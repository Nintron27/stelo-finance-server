import express, { Request, Response } from "express";
import { Collection } from "mongodb";
import {
	getMongoCollection,
	getMongoSession,
	getRedisConnection,
} from "../tools/db";
import bcrypt from "bcryptjs";
import Joi from "joi";
import { isGuest, masterKey } from "../handlers/auth";

const router = express.Router();

router.post("/", async (req: Request, res: Response) => {
	// Validate request body
	try {
		req.body = await Joi.object({
			username: Joi.string()
				.trim()
				.pattern(/^[_A-Za-z0-9-]+$/)
				.required(),
			password: Joi.string().required().min(10).max(32),
		}).validateAsync(req.body);
	} catch (error) {
		return res.status(400).json({
			code: "G0000",
			message: "Invalid JSON body",
		});
	}

	const redis = getRedisConnection();

	// Check if the user is already cached or registered
	const userCacheResult = await redis.get(
		`users:registration:${req.body.username}`
	);
	if (userCacheResult) {
		return res.status(400).json({
			code: "U0000",
			message: "Already registered",
		});
	}
	const wallets: Collection = getMongoCollection("wallets");
	const walletResult = await wallets.findOne(
		{
			"user.username": req.body.username,
		},
		{ projection: { _id: 1 } }
	);
	if (walletResult) {
		return res.status(400).json({
			code: "U0000",
			message: "Already registered",
		});
	}

	// Hashing the password
	const salt: string = await bcrypt.genSalt(10);
	const hashedPassword: string = await bcrypt.hash(req.body.password, salt);

	// Set the account is cache for one week
	await redis.setEx(
		`users:registration:${req.body.username}`,
		60 * 60 * 24 * 3,
		hashedPassword
	);

	res.status(201).json({
		message: "Account cached for 3 days, have it approved before then",
	});
});

router.put("/:username", masterKey(), async (req: Request, res: Response) => {
	const wallets: Collection = getMongoCollection("wallets");
	const redis = getRedisConnection();

	// See if the user has registered
	const hashedPassword = await redis.get(
		`users:registration:${req.params.username}`
	);
	if (!hashedPassword) {
		return res.status(404).json({
			code: "U0001",
			message: "User not found",
		});
	}

	// If the distribution is on, give free stelo
	// else just create account
	if (
		typeof req.query.distribution === "string" &&
		(req.query.distribution as string) === "true"
	) {
		const session = getMongoSession();

		let hasFunds = true;
		let distributionFound = true;
		let alreadyTaken = false;

		await session.withTransaction(async () => {
			let distribution = await wallets.findOne(
				{ address: "genesisdistribution" },
				{ session, projection: { assets: 1 } }
			);

			// Was distribution wallet found? Or is it empty?
			if (!distribution) {
				distributionFound = false;
				return await session.abortTransaction();
			} else if (distribution.assets.stelo <= 500) {
				hasFunds = false;
				return await session.abortTransaction();
			}

			// Calculate their free stelo
			const freeStelo = Math.floor(
				250000000 + distribution.assets.stelo * 0.0015
			);

			// Insert user into db and give free stelo!!
			// also catch error if username is taken
			let user;
			try {
				user = await wallets.insertOne(
					{
						user: {
							username: req.params.username,
							password: hashedPassword,
						},
						assets: {
							stelo: freeStelo,
						},
					},
					{ session }
				);
			} catch (error) {
				alreadyTaken = true;
				return await session.abortTransaction();
			}

			// Take stelo out of distribution wallet
			await wallets.updateOne(
				{ address: "genesisdistribution" },
				{ $inc: { "assets.stelo": -freeStelo } },
				{ session }
			);

			// Cache transaction for user
			const transactionDocument = {
				type: "receive",
				interactant: "#genesisdistribution",
				assets: { stelo: freeStelo },
			};
			await redis
				.multi()
				.lPush(
					`wallets:${user.insertedId}.transactions`,
					JSON.stringify(transactionDocument)
				)
				.expire(`wallets:${user.insertedId}.transactions`, 60 * 60 * 24 * 5)
				.exec();
		});

		await session.endSession();

		if (!distributionFound) {
			return res.status(500).json({
				code: "S0000",
				message: "genesisdistribution not found!",
			});
		} else if (!hasFunds) {
			return res.status(500).json({
				code: "S0001",
				message: "genesisdistribution funds critically low",
			});
		} else if (alreadyTaken) {
			return res.status(400).json({
				code: "U0000",
				message: "User already registered",
			});
		}
	} else {
		// catch error if username somehow has been taken
		try {
			await wallets.insertOne({
				user: {
					username: req.params.username,
					password: hashedPassword,
				},
				assets: {},
			});
		} catch (error) {
			return res.status(400).json({
				code: "U0000",
				message: "User already registered",
			});
		}
	}

	// Remove cached account
	await redis.del(`users:registration:${req.params.username}`);

	// Inform requester if distribution used
	let message: string;
	if (
		typeof req.query.distribution === "string" &&
		(req.query.distribution as string) === "true"
	) {
		message = `${req.params.username} confirmed, using distribution`;
	} else {
		message = `${req.params.username} confirmed`;
	}
	res.status(201).json({
		message,
	});
});

router.post(
	"/:username/sessions",
	isGuest(),
	async (req: Request, res: Response) => {
		// Validate request body
		try {
			req.body = await Joi.object({
				password: Joi.string().max(32).required(),
			}).validateAsync(req.body);
		} catch (error) {
			return res.status(400).json({
				code: "G0000",
				message: "Invalid JSON body",
			});
		}

		const wallets: Collection = getMongoCollection("wallets");

		// Check if user is registered
		const user: any = await wallets.findOne(
			{
				"user.username": req.params.username,
			},
			{ projection: { user: 1 } }
		);
		if (!user) {
			return res.status(400).json({
				code: "U0002",
				message: "Invalid username or password",
			});
		}

		// Checking if password is valid
		const validPassword: boolean = await bcrypt.compare(
			req.body.password,
			user.user.password
		);
		if (!validPassword) {
			return res.status(400).json({
				code: "U0002",
				message: "Invalid username or password",
			});
		}

		// Set their session variables
		req.session.isUser = true;
		req.session.walletId = user._id;
		req.session.address = user.user.username;
		if (user.user.warehouseAccountId) {
			req.session.warehouseAccountId = user.user.warehouseAccountId;
		}
		req.session.createdAt = Date.now();

		res.status(201).json({
			message: "Session created",
		});
	}
);

export { router };
