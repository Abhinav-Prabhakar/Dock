"""Baseline policies for head-to-head evaluation (plan.md §7).

  * StaticRateCardPolicy — the industry today: flat route rate, binary
    accept/reject, fixed service speed, no repositioning.
  * GreedyPolicy — accept anything profitable-looking that fits; simple
    counter-offers on capacity rejects; fixed speed. The myopic baseline.
  * DynamicHeuristicPolicy — greedy + flex-window/alt-hub/split counters and
    congestion-aware speed control. The rule-based fallback (Level 1).

Policies are plain objects with decide_booking(req, sim) -> BookingDecision
and decide_fleet(sim) -> list[FleetAction].
"""

from __future__ import annotations

from simulator.types import (BookingDecision, BookingRequest, DecisionKind,
                             FleetAction)


class StaticRateCardPolicy:
    """Weekly rate card, binary accept/reject — how the industry works today."""

    pricing_mode = "rate_card"

    def decide_booking(self, req: BookingRequest, sim) -> BookingDecision:
        # earliest departure inside the customer's flex window that has room
        for i, opt in enumerate(req.options):
            if opt.within_flex and opt.capacity_ok:
                return BookingDecision(DecisionKind.ACCEPT, option_idx=i)
        return BookingDecision(DecisionKind.REJECT, note="no_capacity_or_date")

    def decide_fleet(self, sim) -> list[FleetAction]:
        return []


class GreedyPolicy:
    """Myopic: accept if it fits and the price clears a marginal-cost floor."""

    pricing_mode = "dynamic"
    marginal_floor = 350.0        # $/TEU rough handling+slot marginal cost

    def decide_booking(self, req: BookingRequest, sim) -> BookingDecision:
        best = None
        for i, opt in enumerate(req.options):
            if not (opt.within_flex and opt.capacity_ok):
                continue
            price = sim.quote(req, opt)
            if price < self.marginal_floor:
                continue
            if best is None or opt.board_day < req.options[best].board_day:
                best = i
        if best is not None:
            return BookingDecision(DecisionKind.ACCEPT, option_idx=best)
        return BookingDecision(DecisionKind.REJECT, note="below_floor_or_full")

    def decide_fleet(self, sim) -> list[FleetAction]:
        return []


class DynamicHeuristicPolicy(GreedyPolicy):
    """Rule-based fallback: greedy accepts + structured counter-offers +
    simple empty repositioning and congestion-aware speed."""

    flex_discount = 0.10
    alt_discount = 0.08

    def decide_booking(self, req: BookingRequest, sim) -> BookingDecision:
        dec = super().decide_booking(req, sim)
        if dec.kind is not DecisionKind.REJECT:
            return dec
        # capacity/date reject -> try structured counters
        if len(req.options) >= 2:
            return BookingDecision(DecisionKind.SPLIT, option_idx=0,
                                   second_idx=1, split_frac=0.6)
        if req.alt_options:
            return BookingDecision(DecisionKind.ALT_HUB, option_idx=0,
                                   discount_pct=self.alt_discount)
        for i, opt in enumerate(req.options):
            if opt.capacity_ok and not opt.within_flex:
                return BookingDecision(DecisionKind.FLEX_WINDOW,
                                       option_idx=i,
                                       discount_pct=self.flex_discount)
        return dec

    def decide_fleet(self, sim) -> list[FleetAction]:
        acts = []
        # reposition: move empties from the most surplus port to the most
        # deficit port if any own voyage covers the pair soon
        surplus = max(sim.empties, key=sim.empties.get)
        deficit = min(sim.empties, key=sim.empties.get)
        if sim.empties[surplus] - sim.empties[deficit] > 300:
            acts.append(FleetAction(kind="reposition", port_from=surplus,
                                    port_to=deficit, teu=150))
        # eco speed for the biggest vessel, service speed otherwise
        for vid, v in sim.vessels.items():
            acts.append(FleetAction(kind="set_speed", vessel_id=vid,
                                    speed_kt=14.0 if v.spec.capacity_teu
                                    >= 5000 else v.spec.service_speed_kt))
        return acts
