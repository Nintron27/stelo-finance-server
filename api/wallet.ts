import express, { Request, Response } from "express";
import { Collection, ObjectId } from "mongodb";
import {
	getMongoCollection,
	getMongoSession,
	getRedisConnection,
} from "../tools/db";
import Joi from "joi";
import axios from "axios";
import { Server } from "socket.io";
import { validateAssets } from "../tools/assetValidation";

const router = express.Router();

router.get("/", async (req: Request, res: Response) => {
	const wallets: Collection = getMongoCollection("wallets");

	// Get user assets, and return error if not found
	let result = await wallets.findOne(
		{
			_id: new ObjectId(req.session.walletId),
		},
		{ projection: { assets: 1 } }
	);
	if (!result) {
		return res.status(404).json({
			code: "W0001",
			message: "Wallet couldn't be found",
		});
	}

	// Get the transactions and if none are found return error
	const redis = getRedisConnection();
	let transactions = await redis.lRange(
		`wallets:${req.session.walletId}.transactions`,
		0,
		9
	);
	if (!transactions) {
		transactions = [];
	} else {
		// Parse all the transactions
		for (let index = 0; index < transactions.length; index++) {
			transactions[index] = JSON.parse(transactions[index]);
		}
	}

	res.status(200).json({
		isUser: req.session.isUser,
		address: req.session.isUser
			? req.session.address
			: `#${req.session.address}`,
		assets: result.assets,
		transactions,
	});
});

router.post("/socketid", async (req: Request, res: Response) => {
	try {
		req.body = await Joi.object({
			socketId: Joi.string().required().length(20),
		}).validateAsync(req.body);
	} catch (error) {
		return res.status(400).json({
			code: "G0000",
			message: "Invalid JSON body",
		});
	}

	// Put their user socket into their room
	(req.app.get("io") as Server)
		.to(req.body.socketId)
		.socketsJoin(
			req.session.isUser ? req.session.address : `#${req.session.address}`
		);

	res.status(200).json({
		message: "Socket connected to transaction room",
	});
});

router.delete("/socketid/:socketId", async (req: Request, res: Response) => {
	try {
		req.params = await Joi.object({
			socketId: Joi.string().required().length(20),
		}).validateAsync(req.params);
	} catch (error) {
		return res.status(400).json({
			code: "G0001",
			message: "Invalid URL Params",
		});
	}

	// Put their user socket into their room
	(req.app.get("io") as Server)
		.to(req.params.socketId)
		.socketsLeave(
			req.session.isUser ? req.session.address : `#${req.session.address}`
		);

	res.status(200).json({
		message: "Socket removed from transaction room",
	});
});

router.get("/assets", async (req: Request, res: Response) => {
	const wallets: Collection = getMongoCollection("wallets");

	// Get user assets, and return error if not found
	let result = await wallets.findOne(
		{
			_id: new ObjectId(req.session.walletId),
		},
		{ projection: { assets: 1 } }
	);
	if (!result) {
		return res.status(404).json({
			code: "W0001",
			message: "Wallet couldn't be found",
		});
	}

	res.status(200).json({
		assets: result.assets,
	});
});

router.post("/transactions", async (req: Request, res: Response) => {
	// Validate request body
	try {
		req.body = await Joi.object({
			recipient: Joi.string().required().trim(),
			memo: Joi.string().max(64),
			assets: Joi.object().required().min(1),
		}).validateAsync(req.body);
	} catch (error) {
		return res.status(400).json({
			code: "G0000",
			message: "Invalid JSON body",
		});
	}

	// Validate the req.body.assets
	const validAssetsResult = await validateAssets(req.body.assets, req, true);
	if (validAssetsResult < 0) {
		return res.status(400).json({
			code: "G0000",
			message: "Invalid JSON body",
		});
	}

	const wallets: Collection = getMongoCollection("wallets");
	const session = getMongoSession();

	let hasFunds = true;
	let recipientFound = true;
	let webhookFailed = false;
	let recipientId: string | undefined;

	// Use transaction to put funds into recipient's wallet
	// if its "smart" send to webhook, then remove
	// funds from senders wallet
	await session.withTransaction(async () => {
		// Create query filter and the query update
		let queryFilter: any;
		if ((req.body.recipient as string).charAt(0) === "#") {
			queryFilter = {
				address: (req.body.recipient as string).substring(1).toLowerCase(),
			};
		} else {
			queryFilter = {
				"user.username": req.body.recipient,
			};
		}

		let queryUpdate: any = {
			$inc: {},
		};
		for (const key in req.body.assets) {
			queryUpdate.$inc[`assets.${key}`] = req.body.assets[key];
		}

		let recipientResult = await wallets.findOneAndUpdate(
			queryFilter,
			queryUpdate,
			{
				session,
				projection: { webhook: 1 },
			}
		);

		if (!recipientResult.value) {
			recipientFound = false;
			return await session.abortTransaction();
		} else {
			recipientId = recipientResult.value._id;
		}

		// Post transaction to webhook if wallet has one
		if (recipientResult.value.webhook) {
			// Create the transaction document to send to their api
			let transaction: any = {
				walletId: req.session.walletId,
				sender: req.session.isUser
					? req.session.address
					: `#${req.session.address}`,
				assets: req.body.assets,
			};
			if (req.body.memo) {
				transaction.memo = req.body.memo;
			}

			// Who knows what their api is going to do,
			// just catch any errors...
			try {
				let result = await axios.post(
					recipientResult.value.webhook,
					transaction,
					{
						timeout: 10000,
					}
				);

				if (!result) {
					webhookFailed = true;
					return await session.abortTransaction();
				}
			} catch (error) {
				webhookFailed = true;
				return await session.abortTransaction();
			}
		}

		// refresh query filter and the query update
		// for now subtracting the assets
		queryFilter = {
			_id: new ObjectId(req.session.walletId),
		};
		queryUpdate = {
			$inc: {},
		};

		// Set the filter and update to all the assets
		for (const key in req.body.assets) {
			queryFilter[`assets.${key}`] = {
				$gte: req.body.assets[key],
			};

			queryUpdate.$inc[`assets.${key}`] = -req.body.assets[key];
		}

		const senderResult = await wallets.updateOne(queryFilter, queryUpdate, {
			session,
		});

		if (!senderResult.modifiedCount) {
			hasFunds = false;
			return await session.abortTransaction();
		}
	});

	await session.endSession();

	if (!hasFunds) {
		return res.status(400).json({
			code: "W0002",
			message: "You don't have the assets to cover this transaction",
		});
	} else if (!recipientFound) {
		return res.status(404).json({
			code: "W0003",
			message: "The recipient couldn't be found",
		});
	} else if (webhookFailed) {
		return res.status(400).json({
			code: "W0004",
			message:
				"Recipient smart wallet's webhook is down, or declined your transaction",
		});
	}

	// Cache transaction for sender
	const redis = getRedisConnection();
	let transaction: any = {
		type: "send",
		interactant: req.body.recipient,
		assets: req.body.assets,
	};
	if (req.body.memo) {
		transaction.memo = req.body.memo;
	}
	await redis
		.multi()
		.lPush(
			`wallets:${req.session.walletId}.transactions`,
			JSON.stringify(transaction)
		)
		.lTrim(`wallets:${req.session.walletId}.transactions`, 0, 9)
		.expire(`wallets:${req.session.walletId}.transactions`, 60 * 60 * 24 * 5)
		.exec();

	// Cache transaction for receiver
	transaction.type = "receive";
	transaction.interactant = req.session.isUser
		? req.session.address
		: `#${req.session.address}`;
	await redis
		.multi()
		.lPush(`wallets:${recipientId}.transactions`, JSON.stringify(transaction))
		.lTrim(`wallets:${recipientId}.transactions`, 0, 9)
		.expire(`wallets:${recipientId}.transactions`, 60 * 60 * 24 * 5)
		.exec();

	// Post to socket room
	(req.app.get("io") as Server)
		.to(req.body.recipient)
		.emit("transaction", transaction);

	res.status(201).json({
		message: "Transaction created and assets sent",
		recipient: req.body.recipient,
		memo: req.body.memo,
		assets: req.body.assets,
	});
});

router.get("/transactions", async (req: Request, res: Response) => {
	// Get the transactions and if none are found return error
	const redis = getRedisConnection();
	let transactions = await redis.lRange(
		`wallets:${req.session.walletId}.transactions`,
		0,
		9
	);
	if (!transactions) {
		return res.status(200).json([]);
	}

	// Parse all the transactions
	for (let index = 0; index < transactions.length; index++) {
		transactions[index] = JSON.parse(transactions[index]);
	}

	return res.status(200).json(transactions);
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

export { router };
