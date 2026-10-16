//! Aurum Chat - desktop power client library entry (clients/desktop).
//!
//! W139 ruling: the web app is the canonical renderer; the desktop client
//! is composition - a native window shell over the same authoritative
//! product. The boot page (../ui/index.html) probes the production
//! deployment and hands the window to it, so no Tauri commands are
//! registered here in v1.0.0: the client deliberately keeps no second
//! state authority.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the Aurum Chat desktop client");
}
