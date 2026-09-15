"""Append-only, tamper-evident event ledger (JSONL + Keccak-256 hash chain).

File format: one canonical-JSON record per line.

    line 0: {"seq":0,"type":"genesis","meta":{...},
             "prev_hash":"0x00...00","hash":<keccak>}
    line n: {"seq":n,"day":<float>,"type":<str>,...payload...,
             "prev_hash":<hash of line n-1>,"hash":<keccak>}

`hash` is always keccak256(canonical_json(record without the "hash" key)).

Verification recomputes every hash and checks seq continuity plus prev_hash
linkage, so edits, deletions, and reorders are all detected. Note that a
*cleanly truncated* file (tail lines removed) still verifies ok — the chain
cannot detect missing suffixes on its own; pass `expected_n` to `verify()`
to also assert the event count.

Single-writer: one `Ledger` instance should own a path at a time. Reopening
an existing path resumes the chain (no second genesis line); concurrent
writers on the same file are unsupported.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from Crypto.Hash import keccak

ZERO_HASH = "0x" + "0" * 64
_RESERVED = {"seq", "day", "type", "prev_hash", "hash"}


def keccak256(data: bytes) -> str:
    """'0x'-prefixed Keccak-256 hex digest (real Keccak, not NIST SHA3-256)."""
    h = keccak.new(digest_bits=256)
    h.update(data)
    return "0x" + h.hexdigest()


def canonical_json(obj: dict) -> bytes:
    """Deterministic encoding: sorted keys, compact separators, UTF-8."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


def _record_hash(record: dict) -> str:
    return keccak256(canonical_json({k: v for k, v in record.items()
                                    if k != "hash"}))


class Ledger:
    """Single-writer append-only ledger backed by a .jsonl file."""

    def __init__(self, path: str | Path, meta: dict | None = None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._seq = 0
        self._last_hash = ZERO_HASH
        if self.path.exists() and self.path.stat().st_size > 0:
            # Resume an existing ledger: adopt the last line's seq/hash.
            last = None
            with self.path.open("r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        last = line
            rec = json.loads(last)
            self._seq = int(rec["seq"])
            self._last_hash = rec["hash"]
        else:
            genesis = {"seq": 0, "type": "genesis", "meta": meta,
                       "prev_hash": ZERO_HASH}
            genesis["hash"] = _record_hash(genesis)
            self._write_line(genesis)
            self._last_hash = genesis["hash"]

    # -- writing -----------------------------------------------------------

    def _write_line(self, record: dict) -> None:
        with self.path.open("a", encoding="utf-8") as f:
            f.write(canonical_json(record).decode("utf-8") + "\n")
            f.flush()
            os.fsync(f.fileno())

    def append(self, event_type: str, day: float, **payload) -> dict:
        """Append an event record; returns the stored record (with hash)."""
        clash = _RESERVED & payload.keys()
        if clash:
            raise ValueError(f"payload uses reserved keys: {sorted(clash)}")
        with self._lock:
            record = {"seq": self._seq + 1, "day": day, "type": event_type,
                      **payload, "prev_hash": self._last_hash}
            record["hash"] = _record_hash(record)
            self._write_line(record)
            self._seq = record["seq"]
            self._last_hash = record["hash"]
            return dict(record)

    # -- reading -----------------------------------------------------------

    def __len__(self) -> int:
        """Number of appended events (excludes the seq-0 genesis header)."""
        return self._seq

    def records(self) -> list[dict]:
        """All records including the seq-0 genesis header."""
        out = []
        with self.path.open("r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    out.append(json.loads(line))
        return out

    def tail(self, n: int) -> list[dict]:
        """Last n records (including genesis if within range)."""
        return self.records()[-n:] if n > 0 else []

    # -- verification ------------------------------------------------------

    @staticmethod
    def verify(path: str | Path, expected_n: int | None = None,
               on_record=None) -> dict:
        """Recompute every hash and check seq/prev_hash linkage.

        Returns {"ok": bool, "n_events": int, "first_bad_seq": int|None,
                 "detail": str}. n_events excludes the genesis header.

        expected_n: if given, also require exactly this many events — this
        is how tail truncation is detected (the chain alone cannot see a
        missing suffix).

        on_record: optional callback(index, record|None, ok, detail) invoked
        per line for progress reporting.
        """
        path = Path(path)
        result = {"ok": True, "n_events": 0, "first_bad_seq": None,
                  "detail": ""}
        n_events = 0

        def fail(seq, detail, index, record):
            result["ok"] = False
            result["first_bad_seq"] = seq
            result["detail"] = detail
            result["n_events"] = n_events
            if on_record:
                on_record(index, record, False, detail)
            return result

        if not path.exists():
            return fail(None, f"ledger not found: {path}", -1, None)

        prev_hash = ZERO_HASH
        with path.open("r", encoding="utf-8") as f:
            index = -1
            for raw in f:
                if not raw.strip():
                    continue
                index += 1
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError as e:
                    return fail(index, f"line {index}: invalid JSON ({e})",
                                index, None)
                seq = rec.get("seq")
                if seq != index:
                    return fail(seq if isinstance(seq, int) else index,
                                f"line {index}: seq discontinuity "
                                f"(expected {index}, got {seq})",
                                index, rec)
                if index == 0:
                    if rec.get("type") != "genesis":
                        return fail(0, "line 0: missing genesis header",
                                    index, rec)
                    if rec.get("prev_hash") != ZERO_HASH:
                        return fail(0, "line 0: genesis prev_hash is not "
                                       "the zero hash", index, rec)
                else:
                    if rec.get("prev_hash") != prev_hash:
                        return fail(seq, f"seq {seq}: prev_hash does not "
                                         f"match previous record's hash",
                                    index, rec)
                stored = rec.get("hash")
                if not isinstance(stored, str) or stored != _record_hash(rec):
                    return fail(seq, f"seq {seq}: hash mismatch — record "
                                     f"content was tampered with",
                                index, rec)
                prev_hash = stored
                if index > 0:
                    n_events += 1
                if on_record:
                    on_record(index, rec, True, "ok")

        if index < 0:
            return fail(None, "empty ledger", -1, None)

        result["n_events"] = n_events
        if expected_n is not None and n_events != expected_n:
            result["ok"] = False
            result["detail"] = (f"event count mismatch: expected "
                                f"{expected_n}, found {n_events} "
                                f"(possible tail truncation)")
        else:
            result["detail"] = (f"ok: genesis + {n_events} event(s), "
                                f"hash chain intact")
        return result
