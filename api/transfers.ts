import express, { Request, Response } from "express";
import { Collection, ObjectId } from "mongodb";
import { getMongoCollection, getMongoSession } from "../tools/db";
import { validateAssets } from "../tools/assetValidation";
import Joi from "joi";

const router = express.Router();

router.post("/", async (req: Request, res: Response) => {
	// Validate request body
	try {
		req.body = await Joi.object({
			receivingWarehouse: Joi.string().required().length(24).hex(),
			sendingWarehouse: Joi.string().required().length(24).hex(),
			assets: Joi.object().required().min(1),
		}).validateAsync(req.body);
	} catch (error) {
		return res.status(400).json({
			code: "G0000",
			message: "Invalid JSON body",
		});
	}

	// Validate the req.body.assets
	const validAssetsResult = await validateAssets(req.body.assets, req);
	if (validAssetsResult < 0) {
		return res.status(400).json({
			code: "G0000",
			message: "Invalid JSON body",
		});
	}
	const collateralNeeded = validAssetsResult;

	const warehouses: Collection = getMongoCollection("warehouses");
	const transfers: Collection = getMongoCollection("transfers");
	const session = getMongoSession();

	// Check if they are assigned to receivingWarehouse
	let result = await warehouses.findOne(
		{
			_id: new ObjectId(req.body.receivingWarehouse),
			$or: [
				{ workers: new ObjectId(req.session.warehouseAccountId) },
				{ ownerId: new ObjectId(req.session.warehouseAccountId) },
			],
		},
		{
			projection: { _id: 1, name: 1, collateral: 1, collateralAvailable: 1 },
		}
	);
	if (!result?._id) {
		return res.status(403).json({
			code: "A0011",
			message: "Must be assigned to the warehouse to do this",
		});
	} else {
		req.warehouse = {
			name: result.name,
			collateral: result.collateral,
			collateralAvailable: result.collateralAvailable,
		};
	}

	// If collateral isn't currently available don't even start transaction
	if (result.collateralAvailable < collateralNeeded) {
		return res.status(400).json({
			code: "H0000",
			message: "Not enough free collateral to cover this",
		});
	}

	let warehouseHasFunds = true;
	let unknownError = false;
	let warehouseHasCollateral = true;
	await session.withTransaction(async () => {
		// Lock up collateral from receiving warehouse
		// return error if they don't have it
		const receivingResult = await warehouses.updateOne(
			{
				_id: new ObjectId(req.body.receivingWarehouse),
				collateralAvailable: { $gte: collateralNeeded },
			},
			{ $inc: { collateralAvailable: -collateralNeeded } },
			{
				session,
			}
		);

		if (!receivingResult.modifiedCount) {
			warehouseHasCollateral = false;
			return await session.abortTransaction();
		}

		// Remove the assets from the sendingWarehouse
		// and return error if they don't have them
		let queryFilter: any = {
			_id: new ObjectId(req.body.sendingWarehouse),
		};
		let queryUpdate: any = {
			$inc: {},
		};

		// Set the filter and update to all the assets
		for (const key in req.body.assets) {
			queryFilter[`assets.${key}`] = {
				$gte: req.body.assets[key],
			};

			queryUpdate.$inc[`assets.${key}`] = -req.body.assets[key];
		}

		const sendingResult = await warehouses.findOneAndUpdate(
			queryFilter,
			queryUpdate,
			{
				session,
				projection: { name: 1 },
			}
		);

		if (!sendingResult.value?._id) {
			warehouseHasFunds = false;
			return await session.abortTransaction();
		}

		// Now insert their transaction document
		await transfers.insertOne({
			createdAt: Date.now(),
			status: "pending",
			collateralUsed: collateralNeeded,
			receivingWarehouse: {
				id: new ObjectId(req.body.receivingWarehouse),
				name: req.warehouse.name,
			},
			sendingWarehouse: {
				id: new ObjectId(req.body.sendingWarehouse),
				name: sendingResult.value.name,
			},
			assets: req.body.assets,
		});
	});

	await session.endSession();

	if (!warehouseHasFunds) {
		return res.status(400).json({
			code: "H0001",
			message: "Warehouse doesn't have the assets to cover this transaction",
		});
	} else if (!warehouseHasCollateral) {
		return res.status(400).json({
			code: "H0000",
			message: "Not enough free collateral to cover this",
		});
	} else if (unknownError) {
		return res.status(500).json({
			code: "S",
			message: "Internal server error occured, if recurring inform Stelo",
		});
	}

	return res.status(201).json({
		message: "Transfer created, assets locked",
		receivingWarehouseId: req.body.receivingWarehouse,
		sendingWarehouseId: req.body.sendingWarehouse,
		collateralUsed: collateralNeeded,
		assets: req.body.assets,
	});
});

router.delete("/:transferId", async (req: Request, res: Response) => {
	// Validate the address param
	try {
		req.params.transferId = await Joi.string()
			.required()
			.length(24)
			.hex()
			.validateAsync(req.params.transferId);
	} catch (error) {
		return res.status(400).json({
			code: "T0000",
			message: "Invalid transfer id",
		});
	}

	const warehouses: Collection = getMongoCollection("warehouses");
	const warehouseAccounts: Collection =
		getMongoCollection("warehouseAccounts");
	const transfers: Collection = getMongoCollection("transfers");
	const session = getMongoSession();

	// Create a session to delete the transaction, after deleting the transaction
	// Check if they were assigned to the sending or receiving warehouse.
	// If not, end there, otherwise return the locked up items back to the
	// sending warehouse.

	let tranferFound = true;
	let assignedToTransfer = true;
	let transferAssets: any = {};
	await session.withTransaction(async () => {
		const transferDocument = await transfers.findOneAndDelete(
			{
				_id: new ObjectId(req.params.transferId),
				status: "pending",
			},
			{
				session,
			}
		);

		if (!transferDocument.value?._id) {
			tranferFound = false;
			return await session.abortTransaction();
		} else {
			transferAssets = transferDocument.value.assets;
		}

		// Check if the requester was assigned to this warehouse
		let requesterResult = await warehouseAccounts.findOne(
			{
				_id: new ObjectId(req.session.warehouseAccountId),
				$or: [
					{
						warehouses: {
							$elemMatch: {
								warehouseId: new ObjectId(
									transferDocument.value.receivingWarehouse.id
								),
							},
						},
					},
					{
						warehouses: {
							$elemMatch: {
								warehouseId: new ObjectId(
									transferDocument.value.sendingWarehouse.id
								),
							},
						},
					},
				],
			},
			{
				projection: {
					_id: 1,
				},
			}
		);

		if (!requesterResult?._id) {
			assignedToTransfer = false;
			return await session.abortTransaction();
		}

		// Create the queryUpdate to put the items back into the warehouse
		let queryUpdate: any = {
			$inc: {},
		};
		for (const key in transferDocument.value.assets) {
			queryUpdate.$inc[`assets.${key}`] = transferDocument.value.assets[key];
		}

		await warehouses.updateOne(
			{
				_id: new ObjectId(transferDocument.value.sendingWarehouse.id),
			},
			queryUpdate,
			{
				session,
			}
		);

		// Now add collateral back into receiving warehouse
		await warehouses.updateOne(
			{
				_id: new ObjectId(transferDocument.value.receivingWarehouse.id),
			},
			{
				$inc: {
					collateralAvailable: transferDocument.value.collateralUsed,
				},
			},
			{
				session,
			}
		);
	});

	await session.endSession();

	if (!assignedToTransfer) {
		return res.status(403).json({
			code: "T0002",
			message: "Not assigned to this transfer",
		});
	} else if (!tranferFound) {
		return res.status(404).json({
			code: "T0001",
			message: "Transfer request not found",
		});
	}

	return res.status(200).json({
		message: "Transfer request deleted, assets and collateral returned",
		assets: transferAssets,
	});
});

router.put("/:transferId/status", async (req: Request, res: Response) => {
	// Validate the address param
	try {
		req.params.transferId = await Joi.string()
			.required()
			.length(24)
			.hex()
			.validateAsync(req.params.transferId);
	} catch (error) {
		return res.status(400).json({
			code: "T0000",
			message: "Invalid transfer id",
		});
	}

	// Validate request body
	try {
		req.body = await Joi.object({
			status: Joi.string().required().valid("sent", "received"),
		}).validateAsync(req.body);
	} catch (error) {
		return res.status(400).json({
			code: "G0000",
			message: "Invalid JSON body",
		});
	}

	const warehouseAccounts: Collection =
		getMongoCollection("warehouseAccounts");
	const transfers: Collection = getMongoCollection("transfers");
	const warehouses: Collection = getMongoCollection("warehouses");
	const session = getMongoSession();

	let tranferFound = true;
	let assignedToTransfer = true;
	let transferAssets: any = {};

	if (req.body.status === "sent") {
		// Create a session to update the transaction, after updating
		// check if they were assigned to the sending or receiving warehouse.
		// If not, end there, otherwise end the session.
		await session.withTransaction(async () => {
			const transferDocument = await transfers.findOneAndUpdate(
				{
					_id: new ObjectId(req.params.transferId),
					status: "pending",
				},
				{
					$set: { status: "sent" },
				},
				{
					session,
					projection: { receivingWarehouse: 1, sendingWarehouse: 1 },
				}
			);

			if (!transferDocument.value?._id) {
				tranferFound = false;
				return await session.abortTransaction();
			}

			// Check if the requester was assigned to this warehouse
			let requesterResult = await warehouseAccounts.findOne(
				{
					_id: new ObjectId(req.session.warehouseAccountId),
					warehouses: {
						$elemMatch: {
							warehouseId: new ObjectId(
								transferDocument.value.sendingWarehouse.id
							),
						},
					},
				},
				{
					projection: {
						_id: 1,
					},
				}
			);

			if (!requesterResult?._id) {
				assignedToTransfer = false;
				return await session.abortTransaction();
			}
		});
	} else if (req.body.status === "received") {
		// Create a session to delete the transaction, after deleting
		// check if they were assigned to the sending or receiving warehouse.
		// If not, end there, otherwise transfer assets into receiving warehouse,
		// and return collateral to sending warehouse.
		await session.withTransaction(async () => {
			const transferDocument = await transfers.findOneAndDelete(
				{
					_id: new ObjectId(req.params.transferId),
					status: "sent",
				},
				{
					session,
				}
			);

			if (!transferDocument.value?._id) {
				tranferFound = false;
				return await session.abortTransaction();
			} else {
				transferAssets = transferDocument.value.assets;
			}

			// Check if the requester was assigned to this warehouse
			let requesterResult = await warehouseAccounts.findOne(
				{
					_id: new ObjectId(req.session.warehouseAccountId),
					warehouses: {
						$elemMatch: {
							warehouseId: new ObjectId(
								transferDocument.value.receivingWarehouse.id
							),
						},
					},
				},
				{
					projection: {
						_id: 1,
					},
				}
			);

			if (!requesterResult?._id) {
				assignedToTransfer = false;
				return await session.abortTransaction();
			}

			// Create the queryUpdate to put the items back into the warehouse
			let queryUpdate: any = {
				$inc: {},
			};
			for (const key in transferDocument.value.assets) {
				queryUpdate.$inc[`assets.${key}`] =
					transferDocument.value.assets[key];
			}

			await warehouses.updateOne(
				{
					_id: new ObjectId(transferDocument.value.receivingWarehouse.id),
				},
				queryUpdate,
				{
					session,
				}
			);

			// Now add collateral back into sending warehouse
			await warehouses.updateOne(
				{
					_id: new ObjectId(transferDocument.value.sendingWarehouse.id),
				},
				{
					$inc: {
						collateralAvailable: transferDocument.value.collateralUsed,
					},
				},
				{
					session,
				}
			);
		});
	} else {
		return res.status(500).json({
			code: "S",
			message: "We have just DIED, contact stelo HQ IMMEDIETLY",
		});
	}

	await session.endSession();

	if (!assignedToTransfer) {
		return res.status(403).json({
			code: "T0002",
			message: "Not assigned to this transfer",
		});
	} else if (!tranferFound) {
		return res.status(404).json({
			code: "T0001",
			message: "Transfer request not found",
		});
	}

	if (req.body.status === "sent") {
		return res.status(200).json({
			message: "Transfer status updated",
		});
	} else {
		return res.status(200).json({
			message: "Transfer confirmed as received, assets deposited",
			assets: transferAssets,
		});
	}
});

router.get("/", async (req: Request, res: Response) => {
	// Validate the address param
	try {
		req.body = await Joi.object({
			warehouseId: Joi.string().required().length(24).hex(),
		}).validateAsync(req.body);
	} catch (error) {
		return res.status(400).json({
			code: "G0000",
			message: "Invalid JSON body",
		});
	}

	const warehouseAccounts: Collection =
		getMongoCollection("warehouseAccounts");
	const transfers: Collection = getMongoCollection("transfers");

	// Check if the requester is assigned to the warehouse
	let requesterResult = await warehouseAccounts.findOne(
		{
			_id: new ObjectId(req.session.warehouseAccountId),
			warehouses: {
				$elemMatch: { warehouseId: new ObjectId(req.body.warehouseId) },
			},
		},
		{
			projection: {
				_id: 1,
			},
		}
	);

	if (!requesterResult?._id) {
		return res.status(403).json({
			code: "T0002",
			message: "Not assigned to this transfer",
		});
	}

	const transferDocuments = await transfers
		.find({
			$or: [
				{
					"sendingWarehouse.id": new ObjectId(req.body.warehouseId),
				},
				{
					"receivingWarehouse.id": new ObjectId(req.body.warehouseId),
				},
			],
		})
		.toArray();

	if (!transferDocuments) {
		return res.status(404).json({
			code: "T0001",
			message: "Transfer request not found",
		});
	}

	return res.status(200).json(transferDocuments);
});

export { router };
