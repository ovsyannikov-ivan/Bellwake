import crypto from "node:crypto";
import express from "express";
import pool from "../database.js";
import { verifyAgentCredentials } from "../services/mqtt.js";

const router = express.Router();
const SHA256_RE = /^[a-f0-9]{64}$/;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const generateSecret = () => crypto.randomBytes(32).toString("hex");

const safeEqual = (left, right) => {
	if (typeof left !== "string" || typeof right !== "string") return false;
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const getUserKey = (user) => {
	const identity = user.sid ? `sid:${user.sid.toLowerCase()}` : `username:${user.username.toLowerCase()}`;
	return sha256(`bellwake:user:v1:${identity}`);
};

const getMqttClientId = (deviceId, userKey) => sha256(`bellwake:mqtt-client:v1:${deviceId}:${userKey}`);

router.post("/", async (req, res, next) => {
	let connection;

	try {
		const { enrollmentToken, clientToken, device, user } = req.body ?? {};
		const deviceId = String(device?.deviceId ?? "").trim().toLowerCase();
		const providedEnrollmentToken = typeof enrollmentToken === "string" ? enrollmentToken.trim() : "";

		if (!SHA256_RE.test(deviceId) || !device?.hostname || !user?.username) {
			return res.status(400).json({ error: "invalid_request" });
		}

		const enrollmentSecret = process.env.ENROLLMENT_TOKEN;
		if (!enrollmentSecret) throw new Error("ENROLLMENT_TOKEN is not configured");

		const mqttUsername = process.env.MQTT_AGENT_USER;
		const mqttPassword = process.env.MQTT_AGENT_PASSWORD;
		if (!mqttUsername || !mqttPassword) throw new Error("MQTT agent credentials are not configured");

		await verifyAgentCredentials({ username: mqttUsername, password: mqttPassword });

		const userKey = getUserKey(user);
		const mqttClientId = getMqttClientId(deviceId, userKey);
		connection = await pool.getConnection();
		await connection.beginTransaction();

		const [rows] = await connection.execute(
			`SELECT client_token_hash
			FROM device_users
			WHERE device_id = ? AND user_key = ?
			LIMIT 1
			FOR UPDATE`,
			[deviceId, userKey],
		);
		const existing = rows[0] ?? null;
		const validClientToken = Boolean(
			existing?.client_token_hash && clientToken && safeEqual(sha256(clientToken), existing.client_token_hash),
		);
		const validManualEnrollment = Boolean(
			providedEnrollmentToken && safeEqual(providedEnrollmentToken, enrollmentSecret),
		);

		let pairingRequest = null;
		if (providedEnrollmentToken && !validManualEnrollment) {
			const [pairingRows] = await connection.execute(
				`SELECT pairing_request_id AS pairingRequestId,
					approved_by_user_id AS approvedByUserId
				FROM pairing_requests
				WHERE token_hash = ?
				  AND status IN ('pending', 'delivered')
				  AND used_at IS NULL
				  AND expires_at > UTC_TIMESTAMP()
				LIMIT 1
				FOR UPDATE`,
				[sha256(providedEnrollmentToken)],
			);
			pairingRequest = pairingRows[0] ?? null;
		}

		if (providedEnrollmentToken) {
			if (!validManualEnrollment && !pairingRequest) {
				await connection.rollback();
				return res.status(403).json({ error: "enrollment_not_authorized" });
			}
		} else if (!validClientToken) {
			await connection.rollback();
			return res.status(403).json({ error: "enrollment_not_authorized" });
		}

		const newClientToken = !validClientToken ? generateSecret() : null;
		await connection.execute(
			`INSERT INTO devices (
				device_id, hostname, os, native_id_type, last_seen
			)
			VALUES (?, ?, ?, ?, UTC_TIMESTAMP())
			ON DUPLICATE KEY UPDATE
				hostname = VALUES(hostname),
				os = VALUES(os),
				native_id_type = VALUES(native_id_type),
				last_seen = UTC_TIMESTAMP()`,
			[deviceId, device.hostname, device.os ?? null, device.nativeIdType ?? null],
		);
		await connection.execute(
			`INSERT INTO device_users (
				device_id, user_key, username, sid, client_token_hash,
				enrolled_by_user_id, first_seen, last_seen, last_enroll_at
			)
			VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP())
			ON DUPLICATE KEY UPDATE
				username = VALUES(username),
				sid = VALUES(sid),
				client_token_hash = COALESCE(VALUES(client_token_hash), client_token_hash),
				enrolled_by_user_id = COALESCE(VALUES(enrolled_by_user_id), enrolled_by_user_id),
				last_seen = UTC_TIMESTAMP(),
				last_enroll_at = UTC_TIMESTAMP()`,
			[
				deviceId,
				userKey,
				user.username,
				user.sid ?? null,
				newClientToken ? sha256(newClientToken) : null,
				pairingRequest?.approvedByUserId ?? null,
			],
		);

		if (pairingRequest) {
			const [result] = await connection.execute(
				`UPDATE pairing_requests
				SET status = 'consumed',
					used_at = UTC_TIMESTAMP(),
					enrolled_device_id = ?,
					enrolled_user_key = ?
				WHERE pairing_request_id = ? AND used_at IS NULL`,
				[deviceId, userKey, pairingRequest.pairingRequestId],
			);
			if (result.affectedRows !== 1) throw new Error("Pairing request was already consumed");
		}

		await connection.commit();

		return res.json({
			...(newClientToken ? { clientToken: newClientToken } : {}),
			mqtt: {
				host: req.hostname,
				port: Number(process.env.MQTT_PORT ?? 8883),
				topic: process.env.MQTT_TOPIC ?? "bellwake/notifications",
				username: mqttUsername,
				password: mqttPassword,
				clientId: mqttClientId,
			},
		});
	} catch (error) {
		if (connection) {
			try {
				await connection.rollback();
			} catch {
				// Транзакция уже могла завершиться.
			}
		}
		next(error);
	} finally {
		connection?.release();
	}
});

export default router;
