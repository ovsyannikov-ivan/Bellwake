<script setup>
import { inject, onBeforeUnmount, onMounted, ref } from "vue";
import DataTable from "datatables.net-bs5";
import "datatables.net-responsive-bs5";
import { socketServiceKey } from "../symbols.js";
import { socketErrorHandlerKey } from "../plugins/plugin.socketErrorHandler.js";
import { debounce, socketEmitAsync } from "../services/service.helpers.js";
import { formatUtcIsoInBrowserTimeZone } from "../services/service.datetime.js";

const emit = defineEmits(["create", "pair", "edit", "changed"]);
const { socket } = inject(socketServiceKey);
const handleSocketError = inject(socketErrorHandlerKey);
const tableElement = ref(null);
let table;

const escapeHtml = (value) => {
	const element = document.createElement("span");
	element.textContent = value == null ? "" : String(value);
	return element.innerHTML;
};

const formatDate = (value) => {
	if (!value) return '<span class="text-body-tertiary">—</span>';
	const formatted = formatUtcIsoInBrowserTimeZone(value);
	if (!formatted) return '<span class="text-body-tertiary">—</span>';
	const [date, time] = formatted.split("T");
	return `${date}<span class="d-block small text-body-secondary">${time}</span>`;
};

const badges = {
	severity: {
		info: '<span class="text-bg-info-subtle text-info-emphasis"><i class="bi bi-info-circle me-1"></i>Информация</span>',
		warning: '<span class="text-bg-warning-subtle text-warning-emphasis"><i class="bi bi-exclamation-triangle me-1"></i>Предупреждение</span>',
		critical: '<span class="text-bg-danger-subtle text-danger-emphasis"><i class="bi bi-exclamation-octagon me-1"></i>Критично</span>',
	},
	state: {
		draft: '<span class="text-bg-secondary-subtle text-secondary-emphasis">Черновик</span>',
		active: '<span class="text-bg-success-subtle text-success-emphasis"><span class="status-dot me-1"></span>Активно</span>',
		archived: '<span class="text-bg-dark-subtle text-dark-emphasis">В архиве</span>',
	},
};

const initialize = () => {
	if (table || !tableElement.value) return;
	table = new DataTable(tableElement.value, {
		serverSide: true,
		processing: true,
		responsive: { details: { type: "column", target: 0 } },
		pageLength: 50,
		lengthChange: false,
		searchDelay: 350,
		order: [[1, "desc"]],
		autoWidth: false,
		layout: { topStart: "search", topEnd: "info", bottomStart: null, bottomEnd: "paging" },
		ajax: async (request, callback) => {
			try {
				callback(await handleSocketError(() => socketEmitAsync(socket, "notifications:list", request), "Не удалось загрузить уведомления"));
			} catch (error) {
				callback({ draw: request.draw, recordsTotal: 0, recordsFiltered: 0, data: [] });
			}
		},
		columns: [
			{ data: null, defaultContent: "", className: "dtr-control", orderable: false, searchable: false },
			{ data: "id", className: "text-body-secondary fw-semibold", width: "5rem" },
			{ data: "title", render: (value, type) => (type === "display" ? `<span class="notification-title">${escapeHtml(value)}</span>` : value) },
			{ data: "severity", render: (value, type) => (type === "display" ? (badges.severity[value] ?? escapeHtml(value)) : value) },
			{ data: "ackRequired", render: (value, type) => (type === "display" ? (value ? '<i class="bi bi-check-circle-fill text-success me-1"></i>Да' : '<span class="text-body-tertiary">Нет</span>') : value) },
			{ data: "state", render: (value, type) => (type === "display" ? (badges.state[value] ?? escapeHtml(value)) : value) },
			{ data: "startsAt", render: (value, type) => (type === "display" ? formatDate(value) : value) },
			{ data: "expiresAt", render: (value, type) => (type === "display" ? formatDate(value) : value) },
			{ data: "createDatetime", render: (value, type) => (type === "display" ? formatDate(value) : value) },
			{
				data: "id",
				orderable: false,
				searchable: false,
				className: "text-end",
				render: (id) => `<button type="button" class="btn btn-sm btn-outline-secondary edit-notification text-nowrap mt-1" data-id="${Number(id)}"><i class="bi bi-pencil me-1"></i>Изменить</button>`,
			},
		],
		columnDefs: [
			{ targets: 0, responsivePriority: 1, width: "1.5rem" },
			{ targets: 2, responsivePriority: 1 },
			{ targets: 9, responsivePriority: 1 },
			{ targets: [6, 7, 8], responsivePriority: 10 },
		],
		language: {
			processing: '<span class="spinner-border spinner-border-sm me-2"></span>Загрузка…',
			search: "",
			searchPlaceholder: "Поиск по заголовку",
			info: "Показаны _START_–_END_ из _TOTAL_",
			infoEmpty: "Нет уведомлений",
			infoFiltered: "(отфильтровано из _MAX_)",
			zeroRecords: "По вашему запросу ничего не найдено",
			emptyTable: "Уведомлений пока нет",
			paginate: { first: "Первая", previous: "Назад", next: "Далее", last: "Последняя" },
		},
	});
};

const scheduleReload = debounce(() => table?.ajax.reload(null, false), 250);
const reload = () => scheduleReload();
const onConnect = () => (table ? scheduleReload() : initialize());
const onChanged = (change) => {
	emit("changed", change);
	scheduleReload();
};
const onClick = (event) => {
	const button = event.target.closest(".edit-notification");
	if (button) emit("edit", Number(button.dataset.id));
};

onMounted(() => {
	tableElement.value.addEventListener("click", onClick);
	socket.on("connect", onConnect);
	socket.on("notifications:changed", onChanged);
	if (socket.connected) initialize();
});

onBeforeUnmount(() => {
	scheduleReload.cancel();
	socket.off("connect", onConnect);
	socket.off("notifications:changed", onChanged);
	tableElement.value?.removeEventListener("click", onClick);
	table?.destroy();
	table = null;
});

defineExpose({ reload });
</script>

<template>
	<div class="table-card-header pb-3">
		<h1 class="h5 mb-0">Уведомления</h1>
		<div class="table-card-actions">
			<button type="button" class="btn btn-violet" @click="emit('pair')"><i class="bi bi-qr-code-scan me-2" />Подключить устройство</button>
			<button type="button" class="btn btn-primary" @click="emit('create')"><i class="bi bi-plus-lg me-2" />Создать уведомление</button>
		</div>
	</div>
	<div class="table-responsive-shell">
		<table ref="tableElement" class="table small table-hover align-middle w-100 mb-0">
			<thead>
				<tr>
					<th aria-label="Подробнее"></th>
					<th>ID</th>
					<th>Заголовок</th>
					<th>Важность</th>
					<th>Подтверждение</th>
					<th>Статус</th>
					<th>Начало</th>
					<th>Окончание</th>
					<th>Создано</th>
					<th class="text-end">Действия</th>
				</tr>
			</thead>
		</table>
	</div>
</template>
