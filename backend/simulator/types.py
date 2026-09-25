"""Core types for the Dock simulator: booking requests, decisions, actions.

A `BookingRequest` is what a policy sees when a shipper asks for capacity.
A `BookingDecision` is what the policy returns. The simulator owns customer
response (accept iff quote <= willingness-to-pay) and all physical dynamics.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class CargoType(str, Enum):
    DRY = "dry"
    REEFER = "reefer"
    HAZMAT = "hazmat"


class Segment(str, Enum):
    FLEXIBLE = "flexible"
    STANDARD = "standard"
    URGENT = "urgent"


class DecisionKind(str, Enum):
    ACCEPT = "accept"
    REJECT = "reject"
    FLEX_WINDOW = "flex_window"        # discount for a later/earlier departure
    ALT_HUB = "alt_hub"                # discount to discharge at alternate hub
    SPLIT = "split"                    # split TEU across two departures


@dataclass
class VoyageOption:
    """One own-fleet carriage option: board at call `board_call`, discharge
    at `discharge_call`, occupying every leg index in between."""
    vessel_id: str
    board_call: int
    discharge_call: int
    board_day: float
    discharge_day_est: float
    legs: tuple[int, ...]
    within_flex: bool                  # board_day inside customer's flex window
    capacity_ok: bool = True           # per-leg TEU/weight/reefer check passed


@dataclass
class BookingRequest:
    request_id: int
    day: float
    origin: str
    dest: str
    teu: int
    weight_t: float                  # total tonnes
    cargo_type: CargoType
    segment: Segment
    wtp_per_teu: float               # customer willingness-to-pay (hidden state)
    market_rate: float               # current spot rate $/TEU on this route
    req_dep_day: float               # requested departure day
    flex_days: int                   # +/- departure window customer tolerates
    options: list[VoyageOption] = field(default_factory=list)
    alt_options: list[VoyageOption] = field(default_factory=list)  # alt-hub dest
    alt_dest: str | None = None


@dataclass
class BookingDecision:
    kind: DecisionKind
    option_idx: int = 0              # index into options (or alt_options)
    discount_pct: float = 0.0        # flex-window / alt-hub discount
    split_frac: float = 0.5          # fraction of TEU on primary option
    second_idx: int = 1              # second option for SPLIT
    note: str = ""


@dataclass
class FleetAction:
    """Periodic fleet-level action.

    kind="set_speed":   vessel_id + speed_kt (applies at next departure)
    kind="reposition":  port_from -> port_to, `teu` empty containers moved on
                        the next own-vessel departure covering that pair.
    """
    kind: str
    vessel_id: str | None = None
    speed_kt: float | None = None
    port_from: str | None = None
    port_to: str | None = None
    teu: int = 0
