# Dock — Technical Direction

*This document replaces the previous `technical.md` (a status/review doc).
It is now a **build directive** for the coding agents. `plan.md` remains the
product source of truth; where this document and `plan.md` disagree on
*scope ordering*, this document wins — it exists because we drifted off
`plan.md`'s own critical path.*

*Status legend: **[done]** · **[wip]** · **[todo]** · **[cut]** (explicitly
descoped, do not build).*

---

## 0. Read this first — what was wrong and what changed

### 0.1 The bid-price blocker is solved. It was not a pricing-design problem.

The previous document's §5.2 reported that the dynamic heuristic earned
**$8.1M under `pricing="bid_price"` vs $18.7M under `"dynamic"`** and
proposed three candidate redesigns of the pricing engine (cap the quote at
an itinerary clearing price / make policies bid-aware / scale E by a
capturable share).

**All three candidates are wrong and are now cancelled.** The engine's
economics were correct. Two upstream bugs were feeding it garbage:

**Bug 1 — leg market rates were not prorated (fixed in `pricing/bid_price.py`).**
`refresh()` assigned each leg the *E-weighted full-OD route rate*. An OD
rate pays for the whole journey, so summing per-leg bids over a `k`-leg
itinerary counted the entire fare `k` times. Measured median
`sum(leg_bid) / market_rate` by itinerary length:

| legs | before | after |
|:--|--:|--:|
| 1 | 0.68 | 0.66 |
| 2 | 2.05 | 1.13 |
| 3 | 3.01 | 1.24 |
| 4 | 3.18 | 1.19 |

Before the fix the opportunity cost scaled linearly with leg count, so
**63% of posted quotes were pinned at `QUOTE_GUARD` (1.45× market)** and
customers declined en masse. After: 33%. Fix = straight-mileage proration
(`leg_distance_nm / total_nm`), the standard interline revenue split.

**Bug 2 — the option-search window discarded the anchored sailing (fixed in
`simulator/world.py`).** `DemandStream.sample_day` anchors `req_dep_day` to
a real sailing **plus `N(0, 1.2)` jitter**, so `req_dep_day` lands on either
side of the true sailing date. But `_options_for` searched from
`req_dep_day - flex_days`. For urgent requests (`flex_days == 0`, 30% of
demand) any *positive* jitter put the anchored sailing **before** the search
window, where it was invisible. Traced case: sailing at day 10.9,
`req_dep_day` 11.7, `flex_days` 0 → window `[11.7, 25.7]` → the 10.9 sailing
is skipped, the next one is 48.6 days out, request lost. `within_flex`
already used a jitter-tolerant `max(flex_days, 1.0)`; the two bounds were
inconsistent and the search bound was the stricter one. Fix = both bounds
derive from `tol = max(flex_days, JITTER_TOL_D)`, `JITTER_TOL_D = 3.0`
(≈2.5σ of the anchor jitter).

### 0.2 Measured effect of the two fixes

Request triage, 90-day `baseline` episode, seed 7, heuristic policy
(fractions of all 8112 requests):

| | before | after |
|:--|--:|--:|
| viable (in-flex option with capacity) | 38.4% | **53.0%** |
| in-flex but no capacity | 13.2% | **28.7%** |
| no option within flex | 13.3% | 0.5% |
| no option at all | 35.1% | 17.8% |

3 episodes × 60 days, `baseline`, seeds 7/108/209:

| pricing | profit | teu_booked | rev/TEU | utilization |
|:--|--:|--:|--:|--:|
| `rate_card` (static) | $18.13M | 22,579 | $1,324 | 0.598 |
| `dynamic` (heuristic) | $22.41M | 22,169 | $1,473 | 0.602 |
| `bid_price` | **$22.66M** | 21,209 | **$1,547** | **0.614** |

`bid_price` went **$8.1M → $14.5M (Bug 1) → $22.7M (Bug 2)** and now wins
on all three RM metrics. Against the static rate card that is **+25%
profit and +16.8% revenue/TEU** — inside `plan.md` §6.1's 5–12% claim with
room to spare, from pricing alone, before RL.

The second row of the triage table is the important one: **"in-flex but no
capacity" more than doubled to 28.7%**, meaning capacity is now genuinely
the binding constraint. The scarcity premise the entire design rests on
(`plan.md` §5, "demand deliberately exceeds bookable lift") holds in
*realized* terms for the first time. Before the fixes it did not — 48% of
demand was lost to schedule matching before any pricing decision was
reached, utilization capped at ~0.58, and only 17% of legs ever sold out.
**That is why bid-price control could not win: there was almost no
scarcity to price against.** Every hour spent tuning the pricing engine
was treating a symptom.

### 0.3 The real problem: we are building the wrong half of the project

`plan.md` §4.6 lists P0 — "must ship". Current reality:

| P0 item | State |
|:--|:--|
| Simulator | [done] |
| Bid-price pricing | [done] (as of §0.1) |
| Accept/reject, flex, alt-hub, split | [done] |
| Stowage constraints | [done] |
| Reason-coded offers | [wip] — `explain()` exists, nothing consumes it |
| **Demand forecasting** | **[todo] — `models/` does not exist** |
| **Manual-vs-AI dashboard** | **[todo] — `src/` is 100% hardcoded mock data** |

Meanwhile we have built out the P1 RL stack (curriculum, GPU box, eval
harness) in depth. `plan.md` §3.8 and §8 are explicit that RL is "the
ambitious ceiling, **not the critical path**", and that "the demo script is
designed so that any of the three policies can power it".

**Right now the demo can be powered by none of them.** There is no path
from any policy to anything a judge can look at. `src/app/page.tsx` renders
`src/lib/data.ts`, which is a hand-written mock (`CNT-A14`, `N°1870`…) with
no relationship to the simulator. That is the single largest risk to the
project and it is entirely unaddressed.

### 0.4 Oracle leakage — a credibility bug we must not demo with

Both the pricing engine and the RL observation read **ground-truth future
demand**:

- `pricing/bid_price.py` `_oracle_demand` reads `sim.demand.lam` directly
  (the docstring admits it: "the simulator's own demand process is used as
  the forecast oracle").
- `env/fleet_env.py` `_obs()` line ~332: `v[i:i+N_ROUTES] =
  sim.demand.lam[:, w] / 1200.0` — the agent is handed next week's true
  intensity per route.

So our headline result is currently "a system with perfect demand
foresight beats one without". The first judge or reviewer who reads
`_obs()` finds this. It is also precisely what `plan.md` §2.4 says to
avoid — those features are supposed to be *supervised forecaster outputs*.
Building `DemandForecaster` is therefore not an optional nicety; it is what
makes the headline number defensible. It is also already P0.

### 0.5 The pivot

1. **Freeze RL scope.** Run the curriculum **once**, end to end, and take
   whatever it gives. Do not tune hyperparameters, do not add phases, do
   not chase a better reward. If PPO beats `heuristic_bid`, we show it as
   the headline; if not, `heuristic_bid` is the headline and RL is framed
   as ongoing research, exactly as `plan.md` §3.8 prescribes. **The $22.7M
   bid-price result already makes the pitch work without RL.** This is the
   fallback the plan told us to keep, and it is now in hand.
2. **Close the oracle leak** with one real forecaster (§3).
3. **Ship the demo** (§4) — this is the priority above everything else,
   including any further RL work.

---

## 1. Immediate fixes — do these first [wip]

### 1.1 Land §0.1 and add regression tests [wip]

In progress. `pricing/bid_price.py` proration is already applied.
`simulator/world.py` needs `JITTER_TOL_D` and the `_options_for` bounds fix,
plus a `_build_sailings` guard skipping `origin == destination` keys (vessel
loops that visit a port twice — VES1 has NLRTM twice, VES2 has KRPUS twice —
currently emit junk self-pair entries like `('NLRTM','NLRTM')`).

Regression tests required, because both bugs are silent and easy to
reintroduce:

1. A `flex_days=0` request whose `req_dep_day` sits 1–2 days **after** a
   real sailing must still get that sailing as an option with
   `within_flex=True`.
2. Median `option_bid(opt) / market_rate` must stay below ~1.6 for 2-leg
   **and** 3-leg options, and the 3-leg median must not be materially above
   the 2-leg median. The invariant is *opportunity cost does not scale with
   leg count*.
3. `all(o != d for (o, d) in sim.sailings)`.

### 1.2 Fix the evaluation fairness bug [todo]

`rl/evaluate.py` claims "identical simulator seeds across policies per
episode — same demand realization, apples-to-apples". It does not deliver
that. `run_baseline` passes `seed` straight into `SimConfig`, but
`run_ppo` → `CargoFleetEnv.reset(seed=seed)` uses that seed only to seed
`self._rng`, then draws `sim.config.seed = int(self._rng.integers(0, 1<<31))`.
**PPO therefore runs a different demand realization than the baselines it
is compared against.** Every head-to-head number the harness has produced
is unsound.

Fix: give `CargoFleetEnv.reset` a way to pin the simulator seed and
scenario exactly (e.g. `options={"sim_seed": seed, "scenario": scen}`,
honoured before `self.sim.reset()`), and have `run_ppo` use it. Keep the
existing random-seed behaviour as the default for training. Add a test:
the same `seed` through `run_baseline` and through the env must produce
identical `requests` counts and identical `sim.demand.lam`.

This is a correctness gate on every number we report. Do it before the
training run, not after.

### 1.3 Revive the negotiation layer — it is effectively dead [todo]

Landing §1.1 exposed a second problem. Measured after the fix, 3 seeds ×
60d, `baseline`:

| pricing | countered | counter win rate | reject→counter conv | booked via counter |
|:--|--:|--:|--:|:--|
| `dynamic` | 117 / 234 / 118 | 0.034 / 0.004 / 0.051 | ~0.001 | flex 1–4, split 0–1, alt-hub 0–1 |
| `bid_price` | 59 / 84 / 36 | 0.068 / 0.000 / 0.167 | ~0.001 | flex 0–5, alt-hub 0–1 |

Against ~1,500 direct accepts per episode. Before the fix there were 715
counters at a 21% win rate. **The counter-offer layer now barely fires and
almost never converts.**

This matters more than it looks. `plan.md` §2.8 calls the negotiation layer
"**the product differentiator** — the thing that makes Dock visibly
different from 'just dynamic pricing'". `plan.md` §1's problem statement #1
is "binary accept/reject destroys value", quoting a 15–20% rejection→revenue
conversion benchmark, and §6.4's entire social pillar is measured by
"bookings converted from reject → counter-offer". We cannot put those
claims on a slide with a conversion rate of 0.001.

Two compounding causes:

1. **The wider `tol` means most requests now find a viable in-flex option,
   so `DynamicHeuristicPolicy` accepts directly and never reaches its
   counter branch.** The counter branch is only entered on a
   capacity/date reject.
2. **When it does counter, it tries `SPLIT` first** (whenever
   `len(options) >= 2`), and split declines dominate every seed
   (`counter_declined:split` 15–220). A split does not change the price, so
   it cannot help a customer whose blocker is price — and
   `_customer_accepts(..., counter=True)` requires `price <= wtp` *and* a
   `counter_prob` draw. The heuristic offers the one counter type that
   cannot fix the binding constraint.

**Fix — policy-side only; do not change the simulator's one-shot customer
model.** Make `DynamicHeuristicPolicy` bid-aware and let it counter
*proactively* instead of only on reject:

- `pricing/bid_price.py` already has `counter_discount(req, opt_alt, opt_req)`
  returning a bid-price-differential discount and a reason string
  (`plan.md` §2.8: "discount = bid price difference"). **Nothing in the
  codebase calls it.** Wire it in.
- New decision order in `decide_booking`: before accepting at full price,
  check whether any other in-flex-or-adjacent option (or an `alt_options`
  entry) has a materially lower `option_bid`. If so, offer
  `FLEX_WINDOW`/`ALT_HUB` at the `counter_discount()` rate instead of
  `ACCEPT`. A discounted counter has a lower price, so it clears `wtp`
  more often — conversion becomes demonstrable with no simulator change.
- Reorder the reject-path counters by what the blocker actually is: price
  blocker → discount-bearing counter (flex/alt-hub); capacity blocker →
  `SPLIT`. Never lead with `SPLIT`.
- Keep `GreedyPolicy` untouched — it is the myopic baseline and must stay
  myopic for the ablation to mean anything.

**Acceptance:** reject→counter conversion and counter win rate reported
across seeds 7/108/209 for both pricing modes, with counters booked via
each of flex-window, alt-hub and split appearing in the outcome mix. Do
not tune toward a target number — report what the mechanism gives. If
`bid_price` profit moves, report that too; a small profit give-back in
exchange for a working negotiation layer is an acceptable trade and is my
call to make, not something to optimize away.

This also feeds §4.1: `offers.json` needs real counter-offer examples to
sample, or the explainability panel is a list of plain accepts.

### 1.4 Do **not** restructure the fleet [cut]

17.8% of requests still have no carriage option at all. Root cause: with 4
vessels on 4 disjoint closed loops, each OD gets roughly one sailing per
round trip — measured gaps of 23–68 days on the main lanes (`CNSHA→NLRTM`
n=4 over 150 days; `CNSHA→DEHAM` n=2, gap 68d). Real carriers run weekly
strings of 3–5 phased vessels.

Fixing this properly means phased vessel strings, which changes the vessel
count, the calibration, `OBS_DIM`, and the speed/reposition action layout —
a multi-day refactor. **Do not do it.** With §0.1 landed, capacity already
binds (28.7% in-flex-no-capacity), which is all the RM story needs.

Instead, **document and reframe**: demand on lanes our four vessels do not
serve in a given window is served by partner carriers and never reaches us
— which is already `plan.md`'s own partner-slot framing (`plan.md` §5,
`calibration.py` partner slot ratio). Report it honestly as a limitation.
If anyone asks "why isn't utilization 90%?", that is the answer, and it is
a true one.

---

## 2. Current module state

| Module | State | Notes |
|:--|:--|:--|
| `data/` (calibration, generators, scenarios, sanity) | [done] | ~831k bookings + 9 panels, 10 scenarios, 2 held out. Do not touch. |
| `simulator/` (world, fleet, demand, metrics, types) | [done] | + §1.1 fix. ~60–90 sim-days/s; ~24 d/s under `bid_price`. |
| `constraints/stowage.py` | [done] | `can_place()` = trial-place + rollback. Never reimplement the shadow logic. |
| `pricing/bid_price.py` | [done] | Proration landed. `explain()` ready for the dashboard. |
| `env/fleet_env.py` | [wip] | `Discrete(44)`, `OBS_DIM=113`. Needs §1.2 seed pinning and §3 forecaster swap. |
| `baselines/heuristics.py` | [done] | static / greedy / dynamic. `heuristic_bid` (dynamic rules + bid pricing) is the ablation and the current best policy. |
| `rl/train.py` | [done] | MaskablePPO curriculum, phases 1–5. **Frozen** — one run, no tuning. |
| `rl/evaluate.py` | [wip] | Needs §1.2. Otherwise sound; holdout-only is correct. |
| `models/` | **[todo]** | §3. Does not exist. |
| Demo artifact pipeline | **[todo]** | §4.1. Does not exist. |
| `src/` dashboard | **[todo]** | §4.2. Exists but is pure mock data. |
| Congestion / delay-risk / reliability forecasters | **[cut]** | See §3.3. |

---

## 3. Supervised forecasters (`backend/models/`) [todo]

Scope is cut hard versus the previous document's six-model table. Build
**three**. Two of them are closed-form and nearly free; the third is the
one that matters.

Conventions: pure numpy/pandas (the local venv has no sklearn — keep
`pytest` runnable everywhere). Each model exposes
`fit(df) / predict(...) / evaluate(df) / save(dir) / load(dir)`
(`.npz` weights + `meta.json`). **Fit on the `build_scenarios(seed)` train
split only; report metrics on the holdout split.** CLI:

```bash
cd backend
.venv/bin/python -m models.train --data data/generated --out models/artifacts
```
prints a metrics table and writes `models/artifacts/report.json`.

### 3.1 `DemandForecaster` — the one that closes the oracle leak

- **Target:** `teu_demanded` per (route, week) from `route_demand_weekly`.
- **Features:** route one-hot, calendar (week-of-year sin/cos, 12-week
  seasonality index), lags `{1, 2, 4}` weeks, 4-week rolling mean, trend
  term, shock-lag indicator.
- **Method:** ridge regression on `log1p(target)`, closed form
  (`np.linalg.solve` on the normal equations with an L2 term); no
  iterative optimizer, no sklearn.
- **Must also expose** `predict_daily(route_idx, day_lo, day_hi) -> float`
  with the **exact signature of `BidPriceEngine`'s `demand_fn`**
  (`(r, day_lo, day_hi) -> expected TEU`), so it drops straight into the
  engine's existing `demand_fn` seam. That seam was built for this; use it.
- **Wiring (this is the point of the model):**
  - `BidPriceEngine(sim, demand_fn=forecaster.predict_daily)` when a
    trained artifact is present; fall back to `_oracle_demand` with a
    **loud warning** otherwise.
  - `env/fleet_env.py` `_obs()`: replace `sim.demand.lam[:, w]` with the
    forecaster's next-week prediction per route. `OBS_DIM` is unchanged
    (still `N_ROUTES` slots), so checkpoints stay compatible — but the
    feature *semantics* change, so any model trained on oracle features
    must be retrained. Do this swap **before** the single RL run, not after.
- **Acceptance:** holdout MAPE reported (no target — report what we get);
  `bid_price` profit over 3×60d must stay within ~10% of the $22.66M oracle
  number. If it collapses, the forecaster is broken — fix it rather than
  reverting to the oracle.

### 3.2 `ElasticityModel` and `WTPModel` — cheap, and they earn a slide

Both are closed-form per segment and exist mainly to prove the pipeline
recovers its own generative parameters — a strong credibility slide.

- `ElasticityModel`: from `price_volume_panel`, regress
  `log(realized_volume / baseline_volume)` on `log(relative_price)` per
  segment. **Must recover `{urgent 0.55, standard 1.1, flexible 1.8}`
  to ±0.15.**
- `WTPModel`: per-segment lognormal `(μ, σ)` of
  `willingness_to_pay_per_teu / market_rate` from `bookings`. **Must
  recover `μ ≈ {1.00, 1.08, 1.38}`.** These are the same parameters
  `pricing/bid_price.py` hardcodes from `calibration.py`, so a match is a
  real end-to-end consistency check — assert it in a test.

Both go in `models/train`'s report table. `ElasticityModel`'s recovered
coefficients also feed the demo's "we measured demand elasticity" panel.

### 3.3 Congestion, delay-risk, reliability [cut]

`CongestionForecaster`, `DelayRiskModel`, `ReliabilityModel` are **cut**.
Nothing consumes their output — port wait and disruption state already
enter the observation as *realized* simulator values, and the reliability
model had 48 training rows, which cannot support any claim we would want to
make in front of judges. Build them only if §4 is completely finished,
which it will not be. They stay in the slide deck as "the same pipeline
extends to…".

---

## 4. The demo — highest priority after §1 [todo]

`plan.md` §7 is the deliverable: three policies, identical demand, live
metrics, plus a shock-injection moment. Two decisions up front.

### Decision A — artifact-driven, not a live API

**Do not build an HTTP server between Python and Next.js.** The backend
writes static JSON; the frontend reads static JSON. Rationale: it removes
the entire live-demo failure mode that `plan.md` §9 tells us to plan
around, it needs no process management on stage, it is faster to build, and
the demo becomes reproducible and diffable. Everything in §7 of the plan is
a *replay* of a completed episode — there is no interactive requirement
that needs a server.

### Decision B — a new route, not a rebuild of the existing screen

`src/app/page.tsx` (the vessel stowage/load-plan screen) stays as is — it
is good-looking context and it is already built. Build the head-to-head
comparison as a **new route `/compare`**, reusing the existing Tailwind
design language and components where they fit. Do not try to retrofit
`src/lib/data.ts`'s mock shapes.

### 4.1 Backend: `scripts/export_demo.py` [todo]

```bash
cd backend
.venv/bin/python -m scripts.export_demo --out ../public/demo \
    --horizon 90 --episodes 5 --seed 42
```

Runs every policy (`static`, `heuristic`, `heuristic_bid`, and `ppo` if a
`--model` is given) on **holdout scenarios only**, with **identical sim
seeds across policies** (reuse the §1.2 seed-pinning path — do not
reimplement it), and writes:

- **`summary.json`** — per policy: mean ± std of `plan.md` §7's headline
  metrics (`revenue_per_teu`, `revenue_usd`, `profit_usd`, `utilization`,
  `empty_teu_nm`, `co2_per_teu`, `fuel_tonnes`, `reject_to_counter_conv`,
  `counter_win_rate`, plus per-segment booked counts for the "shipper
  diversity" metric). Include the lift of each policy over `static` as a
  precomputed percentage — the frontend must not do arithmetic that could
  disagree with what we say on stage.
- **`timeline.json`** — per policy, per sim-day: cumulative revenue and
  profit, utilization, TEU booked, empty TEU-nm, mean bid pressure. This
  drives the racing-lines chart, the core visual.
- **`offers.json`** — ~40 representative decisions from the
  `heuristic_bid` (or `ppo`) episode, each a full reason-coded record from
  `BidPriceEngine.explain()`: request (origin, dest, TEU, segment, cargo,
  requested date, flex), quote, bid price, market rate, reason code,
  per-leg `LegQuote` breakdown (`remaining_teu`, `expected_teu`,
  `pressure`, `market_rate`, `bid_price`), the chosen decision, and the
  realized outcome. **Sample deliberately across outcome types** — at least
  a few each of `booked:accept`, `booked:flex_window`, `booked:alt_hub`,
  `booked:split`, `price_reject`, and a capacity reject. This file *is* the
  explainability deliverable (`plan.md` §4.5); an all-accepts sample wastes
  it.
- **`shock.json`** — the §4.3 pair.
- **`meta.json`** — git SHA, seeds, scenario names, horizon, timestamp,
  which policies are present, and whether the demand oracle or the trained
  forecaster was used. Provenance for every number on screen.

Keep every numeric field pre-rounded and pre-aggregated. Frontend does
presentation only.

### 4.2 Frontend: `/compare` [todo]

Next.js 16 / React 19 / Tailwind 4. **Read
`node_modules/next/dist/docs/` before writing any Next code** — per
`AGENTS.md`, this version has breaking changes. Load the JSON from
`public/demo/` (static import or `fetch`; no server component needs to do
anything clever).

Panels, in priority order — build them in this order and stop wherever time
runs out:

1. **Headline scoreboard** — Static vs Dock side by side, with the lift
   badges from `summary.json` (+25% profit, +16.8% revenue/TEU). This alone
   makes the pitch; build it first.
2. **Racing lines** — cumulative profit per policy over the 90 days from
   `timeline.json`, all policies on one chart. The visual that makes the
   gap obvious. Plain SVG; do not add a charting dependency.
3. **Reason-coded offer feed** — a scrollable list from `offers.json`;
   clicking an offer expands the per-leg bid-price breakdown. This is the
   "judges don't trust a black box" answer (`plan.md` §9).
4. **Impact strip** — empty TEU-nm, CO₂/TEU, fuel, and
   reject→counter conversion, Static vs Dock. The environmental and social
   pillars (`plan.md` §6.2/§6.3).
5. **Shock panel** — §4.3.

Every panel must render from the JSON with **no hardcoded numbers**. If a
policy is missing from `summary.json` (e.g. no `ppo` yet), the UI must
degrade gracefully rather than break — we will not know until late whether
RL makes it in.

### 4.3 Shock injection [todo]

`plan.md` §7's "wow moment", reduced to its honest minimum: a **precomputed
A/B replay**, not live injection.

Add a `SimConfig` hook (or a scenario variant) that forces a disruption —
port closure plus demand spike — at a fixed day (e.g. day 45) of a holdout
scenario. Export **two** runs into `shock.json`: `static` and
`heuristic_bid`/`ppo` on the identical shocked scenario and seed. The UI
scrubs a day slider through the event and shows the divergence: the static
policy sails in and eats demurrage; Dock reprices, reroutes, and issues
counter-offers with reason codes.

A scrubber over precomputed data looks identical to live injection from the
audience's seat and cannot fail on stage. If time is short, cut this before
cutting anything in §4.2.

---

## 5. RL — frozen scope [done / one run pending]

Do **one** pass of the existing curriculum on the GPU box, after §1.2 and
§3.1 have landed (seed fairness and the forecaster swap both change what
the agent sees, so training before them wastes the run).

| Phase | Horizon | Vessels | Fleet acts | Shaping | Pool |
|:--|:--|:--|:--|:--|:--|
| 1 tiny | 14d | VES4 | off | off | train |
| 2 small | 30d | VES4+VES3 | on | off | train |
| 3 +shaping | 30d | VES4+VES3 | on | on | train |
| 4 full | 90d | all 4 | on | on | train |
| 5 stress | 90d | all 4 | on | on | train + 2 adversarial |

Remote box: `ssh -o BatchMode=yes abhinav@192.168.1.3` (WSL2, RTX 3050 8GB,
torch 2.6.0+cu124, sb3 2.9 — cu128/torch-2.11 does not exist, do not retry).

```bash
rsync -az --delete --exclude '.venv/' --exclude 'data/generated/' \
    --exclude '__pycache__/' --exclude 'runs/' \
    -e "ssh -o BatchMode=yes" backend/ abhinav@192.168.1.3:~/Dock/backend/
# per phase, --init-from the previous phase's model.zip:
.venv/bin/python -m rl.train --phase N --timesteps T --n-envs 8 --device cuda
```

**Decision rule, fixed in advance so we do not rationalize later:** if PPO
beats `heuristic_bid` on holdout profit by more than one standard
deviation, it is the headline. Otherwise `heuristic_bid` is the headline
and RL is reported as ongoing research with its curves shown. Either way
`export_demo.py` handles a missing `ppo` gracefully. **Do not tune to
force the first outcome.**

---

## 6. Known issues and honest caveats

Keep these in the deck; do not let a reviewer discover them for us.

1. **Sailing frequency** — 17.8% of requests have no carriage option; our
   4-vessel fleet on disjoint loops gives 23–68 day OD gaps versus a real
   weekly string. Reframed as partner-carrier demand (§1.4). [cut, by
   decision]
2. **Demand oracle** — until §3.1 lands, both the pricer and the RL obs see
   ground-truth `lam`. **No external number may be quoted while this is
   true.**
3. **E estimation** — `_n_deps` approximates a sliding 49-day draw window
   with a single midpoint count. Multiple board calls per OD per vessel are
   handled. Demand that would really go to partners is not discounted, but
   since all `lam` arrives in-sim this is self-consistent.
4. **Counter take-rate is unobservable offline** — `bookings` logs only
   *winning* counters, so `counter_prob` cannot be validated against the
   generated data. Honoured sim-side; report as a modelling assumption.
5. **Terminal Φ = 0** — standard for potential-based shaping, but it puts a
   large negative shaping term on the last steps. Watch phase 3/4 curves
   for end-of-episode dumping.
6. **`SubprocVecEnv` + pricer** — the engine holds only sim refs and
   rebuilds per subprocess; `_cache_day` starts at −1 so the first refresh
   always rebuilds, and capacity is read live. No known staleness, but
   re-check if episodes start behaving differently across workers.
7. **Sim speed** — ~24 sim-days/s under `bid_price` versus 60–90 under
   `dynamic` (refresh + per-request quote optimization). Fine for PPO on
   the box; re-time if a phase balloons.
8. **`OBS_DIM` 113** — pre-bid-feature checkpoints are incompatible, and
   §3.1 changes feature semantics without changing the dimension. Record
   the git SHA with every checkpoint.

---

## 7. Execution order

Strictly sequential; each step gates the next.

1. §1.1 — land the jitter fix + all three regression tests. Suite green.
2. §1.2 — evaluation seed fairness + its test. **Gate: no reported number
   is trustworthy before this.**
3. §1.3 — revive the negotiation layer. Gates §4.1's offer feed.
4. §3.1 — `DemandForecaster`, wired into both `demand_fn` and `_obs()`.
   §3.2 alongside (cheap, and the parameter-recovery test is a real check).
5. §4.1 — `export_demo.py`, run with `heuristic_bid` as the lead policy.
   **At this point we have a complete, demoable project with no RL.** This
   is the milestone that de-risks everything.
6. §4.2 — `/compare` panels 1 → 5, in order.
7. §5 — the single RL curriculum run, in parallel with step 6 once step 4
   has landed. Re-export §4.1 with `--model` if it wins.
8. §4.3 — shock panel, if time remains.

---

## 8. Reproduce / verify

```bash
cd backend
.venv/bin/python -m pytest                       # must stay green
.venv/bin/python -m data.generate --seed 42 --scale 1.0 --out data/generated
.venv/bin/python -m scripts.run_episode --episodes 3 --horizon 60
# head-to-head incl. bid_price (the §0.2 table):
.venv/bin/python -m rl.evaluate --model none --episodes 3 --horizon 60
.venv/bin/python -m models.train --data data/generated --out models/artifacts
.venv/bin/python -m scripts.export_demo --out ../public/demo --seed 42
npm run dev                                      # then open /compare
```
