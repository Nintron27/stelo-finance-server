declare namespace Express {
	interface Request {
		wallet: {
			_id: string;
			address: string;
			ownerId: string;
		};
		warehouse: {
			name: string,
			collateral: number;
			collateralAvailable: number;
		}
	}
}