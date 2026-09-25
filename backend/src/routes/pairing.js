import crypto from "node:crypto";
import { Router } from "express";
import pool from "../database.js";
import { requireAdminRequest, requireAdminSession, requireCsrf } from "../services/adminAuth.js";

const router = Router();
const RELAY_URL = "https://bellwake-relay.ovsyannikov-ivan.workers.dev";
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAIRING_TTL_SECONDS = 5 * 60;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const generatePairingToken = () => crypto.randomBytes(32).toString("hex");

const getServerUrl = () => {
	const value = process.env.BELLWAKE_DOMAIN?.trim();
	if (!value) throw new Error("BELLWAKE_DOMAIN is not configured");
	if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, "");
	return `https://${value.replace(/\/+$/, "")}`;
};

const markPairingFailed = async (tokenHash) => {
	if (!tokenHash) return;
	await pool.execute(
		"UPDATE pairing_requests SET status = 'failed' WHERE token_hash = ? AND status = 'pending'",
		[tokenHash],
	);
};

router.post("/approve", requireAdminRequest, requireAdminSession, requireCsrf, async (req, res, next) => {
	let connection;
	let pairingTokenHash;

	try {
		const socketId = String(req.body?.socketId ?? "").trim().toLowerCase();
		if (!UUID_V4_RE.test(socketId)) {
			return res.status(400).json({ error: "invalid_socket_id", message: "Invalid pairing socket ID" });
		}

		const relaySendToken = process.env.RELAY_SEND_TOKEN?.trim();
		if (!relaySendToken) throw new Error("RELAY_SEND_TOKEN is not configured");

		const pairingToken = generatePairingToken();
		pairingTokenHash = sha256(pairingToken);
		connection = await pool.getConnection();
		await connection.beginTransaction();

		const [existingRows] = await connection.execute(
			`SELECT status, expires_at > UTC_TIMESTAMP() AS isActive
			FROM pairing_requests
			WHERE socket_id = ?
			LIMIT 1
			FOR UPDATE`,
			[socketId],
		);
		const existing = existingRows[0];
		if (Boolean(Number(existing?.isActive)) && ["pending", "delivered"].includes(existing.status)) {
			await connection.rollback();
			return res.status(409).json({
				error: "pairing_already_approved",
				message: "This pairing session has already been approved",
			});
		}

		await connection.execute(
			`INSERT INTO pairing_requests (
				socket_id, token_hash, approved_by_user_id, status, created_at, expires_at,
				delivered_at, used_at, enrolled_device_id, enrolled_user_key
			)
			VALUES (?, ?, ?, 'pending', UTC_TIMESTAMP(), DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND), NULL, NULL, NULL, NULL)
			ON DUPLICATE KEY UPDATE
				token_hash = VALUES(token_hash),
				approved_by_user_id = VALUES(approved_by_user_id),
				status = 'pending',
				created_at = UTC_TIMESTAMP(),
				expires_at = VALUES(expires_at),
				delivered_at = NULL,
				used_at = NULL,
				enrolled_device_id = NULL,
				enrolled_user_key = NULL`,
			[socketId, pairingTokenHash, req.bellwakeAdmin.userId, PAIRING_TTL_SECONDS],
		);
		await connection.commit();
		connection.release();
		connection = null;

		const response = await fetch(`${RELAY_URL}/send/${encodeURIComponent(socketId)}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${relaySendToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				type: "pairingApproved",
				serverUrl: getServerUrl(),
				enrollmentToken: pairingToken,
			}),
			signal: AbortSignal.timeout(5000),
		});
		const body = await response.text();

		if (!response.ok) {
			console.error(`Bellwake Relay returned HTTP ${response.status}: ${body}`);
			await markPairingFailed(pairingTokenHash);
			return res.status(502).json({ error: "relay_delivery_failed", message: "Unable to deliver pairing data" });
		}

		await pool.execute(
			"UPDATE pairing_requests SET status = 'delivered', delivered_at = UTC_TIMESTAMP() WHERE token_hash = ? AND status = 'pending'",
			[pairingTokenHash],
		);
		await pool.execute(
			"DELETE FROM pairing_requests WHERE expires_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)",
		);

		return res.json({ delivered: true });
	} catch (error) {
		if (connection) {
			try {
				await connection.rollback();
			} catch {
				/* Транзакция уже могла завершиться. */
			}
		}
		if (error?.name === "TimeoutError") {
			await markPairingFailed(pairingTokenHash);
			return res.status(504).json({ error: "relay_timeout", message: "Bellwake Relay did not respond in time" });
		}
		next(error);
	} finally {
		connection?.release();
	}
});

export default router;
