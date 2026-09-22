export const socketErrorHandlerKey = Symbol("socketErrorHandler");

export const createSocketErrorHandler = (modalError) => async (operation, title) => {
	try {
		return await operation();
	} catch (error) {
		modalError.show(error, title);
		throw error;
	}
};
