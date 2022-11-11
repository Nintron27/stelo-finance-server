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
import { validWalletKey, isLoggedIn, isGuest } from "../handlers/auth";
import axios from "axios";
import { Server } from "socket.io";
import { validateAssets } from "../tools/assetValidation";

const router = express.Router();

router.post("/", isLoggedIn(true), async (req: Request, res: Response) => {
	// Validate request body
	try {
		req.body = await Joi.object({
			address: Joi.string()
				.trim()
				.min(3)
				.max(24)
				.pattern(/^[a-zA-Z]{3,}$/)
				.lowercase(),
			webhook: Joi.string()
				.trim()
				.pattern(/^(http|https):\/\/.*$/),
		}).validateAsync(req.body);
	} catch (error) {
		return res.status(400).json({
			code: "G0000",
			message: "Invalid JSON body",
		});
	}

	const wallets: Collection = getMongoCollection("wallets");

	// save the address and key, see if address is taken
	// if address is taken and not user provided,
	// then generate one not taken.
	let address = req.body.address ?? randomLowercaseString(6);
	if (req.body.address) {
		let wallet = await wallets.findOne(
			{ address: address },
			{ projection: { _id: 1 } }
		);
		if (wallet) {
			return res.status(400).json({
				code: "W0000",
				message: "Address taken",
			});
		}
	} else {
		let wallet = await wallets.findOne(
			{ address: address },
			{ projection: { _id: 1 } }
		);
		let counter = 0;
		while (wallet && counter < 10) {
			address = randomLowercaseString(6);
			wallet = await wallets.findOne(
				{ address: address },
				{ projection: { _id: 1 } }
			);
			counter++;
		}
		if (counter >= 10) {
			return res.status(508).json({
				code: "S0002",
				message: "Infinite loop encountered, please try again",
			});
		}
	}

	// Generate and hash the key
	let key = randomString(24);
	const salt: string = await bcrypt.genSalt(10);
	const hashedKey: string = await bcrypt.hash(key, salt);

	// Create document to insert into db
	let walletDocument: any = {
		ownerId: new ObjectId(req.session.walletId),
		key: hashedKey,
		address: address,
		assets: {},
	};
	if (req.body.webhook) {
		walletDocument.webhook = req.body.webhook;
	}

	// catch error if address is already taken
	try {
		await wallets.insertOne(walletDocument);
	} catch (error) {
		return res.status(500).json({
			code: "W0000",
			message: "Couldn't insert wallet, address might be taken",
		});
	}

	return res.status(201).json({
		message:
			"Wallet created. The key to access it is attached, and it will never be shown again",
		address,
		key,
		webhook: req.body.webhook,
	});
});

router.post(
	"/:address/sessions",
	isGuest(),
	async (req: Request, res: Response) => {
		// Validate request body
		try {
			req.body = await Joi.object({
				key: Joi.string().trim().length(24).required(),
			}).validateAsync(req.body);
		} catch (error) {
			return res.status(400).json({
				code: "G0000",
				message: "Invalid JSON body",
			});
		}

		const wallets: Collection = getMongoCollection("wallets");

		// Check if wallet is exists
		const wallet: any = await wallets.findOne(
			{
				address: req.params.address,
			},
			{ projection: { key: 1, address: 1 } }
		);
		if (!wallet) {
			return res.status(400).json({
				code: "W0005",
				message: "Invalid address or key",
			});
		}

		// Checking if key is valid
		const validKey: boolean = await bcrypt.compare(req.body.key, wallet.key);
		if (!validKey) {
			return res.status(400).json({
				code: "W0005",
				message: "Invalid address or key",
			});
		}

		// Set their session variables
		req.session.isUser = false;
		req.session.walletId = wallet._id;
		req.session.address = wallet.address;
		req.session.createdAt = Date.now();

		return res.status(201).json({
			message: "Session created",
		});
	}
);

router.get(
	"/:address/assets",
	validWalletKey(),
	async (req: Request, res: Response) => {
		const wallets: Collection = getMongoCollection("wallets");

		// Get the wallet and check if exists
		const wallet: any = await wallets.findOne(
			{
				_id: new ObjectId(req.wallet._id),
			},
			{ projection: { assets: 1 } }
		);
		if (!wallet) {
			return res.status(404).json({
				code: "W0001",
				message: "Wallet not found",
			});
		}

		return res.status(201).json(wallet.assets);
	}
);

router.post(
	"/:address/transactions",
	validWalletKey(),
	async (req: Request, res: Response) => {
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

		// Validate the req.body.assets and get result
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
					address: (req.body.recipient as string)
						.substring(1)
						.toLowerCase(),
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
					walletId: req.wallet._id,
					sender: `#${req.wallet.address}`,
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
				address: req.params.address,
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

			const senderResult = await wallets.updateOne(
				queryFilter,
				queryUpdate,
				{
					session,
				}
			);

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
				`wallets:${req.wallet._id}.transactions`,
				JSON.stringify(transaction)
			)
			.lTrim(`wallets:${req.wallet._id}.transactions`, 0, 9)
			.expire(`wallets:${req.wallet._id}.transactions`, 60 * 60 * 24 * 5)
			.exec();

		// Cache transaction for receiver
		transaction.type = "receive";
		transaction.interactant = `#${req.wallet.address}`;
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
			.to(req.body.recipient)
			.emit("transaction", transaction);

		res.status(201).json({
			message: "Transaction created and assets sent",
			recipient: req.body.recipient,
			memo: req.body.memo,
			assets: req.body.assets,
		});
	}
);

router.put(
	"/:address/webhook",
	isLoggedIn(true),
	validWalletKey(),
	async (req: Request, res: Response) => {
		if (req.wallet.ownerId !== req.session.walletId) {
			return res.status(403).json({
				message: "Only the owner of the wallet can do this",
			});
		}
		// Validate request body
		try {
			req.body = await Joi.object({
				webhook: Joi.string()
					.required()
					.trim()
					.pattern(/^(http|https):\/\/.*$/),
			}).validateAsync(req.body);
		} catch (error) {
			return res.status(400).json({
				code: "G0000",
				message: "Invalid JSON body",
			});
		}

		const wallets: Collection = getMongoCollection("wallets");

		await wallets.updateOne(
			{ _id: new ObjectId(req.wallet._id) },
			{ $set: { webhook: req.body.webhook } }
		);

		res.status(200).json({
			message: "Webhook has been updated",
			webhook: req.body.webhook,
		});
	}
);

router.delete(
	"/:address/webhook",
	isLoggedIn(true),
	validWalletKey(),
	async (req: Request, res: Response) => {
		if (req.wallet.ownerId !== req.session.walletId) {
			return res.status(403).json({
				code: "W0006",
				message: "Only the owner of the wallet can do this",
			});
		}
		const wallets: Collection = getMongoCollection("wallets");

		await wallets.updateOne(
			{ _id: new ObjectId(req.wallet._id) },
			{ $unset: { webhook: "" } }
		);

		res.status(200).json({
			message: "Webhook has been removed",
		});
	}
);

router.put(
	"/:address/owner",
	isLoggedIn(true),
	validWalletKey(),
	async (req: Request, res: Response) => {
		if (req.wallet.ownerId !== req.session.walletId) {
			return res.status(403).json({
				code: "W0006",
				message: "Only the owner of the wallet can do this",
			});
		}
		// Validate request body
		try {
			req.body = await Joi.object({
				username: Joi.string().required().trim(),
			}).validateAsync(req.body);
		} catch (error) {
			return res.status(400).json({
				code: "G0000",
				message: "Invalid JSON body",
			});
		}

		const wallets: Collection = getMongoCollection("wallets");

		// Get user by username, see if exists
		const newOwner = await wallets.findOne(
			{
				"user.username": req.body.username,
			},
			{ projection: { _id: 1 } }
		);
		if (!newOwner) {
			return res.status(404).json({
				code: "U0001",
				message: "User not found",
			});
		}

		await wallets.updateOne(
			{ _id: new ObjectId(req.wallet._id) },
			{ $set: { ownerId: new ObjectId(newOwner._id) } }
		);

		res.status(200).json({
			message: "Owner has been updated",
			owner: {
				_id: newOwner._id,
				username: req.body.username,
			},
		});
	}
);

router.put(
	"/:address/key",
	isLoggedIn(true),
	validWalletKey(),
	async (req: Request, res: Response) => {
		if (req.wallet.ownerId !== req.session.walletId) {
			return res.status(403).json({
				code: "W0006",
				message: "Only the owner of the wallet can do this",
			});
		}

		// Generate the new key
		let key = randomString(24);
		const salt: string = await bcrypt.genSalt(10);
		const hashedKey: string = await bcrypt.hash(key, salt);

		const wallets: Collection = getMongoCollection("wallets");

		await wallets.updateOne(
			{ _id: new ObjectId(req.wallet._id) },
			{ $set: { key: hashedKey } }
		);

		res.status(200).json({
			message: "Key changed and attached",
			key,
		});
	}
);

router.delete(
	"/:address",
	validWalletKey(),
	isLoggedIn(true),
	async (req: Request, res: Response) => {
		if (req.wallet.ownerId !== req.session.walletId) {
			return res.status(403).json({
				code: "W0006",
				message: "Only the owner of the wallet can do this",
			});
		}
		const wallets: Collection = getMongoCollection("wallets");
		const session = getMongoSession();

		// Used if user or wallet wasn't found to display error
		let userFound = true;
		let walletFound = true;

		// To store the assets in the wallet to return
		// to the requester
		let walletResult: any;

		// Take assets from wallet, put into users account
		await session.withTransaction(async () => {
			walletResult = await wallets.findOneAndDelete(
				{ _id: new ObjectId(req.wallet._id) },
				{
					session,
				}
			);

			if (!walletResult.value?._id) {
				walletFound = false;
				return await session.abortTransaction();
			}

			// create query update and to add assets back into user account
			let queryUpdate: any = { $inc: {} };
			for (const key in walletResult.value.assets) {
				queryUpdate.$inc[`assets.${key}`] = walletResult.value.assets[key];
			}

			let userResult = await wallets.updateOne(
				{ _id: new ObjectId(req.session.walletId) },
				queryUpdate,
				{ session }
			);

			if (!userResult.matchedCount) {
				userFound = false;
				return await session.abortTransaction();
			}
		});

		await session.endSession();

		if (!walletFound) {
			return res.status(404).json({
				code: "W0001",
				message: "A wallet with that address couldn't be found",
			});
		} else if (!userFound) {
			return res.status(404).json({
				code: "U0001",
				message: "User couldn't be found",
			});
		}

		// Cache transaction for user and
		// delete old wallet txs
		const redis = getRedisConnection();

		const transaction = {
			type: "receive",
			interactant: `#${req.wallet.address}`,
			memo: "Wallet deleted, these assets returned",
			assets: walletResult.value.assets,
		};
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
			.del(`wallets:${req.wallet._id}.transactions`)
			.exec();

		// TODO: Send over socket

		res.status(200).json({
			message: "Wallet deleted and assets transferred to account",
			assets: walletResult.value.assets,
		});
	}
);

export { router };
