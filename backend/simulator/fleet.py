"""Vessel state and forward scheduling for the Dock simulator.

A vessel sails its closed port loop continuously. Its future is a stream of
port calls; leg `i` is the sailing between call `i` (departure) and call
`i+1` (arrival). Bookable capacity is tracked per leg — a booking boarding at
call i and discharging at call j consumes capacity on legs i..j-1.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from constraints.stowage import StowagePlan
from data import calibration as C

SEA = "sea"
PORT = "port"

BAYS = 64                    # stowage model granularity (plan §2.6: 2D grid)


@dataclass
class VesselSpec:
    vessel_id: str
    capacity_teu: int
    reefer_plugs: int
    min_speed_kt: float
    service_speed_kt: float
    max_speed_kt: float
    fuel_a_tpd: float
    fuel_b_tpd: float
    age_years: int
    loop: list[str]


@dataclass
class Call:
    idx: int                   # global call index on this vessel's schedule
    port: str
    planned_etd: float         # day index (float) — drifts with disruptions
    leg_distance_nm: float     # distance to NEXT call


@dataclass
class LegCap:
    """Remaining bookable capacity on one leg."""
    teu: float
    weight_t: float
    reefer: int


class VesselState:
    def __init__(self, spec: VesselSpec, horizon_days: float,
                 phase_day: float, port_dwell: dict[str, float]):
        self.spec = spec
        self.loop = spec.loop
        self.speed_kt = spec.service_speed_kt
        self.mode = PORT
        self.port = spec.loop[0]
        self.next_event_day = phase_day      # first departure time
        self.at_call_idx = 0                 # berthed at calls[0] (loop[0])
        self.sailing_to_call = -1            # call idx we are heading to
        self.port_dwell = port_dwell

        # projected plan: all accepted containers, tagged by board/discharge
        bay_h = max(4, spec.capacity_teu // BAYS)
        self.stowage = StowagePlan(BAYS, bay_h, spec.reefer_plugs)

        # forward call schedule
        self.calls: list[Call] = []
        self._build_calls(horizon_days, phase_day)

        self.own_lift_teu = spec.capacity_teu * C.OWN_LIFT_SHARE \
            * (1.0 - C.STOWAGE_BUFFER)
        self.legs: dict[int, LegCap] = {}
        # containers aboard per leg, for empty-mile metrics
        self.onboard_teu = 0

    # ------------------------------------------------------------------
    # Schedule
    # ------------------------------------------------------------------

    def _build_calls(self, horizon_days: float, phase_day: float) -> None:
        """Forward schedule of port calls at service speed. Planned times are
        a prior; actual days drift with speed choices, congestion, storms."""
        k = len(self.loop)
        t = phase_day
        idx = 0
        # first call: vessel is berthed at loop[0], departs at phase_day
        while t < horizon_days + 60.0:
            port = self.loop[idx % k]
            nxt = self.loop[(idx + 1) % k]
            self.calls.append(Call(idx, port, t,
                                   C.DISTANCES_NM[(port, nxt)]))
            t += C.DISTANCES_NM[(port, nxt)] / (self.spec.service_speed_kt
                                                * 24.0)
            t += self.port_dwell[nxt]
            idx += 1

    def leg_cap(self, leg_idx: int) -> LegCap:
        if leg_idx not in self.legs:
            self.legs[leg_idx] = LegCap(
                teu=self.own_lift_teu,
                weight_t=self.own_lift_teu * C.TONNES_PER_TEU_MAX,
                reefer=int(self.spec.reefer_plugs * C.OWN_LIFT_SHARE))
        return self.legs[leg_idx]

    # ------------------------------------------------------------------
    # Queries used by demand matching / policies
    # ------------------------------------------------------------------

    def upcoming_calls(self, port: str, day_lo: float, day_hi: float):
        """Calls at `port` departing within [day_lo, day_hi]."""
        out = []
        for c in self.calls:
            if c.port == port and day_lo <= c.planned_etd <= day_hi:
                out.append(c)
        return out

    def next_call_at(self, call_idx: int, port: str) -> Call | None:
        """First call after `call_idx` whose port == `port`."""
        for i in range(call_idx + 1, len(self.calls)):
            if self.calls[i].port == port:
                return self.calls[i]
        return None

    def legs_between(self, board_call: int, discharge_call: int) -> tuple[int, ...]:
        return tuple(range(board_call, discharge_call))

    def has_capacity(self, legs: tuple[int, ...], teu: float,
                     weight_t: float, is_reefer: bool) -> bool:
        for li in legs:
            cap = self.leg_cap(li)
            if cap.teu < teu or cap.weight_t < weight_t:
                return False
            if is_reefer and cap.reefer < teu:
                return False
        return True

    def consume(self, legs: tuple[int, ...], teu: float, weight_t: float,
                is_reefer: bool) -> None:
        for li in legs:
            cap = self.leg_cap(li)
            cap.teu -= teu
            cap.weight_t -= weight_t
            if is_reefer:
                cap.reefer -= int(teu)

    def eta_days(self, call_idx: int, speed_kt: float) -> float:
        """Sailing days for the leg departing at `call_idx`."""
        return self.calls[call_idx].leg_distance_nm / (speed_kt * 24.0)

    def fuel_tpd(self, at_sea: bool) -> float:
        if not at_sea:
            return 4.0                       # auxiliary / hotel load in port
        return self.spec.fuel_a_tpd + self.spec.fuel_b_tpd * self.speed_kt ** 3
