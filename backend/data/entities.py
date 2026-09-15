"""Static entity generators: ports, vessels, voyage schedules."""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import calibration as C


def build_ports() -> pd.DataFrame:
    """Port master table."""
    rows = []
    for (pid, name, lat, lon, berths, cap, cong, tz, dwell, wait) in C.PORTS:
        rows.append({
            "port_id": pid,
            "name": name,
            "lat": lat,
            "lon": lon,
            "berths": berths,
            "daily_capacity_teu": cap,
            "base_congestion": cong,
            "tz_offset": tz,
            "mean_dwell_days": dwell,
            "base_wait_hours": wait,
        })
    return pd.DataFrame(rows)


def build_vessels() -> pd.DataFrame:
    """Vessel master table with cubic fuel curves fuel_tpd = a + b*v^3.

    fuel_b is fixed by the reference burn at service speed (with the
    speed-independent 'hotel' component a = 15% of it); this reproduces the
    industry slow-steaming figure of ~35-50% fuel saved between 18 and 14 kt.
    """
    rows = []
    for (vid, name, cap, reefer, vmin, vserv, vmax, age, draft, ref_burn) in C.VESSELS:
        a = 0.15 * ref_burn
        b = (ref_burn - a) / (vserv ** 3)
        rows.append({
            "vessel_id": vid,
            "name": name,
            "capacity_teu": cap,
            "reefer_plugs": reefer,
            "min_speed_kt": vmin,
            "service_speed_kt": vserv,
            "max_speed_kt": vmax,
            "fuel_a_tpd": round(a, 4),
            "fuel_b_tpd": round(b, 8),
            "age_years": age,
            "draft_m": draft,
            "loop": ">".join(C.VESSEL_LOOPS[vid]),
        })
    return pd.DataFrame(rows)


def build_voyages(rng: np.random.Generator, vessels: pd.DataFrame,
                  ports: pd.DataFrame) -> pd.DataFrame:
    """Voyage schedule: one row per leg (port call -> next port call).

    A voyage is one full traversal of a vessel's closed port rotation.
    Each vessel sails continuously from SCHEDULE_START to SCHEDULE_END with
    a randomized phase offset so departures are staggered across the fleet.

    Columns: voyage_id, vessel_id, leg_seq, origin_port, dest_port,
    etd (departure), eta (arrival), distance_nm, own_lift_teu (bookable own
    capacity on that leg = capacity * OWN_LIFT_SHARE * (1-STOWAGE_BUFFER)).
    """
    dwell = ports.set_index("port_id")["mean_dwell_days"]
    sched_days = float((C.SCHEDULE_END - C.SCHEDULE_START)
                       / np.timedelta64(1, "D"))
    records = []
    for v in vessels.itertuples():
        loop = C.VESSEL_LOOPS[v.vessel_id]
        n_calls = len(loop)
        # Leg sea time at service speed, in days (float).
        leg_days = [C.DISTANCES_NM[(loop[i], loop[(i + 1) % n_calls])]
                    / (v.service_speed_kt * 24.0) for i in range(n_calls)]
        loop_days = sum(leg_days) + sum(float(dwell[p]) for p in loop)
        # Random phase so the fleet isn't synchronized. `t` is float days
        # since SCHEDULE_START (numpy datetime64 rejects float arithmetic).
        t = float(rng.uniform(0.0, min(loop_days, 14.0)))
        voyage_no = 1
        while t < sched_days:
            voyage_id = f"{v.vessel_id}-V{voyage_no:03d}"
            for i in range(n_calls):
                origin = loop[i]
                dest = loop[(i + 1) % n_calls]
                sea_days = leg_days[i]
                records.append({
                    "voyage_id": voyage_id,
                    "vessel_id": v.vessel_id,
                    "leg_seq": i,
                    "origin_port": origin,
                    "dest_port": dest,
                    "etd": t,
                    "eta": t + sea_days,
                    "distance_nm": C.DISTANCES_NM[(origin, dest)],
                    "own_lift_teu": round(v.capacity_teu * C.OWN_LIFT_SHARE
                                        * (1.0 - C.STOWAGE_BUFFER)),
                })
                # next call departs after dwell at destination
                t = t + sea_days + float(dwell[dest])
            voyage_no += 1

    df = pd.DataFrame(records)
    base = pd.Timestamp(C.SCHEDULE_START)
    df["etd"] = base + pd.to_timedelta(df["etd"], unit="D")
    df["eta"] = base + pd.to_timedelta(df["eta"], unit="D")
    df = df.sort_values(["vessel_id", "voyage_id", "leg_seq"]).reset_index(drop=True)
    return df


def departure_calendar(voyages: pd.DataFrame) -> dict[tuple[str, str], dict]:
    """For each OD pair: arrays of candidate (departure etd, voyage_id, leg_seq)
    for every port call at `origin` where `dest` is called later in the same
    voyage. Used to attach bookings to own-vessel sailings.
    """
    cal: dict[tuple[str, str], dict] = {}
    for voyage_id, grp in voyages.groupby("voyage_id", sort=False):
        grp = grp.sort_values("leg_seq")
        calls = list(grp.itertuples())
        # calls[i] is the port call at calls[i].origin_port departing at etd.
        # A booking (o, d) can board at call i if o == calls[i].origin_port
        # and d appears as origin of a later call j>i (its arrival port).
        for i, call in enumerate(calls):
            later_ports = {c.origin_port for c in calls[i + 1:]}
            for d in later_ports:
                key = (call.origin_port, d)
                entry = cal.setdefault(key, {"etd": [], "voyage_id": [],
                                           "leg_seq": [], "lift": []})
                entry["etd"].append(call.etd)
                entry["voyage_id"].append(voyage_id)
                entry["leg_seq"].append(call.leg_seq)
                entry["lift"].append(call.own_lift_teu)
    for key, e in cal.items():
        order = np.argsort(np.array(e["etd"], dtype="datetime64[ns]"))
        e["etd"] = np.array(e["etd"], dtype="datetime64[ns]")[order]
        e["voyage_id"] = np.array(e["voyage_id"])[order]
        e["leg_seq"] = np.array(e["leg_seq"])[order]
        e["lift"] = np.array(e["lift"])[order]
    return cal
