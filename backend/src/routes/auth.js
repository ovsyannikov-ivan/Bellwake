import argon2 from "argon2";
import { Router } from "express";
import pool from "../database.js";
import {
	clearAdminSessionCookie,
	createAdminSession,
	getAdminSessionFromCookie,
	requireAdminRequest,
	requireAdminSession,
	requireCsrf,
	revokeAdminSession,
	sessionToResponse,
	setAdminSessionCookie,
} from "../services/adminAuth.js";

const MAX_FAILED_ATTEMPTS = 5;
const MAX_FAILED_ATTEMPTS_PER_IP = 25;
const ATTEMPT_WINDOW_MINUTES = 15;

const normalizeUsername = (value) => (typeof value === "string" ? value.trim() : "");
const normalizePassword = (value) => (typeof value === "string" ? value : "");

const recordFailedAttempt = async (username, ipAddress) => {
	await Promise.all([
		pool.execute(
			"INSERT INTO login_attempts (username, ip_address, attempted_at) VALUES (?, ?, UTC_TIMESTAMP())",
			[username.slice(0, 100), ipAddress],
		),
		pool.execute("DELETE FROM login_attempts WHERE attempted_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)"),
	]);
};

const isLoginRateLimited = async (username, ipAddress) => {
	const [rows] = await pool.execute(
		`SELECT
			SUM(username = ?) AS usernameCount,
			COUNT(*) AS ipCount
		FROM login_attempts
		WHERE ip_address = ?
		  AND attempted_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${ATTEMPT_WINDOW_MINUTES} MINUTE)`,
		[username.slice(0, 100), ipAddress],
	);
	return Number(rows[0]?.usernameCount ?? 0) >= MAX_FAILED_ATTEMPTS
		|| Number(rows[0]?.ipCount ?? 0) >= MAX_FAILED_ATTEMPTS_PER_IP;
};

export const createAuthRouter = ({ onSessionRevoked } = {}) => {
	const router = Router();

	router.post("/login", requireAdminRequest, async (req, res, next) => {
		let connection;
		try {
			const username = normalizeUsername(req.body?.username);
			const password = normalizePassword(req.body?.password);
			const ipAddress = String(req.ip ?? "").slice(0, 45);

			if (!username || username.length > 100 || !password || password.length > 1024) {
				return res.status(400).json({ error: "invalid_credentials", message: "Invalid username or password" });
			}

			if (await isLoginRateLimited(username, ipAddress)) {
				res.setHeader("Retry-After", String(ATTEMPT_WINDOW_MINUTES * 60));
				return res.status(429).json({ error: "login_rate_limited", message: "Too many failed login attempts" });
			}

			const [rows] = await pool.execute(
				`SELECT user_id AS userId, username, password_hash AS passwordHash,
					display_name AS displayName, is_active AS isActive
				FROM users WHERE username = ? LIMIT 1`,
				[username],
			);
			const user = rows[0] ?? null;
			const passwordValid = user
				? await argon2.verify(user.passwordHash, password)
				: (await argon2.hash(password), false);

			if (!user || !passwordValid) {
				await recordFailedAttempt(username, ipAddress);
				return res.status(401).json({ error: "invalid_credentials", message: "Invalid username or password" });
			}
			if (!Boolean(user.isActive)) {
				await recordFailedAttempt(username, ipAddress);
				return res.status(403).json({ error: "user_inactive", message: "Administrator account is inactive" });
			}

			connection = await pool.getConnection();
			await connection.beginTransaction();
			const session = await createAdminSession({
				userId: user.userId,
				ipAddress,
				userAgent: req.get("user-agent"),
				database: connection,
			});
			await connection.execute("UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE user_id = ?", [user.userId]);
			await connection.commit();
			connection.release();
			connection = null;

			void Promise.all([
				pool.execute("DELETE FROM login_attempts WHERE username = ? AND ip_address = ?", [username, ipAddress]),
				pool.execute("DELETE FROM login_attempts WHERE attempted_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)"),
				pool.execute("DELETE FROM sessions WHERE expires_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)"),
			]).catch((error) => console.error("Admin authentication cleanup failed:", error));

			setAdminSessionCookie(res, session.sessionToken);
			res.setHeader("Cache-Control", "no-store");
			return res.json(sessionToResponse(user, session.csrfToken, session.expiresAt));
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

	router.get("/me", async (req, res, next) => {
		try {
			const session = await getAdminSessionFromCookie(req.get("cookie"));
			if (!session) {
				clearAdminSessionCookie(res);
				return res.status(401).json({ error: "admin_unauthorized" });
			}

			res.setHeader("Cache-Control", "no-store");
			return res.json(sessionToResponse(
				session,
				session.csrfToken,
				new Date(Number(session.expiresAtEpoch) * 1000).toISOString(),
			));
		} catch (error) {
			next(error);
		}
	});

	router.post("/logout", requireAdminRequest, requireAdminSession, requireCsrf, async (req, res, next) => {
		try {
			await revokeAdminSession(req.bellwakeAdmin.sessionHash);
			clearAdminSessionCookie(res);
			onSessionRevoked?.(req.bellwakeAdmin.sessionHash);
			return res.status(204).end();
		} catch (error) {
			next(error);
		}
	});

	return router;
};
