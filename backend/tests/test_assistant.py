"""The LLM chat assistants (server/assistant.py) against a real live episode
and a real test Postgres. The language model itself is a scripted stand-in
(`Script`) that replays tool calls exactly as an OpenAI-compatible endpoint
would return them — the upstream API is heavily rate-limited, so the suite
never spends real requests. Everything the tools touch is real: quotes are
priced by the live policy, bookings go through quotes.accept, and the
operator copilot reads the live stowage."""

from __future__ import annotations

import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from server import assistant
from server.app import create_app

CFG = assistant.LLMConfig(base_url="http://llm.invalid/v1", api_key="test", model="scripted")


class Script:
    """Stand-in LLM: each call pops the next scripted assistant message. A
    step is either a string (final text) or a list of (tool, args) calls; a
    callable step gets the conversation so far (to read earlier tool output)."""

    def __init__(self, *steps):
        self.steps = list(steps)
        self.calls = []                          # (messages, tool names) per call

    def __call__(self, cfg, messages, tools, on_text=None):
        self.calls.append((json.loads(json.dumps(messages)), [t["function"]["name"] for t in tools]))
        step = self.steps.pop(0)
        if callable(step):
            step = step(messages)
        if isinstance(step, str):
            if on_text:                              # stream it like SSE deltas would
                for i in range(0, len(step), 7):
                    on_text(step[i:i + 7])
            return {"role": "assistant", "content": step}
        return {"role": "assistant", "content": None, "tool_calls": [
            {"id": f"call_{len(self.calls)}_{i}", "type": "function",
             "function": {"name": name, "arguments": json.dumps(args)}}
            for i, (name, args) in enumerate(step)]}

    def tool_results(self, n=-1):
        """Parsed tool messages the model saw on call n."""
        return [json.loads(m["content"]) for m in self.calls[n][0] if m["role"] == "tool"]


@pytest.fixture(scope="module")
def live(migrated_db):
    app = create_app()
    with TestClient(app) as c:
        c.delete("/orders")
        mgr = app.state.episodes
        ep = mgr.start("ppo", "baseline", seed=11, horizon_days=90,
                       speed_days_per_sec=0.02, live=True)
        mgr._live_id = ep.id
        for _ in range(100):
            if len(ep.trace) >= 3:
                break
            time.sleep(0.1)
        yield c, mgr, ep
        ep._stop.set()
        ep._pause.set()


QUOTE = dict(origin="CNSHA", dest="NLRTM", teu=6, weight_t=60, cargo_type="dry",
             segment="standard", flex_days=3)


def _quote_turn(mgr):
    """Run a customer turn that quotes; retry departure days until the live
    fleet produces at least one offer (sailings vary by date)."""
    for dep in (6, 9, 12, 15, 20, 25):
        s = Script([("request_quote", {**QUOTE, "departure_in_days": dep})], "Here are your offers.")
        out = assistant.run("customer", mgr, [{"role": "user", "content": "Quote 6 TEU Shanghai to Rotterdam"}],
                            cfg=CFG, llm=s)
        res = s.tool_results()[0]
        if res.get("offers"):
            return s, out, res
    pytest.fail("no sailing produced an offer on CNSHA->NLRTM")


def test_customer_quote_creates_a_real_order_and_offers(live):
    c, mgr, _ = live
    s, out, res = _quote_turn(mgr)
    assert out["reply"] == "Here are your offers."
    assert out["orders_changed"] is True
    assert out["actions"][0]["kind"] == "quote"
    oid = res["order"]["id"]
    # the order the agent quoted is the same row the dashboard lists
    body = c.get(f"/orders/{oid}").json()
    assert body["status"] == "QUOTED" and body["origin"] == "CNSHA" and body["teu"] == 6
    assert {o["id"] for o in body["offers"]} == {o["offer_id"] for o in res["offers"]}
    # the customer agent gets booking tools, and the model saw the system prompt
    names = s.calls[0][1]
    assert {"request_quote", "accept_offer", "decline_offers", "list_my_orders"} <= set(names)
    assert s.calls[0][0][0]["role"] == "system" and "MERIDIAN LINE" in s.calls[0][0][0]["content"]


def test_accept_is_refused_in_the_same_turn_as_the_quote(live):
    """Guardrail in code: the customer must see the offers before booking."""
    c, mgr, _ = live
    for dep in (6, 9, 12, 15, 20, 25):
        def accept_first_offer(messages):
            q = json.loads(next(m["content"] for m in reversed(messages) if m["role"] == "tool"))
            if not q.get("offers"):
                return "No sailings."
            return [("accept_offer", {"order_id": q["order"]["id"], "offer_id": q["offers"][0]["offer_id"]})]
        s = Script([("request_quote", {**QUOTE, "departure_in_days": dep})], accept_first_offer, "Done.")
        out = assistant.run("customer", mgr, [{"role": "user", "content": "book whatever is cheapest"}],
                            cfg=CFG, llm=s)
        quoted = s.tool_results(1)[0]
        if quoted.get("offers"):
            break
    refusal = s.tool_results(2)[-1]
    assert "error" in refusal and "same turn" in refusal["error"]
    assert c.get(f"/orders/{quoted['order']['id']}").json()["status"] == "QUOTED"
    assert [a["kind"] for a in out["actions"]] == ["quote"]


def test_customer_books_an_offer_on_the_next_turn(live):
    c, mgr, _ = live
    _, _, res = _quote_turn(mgr)
    oid, offer = res["order"]["id"], res["offers"][0]["offer_id"]
    history = [{"role": "user", "content": "Quote 6 TEU Shanghai to Rotterdam"},
               {"role": "assistant", "content": f"Offers on {oid}: {offer} ..."},
               {"role": "user", "content": f"Yes, book {offer}"}]
    s = Script([("accept_offer", {"order_id": oid, "offer_id": offer})], "Booked!")
    out = assistant.run("customer", mgr, history, cfg=CFG, llm=s)
    assert s.tool_results()[0]["booked"] is True
    assert out["actions"][-1] == {"kind": "booked", "order_id": oid, "text": f"Booked {oid} · offer {offer}"}
    assert c.get(f"/orders/{oid}").json()["status"] == "CONFIRMED"
    # the history the model received is exactly the visible conversation
    assert [m["role"] for m in s.calls[0][0]] == ["system", "user", "assistant", "user"]


def test_customer_decline_and_order_lookup(live):
    c, mgr, _ = live
    _, _, res = _quote_turn(mgr)
    oid = res["order"]["id"]
    s = Script([("get_order", {"order_id": oid}), ("list_my_orders", {"status": "quoted"})],
               [("decline_offers", {"order_id": oid})], "Declined.")
    out = assistant.run("customer", mgr, [{"role": "user", "content": f"decline {oid}"}], cfg=CFG, llm=s)
    looked_up, listed = s.tool_results(1)
    assert looked_up["order"]["id"] == oid and looked_up["offers"]
    assert any(o["id"] == oid for o in listed["orders"])
    assert s.tool_results(2)[-1] == {"declined": True, "order_id": oid}
    assert c.get(f"/orders/{oid}").json()["status"] == "DECLINED"
    assert out["actions"][-1]["kind"] == "declined"


def test_invalid_quote_is_reported_to_the_model_not_raised(live):
    _, mgr, _ = live
    s = Script([("request_quote", {**QUOTE, "origin": "XXXXX", "departure_in_days": 5})], "That port isn't served.")
    out = assistant.run("customer", mgr, [{"role": "user", "content": "quote from nowhere"}], cfg=CFG, llm=s)
    assert "error" in s.tool_results()[0]
    assert out["actions"] == [] and out["orders_changed"] is False


def test_operator_copilot_is_read_only_and_reads_live_data(live):
    _, mgr, ep = live
    s = Script([("vessel_stowage", {"vessel_id": "VES2"}), ("fleet_snapshot", {}),
                ("recent_booking_decisions", {"limit": 5}), ("strategy_comparison", {}),
                ("customer_orders", {}), ("fleet_particulars", {}),
                ("accept_offer", {"order_id": "BK-1", "offer_id": "x"})], "Briefing.")
    out = assistant.run("operator", mgr, [{"role": "user", "content": "brief me"}],
                        context={"vessel_id": "VES2", "row": 3}, cfg=CFG, llm=s)
    assert out["reply"] == "Briefing."
    names = set(s.calls[0][1])
    assert not names & {"request_quote", "accept_offer", "decline_offers"}
    stow, snap, decisions, strat, orders, particulars, sneaky = s.tool_results()
    with ep.sim_lock:
        v = ep.sim.vessels["VES2"]
        assert stow["capacity_teu"] == v.spec.capacity_teu
    assert stow["name"] == "Meridian Star" and "teu_by_discharge_port" in stow
    assert len(snap["vessels"]) == 4 and "cum_profit" in snap["metrics"]
    assert "decisions" in decisions and set(strat["policies"]) >= {"ppo", "greedy", "static"}
    assert "by_status" in orders and len(particulars["vessels"]) == 4
    assert sneaky == {"error": "unknown tool accept_offer"}
    assert "VES2" in s.calls[0][0][0]["content"] and "row 3" in s.calls[0][0][0]["content"]


def test_tool_loop_is_bounded(live):
    _, mgr, _ = live
    s = Script(*([[("fleet_particulars", {})]] * (assistant.MAX_ROUNDS - 1)), "Final answer without tools.")
    out = assistant.run("operator", mgr, [{"role": "user", "content": "loop"}], cfg=CFG, llm=s)
    assert len(s.calls) == assistant.MAX_ROUNDS
    assert s.calls[-1][1] == []                    # last round offers no tools -> must answer
    assert out["reply"] == "Final answer without tools."


def test_routes_status_disabled_and_validation(live, monkeypatch):
    c, _, _ = live
    monkeypatch.setenv("LLM_API_KEY", "")
    assert c.get("/chat/status").json() == {"enabled": False, "model": None}
    r = c.post("/chat/customer", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 503 and "LLM_API_KEY" in r.json()["detail"]
    monkeypatch.setenv("LLM_API_KEY", "k")
    monkeypatch.setattr(assistant, "complete", Script("Hello from the stand-in."))
    assert c.get("/chat/status").json()["enabled"] is True
    r = c.post("/chat/customer", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 200 and r.json()["reply"] == "Hello from the stand-in."
    r = c.post("/chat/operator", json={"messages": [{"role": "assistant", "content": "hi"}]})
    assert r.status_code == 422
    r = c.post("/chat/pirate", json={"messages": [{"role": "user", "content": "arr"}]})
    assert r.status_code == 404


def test_upstream_client_retries_once_then_reports(monkeypatch):
    """complete(): one retry on 429/5xx (honouring Retry-After, capped), no
    retry on other 4xx — never hammers the rate-limited upstream."""
    sleeps, seen = [], []
    monkeypatch.setattr(assistant.time, "sleep", sleeps.append)

    def fake(codes):
        it = iter(codes)
        def post(url, json=None, timeout=None, headers=None):
            seen.append(json)
            code = next(it)
            body = {"choices": [{"message": {"role": "assistant", "content": "ok"}}]} if code == 200 else {"error": {}}
            return httpx.Response(code, json=body, headers={"retry-after": "30"} if code == 429 else {})
        return post

    monkeypatch.setattr(assistant.httpx, "post", fake([429, 200]))
    assert assistant.complete(CFG, [{"role": "user", "content": "x"}], [])["content"] == "ok"
    assert sleeps == [8.0] and "tools" not in seen[-1]     # Retry-After capped at 8 s

    seen.clear(); sleeps.clear()
    monkeypatch.setattr(assistant.httpx, "post", fake([500, 500]))
    with pytest.raises(assistant.AssistantError) as e:
        assistant.complete(CFG, [{"role": "user", "content": "x"}], [])
    assert e.value.status == 502 and "HTTP 500" in e.value.detail and len(seen) == 2

    seen.clear()
    monkeypatch.setattr(assistant.httpx, "post", fake([401]))
    with pytest.raises(assistant.AssistantError):
        assistant.complete(CFG, [{"role": "user", "content": "x"}], [])
    assert len(seen) == 1


def _sse(text):
    """Parse a text/event-stream body into [(event, data)]."""
    out = []
    for block in text.strip().split("\n\n"):
        ev = data = None
        for line in block.split("\n"):
            if line.startswith("event: "):
                ev = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
        out.append((ev, data))
    return out


def test_stream_endpoint_emits_status_actions_deltas_then_done(live, monkeypatch):
    c, _, _ = live
    monkeypatch.setenv("LLM_API_KEY", "k")
    for dep in (6, 9, 12, 15, 20, 25):
        monkeypatch.setattr(assistant, "complete",
                            Script([("request_quote", {**QUOTE, "departure_in_days": dep})], "Two offers — pick one."))
        r = c.post("/chat/customer/stream", json={"messages": [{"role": "user", "content": "quote please"}]})
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
        assert r.headers["x-accel-buffering"] == "no"
        evs = _sse(r.text)
        if any(e == "action" for e, _ in evs):
            break
    kinds = [e for e, _ in evs]
    assert kinds[0] == "status" and evs[0][1]["text"] == "Pricing against the live fleet"
    assert "action" in kinds and kinds[-1] == "done"
    assert kinds.index("action") < kinds.index("delta")          # receipt arrives before the reply text
    streamed = "".join(d["text"] for e, d in evs if e == "delta")
    done = evs[-1][1]
    assert streamed == done["reply"] == "Two offers — pick one."
    assert done["orders_changed"] is True and done["actions"][0]["kind"] == "quote"


def test_stream_endpoint_reports_errors_as_events(live, monkeypatch):
    c, _, _ = live
    monkeypatch.setenv("LLM_API_KEY", "k")

    def down(cfg, messages, tools, on_text=None):
        raise assistant.AssistantError(502, "The assistant is unavailable right now — HTTP 500.")
    monkeypatch.setattr(assistant, "complete", down)
    evs = _sse(c.post("/chat/operator/stream", json={"messages": [{"role": "user", "content": "hi"}]}).text)
    assert evs == [("error", {"status": 502, "detail": "The assistant is unavailable right now — HTTP 500."})]


def test_preamble_text_before_tool_calls_is_reset(live):
    _, mgr, _ = live
    events = []

    def llm(cfg, messages, tools, on_text=None):
        if not any(m["role"] == "tool" for m in messages):
            on_text("Let me check… ")
            return {"role": "assistant", "content": "Let me check… ", "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": "fleet_particulars", "arguments": "{}"}}]}
        on_text("Four ships.")
        return {"role": "assistant", "content": "Four ships."}

    out = assistant.run("operator", mgr, [{"role": "user", "content": "fleet?"}], cfg=CFG, llm=llm,
                        emit=lambda e, d: events.append((e, d)))
    assert [e for e, _ in events] == ["delta", "reset", "status", "delta"]
    assert out["reply"] == "Four ships."


def test_streamed_tool_call_fragments_are_assembled(monkeypatch):
    """_read_stream: content deltas forwarded; tool-call id/name/arguments
    arriving in pieces across chunks are stitched back together."""
    chunks = [
        {"choices": [{"delta": {"content": "Hel"}}]},
        {"choices": [{"delta": {"content": "lo"}}]},
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_a", "function": {"name": "get_order", "arguments": "{\"order"}}]}}]},
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "_id\": \"BK-1\"}"}}]}}]},
        {"choices": [{"delta": {"tool_calls": [{"index": 1, "id": "call_b", "function": {"name": "fleet_status", "arguments": "{}"}}]}}]},
    ]
    body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
    sent, got = [], []

    class FakeStream:
        status_code = 200
        headers = {}
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def iter_lines(self): return iter(body.splitlines())
        def read(self): return b""

    def stream(method, url, json=None, timeout=None, headers=None):
        sent.append(json)
        return FakeStream()
    monkeypatch.setattr(assistant.httpx, "stream", stream)
    msg = assistant.complete(CFG, [{"role": "user", "content": "x"}], [{"type": "function"}], on_text=got.append)
    assert got == ["Hel", "lo"] and msg["content"] == "Hello"
    assert sent[0]["stream"] is True and sent[0]["tool_choice"] == "auto"
    assert msg["tool_calls"] == [
        {"id": "call_a", "type": "function", "function": {"name": "get_order", "arguments": '{"order_id": "BK-1"}'}},
        {"id": "call_b", "type": "function", "function": {"name": "fleet_status", "arguments": "{}"}},
    ]
