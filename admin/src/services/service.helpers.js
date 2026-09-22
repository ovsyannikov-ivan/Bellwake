const DEFAULT_TIMEOUT = 10000;

export const socketEmitAsync = (socket, event, payload = {}, timeout = DEFAULT_TIMEOUT) =>
	new Promise((resolve, reject) => {
		if (!socket.connected) {
			reject(new Error("Нет соединения с сервером. Проверьте сеть и повторите попытку."));
			return;
		}

		socket.timeout(timeout).emit(event, payload, (timeoutError, response) => {
			if (timeoutError) {
				reject(new Error("Сервер не ответил вовремя. Повторите попытку."));
				return;
			}
			if (!response?.result) {
				reject(new Error(response?.error || "Не удалось выполнить запрос"));
				return;
			}
			resolve(response.data);
		});
	});

export const debounce = (callback, delay = 250) => {
	let timer;
	const wrapped = (...args) => {
		clearTimeout(timer);
		timer = setTimeout(() => callback(...args), delay);
	};
	wrapped.cancel = () => clearTimeout(timer);
	return wrapped;
};
