# SimpleRay

Minimal, elegant Windows desktop client powered by Xray-core.

> **Status:** Planning / specification. App code and installer are not yet implemented.

## Product goal
One compact window with **no left navigation/sidebar**. No oversized connection controls or overwhelming advanced settings. Both Dark and Light themes.

## Planned features
- Clipboard import of proxy links and subscription URLs
- User-named subscriptions; server list **Source** column shows the subscription name, or **—** for independent configs
- Subscription updates and server management
- VMess, VLESS, Trojan, Shadowsocks via Xray-core
- Single-server Ping (×1), Ping (×3 average) via right-click, and Ping All
- Latency sort (ascending/descending); numeric latency color only (no latency badge boxes)
- Favorites, search, context menu, server select and switch
- One balanced ON/OFF switch for both connect and disconnect
- While connected, live download (↓) and upload (↑) rates adjacent to the connection control
- System Proxy, tray operation, Start with Windows, theme settings via gear icon

The authoritative feature requirements, behavior details and exclusions live in [SPEC.md](SPEC.md).

## Status checklist
- [x] Agree on the product layout and features
- [x] Save specification
- [ ] Scaffold desktop application
- [ ] Implement clipboard and subscription parsing
- [ ] Integrate Xray-core
- [ ] Implement connection state, tray and system proxy
- [ ] Implement HTTP-based latency testing, average and sort
- [ ] Implement Dark/Light themes and UI polish
- [ ] Windows installer + smoke tests

## Security
Do not commit actual connection URIs, tokens, proxy credentials, subscription URLs, or logs that may contain secrets.

No live connections are implemented yet. Example designs are mockups, not actual running application screenshots.
