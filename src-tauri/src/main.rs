// Не показываем дополнительное окно консоли в сборке Windows. Не удалять.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
	bellwake_lib::run()
}
