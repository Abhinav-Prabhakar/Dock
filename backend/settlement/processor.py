"""Bridges Simulator events to the settlement chain.

Subscribes to a Simulator's ``events`` list (``fn(event: dict)``) and, for
conditional deals (flex_window / alt_hub / split bookings), drives the
on-chain lifecycle: registerDeal -> confirmDeparture -> confirmDelivery ->
settle. Every chain interaction is re-emitted as a ``settlement.*`` event so
the episode ledger records the real tx hashes alongside the sim events.
"""

from __future__ import annotations

from .chain import SettlementChain
from .terms import deal_id, make_deal_terms

CONTRACT_KINDS = {"flex_window", "alt_hub", "split"}
OUTCOME_NAMES = {0: "settled_full", 1: "settled_penalty", 2: "refunded"}


class SettlementProcessor:
    """Per-episode: one deployed contract + the deals registered on it.

    ``emit`` is the episode's event sink (usually EpisodeManager's
    broadcast+ledger append). ``chain=None`` runs a pass-through mode for
    environments without web3 — deals still record terms and outcomes but
    carry no tx refs (tests use this)."""

    def __init__(self, episode_tag: str, emit, chain: SettlementChain | None):
        self.tag = episode_tag
        self.emit = emit
        self.chain = chain
        self.deals: dict[str, dict] = {}        # request_id(str) -> deal rec
        self._by_rid: dict[int, str] = {}       # request_id -> deal_id hex

    # -- helpers ---------------------------------------------------------

    def _tx_meta(self, rec: dict | None) -> dict:
        if not rec:
            return {}
        return {"tx_hash": rec["tx_hash"], "block": rec["block"],
                "gas_used": rec["gas_used"], "contract": rec["contract"]}

    # -- subscriber ------------------------------------------------------

    def __call__(self, ev: dict) -> None:
        t = ev["type"]
        if t == "cargo.booked":
            self._on_booked(ev)
        elif t == "departure.confirmed":
            self._on_departure(ev)
        elif t == "delivery.confirmed":
            self._on_delivery(ev)
        elif t == "episode.end":
            self._on_episode_end(float(ev.get("day", 0.0)))

    # -- event handlers --------------------------------------------------

    def _on_booked(self, ev: dict) -> None:
        """cargo.booked fires once per booked leg (split books twice — the
        board_call disambiguates the deal id)."""
        if ev.get("kind") not in CONTRACT_KINDS:
            return
        rid = int(ev["request_id"])
        call = int(ev.get("board_call") or 0)
        did = deal_id(rid, f"{self.tag}:{call}").hex()
        terms = make_deal_terms(
            ev, float(ev.get("board_day") or ev["req_dep_day"]),
            ev.get("discharge_day_est"), ev["kind"])
        # contract requires registerDay > 0 (0 marks "no deal")
        reg_day = float(max(1.0, ev["day"]))
        rec = {"deal_id": did, "request_id": rid, "kind": ev["kind"],
               "origin": ev["origin"], "dest": ev["dest"], "teu": ev["teu"],
               "price_usd": float(ev.get("price") or 0.0),
               "segment": ev.get("segment"), "status": "registered",
               "terms": terms, "register_day": reg_day,
               "actual_departure": None, "actual_delivery": None,
               "settled_outcome": None, "settled_amount_usd": None,
               "contract": None, "tx": {}}
        if self.chain is not None:
            try:
                tx = self.chain.register_deal(
                    bytes.fromhex(did), rid, reg_day, terms,
                    rec["price_usd"], int(round(ev["teu"])))
                rec["tx"]["register"] = self._tx_meta(tx)
                rec["contract"] = tx["contract"]
            except Exception as e:      # chain failure must not kill the sim
                rec["status"] = "register_failed"
                rec["error"] = str(e)
        self.deals[did] = rec
        self._by_rid[(rid, call)] = did
        self.emit("settlement.deal_registered",
                  deal_id=did, request_id=rid, kind=ev["kind"],
                  origin=ev["origin"], dest=ev["dest"], teu=ev["teu"],
                  price_usd=rec["price_usd"], segment=ev.get("segment"),
                  vessel_id=ev.get("vessel_id"),
                  board_day=ev.get("board_day"),
                  discharge_eta=ev.get("discharge_day_est"),
                  terms=terms, contract=rec["contract"],
                  tx_hash=rec["tx"].get("register", {}).get("tx_hash"))

    def _on_departure(self, ev: dict) -> None:
        rid = int(ev.get("request_id") or -1)
        did = self._by_rid.get((rid, int(ev.get("call_idx") or -1)))
        if not did:
            return
        d = self.deals[did]
        d["actual_departure"] = float(ev["actual_day"])
        if d["status"] == "registered":
            d["status"] = "departed"
        if self.chain is not None and d["contract"]:
            try:
                tx = self.chain.confirm_departure(bytes.fromhex(did),
                                                float(ev["actual_day"]))
                d["tx"]["departure"] = self._tx_meta(tx)
            except Exception as e:
                d["error"] = str(e)
        self.emit("settlement.departure_recorded", deal_id=did,
                  request_id=rid, actual_day=ev["actual_day"],
                  planned_etd=ev.get("planned_etd"),
                  tx_hash=d["tx"].get("departure", {}).get("tx_hash"))

    def _on_delivery(self, ev: dict) -> None:
        rid = int(ev.get("request_id") or -1)
        did = self._by_rid.get((rid, int(ev.get("board_call") or -1)))
        if not did:
            return
        d = self.deals[did]
        d["actual_delivery"] = float(ev["actual_day"])
        if d["status"] in ("registered", "departed"):
            d["status"] = "delivered"
        if self.chain is not None and d["contract"]:
            try:
                tx = self.chain.confirm_delivery(bytes.fromhex(did),
                                               float(ev["actual_day"]))
                d["tx"]["delivery"] = self._tx_meta(tx)
            except Exception as e:
                d["error"] = str(e)
        self.emit("settlement.delivery_recorded", deal_id=did,
                  request_id=rid, actual_day=ev["actual_day"],
                  tx_hash=d["tx"].get("delivery", {}).get("tx_hash"))
        self._settle(did, float(ev["actual_day"]))

    def _settle(self, did: str, current_day: float) -> None:
        d = self.deals[did]
        if self.chain is not None and d["contract"]:
            try:
                tx = self.chain.settle(bytes.fromhex(did), current_day)
                d["tx"]["settle"] = self._tx_meta(tx)
                d["settled_outcome"] = OUTCOME_NAMES.get(tx["outcome"])
                d["settled_amount_usd"] = tx["amount_cents"] / 100.0
                d["status"] = "settled"
            except Exception as e:
                d["error"] = str(e)
        else:
            # offline mirror of the contract's settle() rules
            t = d["terms"]
            if d["actual_delivery"] is not None:
                if (d["actual_departure"] or 0.0) <= t["window_hi"]:
                    oc, amt = "settled_full", d["price_usd"] * d["teu"]
                else:
                    oc = "settled_penalty"
                    amt = (d["price_usd"] * d["teu"]
                           * (10_000 - t["penalty_bps"]) / 10_000)
            elif current_day > t["delivery_deadline"]:
                oc, amt = "refunded", 0.0
            else:
                return
            d["settled_outcome"], d["settled_amount_usd"] = oc, amt
            d["status"] = "settled"
        if d["status"] == "settled":
            self.emit("settlement.settled", deal_id=did,
                      request_id=d["request_id"],
                      outcome=d["settled_outcome"],
                      amount_usd=d["settled_amount_usd"],
                      tx_hash=d["tx"].get("settle", {}).get("tx_hash"))

    def _on_episode_end(self, day: float) -> None:
        # refund anything still open past its delivery deadline
        for did, d in self.deals.items():
            if d["status"] in ("registered", "departed") \
                    and day > d["terms"]["delivery_deadline"]:
                self._settle(did, day)
