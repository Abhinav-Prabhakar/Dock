# Project Dock

## Dynamic Revenue Management for Container Shipping Fleets

### Hackathon Source of Truth — v2.3 (as built)

> **Rule:** If it isn't in this document, confirm before building it. Every feature, architectural decision, and claim traces back to a section here. Sections marked **as built** describe the shipped implementation; everything in P0/P1 is implemented and tested.

---

## 1. The Problem

### The \$141B industry still pricing like it's 1975

Container shipping moves **80% of global trade by volume**. The industry generated ~\$141 billion in service revenue in 2025. And yet, it prices its most perishable asset — a container slot on a specific voyage on a specific date — the way airlines priced seats before deregulation: **a flat rate card, updated weekly or monthly, applied uniformly to every customer on a route regardless of demand, timing, or network state.**

This creates four compounding inefficiencies:

#### 1. Binary accept/reject destroys value

When a booking doesn't fit (wrong date, overcapacity, suboptimal route), it's simply rejected. No counter-offer. No "what if you flex 3 days?" No "what about splitting across two voyages?" Every hard reject is a revenue opportunity killed that could have been a profitable deal with a small modification. In airlines, flexible pricing and rebooking convert roughly 15–20% of would-be rejections into revenue. Shipping doesn't even try.

#### 2. Static pricing leaves money on the table — in both directions

A weekly rate card can't respond to a demand surge on a specific route (underpricing → sold out early, missing premium bookings), or a demand dip (overpricing → sailing with empty capacity that generates zero revenue). Airlines learned this in the 1980s: **revenue management typically generates an additional 3–9% in revenue** (industry consensus from decades of data). Applied to a \$141B industry, that's **\$4–13B of value** currently being left on the table.

#### 3. Empty containers are a \$15–20B annual waste

One in every three containers transported on a ship is **empty** — roughly 60 million empty moves per year, costing the industry **\$15–20 billion annually** (5–8% of total operating costs, up to 12% when including storage and ownership costs). This happens because trade is structurally imbalanced (heavy export from Asia, heavy import to North America/Europe), and no dynamic system exists to price, reposition, and incentivize backhaul cargo intelligently.

#### 4. No integration between pricing and physical constraints

A container slot isn't just "capacity" — it's a physical position on a ship that must satisfy destination-order stacking (containers unloaded first must be on top), hazmat segregation, weight balance across the vessel, and reefer plug availability. Current pricing is completely disconnected from stowage reality. A rate card might quote a price for a slot that doesn't physically exist given what's already loaded, or reject a booking that could easily fit with a minor rearrangement. The pricing system and the loading plan don't talk to each other.

#### Why airlines solved this and shipping hasn't

Airlines were forced into revenue management by razor-thin margins and the extreme perishability of their inventory — an empty seat at takeoff is revenue destroyed forever. Container shipping has **identical structural properties**: perishable inventory (an empty slot at departure is gone), network structure (multi-leg itineraries, transshipment hubs), and segmentable demand (urgent/premium vs. flexible/budget shippers). But the tooling, data infrastructure, and cultural inertia haven't caught up. Robert Crandall, the CEO who pioneered airline yield management at American Airlines, called it "the single most important technical development in transportation management." Forty years later, shipping still hasn't adopted it.

**That gap is the opportunity.**

---

## 2. The Solution — How We Solve This

### 2.1 Core Thesis

Dock replaces the flat rate card with an **integrated system** that knows:

1. **What capacity is actually worth** — not a flat rate, but the real-time opportunity cost of every slot on every leg, computed against the entire network's bookings and demand forecast.
2. **What's physically possible** — a constraint solver that understands stowage, hazmat, balance, and tells the pricing engine which slots actually exist before it quotes a price.
3. **How to negotiate, not just accept/reject** — a counter-offer engine that converts hard rejections into flexible deals: date shifts, port alternatives, shipment splits, and volume contracts.
4. **When to hold vs. sell** — a reinforcement learning agent that learns the sequential strategy: sometimes it's better to reject a mediocre booking today because a more profitable one is coming next week; sometimes it's better to slow-steam to save fuel when demand at the destination is low; sometimes it's better to reposition empty containers now to capture an upcoming export surge.

The key insight: **these four capabilities are tightly coupled and must be one system.** A pricing engine that doesn't know stowage constraints quotes impossible prices. A constraint solver that doesn't know demand leaves money on the table. A negotiation layer without opportunity-cost awareness gives away margin. An RL agent without all three as inputs makes blind decisions.

### 2.2 System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        BOOKING REQUEST                             │
│            (shipper, origin, dest, date, TEUs, cargo type)         │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  ┌────────────────────┐   ┌──────────────────────────────────────┐  │
│  │  DEMAND & RISK     │   │  OPPORTUNITY-COST PRICING ENGINE     │  │
│  │  FORECASTING       │──▶│  (network LP / bid-price calc)       │  │
│  │  (supervised NNs)  │   │  → shadow price per leg/time-window  │  │
│  └────────────────────┘   └──────────────┬───────────────────────┘  │
│                                          │                          │
│  ┌────────────────────┐                  │                          │
│  │  STOWAGE           │                  │                          │
│  │  CONSTRAINT SOLVER │──▶ legal action  │                          │
│  │  (deterministic)   │    mask          │                          │
│  └────────────────────┘       │          │                          │
│                               ▼          ▼                          │
│                    ┌──────────────────────────┐                     │
│                    │  RL DECISION ENGINE      │                     │
│                    │  (PPO policy)            │                     │
│                    │  state = fleet + demand  │                     │
│                    │         + risk + prices  │                     │
│                    │  actions = masked set    │                     │
│                    └────────────┬─────────────┘                     │
│                                 │                                   │
│                                 ▼                                   │
│                    ┌──────────────────────────┐                     │
│                    │  NEGOTIATION &           │                     │
│                    │  COUNTER-OFFER LAYER     │                     │
│                    │  → structured response   │                     │
│                    │    with reason codes     │                     │
│                    └────────────┬─────────────┘                     │
│                                 │                                   │
│                   SIMULATOR / DIGITAL TWIN                          │
│                   (wraps everything for training & demo)            │
└──────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      STRUCTURED RESPONSE                            │
│  Accept @ $X  |  Counter-offer (flex window / alt hub / split)     │
│  with reason code + bid-price justification                        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  SERVING & AUDIT LAYER  (as built — §2.9)                           │
│  FastAPI + WebSocket live episodes · hash-chained event ledger      │
│  (Keccak-256 JSONL) · conditional deals settle on a local EVM       │
│  (DockSettlement.sol — real tx hashes)                              │
│  · customer booking site + operator console (static, nginx)         │
│  · Postgres orders                                                  │
└──────────────────────────────────────────────────────────────────────┘
```

Five components, each doing one job, connected through a shared fleet state. The critical design principle: **hard constraints are never learned — they are enforced deterministically before the learned model ever sees an action.** The RL agent only ever chooses among physically valid, legally compliant options.

### 2.3 The Simulator (Digital Twin)

> [!IMPORTANT]
> This is the single most load-bearing component. It generates training data, is the RL training environment, and powers the live demo. If the simulator is broken, everything downstream is broken.

**What it models:**

| Element | Implementation (as built) |
|:---|:---|
| **Port network** | **8 real ports** — Shanghai `CNSHA`, Singapore `SGSIN`, Busan `KRPUS`, Rotterdam `NLRTM`, Hamburg `DEHAM`, Antwerp `BEANR`, Los Angeles `USLAX`, New York `USNYC` — with real coordinates, berth counts, congestion priors, and sailing distances. **18 servable OD routes** across three lanes (Asia↔Europe, Asia↔North America, regional) with directional volume asymmetry (~75/25 head/backhaul). Unserved demand is framed as partner-carrier slot capacity. |
| **Fleet** | **4 vessels** `VES1–VES4` (2,500 / 4,000 / 5,500 / 8,000 TEU) on fixed closed loops, with speed profiles, cubic fuel curves (`a + b·v³`, hotel load included), reefer plug counts, age, and draft. Only ~40% of nominal capacity is bookable own-lift (×0.45 own-lift share, ×0.88 stowage buffer) — demand deliberately exceeds it, so capacity is genuinely scarce. |
| **Demand** | Stochastic booking request arrivals **anchored to real sailings** (requested departure drawn near an actual ETD), parameterized by route, season, cargo type, customer segment, and price sensitivity. Hidden per-booking willingness-to-pay; demand is elastic — price changes affect booking volume. |
| **Containers** | TEU quantities (booking-size mixture 1–250 TEU, realized mean ~15.7 TEU), dry/reefer/hazmat types (70/20/10), origin-destination pairs, delivery deadlines. |
| **Weather & disruptions** | Stochastic events: storms, port congestion spikes, canal closures, port strikes — weekly baseline probabilities per type, scaled by scenario. |
| **Time** | Daily step granularity with continuous event times over a configurable horizon (default: 90-day quarter). |
| **Economics** | VLSFO bunker price ~\$600/t (stochastic weekly walk), EU ETS carbon ~€80/tCO₂ (€60–105 band), port fees, demurrage at \$50K/day scale, empty-lease and repositioning costs. |

**Critical requirement:** The simulator runs at **~10³× real-time** (measured ≈20–90 sim-days/s core loop; ≈11 sim-days/s under full bid-price pricing) — fast enough that the 5-phase RL curriculum (~1.8M steps) completes on a single consumer GPU. No graphics in the training path; visualization is a separate rendering layer for the demo only.

**Implementation (as built):** Python under `backend/`, discrete-event simulation with daily step granularity. Gymnasium-compatible `CargoFleetEnv` (`backend/env/fleet_env.py`) with standard `reset()` / `step()` interface. All calibration constants live in `backend/data/calibration.py`, anchored to public market data (Drewry WCI, SCFI, VLSFO, EU ETS — see `backend/data/CALIBRATION.md`).

### 2.4 Demand & Risk Forecasting (Supervised Models)

These are **supervised prediction models**, not RL. There's no sequential decision element to "predict tomorrow's demand" — a forecast is a one-shot prediction, and RL adds zero value here. Their outputs become features in the state vector the RL agent sees and inputs to the bid-price engine.

Three models are built (`backend/models/`, pure numpy/pandas, closed-form — no sklearn). All fit on the train-scenario split only and report metrics on the holdout; artifacts (`weights.npz` + `meta.json` + `report.json`) are committed under `backend/models/artifacts/`.

| Model | Input | Output | Implementation & measured fit |
|:---|:---|:---|:---|
| **Demand forecast** (`DemandForecaster`) | `route_demand_weekly` panel — route, calendar, recent booking velocity | Expected request intensity per route/week (lam units) — consumed by the bid-price engine's expected demand (`BoundDemandForecaster.daily`) and by 18 slots of the RL observation (`next_week()`) | Closed-form ridge on `log1p` climatology residual: route one-hot, week-of-year sin/cos, 12-week seasonality index, lags {1,2,4}, 4-week rolling mean, trend, shock-lag, plus a scaled same-week nowcast of realized demand. Bound per episode; **never reads ground-truth future demand** (missing artifact → `RuntimeError`, no oracle path). Holdout MAPE **0.58**; bid-price profit within ~5% of oracle. |
| **Demand elasticity** (`ElasticityModel`) | `price_volume_panel` | Per-segment price elasticity — how much a price move shifts bookings | Per-segment OLS of `log(realized/baseline volume)` on `log(relative price)`. Recovers **{urgent 0.55, standard 1.10, flexible 1.80}** — the generative parameters to ±0.003. |
| **Willingness-to-pay** (`WTPModel`) | `bookings` (hidden `wtp_per_teu` in data-gen) | Per-segment WTP distribution relative to market rate | Per-segment lognormal fit. Recovers **μ ≈ {1.00, 1.08, 1.38}** vs the same true parameters — an end-to-end consistency check on the whole pipeline. |

**Cut (deliberately):** dedicated congestion, delay-risk, and vessel-reliability forecasters. Port wait, closures, and disruption state already enter the RL observation as *realized* simulator values, and the reliability model had too few training rows to support a claim. The same pipeline extends to them post-hackathon.

> [!NOTE]
> The elasticity and WTP models exist partly as a **credibility proof**: the pipeline recovers its own generative parameters (displayed in the demo's credibility panel via `GET /models/report`). The demand forecaster is the load-bearing one — it closes the oracle leak that would otherwise hand the RL agent perfect demand foresight.

### 2.5 Opportunity-Cost Pricing Engine

This is the economic brain that replaces the flat rate card. It answers the question: **"What is the last unit of capacity on this leg, at this time, actually worth to the network?"**

**Mechanism (as built — `backend/pricing/bid_price.py`):** For every bookable leg of every vessel, the engine estimates the **shadow price** of one TEU of capacity as the isoelastic market-clearing rate at which expected remaining demand would exactly consume remaining slots:

$$p^*_{\text{leg}} = \text{mkt}_{\text{leg}} \cdot \left(\frac{E_{\text{leg}}}{K_{\text{leg}}}\right)^{1/\varepsilon}, \qquad \text{bid} = \text{clip}\left(p^*,\ \text{marginal cost},\ 1.45 \times \text{mkt}_{\text{leg}}\right)$$

where $E_{\text{leg}}$ is forecaster-expected contested TEU before the leg departs and $K_{\text{leg}}$ is remaining bookable TEU. Leg market rates are prorated from OD rates by sailing distance (the standard interline revenue split — without this, opportunity cost scales spuriously with leg count). A booking's opportunity cost is the sum of bid prices over the legs it occupies; quotes are chosen as $\arg\max_p P(\text{accept} \mid p) \cdot (p - \text{bid})$ under the segment WTP mixture, capped by a competitiveness guard against market. `network_value()` — $\Phi(s) = \sum \text{bid}_{\text{leg}} \cdot K_{\text{leg}}$ — is the potential used for RL reward shaping (Section 3.5).

**Why this matters for every decision:**

- **Pricing:** A quote for a booking is checked against the bid price. If the customer's willingness-to-pay exceeds the opportunity cost, accept. If not, the gap tells you how big a discount to offer via counter-offers.
- **Counter-offers:** The bid price difference between "direct Rotterdam delivery" and "discharge at Antwerp instead" quantifies the alternate-hub discount exactly.
- **RL reward shaping:** The bid price provides a dense, principled reward signal — the RL agent gets intermediate feedback on whether its decisions are moving capacity allocation toward the network-optimal state (Section 3.5).

**As built:** the heuristic shipped — the LP was never needed. Two upstream bugs initially made it look broken (un-prorated leg rates triple-counted fares on multi-leg itineraries; a flex-window search bound discarded the very sailing each request was anchored to). Once fixed, bid-price control beat the static rate card by **+25% profit and +16.8% revenue/TEU** on identical demand (3×60d baseline) — from the pricing layer alone, before RL.

### 2.6 Stowage Constraint Solver

A **deterministic, non-learned module** that enforces physical and regulatory loading constraints. This is never left to the RL agent to learn — hard safety constraints must be 100% reliable.

**Constraints enforced:**

| Constraint | Description |
|:---|:---|
| **Destination-order stacking** | Containers destined for the next port of call must be accessible without moving containers bound for later ports. This is a topological ordering constraint on the vertical stack per bay. |
| **Hazmat segregation** | IMO IMDG code requires minimum separation distances between incompatible dangerous goods classes. Modeled as a conflict graph with exclusion zones. |
| **Weight distribution** | Vessel stability requires balanced loading across port/starboard and fore/aft. Metacentric height (GM) must stay within safe bounds. |
| **Stack weight limits** | Maximum stack weight per bay position, with heavier containers below lighter ones. |
| **Reefer plug availability** | Refrigerated containers require powered slots; the number is fixed per vessel. |

**Role in the RL system:** Before the policy network outputs action probabilities, the constraint solver computes a **binary mask** over the action space — which placements and accepts are physically feasible given the current ship state. Illegal actions are masked to probability zero. The RL agent never wastes training signal learning that you can't stack a 30-ton container on top of a 5-ton container. This is standard practice in constrained RL (analogous to legal-move masking in game-playing agents like AlphaGo) and is what makes the problem tractable under hackathon time pressure.

**As built (`backend/constraints/stowage.py`):** each vessel is a 2D grid of bays × stack height (row-level detail ignored). Enforced per placement: destination-order stacking, weight ordering (heavy below light), max stack weight, hazmat confined to designated bays (max 2 hazmat per bay), and reefer containers to powered bays under a plug cap. `can_place()` is a trial-place-then-rollback — feasibility checks share the exact code path as real placement, so the mask can never diverge from the physics.

### 2.7 The RL Decision Engine

Described in full in [Section 3](#3-reinforcement-learning--deep-dive). In brief: a PPO agent that, at each decision point (booking request arrival, periodic fleet review), observes the full fleet state plus forecasts plus bid prices, and chooses from the masked set of feasible actions — accept, reject, counter-offer type, bunker speed, empty repositioning — to maximize cumulative profit over the episode horizon.

### 2.8 Negotiation & Counter-Offer Layer

This is the **product differentiator** — the thing that makes Dock visibly different from "just dynamic pricing." Instead of a binary accept/reject, every decision is expressed as a **structured response** to the shipper:

| Response Type | Example | How It's Computed |
|:---|:---|:---|
| **Accept at quoted price** | "Confirmed: 40 TEU, Shanghai→Rotterdam, Voyage V-2847, $1,850/TEU" | Bid price check passes; stowage feasible. |
| **Flexible-window discount** | "−12% if you allow departure ±4 days" | Bid price is lower on adjacent voyages; discount = bid price difference. |
| **Alternate-hub discount** | "−8% to discharge at Antwerp instead of Rotterdam" | Downstream leg to Rotterdam is congested/premium; Antwerp has cheaper capacity. |
| **Split-consignment** | "60% on Voyage A (Monday), 40% on Voyage B (Thursday)" | Full volume doesn't fit Voyage A; partial fit passes stowage check on both. |
| **Overbooking with rollback option** | "Confirmed, but 5% chance of bump to next voyage with €200/TEU compensation" | Utilization > 90%; historical no-show rate justifies calculated overbooking. *(Designed, not built — P2.)* |
| **Volume/forward contract** | "Lock 200 TEU/month for 6 months at $1,700/TEU (vs. spot ~$1,900)" | Demand forecast shows stable route; locking revenue reduces variance. |
| **Reject with explanation** | "No capacity on this route this week. Next available: [date]. Suggested alt: [route]." | No feasible action passes constraint check; reason code logged. |

Every response ships with a **reason code** derived from the bid price and constraint solver — not reverse-engineered after the fact, not hallucinated by an LLM. The justification is a structured log: "Bid price for Leg X is \$Y due to standing contracts and forecast demand Z; your offer is below threshold; alternate-hub offer priced at bid-price differential." In the build, `BidPriceEngine.explain()` returns this as structured data — quote, bid floor, market rate, reason code (`bid_price_floor` / `market_uplift` / `competitiveness_guard`), and a per-leg breakdown (`remaining_teu`, `expected_teu`, `pressure`, `bid_price`) — which is exactly what the demo's "why" drawer renders.

**As measured:** the counter-offer layer fires proactively (a cheaper-bid alternative is offered before accepting at full price, and counters are ordered by what actually blocks the request — price blocker → discount counter, capacity blocker → split). Measured counter win rate: **19–27%** across seeds, vs. the 15–20% airline benchmark cited in Section 1 — with profit flat-to-up, since the EV gate only counters accepts that would likely have declined anyway. One honest caveat: `booked:split` stays near zero **by construction** — a split can't create capacity, and when a consignment doesn't fit whole, both halves fit only ~7% of the time; the mechanism is real and masked correctly, but it doesn't move volume.

### 2.9 Live API, Ledger & Settlement

> [!IMPORTANT]
> This layer was added during the build — it is how the demo actually runs. `api.md` is the full reference.

| Component | Implementation (as built) |
|:---|:---|
| **Live episode server** | FastAPI (`backend/server/`), served behind nginx at `/api` (single uvicorn worker). `POST /episodes` runs a real simulator instance day-by-day under any policy — including the trained PPO — on a server thread with pause/resume/stop/speed control. One live episode at a time (409 on conflict). An always-on live PPO episode runs from startup (90-day baseline horizon, restarted at end; pace `DOCK_LIVE_SPEED`, default 1 sim-day/min) — customer quotes (`POST /orders`) and live operator views are priced against it. |
| **Event stream** | Every sim event (`booking.decision`, `cargo.booked`, `departure.confirmed`, `delivery.confirmed`, `day.summary`, `settlement.*`, `episode.end`) is pushed to WebSocket subscribers at `WS /episodes/{id}/stream` (replay + live fanout) and appended to a ledger. |
| **Hash-chained ledger** | Each event carries `seq`, `prev_hash`, `hash` (Keccak-256) into `runs/ledger/<id>.jsonl` — a tamper-evident decision audit log (Section 4.5 made literal). Verifiable via `GET /episodes/{id}/ledger/verify` and `scripts/verify_ledger.py`. |
| **On-chain settlement** | Conditional deals (flex-window / alt-hub / split counters) become contracts on a **real in-process EVM** (py-evm via eth-tester): `DockSettlement.sol` deploys per episode — real contract address, real tx hashes. Terms: depart within board_day ±2d, deliver by board+45d, 1000bps late penalty — `settle()` is a pure function of oracle-recorded timings (`settled_full` / `settled_penalty` / `refunded`). |
| **Comparison artifacts** | `scripts/export_demo.py` writes the precomputed 5-policy export to `backend/demo/*.json`, served read-only via `GET /compare/*` — batch-produced, since generating it takes minutes. |
| **Frontends** | Two static sites, no build step. `customers/` — customer booking site (Meridian Line): booking intake (`customers/index.html`), live offer slip (`customers/shared/offers.js`; accept / flex-window / alt-hub / split counter-offers + PPO recommendation), and a fleet dashboard tracking orders through delivery. `drafts/cargo-ship/` — port-operator console: Vessel (3D ship, live stowage, Live bookings panel showing customer quotes/accepts/declines and their deal settlement), Stowage (side elevation + plan), Statistics (`/compare/*` 5-policy holdout comparison + shock replay), Model (live PPO network, per-decision observation/mask/probabilities/value). Both served by nginx at `:8080`. |
| **Customer orders** | Postgres 16 via Alembic migrations (0001–0003); customer submits a booking → `POST /orders` prices it live against the running simulation and returns counter-offers (never below the bid-price floor); customer accepts one offer or declines. Order status: QUOTED → CONFIRMED → LOADING → IN TRANSIT → AT PORT → DELIVERED (+ NO OFFER, DECLINED, EXPIRED). Accepted conditional counter-offers settle on-chain like simulated cargo. |

---

## 3. Reinforcement Learning — Deep Dive

### 3.1 Why RL and Not Supervised Learning

The accept/reject/price/reposition decision is **sequential**: today's decision changes what's optimal tomorrow.

- **Rejecting a mediocre booking today** might be the right call if a premium booking is likely next week — but a supervised model scores each booking independently and can never represent "hold capacity for later."
- **Repositioning empty containers** to Port X costs money now but enables revenue in two weeks — a supervised model sees only the cost, not the future payoff.
- **Slowing a vessel** saves fuel today but delays arrivals, changing which future bookings are feasible — this is a multi-step trade-off a single-step scorer can't capture.

RL is the **structurally correct** tool for this class of problem. It's not a buzzword addition — it's the only framework that optimizes a policy over a sequence of decisions with delayed consequences. Supervised learning is used where it belongs (forecasting, Section 2.4). RL is used where it belongs (sequential fleet decisions).

### 3.2 MDP Formulation

| Element | Definition |
|:---|:---|
| **State** $s_t$ | A flat 112-dim vector (`OBS_DIM=112`), as built: request block (14: TEU, weight, cargo-type & segment one-hots, flex, days-to-departure, market rate, option counts) + 4 voyage-option blocks (5 each: departure gap, capacity fill, within-flex, capacity-ok, leg bid/market) + market block (6: fuel price, ETS price, day/horizon, week, mean bid pressure, network value) + per-port (3×8: wait time, empties, closure flag) + per-vessel (6×4: speed, at-sea, stowage fill, onboard TEU, empties aboard, next-event gap) + **18 forecaster demand slots** (`BoundDemandForecaster.next_week()` — supervised forecast, never the simulator's ground-truth lam) + calendar sin/cos (4) + decision-type flags (2). |
| **Action** $a_t$ | A flat `Discrete(44)` action space (see Section 3.3): 12 booking actions + 16 speed + 16 repositioning, with infeasible actions masked per step. |
| **Reward** $r_t$ | Per-step profit delta − empty-mile penalty, plus potential-based bid-price shaping in curriculum phases ≥3 (see Section 3.5). |
| **Transition** $P(s_{t+1} \mid s_t, a_t)$ | Governed entirely by the simulator. The agent learns to act within the simulator's dynamics — it is never deployed against the real world during training. |
| **Discount** $\gamma$ | 0.99 (long horizon; we want the agent to value future revenue almost as much as immediate revenue). |
| **Episode** | One quarter (90 days) of fleet operations at full scale. Training starts short (1 vessel, 14 days) and extends via curriculum (Section 3.7). |

### 3.3 Action Space Design

The natural action space is mixed — a discrete choice of action type plus continuous parameters (discount percentage, split ratio). Pure continuous multi-dimensional RL is unreliable under hackathon time pressure. We use a **discretized tier** design, flattened into a single `Discrete(44)` space:

**Per-booking actions** (triggered on each booking request — actions 0–11):

| Action | Parameter Tiers |
|:---|:---|
| Reject (0) / Accept at quoted price (1) | — |
| Offer flexible-window discount (2–5) | {5%, 10%, 15%, 20%} |
| Offer alternate-hub discount (6–8) | {5%, 10%, 15%} |
| Offer split-consignment (9–11) | {50/50, 60/40, 70/30} |

**Periodic fleet actions** (triggered every `fleet_every` days — actions 12–43):

| Action | Parameter Tiers |
|:---|:---|
| Set bunker speed (12–27) | 4 vessels × {12, 14, 16, 18} kt |
| Reposition empties (28–43) | top-8 surplus→deficit port pairs × {75, 150} TEU |

Booking steps and fleet steps interleave; `action_masks()` gates each type so only the relevant subset is live at a given step. **44 actions total — small enough for PPO to handle reliably**, while preserving the full negotiation menu from Section 2.8.

> [!TIP]
> The discretization is a hackathon pragmatism, not a fundamental limitation. Post-hackathon, continuous action heads (e.g., via SAC) could replace the tier system for finer-grained pricing.

### 3.4 Action Masking for Safety

Before the PPO policy outputs action logits, the stowage constraint solver (Section 2.6) computes a **binary mask** $m_t \in \{0, 1\}^{|A|}$ where $m_t[a] = 0$ for any action $a$ that would violate a hard constraint (hazmat conflict, weight imbalance, exceeding capacity, impossible stacking order).

The policy network's output logits are modified:

$$\pi(a \mid s_t) = \text{softmax}(\text{logits}(s_t) + \log(m_t))$$

where $\log(0) = -\infty$ forces masked actions to zero probability. This is standard invalid-action masking (used in AlphaGo, StarCraft agents, etc.) and provides two critical benefits:

1. **Safety guarantee:** The agent physically cannot take an illegal action, regardless of what it has or hasn't learned.
2. **Training efficiency:** The agent never wastes gradient signal exploring infeasible actions — it only learns to discriminate among valid options.

As built: `CargoFleetEnv.action_masks()` computes the mask from stowage feasibility, capacity, flex windows, and alt-hub availability; `ActionMasker` + `MaskablePPO` (sb3-contrib) apply it at both training and inference.

### 3.5 Reward Design

Raw end-of-episode profit is sparse and delayed — hard to learn from over a 90-day horizon. As built (`env/fleet_env.py`), the reward is a **layered per-step signal**:

**Layer 1 — Immediate profit contribution:**

$$r^{\text{profit}}_t = \frac{\Delta \text{profit}_t}{10{,}000} = \frac{\Delta(\text{revenue} - \text{fuel} - \text{carbon} - \text{port fees} - \text{demurrage} - \text{reposition} - \text{lease} - \text{roll comp})_t}{10{,}000}$$

A dense per-step signal covering revenue from accepted bookings and every operating cost line.

**Layer 2 — Potential-based bid-price shaping** (enabled in curriculum phases ≥3):

$$r^{\text{shape}}_t = \alpha \cdot \frac{\gamma \cdot \Phi(s_{t+1}) - \Phi(s_t)}{10{,}000}, \qquad \alpha = 0.1,\ \text{clipped to } \pm 50$$

where $\Phi(s)$ is the bid-price engine's `network_value()` — total network value implied by current bid prices (sum of bid-price × remaining capacity across bookable legs). **Potential-based** shaping provably doesn't change the optimal policy (Ng et al., 1999) but densifies the accept-vs-hold signal. Terminal $\Phi = 0$, which puts a negative shaping term on final steps — watched for end-of-episode dumping; no pathology observed.

**Layer 3 — Penalty terms (as built):**

- Empty-mile penalty: $2 \times 10^{-6}$ per empty TEU-nm sailed per step (encourages repositioning optimization).
- The planned safety-margin and hard-reject penalties were **dropped**: safety is already enforced by the hard mask (nothing soft left to penalize), and a reject already costs its foregone revenue — an extra penalty turned out to be redundant pressure.

### 3.6 Training Pipeline

| Component | Choice (as built) | Rationale |
|:---|:---|:---|
| **Framework** | Stable-Baselines3 + `sb3-contrib`, torch 2.9.1+cu128 | Most mature, best-documented PPO implementation; Gymnasium-native. |
| **Algorithm** | `MaskablePPO` (`MlpPolicy`), lr 3e-4, n_steps 512, batch 256, γ 0.99, ent_coef 0.01 | PPO is the most training-stable on-policy algorithm for discrete action spaces; masking is native. |
| **Network** | `net_arch=[256, 256]` shared-trunk MLP → policy and value heads | Simple, proven architecture; no need for attention/transformers at this problem scale. |
| **Parallelization** | `SubprocVecEnv`, 8 parallel environments | Linear speedup in sample collection. |
| **Logging** | TensorBoard (per-run logs in `runs/<name>/`) | Reward curves, action distributions, value loss, episode lengths. |
| **Hardware** | Remote WSL2 box, RTX 3050 8GB, CUDA 12.8 — full curriculum ≈1.8M steps | Local Mac stays free; checkpoints (`runs/ppo_c1..c5`) committed. |
| **Baselines** | Always evaluated alongside on identical demand: (1) Static rate card, (2) Greedy/myopic, (3) Dynamic heuristic, (4) Heuristic + bid-price | The ablation ladder — each rung isolates what a layer contributes. The demo reports RL's lift over every rung. |

### 3.7 Curriculum Learning Strategy

Training the full problem from scratch is likely to fail — the state space is large, the episode is long, and the action space is combinatorial. **Curriculum learning** is the mitigation:

| Phase | Configuration (as run) | Timesteps |
|:---|:---|---:|
| **Phase 1 — Tiny** | 14-day horizon, VES4 only, booking actions only (no fleet actions), no shaping, train-scenario pool | 200k |
| **Phase 2 — Small** | 30-day horizon, VES3+VES4, fleet actions on, no shaping | 300k |
| **Phase 3 — +shaping** | Same as Phase 2 + potential-based bid-price shaping | 300k |
| **Phase 4 — Full scale** | 90-day horizon, all 4 vessels, full action set, shaping | 600k |
| **Phase 5 — Stress** | 90-day full + adversarial scenarios (`adversarial-canal-closure`, `adversarial-perfect-storm`) added to the pool | 400k |

Each phase warm-starts from the previous checkpoint (`--init-from`); `scripts/run_curriculum.sh` runs all five and auto-evaluates on the holdout. Env sanity (the original "Phase 0") is covered by the pytest suite instead of manual inspection. Checkpoints `runs/ppo_c1..c5` are committed with a `config.json` per run (phase, seed, pool, pricing, shaping, git SHA, obs semantics).

**Outcome:** one full curriculum run, no tuning — **PPO is the top policy on holdout aggregate ($17.97M mean, +164% vs static) and wins volatile-shocks outright ($25.9M, best of all five policies).**

> [!IMPORTANT]
> The RL agent **is** the decision engine — not a stretch goal and not optional. The curriculum exists to de-risk it: each phase has a hard exit criterion that surfaces failure early, and the action mask (Section 3.4) means the agent can never take an illegal action even before it converges. The baseline policies in Section 7 exist as an **ablation ladder** — they isolate what each layer of the system contributes — not as alternates.

### 3.8 Honest Assessment — Risks of RL Under Hackathon Constraints

| Dimension | Heuristic + bid-price (benchmark) | RL (PPO — the decision engine) |
|:---|:---|:---|
| **Captures long-horizon trade-offs** | No — each rule scores its decision independently | Yes — this is why we're using it |
| **Time to a working result** | Fast — no training | Slower — thousands of episodes |
| **Training stability** | Deterministic | Sensitive to reward scale, hyperparameters, simulator fidelity |
| **Explainability** | Easier (rule + bid-price attribution) | Harder — needs the bid-price reason-code pipeline (Section 4.5) |
| **Main failure mode** | Systematically undervalues "hold capacity for later" | Learns to exploit simulator quirks rather than real strategy |

**Risk controls — these exist so RL ships, not so we can ship without it:**

1. **Action masking** (Section 3.4): the agent only ever chooses among feasible, stowage-legal actions — a half-trained PPO is still a valid policy.
2. **Curriculum** (Section 3.7): failure surfaces at the smallest scale first — tiny → small → shaped → full → stress — instead of after a full-horizon run.
3. **Supervised inputs** (Section 2.4): the agent does not have to learn to predict demand; the trained forecaster feeds next-week per-route demand into both the state vector and the bid-price engine. RL learns sequencing on top of supervised forecasts — each method where it belongs.
4. **Fixed evaluation harness**: holdout scenarios only (`depressed-demand`, `volatile-shocks` — never trained on), identical simulator seeds across policies (a seed-pinning path in `CargoFleetEnv.reset` — without it, PPO was silently evaluated on different demand realizations than the baselines), mean ± std reported. The comparison against every rung of the ablation ladder is reported exactly as measured — if PPO underperforms the heuristic+bid-price benchmark, that result is shown honestly rather than hidden.

**Result (as measured, `runs/ppo_c5/eval_results.json`, 5 episodes × 90 days, holdout only):** volatile-shocks — **PPO $25.9M, best of all policies** (bid $24.7M / heuristic $23.2M / greedy $22.0M / static $17.0M); depressed-demand — heuristic $9.0M / PPO $8.3M / bid $8.5M / greedy $6.5M / static −$5.2M. PPO is −7.2% behind the heuristic on the collapsing-demand scenario — the forecaster lags a regime break — and that gap is shown honestly in the metrics panel rather than hidden.

---

## 4. Complete Feature Set

### 4.1 Pricing & Negotiation

| Feature | Description |
|:---|:---|
| **Network bid-price control** | Every quote reflects the opportunity cost of capacity across the whole fleet, not just the route being booked. |
| **Demand-elastic pricing** | Prices respond to real-time booking velocity — surge pricing when demand is high, discounts when demand is low. |
| **Flexible-window discount** | "−15% if you allow departure ±4 days." Discount = bid-price differential between the requested voyage and adjacent ones. |
| **Alternate-hub discount** | "−10% to discharge at Antwerp instead of Rotterdam." Discount = bid-price differential between the two downstream legs. |
| **Split-consignment** | Accept 60% of containers on Voyage A, 40% on Voyage B. Computed when full volume fails stowage check but partial fits. |
| **Overbooking with compensation** | Calculate optimal overbooking margin based on historical no-show/cancellation rates. Offer rolled bookings with compensation when bumped. Airlines do this routinely — shipping doesn't. |
| **Booking curve analysis** | Track how fast each voyage fills relative to departure date (analogous to airline booking curves). Price aggressively early, hold for premium late, fire-sale last 48–72 hours. |
| **Volume / forward contracts** | Large shippers lock a recurring rate for committed volume. Priced below spot but above marginal cost — reduces revenue variance for the carrier, guarantees capacity for the shipper. |
| **Last-minute spot auction** | Unsold capacity in the final 48–72 hours before departure — auctioned to capture any remaining value rather than sailing empty. |
| **Backhaul incentive pricing** | On imbalanced routes (e.g., Europe→Asia), aggressively discount the light direction to attract cargo that would otherwise be empty container-miles. The incentive is computed from the repositioning cost savings. |

### 4.2 Fleet Operations

| Feature | Description |
|:---|:---|
| **Empty-container repositioning** | Explicitly optimized as a fleet-level decision. Reposition empties from surplus ports to deficit ports, priced against the alternative (paying to ship them empty vs. waiting for backhaul cargo vs. selling/leasing excess equipment). |
| **Bunker speed control** | Speed is a continuous variable traded off against fuel cost, carbon cost (EU ETS), delivery deadline, and demand at destination. Slow-steam when demand at the next port is low; speed up when a premium booking has a tight deadline. |
| **Congestion-aware scheduling** | If a port is congested (long wait times), adjust arrival timing to avoid peak queues. Demurrage fees can exceed \$50K/day — even a few hours of smarter scheduling saves real money. |
| **Predictive maintenance integration** | Vessel reliability forecasts (Section 2.4) feed into effective capacity planning. Don't overbook a vessel that's likely to need dry-tideline. Reduce the risk of overbooking disruptions. |

### 4.3 Risk & Resilience

| Feature | Description |
|:---|:---|
| **Weather-aware routing** | Adjust route and ETA based on meteorological forecasts. Factor delay probability into pricing (higher price = includes delay-risk insurance). |
| **Port disruption contingency** | When a port goes offline (strike, disaster, closure), automatically reroute affected cargo to alternate hubs and reprice. The counter-offer engine generates structured proposals to affected shippers. |
| **Canal disruption modeling** | Suez/Panama closures modeled as stochastic events. When triggered, the system reroutes (e.g., Cape of Good Hope) and reprices the longer voyage factoring in extra fuel and time. |
| **Risk premium in pricing** | High-risk routes (piracy zones, sanctions-adjacent, storm-prone seasons) carry a calculated risk premium baked into the bid price, not an arbitrary surcharge. |
| **Post-congestion fees** | When a ship is delayed due to port congestion, downstream bookings that depend on that vessel are repriced to reflect the delay cost. |

### 4.4 Sustainability

| Feature | Description |
|:---|:---|
| **Carbon cost internalization** | EU ETS carbon cost (€65–95/tonne CO₂, scaling to 100% of emissions by 2026) is a line item in the profit objective. Slow-steaming is chosen when it's **profitable** (fuel + carbon savings > delay costs), not mandated by policy. |
| **Green-premium routing** | Offer shippers a carbon-optimized routing option at a premium. The premium is real — calculated from the actual cost differential of the low-emission route — not greenwashing. |
| **Emissions per TEU tracking** | Every booking tracks its CO₂ footprint (fuel consumption × emission factor ÷ TEUs carried). This becomes a competitive differentiator as EU/IMO regulations tighten. |
| **Empty-mile reduction as environmental KPI** | Every empty container-mile eliminated is a direct emissions reduction. This is tracked and displayed in the demo as an environmental metric. |

### 4.5 Explainability & Trust

| Feature | Description |
|:---|:---|
| **Reason-coded offers** | Every quote, discount, and rejection ships with a structured explanation derived from the bid price and constraint solver: "Bid price for Leg Shanghai→Rotterdam Week 12 is \$1,920/TEU (driven by 3 standing contracts consuming 60% of capacity + forecast demand of 850 TEU). Your offer of \$1,600/TEU is below threshold. Alternate-hub discount to Antwerp available at −8% (bid price \$1,770/TEU on the Antwerp leg)." |
| **Decision audit log** | As built: every event in every episode is hash-chained into a tamper-evident JSONL ledger (Keccak-256, `prev_hash`/`hash` links) — verify via `GET /episodes/{id}/ledger/verify` or `scripts/verify_ledger.py`. Conditional deals additionally settle on a real local EVM (Section 2.9), so the audit trail ends in on-chain transactions, not just logs. |
| **Manual-vs-AI dashboard** | The core demo visualization (Section 7) — the 5-policy ablation ladder (static → greedy → heuristic → heuristic_bid → ppo) on identical demand, with live metrics plus a precomputed shock replay. |
| **Value function visualization** | Show the RL agent's learned value function over time — "what does the agent think the fleet is worth right now?" — to make the hold-for-premium strategy visible. |

### 4.6 Feature Priority Tiers (Hackathon Scope)

> [!IMPORTANT]
> Not everything ships in the hackathon. This is the priority map.

| Tier | Features | Status |
|:---|:---|:---|
| **P0 — Must ship** | Simulator, bid-price pricing, accept/reject, flex-window discount, alt-hub discount, split-consignment, stowage constraints, demand forecasting, manual-vs-AI dashboard, reason-coded offers | ✅ **All shipped** |
| **P1 — Should ship** | RL agent (PPO), bunker speed control, empty repositioning, booking curve pricing, backhaul incentives, carbon cost internalization | ✅ **All shipped** — full 5-phase curriculum trained; booking-curve and backhaul behavior emerge via bid pressure rather than dedicated modules |
| **P2 — Nice to have** | Overbooking, volume contracts, spot auction, port disruption rerouting, weather routing, green-premium option, value function visualization | ⚠️ **Partial** — port disruptions exist as scenario events with repricing/counter-offers; overbooking/volume contracts/spot auction/green premium/value-function viz not built. *Also shipped beyond the P2 list:* live API, hash-chained ledger, on-chain settlement (§2.9) |
| **P3 — Future vision** | Predictive maintenance, buy/charter/sell decisions, personalized customer modeling (bandit/Bayesian), multi-carrier competition modeling, real AIS data integration | Not built — slides only |

---

## 5. Synthetic Data Strategy

The system trains entirely on synthetic data generated by the simulator. The quality and diversity of this data determines whether the models learn anything useful.

### Demand Generation

| Parameter | Range | Rationale |
|:---|:---|:---|
| **Base demand per route** | 90–1,100 TEU/week headhaul across 18 routes; baseline spot rates $340–2,150/TEU (anchored to Drewry WCI / SCFI) | Covers underutilized and saturated routes |
| **Seasonality** | Sinusoidal with period 12 weeks, amplitude ±30% | Captures peak/off-peak cycles |
| **Trend** | ±5% linear drift per quarter | Captures growing/declining trade lanes |
| **Shock events** | Poisson-distributed demand spikes/drops, 2–5× magnitude | Stress-tests adaptability |
| **Trade imbalance** | ~75/25 directional split (within the 60/40–80/20 band) | Core driver of empty-container dynamics |
| **Cargo mix** | 70% dry, 20% reefer, 10% hazmat | Drives constraint solver engagement |
| **Customer segments** | 40% flexible (±7d flex, 22d lead), 30% standard (±2d, 12d), 30% urgent (0d, 5d, premium); counter-acceptance priors 0.55/0.35/0.15 | Drives negotiation menu diversity |
| **Price sensitivity** | Elasticity {urgent 0.55, standard 1.1, flexible 1.8} — inside the 0.5–2.0 band; WTP multipliers {1.00, 1.08, 1.38} | Determines how demand responds to price changes |

### Data Diversity Requirements (as generated)

- **10 demand scenarios** with varied seasonality, imbalance, and shock frequency: `baseline`, `high-imbalance`, `volatile-shocks`, `seasonal-peak`, `depressed-demand`, `steady-growth`, `boom-market`, `port-strike-season`, `adversarial-canal-closure`, `adversarial-perfect-storm`.
- **Hold-out test set:** 2 of 10 scenarios (20%, seeded split — `depressed-demand` + `volatile-shocks`) are never seen during training — used only for the Section 7 evaluation.
- **Adversarial scenarios:** worst-cases included (`adversarial-canal-closure`, `adversarial-perfect-storm`) — added to the RL training pool only in curriculum phase 5.
- **No single synthetic distribution:** scenario is randomized per episode during RL training (holdout pool excluded).
- **Scale:** `data.generate` produces **831,510 bookings** plus 9 supporting panels (route-week demand, price-volume panel with true elasticity, congestion/weather/telemetry) at scale 1.0 in ~2.6s; parameters anchored to public data — `backend/data/CALIBRATION.md`.

---

## 6. How This Benefits — Triple Impact

> [!NOTE]
> All three impact cases fall directly out of the core mechanism. None of them require a feature bolted on for the pitch. This is what makes the project credible — the environmental and social benefits are **consequences of the economic optimization**, not separate modules.

### 6.1 Economic Impact

#### Direct revenue lift — the headline number

Airline revenue management generates **3–9% additional revenue** (documented across four decades of industry data, from American Airlines' original deployment to modern implementations). Applied to a \$141B container shipping industry, this represents **\$4–13B in unlocked value** industry-wide.

In the Dock demo, we target showing a **5–12% revenue-per-TEU improvement** over static weekly pricing on identical simulated demand. This is conservative relative to the airline benchmark because shipping's current baseline is so unsophisticated that even basic dynamic pricing should produce outsized gains.

#### Capacity utilization increase

Every hard rejection that Dock converts into a counter-offer (flex window, alt hub, split) is **incremental revenue from the same physical fleet**. No new ships needed. In the simulation, we target showing a **4–8 percentage point utilization increase** (e.g., from 78% to 84%), which represents significant capital efficiency given that a single container vessel costs \$100–200M.

#### Empty-container cost reduction

Empty repositioning costs the industry **\$15–20B/year**. Dock's explicit repositioning optimization and backhaul incentive pricing target a **10–20% reduction** in empty container-miles sailed. At scale, that's **\$1.5–4B in annual savings** — money currently spent moving air across oceans.

#### Better capital allocation

When you know actual demand (not a rate card), you know which routes need more capacity and which have excess. This feeds smarter fleet deployment, reducing the need for spot-chartering expensive vessels during demand spikes and avoiding excess capacity during troughs.

#### Network effect compounds

Because Dock prices across the **whole network** (not route-by-route), it captures cross-route synergies that route-level pricing misses entirely. A booking that's marginal on Route A might be highly valuable because the container it brings enables a profitable backhaul on Route B. This network optimization effect doesn't exist in the current industry.

### 6.2 Environmental Impact

#### Fewer empty miles = fewer emissions, period

Shipping accounts for **~3% of global GHG emissions** — roughly equivalent to Germany's entire carbon footprint. One in three containers on the water is empty. Every empty container-mile eliminated is a **direct, measurable reduction in CO₂ emissions** that carries zero cargo value today. If Dock reduces empty-miles by 10–20%, that's a proportional reduction in the ~1% of global emissions that empty container shipping represents.

#### Carbon-aware speed optimization

Bunker speed control with EU ETS cost internalized means the optimizer **is paid to slow down** when it's efficient to do so. Slow-steaming from 18 knots to 14 knots can reduce fuel consumption by **30–50%** on a voyage. Under Dock, this happens automatically when demand at the destination is low enough that the delay cost is less than the fuel + carbon savings. The environmental benefit is a **built-in consequence of profit optimization**, not a separate green initiative.

**Concrete EU ETS numbers:** At €75/tonne CO₂ and 100% phase-in (2026), a large container ship emitting ~100 tonnes CO₂/day faces a carbon cost of ~€7,500/day. Slow-steaming that cuts emissions by 40% saves ~€3,000/day in carbon costs alone, on top of fuel savings. Dock makes this trade-off automatically.

#### Higher utilization = fewer ships needed

If the same cargo volume moves on fewer, more fully loaded voyages, the fleet required to service global trade is smaller. Fewer ships sailing = fewer total emissions. A 5% utilization increase across the global fleet is equivalent to **removing hundreds of vessels** from the water.

#### Green-premium routing creates real market signals

Offering shippers a carbon-optimized routing choice at a calculated premium doesn't just reduce emissions for those shipments — it creates **price discovery for green logistics.** As EU/IMO regulations tighten toward 2050 net-zero targets, this kind of pricing infrastructure is a prerequisite.

### 6.3 Social Impact

#### Trade access for smaller shippers

The current system disproportionately disadvantages small and medium shippers, especially in developing economies. Large shippers negotiate volume discounts through relationships; small shippers get the rate card or nothing. Dock's **algorithmic counter-offers** — flex-window discounts, alternate-hub options, split-consignment — give smaller shippers access to capacity that a binary accept/reject would deny them. A small exporter in Vietnam who can't fill a full container this week but can split across two voyages now has an option that didn't exist before.

#### Price transparency replaces opaque negotiation

Reason-coded offers (Section 4.5) replace opaque, relationship-driven negotiation with a **consistent, explainable basis for every quote.** The same logic applies to a Fortune 500 shipper and a small exporter. This is particularly impactful in regions where information asymmetry and insider access have historically determined who gets capacity and at what price.

#### Supply chain resilience protects consumers

Container shipping disruptions don't just affect shippers — they ripple through to consumer prices and product availability. The 2021 Suez Canal blockage cost an estimated \$9.6B/day in delayed goods. The Red Sea crisis of 2024 rerouted vessels, adding weeks to transit times and spiking freight rates. Dock's **risk-aware rerouting and repricing** (Section 4.3) reduces the severity and duration of these disruptions by automatically adapting, rather than waiting for manual intervention while goods pile up.

#### Regional trade balance improvement

The one-sided nature of global trade (export-heavy Asia, import-heavy North America/Europe) means some regions are chronically **underserved by available container capacity**. African and South American exporters often face container shortages because empties are repositioned to Asia rather than made available locally. Dock's **backhaul incentive pricing** and **repositioning optimization** directly address this by making it profitable to keep containers in underserved regions and pricing backhaul cargo attractively.

#### Port community employment stability

When ships reroute due to disruptions, port workers and logistics communities lose revenue. Dock's **congestion-aware scheduling** and **disruption contingency planning** help maintain more stable, predictable vessel traffic patterns, supporting the port-dependent communities (often in developing regions) that depend on consistent shipping volumes.

### 6.4 Pitch-Ready Summary Table

| Impact Pillar | One-Line Claim | Key Metric in Demo |
|:---|:---|:---|
| **💰 Economic** | 5–12% more revenue per TEU and 4–8pp higher fleet utilization from the same ships, demonstrated head-to-head against manual pricing in simulation. | Revenue/TEU, Utilization % |
| **🌍 Environmental** | 10–20% fewer empty container-miles and 30–50% fuel reduction through carbon-aware speed control — because the optimizer is paid to minimize waste, not told to. | Empty miles, CO₂/TEU, Fuel cost |
| **🤝 Social** | Algorithmic counter-offers give smaller shippers access to capacity that binary accept/reject denies them, with transparent, reason-coded pricing for every customer. | Bookings converted from reject → counter-offer, Shipper diversity |

**As measured** (`runs/ppo_c5/eval_results.json`, 5×90d holdout + demo export): PPO tops the aggregate at **$17.97M mean profit, +164% vs static**, wins volatile-shocks at $25.9M (+52% vs static), and lifts utilization from 0.20 to 0.50 on depressed-demand — far above the 4–8pp target. On baseline pre-RL, the bid-price layer alone measured +25% profit / +16.8% revenue/TEU vs static. Counter win rate measured 19–27% (benchmark: 15–20%). One honest miss: split-consignment converts ~zero by construction (§2.8), and PPO trails the heuristic by 7.2% on depressed-demand — reported as measured, not tuned away.

---

## 7. Demo & Evaluation Plan

### The Core Demo: Head-to-Head Simulation

Five policies run through the **identical simulator**, on the **identical demand scenarios**, over the same fleet and time horizon — an apples-to-apples comparison forming the ablation ladder:

| Policy | Description |
|:---|:---|
| **Baseline (`static`)** | Weekly rate card, binary accept/reject, fixed bunker speed, no repositioning optimization. How the industry works today. |
| **Greedy (`greedy`)** | Myopic market-rate accept — takes anything feasible at market. What accepting-everything achieves. |
| **Dynamic heuristic (`heuristic`)** | Rule-based accept/reject + structured counter-offers, priced by the fill-surge dynamic engine. What rules alone achieve. |
| **Heuristic + bid-price (`heuristic_bid`)** | Same rules, priced by the opportunity-cost engine on top of the trained demand forecaster. Isolates the pricing layer's contribution. |
| **Dock (`ppo`)** | Full system — MaskablePPO agent with masked actions, forecaster-driven state, bid-price control, counter-offers, speed control, repositioning. The decision engine. |

### Headline Metrics Dashboard

| Metric | What It Measures | Impact Pillar |
|:---|:---|:---|
| **Revenue per TEU** | Price realization | 💰 Economic |
| **Total fleet revenue** | Absolute revenue | 💰 Economic |
| **Capacity utilization %** | How full ships sail | 💰 Economic |
| **Bookings converted (reject → counter-offer)** | Value rescued from rejections | 💰 + 🤝 |
| **Empty container-miles** | Waste in the system | 🌍 Environmental |
| **CO₂ per TEU transported** | Emissions intensity | 🌍 Environmental |
| **Fuel cost** | Operating efficiency | 💰 + 🌍 |
| **Shipper segment diversity** | Who gets access to capacity | 🤝 Social |
| **Profit retained under shock** | Resilience | 💰 + 🤝 |

### The "Wow" Moment

**Shock replay (precomputed A/B, as built):** the Fleet screen scrubs through a forced disruption — NLRTM port closure (days 42–63) plus a 2× demand spike — on a fixed seed of a held-out scenario. Two runs of the identical shocked world are shown side by side:

1. The **static baseline** continues on its fixed schedule, sailing into the disruption, accumulating demurrage fees, and rejecting rerouted bookings.
2. **Dock (PPO)** reprices capacity on alternate routes, generates structured counter-offers to affected shippers with reason codes, and protects profit — with the decision rationale visible on screen.

The replay is exported ahead of time as `shock.json`; scrubbing through it looks identical to live injection from the audience's seat and cannot fail on stage. A "run it live" button additionally races two real episodes (static vs. ppo on `volatile-shocks`) through the live API for a less deterministic but fully-live variant.

### The Shipped Demo Surfaces

- **Customer booking site (`customers/`).** Booking intake page (canonical two-column deck at `customers/index.html`; four alternative intake designs `intake-a`..`intake-d`). Submitting a booking hits `POST /orders`, which prices it live against the running simulation and returns the offer slip — accept / flex-window / alt-hub / split counter-offers plus the PPO policy's recommendation. The fleet dashboard (`customers/dashboard/`) tracks every order from QUOTED through DELIVERED.
- **Port-operator console (`drafts/cargo-ship/`).** Four views: Vessel — 3D ship with live stowage of a chosen vessel, live profit, and a Live bookings panel showing customer quotes, accepts and declines, and the settlement steps of their deals; Stowage — side elevation + plan view pulled from `/live/vessels/{id}/stowage`; Statistics — 5-policy holdout comparison from `/compare/*` plus shock replay and live-world stats; Model ("inside the helm") — the live MaskablePPO network, per-decision observation/mask/probabilities/value/attributions from `/live/policy` and `/live/policy/network`.

### Evaluation Integrity

- **Hold-out scenarios:** 20% of demand scenarios (`depressed-demand`, `volatile-shocks`) are never seen during training. Evaluation runs on these.
- **Identical seeds across policies:** `ep_seed = seed·1000 + ep·101` pins the exact demand realization per episode so policies see the same world — a fairness bug here (PPO previously re-seeded through the env RNG) was found and fixed before the training run.
- **Statistical reporting:** mean ± std over episodes × holdout scenarios — latest run 5 episodes × 90 days. Reported as measured, not cherry-picked.
- **Honest reporting:** RL's lift over every rung of the ablation ladder is reported exactly as measured — including the depressed-demand scenario where PPO trails the heuristic by 7.2%.

---

---

> **Last updated:** v2.4 — Frontend reconciliation: the Next.js dashboard was retired for two static sites (customer booking site + port-operator console) served by nginx with the API same-origin; customer bookings are priced live against an always-on simulation and stored in Postgres; comparison artifacts moved to `backend/demo/`. §2.2, §2.9 and §7 updated.
>
> v2.3 — As-built reconciliation: all P0/P1 features shipped. §2 reflects the built system (8 ports / 4 vessels / 18 routes, 3 supervised models with measured recovery, isoelastic bid-price engine, trial-place stowage); new §2.9 covers the live API, hash-chained ledger, and on-chain settlement layer added during the build. §3 updated to the shipped RL stack (Discrete(44), OBS_DIM=112, actual reward, MaskablePPO hyperparameters, the 5-phase curriculum as run, and measured holdout results). §5 records the actual generated dataset (10 scenarios, 831k bookings). §7 reflects five policies, the shipped demo surfaces, and the precomputed + live hybrid. Process sections (build plan, risks, open decisions) removed now that the build is complete; history is in git.
>
> v2.2 — Removed the graduated-fallback framing throughout: RL is the committed decision engine, baselines are the ablation ladder, and the demo replays precomputed artifacts rather than running a live API. §7 policy table now reflects the actual comparison set (static / dynamic heuristic / heuristic+bid-price / PPO).
>
> v2.1 — Locked frontend decision (Next.js dashboard in `src/`); aligned the open-decisions tier-granularity default with §3.3's per-action-type tiers.
>
> v2.0 — Rebuilt with corrected feasibility, grounded impact numbers, realistic hackathon scope tiers, curriculum-based RL training strategy, and graduated fallback plan.
