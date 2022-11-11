import session from "express-session";

declare module "express-session" {
	interface Session {
		isUser: boolean;
		walletId: string;
		warehouseAccountId: string | undefined;
		address: string;
		createdAt: number;
	}
}
