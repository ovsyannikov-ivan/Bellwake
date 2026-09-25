import crypto from "node:crypto";
import pool from "../database.js";

export const ADMIN_SESSION_COOKIE = "bellwake_admin_session";
export const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const generateToken = () => crypto.randomBytes(32).toString("hex");

const safeEqual = (left, right) => {
	if (typeof left !== "string" || typeof right !== "string") return false;
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const parseCookies = (header = "") => {
	const cookies = new Map();
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator < 1) continue;
		const name = part.slice(0, separator).trim();
		const value = part.slice(separator + 1).trim();
		try {
			cookies.set(name, decodeURIComponent(value));
		} catch {
			cookies.set(name, value);
		}
	}
	return cookies;
};

export const getSessionTokenFromCookie = (cookieHeader) => {
	const token = parseCookies(cookieHeader).get(ADMIN_SESSION_COOKIE);
	return typeof token === "string" && /^[a-f0-9]{64}$/.test(token) ? token : null;
};

export const getAdminSessionByHash = async (sessionHash) => {
	if (!/^[a-f0-9]{64}$/.test(sessionHash ?? "")) return null;

	const [rows] = await pool.execute(
		`SELECT
			s.session_id AS sessionHash,
			s.csrf_token AS csrfToken,
			UNIX_TIMESTAMP(s.expires_at) AS expiresAtEpoch,
			u.user_id AS userId,
			u.username,
			u.display_name AS displayName
		FROM sessions AS s
		INNER JOIN users AS u ON u.user_id = s.user_id
		WHERE s.session_id = ?
		  AND s.revoked_at IS NULL
		  AND s.expires_at > UTC_TIMESTAMP()
		  AND u.is_active = 1
		LIMIT 1`,
		[sessionHash],
	);

	return rows[0] ?? null;
};

export const getAdminSessionFromCookie = async (cookieHeader) => {
	const token = getSessionTokenFromCookie(cookieHeader);
	if (!token) return null;
	return getAdminSessionByHash(sha256(token));
};

export const createAdminSession = async ({ userId, ipAddress, userAgent, database = pool }) => {
	const sessionToken = generateToken();
	const csrfToken = generateToken();
	const sessionHash = sha256(sessionToken);

	await database.execute(
		`INSERT INTO sessions (
			session_id,
			user_id,
			csrf_token,
			ip_address,
			user_agent,
			expires_at
		)
		VALUES (?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND))`,
		[sessionHash, userId, csrfToken, ipAddress ?? null, userAgent?.slice(0, 512) || null, ADMIN_SESSION_TTL_SECONDS],
	);

	return {
		sessionToken,
		sessionHash,
		csrfToken,
		expiresAt: new Date(Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000).toISOString(),
	};
};

export const revokeAdminSession = async (sessionHash) => {
	if (!sessionHash) return;
	await pool.execute(
		"UPDATE sessions SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()) WHERE session_id = ?",
		[sessionHash],
	);
};

export const setAdminSessionCookie = (res, sessionToken) => {
	res.setHeader(
		"Set-Cookie",
		`${ADMIN_SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; Path=/; Max-Age=${ADMIN_SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
	);
};

export const clearAdminSessionCookie = (res) => {
	res.setHeader(
		"Set-Cookie",
		`${ADMIN_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
	);
};

export const requireAdminRequest = (req, res, next) => {
	if (req.get("x-bellwake-request") !== "admin") {
		return res.status(403).json({ error: "csrf_rejected", message: "Administrative request marker is missing" });
	}

	if (req.get("sec-fetch-site") === "cross-site") {
		return res.status(403).json({ error: "csrf_rejected", message: "Cross-site request is not allowed" });
	}

	const origin = req.get("origin");
	if (origin) {
		try {
			new URL(origin);
		} catch {
			return res.status(403).json({ error: "csrf_rejected", message: "Request origin is invalid" });
		}
	}

	next();
};

export const requireAdminSession = async (req, res, next) => {
	try {
		const token = getSessionTokenFromCookie(req.get("cookie"));
		const sessionHash = token ? sha256(token) : null;
		const session = sessionHash ? await getAdminSessionByHash(sessionHash) : null;

		if (!session) {
			clearAdminSessionCookie(res);
			return res.status(401).json({ error: "admin_unauthorized", message: "Administrator session is required" });
		}

		req.bellwakeAdmin = { ...session, sessionHash };
		res.setHeader("Cache-Control", "no-store");
		next();
	} catch (error) {
		next(error);
	}
};

export const requireCsrf = (req, res, next) => {
	const csrfToken = req.get("x-csrf-token") ?? "";
	if (!safeEqual(csrfToken, req.bellwakeAdmin?.csrfToken)) {
		return res.status(403).json({ error: "csrf_rejected", message: "CSRF token is invalid" });
	}
	next();
};

export const verifySocketCsrf = (csrfToken, session) => {
	return safeEqual(typeof csrfToken === "string" ? csrfToken : "", session?.csrfToken);
};

export const sessionToResponse = (session, csrfToken, expiresAt) => ({
	authenticated: true,
	user: {
		id: Number(session.userId),
		username: session.username,
		displayName: session.displayName,
	},
	csrfToken,
	expiresAt,
});
