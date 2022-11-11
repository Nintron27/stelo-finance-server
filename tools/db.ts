import { MongoClient, Collection, Db, ClientSession } from "mongodb";
import { createClient, RedisClientType } from "redis";

let mongoClient: MongoClient;
let redisConnection: RedisClientType;
let redisLegacyConnection: RedisClientType;

export async function connectToDatabases(): Promise<void> {
	const mongoConnectionString: any = process.env.MONGO_DB_CONNECT;
	const redisConnectionString: any = process.env.REDIS_DB_CONNECT;

	// Create the mongo client
	const client = await MongoClient.connect(mongoConnectionString);
	mongoClient = client;

	// Create the redis client and legacy client
	let redisClient = createClient({
		url: redisConnectionString,
	});
	await redisClient.connect();
	let redisLegacyClient = createClient({
		url: redisConnectionString,
		legacyMode: true,
	});
	redisLegacyClient.connect();

	// @ts-ignore
	redisConnection = redisClient;
	// @ts-ignore
	redisLegacyConnection = redisLegacyClient;
}

export function getRedisConnection(): RedisClientType {
	return redisConnection;
}

export function getLegacyRedisConnection(): RedisClientType {
	return redisLegacyConnection;
}

export function getMongoCollection(collection: string): Collection {
	return mongoClient.db("stelo").collection(collection);
}

export function getMongoSession(): ClientSession {
	return mongoClient.startSession();
}
