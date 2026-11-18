# SimpleRay — Windows Proxy Client

Minimal single-window V2Ray/Xray client in active development, with the approved reference layout at [design/reference.jpg](design/reference.jpg).

**Current stage:** Phase 1 UI foundation and Phase 2 configuration/subscription management **source code committed**. Connection, System Proxy, live traffic, real Ping, tray and startup integration, Windows installer are **not yet implemented or tested**.

## Phase 2 features implemented in source
- Clipboard Paste for one/multiple VMess, VLESS, Trojan, Shadowsocks share links; common base64-encoded subscription contents.
- Add manual URI and optional name, edit, duplicate, delete; stars, search, sort by every header, selected server persistence.
- Add subscription with mandatory **display name** and HTTP(S) URL; rename, refresh one/all, delete subscription with **keep imported servers or delete them**.
- Server table **Source** = subscription display name, **—** for standalone configurations. Updates preserve favorites, selected server and IDs when identity matches; preserve last good nodes on failed refresh. Deleting a subscribed node hides it from subsequent refreshes.
- Native Tauri Rust clipboard and bounded HTTP subscription fetch commands (max 2 MB, network timeouts). Browser preview uses Clipboard API and fetch where permitted.
- Theme Dark / Light / System, no left sidebar, no fake connection or latency claims. Ping button directly beside Update remains a Phase 4 placeholder.

## Run / verify

Requirements: Node.js 20+. For desktop also install Rust/Cargo, Microsoft C++ build tools, and WebView2 on Windows.

```bash
npm install
npm run dev
npm test
npm run build
npm run desktop:dev
```

- `npm run dev`: local frontend preview (http://127.0.0.1:1420).
- `npm test`: **29/29 passing Node unit/static tests** as of Phase 2.
- `npm run build`: JavaScript syntax/source checks ONLY (not an installer).
- `npm run desktop:dev`: invokes Tauri on Windows, **not yet tested/verified** in current environment.
- Browser interactive Playwright test attempted but blocked by `ERR_BLOCKED_BY_ADMINISTRATOR`; see [PHASE2_REPORT.md](PHASE2_REPORT.md).
- Windows Rust/Cargo compile and actual third-party subscription fetch have not been verified.

## Critical security caveat

Subscription URLs/tokens and server connection URIs are currently saved as **plaintext local WebView storage**. Do **not** commit real subscriptions, tokens or credentials. Before public beta consider replacing this with OS user-scoped encryption (for Windows, DPAPI).

## Project continuity
- [PROJECT_STATUS.md](PROJECT_STATUS.md): current handoff, risks, verified tests, next action.
- [SPEC.md](SPEC.md): source of truth for user-approved behavior and aesthetic.
- [ROADMAP.md](ROADMAP.md): six phase gates, **exactly one phase per explicit user request**.
- [PHASE2_REPORT.md](PHASE2_REPORT.md): detailed Phase 2 work and testing, unverified items.
- [PHASE1_REPORT.md](PHASE1_REPORT.md): initial UI source work and tests.
- [ARCHITECTURE.md](ARCHITECTURE.md): modules, license references and data flow.

## Technical modules
- `frontend/config.js`: protocol/share-link parsers.
- `frontend/store.js`: transactional persistent config and subscription repository.
- `frontend/main.js`, `index.html`, `styles.css`: one-window UI, forms and context actions.
- `src-tauri/src/lib.rs`: local clipboard + subscription fetch commands.
- `tests/`: unit and static UI tests.

No core protocol implementation has been copied from other projects. Planned runtime: Xray-core (MPL-2.0); reference: V2Fly/V2Ray (MIT). See [ARCHITECTURE.md](ARCHITECTURE.md).

**Next phase (only when authorized):** Phase 3 — live Xray-core, correct System Proxy lifecycle, compact single toggle and real up/down traffic metrics.
