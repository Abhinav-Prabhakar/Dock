"""Append-only, tamper-evident event ledger.

Canonical record of a live episode: each event is chained to the previous
one via a Keccak-256 hash over its canonical JSON encoding, so any edit,
deletion, or reorder of history is detectable by `Ledger.verify`.
"""

from ledger.store import Ledger, canonical_json, keccak256

__all__ = ["Ledger", "canonical_json", "keccak256"]
