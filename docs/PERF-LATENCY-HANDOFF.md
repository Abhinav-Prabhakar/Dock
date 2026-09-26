# Handoff: API latency collapse under live-sim load

Written 2026-09-26 on `integration/operator-console` (tip `ee4e551`), verified
against the running Docker stack. **Task for the fixer: make read endpoints
(and customer quotes) stay responsive while the live episode is doing
booking-decision work.**

## Symptom (measured)

With the live PPO episode mid-run (day ~50, ~80 requests/sim-day), a plain
`GET /api/ports` — a static parquet read — took **29 s**, then **85 s** from a
browser; `/api/routes` took 50 s; the customer site's `DockAPI.network()`
(ports + routes) took **186 s**. Between sim bursts the same endpoints return
in <1 ms–1 s. `docker stats` showed the api container pinned at ~83% CPU.

User-visible effect: the customer intake's port selects and the operator
console's panels hang for minutes at a time — pages look frozen, not "live".

## Root cause

Two compounding problems, both in `backend/`:

### 1. Every booking decision does heavy work *inside* `ep.sim_lock`

`EpisodeManager._ppo_step` (`backend/server/episodes.py` ~L853) holds
`ep.sim_lock` for the entire step. For `ep.live` episodes that step includes:

- `policy_view.evaluate(model, obs, mask)` — full PPO forward pass
- `EpisodeManager._decision_pricing` — `sim.pricer.quote` + `pricing_curve()`
  (64-point WTP-survival grid)
- `decision_context.option_views(sim, req)` — per-option leg quotes and
  feasibility (`sim.feasible` → stowage solver) for every option
- `decision_context.counterfactuals(sim, req)` — **four baseline policies**
  (static/greedy/heuristic/heuristic_bid) each run `decide_booking` + re-price
  under a temporarily swapped `sim.config.pricing`
- `env.step(a)` — booking, ledger write, possibly an EVM settlement tx

`latency_ms` on `/live/policy` traces shows ~500 ms+ per booking decision
(measured: `act` ≈ 562 ms on one sample; the counterfactual stage is now
measured separately, key `counterfactuals`).

**Everything the frontends call is serialized behind that lock:**
`GET /live` (routes.py:272), `GET /live/vessels/{id}/stowage` (routes.py:316),
and the whole customer quote path — `POST /orders`, `/accept`, `/decline`
(quotes.py:154, 206, 265, 316). A customer accept can wait seconds-to-minutes
behind a burst of simulated booking steps.

### 2. Even lock-free endpoints starve for the GIL

uvicorn runs `--workers 1` (`backend/docker-entrypoint.sh:28`). All routes
are sync `def` → Starlette threadpool (default 40 threads), competing with
the sim thread for the GIL. During a heavy step the sim thread dominates
CPU, so *any* request — including `GET /ports`, which re-reads
`data/generated/ports.parquet` **on every call** (routes.py:77) — stalls.
Same pattern: `/routes` (routes.py:88), `/vessels` (82), `/models/report`
(96), `/compare/{name}` re-reads a JSON file per call (routes.py:323).

## Reproduction

```bash
docker compose up -d            # live sim auto-starts (PPO, baseline, 90d)
# while it's mid-run:
time curl -s -o /dev/null http://localhost:8080/api/ports     # 0.08s quiet → 30s+ busy
time curl -s -o /dev/null http://localhost:8080/api/live      # blocks on sim_lock
```

Browser-level harness used for this session lives at `/tmp/dock-uitest`
(playwright-core driving real Chrome, `channel: 'chrome'`); rebuild with
`npm i playwright-core` if wiped — scripts: `t1b-vessel.mjs` (operator vessel
screen), `t2-screens.mjs` (stowage/stats/model), `t3-customer.mjs` /
`t7-book-accept.mjs` (customer booking → offer → accept), `t8-panel.mjs`
(bookings panel).

## Suggested approaches (roughly cheapest → most invasive)

1. **Cache static reads.** `/ports`, `/routes`, `/vessels`, `/models/report`,
   `/compare/*` are constant per dataset — parse once at startup (or
   `functools.lru_cache`), not a parquet/JSON read per request. Doesn't fix
   the GIL stall on its own, but removes work *and* makes these calls cheap
   enough to slip through contention windows.

2. **Get the context computation out of the locked step.** Options:
   - Compute `options` / `counterfactuals` / `pricing.curve` **lazily** —
     store a light snapshot in the trace, compute the heavy context only
     when the operator's Model page actually requests that decision's
     detail (new endpoint, e.g. `GET /live/policy/{n}/context`).
   - Or **subsample**: full context only every Nth decision / only for
     customer requests (`source == "customer"`), which is what the
     counterfactuals exist to explain anyway.
   - Or compute after `env.step` on a copied state — expensive, fragile.
   Note `counterfactuals` mutates `sim.config.pricing` temporarily
   (restored in `finally`) — fine under the lock, but means it can't just
   be moved to a parallel thread as-is.
3. **Process isolation.** Run the episode driver in a separate process
   (multiprocessing) and serve reads from a shared/queued snapshot. This is
   the only fix that fully removes GIL contention; biggest change — events,
   snapshot and the quote path would all need to cross a process boundary.
4. **Don't try**: `--workers > 1` (each worker is a process, but the live sim
   is per-process state — quotes/episodes would split-brain; also each
   worker would run its own live episode). Not viable without (3).

Also worth adding while you're in there: lock-wait telemetry (record how
long `_ppo_step` and each request handler wait on `sim_lock`, expose in
`/live`) so the win is measurable.

## Resolution (2026-09-26)

Measured on a throwaway api container at `DOCK_LIVE_SPEED=20` (sim
CPU-bound, ~99% CPU) with 3 simulated operator tabs + a customer quote loop.

**What the profile actually showed** (py-spy, episode thread): `env.step` is
58% of a step (demand-forecast refresh in `_obs` 28%, stowage search ~25%);
the live-only context is ~31% (`policy_view.evaluate` 17%, `option_views` 9%,
`counterfactuals` 6%). A typical booking step is 5–15 ms; ~500 ms is the tail
(a step that settles a deal on py-evm), not the norm. At the compose default
(1/60 sim-day/s) a sim-day costs ~1.3 s of CPU, so the sim is ~98% idle — the
30–186 s numbers were not reproducible there, and never with curl.

**Actual root cause for the lock-bound paths: lock barging.** The driver
released `sim_lock` and re-took it on the next loop iteration without
dropping the GIL, so a blocked handler waited out whole bursts of steps.
Fixed with `SimLock` (`backend/server/episodes.py`): the driver enters via
`sim_lock.step()`, which first parks until already-blocked handlers have had
their turn (max 250 ms). Handlers keep using `with ep.sim_lock:`.

| (ms)            | before med / p95 / max | after med / p95 / max |
|-----------------|------------------------|-----------------------|
| `GET /live`     | 498 / 1172 / 1225      | 15 / 550 / 731        |
| `POST /orders`  | 13 / 1068 / 1561       | 31 / 80 / 190         |

Also: `/ports`, `/vessels`, `/models/report`, `/compare/*` parse their file
once (`functools.cache`). `GET /live` now returns `sim_lock` telemetry
(`handler_wait_ms`, `step_wait_ms`, `step_hold_ms`: n/p50/p95/max over the
last 512). Regression test: `backend/tests/test_sim_lock.py`.

**Not fixed / tried:** the remaining 0.3–0.7 s tail on every endpoint is GIL
contention with the CPU-bound sim; `sys.setswitchinterval(0.001)` made no
measurable difference and was dropped. Only process isolation (approach 3)
removes that. Context work was left in the step — it must read pre-step
state, and it's a third of the cost, not the bulk.

## Related findings from the same session (not part of this task)

- `_record_trace` scans only `ep.events[-12:]` → intermittent
  `outcome: None` on booking traces after event-busy steps (confirmed live:
  request 5015's decision event existed at seq 7728 but was outside the
  window). Correlate by `request_id`, not position.
- `liveDecision.js` highlights the priced option via `pricing.dest`, but
  `_decision_pricing` never returns `dest` → chosen option never highlights.
- `live.js` restart handling: `_resetEpisode` doesn't clear `bookingItems`
  in `main.js`; `LiveEngine` trace state (`lastN`/queue) may suppress new
  decisions after an episode id change.
- `fromLive.js` upsamples stowage when physical > logical capacity —
  smaller vessels (VES4) can render overfilled.
