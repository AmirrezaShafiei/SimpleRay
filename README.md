# SimpleRay — Phase 1 UI

Minimal Windows Xray client in development. **This is only a working UI preview with demo server rows; it does not route traffic, connect, ping or modify system proxy.**

## Run the interactive visual preview

Requires Node.js 20+:

```bash
npm run dev
```

Open http://127.0.0.1:1420 in a browser. This frontend contains no external font, CDN or UI library dependency.

## Run tests

```bash
npm test
npm run build
```

`npm run build` currently checks frontend source layout/syntax, not Rust compilation. For Windows desktop development, install Rust, Microsoft C++ build tools, WebView2 (on supported Windows installations) and dependencies:

```bash
npm install
npm run desktop:dev
```

Windows native builds are **not verified in this environment**. An installer and connection engine are planned for later phases.

## Visual reference

The agreed design screenshot is checked in at [design/reference.jpg](design/reference.jpg). It shows the layout we emulate. Its `Remarks` field is replaced with `Source`, and the toolbar includes Ping directly beside Update.

## Phase 1 delivered UI behavior
- One window, reference-style dark and light themes (also Follow System), settings modal and local preference persistence.
- Single small connection switch that switches **preview state only**; no disconnected/connected claims without explicit preview annotation.
- Server table populated with **demo data**, Star, Name, Type, latency (color text, no background), Source.
- Clicking any table header toggles sort, including numeric latency and favorite; missing latency sorted last.
- Search filters across server name, protocol and subscription Source; single-click select, double-click preview state; right-click menu.
- Ping All next to Update, single-server Ping in row context menu. Both show planned-phase notifications; no fake latency measurements.
- Footer shows proxy as Inactive and startup as planned, avoiding fake OS integration.

For test results and limitations, see [PHASE1_REPORT.md](PHASE1_REPORT.md). The phase plan and requirements are in [ROADMAP.md](ROADMAP.md), [SPEC.md](SPEC.md), and [PROJECT_STATUS.md](PROJECT_STATUS.md).

## License references
Consult [ARCHITECTURE.md](ARCHITECTURE.md) for upstream V2Ray/Xray license and integration notes.
