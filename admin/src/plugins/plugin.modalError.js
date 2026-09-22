import { reactive } from "vue";

export const modalErrorKey = Symbol("modalError");

export const createModalError = () => {
	const state = reactive({ visible: false, title: "Ошибка", message: "" });
	return {
		state,
		show(error, title = "Не удалось выполнить действие") {
			state.title = title;
			state.message = error instanceof Error ? error.message : String(error || "Неизвестная ошибка");
			state.visible = true;
		},
		hide() {
			state.visible = false;
		},
	};
};
