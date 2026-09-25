"""Metrics accumulator for simulator episodes (plan.md §7 dashboard)."""

from __future__ import annotations

from collections import Counter, defaultdict


class MetricsTracker:
    def __init__(self) -> None:
        self.outcomes: Counter = Counter()
        self.revenue = 0.0
        self.fuel_cost = 0.0
        self.carbon_cost = 0.0
        self.port_fees = 0.0
        self.demurrage_cost = 0.0
        self.reposition_cost = 0.0
        self.lease_cost = 0.0
        self.roll_compensation = 0.0

        self.n_requests = 0
        self.n_accepted = 0
        self.n_rejected = 0
        self.n_countered = 0
        self.n_counter_won = 0
        self.n_rolled = 0

        self.teu_booked = 0.0          # accepted + counter-won volume
        self.teu_nm_carried = 0.0      # laden container-miles
        self.capacity_nm = 0.0         # own-lift capacity that sailed
        self.empty_teu_nm = 0.0        # repositioned empty container-miles
        self.co2_tonnes = 0.0
        self.fuel_tonnes = 0.0
        self.leased_containers = 0.0
        self.repositioned_teu = 0.0

        self.by_segment = defaultdict(lambda: {"requests": 0, "booked": 0})
        self.decision_log: list[dict] = []

    def report(self) -> dict:
        profit = (self.revenue - self.fuel_cost - self.carbon_cost
                  - self.port_fees - self.demurrage_cost
                  - self.reposition_cost - self.lease_cost
                  - self.roll_compensation)
        denom = max(self.teu_booked, 1.0)
        return {
            "revenue_usd": round(self.revenue, 0),
            "profit_usd": round(profit, 0),
            "costs": {
                "fuel": round(self.fuel_cost, 0),
                "carbon": round(self.carbon_cost, 0),
                "port_fees": round(self.port_fees, 0),
                "demurrage": round(self.demurrage_cost, 0),
                "reposition": round(self.reposition_cost, 0),
                "lease": round(self.lease_cost, 0),
                "roll_comp": round(self.roll_compensation, 0),
            },
            "revenue_per_teu": round(self.revenue / denom, 1),
            "utilization": round(self.teu_nm_carried
                                 / max(self.capacity_nm, 1.0), 4),
            "requests": self.n_requests,
            "accepted": self.n_accepted,
            "rejected": self.n_rejected,
            "countered": self.n_countered,
            "counter_win_rate": round(
                self.n_counter_won / max(self.n_countered, 1), 3),
            "reject_to_counter_conv": round(
                self.n_counter_won / max(self.n_requests - self.n_accepted, 1),
                3),
            "rolled_bookings": self.n_rolled,
            "teu_booked": round(self.teu_booked, 0),
            "empty_teu_nm": round(self.empty_teu_nm, 0),
            "co2_per_teu": round(self.co2_tonnes / denom, 3),
            "fuel_tonnes": round(self.fuel_tonnes, 0),
            "leased_containers": round(self.leased_containers, 0),
            "repositioned_teu": round(self.repositioned_teu, 0),
            "outcomes": dict(self.outcomes),
            "segments": {k: dict(v) for k, v in self.by_segment.items()},
        }
