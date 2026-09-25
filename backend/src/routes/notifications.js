import crypto from "node:crypto";
import { Router } from "express";
import pool from "../database.js";
import { requireAdminSession } from "../services/adminAuth.js";
import { mysqlDateTimeToUtcIso } from "../services/dateTime.js";

const router = Router();

const notificationFields = `
	n.notification_id AS id,
	n.title,
	n.body,
	n.severity,
	n.ack_required AS ackRequired,
	n.state,
	n.starts_at AS startsAt,
	n.expires_at AS expiresAt,
	n.create_datetime AS createDatetime
`;

const sha256 = (value) => {
	return crypto.createHash("sha256").update(value).digest("hex");
};

const getNotificationId = (value) => {
	const notificationId = Number(value);

	return Number.isInteger(notificationId) && notificationId > 0
		? notificationId
		: null;
};

const serializeNotification = (notification) => ({
	...notification,
	ackRequired: Boolean(notification.ackRequired),
	startsAt: mysqlDateTimeToUtcIso(notification.startsAt),
	expiresAt: mysqlDateTimeToUtcIso(notification.expiresAt),
	createDatetime: mysqlDateTimeToUtcIso(notification.createDatetime),
});

const authenticateAgent = async (req, res, next) => {
	try {
		const authorization = req.get("authorization") ?? "";
		const match = authorization.match(/^Bearer\s+(.+)$/i);
		const clientToken = match?.[1]?.trim();
		const deviceId = (req.get("x-bellwake-device-id") ?? "").trim().toLowerCase();

		if (!clientToken || clientToken.length > 512 || !/^[a-f0-9]{64}$/.test(deviceId)) {
			return res.status(401).json({
				error: "agent_unauthorized",
				message: "Agent credentials are required",
			});
		}

		const [rows] = await pool.execute(
			`SELECT
				device_id AS deviceId,
				user_key AS userKey
			FROM device_users
			WHERE device_id = ?
			  AND client_token_hash = ?
			LIMIT 1
			`,
			[deviceId, sha256(clientToken)]
		);

		if (rows.length === 0) {
			return res.status(401).json({
				error: "agent_unauthorized",
				message: "Agent credentials are invalid",
			});
		}

		req.bellwakeAgent = rows[0];
		next();
	} catch (error) {
		next(error);
	}
};

router.get("/:notificationId/delivery", authenticateAgent, async (req, res, next) => {
	try {
		const notificationId = getNotificationId(req.params.notificationId);

		if (!notificationId) {
			return res.status(400).json({
				error: "invalid_notification_id",
				message: "Invalid notification ID",
			});
		}

		const { deviceId, userKey } = req.bellwakeAgent;
		const [rows] = await pool.execute(
			`SELECT
				${notificationFields},
				EXISTS (
					SELECT 1
					FROM notification_ack AS a
					WHERE a.notification_id = n.notification_id
					  AND a.device_id = ?
					  AND a.user_key = ?
				) AS acknowledged
			FROM notifications AS n
			WHERE n.notification_id = ?
			LIMIT 1
			`,
			[deviceId, userKey, notificationId]
		);

		if (rows.length === 0) {
			return res.status(404).json({
				error: "notification_not_found",
				message: "Notification not found",
			});
		}

		if (Boolean(rows[0].acknowledged)) {
			return res.status(204).end();
		}

		delete rows[0].acknowledged;
		res.json(serializeNotification(rows[0]));
	} catch (error) {
		next(error);
	}
});

router.post("/:notificationId/acknowledge", authenticateAgent, async (req, res, next) => {
	try {
		const notificationId = getNotificationId(req.params.notificationId);

		if (!notificationId) {
			return res.status(400).json({
				error: "invalid_notification_id",
				message: "Invalid notification ID",
			});
		}

		const { deviceId, userKey } = req.bellwakeAgent;
		await pool.execute(
			`INSERT INTO notification_ack (
				notification_id,
				device_id,
				user_key,
				acknowledged_at
			)
			SELECT ?, ?, ?, UTC_TIMESTAMP()
			FROM notifications
			WHERE notification_id = ?
			ON DUPLICATE KEY UPDATE
				acknowledged_at = acknowledged_at
			`,
			[notificationId, deviceId, userKey, notificationId]
		);

		const [rows] = await pool.execute(
			`SELECT acknowledged_at AS acknowledgedAt
			FROM notification_ack
			WHERE notification_id = ?
			  AND device_id = ?
			  AND user_key = ?
			LIMIT 1
			`,
			[notificationId, deviceId, userKey]
		);

		if (rows.length === 0) {
			return res.status(404).json({
				error: "notification_not_found",
				message: "Notification not found",
			});
		}

		await Promise.all([
			pool.execute(
				"UPDATE device_users SET last_seen = UTC_TIMESTAMP() WHERE device_id = ? AND user_key = ?",
				[deviceId, userKey]
			),
			pool.execute(
				"UPDATE devices SET last_seen = UTC_TIMESTAMP() WHERE device_id = ?",
				[deviceId]
			),
		]);

		res.json({
			notificationId,
			acknowledged: true,
			acknowledgedAt: mysqlDateTimeToUtcIso(rows[0].acknowledgedAt),
		});
	} catch (error) {
		next(error);
	}
});

router.get("/:notificationId", requireAdminSession, async (req, res, next) => {
	try {
		const notificationId = getNotificationId(req.params.notificationId);

		if (!notificationId) {
			return res.status(400).json({
				error: "invalid_notification_id",
				message: "Invalid notification ID",
			});
		}

		const [rows] = await pool.query(
			`SELECT ${notificationFields}
			FROM notifications AS n
			WHERE n.notification_id = ?
			LIMIT 1
			`,
			[notificationId]
		);

		if (rows.length === 0) {
			return res.status(404).json({
				error: "notification_not_found",
				message: "Notification not found",
			});
		}

		res.json(serializeNotification(rows[0]));
	} catch (error) {
		next(error);
	}
});

export default router;
