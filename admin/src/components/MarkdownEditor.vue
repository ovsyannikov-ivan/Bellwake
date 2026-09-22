<script setup>
import { nextTick, onBeforeUnmount, ref } from "vue";
import Editor from "@toast-ui/editor";
import "@toast-ui/editor/dist/toastui-editor.css";

const editorHost = ref(null);
const emit = defineEmits(["change"]);
let editor = null;
let resizeObserver = null;
let pendingMarkdown = "";

const syncHeight = () => {
	if (!editor || !editorHost.value) return;
	const height = Math.floor(editorHost.value.getBoundingClientRect().height);
	if (height > 0) editor.setHeight(`${height}px`);
};

const createToolbarButton = ({ name, icon, title, command, payload, state }) => {
	const button = document.createElement("button");
	const iconElement = document.createElement("i");

	button.type = "button";
	button.className = "btn btn-sm btn-link bellwake-editor-toolbar-button text-body-secondary";
	button.title = title;
	button.setAttribute("aria-label", title);

	iconElement.className = `bi ${icon}`;
	iconElement.setAttribute("aria-hidden", "true");
	button.appendChild(iconElement);

	button.addEventListener("click", (event) => {
		event.preventDefault();
		if (!editor) return;
		editor.exec(command, payload);
		editor.focus();
	});

	return {
		name,
		tooltip: title,
		el: button,
		...(state ? { state } : {}),
		onUpdated({ active, disabled }) {
			button.disabled = disabled;
			button.classList.toggle("active", active);
			button.classList.toggle("text-primary", active);
			button.classList.toggle("text-body-secondary", !active);
		},
	};
};

const createToolbarItems = () => [
	[
		createToolbarButton({
			name: "bellwakeHeading2",
			icon: "bi-type-h2",
			title: "Заголовок второго уровня",
			command: "heading",
			payload: { level: 2 },
			state: "heading",
		}),
		createToolbarButton({
			name: "bellwakeBold",
			icon: "bi-type-bold",
			title: "Жирный",
			command: "bold",
			state: "strong",
		}),
		createToolbarButton({
			name: "bellwakeItalic",
			icon: "bi-type-italic",
			title: "Курсив",
			command: "italic",
			state: "emph",
		}),
		createToolbarButton({
			name: "bellwakeStrike",
			icon: "bi-type-strikethrough",
			title: "Зачёркнутый",
			command: "strike",
			state: "strike",
		}),
	],
	[
		createToolbarButton({
			name: "bellwakeQuote",
			icon: "bi-quote",
			title: "Цитата",
			command: "blockQuote",
			state: "blockQuote",
		}),
		createToolbarButton({
			name: "bellwakeUnorderedList",
			icon: "bi-list-ul",
			title: "Маркированный список",
			command: "bulletList",
			state: "bulletList",
		}),
		createToolbarButton({
			name: "bellwakeOrderedList",
			icon: "bi-list-ol",
			title: "Нумерованный список",
			command: "orderedList",
			state: "orderedList",
		}),
	],
	["link"],
	[
		createToolbarButton({
			name: "bellwakeInlineCode",
			icon: "bi-code",
			title: "Код",
			command: "code",
			state: "code",
		}),
		createToolbarButton({
			name: "bellwakeCodeBlock",
			icon: "bi-braces",
			title: "Блок кода",
			command: "codeBlock",
			state: "codeBlock",
		}),
	],
];

const decorateNativeToolbarItems = () => {
	const linkButton = editorHost.value?.querySelector(".toastui-editor-toolbar-icons.link");

	if (!linkButton) return;

	linkButton.classList.add("btn", "btn-sm", "btn-link", "bellwake-editor-toolbar-button", "text-body-secondary", "bi", "bi-link-45deg");

	linkButton.style.backgroundImage = "none";
	linkButton.title = "Ссылка";
	linkButton.setAttribute("aria-label", "Ссылка");
};

const initialize = async () => {
	if (editor || !editorHost.value) return;
	await nextTick();

	editor = new Editor({
		el: editorHost.value,
		height: "100%",
		initialValue: pendingMarkdown,
		initialEditType: "wysiwyg",
		hideModeSwitch: true,
		usageStatistics: false,
		previewStyle: "vertical",
		toolbarItems: createToolbarItems(),
		events: {
			change: () => emit("change"),
		},
	});

	decorateNativeToolbarItems();

	resizeObserver = new ResizeObserver(syncHeight);
	resizeObserver.observe(editorHost.value);
	requestAnimationFrame(syncHeight);
};

const setMarkdown = (value = "") => {
	pendingMarkdown = value;
	if (editor) editor.setMarkdown(value, false);
};

const getMarkdown = () => editor?.getMarkdown() ?? pendingMarkdown;
const focus = () => editor?.focus();

const resize = async () => {
	await nextTick();
	requestAnimationFrame(syncHeight);
};

onBeforeUnmount(() => {
	resizeObserver?.disconnect();
	resizeObserver = null;
	editor?.destroy();
	editor = null;
});

defineExpose({
	initialize,
	setMarkdown,
	getMarkdown,
	focus,
	resize,
});
</script>

<template>
	<div ref="editorHost" class="markdown-editor" />
</template>
