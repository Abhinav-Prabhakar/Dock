"""DockSettlement on a real in-process EVM (eth-tester PyEVM via web3).

Covers the full deal lifecycle: register -> depart -> deliver -> settle,
the penalty and refund branches, wrong-order reverts, deal isolation,
and that receipts carry real mined-transaction fields.
"""

from __future__ import annotations

import pytest

pytest.importorskip("web3")
pytest.importorskip("eth_tester")

from settlement.chain import (DEPARTED, DELIVERED, OUTCOME_FULL,
                              OUTCOME_PENALTY, OUTCOME_REFUND, REGISTERED,
                              REFUNDED, SETTLED_FULL, SETTLED_PENALTY,
                              SettlementChain)
from settlement.terms import deal_id, make_deal_terms

EP = "ep-test"
BOARD_DAY = 10.0          # window [8, 12], deadline 55
PRICE_USD = 1200.0        # per TEU -> 120_000 cents
TEU = 3
FULL_CENTS = 120_000 * TEU            # 360_000
PENALTY_CENTS = FULL_CENTS * 9_000 // 10_000  # 10% penalty -> 324_000


@pytest.fixture
def chain() -> SettlementChain:
    """Fresh PyEVM chain + freshly deployed contract per test."""
    return SettlementChain()


def _register(chain: SettlementChain, request_id: int,
              board_day: float = BOARD_DAY, price: float = PRICE_USD,
              teu: int = TEU) -> tuple[bytes, dict]:
    terms = make_deal_terms({}, board_day, None, "flex_window")
    did = deal_id(request_id, EP)
    receipt = chain.register_deal(did, request_id, board_day, terms,
                                  price, teu)
    return did, terms, receipt


def _assert_receipt(r: dict, chain: SettlementChain) -> None:
    assert isinstance(r["tx_hash"], str) and r["tx_hash"].startswith("0x")
    assert len(r["tx_hash"]) == 66
    assert isinstance(r["block"], int) and r["block"] >= 1
    assert isinstance(r["gas_used"], int) and r["gas_used"] > 0
    assert r["contract"] == chain.address


class TestTerms:
    def test_terms_shape(self):
        terms = make_deal_terms({}, 20.0, 33.0, "alt_hub")
        assert terms == {"window_lo": 18.0, "window_hi": 22.0,
                         "delivery_deadline": 65.0, "penalty_bps": 1000}

    def test_window_lo_floors_at_zero(self):
        terms = make_deal_terms({}, 1.0, None, "split")
        assert terms["window_lo"] == 0.0
        assert terms["window_hi"] == 3.0

    def test_deal_id_deterministic_32_bytes(self):
        a = deal_id(42, "ep0")
        assert a == deal_id(42, "ep0")
        assert isinstance(a, bytes) and len(a) == 32
        assert a != deal_id(43, "ep0") != deal_id(42, "ep1")


class TestLifecycle:
    def test_happy_path_settles_full(self, chain):
        did, terms, r = _register(chain, request_id=7)
        _assert_receipt(r, chain)
        assert chain.deal_state(did)["status"] == REGISTERED

        dep = chain.confirm_departure(did, 11.0)   # inside [8, 12]
        _assert_receipt(dep, chain)
        assert chain.deal_state(did)["status"] == DEPARTED
        assert chain.deal_state(did)["actualDeparture"] == 11

        dl = chain.confirm_delivery(did, 25.0)
        _assert_receipt(dl, chain)
        assert chain.deal_state(did)["status"] == DELIVERED
        assert chain.deal_state(did)["actualDelivery"] == 25

        s = chain.settle(did, 25.0)
        _assert_receipt(s, chain)
        assert s["outcome"] == OUTCOME_FULL
        assert s["amount_cents"] == FULL_CENTS

        state = chain.deal_state(did)
        assert state["status"] == SETTLED_FULL
        assert state["status_name"] == "SettledFull"
        assert state["settledAmountCents"] == FULL_CENTS
        assert state["teu"] == TEU
        assert state["priceCents"] == 120_000
        assert state["windowLo"] == 8 and state["windowHi"] == 12
        assert state["deliveryDeadline"] == 55
        assert state["penaltyBps"] == 1000

    def test_late_departure_settles_with_penalty(self, chain):
        did, _, _ = _register(chain, request_id=8)
        chain.confirm_departure(did, 13.0)         # after window_hi (12)
        chain.confirm_delivery(did, 30.0)

        s = chain.settle(did, 30.0)
        assert s["outcome"] == OUTCOME_PENALTY
        assert s["amount_cents"] == PENALTY_CENTS
        assert s["amount_cents"] < FULL_CENTS

        state = chain.deal_state(did)
        assert state["status"] == SETTLED_PENALTY
        assert state["settledAmountCents"] == PENALTY_CENTS

    def test_never_departs_refunds_after_deadline(self, chain):
        did, terms, _ = _register(chain, request_id=9)
        s = chain.settle(did, terms["delivery_deadline"] + 1.0)
        assert s["outcome"] == OUTCOME_REFUND
        assert s["amount_cents"] == 0

        state = chain.deal_state(did)
        assert state["status"] == REFUNDED
        assert state["actualDeparture"] == 0
        assert state["actualDelivery"] == 0
        assert state["settledAmountCents"] == 0


class TestWrongOrder:
    def test_delivery_before_departure_reverts(self, chain):
        did, _, _ = _register(chain, request_id=10)
        with pytest.raises(Exception):
            chain.confirm_delivery(did, 20.0)

    def test_settle_before_delivery_and_deadline_reverts(self, chain):
        did, _, _ = _register(chain, request_id=11)
        chain.confirm_departure(did, 11.0)
        with pytest.raises(Exception):
            chain.settle(did, 30.0)   # departed but not delivered, < 55

    def test_settle_registered_before_deadline_reverts(self, chain):
        did, _, _ = _register(chain, request_id=12)
        with pytest.raises(Exception):
            chain.settle(did, 20.0)

    def test_duplicate_register_reverts(self, chain):
        did, terms, _ = _register(chain, request_id=13)
        with pytest.raises(Exception):
            chain.register_deal(did, 13, BOARD_DAY, terms, PRICE_USD, TEU)

    def test_departure_after_refund_reverts(self, chain):
        did, terms, _ = _register(chain, request_id=14)
        chain.settle(did, terms["delivery_deadline"] + 5.0)
        with pytest.raises(Exception):
            chain.confirm_departure(did, 11.0)


class TestIsolation:
    def test_two_deals_do_not_interfere(self, chain):
        did_a, _, _ = _register(chain, request_id=20)
        did_b, terms_b, _ = _register(chain, request_id=21)
        assert did_a != did_b
        assert chain.deal_count() == 2

        # Deal A: full lifecycle. Deal B: untouched until refund.
        chain.confirm_departure(did_a, 9.0)
        chain.confirm_delivery(did_a, 22.0)
        sa = chain.settle(did_a, 22.0)
        sb = chain.settle(did_b, terms_b["delivery_deadline"] + 1.0)

        assert sa["outcome"] == OUTCOME_FULL
        assert sa["amount_cents"] == FULL_CENTS
        assert sb["outcome"] == OUTCOME_REFUND
        assert sb["amount_cents"] == 0

        assert chain.deal_state(did_a)["status"] == SETTLED_FULL
        assert chain.deal_state(did_b)["status"] == REFUNDED
        assert chain.deal_state(did_b)["actualDeparture"] == 0


class TestReceipts:
    def test_blocks_advance_and_gas_is_real(self, chain):
        did, _, r1 = _register(chain, request_id=30)
        r2 = chain.confirm_departure(did, 10.0)
        r3 = chain.confirm_delivery(did, 20.0)
        r4 = chain.settle(did, 20.0)
        for r in (r1, r2, r3, r4):
            _assert_receipt(r, chain)
        blocks = [r["block"] for r in (r1, r2, r3, r4)]
        assert blocks == sorted(blocks) and len(set(blocks)) == 4
        assert len({r["tx_hash"] for r in (r1, r2, r3, r4)}) == 4
        assert chain.chain_height == r4["block"]
