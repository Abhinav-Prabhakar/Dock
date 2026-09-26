"""Customer quotes against the live simulation.

POST /orders turns a customer's request into a real BookingRequest inside
the live episode and prices it the way the engine prices simulated
shippers:

  * the offer menu is the policy's own booking action space, filtered by the
    same feasibility mask (env.fleet_env.booking_mask — capacity + stowage
    solver): accept / flex-window counter / alt-hub counter / split;
  * each offer is priced by the live bid-price engine (sim.quote);
  * the recommendation is what the PPO policy would do with this request
    (policy_view.evaluate on the request's own observation).

Accepting books the cargo on the chosen voyage at the quoted price (a quote
is a commitment). The customer's click replaces the simulator's hidden
willingness-to-pay draw — it is the only simulated step a real customer
changes. Everything downstream (stowage, departure, delivery, settlement
deal for counter-offers, ledger) is the same code path as simulated cargo.
"""

from __future__ import annotations

import time

from data import calibration as C
from env.fleet_env import booking_mask, decode_booking
from simulator.types import BookingRequest, CargoType, DecisionKind, Segment

from . import orders as store
from .stowage_view import vessel_name

QUOTE_TTL_S = 15 * 60      # wall-clock validity of a quote
KIND_ACTIONS = {           # booking action indices per offer kind
    "accept": (1,),
    "flex_window": (2, 3, 4, 5),
    "alt_hub": (6, 7, 8),
    "split": (9, 10, 11),
}


class QuoteError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


# ---------------------------------------------------------------------------
# Building + pricing
# ---------------------------------------------------------------------------

def _request(sim, order: dict) -> BookingRequest:
    """A BookingRequest in the live sim for this order (days-from-now ->
    absolute sim days)."""
    rid = sim.demand.next_request_id
    sim.demand.next_request_id += 1
    req = BookingRequest(
        request_id=rid, day=float(sim.day),
        origin=order["origin"], dest=order["dest"],
        teu=int(order["teu"]), weight_t=float(order["weight_t"]),
        cargo_type=CargoType(order["cargo_type"]),
        segment=Segment(order["segment"]),
        wtp_per_teu=float("inf"),          # a human decides, not a WTP draw
        market_rate=float(sim.demand.market_rate(
            (order["origin"], order["dest"]), sim.day)),
        req_dep_day=float(sim.day) + float(order["req_dep_day"]),
        flex_days=int(order["flex_days"]),
    )
    req.options = sim._options_for(req, req.dest)
    alt = C.ALT_HUB.get(req.dest)
    if alt:
        req.alt_dest = alt
        req.alt_options = sim._options_for(req, alt)
    req.customer_order = order["id"]
    sim.metrics.n_requests += 1
    sim.metrics.by_segment[req.segment.value]["requests"] += 1
    return req


def _parts(req, dec):
    """(option, teu, weight) pieces a decision books, and its discharge port."""
    k = dec.kind
    if k is DecisionKind.ALT_HUB:
        return [(req.alt_options[dec.option_idx], req.teu, req.weight_t)], req.alt_dest
    if k is DecisionKind.SPLIT:
        a, b = req.options[dec.option_idx], req.options[dec.second_idx]
        ta = max(1, int(round(req.teu * dec.split_frac)))
        wa = req.weight_t * ta / req.teu
        return [(a, ta, wa), (b, req.teu - ta, req.weight_t - wa)], req.dest
    return [(req.options[dec.option_idx], req.teu, req.weight_t)], req.dest


def _vessel_name(sim, vid: str) -> str:
    return vessel_name(vid)


def _price(sim, req, dec, action: int, prob, days_from: float) -> dict:
    parts, port = _parts(req, dec)
    opt0 = parts[0][0]
    base = sim.quote(req, opt0)
    price = round(base * (1 - dec.discount_pct), 2)
    pricing = None
    if getattr(sim, "pricer", None) is not None:
        q = sim.pricer.quote(req, opt0)
        pricing = {"bid_price": q.bid_price, "market_rate": q.market_rate,
                   "reason": q.reason, "list_price": round(base, 2)}
    legs = [{"vessel_id": o.vessel_id, "vessel": _vessel_name(sim, o.vessel_id),
             "teu": int(t), "board_day": round(o.board_day, 2),
             "eta_day": round(o.discharge_day_est, 2)} for o, t, _ in parts]
    rel = lambda d: max(0, round(d - days_from))  # noqa: E731
    k, pct = dec.kind.value, int(round(dec.discount_pct * 100))
    first = legs[0]
    if k == "accept":
        summary = (f"{first['vessel']} sails in {rel(first['board_day'])} days, "
                   f"inside your window — arrives in ~{rel(first['eta_day'])} days.")
    elif k == "flex_window":
        summary = (f"{pct}% off to sail in {rel(first['board_day'])} days on "
                   f"{first['vessel']}, just outside your window.")
    elif k == "alt_hub":
        summary = (f"{pct}% off to discharge at {port} instead of {req.dest} "
                   f"(sails in {rel(first['board_day'])} days).")
    else:
        a, b = legs
        summary = (f"Split: {a['teu']} TEU on {a['vessel']} in {rel(a['board_day'])} days, "
                   f"{b['teu']} TEU on {b['vessel']} in {rel(b['board_day'])} days.")
    return {
        "kind": k, "action": int(action),
        "price_per_teu": price, "total_usd": round(price * req.teu, 2),
        "discount_pct": dec.discount_pct, "discharge_port": port,
        "board_day": min(l["board_day"] for l in legs),
        "eta_day": max(l["eta_day"] for l in legs),
        "legs": legs, "summary": summary, "pricing": pricing,
        "prob": None if prob is None else round(float(prob), 4),
    }


def _policy_view(ep, req, mask):
    """What the live PPO policy makes of this request, or None when the live
    episode runs a non-learned policy."""
    model, env = ep._ctx.get("model"), ep._ctx.get("env")
    if model is None or env is None:
        return None
    from . import policy_view
    saved = (env._req, env._fleet_step)
    env._req, env._fleet_step = req, False
    try:
        obs = env._obs()
    finally:
        env._req, env._fleet_step = saved
    return policy_view.evaluate(model, obs, mask)


def quote(ep, order: dict) -> dict:
    """Price an order against the live episode; persist order + offers."""
    with ep.sim_lock:
        sim = ep.sim
        req = _request(sim, order)
        mask = booking_mask(sim, req)
        view = _policy_view(ep, req, mask)
        probs = view["probs"] if view else None
        offers = []
        for kind, acts in KIND_ACTIONS.items():
            legal = [a for a in acts if mask[a]]
            if not legal:
                continue
            # within a kind, the tier the policy rates highest (else mildest)
            a = max(legal, key=lambda i: probs[i]) if probs else legal[0]
            off = _price(sim, req, decode_booking(a, req), a,
                         probs[a] if probs else None, sim.day)
            # never sell below opportunity cost: a counter-offer discounted
            # under the bid-price floor is withheld, not offered
            if off["pricing"] and off["price_per_teu"] < off["pricing"]["bid_price"]:
                continue
            offers.append(off)
        if view is not None:
            best = view["action"]              # 0 = the policy would reject
        else:
            dec = ep._ctx["policy"].decide_booking(req, sim)
            best = next((o["action"] for o in offers
                         if o["kind"] == dec.kind.value), 0)
        for n, off in enumerate(offers, 1):
            off["id"] = f"{order['id']}-O{n}"
            off["recommended"] = off["action"] == best
        ep._reqs[req.request_id] = req
        ep.quotes[order["id"]] = {"req": req, "created": time.time(),
                                  "offers": {o["id"]: o for o in offers}}
        day = float(sim.day)

    rec_offer = next((o for o in offers if o["action"] == best), None)
    recommendation = {
        "action": best,
        "label": (rec_offer["summary"] if rec_offer else
                  "No sailing in this window clears the cost of the space — "
                  "try a wider or later departure window" if not offers else
                  "The model would hold this space for higher-value demand; "
                  "these offers are still above cost"),
        "prob": round(view["probs"][best], 4) if view else None,
        "value": view["value"] if view else None,
        "attribution": view["attribution"] if view else [],
    }
    store.insert_quoted(dict(order, episode_id=ep.id,
                             request_id=req.request_id), offers,
                        status="QUOTED" if offers else "NO OFFER")
    if not offers:
        # nothing viable: record it as a (customer) rejection so the operator
        # sees the demand the network turned away, and why
        with ep.sim_lock:
            ep.sim.metrics.n_rejected += 1
            ep.sim.metrics.outcomes["rejected:no_viable_offer"] += 1
            ep.sim.emit("booking.decision", request_id=req.request_id,
                        decision="reject", kind=None, outcome="rejected",
                        reason="no_viable_offer", price=None, quoted=None,
                        teu=req.teu, weight_t=round(req.weight_t, 1),
                        origin=req.origin, dest=req.dest,
                        segment=req.segment.value,
                        cargo_type=req.cargo_type.value,
                        market_rate=round(req.market_rate, 2),
                        req_dep_day=req.req_dep_day, flex_days=req.flex_days,
                        n_options=len(req.options), vessel_id="",
                        source="customer", order_id=order["id"])
            ep.quotes.pop(order["id"], None)
    ep.emit("order.quoted", order_id=order["id"], request_id=req.request_id,
            origin=req.origin, dest=req.dest, teu=req.teu,
            segment=req.segment.value, cargo_type=req.cargo_type.value,
            offers=[{k: o[k] for k in ("id", "kind", "price_per_teu",
                                       "recommended")} for o in offers],
            recommended_action=best, day=day)
    return {"order": store.get_order(order["id"], live_info(ep)),
            "offers": store.get_offers(order["id"]),
            "recommendation": recommendation}


# ---------------------------------------------------------------------------
# Customer response
# ---------------------------------------------------------------------------

def _open_quote(ep, order_id: str) -> dict:
    ctx = ep.quotes.get(order_id) if ep is not None else None
    if ctx is None:
        order = store.get_order(order_id)
        if order is None:
            raise QuoteError(404, f"order '{order_id}' not found")
        if order["status"] != "QUOTED":
            raise QuoteError(409, f"order is {order['status']}, not open for a decision")
        store.update_order(order_id, status="EXPIRED")
        store.set_offer_status(order_id, "expired")
        raise QuoteError(409, "quote expired — the live simulation restarted "
                              "since it was priced; please request a new quote")
    if time.time() - ctx["created"] > QUOTE_TTL_S:
        ep.quotes.pop(order_id, None)
        store.update_order(order_id, status="EXPIRED")
        store.set_offer_status(order_id, "expired")
        raise QuoteError(409, "quote expired — please request a new quote")
    return ctx


def accept(ep, order_id: str, offer_id: str) -> dict:
    ctx = _open_quote(ep, order_id)
    off = ctx["offers"].get(offer_id)
    if off is None:
        raise QuoteError(404, f"offer '{offer_id}' is not part of order {order_id}")
    req = ctx["req"]
    dec = decode_booking(off["action"], req)
    parts, port = _parts(req, dec)
    price = off["price_per_teu"]
    with ep.sim_lock:
        # ctx was read before the lock; re-check it's still the open quote
        # so two concurrent accepts (or an accept racing a decline) can't
        # both pass _open_quote and book/decline the same request twice.
        if ep.quotes.get(order_id) is not ctx:
            raise QuoteError(409, "order is no longer open for a decision")
        sim = ep.sim
        if sim.day > off["board_day"] - 0.25:
            raise QuoteError(409, "that sailing has already left — please request a new quote")
        if not all(sim.feasible(req, o, t, w) for o, t, w in parts):
            raise QuoteError(409, "that space has since been taken — please request a new quote")
        m = sim.metrics
        if dec.kind is DecisionKind.ACCEPT:
            m.n_accepted += 1
        else:
            m.n_countered += 1
            m.n_counter_won += 1
        m.outcomes[f"booked:{dec.kind.value}"] += 1
        # before _book: it emits settlement.deal_registered synchronously
        ep.customer_reqs[req.request_id] = order_id
        for o, t, w in parts:
            sim._book(req, o, price, t, w, dec.kind.value)
        sim.emit("booking.decision", request_id=req.request_id,
                 decision=dec.kind.value, kind=dec.kind.value,
                 outcome="booked", reason="customer_accepted", price=price,
                 quoted=price, teu=req.teu, weight_t=round(req.weight_t, 1),
                 origin=req.origin, dest=req.dest,
                 segment=req.segment.value, cargo_type=req.cargo_type.value,
                 market_rate=round(req.market_rate, 2),
                 req_dep_day=req.req_dep_day, flex_days=req.flex_days,
                 n_options=len(req.options),
                 vessel_id=parts[0][0].vessel_id,
                 source="customer", order_id=order_id)
        ep.quotes.pop(order_id, None)
    first = off["legs"][0]
    store.update_order(order_id, status="CONFIRMED", offer_id=offer_id,
                       price_usd=off["total_usd"], vessel=first["vessel"],
                       voyage=f"{first['vessel_id']}-{int(first['board_day'])}",
                       board_day=off["board_day"], eta_day=off["eta_day"],
                       discharge_port=port)
    store.set_offer_status(order_id, "declined", only_id=offer_id)
    ep.emit("order.accepted", order_id=order_id, request_id=req.request_id,
            offer_id=offer_id, kind=off["kind"], price_per_teu=price,
            total_usd=off["total_usd"], vessel_id=first["vessel_id"])
    return {"order": store.get_order(order_id, live_info(ep)),
            "offers": store.get_offers(order_id)}


def decline(ep, order_id: str) -> dict:
    ctx = _open_quote(ep, order_id)
    req = ctx["req"]
    with ep.sim_lock:
        if ep.quotes.get(order_id) is not ctx:
            raise QuoteError(409, "order is no longer open for a decision")
        sim = ep.sim
        sim.metrics.n_rejected += 1
        sim.metrics.outcomes["declined:customer"] += 1
        sim.emit("booking.decision", request_id=req.request_id,
                 decision="customer_declined", kind=None,
                 outcome="declined", reason="customer_declined", price=None,
                 quoted=None, teu=req.teu, weight_t=round(req.weight_t, 1),
                 origin=req.origin, dest=req.dest,
                 segment=req.segment.value, cargo_type=req.cargo_type.value,
                 market_rate=round(req.market_rate, 2),
                 req_dep_day=req.req_dep_day, flex_days=req.flex_days,
                 n_options=len(req.options), vessel_id="",
                 source="customer", order_id=order_id)
        ep.quotes.pop(order_id, None)
    store.update_order(order_id, status="DECLINED")
    store.set_offer_status(order_id, "declined")
    ep.emit("order.declined", order_id=order_id, request_id=req.request_id)
    return {"order": store.get_order(order_id, live_info(ep)),
            "offers": store.get_offers(order_id)}


# ---------------------------------------------------------------------------
# Voyage progress -> order status (bus subscriber on the live episode)
# ---------------------------------------------------------------------------

def order_tracker(ep):
    """Sim-bus subscriber: moves customer orders along as their cargo sails,
    arrives and settles."""
    def on_event(ev: dict) -> None:
        oid = ep.customer_reqs.get(ev.get("request_id"))
        if oid is None:
            return
        t = ev.get("type")
        if t == "departure.confirmed":
            store.update_order(oid, status="IN TRANSIT")
        elif t == "delivery.confirmed":
            store.update_order(oid, status="DELIVERED", progress=1.0)
        elif t == "settlement.deal_registered":
            store.update_order(oid, deal_id=ev.get("deal_id"))
    return on_event


def live_info(ep) -> dict | None:
    return None if ep is None else {"id": ep.id, "day": float(ep.day)}
