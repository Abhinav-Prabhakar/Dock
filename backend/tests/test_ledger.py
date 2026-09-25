"""Tests for the append-only, tamper-evident event ledger."""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from ledger.store import ZERO_HASH, Ledger, canonical_json, keccak256


def _make(path, n_events=5):
    led = Ledger(path, meta={"episode": "test"})
    for i in range(n_events):
        led.append("tick", day=float(i), value=i)
    return led


def _read_lines(path):
    return path.read_text(encoding="utf-8").splitlines()


def _write_lines(path, lines):
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_keccak_known_vector():
    # Keccak-256 of the empty string (differs from NIST sha3_256).
    assert keccak256(b"") == (
        "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")


def test_canonical_json():
    assert canonical_json({"b": 1, "a": 2}) == b'{"a":2,"b":1}'


def test_genesis_header(tmp_path):
    p = tmp_path / "ep.jsonl"
    led = Ledger(p, meta={"episode": 7})
    first = json.loads(_read_lines(p)[0])
    assert first["seq"] == 0
    assert first["type"] == "genesis"
    assert first["meta"] == {"episode": 7}
    assert first["prev_hash"] == ZERO_HASH
    assert first["hash"] == keccak256(canonical_json(
        {k: v for k, v in first.items() if k != "hash"}))
    assert len(led) == 0  # genesis is not an event


def test_write_and_verify(tmp_path):
    p = tmp_path / "ep.jsonl"
    led = _make(p, 5)
    assert len(led) == 5
    seqs = [r["seq"] for r in led.records()]
    assert seqs == list(range(6))  # genesis seq 0 + events seq 1..5
    res = Ledger.verify(p)
    assert res["ok"], res
    assert res["n_events"] == 5
    assert res["first_bad_seq"] is None


def test_records_and_tail(tmp_path):
    p = tmp_path / "ep.jsonl"
    led = _make(p, 4)
    recs = led.records()
    assert len(recs) == 5 and recs[0]["type"] == "genesis"
    tail = led.tail(2)
    assert [r["seq"] for r in tail] == [3, 4]
    assert tail[-1]["type"] == "tick"


def test_tamper_payload_detected(tmp_path):
    p = tmp_path / "ep.jsonl"
    _make(p, 5)
    lines = _read_lines(p)
    rec = json.loads(lines[3])
    rec["value"] = 9999  # edit a payload field; stored hash now stale
    lines[3] = json.dumps(rec, sort_keys=True, separators=(",", ":"))
    _write_lines(p, lines)
    res = Ledger.verify(p)
    assert not res["ok"]
    assert res["first_bad_seq"] == 3


def test_delete_middle_line_detected(tmp_path):
    p = tmp_path / "ep.jsonl"
    _make(p, 5)
    lines = _read_lines(p)
    del lines[3]  # remove the seq-3 record entirely
    _write_lines(p, lines)
    res = Ledger.verify(p)
    assert not res["ok"]
    # chain is broken at the record after the gap (seq 4 sits at index 3)
    assert res["first_bad_seq"] == 4


def test_truncate_tail(tmp_path):
    """A cleanly truncated file keeps an intact chain: verify() alone
    reports ok=True for the remaining prefix — suffix loss is only
    detectable against an expected event count (expected_n)."""
    p = tmp_path / "ep.jsonl"
    _make(p, 5)
    lines = _read_lines(p)
    _write_lines(p, lines[:3])  # keep genesis + 2 events
    res = Ledger.verify(p)
    assert res["ok"] and res["n_events"] == 2
    res2 = Ledger.verify(p, expected_n=5)
    assert not res2["ok"] and "count mismatch" in res2["detail"]
    # a torn (mid-line) truncation IS detected: corrupt JSON
    _write_lines(p, lines[:3] + [lines[3][:20]])
    res3 = Ledger.verify(p)
    assert not res3["ok"]


def test_reopen_for_read_via_verify(tmp_path):
    """Single-writer: readers reopen the path through Ledger.verify
    (no second writer instance needed)."""
    p = tmp_path / "ep.jsonl"
    _make(p, 3)
    res = Ledger.verify(p)  # pure read, no Ledger() construction
    assert res["ok"] and res["n_events"] == 3
    # Reconstructing a Ledger on an existing path resumes the chain —
    # it must NOT write a second genesis line.
    n_lines = len(_read_lines(p))
    led2 = Ledger(p)
    assert len(_read_lines(p)) == n_lines
    rec = led2.append("tick", day=99.0, value=99)
    assert rec["seq"] == 4
    assert Ledger.verify(p)["ok"]


def test_reserved_payload_keys_rejected(tmp_path):
    led = Ledger(tmp_path / "ep.jsonl")
    with pytest.raises(ValueError):
        led.append("tick", day=0.0, seq=99)


def test_concurrent_appends(tmp_path):
    p = tmp_path / "ep.jsonl"
    led = Ledger(p)
    with ThreadPoolExecutor(max_workers=4) as ex:
        list(ex.map(lambda i: led.append("tick", day=float(i), value=i),
                  range(40)))
    assert len(led) == 40
    assert Ledger.verify(p)["ok"]
