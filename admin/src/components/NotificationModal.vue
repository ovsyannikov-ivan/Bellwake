<script setup>
import { inject, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { Modal } from "bootstrap";
import MarkdownEditor from "./MarkdownEditor.vue";
import { socketServiceKey } from "../symbols.js";
import { socketEmitAsync } from "../services/service.helpers.js";
import { modalErrorKey } from "../plugins/plugin.modalError.js";
import { useLoading } from "../plugins/plugin.loadingBackdrop.js";
import { socketErrorHandlerKey } from "../plugins/plugin.socketErrorHandler.js";

const emit = defineEmits(["saved"]);
const { socket } = inject(socketServiceKey);
const modalError = inject(modalErrorKey);
const loader = useLoading();
const handleSocketError = inject(socketErrorHandlerKey);
const modalElement = ref(null);
const editorRef = ref(null);
const formElement = ref(null);
const loading = ref(false);
const saving = ref(false);
const codeVisible = ref(false);
const markdownCode = ref("");
const externalChange = ref(false);
let modal;

const emptyForm = () => ({ id: null, title: "", severity: "info", ackRequired: true, state: "draft", startsAt: "", expiresAt: "" });
const form = reactive(emptyForm());

const resetForm = () => {
	Object.assign(form, emptyForm());
	editorRef.value?.setMarkdown("");
	codeVisible.value = false;
	markdownCode.value = "";
	externalChange.value = false;
};

const showModal = async () => {
	modal ??= Modal.getOrCreateInstance(modalElement.value, { backdrop: "static" });
	modal.show();
	await nextTick();
};

const openCreate = async () => {
	resetForm();
	await showModal();
};

const openEdit = async (id) => {
	resetForm();
	form.id = id;
	loading.value = true;
	await showModal();
	loader.show("pulse");
	try {
		const notification = await handleSocketError(() => socketEmitAsync(socket, "notifications:get", { id }), "Не удалось открыть уведомление");
		Object.assign(form, {
			id: notification.id,
			title: notification.title,
			severity: notification.severity,
			ackRequired: notification.ackRequired,
			state: notification.state,
			startsAt: notification.startsAt ?? "",
			expiresAt: notification.expiresAt ?? "",
		});
		editorRef.value?.setMarkdown(notification.body);
	} catch {
		modal.hide();
	} finally {
		loading.value = false;
		loader.hide();
	}
};

const onShown = async () => {
	await editorRef.value?.initialize();
	if (!loading.value) editorRef.value?.focus();
};

const toggleCode = () => {
	markdownCode.value = editorRef.value?.getMarkdown() ?? "";
	codeVisible.value = !codeVisible.value;
};

const save = async () => {
	if (saving.value || loading.value) return;
	formElement.value.classList.add("was-validated");
	if (!formElement.value.checkValidity()) return;

	const body = editorRef.value?.getMarkdown().trim() ?? "";
	if (!body) {
		modalError.show("Введите текст уведомления", "Не удалось сохранить уведомление");
		return;
	}

	saving.value = true;
	try {
		const event = form.id ? "notifications:update" : "notifications:create";
		await handleSocketError(
			() =>
				socketEmitAsync(socket, event, {
					...(form.id ? { id: form.id } : {}),
					title: form.title,
					body,
					severity: form.severity,
					ackRequired: form.ackRequired,
					state: form.state,
					startsAt: form.startsAt || null,
					expiresAt: form.expiresAt || null,
				}),
			"Не удалось сохранить уведомление",
		);
		modal.hide();
		emit("saved");
	} catch {
		// The shared Socket.IO handler has already shown the error modal.
	} finally {
		saving.value = false;
	}
};

const notifyExternalChange = ({ action, id }) => {
	if (action === "updated" && Number(id) === Number(form.id) && modalElement.value?.classList.contains("show")) {
		externalChange.value = true;
	}
};

const onHidden = () => formElement.value?.classList.remove("was-validated");
onMounted(() => {
	modalElement.value.addEventListener("shown.bs.modal", onShown);
	modalElement.value.addEventListener("hidden.bs.modal", onHidden);
});
onBeforeUnmount(() => {
	modalElement.value?.removeEventListener("shown.bs.modal", onShown);
	modalElement.value?.removeEventListener("hidden.bs.modal", onHidden);
	modal?.dispose();
});
defineExpose({ openCreate, openEdit, notifyExternalChange });
</script>

<template>
	<div ref="modalElement" v-zindex-modal class="modal fade" tabindex="-1" aria-labelledby="notification-modal-title">
		<div class="modal-dialog modal-xl modal-dialog-scrollable modal-fullscreen-sm-down">
			<div class="modal-content">
				<div class="modal-header px-3 px-md-4">
					<div id="notification-modal-title" class="modal-title fs-4">{{ form.id ? `Уведомление #${form.id}` : "Новое уведомление" }}</div>
					<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Закрыть" />
				</div>

				<form ref="formElement" novalidate @submit.prevent="save">
					<div class="modal-body p-3 p-md-4">
						<div v-if="externalChange" class="alert alert-warning d-flex gap-2 align-items-start" role="alert">
							<i class="bi bi-exclamation-triangle-fill" />
							<div>
								<strong>Уведомление изменено другим администратором.</strong><br /><span class="small">Ваш текст сохранён в форме. Закройте её без сохранения, чтобы загрузить актуальную версию.</span>
							</div>
						</div>
						<div :class="{ 'opacity-25 pe-none': loading }">
							<div class="mb-4">
								<label for="notification-title" class="form-label fw-semibold">Заголовок</label>
								<input id="notification-title" v-model.trim="form.title" class="form-control form-control-lg" maxlength="255" autocomplete="off" required placeholder="Коротко опишите суть уведомления" />
								<div class="invalid-feedback">Введите заголовок.</div>
							</div>

							<div class="mb-4">
								<div class="d-flex align-items-center justify-content-between gap-3 mb-2">
									<label class="form-label fw-semibold mb-0">Текст уведомления</label>
									<button type="button" class="btn btn-sm btn-outline-secondary" @click="toggleCode"><i class="bi bi-code-slash me-1" />{{ codeVisible ? "Скрыть код" : "Посмотреть код" }}</button>
								</div>
								<MarkdownEditor ref="editorRef" />
								<div v-if="codeVisible" class="markdown-code mt-3">
									<div class="small fw-semibold text-body-secondary mb-2">Исходный Markdown</div>
									<pre class="mb-0">{{ markdownCode || "—" }}</pre>
								</div>
							</div>

							<div class="row g-3 mb-4">
								<div class="col-md-4">
									<label for="severity" class="form-label fw-semibold">Важность</label
									><select id="severity" v-model="form.severity" class="form-select">
										<option value="info">Информационная</option>
										<option value="warning">Предупреждение</option>
										<option value="critical">Критическая</option>
									</select>
								</div>
								<div class="col-md-4">
									<label for="state" class="form-label fw-semibold">Статус</label
									><select id="state" v-model="form.state" class="form-select">
										<option value="draft">Черновик</option>
										<option value="active">Активно</option>
										<option value="archived">В архиве</option>
									</select>
								</div>
								<div class="col-md-4 d-flex align-items-end">
									<div class="form-check form-switch rounded border w-100 p-2 ps-5">
										<input id="ack-required" v-model="form.ackRequired" class="form-check-input" type="checkbox" /><label class="form-check-label" for="ack-required">Требовать подтверждение</label>
									</div>
								</div>
							</div>
							<div class="row g-3">
								<div class="col-md-6">
									<label for="starts-at" class="form-label fw-semibold">Начало действия</label><input id="starts-at" v-model="form.startsAt" type="datetime-local" class="form-control" />
									<div class="form-text">Оставьте пустым, если ограничение не требуется.</div>
								</div>
								<div class="col-md-6">
									<label for="expires-at" class="form-label fw-semibold">Окончание действия</label
									><input id="expires-at" v-model="form.expiresAt" type="datetime-local" class="form-control" :min="form.startsAt || undefined" />
									<div class="form-text">Дата указывается в локальном времени организации.</div>
								</div>
							</div>
						</div>
					</div>
					<div class="modal-footer px-3 px-md-4 py-3">
						<button type="button" class="btn btn-light border" data-bs-dismiss="modal" :disabled="saving">Отмена</button
						><button type="submit" class="btn btn-primary px-4" :disabled="saving || loading">
							<span v-if="saving" class="spinner-border spinner-border-sm me-2" />{{ saving ? "Сохраняем…" : "Сохранить" }}
						</button>
					</div>
				</form>
			</div>
		</div>
	</div>
</template>

<style scoped>
.markdown-code {
	max-height: 15rem;
	overflow: auto;
	padding: 1rem;
	border: 1px solid var(--bs-border-color);
	border-radius: var(--bs-border-radius);
	background: var(--bs-tertiary-bg);
}
.markdown-code pre {
	white-space: pre-wrap;
	word-break: break-word;
	font-size: 0.82rem;
	color: var(--bs-body-color);
}
</style>
