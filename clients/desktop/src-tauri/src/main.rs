// Aurum Chat - desktop power client (clients/desktop).
//
// Prevents an additional console window on Windows in release builds;
// a no-op on Linux where the deb is the delivered bundle.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    aurum_chat_desktop_lib::run()
}
