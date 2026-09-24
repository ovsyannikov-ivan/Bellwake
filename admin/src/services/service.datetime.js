import { DateTime } from "luxon";

export const getBrowserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const requireValidDateTime = (dateTime, label) => {
	if (!dateTime.isValid) throw new TypeError(`${label}: ${dateTime.invalidExplanation ?? dateTime.invalidReason}`);
	return dateTime;
};

export const localDateToUtcIso = (value) => {
	if (value === null || value === undefined) return null;
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("Ожидалась корректная дата");

	return requireValidDateTime(DateTime.fromJSDate(value), "Некорректная локальная дата").toUTC().toISO();
};

export const utcIsoToLocalDate = (value) => {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value !== "string") throw new TypeError("Ожидалась дата в формате UTC ISO");

	return requireValidDateTime(DateTime.fromISO(value, { zone: "utc" }), "Некорректная UTC-дата").toLocal().toJSDate();
};

export const formatUtcIsoInBrowserTimeZone = (value) => {
	if (!value || typeof value !== "string") return null;

	const dateTime = DateTime.fromISO(value, { zone: "utc" });
	return dateTime.isValid ? dateTime.toLocal().toFormat("dd.MM.yyyy'T'HH:mm") : null;
};
