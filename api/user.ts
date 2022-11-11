import express, { Request, Response } from "express";
import { Collection, ObjectId } from "mongodb";
import {
	getMongoCollection,
	getMongoSession,
	getRedisConnection,
} from "../tools/db";
import Joi from "joi";
import bcrypt from "bcryptjs";
import { Server } from "socket.io";

const router = express.Router();

router.put("/username", async (req: Request, res: Response) => {
	// Validate request body
	try {
		req.body = await Joi.object({
			username: Joi.string()
				.trim()
				.pattern(/^[_A-Za-z0-9-]+$/)
				.required(),
		}).validateAsync(req.body);
	} catch (error) {
		return res.status(400).json({
			code: "G0000",
			message: "Invalid JSON body",
		});
	}

	const wallets: Collection = getMongoCollection("wallets");

	// Update name in db and session
	// catch error if name is already taken
	try {
		await wallets.updateOne(
			{ _id: new ObjectId(req.session.walletId) },
			{ $set: { "user.username": req.body.username } }
		);
	} catch (error) {
		return res.status(400).json({
			code: "U0000",
			message: "Username already taken",
		});
	}

	// Move all clients into new room
	// and delete old one
	(req.app.get("io") as Server)
		.to(req.session.address)
		.socketsJoin(req.body.username);
	(req.app.get("io") as Server)
		.to(req.session.address)
		.socketsLeave(req.session.address);

	// now update name on session
	req.session.address = req.body.username;

	return res.status(201).json({
		message: "Username updated",
	});
});

router.put("/password", async (req: Request, res: Response) => {
	// Validate request body
	try {
		req.body = await Joi.object({
			oldPassword: Joi.string().required().max(32),
			newPassword: Joi.string().required().min(10).max(32),
		}).validateAsync(req.body);
	} catch (error) {
		return res.status(400).json({
			code: "G0000",
			message: "Invalid JSON body",
		});
	}

	const wallets: Collection = getMongoCollection("wallets");

	const userWallet = await wallets.findOne(
		{
			_id: new ObjectId(req.session.walletId),
		},
		{ projection: { "user.password": 1 } }
	);

	if (!userWallet) {
		return res.status(404).json({
			code: "U0001",
			message: "User not found",
		});
	}

	// Checking if password is valid
	const validPassword: boolean = await bcrypt.compare(
		req.body.oldPassword,
		userWallet.user.password
	);
	if (!validPassword) {
		return res.status(400).json({
			code: "U0003",
			message: "Invalid password",
		});
	}

	// Hashing the password
	const salt: string = await bcrypt.genSalt(10);
	const hashedPassword: string = await bcrypt.hash(req.body.newPassword, salt);

	await wallets.updateOne(
		{ _id: new ObjectId(req.session.walletId) },
		{ $set: { "user.password": hashedPassword } }
	);

	return res.status(201).json({
		message: "Password updated",
	});
});

router.delete("/session", async (req: Request, res: Response) => {
	await new Promise<void>((resolve, reject) => {
		req.session.destroy((err: Error) => {
			if (err) reject(err);
		});
		res.clearCookie("sid");
		resolve();
	});

	res.status(200).json({
		message: "Successfully logged out",
	});
});

router.delete("/", async (req: Request, res: Response) => {
	// Validate request body
	try {
		req.body = await Joi.object({
			password: Joi.string().required().max(32),
		}).validateAsync(req.body);
	} catch (error) {
		return res.status(400).json({
			code: "G0000",
			message: "Invalid JSON body",
		});
	}

	const wallets: Collection = getMongoCollection("wallets");

	// Check if they own any wallets currently
	const ownedWallets = await wallets.findOne(
		{
			ownerId: new ObjectId(req.session.walletId),
		},
		{ projection: { _id: 1 } }
	);
	if (ownedWallets) {
		return res.status(400).json({
			code: "U0004",
			message: "Still owner of wallets",
		});
	}

	// Do they even exist? idk check LOL
	const userWallet = await wallets.findOne({
		_id: new ObjectId(req.session.walletId),
	});
	if (!userWallet) {
		return res.status(404).json({
			code: "U0001",
			message: "User not found",
		});
	}

	// Checking if password is valid
	const validPassword: boolean = await bcrypt.compare(
		req.body.password,
		userWallet.user.password
	);
	if (!validPassword) {
		return res.status(400).json({
			code: "U0003",
			message: "Invalid password",
		});
	}

	let recipientFound = true;
	let treasuryFound = true;

	// Use transaction to delete their account and
	// transfer their funds to the stelotreasury
	const session = getMongoSession();
	await session.withTransaction(async () => {
		let recipientResult = await wallets.findOneAndDelete(
			{ _id: new ObjectId(req.session.walletId) },
			{
				session,
				projection: { assets: 1 },
			}
		);

		if (!recipientResult.value) {
			recipientFound = false;
			return await session.abortTransaction();
		}

		// create queryUpdate to add funds into stelotreasury
		let queryUpdate: any = {
			$inc: {},
		};

		// Put all the assets into the inc object
		for (const key in recipientResult.value.assets) {
			queryUpdate.$inc[`assets.${key}`] = recipientResult.value.assets[key];
		}

		const treasuryResult = await wallets.updateOne(
			{ address: "stelotreasury" },
			queryUpdate,
			{
				session,
			}
		);

		if (!treasuryResult.matchedCount) {
			treasuryFound = false;
			return await session.abortTransaction();
		}
	});

	await session.endSession();

	if (!recipientFound) {
		return res.status(404).json({
			code: "U0001",
			message: "User not found",
		});
	} else if (!treasuryFound) {
		return res.status(404).json({
			code: "S0000",
			message: "The stelo treasury wallet wasn't found",
		});
	}

	// Delete the txs from cache
	const redis = getRedisConnection();
	await redis.del(`wallets:${req.session.walletId}.transactions`);

	// Delete the session
	await new Promise<void>((resolve, reject) => {
		req.session.destroy((err: Error) => {
			if (err) reject(err);
		});
		res.clearCookie("sid");
		resolve();
	});

	return res.status(200).json({
		message: "Account deleted and session closed",
	});
});

router.post("/warehouseaccount", async (req: Request, res: Response) => {
	// TODO: You could just create ObjectId, try to insert into account
	// if it doesn't already have one. Then if not found throw error
	// only issue is maybe use transaction so incase of app crash
	// there isn't an account that says it has wareaccount when it
	// doesn't due to the crash.

	// See if they already have a warehouse account
	const wallets: Collection = getMongoCollection("wallets");
	let result = await wallets.findOne(
		{
			_id: new ObjectId(req.session.walletId),
			"user.warehouseAccountId": { $exists: true },
		},
		{ projection: { _id: 1 } }
	);

	if (result?._id) {
		return res.status(400).json({
			code: "U0005",
			message: "Already registered a warehouse account",
		});
	}

	// Create warehouse account and put id into user wallet
	const warehouseAccounts: Collection =
		getMongoCollection("warehouseAccounts");
	let warehouseAccount = await warehouseAccounts.insertOne({
		canCreateWarehouses: false,
		warehouses: [],
	});
	await wallets.updateOne(
		{
			_id: new ObjectId(req.session.walletId),
		},
		{
			$set: {
				"user.warehouseAccountId": new ObjectId(
					warehouseAccount.insertedId
				),
			},
		}
	);

	// Update their session so it has their warehouse accont id
	req.session.warehouseAccountId = warehouseAccount.insertedId.toString();

	return res.status(201).json({
		message: "Warehouse account created",
	});
});

router.get("/warehouseaccount", async (req: Request, res: Response) => {
	// Check if they don't have an account on record
	if (!req.session.warehouseAccountId) {
		return res.status(404).json({
			code: "U0006",
			message: "Warehouse account not found",
		});
	}

	// Get and return all their warehouse account info
	const warehouseAccounts: Collection =
		getMongoCollection("warehouseAccounts");
	const warehouseAccount = await warehouseAccounts.findOne({
		_id: new ObjectId(req.session.warehouseAccountId),
	});

	// Check once more incase account was still not retrieved
	if (warehouseAccount?._id) {
		return res.status(200).json(warehouseAccount);
	} else {
		return res.status(404).json({
			code: "U0006",
			message: "Warehouse account not found",
		});
	}
});

export { router };
