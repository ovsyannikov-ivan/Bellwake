const BASE_MODAL_Z = 1055;
const BASE_BACKDROP_Z = 1050;
const STEP = 20;

class ModalStackManager {
	constructor() {
		this.stack = [];
		this.backdrops = new Map();
	}

	register(modalElement) {
		if (!this.stack.includes(modalElement)) this.stack.push(modalElement);
		requestAnimationFrame(() => {
			const backdrops = document.querySelectorAll(".modal-backdrop");
			const newestBackdrop = backdrops[backdrops.length - 1];
			if (newestBackdrop) this.backdrops.set(modalElement, newestBackdrop);
			this.apply();
		});
	}

	unregister(modalElement) {
		this.stack = this.stack.filter((item) => item !== modalElement);
		this.backdrops.delete(modalElement);
		this.apply();
	}

	apply() {
		this.stack.forEach((modalElement, index) => {
			modalElement.style.zIndex = String(BASE_MODAL_Z + index * STEP);
			const backdrop = this.backdrops.get(modalElement);
			if (backdrop) backdrop.style.zIndex = String(BASE_BACKDROP_Z + index * STEP);
		});
	}
}

export default {
	install(app) {
		const manager = new ModalStackManager();
		app.directive("zindex-modal", {
			mounted(element) {
				const onShow = () => manager.register(element);
				const onHidden = () => manager.unregister(element);
				element.__bellwakeModalHandlers = { onShow, onHidden };
				element.addEventListener("show.bs.modal", onShow);
				element.addEventListener("hidden.bs.modal", onHidden);
			},
			unmounted(element) {
				const handlers = element.__bellwakeModalHandlers;
				if (handlers) {
					element.removeEventListener("show.bs.modal", handlers.onShow);
					element.removeEventListener("hidden.bs.modal", handlers.onHidden);
				}
				manager.unregister(element);
				delete element.__bellwakeModalHandlers;
			},
		});
	},
};
