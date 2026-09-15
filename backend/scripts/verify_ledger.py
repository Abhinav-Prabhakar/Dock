"""Standalone ledger verifier.

Usage (from backend/):
    python -m scripts.verify_ledger <path.jsonl> [--expect N]

Prints a per-line progress summary and a final verdict.
Exit code 0 = chain intact, 1 = tampered/corrupt/missing.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Allow running both as `python -m scripts.verify_ledger` (cwd on sys.path)
# and directly as `python scripts/verify_ledger.py`.
_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from ledger.store import Ledger  # noqa: E402


def _short(h, width=18):
    return h[:width] + "…" if isinstance(h, str) and len(h) > width else h


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="verify_ledger",
        description="Verify a hash-chained event ledger (.jsonl).")
    ap.add_argument("path", help="path to the ledger .jsonl file")
    ap.add_argument("--expect", type=int, default=None, metavar="N",
                    help="require exactly N events (detects tail "
                         "truncation; excludes the genesis header)")
    args = ap.parse_args(argv)

    def progress(index, record, ok, detail):
        if record is None:
            print(f"  line {index:>4}: <unparseable>            FAIL  {detail}")
            return
        seq = record.get("seq", "?")
        rtype = record.get("type", "?")
        h = _short(record.get("hash"))
        status = "ok" if ok else f"FAIL  {detail}"
        print(f"  seq  {seq:>4}  {rtype:<18} {h:<20} {status}")

    print(f"verifying {args.path}")
    result = Ledger.verify(args.path, expected_n=args.expect,
                           on_record=progress)
    print("-" * 72)
    print(f"verdict: {'OK' if result['ok'] else 'FAILED'}  "
          f"events={result['n_events']}  "
          f"first_bad_seq={result['first_bad_seq']}  "
          f"{result['detail']}")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
