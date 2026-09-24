import { DateTime } from "luxon";

const MYSQL_DATETIME_FORMAT = "yyyy-LL-dd HH:mm:ss";

const requireValidDateTime = (dateTime, label) => {
	if (!dateTime.isValid) throw new TypeError(`${label}: ${dateTime.invalidExplanation ?? dateTime.invalidReason}`);
	return dateTime;
};

export const utcIsoToMysqlDateTime = (value) => {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value !== "string") throw new TypeError("Ожидалась дата в формате UTC ISO");

	return requireValidDateTime(DateTime.fromISO(value, { zone: "utc" }), "Некорректная UTC-дата").toUTC().toFormat(MYSQL_DATETIME_FORMAT);
};

export const mysqlDateTimeToUtcIso = (value) => {
	if (value === null || value === undefined || value === "") return null;

	const dateTime =
		value instanceof Date
			? DateTime.fromJSDate(value, { zone: "utc" })
			: DateTime.fromSQL(String(value), { zone: "utc" });

	return requireValidDateTime(dateTime, "Некорректная дата MySQL").toUTC().toISO();
};
