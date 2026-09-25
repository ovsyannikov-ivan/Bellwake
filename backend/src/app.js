import "dotenv/config";
import { createServer } from "node:http";
import express from "express";
import helmet from "helmet";
import mqtt from "mqtt";
import { Server } from "socket.io";
import pool from "./database.js";
import { createAuthRouter } from "./routes/auth.js";
import enrollmentRouter from "./routes/enrollment.js";
import notificationsRouter from "./routes/notifications.js";
import pairingRouter from "./routes/pairing.js";
import { getAdminSessionByHash, getAdminSessionFromCookie, verifySocketCsrf } from "./services/adminAuth.js";
import { registerAdminNotificationHandlers } from "./socket/adminNotifications.js";

const app = express();

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3102);

const MQTT_LOCAL_PORT = Number(process.env.MQTT_LOCAL_PORT ?? 1883);
const MQTT_TOPIC = (process.env.MQTT_TOPIC ?? "bellwake/notifications").replace(/\/+$/, "");
const MQTT_RECONCILE_INTERVAL = Number(process.env.MQTT_RECONCILE_INTERVAL ?? 5000);

const MQTT_PUBLISHER_USER = process.env.MQTT_PUBLISHER_USER;
const MQTT_PUBLISHER_PASSWORD = process.env.MQTT_PUBLISHER_PASSWORD;

if (!MQTT_PUBLISHER_USER || !MQTT_PUBLISHER_PASSWORD) {
	throw new Error("MQTT publisher credentials are not configured");
}

const httpServer = createServer(app);

const io = new Server(httpServer, {
	path: "/api/socket.io",
	transports: ["websocket"],
});

/*
 * MQTT
 *
 * MQTT содержит только retained-маркеры реально действующих
 * уведомлений:
 *
 *   bellwake/notifications/17
 *   bellwake/notifications/42
 *
 * Содержимое сообщения:
 *
 *   {"notificationId":17}
 */
const mqttClient = mqtt.connect(`mqtt://127.0.0.1:${MQTT_LOCAL_PORT}`, {
	username: MQTT_PUBLISHER_USER,
	password: MQTT_PUBLISHER_PASSWORD,
	clientId: `bellwake-server-${process.pid}`,
	clean: true,
	reconnectPeriod: 5000,
	connectTimeout: 3000,
});

const publishedNotifications = new Map();

let mqttReconcileRunning = false;

const publishMqtt = (topic, payload) => {
	return new Promise((resolve, reject) => {
		mqttClient.publish(
			topic,
			payload,
			{
				qos: 1,
				retain: true,
			},
			(error) => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			}
		);
	});
};

const getNotificationTopic = (notificationId) => {
	return `${MQTT_TOPIC}/${notificationId}`;
};

const getNotificationSignature = (notification) => {
	return JSON.stringify({
		title: notification.title,
		body: notification.body,
		severity: notification.severity,
		ackRequired: Boolean(notification.ack_required),
		state: notification.state,
		startsAt: notification.starts_at,
		expiresAt: notification.expires_at,
	});
};

const publishNotification = async (notification) => {
	const notificationId = Number(notification.notification_id);
	const topic = getNotificationTopic(notificationId);
	const payload = JSON.stringify({
		notificationId,
	});

	await publishMqtt(topic, payload);

	console.log(`MQTT notification published: ${topic}`);
};

const removeNotification = async (notificationId) => {
	const topic = getNotificationTopic(notificationId);

	await publishMqtt(topic, Buffer.alloc(0));

	console.log(`MQTT notification removed: ${topic}`);
};

const reconcileNotifications = async ({ force = false } = {}) => {
	if (!mqttClient.connected || mqttReconcileRunning) {
		return;
	}

	mqttReconcileRunning = true;

	try {
		const [notifications] = await pool.query(
			`SELECT
				notification_id,
				title,
				body,
				severity,
				ack_required,
				state,
				starts_at,
				expires_at,
				(
					state = 'active'
					AND (
						starts_at IS NULL
						OR starts_at <= UTC_TIMESTAMP()
					)
					AND (
						expires_at IS NULL
						OR expires_at > UTC_TIMESTAMP()
					)
				) AS should_publish
			FROM notifications
			ORDER BY notification_id
			`
		);

		const existingIds = new Set();

		for (const notification of notifications) {
			const notificationId = Number(notification.notification_id);

			existingIds.add(notificationId);

			const shouldPublish = Boolean(notification.should_publish);
			const previousSignature = publishedNotifications.get(notificationId);

			if (shouldPublish) {
				const signature = getNotificationSignature(notification);

				/*
				 * Публикуем если:
				 *
					 * - сервер только подключился к MQTT;
				 * - уведомление только что стало действующим;
				 * - уже действующее уведомление было изменено.
				 */
				if (force || previousSignature !== signature) {
					await publishNotification(notification);

					publishedNotifications.set(notificationId, signature);
				}
				continue;
			}

			/*
			 * Если уведомление больше не должно быть действующим,
			 * снимаем retained-маркер.
			 *
			 * При принудительной синхронизации очищаем также старые retained-сообщения,
			 * оставшиеся в Mosquitto после перезапуска сервера.
			 */

			if (force || publishedNotifications.has(notificationId)) {
				await removeNotification(notificationId);
			}
			publishedNotifications.delete(notificationId);
		}

		/*
		 * Если запись была удалена из БД во время работы сервера,
		 * но её retained-топик ещё существует — снимаем его.
		 */
		for (const notificationId of [...publishedNotifications.keys()]) {
			if (existingIds.has(notificationId)) {
				continue;
			}

			await removeNotification(notificationId);
			publishedNotifications.delete(notificationId);
		}
	} catch (error) {
		console.error("MQTT notification reconciliation failed:", error);
	} finally {
		mqttReconcileRunning = false;
	}
};

mqttClient.on("connect", async () => {
	console.log(`Bellwake MQTT publisher connected to mqtt://127.0.0.1:${MQTT_LOCAL_PORT}`);

	/*
	 * На каждом новом подключении делаем полную синхронизацию.
	 *
	 * Это важно после перезапуска как Node.js, так и Mosquitto.
	 */
	await reconcileNotifications({
		force: true,
	});
});

mqttClient.on("reconnect", () => {
	console.log("Bellwake MQTT publisher reconnecting...");
});

mqttClient.on("error", (error) => {
	console.error("Bellwake MQTT publisher error:", error.message);
});

/*
 * Раз в несколько секунд проверяем переходы временных границ:
 *
 * наступил starts_at  -> публикуем уведомление;
 * наступил expires_at -> снимаем retained-сообщение.
 *
 * По умолчанию 5 секунд.
 */
setInterval(() => {
	void reconcileNotifications();
}, MQTT_RECONCILE_INTERVAL);

const adminNamespace = io.of("/admin");

const expireAdminSocket = (socket, acknowledgement) => {
	acknowledgement?.({ result: false, error: "Сессия администратора завершена" });
	socket.emit("auth:expired");
	socket.disconnect(true);
};

adminNamespace.use(async (socket, next) => {
	try {
		const session = await getAdminSessionFromCookie(socket.request.headers.cookie);
		if (!session || !verifySocketCsrf(socket.handshake.auth?.csrfToken, session)) {
			const error = new Error("Administrator session is required");
			error.data = { code: "admin_unauthorized" };
			return next(error);
		}

		socket.data.adminSession = session;
		next();
	} catch (error) {
		next(error);
	}
});

adminNamespace.on("connection", (socket) => {
	const expiresInMs = Math.max(0, Number(socket.data.adminSession.expiresAtEpoch) * 1000 - Date.now());
	const expirationTimer = setTimeout(() => expireAdminSocket(socket), expiresInMs);
	const validationTimer = setInterval(async () => {
		try {
			if (!await getAdminSessionByHash(socket.data.adminSession.sessionHash)) expireAdminSocket(socket);
		} catch (error) {
			console.error("Admin Socket.IO session validation failed:", error);
		}
	}, 60_000);

	socket.use(async (packet, next) => {
		try {
			const session = await getAdminSessionByHash(socket.data.adminSession.sessionHash);
			if (!session) {
				const acknowledgement = typeof packet.at(-1) === "function" ? packet.at(-1) : null;
				expireAdminSocket(socket, acknowledgement);
				return;
			}
			socket.data.adminSession = session;
			next();
		} catch (error) {
			next(error);
		}
	});

	socket.once("disconnect", () => {
		clearTimeout(expirationTimer);
		clearInterval(validationTimer);
	});
	registerAdminNotificationHandlers(adminNamespace, socket);
});

const disconnectAdminSession = (sessionHash) => {
	for (const socket of adminNamespace.sockets.values()) {
		if (socket.data.adminSession?.sessionHash === sessionHash) expireAdminSocket(socket);
	}
};

app.disable("x-powered-by");
app.set("trust proxy", "loopback");

app.use(helmet());
app.use(express.json({ limit: "256kb" }));

app.use("/api/auth", createAuthRouter({ onSessionRevoked: disconnectAdminSession }));
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
			mqtt: mqttClient.connected ? "connected" : "disconnected",
		});
	} catch (error) {
		console.error("Database health check failed:", error);

		res.status(503).json({
			ok: false,
			service: "bellwake",
			database: "unavailable",
			mqtt: mqttClient.connected ? "connected" : "disconnected",
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
