import { createApp } from "vue";
import App from "./App.vue";
import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap-icons/font/bootstrap-icons.css";
import "datatables.net-bs5/css/dataTables.bootstrap5.min.css";
import "datatables.net-responsive-bs5/css/responsive.bootstrap5.min.css";
import "./styles.scss";
import { createSocketService } from "./services/service.socketio.js";
import { createModalError, modalErrorKey } from "./plugins/plugin.modalError.js";
import { createSocketErrorHandler, socketErrorHandlerKey } from "./plugins/plugin.socketErrorHandler.js";
import ModalZindexManager from "./plugins/plugin.modalZindexManager.js";
import { socketServiceKey } from "./symbols.js";
import { createLoadingBackdropPlugin } from "./plugins/plugin.loadingBackdrop.js";

const app = createApp(App);
const socketService = createSocketService();
const modalError = createModalError();

app.use(ModalZindexManager);
app.use(createLoadingBackdropPlugin({ variant: "pulse" }));
app.provide(socketServiceKey, socketService);
app.provide(modalErrorKey, modalError);
app.provide(socketErrorHandlerKey, createSocketErrorHandler(modalError));
app.mount("#app");
