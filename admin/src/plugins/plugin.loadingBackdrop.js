import { createApp, h, inject, readonly, ref } from "vue";
import LoadingBackdrop from "../components/LoadingBackdrop.vue";

export const loadingBackdropKey = Symbol("loadingBackdrop");

export const createLoadingBackdropPlugin = (options = {}) => {
	const isLoading = ref(false);
	const variant = ref(options.variant ?? "pulse");
	const loadingCount = ref(0);
	const container = document.createElement("div");
	document.body.appendChild(container);

	const overlayApp = createApp({
		setup: () => () => h(LoadingBackdrop, { show: isLoading.value, variant: variant.value }),
	});
	overlayApp.mount(container);

	const loading = {
		show(nextVariant) {
			if (nextVariant) variant.value = nextVariant;
			loadingCount.value += 1;
			isLoading.value = true;
		},
		hide() {
			loadingCount.value = Math.max(0, loadingCount.value - 1);
			if (loadingCount.value === 0) isLoading.value = false;
		},
		reset() {
			loadingCount.value = 0;
			isLoading.value = false;
		},
		isLoading: readonly(isLoading),
		count: readonly(loadingCount),
	};

	return {
		install(app) {
			app.provide(loadingBackdropKey, loading);
		},
		...loading,
	};
};

export const useLoading = () => {
	const loading = inject(loadingBackdropKey);
	if (!loading) throw new Error("Loading backdrop plugin is not installed");
	return loading;
};
