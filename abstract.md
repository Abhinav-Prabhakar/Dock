# Dock — Project Abstract & Technical Deep-Dive

**Dynamic revenue management for a container-shipping fleet.** Container
shipping moves ~80% of global trade (~$141B in 2025) but still prices its most
perishable asset — a container slot on a specific voyage on a specific date —
with a flat weekly rate card and binary accept/reject. Airlines solved this in
the 1980s and unlocked 3–9% more revenue. Shipping never did. Dock is that
system, built end-to-end and running live.

This document is the "everything" reference: the problem, the architecture,
every model and how it was trained, the strategies used, the settlement layer,
the frontends, and the honest results.

---

## 1. The problem we attack

Four structural failures in how carriers sell capacity today:

1. **Binary accept/reject destroys value.** A booking that doesn't fit is lost
   revenue — there is no "yes, but Thursday instead." Airlines convert
   15–20% of such declines with counter-offers; shipping converts ~0%.
2. **Static pricing leaves money on the table in both directions.** A weekly
   rate card can't tell a slot on a nearly-empty sailing from a slot on a
   sailing that will be sold out tomorrow.
3. **Empty containers are a $15–20B annual waste.** Trade imbalance means
   boxes pile up where nobody wants them. Repositioning is a scheduling
   decision with delayed payoff — exactly what naive pricing can't see.
4. **Pricing ignores physics.** A quote that the vessel can't stow — wrong
   stack order, hazmat conflict, no reefer plug — is a promise you can't keep.

## 2. What Dock is

A running digital twin of a container-shipping line plus the decision system
that operates it, exposed through a live API and two real user-facing sites:

- **The world** — a discrete-time simulator (`backend/simulator/`): 8 real
  ports (Shanghai, Singapore, Busan, Rotterdam, Hamburg, Antwerp, LA/LB,
  NY/NJ), 4 vessels on fixed loops (Pacific Aurora 8,000 TEU; Meridian Star
  5,500; Atlantic Pioneer 4,000; Coral Empress 2,500), 18 market routes, 3
  cargo types (dry / reefer / hazmat), 3 customer segments
  (flexible / standard / urgent). Daily steps over a 90-day quarter:
  booking requests arrive, vessels sail, fuel and EU-ETS carbon prices drift,
  ports congest and close, storms and canal blockages stretch legs.
- **The decision stack** — five stages between "booking request" and
  "structured response": demand forecasting → bid-price engine → stowage
  constraint solver → MaskablePPO policy → negotiation layer.
- **The accountability layer** — every simulated event lands in a
  Keccak-256 hash-chained ledger; every conditional deal (a counter-offer the
  customer accepted) registers on a real in-process EVM contract.
- **The interfaces** — a customer booking site (Next.js static export at
  `/customers/`), a port-operator console (`/`), an OpenAI-compatible LLM
  assistant on each side, and a FastAPI surface under `/api`.

```
                BOOKING REQUEST
                      │
        ┌─────────────┴──────────────┐
        │  Demand forecasting        │  closed-form ridge, bound per episode
        └─────────────┬──────────────┘
                      ▼
        ┌────────────────────────────┐
        │  Bid-price engine          │  shadow price per leg / time window
        └─────────────┬──────────────┘
                      ▼
        ┌────────────────────────────┐
        │  Stowage constraint solver │  → binary action mask (never learned)
        └─────────────┬──────────────┘
                      ▼
        ┌────────────────────────────┐
        │  RL decision engine        │  MaskablePPO over masked actions
        └─────────────┬──────────────┘
                      ▼
        ┌────────────────────────────┐
        │  Negotiation layer         │  structured response + reason code
        └─────────────┬──────────────┘
                      ▼
           SIMULATOR / DIGITAL TWIN   (trains the RL, generates data, runs the demo)
```

Three design principles run through everything:

- **Hard constraints are never learned.** The RL agent can only ever choose
  among physically valid, legally compliant actions — safety comes from the
  mask, not from training luck.
- **No oracle leakage.** Pricing and the RL observation consume the trained
  `DemandForecaster`, never the simulator's ground-truth demand intensity.
  Missing model artifacts raise `RuntimeError` — nothing silently degrades.
- **Supervised models feed the RL policy; they never replace it.**

## 3. The decision stack, stage by stage

### 3.1 Demand forecasting — `models/demand.py`

A **closed-form ridge regression** per (route, week): 29 features (route
one-hots, week-of-year and 12-week seasonality sin/cos, clipped trend, residual
lags 1/2/4, rolling residual mean, shock indicator), solved by
`np.linalg.solve` on the normal equations — no sklearn, no optimizer.

The subtle, load-bearing choice: the regression target is the **climatology
residual** (`log1p(demand) − log1p(climatology)`), not the level. Scenario
regime multipliers are constant within an episode but unknown at week 0; a
level model regresses to the pooled mean (~1.8× over-prediction measured),
while residual lags let a single observed week re-level the whole forecast to
the episode's regime.

`BoundDemandForecaster` binds the fitted model to a live episode: a
week-indexed history buffer seeded from climatology, filled forward with
observed demand (including a scaled nowcast for the week in progress),
recursively predicting ahead. Its `daily(route, lo, hi)` is exactly the
`demand_fn` the pricing engine consumes — in the same request-rate units the
pricing engine was calibrated against.

### 3.2 Opportunity-cost pricing — `pricing/bid_price.py`

For every bookable leg of every vessel, the engine estimates the **shadow
price of one TEU of capacity**: what that slot is worth given the demand still
expected to contest it.

- `E_leg` = expected contested TEU demand before the leg departs (from the
  bound forecaster, divided across the competing own-fleet departures inside
  the 49-day booking window).
- `K_leg` = remaining bookable TEU on the leg, live.
- The marginal value is solved as `max_r r · min(1, E·SF(r)/K)` over a
  36-point relative-price grid, where `SF` is the segment-mixture
  willingness-to-pay survival function (lognormal per segment). Thick demand
  → approaches the market-clearing price; thin demand → optimal price
  discounted by the odds it sells at all; `E=0` → the slot is worthless.
- **Quotes** are the revenue-optimal posted price over that opportunity-cost
  floor: `argmax_p SF_segment(p)·(p − bid)` — a classic monopoly markup over
  marginal cost, clipped to `[0.80, 1.45]× market`. Every quote carries a
  **reason code** (`bid_price_floor` / `market_uplift` /
  `competitiveness_guard`) plus a per-leg breakdown (`remaining_teu`,
  `expected_teu`, `pressure`, `bid_price`) — explainability is a data
  structure, not a paragraph.
- **Counter-offer discounts** are bid-price differentials between the
  requested voyage and a cheaper alternative — a discount is only offered when
  it is justified by actually cheaper capacity, capped at 30%.
- `network_value()` — `Φ(s) = Σ bid_leg × K_leg` — doubles as the potential
  function for RL reward shaping (§4.3).

### 3.3 Stowage constraint solver — `constraints/stowage.py`

A deterministic solver models each vessel as bays of container stacks and
enforces, eagerly at accept time against a *projected* plan:

- **Destination-order stacking** — a box can only sit above boxes discharged
  at the same or a later call (top of stack discharges first; no
  re-handling at sea).
- **Weight order** — heavier below lighter.
- **Slot limits** — hard stack height per bay.
- **IMDG hazmat segregation** — hazmat only in designated bays, hazmat bays
  exclusively hazmat (bay-level separation), max 2 per bay.
- **Reefer plugs** — reefer only in powered bays, capped by the vessel's
  plug count.

Its output is not a plan suggestion — it is the **binary action mask** the RL
policy never sees past.

### 3.4 The RL decision engine — `env/fleet_env.py` + MaskablePPO

**Why RL at all:** the decision is sequential. Rejecting a mediocre booking
today is right if premium demand arrives next week; repositioning empties
costs now and pays in two weeks; slow-steaming saves fuel but changes which
future bookings are feasible. Supervised scoring can never represent
"hold capacity for later" — RL is the structurally correct tool, not a
buzzword.

**MDP:**
- **Observation** — flat 112-dim vector: request block (14), 4 voyage-option
  blocks (5 each, incl. that option's bid price), market block (6: fuel, ETS,
  progress, season, mean bid pressure, network value), per-port state (3×8:
  wait, empties, closed), per-vessel state (6×4), the forecaster's next-week
  prediction on all 18 routes, calendar sin/cos, decision-type flags.
- **Actions** — flat `Discrete(44)`, two interleaved step types:
  - *Booking steps* (one per request): reject; accept at quote;
    flex-window discount {5,10,15,20}%; alt-hub discount {5,10,15}%;
    split consignment {50/50, 60/40, 70/30}.
  - *Fleet steps* (every `fleet_every`=3 days): set speed {12,14,16,18} kt
    per vessel; reposition {75,150} TEU empties on the top-8
    surplus→deficit port pairs.
  - `action_masks()` recomputes the feasible set every step — a booking
    action only exists if the stowage solver says it can physically load.
- **Reward** — layered, dense per-step:
  1. `Δprofit/10,000` across every cost line (revenue − fuel − carbon −
     port fees − demurrage − repositioning − container lease − roll
     compensation);
  2. `−2e-6` per empty TEU-nm sailed (anti-deadhead pressure);
  3. *potential-based shaping* in curriculum phases ≥3:
     `0.1·(γ·Φ(s′) − Φ(s))/10,000` clipped to ±50, where `Φ` is the
     bid-price engine's `network_value()`. Potential-based shaping provably
     leaves the optimal policy unchanged (Ng et al. 1999) but densifies the
     accept-vs-hold signal.

**Training:** Stable-Baselines3 `MaskablePPO` (`sb3-contrib`), shared-trunk
MLP `256×256` → policy + value heads, lr 3e-4, n_steps 512, batch 256,
γ=0.99, ent_coef 0.01, 8 `SubprocVecEnv` workers, torch on CUDA (RTX 3050).
**~1.8M steps across a 5-phase curriculum** — small worlds first:

| Phase | World | Notes |
|---|---|---|
| 1 — tiny | 14d, VES4 only, bookings only | 200k steps |
| 2 — small | 30d, VES3+VES4, fleet actions on | 300k, warm-started |
| 3 — +shaping | same + potential-based shaping | 300k |
| 4 — full | 90d, all 4 vessels | 600k |
| 5 — stress | 90d + adversarial scenarios (Suez-style closure, simultaneous port storm+strike) | ~400k |

Training never touches the two holdout scenarios. Checkpoints
(`runs/ppo_c1..c5`) carry a `config.json` recording git SHA and observation
semantics.

### 3.5 Negotiation layer — the product differentiator

Every decision is a **structured response**, not a bit:

| Response | Mechanism |
|---|---|
| Accept at quoted price | bid-floor check + stowage feasibility |
| Flexible-window discount | bid price is lower on adjacent sailings → discount = bid differential |
| Alternate-hub discount | downstream leg congested → cheaper discharge port, priced by differential |
| Split consignment | full volume doesn't fit; partial fit verified on both voyages |
| Reject with explanation | nothing feasible; reason code + next-available suggestion |

Measured counter-offer win rate **19–27%** across seeds vs. the 15–20%
airline benchmark — with profit flat-to-up, because counters only fire where
the EV math justifies them. (Honest caveat carried in `plan.md`: splits stay
near zero *by construction* — when a consignment doesn't fit whole, both
halves fit only ~7% of the time.)

## 4. Supervised models — all closed-form, all honest

All three models are **closed-form fits on simulator-generated data** —
deliberately interpretable, deliberately leak-proof:

| Model | Method | Role |
|---|---|---|
| `DemandForecaster` | ridge on climatology residuals, 29 features | feeds the bid engine's `E` and the RL observation's 18 forecast slots |
| `ElasticityModel` | per-segment OLS of `log(volume)` on `log(rel_price)` | recovers price elasticity from randomized price probes (rel ∈ {0.80…1.25}) |
| `WTPModel` | per-segment lognormal (closed-form μ, σ) | recovers the WTP multipliers {flexible 1.00, standard 1.08, urgent 1.38} |

The last two exist to *prove the pipeline recovers its own generative
parameters* — a calibration audit, not a production dependency.

**Why synthetic data:** booking-level demand data with negotiation outcomes
does not exist publicly. The simulator is therefore the load-bearing
component — 10 demand regimes (seasonality, trade imbalance, Poisson shock
events, elastic segments), real-world anchors (Drewry WCI, SCFI, VLSFO,
EU ETS) calibrating generator parameters (`data/CALIBRATION.md`), and **2
scenarios permanently held out** (`depressed-demand`, `volatile-shocks`) —
never trained on, only evaluated.

## 5. Serving it live — API, ledger, settlement

- **Always-on live episode** — on startup the API launches a real PPO episode
  (baseline scenario, 90-day horizon, restarted at end) paced by
  `DOCK_LIVE_SPEED` (default 1 sim-day/minute). Customer quotes and operator
  views are priced against *this* world — not a replay.
- **FastAPI surface** (`api.md` is the reference): `/live` snapshot,
  `/live/events` (sequence-tailed feed), `/live/policy` + `/live/policy/network`
  (real forward+backward pass over the trained network — masked action
  probabilities, logits, value, entropy, hidden activations,
  gradient-times-input attributions), `/live/vessels/{id}/stowage`,
  `/orders` + accept/decline, `/episodes` control, `/episodes/{id}/ledger`
  (+`/verify`), `/compare/*` precomputed 5-policy exports,
  `/chat/{customer,operator}`, and `WS /episodes/{id}/stream`.
- **Hash-chained ledger** — every event is a canonical-JSON line chained by
  `keccak256` to its predecessor (`ledger/store.py`); any edit, deletion or
  reorder fails verification. The audit log is literal, not metaphorical.
- **On-chain settlement** — `settlement/DockSettlement.sol` deployed per
  episode on a real in-process EVM (py-evm via eth-tester → real contract
  address, real tx hashes, real gas). Conditional deals (accepted
  flex-window / alt-hub / split counters) lock their terms on-chain: depart
  within board-day ±2 days, deliver within +45 days, 1000 bps carrier-late
  penalty. The backend acts as oracle writing departure/delivery
  confirmations; `settle()` is a pure function of recorded timings →
  `settled_full` / `settled_penalty` / `refunded`.
- **Postgres + Alembic** for customer orders; nginx fronts everything
  same-origin on `:8080` (`/` operator console, `/customers/` customer site,
  `/api/` backend, WS upgrade).

### Performance work that made the demo livable

The sim driver originally barged the episode lock so hard that `/ports`
took **30–186 s** under load. Fixed by `SimLock` — a fair lock where the
driver parks (≤250 ms) until already-blocked handlers get their turn — plus
`functools.cache` on static dataset reads and lock-wait telemetry exported
in `/live` (`handler_wait_ms` / `step_wait_ms` / `step_hold_ms`, p50/p95/max
over the last 512). Result: `/live` median 498→15 ms, `POST /orders` p95
1068→80 ms, on a CPU-bound sim at 20× speed. (`docs/PERF-LATENCY-HANDOFF.md`.)

## 6. The interfaces

**Customer site — "Meridian Line"** (`customers/`, Next.js App Router,
static export): booking intake (ports, TEU, cargo type, service segment,
departure flexibility) → live-priced offer slip with the full negotiation
menu — accept / flex-window / alt-hub / split, each offer carrying the PPO
recommendation → fleet dashboard tracking orders QUOTED → CONFIRMED →
LOADING → IN TRANSIT → AT PORT → DELIVERED, with on-chain settlement status
for conditional deals. A **Booking Desk** LLM assistant can quote, list, and
(with an explicit same-turn guard so it can't book what you haven't seen)
accept offers.

**Operator console** (`drafts/cargo-ship/`, dependency-free static JS):
- **Vessel** — live 3D hulls (per-vessel geometry matched to real TEU
  capacity), stowage rendered from the actual `/live/.../stowage` plan, and
  a bookings rail streaming every quote, accept, decline, and deal
  settlement as events arrive.
- **Stowage** — side elevation + top/plan views of the live cargo plan.
- **Statistics** — the 5-policy holdout comparison (`/compare/*`) plus live
  fleet telemetry.
- **Model** — the trained PPO *thinking out loud*: the 112 observation
  features, the legality mask, masked action probabilities, value estimate,
  entropy, hidden-layer activations, per-feature attributions, pricing
  curve, and counterfactuals (what each baseline policy *would have done* on
  the same request) — all from a real forward+backward pass per decision.
- **Copilot** — a read-only LLM assistant that can pull the live snapshot,
  a vessel's stowage, booking outcomes, customer orders, and the strategy
  comparison.

Both assistants run one bounded tool loop (≤6 model calls/turn,
audience-scoped tool sets — the operator copilot cannot touch bookings)
against the *same* functions the REST routes use. Both frontends run on
**live data only** — no mock or cached fallbacks; if the API is unreachable
they say so.

## 7. Results — the ablation ladder, honestly

Five policies run the identical simulator on identical demand (each rung adds
one capability): `static` (rate card — the industry today) → `greedy` →
`heuristic` (+counters) → `heuristic_bid` (+bid-price floor) → `ppo` (learned
sequencing on top of all of it).

Holdout evaluation (`runs/ppo_c5/eval_results.json`, 5 episodes × 90 days,
holdout scenarios only):

| Policy | depressed-demand | volatile-shocks |
|---|---:|---:|
| static | −$5.2M | $17.0M |
| greedy | $6.5M | $22.0M |
| heuristic | $9.0M | $23.2M |
| heuristic_bid | $8.5M | $24.7M |
| **ppo** | $8.3M | **$25.9M — best** |

What the numbers actually say:

- **Most of the lift is the decision stack, not the network.** Going from a
  rate card to bid-priced counter-offers is worth ~$14M in depressed demand
  and ~$8M under shocks before any learning enters the picture.
- **RL earns its keep where sequencing matters.** Under volatile shocks PPO
  tops every baseline (+$1.2M over the best heuristic) — holding capacity,
  repositioning ahead of surges, speed-vs-schedule trade-offs. In a flat
  market it roughly ties the bid-price heuristic, which is the honest result:
  when there's little to sequence, there's little for RL to add.
- **Counter-offers convert.** 19–27% win rate on counters that a binary
  system loses entirely.

## 8. Engineering rigor

- 145 backend pytest tests green; frontend adapter tests (vitest/node) for
  every live-data mapping; `scripts/check_imports.py` guards the no-bundler
  frontend's module graph; `scripts/e2e.sh` drives a real customer booking
  through quote → accept → on-chain settlement; `scripts/verify_ledger.py`
  audits the hash chain.
- One-command stack: `docker compose up --build` → Postgres migrations +
  dataset generation + live PPO episode + both sites on `:8080`.
- Documented failure modes, not hidden ones: holdout-only evaluation, no
  oracle fallbacks, explicit "unavailable" UI states, and a public handoff
  doc for the known sharp edges.

## 9. Impact

| Pillar | Claim |
|---|---|
| Economic | 5–12% more revenue per TEU; 4–8pp higher utilization from the same fleet |
| Environmental | 10–20% fewer empty container-miles; carbon-aware speed is a profit decision, not a mandate |
| Social | Counter-offers give small shippers access binary reject denies; every quote is explainable — reason codes, per-leg bid decomposition, and an auditable settlement trail |
