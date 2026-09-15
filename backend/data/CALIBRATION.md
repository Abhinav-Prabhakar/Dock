# Dock Synthetic Data — Calibration & Methodology Notes

Everything below documents the real-world anchors baked into
`calibration.py` and the simplifications made in the generator modules. The
goal is a dataset that is *defensible*: every constant traces to either an
observable market statistic or an explicit, documented modeling choice.

## Market anchors

| Anchor | Value used | Source / rationale |
|---|---|---|
| Drewry WCI composite | ~$4,476/FEU (Sep 2026) | Headhaul route means of ~$1,550–2,150 **per TEU** ≈ $2,600–3,700/FEU-equivalent (1 FEU ≈ 1.7 TEU loaded) — inside the composite's neighbourhood |
| Shanghai→Rotterdam spot band | $1,500–4,500/FEU ≈ $880–2,650/TEU | `CNSHA→NLRTM` mean $1,780/TEU with weekly vol 5.5% mean-reverting walk reproduces that band; scenario price multipliers (0.72–1.45) extend it both ways |
| SCFI composite | ~3,400–3,500 (Aug 2026) | Same regime as WCI; rates are index-level consistent, not tick-matched |
| VLSFO bunker | $500–700/t base | `VLSFO_USD_PER_TONNE_BASE = 600`, weekly σ=3.5% walk clipped to $380–950 (covers 2021–22 spike range); adversarial scenarios force ×1.35–1.6 spikes |
| EU ETS carbon | €65–95/tCO₂ | `ETS_EUR_PER_TCO2_BASE = 80`, clipped €60–105 — the ETS phase-in band through 2026 |
| Fuel curve | t/day = a + b·v³ | Cubic in speed; calibrated so 18→14 kt saves ~35–50% (VES1: 161→85 t/day = 47%) — matches published slow-steaming figures |
| CO₂ factor | 3.15 tCO₂/t VLSFO | Industry-standard emission factor (3.114–3.206) |
| Demurrage/delay cost | ~$50K/day scale | `DEMURRAGE_USD_PER_DAY`, matches plan.md |
| Empty containers | ~1 in 3 industry-wide | Directional imbalance (below) is the causal driver; empty repositioning itself is a simulator concern, not a dataset column |
| Trade imbalance | ~77/23 Asia→Europe, ~77/23 transpacific headhaul/backhaul | Spec band 60/40–80/20; realized carried ratio ≈ 3.3× (sanity-checked) |
| Port congestion | Normal waits 2–12 h; crisis multi-day | Wait model `base·(occ/0.6)^2.5·event_mult` clipped at 200 h ≈ 8 days — LA/LB-2021-style tail events occur in strike/closure/adversarial scenarios (p99 ≈ 70 h) |

## Scenario diversity

10 named demand regimes (`scenarios/*.json`): baseline, high-imbalance,
volatile-shocks, seasonal-peak, depressed-demand, steady-growth, boom-market,
port-strike-season, plus two **adversarial** worst-cases
(`adversarial-canal-closure` — Suez-style 6-week closure with lane-specific
demand spikes and a fuel spike; `adversarial-perfect-storm` — simultaneous
LA/LB closure + transpacific demand spike ×3 + fuel spike ×1.6).

**Holdout split:** exactly 20% (2 of 10), chosen by a dedicated RNG derived
from `--seed`, recorded in `scenarios/manifest.json`. With `--seed 42` the
holdout is `{depressed-demand, volatile-shocks}`. Holdout rows must never
enter training sets.

## Modeling choices worth knowing

* **Time axis:** 2025-01-01 → 2026-12-31 (731 days, 104 weeks). The Sep-2026
  WCI anchor lands inside the window. Week index 0 = week of 2025-01-01.
* **Bookings are a *request* log**, not an accepted-bookings ledger. Every
  row is a shipper request; `outcome` ∈ {accepted, rejected, counter_offered}.
  `realized_price_per_teu` is set for accepted and *successful* counters;
  `counter_offer_type` is set only on `counter_offered` rows.
  `price_driven_no_book` marks requests lost on price (the elasticity
  signal).
* **Capacity** (`weekly_capacity`) = partner/alliance slot-charter baseline
  (~weekly service) **plus** our own vessels' bookable lift in weeks they
  actually sail the OD. Rationale: 4 vessels cannot offer weekly departures
  on 18 OD pairs — real carriers fill gaps by buying slots. `voyage_id` is
  set when a non-rejected booking lands within `max(flex_window, 3d)` of an
  own-vessel departure; empty string = partner lift.
* **Two-pass quote model:** the carrier's quote = market × segment product
  uplift × surge(running *accepted* fill) × lognormal noise. Requests that
  never convert do not sell capacity, so surge is driven by realized load —
  first pass discovers conversions, second pass reprices.
* **Elasticity is structural in two places:** (a) booking acceptance —
  P(customer accepts) falls as quote/WTP rises, producing more
  `price_driven_no_book` rows at high relative prices (verified: no-book
  rate 2%→65% across price deciles in the standard segment); (b) the
  `price_volume_panel` — randomized probes at {0.80,0.90,1.00,1.10,1.25}×
  market with `volume ∝ (p/p₀)^(−elasticity)`, elasticity ∈ {0.55 urgent,
  1.1 standard, 1.8 flexible} ⊂ spec band 0.5–2.0.
* **Reefer sub-capacity:** reefers additionally draw against a ~9%-of-
  capacity powered-slot pool, so reefer demand can reject independently of
  TEU capacity.
* **Congestion & weather are per-scenario** (scenario schedules drive
  strikes/closures); **telemetry & maintenance are one physical fleet**
  shared across scenarios — scenario effects on commercial outcomes live in
  the demand datasets.
* **`failure_within_30d` label:** 1 iff another *unscheduled* maintenance
  event occurs for the same vessel within 30 days after the row's date
  (degradation-cascade onset detection).
* **`week_index`/`market_rate_per_teu`/`baseline_volume_teu`/
  `elasticity_true`** are ground-truth helper columns kept for training
  joins and teacher-signal debugging; they are the generator's own latent
  state, not observed features.
* **Determinism:** all RNG streams spawn from `SeedSequence(seed)` in fixed
  order; identical `(seed, scale)` → identical output. No wall-clock or
  global state is consumed.
* **Scale parameter** multiplies booking request intensity only; physical
  capacity is unchanged, so at scale < 1 capacity binds less (accept rates
  rise slightly) — scale is a dataset-size knob, not a market knob.
