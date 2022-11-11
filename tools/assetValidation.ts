import { getRedisConnection } from "./db";
import { Request } from "express";

/**
 * Validates if the assets in `assetsToCheck` are valid, if so returns total collateral value
 * of all of them. If invalid, returns -1.
 * @param assetsToCheck Object with asset names as keys, and their quantity as their value.
 * @param expressRequest Must be the routes Request variable.
 * @param steloAllowed Whether or not 'stelo' is a valid asset for this request.
 * @returns If the assets are invalid, returns -1, otherwise collateral value of `assetsToCheck`
 */
export async function validateAssets(
	assetsToCheck: any,
	expressRequest: Request,
	steloAllowed: boolean = false
): Promise<number> {
	const currentDateTime = Date.now();
	const thirtyMinutes = 1000 * 60 * 30;
	const redis = getRedisConnection();

	const globalAssetObject = expressRequest.app.get("assets");
	const globalAssetsUpdatedAt = expressRequest.app.get("assetsCheckedAt");

	let totalCollateral = 0;
	let outdatedAssets: string[] = [];

	// Loop the assets, if they are 0 or smaller
	// than just return -1. If the key is missing from
	// the object we are checking against than check
	// if the object is older than an hour.
	// If so, update the entire global object.
	for (const key in assetsToCheck) {
		if (Number.isInteger(assetsToCheck[key]) && assetsToCheck[key] >= 1) {
			if (key in globalAssetObject) {
				if (
					globalAssetObject[key].updatedAt <
					currentDateTime - thirtyMinutes
				) {
					// Save the stale keys to do just 1 db call
					outdatedAssets.push(key);
				} else {
					totalCollateral +=
						globalAssetObject[key].value * assetsToCheck[key];
				}
			} else if (key === 'stelo') {
				if (!steloAllowed) {
					return -1;
				}
			} else if (
				globalAssetsUpdatedAt <
				currentDateTime - thirtyMinutes * 2
			) {
				const assets = await redis.HGETALL("assets");

				// TODO: Handle this better LOL
				if (Object.keys(assets).length < 1) {
					return -1;
				}

				let assetValueObject: any = {};
				for (const key in assets) {
					assetValueObject[key] = {
						value: Number(assets[key]),
						updatedAt: currentDateTime,
					};
				}

				// Now set the variables
				expressRequest.app.set("assets", assetValueObject);
				expressRequest.app.set("assetsCheckedAt", currentDateTime);

				// Now, check if asset is there, if so add collateral
				if (key in assets) {
					totalCollateral += Number(assets[key]) * assetsToCheck[key];
				} else {
					return -1;
				}
			} else {
				return -1;
			}
		} else {
			return -1;
		}
	}

	// Now handle the outdated assets if there are any.
	// Get the updated values, loop through the outdated assets
	// and handle all outcomes
	if (outdatedAssets.length >= 1) {
		const updatedAssets = await redis.HMGET("assets", outdatedAssets);

		for (let index = 0; index < updatedAssets.length; index++) {
			// If asset was removed, delete from global object
			// and return -1. ELSE, update global object and
			// add that collateral up.
			if (updatedAssets[index] === null) {
				delete globalAssetObject[outdatedAssets[index]];
				return -1;
			} else {
				// Update value in the global object :D
				// (one time using object refencing is nice)
				globalAssetObject[outdatedAssets[index]] = {
					value: Number(updatedAssets[index]),
					updatedAt: currentDateTime,
				};

				// Add the collateral in
				totalCollateral +=
					Number(updatedAssets[index]) *
					assetsToCheck[outdatedAssets[index]];
			}
		}
	}

	return totalCollateral;
}
