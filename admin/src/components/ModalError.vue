<script setup>
import { inject, nextTick, onBeforeUnmount, watch } from "vue";
import { Modal } from "bootstrap";
import { modalErrorKey } from "../plugins/plugin.modalError.js";

const modalError = inject(modalErrorKey);
let modal;
let element;

const setRef = (value) => {
	if (element) element.removeEventListener("hidden.bs.modal", onHidden);
	element = value;
	if (value) {
		modal = Modal.getOrCreateInstance(value);
		value.addEventListener("hidden.bs.modal", onHidden);
	}
};

watch(
	() => modalError.state.visible,
	async (visible) => {
		await nextTick();
		if (visible) modal?.show();
		else modal?.hide();
	},
);

const onHidden = () => modalError.hide();
onBeforeUnmount(() => {
	element?.removeEventListener("hidden.bs.modal", onHidden);
	modal?.dispose();
});
</script>

<template>
	<div :ref="setRef" v-zindex-modal class="modal fade" tabindex="-1" aria-labelledby="error-modal-title">
		<div class="modal-dialog modal-dialog-centered">
			<div class="modal-content">
				<div class="modal-header border-0 pb-0">
					<div class="error-icon me-3"><i class="bi bi-exclamation-lg" /></div>
					<div id="error-modal-title" class="modal-title fs-5">{{ modalError.state.title }}</div>
					<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Закрыть" />
				</div>
				<div class="modal-body ps-5 ms-3 pt-2">
					<p class="mb-0 text-body-secondary">{{ modalError.state.message }}</p>
				</div>
				<div class="modal-footer border-0"><button type="button" class="btn btn-primary px-4" data-bs-dismiss="modal">Понятно</button></div>
			</div>
		</div>
	</div>
</template>

<style scoped>
.error-icon {
	display: grid;
	place-items: center;
	width: 2.25rem;
	height: 2.25rem;
	border-radius: 50%;
	color: var(--bs-danger);
	background: rgba(var(--bs-danger-rgb), 0.12);
}
</style>
