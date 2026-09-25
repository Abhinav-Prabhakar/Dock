"""Deal terms for Dock conditional-booking settlements.

When a booking closes via a conditional counter-offer (flex_window /
alt_hub / split) it becomes a "deal" with written settlement terms:
the departure window the carrier promised, the delivery deadline, and
the penalty (in basis points) for a carrier-late departure. These terms
are what gets locked on-chain at registration — keep them honest and
simple.
"""

from __future__ import annotations

from Crypto.Hash import keccak

#: Half-width of the acceptable departure window (carrier grace, days).
WINDOW_HALF_DAYS = 2.0
#: Latest delivery allowed, measured from the option's board day; covers
#: the longest leg in the fleet schedule.
DELIVERY_LEAD_DAYS = 45.0
#: Carrier-late discount credit, basis points (1000 = 10%).
PENALTY_BPS = 1000


def make_deal_terms(request_dict: dict, option_board_day: float,
                    option_discharge_eta: float | None,
                    decision_kind: str) -> dict:
    """The deal's promises, derived from the accepted option.

    ``request_dict`` / ``option_discharge_eta`` / ``decision_kind`` are
    accepted for context/future kinds but the terms are intentionally
    uniform: every deal promises the same window and deadline shape.
    """
    return {
        "window_lo": max(0.0, option_board_day - WINDOW_HALF_DAYS),
        "window_hi": option_board_day + WINDOW_HALF_DAYS,
        "delivery_deadline": option_board_day + DELIVERY_LEAD_DAYS,
        "penalty_bps": PENALTY_BPS,
    }


def deal_id(request_id: int, episode_tag: str) -> bytes:
    """Stable 32-byte deal identifier: keccak256("{tag}:{request_id}")."""
    k = keccak.new(digest_bits=256)
    k.update(f"{episode_tag}:{request_id}".encode())
    return k.digest()
