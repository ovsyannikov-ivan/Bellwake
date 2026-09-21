import { Router } from "express";

const router = Router();
const RELAY_URL = "https://bellwake-relay.ovsyannikov-ivan.workers.dev";
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const getServerUrl = () => {
	const value = process.env.BELLWAKE_DOMAIN?.trim();
	if (!value) {
		throw new Error("BELLWAKE_DOMAIN is not configured");
	}
	if (/^https?:\/\//i.test(value)) {
		return value.replace(/\/+$/, "");
	}
	return `https://${value.replace(/\/+$/, "")}`;
};

router.post("/approve", async (req, res, next) => {
	try {
		const socketId = String(req.body?.socketId ?? "").trim();

		if (!UUID_V4_RE.test(socketId)) {
			return res.status(400).json({
				error: "invalid_socket_id",
				message: "Invalid pairing socket ID",
			});
		}

		const enrollmentToken = process.env.ENROLLMENT_TOKEN?.trim();
		const relaySendToken = process.env.RELAY_SEND_TOKEN?.trim();

		if (!enrollmentToken) {
			throw new Error("ENROLLMENT_TOKEN is not configured");
		}
		if (!relaySendToken) {
			throw new Error("RELAY_SEND_TOKEN is not configured");
		}

		const response = await fetch(`${RELAY_URL}/send/${encodeURIComponent(socketId)}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${relaySendToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				type: "pairingApproved",
				serverUrl: getServerUrl(),
				enrollmentToken,
			}),
			signal: AbortSignal.timeout(5000),
		});
		const body = await response.text();

		if (!response.ok) {
			console.error(`Bellwake Relay returned HTTP ${response.status}: ${body}`);

			return res.status(502).json({
				error: "relay_delivery_failed",
				message: "Unable to deliver pairing data",
			});
		}
		return res.json({
			delivered: true,
		});
	} catch (error) {
		if (error?.name === "TimeoutError") {
			return res.status(504).json({
				error: "relay_timeout",
				message: "Bellwake Relay did not respond in time",
			});
		}
		next(error);
	}
});

export default router;
