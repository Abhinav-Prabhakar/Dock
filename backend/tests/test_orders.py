"""Order store + /orders API, against a real (test) Postgres.

Lean on purpose: the round-trip, the validation contract the customer site
relies on, and a regression test for the concurrent-id race (order ids used
to be MAX+1 in app code, so parallel POSTs collided on the primary key).
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from server import orders as order_store
from server.app import create_app

GOOD = dict(origin="CNSHA", dest="NLRTM", teu=4, weight_t=40.0,
            cargo_type="dry", segment="standard", req_dep_day=20.0,
            flex_days=2)


@pytest.fixture(scope="module")
def client(migrated_db):
    with TestClient(create_app()) as c:
        c.delete("/orders")
        yield c


def test_round_trip(client):
    r = client.post("/orders", json=GOOD)
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["id"].startswith("BK-") and created["id"].endswith("-TC")
    assert created["status"] == "PENDING REVIEW"

    got = client.get(f"/orders/{created['id']}")
    assert got.status_code == 200
    assert got.json()["origin"] == "CNSHA"
    assert created["id"] in [o["id"] for o in client.get("/orders").json()]


def test_list_is_newest_first(client):
    a = client.post("/orders", json=GOOD).json()["id"]
    b = client.post("/orders", json=GOOD).json()["id"]
    ids = [o["id"] for o in client.get("/orders").json()]
    assert ids.index(b) < ids.index(a)


@pytest.mark.parametrize("patch, needle", [
    ({"origin": "XXXXX"}, "unknown origin"),
    ({"dest": "USNYC", "origin": "NLRTM"}, "no servable OD pair"),
    ({"cargo_type": "livestock"}, "cargo_type"),
    ({"segment": "vip"}, "segment"),
    ({"req_dep_day": 0.0}, "req_dep_day"),
])
def test_validation_rejects(client, patch, needle):
    r = client.post("/orders", json={**GOOD, **patch})
    assert r.status_code == 422
    assert needle in r.text


def test_missing_order_is_404(client):
    assert client.get("/orders/BK-0-TC").status_code == 404


def test_concurrent_creates_get_unique_ids(migrated_db):
    body = order_store.OrderIn(**GOOD)
    with ThreadPoolExecutor(max_workers=16) as pool:
        recs = list(pool.map(lambda _: order_store.create_order(body), range(32)))
    ids = [r["id"] for r in recs]
    assert len(set(ids)) == len(ids) == 32
