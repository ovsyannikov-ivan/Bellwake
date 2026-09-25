export class AuthRequestError extends Error {
	constructor(message, { status = 0, code = "" } = {}) {
		super(message);
		this.name = "AuthRequestError";
		this.status = status;
		this.code = code;
	}
}

const parseResponse = async (response) => {
	const payload = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new AuthRequestError(payload.message || "Ошибка авторизации", {
			status: response.status,
			code: payload.error,
		});
	}
	return payload;
};
export const getAdminSession = async () => {
	const response = await fetch("/api/auth/me", {
		credentials: "same-origin",
		cache: "no-store",
	});
	if (response.status === 401) return null;
	return parseResponse(response);
};

export const loginAdmin = async ({ username, password }) => {
	const response = await fetch("/api/auth/login", {
		method: "POST",
		credentials: "same-origin",
		headers: {
			"Content-Type": "application/json",
			"X-Bellwake-Request": "admin",
		},
		body: JSON.stringify({ username, password }),
	});
	return parseResponse(response);
};

export const logoutAdmin = async (csrfToken) => {
	const response = await fetch("/api/auth/logout", {
		method: "POST",
		credentials: "same-origin",
		headers: {
			"X-Bellwake-Request": "admin",
			"X-CSRF-Token": csrfToken,
		},
	});
	if (response.status !== 204) await parseResponse(response);
};
