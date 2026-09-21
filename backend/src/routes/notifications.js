import { Router } from "express";
import pool from "../database.js";

const router = Router();

router.get("/:notificationId", async (req, res, next) => {
	try {
		const notificationId = Number(req.params.notificationId);

		if (!Number.isInteger(notificationId) || notificationId <= 0) {
			return res.status(400).json({
				error: "invalid_notification_id",
				message: "Invalid notification ID",
			});
		}

		const [rows] = await pool.query(
			`SELECT
				notification_id AS id,
				title,
				body,
				severity,
				ack_required AS ackRequired,
				state,
				starts_at AS startsAt,
				expires_at AS expiresAt,
				create_datetime AS createDatetime
			FROM notifications
			WHERE notification_id = ?
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

		const notification = rows[0];
		notification.ackRequired = Boolean(notification.ackRequired);
		res.json(notification);
	} catch (error) {
		next(error);
	}
});

export default router;
