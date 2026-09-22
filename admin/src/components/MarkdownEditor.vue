<script setup>
import { nextTick, onBeforeUnmount, ref } from "vue";
import Editor from "@toast-ui/editor";
import "@toast-ui/editor/dist/toastui-editor.css";

const editorHost = ref(null);
let editor = null;
let pendingMarkdown = "";

const createHeadingButton = () => {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "toastui-editor-toolbar-icons bellwake-h2-button";
	button.textContent = "H2";
	button.title = "Заголовок второго уровня";
	button.setAttribute("aria-label", "Заголовок второго уровня");
	button.addEventListener("click", () => editor?.exec("heading", { level: 2 }));
	return button;
};

const initialize = async () => {
	if (editor || !editorHost.value) return;
	await nextTick();
	editor = new Editor({
		el: editorHost.value,
		height: "390px",
		initialValue: pendingMarkdown,
		initialEditType: "wysiwyg",
		hideModeSwitch: true,
		usageStatistics: false,
		previewStyle: "vertical",
		toolbarItems: [
			[{ el: createHeadingButton(), tooltip: "Заголовок второго уровня" }, "bold", "italic", "strike"],
			["quote", "ul", "ol"],
			["link", "code", "codeblock"],
		],
	});
};

const setMarkdown = (value = "") => {
	pendingMarkdown = value;
	if (editor) editor.setMarkdown(value, false);
};

const getMarkdown = () => editor?.getMarkdown() ?? pendingMarkdown;
const focus = () => editor?.focus();

onBeforeUnmount(() => {
	editor?.destroy();
	editor = null;
});

defineExpose({ initialize, setMarkdown, getMarkdown, focus });
</script>

<template><div ref="editorHost" class="markdown-editor" /></template>
