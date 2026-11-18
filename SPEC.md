# SimpleRay — Product Specification (v0.1)

Status: DESIGN AGREED / IMPLEMENTATION PENDING
Platform: Windows desktop
Product principle: elegant, extremely simple single-window Xray client; NO v2rayN-style overwhelming interface and NO left sidebar.
This file reflects user decisions as of 2026-11-18; mockup data and sample ping values are illustrative only.

## Scope and implementation
- Use the maintained Xray-core runtime for supported proxy protocols, rather than reimplementing protocols or cryptography.
- First release: Windows desktop app, System Proxy mode; **TUN / split-tunneling are out of v0.1 scope**.
- Prefer a lean cross-platform desktop UI approach (Tauri is a candidate, not a mandatory choice).
- Protocols to support from imported links and subscriptions: VMess, VLESS, Trojan, Shadowsocks, as compatible with the packaged Xray runtime.
- Handle protocol options (TLS/Reality/transport settings, etc.) when present in links, reporting unsupported parameters instead of silently misconfiguring.
- Never upload/store private server URIs, credentials, subscriptions or tokens in the public repository or telemetry.

## Visual direction
- ONE clean main window, NO left-side navigation/sidebar; keep same spacious visual style as the originally preferred mockup, with cohesive typography, mild shadows, rounded corners, restrained colors.
- Dark and Light themes with coherent contrast. Theme choice in Settings (Dark / Light / Follow system).
- Compact, **balanced** connection switch in header; avoid gigantic pill / oversized Disconnect button. The SAME switch toggles connect and disconnect. **Do not add a separate Disconnect button**.
- Connected state is clearly indicated (green), disconnected state neutral, connecting/reconnecting states visibly distinct; never claim connected merely because a process was started.
- Live traffic next to main connection control **only while connected**: downward green arrow for DOWNLOAD rate and upward blue arrow for UPLOAD rate (e.g. MB/s, adaptive units); avoid duplicating those metrics unnecessarily elsewhere. Show graceful zeros if no activity.
- Header also shows selected server name + protocol and current connection status.
- Compact action toolbar: Paste (clipboard) with optional menu, Update Subscription, Add (if needed), Delete selected (if needed), Search, and gear icon for Settings.
- The **Ping Selected** button must NOT exist. Its action belongs in the row context menu.
- A single **Ping All (×3 / Average)** action is allowed in a compact toolbar menu; no excess permanent buttons.
- Keep bottom status line minimal (system proxy status, optional startup/tray state), with no redundant connection information.

## Server list / data model
- Table columns:
  1. Favorite toggle (star icon)
  2. Server Name
  3. Type / Protocol (VMess / VLESS / Trojan / Shadowsocks; plainly displayed)
  4. Latency in milliseconds (numeric **colored text ONLY**, absolutely NO colored pill/box/border around latency)
  5. Source
- **Source REPLACES Remarks** (no Remarks column).
- For servers imported from a named Subscription, show EXACTLY their subscription display name in Source.
- For manual/standalone configuration, show an em dash (—) in Source.
- Track internal stable subscription ID separately from user-editable display name: renaming a subscription updates the Source display for its nodes.
- Favorited servers are denoted by clickable stars and remain favorited after app restart; subscription refresh should preserve favorites/selection where matching is possible.
- Optional location flag based on reliable server metadata/name; never treat guessed country as authoritative.
- Selecting a row is separate from initiating connection. Double-click: select and connect or switch to that server.
- Sort by latency ascending/descending, and optionally name/favorites; unknown/timeouts sort last. Search by server name/type/source, case-insensitive.

## Latency measurement
- Test **single server** from right-click menu: Ping (×1), Ping (×3) — Average.
- Test **all servers** from one unobtrusive toolbar option: 3 probe attempts per server, calculate average of successful samples, show per-server progress and results.
- Proxy-level HTTP connectivity/latency tests THROUGH EACH CONFIG, **not just ICMP** to the server IP.
- Bound concurrency and per-probe timeout; a partial success should clearly show successful sample count (e.g., '2/3'); all failures become 'Timeout' / 'Failed'.
- Do not confuse an HTTP test response time with physical ICMP RTT; UI can label it 'Latency'.
- Color **text only** for numeric latency: green for low, yellow for moderate, orange/red for higher latency; thresholds should be consistent/documented (initial defaults customizable later).
- Sorting uses the latest available measured value, preferring the 3-probe average when available; label average clearly (Avg.).
- Failed/unmeasured entries use grey text, and should never be shown as 0 ms.

## Import, subscriptions and local edits
- Clipboard Paste recognizes:
  - one or multiple proxy URI(s)
  - compatible subscription URL(s)
  - subscription payloads if supported by import parser.
- **When adding a subscription, prompt for a user-chosen Name (editable), and the subscription URL**. The name is saved and shown as Source for all corresponding servers.
- Preserve subscriptions as distinct entities with name, URL, last update, nodes and update error (if any).
- Subscription Update: manual per subscription and optionally Update All, refresh associated nodes without deleting unrelated manual configs; keep last-good data on transient error.
- Permit adding, editing, duplicating, and deleting individual manual configurations. For subscription-managed nodes, local edits may need either an override or a 'Duplicate as manual' action to avoid losing work on refresh.
- Handle invalid and duplicate clipboard entries with clear feedback, never lose existing configs silently.
- Deleting a subscription must have a confirmation about whether to delete its imported nodes too.

## Context menu (right click on server)
- Connect / Select
- Ping (×1)
- Ping (×3) — Average
- Star / Unstar
- Edit (when applicable)
- Duplicate
- Delete (with confirmation)
No dedicated Ping Selected toolbar button.

## Settings (gear icon)
- Theme: Dark / Light / System
- Start with Windows: toggle
- Minimize to tray: toggle, closing the main window should hide to tray while core stays running by default; explicit Exit from tray terminates app/core and cleans proxy settings.
- Optional: auto-connect at startup (separate from start-with-Windows; OFF by default)
- System Proxy mode on/off and local listen ports where needed.
- Future advanced settings can live here; do not clutter main UI.

## Reliability, privacy & quality gates
- If connecting fails, display actionable error and do not claim success.
- Switching servers cleans up the previous connection and applies the new proxy reliably.
- Restore changed system proxy settings on explicit app exit or crash recovery when feasible.
- Tray icon represents disconnected/connecting/connected states; supports Show, Connect/Disconnect, Exit.
- Do not let subscription refresh interrupt active connection unless required; handle selected server updates carefully.
- Prevent concurrent Ping All / update operations from freezing the interface.
- Persist selected server, subscription names, favorites, and startup/theme preferences.
- Never log private URI passwords/keys/subscription secrets.
- Deliver Windows installer and test both themes, startup, tray, import, refresh, latency, sorting, protocol parsers and connection lifecycle.

## Explicitly NOT in initial build
- Left sidebar / multiple category pages
- A second Disconnect button
- Oversized connection pill
- Separate Ping Selected toolbar button
- Colored boxed latency badges
- Remarks column
- TUN / complex rules editor / split tunnel / browser extension

## Main window sketch (layout only)
```
SimpleRay                                           [ _ ][ □ ][ X ]
[compact connect switch] Connected • VMess / Selected server   ↓ Down   ↑ Up     [⚙]
[Paste ▾] [Update] [Add] [Delete]     [Search servers...] [Ping All ▾]
★  Name                  Type        Latency (Avg.)       Source
☆  Germany 01            VMess       68 ms                Daily Nodes
★  Backup                Trojan      211 ms               —
...
[System Proxy: ON]    [tray status if needed]
```

User-requested final correction: Replace Remarks column with Source. Subscription import **must allow naming**, and Source displays that name, while standalone configs show '—'. This specification is the source of truth for implementation.
