"""Order store + /orders validation, against a real (test) Postgres, with no
live simulation running (DOCK_LIVE=0 in conftest).

Covers the contract the customer site relies on before any pricing happens,
that there is no fallback when the live simulation is down, and a
regression test for the concurrent-id race (ids used to be MAX+1 in app
code, so parallel POSTs collided on the primary key). The quote -> accept
flow itself is in test_quotes.py.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from server import orders as order_store
from server.app import create_app

GOOD = dict(origin="CNSHA", dest="NLRTM", teu=4, weight_t=40.0,
            cargo_type="dry", segment="standard", req_dep_day=10.0,
            flex_days=2)


@pytest.fixture(scope="module")
def client(migrated_db):
    with TestClient(create_app()) as c:
        c.delete("/orders")
        yield c


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


def test_no_live_simulation_is_503_not_a_fallback(client):
    r = client.post("/orders", json=GOOD)
    assert r.status_code == 503
    assert client.get("/orders").json() == []      # nothing stored


def test_missing_order_is_404(client):
    assert client.get("/orders/BK-0-TC").status_code == 404


def test_order_ids_are_unique_under_concurrency(migrated_db):
    with ThreadPoolExecutor(max_workers=16) as pool:
        ids = list(pool.map(lambda _: order_store.next_id(), range(64)))
    assert len(set(ids)) == 64
    assert all(i.startswith("BK-") and i.endswith("-TC") for i in ids)
