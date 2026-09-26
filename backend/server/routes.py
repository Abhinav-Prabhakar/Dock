"""REST endpoints for the Dock live API."""

from __future__ import annotations

import functools
import json
from pathlib import Path

import pandas as pd
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from data import calibration as C

from .episodes import (BACKEND, REPO_ROOT, EpisodeConflict, EpisodeManager,
                       list_policies)
from . import orders as order_store
from . import quotes
from .stowage_view import stowage_view

GENERATED = BACKEND / "data" / "generated"
SCENARIO_DIR = GENERATED / "scenarios"
DEMO_DIR = BACKEND / "demo"
COMPARE_NAMES = {"summary", "timeline", "offers", "shock", "meta"}

router = APIRouter()


class EpisodeStart(BaseModel):
    policy: str
    scenario: str
    seed: int = 42
    horizon_days: int = 90
    speed_days_per_sec: float = 20.0


class EpisodeControl(BaseModel):
    action: str                      # pause|resume|stop|set_speed
    speed: float | None = None


def _mgr(request: Request) -> EpisodeManager:
    return request.app.state.episodes


def _episode_or_404(mgr: EpisodeManager, ep_id: str):
    ep = mgr.get(ep_id)
    if ep is None:
        raise HTTPException(404, f"episode '{ep_id}' not found")
    return ep


@router.get("/health")
def health():
    return {"ok": True}


@router.get("/policies")
def policies():
    return list_policies()


@router.get("/scenarios")
def scenarios():
    out = []
    for p in sorted(SCENARIO_DIR.glob("*.json")):
        try:
            rec = json.loads(p.read_text())
        except Exception:
            continue
        if "scenario_id" not in rec:   # skips manifest.json
            continue
        out.append(rec)
    return out


# Reference data is fixed for the life of the process (data/generated and the
# committed artifacts only change on a rebuild), so each file is parsed once.
@functools.cache
def _parquet_records(path: Path) -> list[dict]:
    return pd.read_parquet(path).to_dict("records")


@functools.cache
def _json_file(path: Path):
    return json.loads(path.read_text())


@router.get("/ports")
def ports():
    return _parquet_records(GENERATED / "ports.parquet")


@router.get("/vessels")
def vessels():
    return _parquet_records(GENERATED / "vessels.parquet")


@router.get("/routes")
def routes():
    return [{"origin": o, "dest": d, "base_teu_wk": b,
             "market_usd_per_teu": m, "lane": lane, "direction": direc}
            for (o, d, b, m, lane, direc) in C.ROUTES]


@router.get("/models/report")
def models_report():
    p = BACKEND / "models" / "artifacts" / "report.json"
    if not p.exists():
        raise HTTPException(404, "models/artifacts/report.json not found")
    return _json_file(p)


@router.post("/episodes", status_code=201)
def start_episode(body: EpisodeStart, request: Request):
    mgr = _mgr(request)
    try:
        ep = mgr.start(body.policy, body.scenario, body.seed,
                       body.horizon_days, body.speed_days_per_sec)
    except EpisodeConflict as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))
    return ep.descriptor()


@router.get("/episodes")
def list_episodes(request: Request):
    return [ep.descriptor() for ep in _mgr(request).list()]


@router.get("/episodes/{ep_id}")
def episode_snapshot(ep_id: str, request: Request):
    try:
        return _mgr(request).snapshot(ep_id)
    except KeyError:
        raise HTTPException(404, f"episode '{ep_id}' not found")


@router.post("/episodes/{ep_id}/control")
def episode_control(ep_id: str, body: EpisodeControl, request: Request):
    mgr = _mgr(request)
    try:
        ep = mgr.control(ep_id, body.action, body.speed)
    except KeyError:
        raise HTTPException(404, f"episode '{ep_id}' not found")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return ep.descriptor()


@router.get("/episodes/{ep_id}/events")
def episode_events(ep_id: str, request: Request,
                   after_seq: int = 0, limit: int = 500):
    ep = _episode_or_404(_mgr(request), ep_id)
    with ep._lock:
        evs = [e for e in ep.events if e.get("seq", 0) >= after_seq]
    evs = evs[:max(0, limit)]
    next_seq = evs[-1]["seq"] + 1 if evs else after_seq
    return {"events": evs, "next_seq": next_seq}


@router.get("/episodes/{ep_id}/ledger")
def episode_ledger(ep_id: str, request: Request,
                   after_seq: int = 0, limit: int = 500):
    """The episode's hash-chained ledger events (the canonical record;
    identical to /events but read back from the .jsonl file)."""
    ep = _episode_or_404(_mgr(request), ep_id)
    path = _mgr(request).ledger_dir / f"{ep.id}.jsonl"
    if not path.exists():
        raise HTTPException(404, "ledger file not found")
    lines = path.read_text().splitlines()
    recs = [json.loads(ln) for ln in lines if ln.strip()]
    recs = [r for r in recs if r.get("seq", 0) >= after_seq]
    recs = recs[:max(0, limit)]
    nxt = recs[-1]["seq"] + 1 if recs else after_seq
    return {"events": recs, "next_seq": nxt}


@router.get("/episodes/{ep_id}/ledger/verify")
def episode_ledger_verify(ep_id: str, request: Request):
    """Recompute the hash chain and check linkage — proves the ledger
    is untampered."""
    from ledger.store import Ledger
    ep = _episode_or_404(_mgr(request), ep_id)
    path = _mgr(request).ledger_dir / f"{ep.id}.jsonl"
    if not path.exists():
        raise HTTPException(404, "ledger file not found")
    return Ledger.verify(path)


@router.get("/episodes/{ep_id}/deals")
def episode_deals(ep_id: str, request: Request):
    ep = _episode_or_404(_mgr(request), ep_id)
    with ep._lock:
        return list(ep.deals.values())


@router.get("/episodes/{ep_id}/deals/{deal_id}")
def episode_deal(ep_id: str, deal_id: str, request: Request):
    ep = _episode_or_404(_mgr(request), ep_id)
    d = ep.deals.get(deal_id)
    if d is None:
        raise HTTPException(404, f"deal '{deal_id}' not found")
    return d


# ---------------------------------------------------------------------------
# Customer booking orders — shared store between the customer site
# (customers/) and the operator site (cargo-ship). No auth by design: one
# portal per customer company, one ledger on the operator side.
# ---------------------------------------------------------------------------

def _live(request: Request):
    return _mgr(request).live()


def _require_live(request: Request):
    mgr = _mgr(request)
    ep = mgr.live()
    if ep is None or ep.sim is None:
        raise HTTPException(503, mgr.live_error
                            or "the live simulation is starting — try again shortly")
    return ep


@router.get("/orders")
def list_orders(request: Request):
    return order_store.list_orders(quotes.live_info(_live(request)))


@router.get("/orders/{order_id}")
def get_order(order_id: str, request: Request):
    o = order_store.get_order(order_id, quotes.live_info(_live(request)))
    if o is None:
        raise HTTPException(404, f"order '{order_id}' not found")
    return {**o, "offers": order_store.get_offers(order_id)}


@router.post("/orders", status_code=201)
def create_order(body: order_store.OrderIn, request: Request):
    """Price a customer request against the live simulation: returns the
    order, its offer menu and the policy's recommendation."""
    try:
        order = order_store.validate(body)
    except ValueError as e:
        raise HTTPException(422, str(e))
    ep = _require_live(request)
    order["id"] = order_store.next_id()
    return quotes.quote(ep, order)


@router.post("/orders/{order_id}/accept")
def accept_offer(order_id: str, body: order_store.AcceptIn, request: Request):
    try:
        return quotes.accept(_live(request), order_id, body.offer_id)
    except quotes.QuoteError as e:
        raise HTTPException(e.status, e.detail)


@router.post("/orders/{order_id}/decline")
def decline_offers(order_id: str, request: Request):
    try:
        return quotes.decline(_live(request), order_id)
    except quotes.QuoteError as e:
        raise HTTPException(e.status, e.detail)


@router.delete("/orders", status_code=204)
def reset_orders():
    order_store.clear_orders()


# ---------------------------------------------------------------------------
# The live episode — what both sites show
# ---------------------------------------------------------------------------

@router.get("/live")
def live_snapshot(request: Request):
    ep = _require_live(request)
    with ep.sim_lock:
        snap = _mgr(request).snapshot(ep.id)
    return {**snap, "live": True, "speed_days_per_sec": ep.speed_days_per_sec,
            "n_events": len(ep.events), "last_seq": ep.events[-1]["seq"] if ep.events else 0,
            "sim_lock": ep.sim_lock.stats()}


@router.get("/live/events")
def live_events(request: Request, after_seq: int = 0, limit: int = 200,
                types: str | None = None):
    """Events after `after_seq` (poll with the returned next_seq). `types`
    filters by comma-separated type, e.g. booking.decision,order.accepted."""
    ep = _require_live(request)
    want = set(types.split(",")) if types else None
    out = [e for e in ep.events[:] if e["seq"] > after_seq
           and (want is None or e["type"] in want)]
    limit = max(1, min(limit, 1000))
    out = out[-limit:]
    nxt = ep.events[-1]["seq"] if ep.events else after_seq
    return {"episode_id": ep.id, "events": out, "next_seq": nxt}


@router.get("/live/policy")
def live_policy(request: Request, limit: int = 20):
    """Recent live decisions as the policy network saw them: obs, mask,
    probabilities, value, hidden activations, attributions, outcome."""
    ep = _require_live(request)
    trace = list(ep.trace)[-max(1, min(limit, 60)):]
    return {"episode_id": ep.id, "policy": ep.policy, "day": ep.day,
            "decisions": trace}


@router.get("/live/policy/network")
def live_policy_network(request: Request):
    ep = _require_live(request)
    model = ep._ctx.get("model")
    if model is None:
        raise HTTPException(404, f"live policy '{ep.policy}' is not a neural network")
    from .policy_view import network
    return network(model)


@router.get("/live/vessels/{vessel_id}/stowage")
def live_stowage(vessel_id: str, request: Request):
    ep = _require_live(request)
    with ep.sim_lock:
        v = ep.sim.vessels.get(vessel_id)
        if v is None:
            raise HTTPException(404, f"unknown vessel '{vessel_id}'")
        return stowage_view(ep.sim, v)


@router.get("/compare/{name}")
def compare(name: str):
    if name not in COMPARE_NAMES:
        raise HTTPException(404, f"unknown compare view '{name}' — "
                                 f"one of {sorted(COMPARE_NAMES)}")
    p = DEMO_DIR / f"{name}.json"
    if not p.exists():
        raise HTTPException(404, f"public/demo/{name}.json not found")
    return _json_file(p)
