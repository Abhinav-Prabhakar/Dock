"""Static demo-artifact exporter for the /compare dashboard (plan.md §7,
technical.md §4.1).

Runs every policy on the HOLDOUT demand scenarios with identical simulator
seeds across policies — the same seed-pinning scheme as rl/evaluate.py
(``ep_seed = seed*1000 + ep*101``) so every policy faces the same demand
realization — and writes pre-aggregated, pre-rounded JSON artifacts to
``--out`` (default ``../public/demo/``):

    summary.json    per-policy mean +/- std of the plan.md §7 headline
                    metrics, per-segment booked counts ("shipper
                    diversity"), and the precomputed lift vs `static` —
                    the frontend must not recompute anything
    timeline.json   per-policy per-day series — cumulative revenue/profit,
                    utilization, TEU booked, empty TEU-nm, mean bid
                    pressure — averaged across episodes x scenarios;
                    drives the racing-lines chart
    offers.json     ~40 reason-coded decision records sampled across
                    outcome kinds from one heuristic_bid episode (or ppo
                    when --model is given); each record carries the full
                    BidPriceEngine.explain() per-leg breakdown — the
                    plan.md §4.5 explainability deliverable
    shock.json      the technical.md §4.3 precomputed A/B shock replay:
                    static vs the lead policy on an identical scenario
                    with a forced mid-horizon NLRTM closure + demand spike
    meta.json       provenance: git SHA, seed, timestamp, scenario/policy
                    lists, demand model artifact

No HTTP server (technical.md §4 Decision A): the Next.js app reads these
files statically.

Usage (from backend/):
    .venv/bin/python -m scripts.export_demo --out ../public/demo \
        --horizon 90 --episodes 5 --seed 42 [--model none] [--policies a,b,c]
"""

from __future__ import annotations

import argparse
import copy
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np

from baselines import (DynamicHeuristicPolicy, GreedyPolicy,
                       StaticRateCardPolicy)
from data.scenarios import build_scenarios
from simulator import SimConfig, Simulator
from simulator.types import DecisionKind
from simulator.world import DEFAULT_FORECASTER_DIR

BACKEND = Path(__file__).resolve().parent.parent
REPO = BACKEND.parent

# Trained supervised demand forecaster (models/demand.py
# DemandForecaster) consumed by the bid-price engine. The simulator
# auto-loads DEFAULT_FORECASTER_DIR when present and refuses to degrade
# to the oracle — every policy that touches the pricer (heuristic,
# heuristic_bid, ppo) raises RuntimeError without it, so a missing
# artifact is a hard error, never a silent fallback.
try:
    FORECASTER_REL = str(DEFAULT_FORECASTER_DIR.relative_to(BACKEND))
except ValueError:
    FORECASTER_REL = str(DEFAULT_FORECASTER_DIR)
FORECASTER_POLICIES = ("heuristic", "heuristic_bid", "ppo")

# plan.md §7 headline metrics aggregated into summary.json.
SUMMARY_METRICS = [
    "revenue_usd", "profit_usd", "revenue_per_teu", "utilization",
    "empty_teu_nm", "co2_per_teu", "fuel_tonnes", "counter_win_rate",
    "reject_to_counter_conv", "requests", "accepted", "teu_booked",
]

# per-day timeline fields and their rounding (dp)
TIMELINE_KEYS = {"cum_revenue": 0, "cum_profit": 0, "utilization": 4,
                 "teu_booked": 1, "empty_teu_nm": 0, "mean_bid_pressure": 3}

N_OFFERS = 40
# preferred outcome-kind ordering for the offers round-robin so every
# decision type appears before any kind is repeated
OFFER_KIND_ORDER = [
    "booked:accept", "booked:flex_window", "booked:alt_hub", "booked:split",
    "price_reject", "declined",
    "counter_declined:alt_hub", "counter_declined:flex_window",
    "counter_declined:split",
]

# technical.md §4.3: forced mid-horizon disruption on a fixed calendar
# (start_week=40 -> closure weeks 46-49 land on episode days 42-63).
SHOCK_START_WEEK = 40
SHOCK_PORT = "NLRTM"                    # served by VES1/VES4 loops
SHOCK_CLOSE_WK = (46, 49)
SHOCK_SPIKE_WK = (46, 52)
SHOCK_SPIKE_MULT = 2.0


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _json_default(o):
    """json.dumps fallback: coerce numpy scalars to python natives."""
    if isinstance(o, np.floating):
        return float(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(f"not JSON-serializable: {type(o)!r}")


def _write(out_dir: Path, name: str, obj) -> None:
    dst = out_dir / name
    dst.write_text(json.dumps(obj, indent=2, default=_json_default))
    print(f"  wrote {dst}")


def _demand_model_path() -> str | None:
    """Repo-relative path of the demand-forecaster artifact the simulator
    auto-loads (``models/artifacts/demand_forecaster``), or None."""
    if DEFAULT_FORECASTER_DIR.is_dir() and any(
            DEFAULT_FORECASTER_DIR.iterdir()):
        return FORECASTER_REL
    return None


def _git_sha() -> str | None:
    try:
        r = subprocess.run(["git", "rev-parse", "--short", "HEAD"],
                           cwd=REPO, capture_output=True, text=True,
                           timeout=10)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None


def _profit(m) -> float:
    """Cumulative profit from a MetricsTracker (mirrors report())."""
    return (m.revenue - m.fuel_cost - m.carbon_cost - m.port_fees
            - m.demurrage_cost - m.reposition_cost - m.lease_cost
            - m.roll_compensation)


def _daily_snap(sim) -> dict:
    """End-of-day timeline point (pre-rounded)."""
    m = sim.metrics
    return {
        "day": int(sim.day),
        "cum_revenue": round(m.revenue, 0),
        "cum_profit": round(_profit(m), 0),
        "utilization": round(m.teu_nm_carried / max(m.capacity_nm, 1.0), 4),
        "teu_booked": round(m.teu_booked, 1),
        "empty_teu_nm": round(m.empty_teu_nm, 0),
        "mean_bid_pressure": (round(sim.pricer.mean_pressure(), 3)
                              if sim.pricer is not None else None),
    }


# ---------------------------------------------------------------------------
# Episode runners — replicate Simulator.run()'s loop so we can snapshot
# per-day series and (optionally) instrument each booking decision.
# ---------------------------------------------------------------------------

def _chosen_opt(req, dec):
    """The VoyageOption a decision refers to; for REJECT/other outcomes the
    closest option (options are sorted by |board_day - req_dep_day|) so the
    feed always carries bid-price reasoning."""
    pool = req.alt_options if dec.kind is DecisionKind.ALT_HUB \
        else req.options
    if pool:
        return pool[min(dec.option_idx, len(pool) - 1)]
    if req.options:
        return req.options[0]
    if req.alt_options:
        return req.alt_options[0]
    return None


def _explain(sim, req, opt):
    if opt is None:
        return None
    eng = sim.pricer
    if eng is None:
        try:
            eng = sim.attach_pricer()     # offer feed always shows bid-price
        except Exception:                 # reasoning even under fallbacks
            return None
    return eng.explain(req, opt)


def _outcome_str(res: dict) -> str:
    """Normalized outcome kind for the offers feed, e.g. 'booked:alt_hub',
    'price_reject', 'rejected:no_voyage_option', 'counter_declined:split'."""
    out = res.get("outcome", "unknown")
    kind = res.get("kind") or res.get("reason")
    if out == "booked":
        return f"booked:{kind or 'accept'}"
    if out == "rejected":
        return f"rejected:{kind or 'policy'}"
    return f"{out}:{kind}" if kind else out


def _offer_record(req, dec, res: dict, day: float, explain) -> dict:
    price = res.get("price", res.get("quoted"))
    if price is None and explain:
        price = explain.get("quote_per_teu")
    return {
        "request_id": int(req.request_id),
        "day": int(day),
        "origin": req.origin,
        "dest": req.dest,
        "teu": int(req.teu),
        "segment": req.segment.value,
        "cargo_type": req.cargo_type.value,
        "req_dep_day": round(float(req.req_dep_day), 1),
        "flex_days": int(req.flex_days),
        "decision_kind": dec.kind.value,
        "option_idx": int(dec.option_idx),
        "discount_pct": round(float(dec.discount_pct), 4),
        "outcome": _outcome_str(res),
        "price": (round(float(price), 2) if price is not None else None),
        "explain": explain,
    }


def run_policy_episode(policy, scenario, seed: int, horizon: int,
                       start_week: int | None = None,
                       collect_offers: bool = False):
    """One episode under a heuristic policy — Simulator.run()'s loop
    replicated to snapshot the per-day series after each end_day().
    Returns (report, daily, offers)."""
    cfg = SimConfig(scenario=scenario, horizon_days=horizon, seed=seed,
                    start_week=start_week, pricing=policy.pricing_mode)
    sim = Simulator(cfg)
    sim.reset()
    daily, offers = [], []
    while not sim.done:
        for req in sim.begin_day():
            dec = policy.decide_booking(req, sim)
            ex = _explain(sim, req, _chosen_opt(req, dec)) \
                if collect_offers else None
            res = sim.apply_decision(req, dec)
            if collect_offers:
                offers.append(_offer_record(req, dec, res, sim.day, ex))
        if sim.config.fleet_actions \
                and int(sim.day) % sim.config.fleet_every == 0:
            for act in policy.decide_fleet(sim):
                sim.apply_fleet_action(act)
        sim.end_day()
        daily.append(_daily_snap(sim))
    return sim.metrics.report(), daily, offers


def run_ppo_episode(model, scenario, seed: int, horizon: int,
                    start_week: int | None = None,
                    collect_offers: bool = False):
    """One episode under the trained PPO — pins the sim seed/scenario via
    env.reset options exactly like rl/evaluate.py's run_ppo. The env steps
    per *decision*, not per day, so the day series is snapshotted after
    each step keyed on int(sim.day) (last write per day wins)."""
    from env import CargoFleetEnv           # lazy: only needed with --model

    cfg = SimConfig(scenario=scenario, horizon_days=horizon,
                    start_week=start_week, pricing="bid_price")
    env = CargoFleetEnv(cfg, scenario_pool=(
        [scenario] if isinstance(scenario, str) else None))
    obs, _ = env.reset(seed=seed,
                       options={"sim_seed": seed, "scenario": scenario})

    offers = []
    if collect_offers:
        orig_apply = env.sim.apply_decision

        def _recorded(req, dec, _orig=orig_apply, _sim=env.sim,
                      _out=offers):
            ex = _explain(_sim, req, _chosen_opt(req, dec))
            res = _orig(req, dec)
            _out.append(_offer_record(req, dec, res, _sim.day, ex))
            return res

        env.sim.apply_decision = _recorded

    snaps = {}
    while True:
        a, _ = model.predict(obs, action_masks=env.action_masks(),
                             deterministic=True)
        obs, _r, term, trunc, _ = env.step(int(a))
        snaps[int(env.sim.day)] = _daily_snap(env.sim)
        if term or trunc:
            break

    # align to the baseline convention: entries for day 1..horizon,
    # carrying the last snapshot forward over decision-free days (day-0
    # decisions seed `last`; a wholly empty prefix emits zeros)
    zero = {"cum_revenue": 0.0, "cum_profit": 0.0, "utilization": 0.0,
            "teu_booked": 0.0, "empty_teu_nm": 0.0, "mean_bid_pressure": None}
    daily, last = [], snaps.get(0)
    for d in range(1, horizon + 1):
        if d in snaps:
            last = snaps[d]
        daily.append({**zero, **(last or {}), "day": d})
    return env.sim.metrics.report(), daily, offers


# ---------------------------------------------------------------------------
# Aggregation / sampling
# ---------------------------------------------------------------------------

def _aggregate(reports: list[dict]) -> dict:
    agg = {}
    for k in SUMMARY_METRICS:
        vals = np.array([r[k] for r in reports], dtype=float)
        agg[k] = {"mean": round(float(vals.mean()), 2),
                  "std": round(float(vals.std()), 2)}
    segs: dict[str, dict[str, list]] = {}
    for r in reports:
        for s, v in r["segments"].items():
            b = segs.setdefault(s, {"requests": [], "booked": []})
            b["requests"].append(v["requests"])
            b["booked"].append(v["booked"])
    agg["segments"] = {
        s: {"requests": round(float(np.mean(v["requests"])), 1),
            "booked": round(float(np.mean(v["booked"])), 1)}
        for s, v in sorted(segs.items())}
    return agg


def _lift_vs_static(agg: dict, base: dict) -> dict:
    def pct(key):
        b = base[key]["mean"]
        if b is None or b <= 0:          # no meaningful % vs a non-positive
            return None                  # baseline -> null, never a lie
        return round((agg[key]["mean"] / b - 1.0) * 100.0, 1)

    return {
        "profit_usd_pct": pct("profit_usd"),
        "revenue_per_teu_pct": pct("revenue_per_teu"),
        "utilization_pp": round(
            (agg["utilization"]["mean"] - base["utilization"]["mean"])
            * 100.0, 2),
    }


def _mean_series(series_list: list[list[dict]]) -> list[dict]:
    """Elementwise mean of equal-length daily series across reps."""
    n = min(len(s) for s in series_list)
    out = []
    for i in range(n):
        row = {"day": int(series_list[0][i]["day"])}
        for k, dp in TIMELINE_KEYS.items():
            vals = [s[i][k] for s in series_list if s[i][k] is not None]
            row[k] = round(float(np.mean(vals)), dp) if vals else None
        out.append(row)
    return out


def _sample_offers(records: list[dict], n: int = N_OFFERS) -> list[dict]:
    """Deliberate sample: bucket by outcome kind and round-robin so every
    decision type (accepts, each counter kind, price rejects, capacity
    rejects) appears before any kind repeats."""
    buckets: dict[str, list[dict]] = {}
    for r in records:
        buckets.setdefault(r["outcome"], []).append(r)
    order = [k for k in OFFER_KIND_ORDER if k in buckets]
    order += sorted(k for k in buckets if k not in OFFER_KIND_ORDER)
    picked, i = [], 0
    while len(picked) < n and any(buckets[k] for k in order):
        k = order[i % len(order)]
        if buckets[k]:
            picked.append(buckets[k].pop(0))
        i += 1
    picked.sort(key=lambda r: (r["day"], r["request_id"]))
    return picked


# ---------------------------------------------------------------------------
# Shock replay (technical.md §4.3)
# ---------------------------------------------------------------------------

def _shock_scenario(configs: dict, first_scen: str) -> dict:
    """Copy of the first holdout scenario config plus a forced mid-horizon
    disruption: NLRTM closure weeks 46-49 + a 2x demand spike weeks 46-52.
    With start_week=40 pinned that is episode days ~42-63 of a 90d run."""
    cfg = copy.deepcopy(configs[first_scen])
    cfg["port_closures"] = list(cfg.get("port_closures") or []) + [
        (SHOCK_PORT, *SHOCK_CLOSE_WK)]
    cfg["demand_spike_events"] = list(
        cfg.get("demand_spike_events") or []) + [
        (*SHOCK_SPIKE_WK, SHOCK_SPIKE_MULT, None)]
    cfg["description"] = (
        f"SHOCK REPLAY on '{first_scen}': {SHOCK_PORT} port closure "
        f"weeks {SHOCK_CLOSE_WK[0]}-{SHOCK_CLOSE_WK[1]} + "
        f"{SHOCK_SPIKE_MULT}x demand spike weeks "
        f"{SHOCK_SPIKE_WK[0]}-{SHOCK_SPIKE_WK[1]} "
        f"(start_week={SHOCK_START_WEEK} pinned).")
    return cfg


def _run_shock(configs, first_scen, policies, model, lead, seed,
               horizon) -> dict:
    scen = _shock_scenario(configs, first_scen)
    shock_seed = seed * 1000              # episode-0 seed, identical runs
    runs = {}
    rep, daily, _ = run_policy_episode(policies["static"], scen,
                                       shock_seed, horizon,
                                       start_week=SHOCK_START_WEEK)
    runs["static"] = {"daily": daily, "summary": rep}
    if lead and lead != "static":
        if lead == "ppo":
            rep, daily, _ = run_ppo_episode(model, scen, shock_seed,
                                            horizon,
                                            start_week=SHOCK_START_WEEK)
        else:
            rep, daily, _ = run_policy_episode(policies[lead], scen,
                                               shock_seed, horizon,
                                               start_week=SHOCK_START_WEEK)
        runs[lead] = {"daily": daily, "summary": rep}
    return {
        "event": {
            "port": SHOCK_PORT,
            "day_lo": (SHOCK_CLOSE_WK[0] - SHOCK_START_WEEK) * 7,
            "day_hi": (SHOCK_CLOSE_WK[1] - SHOCK_START_WEEK) * 7,
            "description": (
                f"{SHOCK_PORT} port closure weeks "
                f"{SHOCK_CLOSE_WK[0]}-{SHOCK_CLOSE_WK[1]} (episode days "
                f"{(SHOCK_CLOSE_WK[0] - SHOCK_START_WEEK) * 7}-"
                f"{(SHOCK_CLOSE_WK[1] - SHOCK_START_WEEK) * 7}) plus a "
                f"{SHOCK_SPIKE_MULT}x all-lane demand spike weeks "
                f"{SHOCK_SPIKE_WK[0]}-{SHOCK_SPIKE_WK[1]}, injected into "
                f"holdout scenario '{first_scen}'."),
        },
        "runs": runs,
    }


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=str, default="../public/demo",
                    help="output directory for the JSON artifacts")
    ap.add_argument("--horizon", type=int, default=90)
    ap.add_argument("--episodes", type=int, default=5,
                    help="episodes per scenario x policy")
    ap.add_argument("--seed", type=int, default=42,
                    help="scenario-split + episode seed (match training)")
    ap.add_argument("--model", type=str, default="none",
                    help="path to model.zip, or 'none' for baselines only")
    ap.add_argument("--policies", type=str, default=None,
                    help="comma list; default = all baselines (+ppo with "
                         "--model)")
    ap.add_argument("--scenarios", type=str, default=None,
                    help="comma list; default = holdout scenarios")
    args = ap.parse_args()

    configs, _train, holdout = build_scenarios(args.seed)
    scenarios = ([s.strip() for s in args.scenarios.split(",") if s.strip()]
                 if args.scenarios else list(holdout))
    for s in scenarios:
        if s not in configs:
            ap.error(f"unknown scenario '{s}' (known: {sorted(configs)})")
    print(f"export scenarios: {scenarios}  (train pool untouched: {_train})")

    model = None
    if args.model != "none":
        from sb3_contrib import MaskablePPO      # lazy: only with --model
        model = MaskablePPO.load(args.model)
        print(f"loaded {args.model}")

    canonical = ["static", "greedy", "heuristic", "heuristic_bid"]
    if model is not None:
        canonical.append("ppo")
    if args.policies:
        wanted = [p.strip() for p in args.policies.split(",") if p.strip()]
        for p in wanted:
            if p == "ppo" and model is None:
                ap.error("policy 'ppo' requires --model")
            if p not in canonical:
                ap.error(f"unknown policy '{p}' (available: {canonical})")
        selected = [p for p in canonical if p in wanted]
    else:
        selected = list(canonical)

    demand_model = _demand_model_path()
    # ppo is also the shock/offers lead whenever --model is given, even if
    # it is not in --policies — gate it too (env.reset requires the
    # forecaster unconditionally)
    needs_forecaster = [p for p in selected if p in FORECASTER_POLICIES]
    if model is not None and "ppo" not in needs_forecaster:
        needs_forecaster.append("ppo")
    if needs_forecaster and demand_model is None:
        raise RuntimeError(
            f"policies {needs_forecaster} require the trained demand "
            f"forecaster at {FORECASTER_REL} — artifact absent (run "
            "`.venv/bin/python -m models.train --data data/generated "
            "--out models/artifacts` first)")

    heuristic_bid = DynamicHeuristicPolicy()
    heuristic_bid.pricing_mode = "bid_price"
    policies = {
        "static": StaticRateCardPolicy(),
        "greedy": GreedyPolicy(),
        "heuristic": DynamicHeuristicPolicy(),
        "heuristic_bid": heuristic_bid,
    }

    # lead policy drives offers.json and the shock A/B: ppo when a model is
    # given, else heuristic_bid, else the best available heuristic fallback
    lead = ("ppo" if model is not None else next(
        (p for p in ("heuristic_bid", "heuristic", "greedy")
         if p in selected), None))
    offers_source = lead

    # ---- run the matrix -------------------------------------------------
    t0 = time.time()
    reps = {p: {"reports": [], "daily": []} for p in selected}
    offer_records: list[dict] = []
    for scen in scenarios:
        for ep in range(args.episodes):
            ep_seed = args.seed * 1000 + ep * 101   # rl/evaluate.py scheme
            for name in selected:
                want_offers = (name == offers_source
                               and scen == scenarios[0] and ep == 0)
                if name == "ppo":
                    rep, daily, offs = run_ppo_episode(
                        model, scen, ep_seed, args.horizon,
                        collect_offers=want_offers)
                else:
                    rep, daily, offs = run_policy_episode(
                        policies[name], scen, ep_seed, args.horizon,
                        collect_offers=want_offers)
                reps[name]["reports"].append(rep)
                reps[name]["daily"].append(daily)
                if want_offers:
                    offer_records = offs
        print(f"  {scen}: {args.episodes} episodes x {len(selected)} "
              f"policies ({time.time() - t0:.0f}s)")

    # ---- artifacts ------------------------------------------------------
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    summary = {"policies": {}, "lift_vs_static": {}}
    for name in selected:
        summary["policies"][name] = _aggregate(reps[name]["reports"])
    if "static" in summary["policies"]:
        base = summary["policies"]["static"]
        for name in selected:
            if name != "static":
                summary["lift_vs_static"][name] = _lift_vs_static(
                    summary["policies"][name], base)

    timeline = {"policies": {name: _mean_series(reps[name]["daily"])
                             for name in selected}}

    offers = _sample_offers(offer_records, N_OFFERS)

    shock = _run_shock(configs, scenarios[0], policies, model, lead,
                       args.seed, args.horizon)

    meta = {
        "git_sha": _git_sha(),
        "generated_at": datetime.now(timezone.utc)
        .isoformat(timespec="seconds"),
        "seed": args.seed,
        "episodes": args.episodes,
        "horizon_days": args.horizon,
        "scenarios": scenarios,
        "policies_present": selected,
        "demand_model": demand_model,
        "notes": (
            "Artifact-driven demo export (technical.md §4.1, Decision A). "
            "Identical simulator seeds across policies: ep_seed = "
            "seed*1000 + ep*101 (same scheme as rl/evaluate.py). "
            "shock.json replays a forced NLRTM closure + 2x demand spike "
            "mid-horizon (technical.md §4.3). All numbers pre-rounded and "
            "pre-aggregated — the frontend must not recompute."),
    }

    _write(out_dir, "summary.json", summary)
    _write(out_dir, "timeline.json", timeline)
    _write(out_dir, "offers.json", offers)
    _write(out_dir, "shock.json", shock)
    _write(out_dir, "meta.json", meta)
    print(f"done ({time.time() - t0:.0f}s total) -> {out_dir}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as e:
        # e.g. heuristic_bid without the trained forecaster artifact —
        # surface it, never swallow it
        print(f"export_demo: {e}", file=sys.stderr)
        sys.exit(1)
