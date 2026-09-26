"""LLM chat assistants — a customer booking agent (customer dashboard) and a
port-operator copilot (operator console, stowage screen).

Both talk to one OpenAI-compatible chat-completions endpoint configured by
env (LLM_BASE_URL, LLM_API_KEY, LLM_MODEL — see .env.example). The key never
leaves this process: the browser posts its visible conversation to
/chat/{audience}, the server runs a bounded tool loop against the *same*
functions the REST routes use (so the agent can do exactly what the site can
do, no more), and returns the reply plus a list of what it did.

Guardrails that live in code, not only in the prompt:
  * Audience-scoped tool sets. The operator copilot is read-only; only the
    customer agent can quote/accept/decline.
  * A binding decision (accept_offer / decline_offers) is refused in the same
    turn the offers were first quoted — the customer always sees the offers
    and answers once before anything is booked.
  * Bounded cost: at most MAX_ROUNDS model calls per message, one retry on a
    transient error (honouring Retry-After), a trimmed history, and compact
    tool results. The upstream API is heavily rate-limited.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from typing import Callable

import httpx

from data import calibration as C

from . import orders as order_store
from . import quotes
from .stowage_view import stowage_view, vessel_name

MAX_ROUNDS = 6            # model calls per user message (tool rounds + answer)
MAX_HISTORY = 16          # most recent visible turns sent upstream
MAX_MSG_CHARS = 2000      # per user/assistant message from the browser
TIMEOUT_S = 60.0

PORT_NAMES = {row[0]: row[1] for row in C.PORTS}


class AssistantError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


# ---------------------------------------------------------------------------
# Upstream client
# ---------------------------------------------------------------------------

@dataclass
class LLMConfig:
    base_url: str
    api_key: str
    model: str

    @classmethod
    def from_env(cls) -> "LLMConfig":
        return cls(base_url=os.environ.get("LLM_BASE_URL", "https://api.voidai.app/v1").rstrip("/"),
                   api_key=os.environ.get("LLM_API_KEY", ""),
                   model=os.environ.get("LLM_MODEL", "gpt-5.6-luna"))

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)


def _retry_wait(r: httpx.Response) -> float:
    ra = r.headers.get("retry-after")
    return min(float(ra), 8.0) if ra and ra.replace(".", "", 1).isdigit() else 2.0


def _read_stream(r: httpx.Response, on_text: Callable[[str], None]) -> dict:
    """Assemble one streamed (SSE) chat-completions response into a message
    dict, forwarding content deltas as they arrive. Tool calls stream as
    indexed fragments (id/name once, arguments in pieces)."""
    content, calls = [], {}
    for line in r.iter_lines():
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            chunk = json.loads(data)
        except ValueError:
            continue
        if chunk.get("error"):
            raise AssistantError(502, "the language model failed mid-reply")
        for ch in chunk.get("choices") or []:
            d = ch.get("delta") or {}
            if d.get("content"):
                content.append(d["content"])
                on_text(d["content"])
            for tc in d.get("tool_calls") or []:
                slot = calls.setdefault(tc.get("index", 0), {"id": None, "type": "function",
                                                             "function": {"name": "", "arguments": ""}})
                slot["id"] = tc.get("id") or slot["id"]
                fn = tc.get("function") or {}
                slot["function"]["name"] += fn.get("name") or ""
                slot["function"]["arguments"] += fn.get("arguments") or ""
    msg = {"role": "assistant", "content": "".join(content) or None}
    if calls:
        msg["tool_calls"] = [calls[i] for i in sorted(calls)]
    return msg


def complete(cfg: LLMConfig, messages: list[dict], tools: list[dict],
             on_text: Callable[[str], None] | None = None) -> dict:
    """One chat-completions call -> the assistant message dict. With
    `on_text`, the call is streamed and content deltas are forwarded as they
    arrive (same request count). Retries once on 429/5xx/network errors that
    happen before any text streamed — the upstream is rate-limited, so it is
    never hammered."""
    body = {"model": cfg.model, "messages": messages}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    if on_text:
        body["stream"] = True
    headers = {"Authorization": f"Bearer {cfg.api_key}"}
    url = f"{cfg.base_url}/chat/completions"
    last = None
    for attempt in range(2):
        wait = 2.0
        try:
            if on_text:
                with httpx.stream("POST", url, json=body, timeout=TIMEOUT_S, headers=headers) as r:
                    if r.status_code == 200:
                        return _read_stream(r, on_text)
                    r.read()
                    code, wait = r.status_code, _retry_wait(r)
            else:
                r = httpx.post(url, json=body, timeout=TIMEOUT_S, headers=headers)
                if r.status_code == 200:
                    try:
                        return r.json()["choices"][0]["message"]
                    except (ValueError, KeyError, IndexError):
                        raise AssistantError(502, "the language model returned an unreadable response")
                code, wait = r.status_code, _retry_wait(r)
        except httpx.HTTPError as e:
            last = f"cannot reach the language model ({type(e).__name__})"
        else:
            last = f"the language model returned HTTP {code}"
            if code != 429 and code < 500:
                break                      # 4xx other than 429: retrying won't help
        if attempt == 0:
            time.sleep(wait)
    raise AssistantError(502, f"The assistant is unavailable right now — {last}.")


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@dataclass
class Tool:
    name: str
    description: str
    params: dict
    fn: Callable[..., object]
    binding: bool = False          # books / declines something for the customer

    def spec(self) -> dict:
        return {"type": "function", "function": {
            "name": self.name, "description": self.description,
            "parameters": {"type": "object", "properties": self.params,
                           "required": [k for k, v in self.params.items() if not v.get("optional")]
                           } if self.params else {"type": "object", "properties": {}}}}


def _clean(params: dict) -> dict:
    """Strip our 'optional' marker from JSON-schema property dicts."""
    return {k: {kk: vv for kk, vv in v.items() if kk != "optional"} for k, v in params.items()}


@dataclass
class Turn:
    """What the tools did during one user message (returned to the browser)."""
    actions: list[dict] = field(default_factory=list)
    quoted: set[str] = field(default_factory=set)       # order ids quoted this turn
    changed_orders: bool = False


def _r1(x):
    return None if x is None else round(float(x), 1)


def _order_brief(o: dict) -> dict:
    keep = ("id", "origin", "dest", "teu", "weight_t", "cargo_type", "segment", "status",
            "vessel", "voyage", "eta", "price_usd", "board_day", "eta_day", "discharge_port")
    b = {k: o.get(k) for k in keep if o.get(k) is not None}
    if o.get("progress"):
        b["progress_pct"] = round(100 * float(o["progress"]))
    return b


def _offer_brief(f: dict) -> dict:
    return {"offer_id": f["id"], "kind": f["kind"], "summary": f["summary"],
            "price_per_teu_usd": _r1(f["price_per_teu"]), "total_usd": _r1(f["total_usd"]),
            "discount_pct": _r1(f.get("discount_pct")), "discharge_port": f["discharge_port"],
            "board_in_days": _r1(f["board_day"]), "arrives_in_days": _r1(f["eta_day"]),
            "recommended": bool(f.get("recommended")), "status": f.get("status")}


def _customer_tools(mgr, turn: Turn) -> list[Tool]:
    def live():
        ep = mgr.live()
        if ep is None or ep.sim is None:
            raise AssistantError(503, mgr.live_error or "the live simulation is starting — try again shortly")
        return ep

    def network():
        return {"ports": [{"code": p, "name": n} for p, n in PORT_NAMES.items()],
                "servable_routes": sorted(f"{o}->{d}" for (o, d) in order_store.SERVABLE),
                "cargo_types": list(order_store.CARGO_TYPES), "segments": list(order_store.SEGMENTS)}

    def list_orders(status: str | None = None):
        rows = order_store.list_orders(quotes.live_info(mgr.live()))
        if status:
            rows = [o for o in rows if o["status"] == status.upper()]
        return {"count": len(rows), "orders": [_order_brief(o) for o in rows[:25]],
                "truncated": len(rows) > 25}

    def get_order(order_id: str):
        o = order_store.get_order(order_id, quotes.live_info(mgr.live()))
        if o is None:
            return {"error": f"order '{order_id}' not found"}
        return {"order": _order_brief(o), "offers": [_offer_brief(f) for f in order_store.get_offers(order_id)]}

    def request_quote(origin, dest, teu, weight_t, cargo_type, segment, departure_in_days, flex_days=3):
        body = order_store.OrderIn(origin=str(origin).upper(), dest=str(dest).upper(), teu=int(teu),
                                   weight_t=float(weight_t), cargo_type=str(cargo_type).lower(),
                                   segment=str(segment).lower(), req_dep_day=float(departure_in_days),
                                   flex_days=int(flex_days))
        try:
            order = order_store.validate(body)
        except ValueError as e:
            return {"error": str(e)}
        ep = live()
        order["id"] = order_store.next_id()
        res = quotes.quote(ep, order)
        turn.quoted.add(order["id"])
        turn.changed_orders = True
        o = res["order"]
        turn.actions.append({"kind": "quote", "order_id": o["id"],
                             "text": f"Quoted {o['id']} · {o['origin']}→{o['dest']} · {o['teu']} TEU · "
                                     f"{len(res['offers'])} offer{'s' if len(res['offers']) != 1 else ''}"})
        return {"order": _order_brief(o), "offers": [_offer_brief(f) for f in res["offers"]],
                "note": "Present these offers to the customer and wait for their explicit choice "
                        "before calling accept_offer."}

    def _guard(order_id: str):
        if order_id in turn.quoted:
            return {"error": "Not allowed in the same turn as the quote. Show the customer the offers "
                             "and ask which one (if any) they want to book."}
        return None

    def accept_offer(order_id: str, offer_id: str):
        if (g := _guard(order_id)):
            return g
        try:
            res = quotes.accept(mgr.live(), order_id, offer_id)
        except quotes.QuoteError as e:
            return {"error": e.detail}
        turn.changed_orders = True
        turn.actions.append({"kind": "booked", "order_id": order_id, "text": f"Booked {order_id} · offer {offer_id}"})
        return {"booked": True, "order": _order_brief(res["order"])}

    def decline_offers(order_id: str):
        if (g := _guard(order_id)):
            return g
        try:
            quotes.decline(mgr.live(), order_id)
        except quotes.QuoteError as e:
            return {"error": e.detail}
        turn.changed_orders = True
        turn.actions.append({"kind": "declined", "order_id": order_id, "text": f"Declined all offers on {order_id}"})
        return {"declined": True, "order_id": order_id}

    def fleet():
        ep = live()
        with ep.sim_lock:
            snap = mgr.snapshot(ep.id)
        return {"sim_day": _r1(snap["day"]), "vessels": [{
            "vessel_id": v["vessel_id"], "name": v["name"], "mode": v["mode"], "at_port": v.get("port"),
            "from": v.get("from_port"), "to": v.get("to_port"), "leg_progress_pct": round(100 * (v.get("progress") or 0)),
            "speed_kt": _r1(v.get("speed_kt"))} for v in snap["vessels"]]}

    S = lambda d, **kw: {"type": "string", "description": d, **kw}   # noqa: E731
    N = lambda d, **kw: {"type": "number", "description": d, **kw}   # noqa: E731
    return [
        Tool("get_network", "Ports (UN/LOCODE + name), which origin->destination routes can be booked, "
             "and the valid cargo types and service segments.", {}, network),
        Tool("list_my_orders", "The customer's booking orders, newest first, with status, vessel, ETA and price.",
             _clean({"status": S("Optional status filter, e.g. QUOTED, CONFIRMED, IN TRANSIT, DELIVERED", optional=True)}),
             list_orders),
        Tool("get_order", "One order in detail, including every priced offer on it.",
             {"order_id": S("Order id like BK-2456-TC")}, get_order),
        Tool("request_quote", "Price a new booking request against the live fleet. Creates a QUOTED order "
             "with a menu of offers (non-binding). Ports are UN/LOCODEs from get_network.",
             {"origin": S("Origin port code, e.g. CNSHA"), "dest": S("Destination port code, e.g. NLRTM"),
              "teu": {"type": "integer", "description": "Containers in TEU (1 TEU = one 20ft box)", "minimum": 1},
              "weight_t": N("Total cargo weight in tonnes"),
              "cargo_type": S("dry | reefer | hazmat", enum=list(order_store.CARGO_TYPES)),
              "segment": S("flexible (cheapest, wide window) | standard | urgent (fastest)", enum=list(order_store.SEGMENTS)),
              "departure_in_days": N("Earliest departure, in days from today (>= 0.5)"),
              "flex_days": {"type": "integer", "description": "Days of flexibility on the departure date", "minimum": 0}},
             request_quote),
        Tool("accept_offer", "BINDING: book one offer on a QUOTED order. Only call after the customer explicitly "
             "chose that offer in their latest message.",
             {"order_id": S("Order id"), "offer_id": S("Offer id from get_order/request_quote")}, accept_offer, binding=True),
        Tool("decline_offers", "BINDING: turn down every offer on a QUOTED order. Only on the customer's explicit request.",
             {"order_id": S("Order id")}, decline_offers, binding=True),
        Tool("fleet_status", "Where each vessel is right now (at port or sailing between ports).", {}, fleet),
    ]


def _operator_tools(mgr, context: dict) -> list[Tool]:
    def live():
        ep = mgr.live()
        if ep is None or ep.sim is None:
            raise AssistantError(503, mgr.live_error or "the live simulation is starting — try again shortly")
        return ep

    def snapshot():
        ep = live()
        with ep.sim_lock:
            s = mgr.snapshot(ep.id)
        m = s["metrics"]
        return {"sim_day": _r1(s["day"]), "policy": s["policy"], "scenario": s["scenario"],
                "metrics": {k: (round(v, 3) if isinstance(v, float) else v) for k, v in m.items() if k != "costs"},
                "costs_usd": {k: round(v) for k, v in m.get("costs", {}).items()},
                "vessels": [{"vessel_id": v["vessel_id"], "name": v["name"], "mode": v["mode"],
                             "at_port": v.get("port"), "from": v.get("from_port"), "to": v.get("to_port"),
                             "leg_progress_pct": round(100 * (v.get("progress") or 0)),
                             "onboard_teu": v.get("onboard_teu"), "speed_kt": _r1(v.get("speed_kt"))}
                            for v in s["vessels"]],
                "empty_containers_by_port": {k: round(v) for k, v in s.get("empties", {}).items()}}

    def stowage(vessel_id: str):
        ep = live()
        with ep.sim_lock:
            v = ep.sim.vessels.get(vessel_id)
            if v is None:
                return {"error": f"unknown vessel '{vessel_id}' — one of {sorted(ep.sim.vessels)}"}
            st = stowage_view(ep.sim, v)
        units = [u for b in st["bays"] for u in b["aboard"]]
        by_pod, by_type = {}, {}
        for u in units:
            by_pod[u["discharge"]] = by_pod.get(u["discharge"], 0) + 1
            by_type[u["cargo_type"]] = by_type.get(u["cargo_type"], 0) + 1
        heavy = sorted(st["bays"], key=lambda b: -sum(u["weight_t"] for u in b["aboard"]))[:3]
        return {"vessel_id": vessel_id, "name": st["name"], "mode": st["mode"], "port": st["port"],
                "capacity_teu": st["capacity_teu"], "aboard_teu": st["aboard_teu"],
                "utilisation_pct": round(100 * st["aboard_teu"] / st["capacity_teu"]) if st["capacity_teu"] else None,
                "booked_to_load_later_teu": st["booked_later_teu"],
                "cargo_weight_t": round(sum(u["weight_t"] for u in units)),
                "teu_by_discharge_port": by_pod, "teu_by_cargo_type": by_type,
                "reefer_plugs": next((row[3] for row in C.VESSELS if row[0] == vessel_id), None),
                "heaviest_logical_bays": [{"bay": b["idx"], "weight_t": round(sum(u["weight_t"] for u in b["aboard"]))} for b in heavy],
                "upcoming_calls": st["upcoming_calls"][:6]}

    def bookings(limit: int = 20, outcome: str | None = None):
        ep = live()
        evs = [e for e in ep.events[:] if e["type"] == "booking.decision"
               and (not outcome or e.get("outcome") == outcome)][-max(1, min(int(limit), 40)):]
        return {"decisions": [{k: e.get(k) for k in ("day", "source", "origin", "dest", "teu", "segment",
                                                     "outcome", "kind", "price", "vessel", "note") if e.get(k) is not None}
                              for e in reversed(evs)]}

    def customer_orders(status: str | None = None):
        rows = order_store.list_orders(quotes.live_info(mgr.live()))
        if status:
            rows = [o for o in rows if o["status"] == status.upper()]
        counts = {}
        for o in rows:
            counts[o["status"]] = counts.get(o["status"], 0) + 1
        return {"count": len(rows), "by_status": counts, "latest": [_order_brief(o) for o in rows[:15]]}

    def strategies():
        from .routes import DEMO_DIR
        s = json.loads((DEMO_DIR / "summary.json").read_text())
        return {"policies": {k: {"profit_usd_mean": round(v["profit_usd"]["mean"]), "profit_usd_std": round(v["profit_usd"]["std"]),
                                 "utilization": v["utilization"]["mean"], "revenue_per_teu": v["revenue_per_teu"]["mean"],
                                 "co2_per_teu": v["co2_per_teu"]["mean"]} for k, v in s["policies"].items()},
                "lift_vs_static": s.get("lift_vs_static")}

    def vessels():
        return {"vessels": [{"vessel_id": v[0], "name": v[1], "capacity_teu": v[2], "reefer_plugs": v[3],
                             "service_speed_kt": v[5], "draft_m": v[8], "loop": C.VESSEL_LOOPS.get(v[0])} for v in C.VESSELS]}

    S = lambda d, **kw: {"type": "string", "description": d, **kw}   # noqa: E731
    return [
        Tool("fleet_snapshot", "Live simulation now: day, cumulative revenue/profit/utilisation, costs, every "
             "vessel's position/speed/onboard TEU, and empty containers per port.", {}, snapshot),
        Tool("vessel_stowage", "What is aboard one vessel now: TEU vs capacity, cargo weight, TEU by discharge "
             "port and cargo type, heaviest bays, next port calls.",
             {"vessel_id": S("VES1 | VES2 | VES3 | VES4", enum=[v[0] for v in C.VESSELS])}, stowage),
        Tool("recent_booking_decisions", "Latest booking decisions the pricing policy made (accept / counter / reject) "
             "with lane, TEU, segment and price.",
             _clean({"limit": {"type": "integer", "description": "How many (max 40)", "optional": True},
                     "outcome": S("booked | rejected | declined", optional=True)}), bookings),
        Tool("customer_orders", "Orders filed through the customer portal, with counts by status.",
             _clean({"status": S("Optional status filter", optional=True)}), customer_orders),
        Tool("strategy_comparison", "Holdout evaluation of pricing strategies (static rate card, greedy, "
             "heuristic, heuristic+bid price, the RL policy): profit, utilisation, revenue/TEU, CO2/TEU.",
             {}, strategies),
        Tool("fleet_particulars", "Static particulars of the four vessels: capacity, reefer plugs, speed, draught, port rotation.",
             {}, vessels),
    ]


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

def _customer_prompt(day: float | None) -> str:
    today = f"The simulation clock is at day {day:.1f}; express times as 'in N days'." if day is not None else ""
    return f"""You are the MERIDIAN LINE booking assistant inside the customer's fleet dashboard.
You help this customer company book container shipments and answer questions about their orders,
using ONLY the tools — never invent orders, prices, sailings, vessels or ETAs. {today}

Booking a shipment:
1. Collect origin, destination, TEU, total weight (tonnes), cargo type (dry/reefer/hazmat), service
   (flexible/standard/urgent) and earliest departure. Ask briefly for anything missing; suggest sensible
   defaults (standard, 3 flex days) rather than interrogating. Use get_network to map city names to codes and
   check the route is servable.
2. Call request_quote, then present the offers compactly (one line each: price/TEU, total, sailing and
   arrival, and mark the recommended one). Quotes are free and non-binding.
3. Only call accept_offer after the customer explicitly picks an offer in their latest message. Before a
   binding action, restate what will be booked and the total price. Declining works the same way.

Style: warm, concise, plain text with short lists; money as $1,234; no markdown tables or headings.
If a tool returns an error, explain it plainly and suggest a fix. Stay on shipping topics."""


def _operator_prompt(context: dict) -> str:
    ctx = ""
    if context.get("vessel_id"):
        ctx = f"The operator is looking at the stowage screen for {context['vessel_id']} ({vessel_name(context['vessel_id'])})"
        if context.get("row"):
            ctx += f", row {context['row']}"
        ctx += ". 'This ship' means that vessel."
    return f"""You are DOCK's operations copilot for a container-shipping port operator / fleet planner.
Answer questions about stowage, vessel loading, the live booking flow, customer orders, fleet positions,
and how the pricing policy is performing — using ONLY the read-only tools; never invent figures. {ctx}

Be brief and specific, like a chief officer's briefing: lead with the answer, then 2–4 supporting facts with
numbers and units (TEU, t, kt, $). Plain text, short lists, no markdown tables or headings. Flag risks you
notice (e.g. heavy discharge at the next call, reefer plug pressure, low utilisation). You cannot change
bookings or stowage — say so if asked, and point to the relevant screen."""


# ---------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------

def _visible_history(messages: list[dict]) -> list[dict]:
    out = []
    for m in messages[-MAX_HISTORY:]:
        role, content = m.get("role"), m.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            out.append({"role": role, "content": content[:MAX_MSG_CHARS]})
    if not out or out[-1]["role"] != "user":
        raise AssistantError(422, "the last message must be the user's")
    return out


# What the UI shows while a tool runs (streaming endpoint).
STATUS = {
    "get_network": "Checking the route network", "list_my_orders": "Looking up your orders",
    "get_order": "Opening the order", "request_quote": "Pricing against the live fleet",
    "accept_offer": "Booking the offer", "decline_offers": "Declining the offers",
    "fleet_status": "Locating the vessels", "fleet_snapshot": "Reading the live simulation",
    "vessel_stowage": "Reading the stowage", "recent_booking_decisions": "Reading recent booking decisions",
    "customer_orders": "Reading customer orders", "strategy_comparison": "Comparing pricing strategies",
    "fleet_particulars": "Reading vessel particulars",
}


def run(audience: str, mgr, messages: list[dict], context: dict | None = None,
        cfg: LLMConfig | None = None, llm: Callable | None = None,
        emit: Callable[[str, dict], None] | None = None) -> dict:
    """One user message through the bounded tool loop. With `emit`, progress
    is pushed as it happens: ('delta', {text}) while the model writes,
    ('reset', {}) if a round turned into tool calls after some preamble text,
    ('status', {text}) before each tool runs, ('action', {...}) when the
    agent did something (quoted / booked / declined)."""
    cfg = cfg or LLMConfig.from_env()
    llm = llm or complete           # looked up at call time (tests swap the client)
    if not cfg.enabled:
        raise AssistantError(503, "The assistant isn't configured (no LLM_API_KEY on the server).")
    context = context or {}
    turn = Turn()
    ep = mgr.live()
    if audience == "customer":
        tools = _customer_tools(mgr, turn)
        system = _customer_prompt(float(ep.day) if ep is not None else None)
    elif audience == "operator":
        tools = _operator_tools(mgr, context)
        system = _operator_prompt(context)
    else:
        raise AssistantError(404, f"unknown assistant '{audience}'")
    by_name = {t.name: t for t in tools}
    convo = [{"role": "system", "content": system}, *_visible_history(messages)]
    specs = [t.spec() for t in tools]

    streamed = []
    on_text = None
    if emit:
        def on_text(t):
            streamed.append(t)
            emit("delta", {"text": t})

    for round_ in range(MAX_ROUNDS):
        final = round_ == MAX_ROUNDS - 1
        streamed.clear()
        msg = llm(cfg, convo, [] if final else specs, on_text=on_text) if emit else llm(cfg, convo, [] if final else specs)
        calls = msg.get("tool_calls") or []
        if calls and streamed:
            emit("reset", {})
        if not calls:
            return {"reply": (msg.get("content") or "").strip() or "Sorry — I couldn't produce an answer.",
                    "actions": turn.actions, "orders_changed": turn.changed_orders}
        convo.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
        for call in calls:
            fn = call.get("function", {})
            tool = by_name.get(fn.get("name"))
            n_actions = len(turn.actions)
            if emit and tool:
                emit("status", {"text": STATUS.get(tool.name, "Working")})
            try:
                args = json.loads(fn.get("arguments") or "{}")
                result = tool.fn(**args) if tool else {"error": f"unknown tool {fn.get('name')}"}
            except AssistantError:
                raise
            except TypeError as e:
                result = {"error": f"bad arguments: {e}"}
            except Exception as e:          # a tool failure is reported to the model, not a 500
                result = {"error": f"{type(e).__name__}: {e}"}
            convo.append({"role": "tool", "tool_call_id": call.get("id"),
                          "content": json.dumps(result, default=str)[:6000]})
            if emit:
                for a in turn.actions[n_actions:]:
                    emit("action", a)
    return {"reply": "Sorry — that took too many steps. Could you narrow the question?",
            "actions": turn.actions, "orders_changed": turn.changed_orders}
