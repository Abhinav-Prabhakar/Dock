"""The customer quote -> accept/decline flow and the /live endpoints, against
a real live episode running the trained PPO policy (slow clock, so the
world barely moves during a test) and a real test Postgres.
"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from server import quotes
from server.app import create_app

BASE = dict(origin="CNSHA", dest="NLRTM", teu=6, weight_t=60.0,
            cargo_type="dry", segment="standard", flex_days=3)


@pytest.fixture(scope="module")
def live(migrated_db):
    app = create_app()
    with TestClient(app) as c:
        c.delete("/orders")
        mgr = app.state.episodes
        ep = mgr.start("ppo", "baseline", seed=11, horizon_days=90,
                       speed_days_per_sec=0.02, live=True)
        mgr._live_id = ep.id
        for _ in range(100):                     # let the policy run a few steps
            if len(ep.trace) >= 3:
                break
            time.sleep(0.1)
        yield c, ep
        ep._stop.set()
        ep._pause.set()


def _quote_with_offers(c) -> dict:
    """A quote that has at least one offer (sailings vary by date)."""
    for dep in (6, 9, 12, 15, 20, 25, 30):
        r = c.post("/orders", json={**BASE, "req_dep_day": dep})
        assert r.status_code == 201, r.text
        body = r.json()
        if body["offers"]:
            return body
    pytest.fail("no sailing produced an offer on CNSHA->NLRTM")


def test_no_viable_offer_is_recorded_not_faked(live):
    """A request nothing can carry clears nothing -> NO OFFER, never a
    below-cost deal, and the operator still sees the turned-away demand."""
    c, _ = live
    # 7,000 TEU exceeds every vessel's bookable own-lift space — and a
    # split's halves (3,500 TEU) don't fit either, so nothing is viable
    r = c.post("/orders", json={**BASE, "teu": 7000, "weight_t": 70000,
                                "req_dep_day": 8})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["offers"] == []
    assert body["order"]["status"] == "NO OFFER"
    evs = c.get("/live/events", params={"types": "booking.decision"}).json()["events"]
    ev = next(e for e in evs if e.get("order_id") == body["order"]["id"])
    assert ev["outcome"] == "rejected" and ev["source"] == "customer"


def test_quote_returns_priced_offers_and_recommendation(live):
    c, ep = live
    body = _quote_with_offers(c)
    order, offers, rec = body["order"], body["offers"], body["recommendation"]
    assert order["status"] == "QUOTED" and order["episode_id"] == ep.id
    kinds = {o["kind"] for o in offers}
    assert kinds <= {"accept", "flex_window", "alt_hub", "split"}
    for o in offers:
        assert o["price_per_teu"] > 0 and o["total_usd"] > 0
        assert o["legs"] and o["summary"]
        # never offered below the opportunity cost of the space
        assert o["price_per_teu"] >= o["pricing"]["bid_price"]
        assert 0.0 <= o["prob"] <= 1.0                  # PPO probability
    assert sum(o["recommended"] for o in offers) <= 1
    assert "action" in rec and rec["attribution"]


def test_accept_books_on_the_live_world(live):
    c, ep = live
    body = _quote_with_offers(c)
    oid, offer = body["order"]["id"], body["offers"][0]
    r = c.post(f"/orders/{oid}/accept", json={"offer_id": offer["id"]})
    assert r.status_code == 200, r.text
    order = r.json()["order"]
    assert order["status"] in ("CONFIRMED", "LOADING")
    assert order["price_usd"] == offer["total_usd"]
    assert order["vessel"] and order["eta"].startswith("D+")

    evs = c.get("/live/events", params={"types": "booking.decision,order.accepted"}).json()["events"]
    mine = [e for e in evs if e.get("order_id") == oid]
    assert {e["type"] for e in mine} == {"booking.decision", "order.accepted"}
    bd = next(e for e in mine if e["type"] == "booking.decision")
    assert bd["source"] == "customer" and bd["outcome"] == "booked"

    again = c.post(f"/orders/{oid}/accept", json={"offer_id": offer["id"]})
    assert again.status_code == 409                   # decided orders are closed


def test_concurrent_accept_books_only_once(live):
    """Two accepts racing the same open quote (double-click, two tabs): both
    read the quote before either takes sim_lock, so without the re-check
    inside the lock, the second would book the same request a second time."""
    import concurrent.futures

    c, _ = live
    body = _quote_with_offers(c)
    oid, offer = body["order"]["id"], body["offers"][0]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futs = [pool.submit(c.post, f"/orders/{oid}/accept",
                            json={"offer_id": offer["id"]}) for _ in range(2)]
        results = [f.result() for f in futs]
    assert sorted(r.status_code for r in results) == [200, 409]
    evs = c.get("/live/events", params={"types": "booking.decision"}).json()["events"]
    booked = [e for e in evs if e.get("order_id") == oid and e.get("outcome") == "booked"]
    assert len(booked) == 1
    assert c.get(f"/orders/{oid}").json()["status"] in ("CONFIRMED", "LOADING")


def test_concurrent_accept_and_decline_do_not_diverge(live):
    """An accept racing a decline on the same open quote must not leave the
    order DECLINED while the cargo is booked (or vice versa)."""
    import concurrent.futures

    c, _ = live
    body = _quote_with_offers(c)
    oid, offer = body["order"]["id"], body["offers"][0]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        f_accept = pool.submit(c.post, f"/orders/{oid}/accept",
                               json={"offer_id": offer["id"]})
        f_decline = pool.submit(c.post, f"/orders/{oid}/decline")
        r_accept, r_decline = f_accept.result(), f_decline.result()
    assert sorted([r_accept.status_code, r_decline.status_code]) == [200, 409]
    order = c.get(f"/orders/{oid}").json()
    if r_accept.status_code == 200:
        assert order["status"] in ("CONFIRMED", "LOADING")
    else:
        assert order["status"] == "DECLINED"


def test_accepted_counter_offer_registers_a_deal_on_the_order(live):
    """Counter-offers become settlement contracts. _book emits
    settlement.deal_registered synchronously, so the order must already be
    known to the tracker then, or it never gets its deal_id."""
    c, ep = live
    lanes = [(r["origin"], r["dest"]) for r in c.get("/routes").json()]
    for dep in (4, 8, 12, 16):
        for o, d in lanes:
            body = c.post("/orders", json={**BASE, "origin": o, "dest": d, "teu": 4,
                                           "weight_t": 40.0, "flex_days": 0,
                                           "req_dep_day": dep}).json()
            counter = next((f for f in body["offers"]
                            if f["kind"] in ("flex_window", "alt_hub", "split")), None)
            if counter:
                break
        if counter:
            break
    else:
        pytest.fail("no counter-offer on any lane")
    oid = body["order"]["id"]
    r = c.post(f"/orders/{oid}/accept", json={"offer_id": counter["id"]})
    assert r.status_code == 200, r.text
    deal_id = c.get(f"/orders/{oid}").json()["deal_id"]
    assert deal_id and ep.deals[deal_id]["kind"] == counter["kind"]
    assert ep.deals[deal_id]["request_id"] == body["order"]["request_id"]


def test_decline(live):
    c, _ = live
    body = _quote_with_offers(c)
    oid = body["order"]["id"]
    r = c.post(f"/orders/{oid}/decline")
    assert r.status_code == 200
    assert r.json()["order"]["status"] == "DECLINED"
    assert all(o["status"] == "declined" for o in r.json()["offers"])


def test_decline_after_accept_conflicts_and_db_stays_confirmed(live):
    c, _ = live
    body = _quote_with_offers(c)
    oid, offer = body["order"]["id"], body["offers"][0]
    r = c.post(f"/orders/{oid}/accept", json={"offer_id": offer["id"]})
    assert r.status_code == 200, r.text
    again = c.post(f"/orders/{oid}/decline")
    assert again.status_code == 409
    assert c.get(f"/orders/{oid}").json()["status"] in ("CONFIRMED", "LOADING")


def test_quote_expires(live, monkeypatch):
    c, _ = live
    body = _quote_with_offers(c)
    monkeypatch.setattr(quotes, "QUOTE_TTL_S", -1)
    r = c.post(f"/orders/{body['order']['id']}/accept",
               json={"offer_id": body["offers"][0]["id"]})
    assert r.status_code == 409 and "expired" in r.text
    assert c.get(f"/orders/{body['order']['id']}").json()["status"] == "EXPIRED"


def test_live_snapshot_policy_and_stowage(live):
    c, ep = live
    snap = c.get("/live").json()
    assert snap["id"] == ep.id and snap["live"] is True
    assert len(snap["vessels"]) == 4
    assert snap["vessels"][0]["name"] == "Pacific Aurora"

    pol = c.get("/live/policy").json()
    assert pol["decisions"], "the live PPO episode should have recorded decisions"
    d = pol["decisions"][-1]
    assert len(d["obs"]) == 112 and len(d["probs"]) == 44 and len(d["mask"]) == 44
    assert d["mask"][d["action"]]                       # chosen action was legal
    assert len(d["h1"]) == len(d["h2"]) == 28
    assert set(d["latency_ms"]) == {"mask", "policy", "bid", "counterfactuals", "act"}
    bookings = [x for x in pol["decisions"] if x["step"] == "booking"]
    for x in bookings:                       # context the original panels draw
        for o in x["options"]:
            assert o["vessel_id"] and o["legs"] and o["bid"] is not None
            assert all(l["from"] and l["to"] for l in o["legs"])
            assert o["feasible"] or o["reason"]
        for cf in x["counterfactuals"]:
            assert cf["key"] in {"static", "greedy", "heuristic", "heuristic_bid"}
    if bookings:
        assert any(x["counterfactuals"] for x in bookings)
    priced = [x for x in pol["decisions"] if x.get("pricing")]
    if priced:                                    # booking steps with an offer
        pr = priced[-1]["pricing"]
        assert pr["bid_price"] >= 0 and pr["price"] > 0 and pr["reason"]
        assert pr["dest"]                          # matched against options[].dest
        curve = pr["curve"]
        assert len(curve) == 64 and all(0 <= pa <= 1 for _, pa, _ in curve)
        assert [pa for _, pa, _ in curve] == sorted((pa for _, pa, _ in curve), reverse=True)
    booked = [x for x in pol["decisions"] if x.get("outcome")]
    if booked:                                    # tied to its ledger entry
        assert booked[-1]["outcome"]["hash"] and booked[-1]["outcome"]["seq"]

    net = c.get("/live/policy/network").json()
    assert net["layers"] == [112, 256, 256, 44]
    assert len(net["w1"]) == 28 and len(net["w1"][0]) == 112
    assert len(net["w3"]) == 44 and len(net["obs_labels"]) == 112

    st = c.get("/live/vessels/VES1/stowage").json()
    assert st["name"] == "Pacific Aurora" and len(st["bays"]) == 64
    assert st["aboard_teu"] == sum(len(b["aboard"]) for b in st["bays"])
    assert c.get("/live/vessels/NOPE/stowage").status_code == 404
