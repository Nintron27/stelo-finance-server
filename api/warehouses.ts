import express, { Request, Response } from "express";
import { Collection, ObjectId } from "mongodb";
import {
	getMongoCollection,
	getMongoSession,
	getRedisConnection,
} from "../tools/db";
import bcrypt from "bcryptjs";
import { randomLowercaseString, randomString } from "../tools/random";
import Joi from "joi";
import {
	validWalletKey,
	isLoggedIn,
	isGuest,
	assignedToWarehouse,
} from "../handlers/auth";
import axios from "axios";
import { Server } from "socket.io";
import { validateAssets } from "../tools/assetValidation";

const router = express.Router();

router.post("/", async (req: Request, res: Response) => {
	// Validate request body
	try {
		req.body = await Joi.object({
			name: Joi.string()
				.required()
				.trim()
				.min(3)
				.max(32)
				.pattern(/^[ _A-Za-z0-9-]+$/),
			coordinates: Joi.array()
				.items(Joi.number().integer().max(90000000).min(-90000000))
				.length(2)
				.required(),
		}).validateAsync(req.body);
	} catch (error) {
		return res.status(400).json({
			code: "G0000",
			message: "Invalid JSON body",
		});
	}

	const warehouses: Collection = getMongoCollection("warehouses");
	const warehouseAccounts: Collection =
		getMongoCollection("warehouseAccounts");

	// Use transaction incase they don't have permission
	let hasPermission = true;
	const session = getMongoSession();
	await session.withTransaction(async () => {
		const warehouseId: ObjectId = new ObjectId();

		let result = await warehouseAccounts.updateOne(
			{
				_id: new ObjectId(req.session.warehouseAccountId),
				canCreateWarehouses: true,
			},
			{
				$push: {
					warehouses: {
						warehouseId: warehouseId,
						name: req.body.name,
						role: "owner",
					},
				},
			},
			{
				session,
			}
		);

		// If account not found then they didn't have permission
		if (!result.modifiedCount) {
			hasPermission = false;
			return await session.abortTransaction();
		}

		await warehouses.insertOne(
			{
				_id: warehouseId,
				name: req.body.name,
				ownerId: new ObjectId(req.session.warehouseAccountId),
				coordinates: [
					Number((req.body.coordinates[0] * 0.000001).toFixed(6)),
					Number((req.body.coordinates[1] * 0.000001).toFixed(6)),
				],
				collateral: 0,
				collateralAvailable: 0,
				workers: [],
				assets: {},
			},
			{ session }
		);
	});

	await session.endSession();

	if (!hasPermission) {
		return res.status(400).json({
			code: "A0009",
			message: "Must have permission to create warehouses",
		});
	}

	return res.status(201).json({
		message: "Warehouse created",
	});
});

router.get(
	"/:warehouseId",
	assignedToWarehouse(true),
	async (req: Request, res: Response) => {
		const warehouses: Collection = getMongoCollection("warehouses");

		const warehouseDocument = await warehouses.findOne({
			_id: new ObjectId(req.params.warehouseId),
		});

		if (warehouseDocument?._id) {
			// Set the coordinates correctly then return
			for (
				let index = 0;
				index < warehouseDocument.coordinates.length;
				index++
			) {
				warehouseDocument.coordinates[index] =
					warehouseDocument.coordinates[index] * 1000000;
			}
			return res.status(200).json(warehouseDocument);
		} else {
			return res.status(404).json({
				code: "H0002",
				message: "Warehouse couldn't be found",
			});
		}
	}
);

router.patch(
	"/:warehouseId/collateral",
	assignedToWarehouse(true),
	async (req: Request, res: Response) => {
		// Validate request body
		try {
			req.body = await Joi.object({
				balance: Joi.number().required().integer().invalid(0),
			}).validateAsync(req.body);
		} catch (error) {
			return res.status(400).json({
				code: "G0000",
				message: "Invalid JSON body",
			});
		}

		// Store whether they are storing or removing collateral
		let addingCollateral = true;
		if (req.body.balance < 0) {
			addingCollateral = false;

			// Quick check if there is free collateral,
			// to avoid a db call if possible
			if (Math.abs(req.body.balance) > req.warehouse.collateralAvailable) {
				return res.status(400).json({
					code: "H0000",
					message: "Not enough free collateral to cover this",
				});
			}
		}

		const warehouses: Collection = getMongoCollection("warehouses");
		const wallets: Collection = getMongoCollection("wallets");

		// variables to use for returning errors
		let hasFunds = true;
		let availableCollateral = true;
		let walletFound = true;

		const session = getMongoSession();
		await session.withTransaction(async () => {
			if (addingCollateral) {
				let result = await wallets.updateOne(
					{
						_id: new ObjectId(req.session.walletId),
						"assets.stelo": { $gte: req.body.balance },
					},
					{
						$inc: { "assets.stelo": -req.body.balance },
					},
					{
						session,
					}
				);

				// If account not found then they didn't have permission
				if (!result.modifiedCount) {
					hasFunds = false;
					return await session.abortTransaction();
				}

				await warehouses.updateOne(
					{
						_id: new ObjectId(req.params.warehouseId),
					},
					{
						$inc: {
							collateral: req.body.balance,
							collateralAvailable: req.body.balance,
						},
					},
					{ session }
				);
			} else {
				let result = await warehouses.updateOne(
					{
						_id: new ObjectId(req.params.warehouseId),
						collateralAvailable: { $gte: Math.abs(req.body.balance) },
					},
					{
						$inc: {
							collateral: req.body.balance,
							collateralAvailable: req.body.balance,
						},
					},
					{
						session,
					}
				);

				if (!result.modifiedCount) {
					availableCollateral = false;
					return await session.abortTransaction();
				}

				let userResult = await wallets.updateOne(
					{
						_id: new ObjectId(req.session.walletId),
					},
					{
						$inc: { "assets.stelo": Math.abs(req.body.balance) },
					},
					{
						session,
					}
				);

				// If account not found then they didn't have permission
				if (!userResult.modifiedCount) {
					walletFound = false;
					return await session.abortTransaction();
				}
			}
		});

		await session.endSession();

		if (!hasFunds) {
			return res.status(400).json({
				code: "W0002",
				message: "You don't have the assets to cover this transaction",
			});
		} else if (!availableCollateral) {
			return res.status(400).json({
				code: "H0000",
				message: "Not enough free collateral to cover this",
			});
		} else if (!walletFound) {
			return res.status(400).json({
				code: "W0001",
				message: "Wallet not found",
			});
		}

		// Cache transaction for sender
		const redis = getRedisConnection();
		let transaction: any = {
			type: "send",
			interactant: "<warehouse.collateral>",
			assets: { stelo: Math.abs(req.body.balance) },
		};
		if (!addingCollateral) {
			transaction.type = "receive";
		}
		await redis
			.multi()
			.lPush(
				`wallets:${req.session.walletId}.transactions`,
				JSON.stringify(transaction)
			)
			.lTrim(`wallets:${req.session.walletId}.transactions`, 0, 9)
			.expire(
				`wallets:${req.session.walletId}.transactions`,
				60 * 60 * 24 * 5
			)
			.exec();

		return res.status(200).json({
			message: "Collateral adjusted",
		});
	}
);

router.put(
	"/:warehouseId/owner",
	assignedToWarehouse(true),
	async (req: Request, res: Response) => {
		// Validate request body
		try {
			req.body = await Joi.object({
				warehouseAccountId: Joi.string().required().length(24).hex(),
			}).validateAsync(req.body);
		} catch (error) {
			return res.status(400).json({
				code: "G0000",
				message: "Invalid JSON body",
			});
		}

		const warehouses: Collection = getMongoCollection("warehouses");
		const warehouseAccounts: Collection =
			getMongoCollection("warehouseAccounts");

		// Update the new owners records, if they don't exist then
		// return an error
		let result = await warehouseAccounts.updateOne(
			{
				_id: new ObjectId(req.body.warehouseAccountId),
				"warehouses.warehouseId": new ObjectId(req.params.warehouseId),
			},
			{ $set: { "warehouses.$.role": "owner" } }
		);
		if (!result.modifiedCount) {
			result = await warehouseAccounts.updateOne(
				{
					_id: new ObjectId(req.body.warehouseAccountId),
					"warehouses.warehouseId": {
						$ne: new ObjectId(req.params.warehouseId),
					},
				},
				{
					$push: {
						warehouses: {
							warehouseId: new ObjectId(req.params.warehouseId),
							name: req.warehouse.name,
							role: "owner",
						},
					},
				}
			);
			if (!result.modifiedCount) {
				return res.status(400).json({
					code: "U0006",
					message: "Warehouse account not found",
				});
			}
		}

		// Set the owner to just a worker
		await warehouseAccounts.updateOne(
			{
				_id: new ObjectId(req.session.warehouseAccountId),
				"warehouses.warehouseId": new ObjectId(req.params.warehouseId),
			},
			{ $set: { "warehouses.$.role": "worker" } }
		);

		// Update the warehouse record
		await warehouses.updateOne(
			{
				_id: new ObjectId(req.params.warehouseId),
			},
			{
				$set: { ownerId: new ObjectId(req.body.warehouseAccountId) },
				$push: { workers: new ObjectId(req.session.warehouseAccountId) },
			}
		);
		// Seperate statement to pull the worker if there
		// (cant do 2 actions to same part of mongodb document at once)
		await warehouses.updateOne(
			{
				_id: new ObjectId(req.params.warehouseId),
			},
			{
				$pull: { workers: new ObjectId(req.body.warehouseAccountId) },
			}
		);

		res.status(200).json({
			message: "Owner of the warehouse has been updated",
		});
	}
);

router.post(
	"/:warehouseId/workers",
	assignedToWarehouse(true),
	async (req: Request, res: Response) => {
		// Validate request body
		try {
			req.body = await Joi.object({
				warehouseAccountId: Joi.string().required().length(24).hex(),
			}).validateAsync(req.body);
		} catch (error) {
			return res.status(400).json({
				code: "G0000",
				message: "Invalid JSON body",
			});
		}

		const warehouses: Collection = getMongoCollection("warehouses");
		const warehouseAccounts: Collection =
			getMongoCollection("warehouseAccounts");

		// Update the new wokers records, if they don't exist or
		// are already assigned to warehouse then return error
		let result = await warehouseAccounts.updateOne(
			{
				_id: new ObjectId(req.body.warehouseAccountId),
				"warehouses.warehouseId": {
					$ne: new ObjectId(req.params.warehouseId),
				},
			},
			{
				$push: {
					warehouses: {
						warehouseId: new ObjectId(req.params.warehouseId),
						name: req.warehouse.name,
						role: "worker",
					},
				},
			}
		);
		if (!result.modifiedCount) {
			return res.status(400).json({
				code: "U0006",
				message:
					"Warehouse account not found, or already assigned to warehouse",
			});
		}

		// Update the warehouse record
		await warehouses.updateOne(
			{
				_id: new ObjectId(req.params.warehouseId),
			},
			{
				$push: { workers: new ObjectId(req.body.warehouseAccountId) },
			}
		);

		res.status(200).json({
			message: "Worker assigned to warehouse",
		});
	}
);

router.delete(
	"/:warehouseId/workers/:warehouseAccountId",
	assignedToWarehouse(true),
	async (req: Request, res: Response) => {
		// Validate request param
		try {
			req.params.warehouseAccountId = await Joi.string()
				.required()
				.length(24)
				.hex()
				.validateAsync(req.params.warehouseAccountId);
		} catch (error) {
			return res.status(400).json({
				code: "G0000",
				message: "Invalid JSON body",
			});
		}

		const warehouses: Collection = getMongoCollection("warehouses");
		const warehouseAccounts: Collection =
			getMongoCollection("warehouseAccounts");

		// Update the wokers records, if they don't exist or
		// aren't assigned to warehouse then return error
		let result = await warehouseAccounts.updateOne(
			{
				_id: new ObjectId(req.params.warehouseAccountId),
			},
			{
				$pull: {
					warehouses: {
						warehouseId: new ObjectId(req.params.warehouseId),
					},
				},
			}
		);
		if (!result.modifiedCount) {
			return res.status(400).json({
				code: "U0006",
				message:
					"Warehouse account not found, or not assigned to warehouse",
			});
		}

		// Update the warehouse record
		await warehouses.updateOne(
			{
				_id: new ObjectId(req.params.warehouseId),
			},
			{
				$pull: { workers: new ObjectId(req.params.warehouseAccountId) },
			}
		);

		res.status(200).json({
			message: "Worker un-assigned from warehouse",
		});
	}
);

router.post(
	"/:warehouseId/assets",
	assignedToWarehouse(false),
	async (req: Request, res: Response) => {
		// Validate request body
		try {
			req.body = await Joi.object({
				depositor: Joi.string().trim().required(),
				assets: Joi.object().required().min(1),
			}).validateAsync(req.body);
		} catch (error) {
			return res.status(400).json({
				code: "G0000",
				message: "Invalid JSON body",
			});
		}

		// Validate the req.body.assets and get result
		const validAssetsResult = await validateAssets(req.body.assets, req);
		if (validAssetsResult < 0) {
			return res.status(400).json({
				code: "G0000",
				message: "Invalid JSON body",
			});
		}
		const collateralNeeded = validAssetsResult;

		// Test if collateral is there, and return error if not
		if (req.warehouse.collateralAvailable < collateralNeeded) {
			return res.status(400).json({
				code: "H0000",
				message: "Not enough free collateral to cover this",
			});
		}

		const warehouses: Collection = getMongoCollection("warehouses");
		const wallets: Collection = getMongoCollection("wallets");
		const session = getMongoSession();

		let recipientFound = true;
		let collateralAvailable = true;
		let recipientId: string | undefined;
		await session.withTransaction(async () => {
			// Create queryUpdate to add assets into warehouse
			let queryUpdate: any = {
				$inc: { collateralAvailable: -collateralNeeded },
			};
			for (const key in req.body.assets) {
				queryUpdate.$inc[`assets.${key}`] = req.body.assets[key];
			}

			const warehouseResult = await warehouses.updateOne(
				{
					_id: new ObjectId(req.params.warehouseId),
					collateralAvailable: { $gte: collateralNeeded },
				},
				queryUpdate,
				{
					session,
				}
			);

			if (!warehouseResult.modifiedCount) {
				collateralAvailable = false;
				return await session.abortTransaction();
			}

			// Now add those items into the players wallet also
			const depositorResult = await wallets.findOneAndUpdate(
				{ "user.username": req.body.depositor },
				queryUpdate,
				{
					session,
					projection: { _id: 1 },
				}
			);

			if (!depositorResult.value?._id) {
				recipientFound = false;
				return await session.abortTransaction();
			} else {
				recipientId = depositorResult.value._id;
			}
		});

		await session.endSession();

		if (!recipientFound) {
			return res.status(404).json({
				code: "W0003",
				message: "The recipient couldn't be found",
			});
		} else if (!collateralAvailable) {
			return res.status(400).json({
				code: "H0000",
				message: "Not enough free collateral to cover this",
			});
		}

		// Cache transaction for receiver
		const redis = getRedisConnection();
		let transaction: any = {
			type: "deposit",
			interactant: `<warehouse.${req.warehouse.name}>`,
			assets: req.body.assets,
		};
		await redis
			.multi()
			.lPush(
				`wallets:${recipientId}.transactions`,
				JSON.stringify(transaction)
			)
			.lTrim(`wallets:${recipientId}.transactions`, 0, 9)
			.expire(`wallets:${recipientId}.transactions`, 60 * 60 * 24 * 5)
			.exec();

		// Post to socket room
		(req.app.get("io") as Server)
			.to(req.body.depositor)
			.emit("transaction", transaction);

		return res.status(200).json({
			message:
				"Deposit handled, assets assigned to warehouse and credited to user",
			depositor: req.body.depositor,
			assets: req.body.assets,
		});
	}
);

router.delete(
	"/:warehouseId/assets",
	assignedToWarehouse(false),
	async (req: Request, res: Response) => {
		// Validate request body
		try {
			req.body = await Joi.object({
				withdrawer: Joi.string().trim().required(),
				assets: Joi.object().required().min(1),
			}).validateAsync(req.body);
		} catch (error) {
			return res.status(400).json({
				code: "G0000",
				message: "Invalid JSON body",
			});
		}

		// Validate the req.body.assets and get result
		const validAssetsResult = await validateAssets(req.body.assets, req);
		if (validAssetsResult < 0) {
			return res.status(400).json({
				code: "G0000",
				message: "Invalid JSON body",
			});
		}
		let collateralToReturn = validAssetsResult;

		// Test if collateral will overflow, if so scoop off the top

		// TODO: fix if this gets outdated by session time I guess,
		// maybe my back burner idea will work
		if (
			req.warehouse.collateralAvailable + collateralToReturn >
			req.warehouse.collateral
		) {
			collateralToReturn -= req.warehouse.collateralAvailable - req.warehouse.collateral + collateralToReturn;
		}

		const warehouses: Collection = getMongoCollection("warehouses");
		const wallets: Collection = getMongoCollection("wallets");
		const session = getMongoSession();

		let userHasFunds = true;
		let warehouseHasFunds = true;
		let withdrawerId: string | undefined;
		await session.withTransaction(async () => {
			// Create queryUpdate to withdraw the needed assets
			// from user and warehouse, and queryFilter to
			// make sure they have the assets.
			// But also use queryUpdate to return collateral
			let queryFilter: any = {
				_id: new ObjectId(req.params.warehouseId),
			};
			let queryUpdate: any = {
				$inc: { collateralAvailable: collateralToReturn },
			};
			for (const key in req.body.assets) {
				queryFilter[`assets.${key}`] = {
					$gte: req.body.assets[key],
				};

				queryUpdate.$inc[`assets.${key}`] = -req.body.assets[key];
			}

			const warehouseResult = await warehouses.updateOne(
				queryFilter,
				queryUpdate,
				{
					session,
				}
			);

			if (!warehouseResult.modifiedCount) {
				warehouseHasFunds = false;
				return await session.abortTransaction();
			}

			// Now withdraw the items from the player's wallet also
			delete queryFilter._id;
			queryFilter["user.username"] = req.body.withdrawer;
			const withdrawerResult = await wallets.findOneAndUpdate(
				queryFilter,
				queryUpdate,
				{
					session,
					projection: { _id: 1 },
				}
			);

			if (!withdrawerResult.value?._id) {
				userHasFunds = false;
				return await session.abortTransaction();
			} else {
				withdrawerId = withdrawerResult.value._id;
			}
		});

		await session.endSession();

		if (!userHasFunds) {
			return res.status(400).json({
				code: "W0002",
				message:
					"Withdrawer doesn't have the assets to cover this transaction",
			});
		} else if (!warehouseHasFunds) {
			return res.status(400).json({
				code: "H0001",
				message:
					"Warehouse doesn't have the assets to cover this transaction",
			});
		}

		// Cache transaction for receiver
		const redis = getRedisConnection();
		let transaction: any = {
			type: "withdrawal",
			interactant: `<warehouse.${req.warehouse.name}>`,
			assets: req.body.assets,
		};
		await redis
			.multi()
			.lPush(
				`wallets:${withdrawerId}.transactions`,
				JSON.stringify(transaction)
			)
			.lTrim(`wallets:${withdrawerId}.transactions`, 0, 9)
			.expire(`wallets:${withdrawerId}.transactions`, 60 * 60 * 24 * 5)
			.exec();

		// Post to socket room
		(req.app.get("io") as Server)
			.to(req.body.withdrawer)
			.emit("transaction", transaction);

		return res.status(200).json({
			message:
				"Withdrawal handled, assets removed from warehouse and user wallet",
			withdrawer: req.body.withdrawer,
			assets: req.body.assets,
		});
	}
);

export { router };
