# Aurum Chat — desktop power client (Tauri 2)

The desktop leg of the W139 cross-platform ruling: **the web app is the
canonical renderer**; this client is composition — a native Linux window
shell over the same authoritative product deployment. It deliberately
keeps no second state authority (no local database, no Tauri commands in
v1.0.0): the boot page probes the production deployment and hands the
window to it.

- **Product surface:** `https://aurum-chat-livid.vercel.app` (canonical
  web app; health probe `/api/health`)
- **Shell:** Tauri 2, WebKitGTK webview, one 1280×800 window
- **Identity:** productName `Aurum Chat`, binary `aurum-chat`,
  identifier `chat.aurum.desktop`, the W123 tower mark icon
- **Bundle:** `.deb` (Ubuntu amd64), built by
  `.github/workflows/desktop-release.yml` on `ubuntu-22.04` for the
  broadest glibc compatibility (runs on 22.04, 24.04 and newer)

## Layout

```
clients/desktop/
├── ui/index.html            # the boot/splash + offline-retry surface
└── src-tauri/
    ├── tauri.conf.json      # window, bundle, identity
    ├── Cargo.toml           # the Rust crate (tauri 2)
    ├── src/{main.rs,lib.rs} # canonical minimal entry points
    └── icons/               # the tower mark, rasterized from
                             # src/app/icon.svg geometry
```

## Building

Requires Rust (stable) and the Tauri 2 Linux prerequisites
(`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`,
`librsvg2-dev`, `patchelf`), then:

```bash
cd clients/desktop
npx --yes @tauri-apps/cli@^2 build --bundles deb
# → src-tauri/target/release/bundle/deb/aurum-chat_1.0.0_amd64.deb
```

The CI workflow does exactly this on every `workflow_dispatch` and
attaches the `.deb` to the `desktop-vX.Y.Z` GitHub release.

## Installing (Ubuntu desktop)

```bash
wget -O aurum-chat_1.0.0_amd64.deb \
  https://github.com/payswapdotorg/aurum-chat/releases/download/desktop-v1.0.0/aurum-chat_1.0.0_amd64.deb
sudo apt install ./aurum-chat_1.0.0_amd64.deb
```

Then launch **Aurum Chat** from the applications menu (or `aurum-chat`).

## Honest limitations (v1.0.0)

- The client-session registration and cross-device handoff surfaces of
  the W139 cross-platform module are service-level contracts with no
  user-facing routes yet; the desktop client composes them in a
  follow-up once the web app exposes the composition surface. Until
  then the client is a shell over the canonical web renderer.
- Sign-in state lives in the WebKitGTK profile of the local user
  (`~/.local/share/chat.aurum.desktop/`), the same as a browser.
- The app URL is fixed at build time (the canonical deployment).
