import "dotenv/config";
import { createServer } from "node:http";
import express from "express";
import helmet from "helmet";
import { Server } from "socket.io";
import pool from "./database.js";
import enrollmentRouter from "./routes/enrollment.js";
import notificationsRouter from "./routes/notifications.js";
import pairingRouter from "./routes/pairing.js";
import { registerAdminNotificationHandlers } from "./socket/adminNotifications.js";

const app = express();
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3102);
const httpServer = createServer(app);
const io = new Server(httpServer, {
	path: "/api/socket.io",
	transports: ["websocket"],
});

const adminNamespace = io.of("/admin");
adminNamespace.on("connection", (socket) => {
	// TODO: protect this namespace with a real administrator session before production.
	registerAdminNotificationHandlers(adminNamespace, socket);
});

app.disable("x-powered-by");
app.set("trust proxy", "loopback");

app.use(helmet());
app.use(express.json({ limit: "256kb" }));

app.use("/api/enroll", enrollmentRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/pairing", pairingRouter);

app.get("/api/health", async (req, res) => {
	try {
		await pool.query("SELECT 1");

		res.json({
			ok: true,
			service: "bellwake",
			database: "connected",
		});
	} catch (error) {
		console.error("Database health check failed:", error);

		res.status(503).json({
			ok: false,
			service: "bellwake",
			database: "unavailable",
		});
	}
});

app.use((req, res) => {
	res.status(404).json({
		error: "not_found",
		message: "Endpoint not found",
	});
});

app.use((error, req, res, next) => {
	console.error(error);

	res.status(500).json({
		error: "internal_server_error",
		message: "Internal server error",
	});
});

httpServer.listen(PORT, HOST, () => {
	console.log(`Bellwake API listening on http://${HOST}:${PORT}`);
});
