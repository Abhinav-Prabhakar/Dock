"""Context for one live booking decision, for the operator console's
decision-engine page — everything its original panels draw, computed from
the live simulator (read-only; called under the episode's sim lock, before
the policy's action is applied):

  option_views     every voyage option the request had: vessel, sailing and
                   arrival day, discharge port, per-leg ports / pressure /
                   remaining TEU / bid, total bid, feasibility (+ why not)
  pricing_curve    the bid-price engine's own objective for the option —
                   P(accept) under the engine's *segment* willingness-to-pay
                   model (calibration, not the customer's hidden draw) and
                   expected margin P·(p − bid) over a price grid
  counterfactuals  what the baseline policies (static rate card, greedy,
                   heuristic, heuristic + bid price) would do with the SAME
                   request in the SAME state: decision, $/TEU, and margin
                   over the network's opportunity cost
Nothing here mutates the world except a temporary, restored switch of
sim.config.pricing so each baseline prices the way it does in its own runs.
"""

from __future__ import annotations

import numpy as np

from pricing.bid_price import wtp_survival_seg
from simulator.types import DecisionKind


def _leg_ports(v, leg_idx: int) -> tuple[str | None, str | None]:
    calls = v.calls
    a = calls[leg_idx].port if 0 <= leg_idx < len(calls) else None
    b = calls[leg_idx + 1].port if 0 <= leg_idx + 1 < len(calls) else None
    return a, b


def _why_infeasible(sim, req, opt) -> str:
    v = sim.vessels[opt.vessel_id]
    if not v.has_capacity(opt.legs, req.teu, req.weight_t,
                          req.cargo_type.value == "reefer"):
        return "no capacity on leg"
    if req.cargo_type.value == "hazmat":
        return "hazmat bay cap"
    if req.cargo_type.value == "reefer":
        return "reefer plugs full"
    return "stowage infeasible"


def option_views(sim, req) -> list[dict]:
    pricer = getattr(sim, "pricer", None)
    out = []
    groups = [("requested", req.dest, req.options[:4])]
    if req.alt_options:
        groups.append(("alt_hub", req.alt_dest, req.alt_options[:2]))
    for kind, dest, opts in groups:
        for o in opts:
            v = sim.vessels[o.vessel_id]
            legs = []
            for li in o.legs:
                a, b = _leg_ports(v, li)
                lq = pricer.leg_quote(o.vessel_id, li) if pricer else None
                legs.append({
                    "leg": li, "from": a, "to": b,
                    "pressure": round(lq.pressure, 3) if lq else None,
                    "remaining_teu": round(lq.remaining_teu, 1) if lq else
                    round(v.leg_cap(li).teu, 1),
                    "bid_price": round(lq.bid_price, 2) if lq else None,
                })
            ok = sim.feasible(req, o)
            out.append({
                "kind": kind, "vessel_id": o.vessel_id, "dest": dest,
                "board_day": round(o.board_day, 2),
                "eta_day": round(o.discharge_day_est, 2),
                "within_flex": bool(o.within_flex),
                "bid": round(pricer.option_bid(o), 2) if pricer else None,
                "room_teu": round(min(v.leg_cap(li).teu for li in o.legs), 1)
                if o.legs else 0.0,
                "legs": legs, "feasible": bool(ok),
                "reason": None if ok else _why_infeasible(sim, req, o),
            })
    return out


def pricing_curve(req, bid: float, market: float, n: int = 64) -> list[list[float]]:
    """[[price $/TEU, P(accept), expected margin $/TEU], ...] — the curve the
    bid-price engine maximises (before its competitiveness guard)."""
    mkt = max(market, 1.0)
    out = []
    for r in np.linspace(0.4, 1.9, n):
        p = float(r * mkt)
        pa = float(wtp_survival_seg(req.segment.value, float(r)))
        out.append([round(p, 2), round(pa, 4), round(pa * (p - bid), 2)])
    return out


def _decision_price(sim, req, dec):
    """(option, $/TEU) a decision would quote under the sim's current
    pricing mode, or (None, None) for reject / no option."""
    k = dec.kind
    if k is DecisionKind.REJECT:
        return None, None
    opts = req.alt_options if k is DecisionKind.ALT_HUB else req.options
    if not opts:
        return None, None
    opt = opts[min(dec.option_idx, len(opts) - 1)]
    return opt, round(sim.quote(req, opt) * (1 - dec.discount_pct), 2)


_POLICIES = None


def _baselines():
    global _POLICIES
    if _POLICIES is None:
        from .episodes import _policy_table
        table = _policy_table()
        _POLICIES = [(key, table[key]["label"], table[key]["factory"](),
                      table[key]["pricing"])
                     for key in ("static", "greedy", "heuristic", "heuristic_bid")]
    return _POLICIES


def counterfactuals(sim, req) -> list[dict]:
    pricer = getattr(sim, "pricer", None)
    saved = sim.config.pricing
    out = []
    try:
        for key, label, policy, mode in _baselines():
            sim.config.pricing = mode
            try:
                dec = policy.decide_booking(req, sim)
                opt, price = _decision_price(sim, req, dec)
            except Exception:
                continue                  # a baseline that can't run here is omitted
            bid = pricer.option_bid(opt) if (pricer and opt is not None) else None
            out.append({
                "key": key, "label": label, "kind": dec.kind.value,
                "price": price,
                "margin_usd": (round((price - bid) * req.teu, 2)
                               if price is not None and bid is not None else 0.0),
            })
    finally:
        sim.config.pricing = saved
    return out
