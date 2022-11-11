import { Request, Response, NextFunction } from "express";
import Joi from "joi";
import bcrypt from "bcryptjs";
import { getMongoCollection } from "../tools/db";
import { Collection, ObjectId } from "mongodb";

export function isGuest() {
	return async function (req: Request, res: Response, next: NextFunction) {
		if (!!req.session.walletId) {
			return res.status(400).json({
				code: "A0000",
				message: "Not permitted to use this route",
			});
		} else {
			return next();
		}
	};
}

export function isLoggedIn(
	isUser?: boolean,
	hasWarehouseAccount: boolean = false
) {
	return async function (req: Request, res: Response, next: NextFunction) {
		if (!!req.session.walletId) {
			const now = Date.now();
			const SESSION_ABSOLUTE_TIMEOUT = 1000 * 60 * 60 * 6;

			// If the cookie is past its absolute timeout then log out user
			// and block request
			if (now > req.session.createdAt + SESSION_ABSOLUTE_TIMEOUT) {
				await new Promise<void>((resolve, reject) => {
					req.session.destroy((err: Error) => {
						if (err) reject(err);
					});
					res.clearCookie("sid");
					resolve();
				});
				return res.status(400).json({
					code: "A0001",
					message: "Session expired",
				});

				// Else, check if its supposed to be a user ONLY
				// route, or wallet ONLY route
			} else if (isUser && !req.session.isUser) {
				return res.status(400).json({
					code: "A0002",
					message: "Must be user session",
				});
			} else if (isUser === false && req.session.isUser) {
				return res.status(400).json({
					code: "A0003",
					message: "Must be a non user session",
				});
			} else if (hasWarehouseAccount && !req.session.warehouseAccountId) {
				return res.status(400).json({
					code: "A0008",
					message: "Must have a warehouse account",
				});
			}
			return next();
		} else {
			return res.status(400).json({
				code: "A0004",
				message: "This route requires authentication",
			});
		}
	};
}

export function masterKey() {
	return async function (req: Request, res: Response, next: NextFunction) {
		const key: string | undefined = req.header("Authorization");
		const API_MASTER_KEY: any = process.env.API_MASTER_KEY;
		if (API_MASTER_KEY === key) {
			return next();
		} else {
			return res.status(403).json({
				code: "A0005",
				message: "Not permitted to use this route",
			});
		}
	};
}

export function validWalletKey() {
	return async function (req: Request, res: Response, next: NextFunction) {
		// Validate address param
		try {
			req.params.address = await Joi.string()
				.required()
				.lowercase()
				.min(3)
				.max(24)
				.pattern(/^[a-zA-Z]{3,}$/)
				.validateAsync(req.params.address);
		} catch (error) {
			return res.status(400).json({
				code: "A0006",
				message: "Invalid address",
			});
		}

		// Get key and check if it exists
		let walletKey: string | undefined = req.header("Authorization");

		try {
			// Validate the key
			await Joi.string()
				.required()
				.pattern(/^[a-zA-Z0-9]{24}$/)
				.validateAsync(walletKey);
		} catch (error) {
			return res.status(400).json({
				code: "A0007",
				message: "Missing wallet key or invalid format",
			});
		}

		const wallets = getMongoCollection("wallets");

		let wallet = await wallets.findOne(
			{ address: req.params.address },
			{ projection: { key: 1, address: 1, ownerId: 1 } }
		);

		if (!wallet) {
			return res.status(404).json({
				code: "W0001",
				message: "Wallet not found",
			});
		}

		// Checking if password is valid
		const validKey: boolean = await bcrypt.compare(
			walletKey as string,
			wallet.key
		);
		if (!validKey) {
			return res.status(400).json({
				code: "A0007",
				message: "Invalid wallet key",
			});
		} else {
			req.wallet = {
				_id: wallet._id.toString(),
				address: wallet.address,
				ownerId: wallet.ownerId.toString(),
			};
			return next();
		}
	};
}

export function assignedToWarehouse(isOwner?: boolean) {
	return async function (req: Request, res: Response, next: NextFunction) {
		// Validate address param
		try {
			req.params.warehouseId = await Joi.string()
				.required()
				.length(24)
				.hex()
				.validateAsync(req.params.warehouseId);
		} catch (error) {
			return res.status(400).json({
				code: "A0010",
				message: "Invalid warehouse id",
			});
		}

		const warehouses: Collection = getMongoCollection("warehouses");

		let query: any = {
			_id: new ObjectId(req.params.warehouseId),
		};
		if (isOwner) {
			query.ownerId = new ObjectId(req.session.warehouseAccountId);
		} else {
			query["$or"] = [
				{ workers: new ObjectId(req.session.warehouseAccountId) },
				{ ownerId: new ObjectId(req.session.warehouseAccountId) },
			];
		}

		let result = await warehouses.findOne(query, {
			projection: { _id: 1, name: 1, collateral: 1, collateralAvailable: 1 },
		});

		if (!result?._id) {
			if (isOwner) {
				return res.status(403).json({
					code: "A0012",
					message: "Only the warehouse owner can do this",
				});
			} else {
				return res.status(403).json({
					code: "A0011",
					message: "Must be assigned to the warehouse to do this",
				});
			}
		} else {
			req.warehouse = {
				name: result.name,
				collateral: result.collateral,
				collateralAvailable: result.collateralAvailable,
			};
			return next();
		}
	};
}
