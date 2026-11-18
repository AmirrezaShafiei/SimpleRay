# SimpleRay — Phase 4 implementation report

Date: 2026-11-18
**Status: Real-delay implementation source and JS tests complete; native Windows/real-server test PENDING.**

## Delivered in source
- Main toolbar retains one Ping button directly beside Update. No redundant `Ping Selected` button.
- `Ping All` starts up to three simultaneous independent Xray-based proxy tests; each node starts its own temporary local HTTP proxy process and submits HTTPS `GET` requests through it.
- Default count is **3 independent attempts**, arithmetic average computed from the successful samples. Settings can choose **1 attempt** instead; that preference is persisted.
- Single node context menu offers explicit `Ping (×1)` and `Ping (×3) — Average` regardless of default Ping All setting.
- The backend measures real HTTPS response time to `https://www.gstatic.com/generate_204` over the proxy and requires HTTP 204 (NOT ICMP RTT and NOT raw TCP connect time). No direct fallback is used to report fake results.
- Results carry attempted/successful counts and show a truthful `Timeout` / `Failed` label if none succeed. Partial success is visible as `x/3` in latency tooltip.
- Result persists with the server and survives subscription refresh for an identity match; numeric ascending/descending sorting and no-box color-coded latency text remain intact.
- Canceling a Ping All batch stops queueing further jobs; the at-most-three currently running Xray probes finish/timeout. A result is ignored when its server was removed mid-test.

## Verification
- `npm test`: **43 passed, 0 failed** overall including deterministic latency aggregation/partial failure, concurrency cap, unit conversion, x1 choice, and sort compatibility.
- JavaScript syntax checker: passed.
- Native Rust build: not possible in this runtime.
- Real latency against user servers: **not executed** (no user-provided test connection and no Xray binary on Windows in this environment).
- UI browser smoke: access blocked by environment policy.

## Limitations
- One fixed 204 endpoint initially; changing it in Settings may be considered later.
- Averages are across successful samples only. For example, 2/3 successful samples shows their average with `2/3` status, not three-sample mean.
- A canceled active probe is not forcefully interrupted; it is bounded by an Xray readiness timeout and per-probe HTTP timeout. There is no ICMP RTT mode.
- Per-node Xray startup has overhead. Responsiveness with hundreds of servers needs Windows profiling and may warrant a single-core multi-outbound design later.
- Color thresholds use the previous phase's initial policy and may need user review after real trials.
