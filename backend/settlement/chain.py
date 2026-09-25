"""In-process EVM settlement chain for Dock deals.

Wraps a real PyEVM (eth-tester) backend via web3.py: the DockSettlement
contract is deployed once per instance (one contract per episode) and
this object is the oracle that writes departure/delivery confirmations
and triggers settlement. Everything returned comes from real mined
transaction receipts — tx hashes, block numbers, gas used.
"""

from __future__ import annotations

import json
from pathlib import Path

from Crypto.Hash import keccak
from eth_tester import PyEVMBackend
from web3 import Web3
from web3.providers.eth_tester import EthereumTesterProvider

ARTIFACT = Path(__file__).parent / "artifacts" / "DockSettlement.json"

#: Status enum indexes, mirroring DockSettlement.Status.
STATUS_NAMES = (
    "Registered",
    "Departed",
    "Delivered",
    "SettledFull",
    "SettledPenalty",
    "Refunded",
)
REGISTERED, DEPARTED, DELIVERED, SETTLED_FULL, SETTLED_PENALTY, REFUNDED = (
    range(6))

#: Settle() outcome codes, mirroring the contract's emitted values.
OUTCOME_FULL, OUTCOME_PENALTY, OUTCOME_REFUND = 0, 1, 2

#: Field order of the public `deals(bytes32)` getter (struct field order).
_DEAL_FIELDS = (
    "requestHash", "registerDay", "windowLo", "windowHi",
    "deliveryDeadline", "priceCents", "teu", "penaltyBps", "status",
    "actualDeparture", "actualDelivery", "settledAmountCents",
)


def _day(day: float) -> int:
    """Sim days are floats; the contract stores uint64 day numbers."""
    return int(round(day))


def _keccak256(data: bytes) -> bytes:
    k = keccak.new(digest_bits=256)
    k.update(data)
    return k.digest()


class SettlementChain:
    """One deployed DockSettlement contract on a private PyEVM chain."""

    def __init__(self) -> None:
        artifact = json.loads(ARTIFACT.read_text())
        backend = PyEVMBackend()
        self.w3 = Web3(EthereumTesterProvider(backend))
        self.acct = self.w3.eth.accounts[0]

        factory = self.w3.eth.contract(abi=artifact["abi"],
                                       bytecode=artifact["bytecode"])
        tx_hash = factory.constructor().transact({"from": self.acct})
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash)
        self.address = receipt.contractAddress
        self.contract = self.w3.eth.contract(address=self.address,
                                             abi=artifact["abi"])

    # ------------------------------------------------------------------
    # oracle writes
    # ------------------------------------------------------------------
    def register_deal(self, deal_id: bytes, request_id: int,
                      register_day: float, terms: dict, price_usd: float,
                      teu: int) -> dict:
        """Lock a deal's terms on-chain. ``price_usd`` is per-TEU dollars,
        stored as integer cents."""
        request_hash = _keccak256(f"request:{request_id}".encode())
        price_cents = int(round(price_usd * 100))
        return self._send(
            self.contract.functions.registerDeal,
            deal_id, request_hash, _day(register_day),
            _day(terms["window_lo"]), _day(terms["window_hi"]),
            _day(terms["delivery_deadline"]), price_cents, int(teu),
            int(terms["penalty_bps"]),
        )

    def confirm_departure(self, deal_id: bytes, actual_day: float) -> dict:
        return self._send(self.contract.functions.confirmDeparture,
                          deal_id, _day(actual_day))

    def confirm_delivery(self, deal_id: bytes, actual_day: float) -> dict:
        return self._send(self.contract.functions.confirmDelivery,
                          deal_id, _day(actual_day))

    def settle(self, deal_id: bytes, current_day: float) -> dict:
        """Settle a deal; includes the decoded Settled event outcome and
        payout amount (cents)."""
        out = self._send(self.contract.functions.settle,
                         deal_id, _day(current_day))
        receipt = self.w3.eth.get_transaction_receipt(out["tx_hash"])
        events = self.contract.events.Settled().process_receipt(receipt)
        if events:
            args = events[0]["args"]
            out["outcome"] = int(args["outcome"])
            out["amount_cents"] = int(args["amountCents"])
        return out

    # ------------------------------------------------------------------
    # reads
    # ------------------------------------------------------------------
    def deal_state(self, deal_id: bytes) -> dict:
        """The on-chain Deal struct as a dict; ``status`` is the enum
        index (0=Registered .. 5=Refunded), ``status_name`` its label."""
        row = self.contract.functions.deals(deal_id).call()
        state = dict(zip(_DEAL_FIELDS, row))
        state["status_name"] = STATUS_NAMES[state["status"]]
        return state

    @property
    def chain_height(self) -> int:
        """Latest mined block number."""
        return self.w3.eth.block_number

    def deal_count(self) -> int:
        return int(self.contract.functions.dealCount().call())

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------
    def _send(self, fn, *args) -> dict:
        """Transact an oracle call and return real receipt fields.
        Reverts raise (ContractLogicError) — callers see the failure."""
        tx_hash = fn(*args).transact({"from": self.acct})
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash)
        if receipt.status != 1:
            raise RuntimeError(
                f"tx {tx_hash.hex()} failed on-chain (status=0)")
        return {
            "tx_hash": tx_hash.to_0x_hex(),
            "block": int(receipt.blockNumber),
            "gas_used": int(receipt.gasUsed),
            "contract": self.address,
        }
