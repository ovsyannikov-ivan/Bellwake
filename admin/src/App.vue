<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref } from "vue";
import { Dropdown } from "bootstrap";
import NotificationTable from "./components/NotificationTable.vue";
import NotificationModal from "./components/NotificationModal.vue";
import PairingModal from "./components/PairingModal.vue";
import ModalError from "./components/ModalError.vue";
import { socketServiceKey } from "./symbols.js";

const { state } = inject(socketServiceKey);
const tableRef = ref(null);
const modalRef = ref(null);
const pairingModalRef = ref(null);
const themeDropdownButton = ref(null);
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const themeMode = ref(document.documentElement.dataset.bsThemeMode ?? "auto");
let themeDropdown;

const themeOptions = [
	{ value: "light", label: "Светлая", icon: "bi-sun-fill" },
	{ value: "dark", label: "Тёмная", icon: "bi-moon-stars-fill" },
	{ value: "auto", label: "Системная", icon: "bi-circle-half" },
];
const activeTheme = computed(() => themeOptions.find(({ value }) => value === themeMode.value) ?? themeOptions[2]);

const applyTheme = () => {
	const resolvedTheme = themeMode.value === "auto" ? (systemTheme.matches ? "dark" : "light") : themeMode.value;
	document.documentElement.dataset.bsThemeMode = themeMode.value;
	document.documentElement.setAttribute("data-bs-theme", resolvedTheme);
};

const selectTheme = (mode) => {
	themeMode.value = mode;
	localStorage.setItem("bellwake-admin-theme", mode);
	applyTheme();
	themeDropdown?.hide();
};

const onSystemThemeChange = () => {
	if (themeMode.value === "auto") applyTheme();
};

onMounted(() => {
	themeDropdown = new Dropdown(themeDropdownButton.value);
	systemTheme.addEventListener("change", onSystemThemeChange);
});

onBeforeUnmount(() => {
	systemTheme.removeEventListener("change", onSystemThemeChange);
	themeDropdown?.dispose();
});

const openCreate = () => modalRef.value?.openCreate();
const openEdit = (id) => modalRef.value?.openEdit(id);
const openPairing = () => pairingModalRef.value?.open();
const onChanged = (change) => modalRef.value?.notifyExternalChange(change);
const onSaved = () => tableRef.value?.reload();
</script>

<template>
	<div class="app-shell">
		<nav class="navbar navbar-expand border-bottom sticky-top">
			<div class="container-fluid app-container">
				<a class="navbar-brand d-flex align-items-center gap-3" href="#" aria-label="Bellwake Admin">
					<img class="brand-icon" src="/bellwake-icon-256.png" width="40" height="40" alt="" />
					<span><span class="brand-name">Bellwake</span><span class="brand-product">Панель администрирования</span></span>
				</a>
				<div class="d-flex align-items-center gap-2 gap-md-3">
					<div class="connection-status" :class="state.connected ? 'is-online' : 'is-offline'" :title="state.connected ? 'Соединение установлено' : 'Переподключение к серверу'">
						<span class="connection-dot" /><span class="d-none d-sm-inline">{{ state.connected ? "На связи" : "Нет связи" }}</span>
					</div>
					<button type="button" class="btn btn-primary navbar-action" title="Подключить устройство" aria-label="Подключить устройство" @click="openPairing">
						<i class="bi bi-qr-code-scan" /><span class="d-none d-lg-inline">Подключить устройство</span>
					</button>
					<div class="dropdown">
						<button ref="themeDropdownButton" type="button" class="btn btn-icon dropdown-toggle" data-bs-toggle="dropdown" aria-label="Выбрать цветовую тему" aria-haspopup="true" aria-expanded="false">
							<i class="bi" :class="activeTheme.icon" />
						</button>
						<ul class="dropdown-menu dropdown-menu-end theme-menu">
							<li v-for="option in themeOptions" :key="option.value">
								<button
									type="button"
									class="dropdown-item d-flex align-items-center"
									:class="{ active: themeMode === option.value }"
									:aria-pressed="themeMode === option.value"
									@click="selectTheme(option.value)"
								>
									<i class="bi me-2" :class="option.icon" /><span>{{ option.label }}</span
									><i v-if="themeMode === option.value" class="bi bi-check2 ms-auto" />
								</button>
							</li>
						</ul>
					</div>
				</div>
			</div>
		</nav>

		<main class="app-container py-3 py-lg-3">
			<div v-if="!state.connected" class="alert alert-warning connection-alert d-flex align-items-center gap-3" role="status">
				<span class="spinner-grow spinner-grow-sm" />
				<div><strong>Соединение с сервером потеряно.</strong> Таблица обновится автоматически после восстановления связи.</div>
			</div>

			<NotificationTable ref="tableRef" @create="openCreate" @edit="openEdit" @changed="onChanged" />
		</main>

		<NotificationModal ref="modalRef" @saved="onSaved" />
		<PairingModal ref="pairingModalRef" />
		<ModalError />
	</div>
</template>
