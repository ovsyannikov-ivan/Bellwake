import pool from "../database.js";

const SEVERITIES = new Set(["info", "warning", "critical"]);
const STATES = new Set(["draft", "active", "archived"]);
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

class AdminSocketError extends Error {}

const SORT_COLUMNS = [
	"notification_id",
	"notification_id",
	"title",
	"severity",
	"ack_required",
	"state",
	"starts_at",
	"expires_at",
	"create_datetime",
	"notification_id",
];

const responseOk = (ack, data) => ack?.({ result: true, data });
const responseError = (ack, error) => ack?.({ result: false, error });

const getPositiveId = (value) => {
	const id = Number(value);
	if (!Number.isSafeInteger(id) || id <= 0) throw new AdminSocketError("Некорректный идентификатор уведомления");
	return id;
};

const normalizeDateTime = (value, label) => {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value !== "string") throw new AdminSocketError(`${label}: укажите корректную дату и время`);

	const match = DATETIME_RE.exec(value);
	if (!match) throw new AdminSocketError(`${label}: укажите корректную дату и время`);

	const [, year, month, day, hour, minute, second = "00"] = match;
	const parts = [year, month, day, hour, minute, second].map(Number);
	const [y, mo, d, h, mi, s] = parts;
	const candidate = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
	if (
		candidate.getUTCFullYear() !== y || candidate.getUTCMonth() !== mo - 1 ||
		candidate.getUTCDate() !== d || candidate.getUTCHours() !== h ||
		candidate.getUTCMinutes() !== mi || candidate.getUTCSeconds() !== s
	) {
		throw new AdminSocketError(`${label}: укажите существующую дату и время`);
	}
	return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
};

const validateNotification = (payload) => {
	const title = typeof payload?.title === "string" ? payload.title.trim() : "";
	const body = typeof payload?.body === "string" ? payload.body.trim() : "";
	const severity = payload?.severity;
	const state = payload?.state;

	if (!title) throw new AdminSocketError("Укажите заголовок уведомления");
	if (title.length > 255) throw new AdminSocketError("Заголовок не должен быть длиннее 255 символов");
	if (!body) throw new AdminSocketError("Введите текст уведомления");
	if (!SEVERITIES.has(severity)) throw new AdminSocketError("Выбран некорректный уровень важности");
	if (!STATES.has(state)) throw new AdminSocketError("Выбран некорректный статус");
	if (typeof payload?.ackRequired !== "boolean") throw new AdminSocketError("Некорректное значение подтверждения прочтения");

	const startsAt = normalizeDateTime(payload.startsAt, "Начало действия");
	const expiresAt = normalizeDateTime(payload.expiresAt, "Окончание действия");
	if (startsAt && expiresAt && expiresAt < startsAt) {
		throw new AdminSocketError("Окончание действия не может быть раньше начала");
	}

	return { title, body, severity, ackRequired: payload.ackRequired, state, startsAt, expiresAt };
};

const selectFields = `
	notification_id AS id,
	title,
	severity,
	ack_required AS ackRequired,
	state,
	DATE_FORMAT(starts_at, '%Y-%m-%dT%H:%i') AS startsAt,
	DATE_FORMAT(expires_at, '%Y-%m-%dT%H:%i') AS expiresAt,
	DATE_FORMAT(create_datetime, '%Y-%m-%dT%H:%i') AS createDatetime`;

const getNotification = async (id) => {
	const [rows] = await pool.execute(
		`SELECT ${selectFields}, body FROM notifications WHERE notification_id = ? LIMIT 1`,
		[id],
	);
	if (!rows[0]) throw new AdminSocketError("Уведомление не найдено");
	return { ...rows[0], ackRequired: Boolean(rows[0].ackRequired) };
};

const withAcknowledgement = (handler) => async (payload, ack) => {
	try {
		await handler(payload ?? {}, ack);
	} catch (error) {
		if (error instanceof AdminSocketError) {
			console.warn(`Admin Socket.IO request rejected: ${error.message}`);
		} else {
			console.error("Admin Socket.IO request failed:", error);
		}
		responseError(ack, error instanceof AdminSocketError ? error.message : "Внутренняя ошибка сервера");
	}
};

export const registerAdminNotificationHandlers = (namespace, socket) => {
	socket.on("notifications:list", withAcknowledgement(async (payload, ack) => {
		const draw = Math.max(0, Number.parseInt(payload.draw, 10) || 0);
		const start = Math.max(0, Number.parseInt(payload.start, 10) || 0);
		const searchValue = String(payload.search?.value ?? payload["search[value]"] ?? "").trim().slice(0, 255);
		const order = payload.order?.[0] ?? {};
		const requestedColumn = Number.parseInt(order.column ?? payload["order[0][column]"], 10);
		const sortColumn = SORT_COLUMNS[requestedColumn] ?? "notification_id";
		const requestedDirection = String(order.dir ?? payload["order[0][dir]"] ?? "desc").toLowerCase();
		const sortDirection = requestedDirection === "asc" ? "ASC" : "DESC";
		const where = searchValue ? "WHERE title LIKE ?" : "";
		const params = searchValue ? [`%${searchValue}%`] : [];

		const [[totalRow], [filteredRow], [rows]] = await Promise.all([
			pool.query("SELECT COUNT(*) AS count FROM notifications"),
			pool.execute(`SELECT COUNT(*) AS count FROM notifications ${where}`, params),
			pool.execute(
				`SELECT ${selectFields} FROM notifications ${where} ORDER BY ${sortColumn} ${sortDirection} LIMIT ? OFFSET ?`,
				[...params, 50, start],
			),
		]);

		responseOk(ack, {
			draw,
			recordsTotal: Number(totalRow[0].count),
			recordsFiltered: Number(filteredRow[0].count),
			data: rows.map((row) => ({ ...row, ackRequired: Boolean(row.ackRequired) })),
		});
	}));

	socket.on("notifications:get", withAcknowledgement(async (payload, ack) => {
		responseOk(ack, await getNotification(getPositiveId(payload.id)));
	}));

	socket.on("notifications:create", withAcknowledgement(async (payload, ack) => {
		const notification = validateNotification(payload);
		const [result] = await pool.execute(
			`INSERT INTO notifications (title, body, severity, ack_required, state, starts_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[notification.title, notification.body, notification.severity, notification.ackRequired, notification.state, notification.startsAt, notification.expiresAt],
		);
		const id = Number(result.insertId);
		responseOk(ack, { id });
		namespace.emit("notifications:changed", { action: "created", id });
	}));

	socket.on("notifications:update", withAcknowledgement(async (payload, ack) => {
		const id = getPositiveId(payload.id);
		const notification = validateNotification(payload);
		const [result] = await pool.execute(
			`UPDATE notifications
			 SET title = ?, body = ?, severity = ?, ack_required = ?, state = ?, starts_at = ?, expires_at = ?
			 WHERE notification_id = ?`,
			[notification.title, notification.body, notification.severity, notification.ackRequired, notification.state, notification.startsAt, notification.expiresAt, id],
		);
		if (result.affectedRows === 0) throw new AdminSocketError("Уведомление не найдено");
		responseOk(ack, { id });
		namespace.emit("notifications:changed", { action: "updated", id });
	}));
};
