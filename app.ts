import helmet from "helmet";
import dotenv from "dotenv";
import { Server } from "socket.io";
import { createServer } from "http";
import session from "express-session";
import rateLimit from "express-rate-limit";
import { isLoggedIn } from "./handlers/auth";
import mongoSanitize from "express-mongo-sanitize";
import {
	connectToDatabases,
	getLegacyRedisConnection,
	getRedisConnection,
} from "./tools/db";
import express, { Application, NextFunction, Request, Response } from "express";

// Importing routes
import { router as user } from "./api/user";
import { router as users } from "./api/users";
import { router as wallet } from "./api/wallet";
import { router as wallets } from "./api/wallets";
import { router as transfers } from "./api/transfers";
import { router as warehouses } from "./api/warehouses";

// Import ENV variables
dotenv.config();

// Connect to DBs, if successful launch express app
connectToDatabases()
	.then(async () => {
		const app: Application = express();
		const httpServer = createServer(app);
		const io = new Server(httpServer, {
			cors: {
				origin: "*",
				methods: ["GET", "POST"],
			},
		});

		// Socket IO global usage
		app.set("io", io);

		// Get assets and their values from redis,
		// then create global object of them with timestamps
		// to prevent stale prices.
		const redis = getRedisConnection();
		const assets = await redis.HGETALL("assets");

		if (Object.keys(assets).length < 1) {
			console.log("'assets' not found in redis");
			process.exit();
		}

		const currentDateTime = Date.now();
		let assetValueObject: any = {};
		for (const key in assets) {
			assetValueObject[key] = {
				value: Number(assets[key]),
				updatedAt: currentDateTime,
			};
		}

		// Now set the variables
		app.set("assets", assetValueObject);
		app.set("assetsCheckedAt", currentDateTime);

		// Because app is ran behind NGINX
		app.set("trust proxy", 1);

		// Create the redis store for sessions
		let redisStore = require("connect-redis")(session);

		// Middlewares
		app.use(
			session({
				secret: process.env.SESSION_SECRET as string,
				store: new redisStore({
					client: getLegacyRedisConnection(),
				}),
				name: "sid",
				cookie: {
					maxAge: 1_000 * 60 * 30, // 30 minutes
					secure: process.env.NODE_ENV === "production",
					sameSite: true,
				},
				rolling: true,
				resave: false,
				saveUninitialized: false,
			})
		);
		app.use(express.json());
		app.use(helmet());
		app.use(mongoSanitize());

		// general rate limiter settings
		const generalLimiter = rateLimit({
			windowMs: 15 * 60 * 1000, // 15 minute window
			max: 150, // limit each IP to 150 requests per window
		});

		// Route Middlewares
		app.use("/users", generalLimiter, users);
		app.use("/user", generalLimiter, isLoggedIn(true), user);
		app.use("/wallets", wallets);
		app.use("/wallet", generalLimiter, isLoggedIn(), wallet);
		app.use("/transfers", generalLimiter, isLoggedIn(true, true), transfers);
		app.use(
			"/warehouses",
			generalLimiter,
			isLoggedIn(true, true),
			warehouses
		);

		// Error handler middlewares
		app.use(function (req: Request, res: Response, next: NextFunction) {
			res.status(404).json({
				code: "G0000",
				message: "The route you are requesting couldn't be found",
			});
		});
		app.use(function (
			err: Error,
			req: Request,
			res: Response,
			next: NextFunction
		) {
			console.error(err.stack);
			res.status(500).json({
				error: "Internal Server Error",
				message: "Unfortunately something broke in the server",
			});
		});

		// All is good, so start the app
		const APP_PORT: any = process.env.PORT || 5000;
		httpServer.listen(APP_PORT, () => {
			console.log(`Server started on port: ${APP_PORT}`);
			if (process.env.NODE_ENV === "production") {
				console.log(`Running in production mode`);
			} else {
				console.log(`Running in development mode`);
			}
		});
	})
	.catch((error) => console.log(error));
