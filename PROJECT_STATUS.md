# SimpleRay — Handoff / Project Status

Last planning update: 2026-11-18

## Current state
- **Planning and specification only. No implementation phases have started.**
- GitHub private repo: `AmirrezaShafiei/SimpleRay`
- Main branch: `main`
- Requirements: [SPEC.md](SPEC.md) — authoritative source of truth.
- Phase-by-phase execution: [ROADMAP.md](ROADMAP.md).
- Overview: [README.md](README.md).

## Next action
Wait for the user to say **"فاز ۱ رو انجام بده"** (or equivalent). Only then implement Phase 1, commit changes and test. Do NOT infer permission to implement subsequent phases.

## Requirements not to overlook
- User's shared reference screenshot is `SimpleRay VPN Server Dashboard(1).png`, from the planning conversation (2026-11-18). The actual image is NOT yet stored in this Git repository. Request it in a new chat only if visual precision requires it; otherwise use written layout in SPEC.md.
- Simple single window, no sidebar; dark/light themes.
- Compact single ON/OFF switch, no separate Disconnect button; actual live down/up speeds next to switch only when connected.
- Server table: Favorite, Name, Type, Latency (numeric colored TEXT ONLY), Source (instead of Remarks). Source = named subscription or em dash for manual entries.
- Sort by clicking **all meaningful column headers**, toggling asc/desc with arrow. Search, stars, right-click menu.
- Toolbar buttons: Paste, Update, **Ping immediately next to Update**, Search, Settings (gear). Right-click single-server ping, NOT separate Ping Selected button.
- Ping All defaults to 3 separate through-proxy HTTP real-delay probes per server, display successful average; Settings can select 1 probe instead. Handle timeouts and partial successes truthfully.
- Subscription import supports naming and later renaming, update and persistence.
- Start at Startup, tray handling, System Proxy. TUN out of initial scope.

## Phase accounting
| Phase | Deliverable | State |
|:---:|---|---|
| 1 | Desktop skeleton + faithful Dark/Light UI, sortable demo table | Not started |
| 2 | Config/subscription import, naming, update, persistence | Not started |
| 3 | Xray connection, System Proxy, live traffic | Not started |
| 4 | Real latency ping ×1/×3 average and sorting tests | Not started |
| 5 | Tray, Windows startup, settings and polish | Not started |
| 6 | QA, installer, beta release | Not started |

## After each phase
Update the table above with concrete results, commit SHA, verified test outcomes, outstanding bugs, and state of the *next* phase. Never mark a task completed based on a mockup or plan.

## Important
A previous unrelated starter ZIP/mockup was created during planning; it is NOT a tested executable client, not part of this GitHub repository, and does not satisfy a phase by itself.
