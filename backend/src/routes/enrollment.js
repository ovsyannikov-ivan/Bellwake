import crypto from "node:crypto";
import express from "express";
import pool from "../database.js";
import { verifyAgentCredentials } from "../services/mqtt.js";

const router = express.Router();

const sha256 = (value) => {
	return crypto.createHash("sha256").update(value).digest("hex");
};

const generateSecret = () => {
	return crypto.randomBytes(32).toString("hex");
};

const safeEqual = (left, right) => {
	if (typeof left !== "string" || typeof right !== "string") {
		return false;
	}

	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);

	if (leftBuffer.length !== rightBuffer.length) {
		return false;
	}
	return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const getUserKey = (user) => {
	const identity = user.sid ? `sid:${user.sid.toLowerCase()}` : `username:${user.username.toLowerCase()}`;
	return sha256(`bellwake:user:v1:${identity}`);
};

const getMqttClientId = (deviceId, userKey) => {
	return sha256(`bellwake:mqtt-client:v1:${deviceId}:${userKey}`);
};

router.post("/", async (req, res, next) => {
	let connection;
	try {
		const { enrollmentToken, clientToken, device, user } = req.body ?? {};

		if (!device?.deviceId || !device?.hostname || !user?.username) {
			return res.status(400).json({
				error: "invalid_request",
			});
		}

		const enrollmentSecret = process.env.ENROLLMENT_TOKEN;

		if (!enrollmentSecret) {
			throw new Error("ENROLLMENT_TOKEN is not configured");
		}

		const mqttUsername = process.env.MQTT_AGENT_USER;
		const mqttPassword = process.env.MQTT_AGENT_PASSWORD;

		if (!mqttUsername || !mqttPassword) {
			throw new Error("MQTT agent credentials are not configured");
		}

		await verifyAgentCredentials({
			username: mqttUsername,
			password: mqttPassword,
		});

		const userKey = getUserKey(user);
		const mqttClientId = getMqttClientId(device.deviceId, userKey);

		connection = await pool.getConnection();
		const [rows] = await connection.execute(
			`SELECT
				client_token_hash
			FROM device_users
			WHERE device_id = ?
			  AND user_key = ?
			LIMIT 1
			`,
			[device.deviceId, userKey]
		);

		const existing = rows[0] ?? null;
		const validClientToken = existing?.client_token_hash && clientToken && safeEqual(sha256(clientToken), existing.client_token_hash);
		const validEnrollmentToken = enrollmentToken && safeEqual(enrollmentToken, enrollmentSecret);

		if (!validClientToken && !validEnrollmentToken) {
			return res.status(403).json({
				error: "enrollment_not_authorized",
			});
		}

		const newClientToken = !validClientToken ? generateSecret() : null;
		await connection.beginTransaction();
		await connection.execute(
			`INSERT INTO devices (
				device_id,
				hostname,
				os,
				native_id_type,
				last_seen
			)
			VALUES (?, ?, ?, ?, NOW())
			ON DUPLICATE KEY UPDATE
				hostname = VALUES(hostname),
				os = VALUES(os),
				native_id_type = VALUES(native_id_type),
				last_seen = NOW()
			`,
			[device.deviceId, device.hostname, device.os ?? null, device.nativeIdType ?? null]
		);
		await connection.execute(
			`INSERT INTO device_users (
				device_id,
				user_key,
				username,
				sid,
				client_token_hash,
				first_seen,
				last_seen,
				last_enroll_at
			)
			VALUES (?, ?, ?, ?, ?, NOW(), NOW(), NOW())
			ON DUPLICATE KEY UPDATE
				username = VALUES(username),
				sid = VALUES(sid),

				client_token_hash =
					COALESCE(
						VALUES(client_token_hash),
						client_token_hash
					),

				last_seen = NOW(),
				last_enroll_at = NOW()
			`,
			[device.deviceId, userKey, user.username, user.sid ?? null, newClientToken ? sha256(newClientToken) : null]
		);
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
