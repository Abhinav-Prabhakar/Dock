"""Stowage of one live vessel, for the operator console's 3D vessel and
stowage screens.

The simulator's stowage solver (constraints/stowage.py) models a vessel as
64 logical bays, each one stack of TEU slots tagged with board/discharge
call, weight and cargo type. This returns what is physically aboard *now*
(board_call <= current call < discharge_call), per bay, in stacking order —
latest discharge at the bottom, heavier below lighter — plus what's booked
to load at later calls and the vessel's upcoming port rotation. The 3D
layout (physical bay / row / tier) is the frontend's job.
"""

from __future__ import annotations

from data import calibration as C

VESSEL_NAMES = {row[0]: row[1] for row in C.VESSELS}


def vessel_name(vessel_id: str) -> str:
    return VESSEL_NAMES.get(vessel_id, vessel_id)


def _ctype(s) -> str:
    return getattr(s.cargo_type, "value", s.cargo_type)


def stowage_view(sim, v) -> dict:
    at = v.at_call_idx
    calls = v.calls
    port = lambda i: calls[i].port if 0 <= i < len(calls) else None  # noqa: E731
    bays = []
    aboard_teu = booked_teu = 0
    for b in v.stowage.bays:
        aboard = [s for s in b.slots if s.board_call <= at < s.discharge_call]
        later = [s for s in b.slots if s.board_call > at]
        aboard.sort(key=lambda s: (-s.discharge_call, -s.weight_t))
        aboard_teu += len(aboard)
        booked_teu += len(later)
        bays.append({
            "idx": b.idx, "powered": b.powered, "hazmat_ok": b.hazmat_ok,
            "aboard": [{"discharge": port(s.discharge_call),
                        "discharge_call": s.discharge_call,
                        "board": port(s.board_call),
                        "weight_t": round(s.weight_t, 1),
                        "cargo_type": _ctype(s)} for s in aboard],
            "booked_later": len(later),
        })
    upcoming = [{"idx": c.idx, "port": c.port,
                 "etd_day": round(c.planned_etd, 2)}
                for c in calls[at:at + 8]]
    return {
        "vessel_id": v.spec.vessel_id,
        "name": vessel_name(v.spec.vessel_id),
        "capacity_teu": v.spec.capacity_teu,
        "day": round(float(sim.day), 2),
        "mode": v.mode.upper(),
        "at_call": at, "port": port(at),
        "speed_kt": round(v.speed_kt, 2),
        "bay_height": v.stowage.bay_height,
        "aboard_teu": aboard_teu, "booked_later_teu": booked_teu,
        "upcoming_calls": upcoming,
        "bays": bays,
    }
