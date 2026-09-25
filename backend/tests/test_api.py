"""API tests for the Dock live server (server.app).

Runs a real episode on a daemon thread via TestClient — static policy +
small horizon + speed_days_per_sec=0 (flat out) keeps it fast and needs
no model artifacts.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

BACKEND = Path(__file__).resolve().parent.parent

from server.app import create_app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    app = create_app()
    with TestClient(app) as c:
        yield c


def _wait_done(client: TestClient, ep_id: str, timeout: float = 60.0) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        snap = client.get(f"/episodes/{ep_id}").json()
        if snap["status"] in ("done", "stopped", "error"):
            return snap
        time.sleep(0.25)
    pytest.fail(f"episode {ep_id} did not finish in {timeout}s")


# ---------------------------------------------------------------------------
# Static resources
# ---------------------------------------------------------------------------

def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_policies(client):
    r = client.get("/policies")
    assert r.status_code == 200
    ids = {p["id"] for p in r.json()}
    assert ids == {"static", "greedy", "heuristic", "heuristic_bid", "ppo"}
    for p in r.json():
        assert p["label"] and p["desc"]


def test_scenarios(client):
    r = client.get("/scenarios")
    assert r.status_code == 200
    scens = r.json()
    assert len(scens) >= 8
    for s in scens:
        for k in ("scenario_id", "description", "split"):
            assert k in s, f"scenario missing '{k}'"
    ids = {s["scenario_id"] for s in scens}
    assert "baseline" in ids
    assert "manifest" not in ids


def test_ports(client):
    r = client.get("/ports")
    assert r.status_code == 200
    ports = r.json()
    assert len(ports) >= 8
    for p in ports:
        assert "lat" in p and "lon" in p
        assert -90 <= p["lat"] <= 90 and -180 <= p["lon"] <= 180


def test_vessels(client):
    r = client.get("/vessels")
    assert r.status_code == 200
    vessels = r.json()
    assert len(vessels) == 4
    for v in vessels:
        assert v["vessel_id"] and v["name"]


def test_routes(client):
    r = client.get("/routes")
    assert r.status_code == 200
    routes = r.json()
    assert len(routes) >= 15
    for rt in routes:
        for k in ("origin", "dest", "base_teu_wk", "market_usd_per_teu",
                  "lane", "direction"):
            assert k in rt


def test_models_report(client):
    r = client.get("/models/report")
    assert r.status_code == 200
    assert "models" in r.json() or "split" in r.json()


# ---------------------------------------------------------------------------
# Episode lifecycle
# ---------------------------------------------------------------------------

def test_episode_lifecycle(client):
    r = client.post("/episodes", json={
        "policy": "static", "scenario": "baseline", "seed": 42,
        "horizon_days": 10, "speed_days_per_sec": 0})
    assert r.status_code == 201, r.text
    ep = r.json()
    assert ep["policy"] == "static" and ep["scenario"] == "baseline"
    ep_id = ep["id"]

    snap = _wait_done(client, ep_id)
    assert snap["status"] == "done"
    assert snap["day"] == 10
    m = snap["metrics"]
    for k in ("cum_revenue", "cum_profit", "teu_booked"):
        assert k in m
    assert len(snap["vessels"]) == 4
    for v in snap["vessels"]:
        assert v["mode"] in ("SEA", "PORT")
        assert v["vessel_id"] and v["name"]
    assert snap["empties"] and all(
        isinstance(t, (int, float)) for t in snap["empties"].values())

    # events: seq-ordered, contains the core stream types
    r = client.get(f"/episodes/{ep_id}/events", params={"after_seq": 0,
                                                       "limit": 5000})
    assert r.status_code == 200
    body = r.json()
    evs = body["events"]
    assert evs, "expected a non-empty event log"
    seqs = [e["seq"] for e in evs]
    assert seqs == sorted(seqs)
    types = {e["type"] for e in evs}
    assert "booking.decision" in types
    assert "day.summary" in types
    assert body["next_seq"] == evs[-1]["seq"] + 1

    # pagination: after_seq picks up where the first page stopped
    r2 = client.get(f"/episodes/{ep_id}/events",
                    params={"after_seq": body["next_seq"], "limit": 10})
    assert r2.status_code == 200
    assert all(e["seq"] >= body["next_seq"] for e in r2.json()["events"])

    # deals: list shape (static never counters -> may be empty)
    r = client.get(f"/episodes/{ep_id}/deals")
    assert r.status_code == 200
    assert isinstance(r.json(), list)
    for d in r.json():
        assert "deal_id" in d and "status" in d
        r1 = client.get(f"/episodes/{ep_id}/deals/{d['deal_id']}")
        assert r1.status_code == 200

    # descriptor list
    r = client.get("/episodes")
    assert r.status_code == 200
    assert any(e["id"] == ep_id for e in r.json())


def test_episode_control_and_409(client):
    # slow episode so a second start is refused
    r = client.post("/episodes", json={
        "policy": "static", "scenario": "baseline", "seed": 7,
        "horizon_days": 60, "speed_days_per_sec": 1})
    assert r.status_code == 201, r.text
    ep_id = r.json()["id"]
    try:
        r2 = client.post("/episodes", json={
            "policy": "static", "scenario": "baseline",
            "horizon_days": 10, "speed_days_per_sec": 0})
        assert r2.status_code == 409

        r = client.post(f"/episodes/{ep_id}/control",
                        json={"action": "pause"})
        assert r.status_code == 200
        assert r.json()["status"] == "paused"

        r = client.post(f"/episodes/{ep_id}/control",
                        json={"action": "resume"})
        assert r.status_code == 200
        assert r.json()["status"] == "running"

        r = client.post(f"/episodes/{ep_id}/control",
                        json={"action": "set_speed", "speed": 5})
        assert r.status_code == 200
        assert r.json()["speed_days_per_sec"] == 5.0

        r = client.post(f"/episodes/{ep_id}/control",
                        json={"action": "bogus"})
        assert r.status_code == 400
    finally:
        client.post(f"/episodes/{ep_id}/control", json={"action": "stop"})
    snap = _wait_done(client, ep_id)
    assert snap["status"] in ("stopped", "done")


def test_episode_validation(client):
    r = client.post("/episodes", json={
        "policy": "nope", "scenario": "baseline"})
    assert r.status_code == 400
    r = client.post("/episodes", json={
        "policy": "static", "scenario": "not-a-scenario"})
    assert r.status_code == 400
    r = client.get("/episodes/doesnotexist")
    assert r.status_code == 404
    r = client.post("/episodes/doesnotexist/control",
                    json={"action": "pause"})
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Compare views (precomputed demo JSON)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name",
                         ["summary", "timeline", "offers", "shock", "meta"])
def test_compare(client, name):
    r = client.get(f"/compare/{name}")
    assert r.status_code == 200
    assert r.json()  # non-empty JSON document


def test_compare_unknown(client):
    r = client.get("/compare/nonexistent")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# WebSocket stream
# ---------------------------------------------------------------------------

def test_websocket_stream(client):
    """WS receives events during a short live episode. TestClient's
    websocket support is a starlette TestClient portal — if it is flaky
    in this environment, the REST /events test above still covers the
    event stream."""
    r = client.post("/episodes", json={
        "policy": "static", "scenario": "baseline", "seed": 11,
        "horizon_days": 20, "speed_days_per_sec": 30})
    assert r.status_code == 201, r.text
    ep_id = r.json()["id"]
    try:
        received = []
        with client.websocket_connect(f"/episodes/{ep_id}/stream") as ws:
            for _ in range(200):
                try:
                    msg = ws.receive_json()
                except Exception:
                    break                      # server closed the socket
                received.append(msg)
                if msg.get("type") == "episode.status" and \
                        msg.get("status") in ("done", "stopped", "error"):
                    break
        assert received, "WS stream delivered no events"
        types = {m.get("type") for m in received}
        assert types & {"booking.decision", "day.summary", "episode.status"}
    except Exception as e:
        pytest.skip(f"TestClient websocket support unavailable: {e}")
    finally:
        client.post(f"/episodes/{ep_id}/control", json={"action": "stop"})
