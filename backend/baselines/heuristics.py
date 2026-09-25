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

from data import calibration as C
from pricing.bid_price import wtp_survival_seg
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
    split_discount = 0.05     # inconvenience discount: consignment arrives
                            # in two parts — a split never fixes a price
                            # blocker, so it is offered last
    # Discounts below this are treated as noise. A counter wagers the
    # booking on the segment's counter_prob draw, so a counter is only
    # offered when its expected revenue beats the full-price accept's —
    # i.e. when the posted price sits deep enough in the WTP tail that a
    # bid-justified discount can win a customer the accept would lose.
    # Countering a near-certain accept would just torch the booking.
    MIN_COUNTER_DISCOUNT = 0.03

    def _engine(self, sim):
        """Bid-price engine if available (attach_pricer works under any
        pricing mode); None -> fall back to the fixed discount tiers."""
        eng = getattr(sim, "pricer", None)
        if eng is None:
            try:
                eng = sim.attach_pricer()
            except Exception:
                eng = None
        return eng

    def _discount(self, req, opt, eng, fallback: float,
                  ref=None) -> float:
        """Bid-price-justified discount (plan §2.8) if the engine says the
        alternative is meaningfully cheaper capacity, else the fixed tier."""
        if eng is not None:
            disc, _ = eng.counter_discount(req, opt, ref)
            if disc >= self.MIN_COUNTER_DISCOUNT:
                return disc
        return fallback

    def decide_booking(self, req: BookingRequest, sim) -> BookingDecision:
        dec = super().decide_booking(req, sim)
        eng = self._engine(sim)
        if dec.kind is DecisionKind.ACCEPT:
            return self._maybe_counter(req, sim, dec, eng)
        return self._counter_on_reject(req, sim, dec, eng)

    def _maybe_counter(self, req: BookingRequest, sim,
                       dec: BookingDecision, eng) -> BookingDecision:
        """Proactive counter: before accepting at full price, check whether
        another option (a different in-window sailing, or an alt-hub
        discharge) is materially cheaper capacity. If the bid-justified
        discount raises expected revenue, offer it instead of ACCEPT."""
        opt = req.options[dec.option_idx]
        seg = req.segment.value
        cprob = C.SEGMENTS[seg]["counter_prob"]
        mkt = max(req.market_rate, 1.0)
        price = sim.quote(req, opt)
        ev_accept = price * wtp_survival_seg(seg, price / mkt)
        cands = [(DecisionKind.FLEX_WINDOW, i, o, self.flex_discount)
                 for i, o in enumerate(req.options) if i != dec.option_idx]
        cands += [(DecisionKind.ALT_HUB, i, o, self.alt_discount)
                  for i, o in enumerate(req.alt_options)]
        best = None
        for kind, i, alt, fallback in cands:
            if not sim.feasible(req, alt):
                continue
            disc = self._discount(req, alt, eng, fallback, ref=opt)
            p = sim.quote(req, alt) * (1.0 - disc)
            ev = p * cprob * wtp_survival_seg(seg, p / mkt)
            if ev > ev_accept and (best is None or ev > best[0]):
                best = (ev, kind, i, disc)
        if best is None:
            return dec
        return BookingDecision(best[1], option_idx=best[2],
                               discount_pct=round(best[3], 4))

    def _counter_on_reject(self, req: BookingRequest, sim,
                           dec: BookingDecision, eng) -> BookingDecision:
        """Counter the reject by what blocks it: any fitting alternative
        (a sailing outside the flex window, or an alt-hub discharge) gets a
        discount-bearing counter — offer the one with the highest expected
        revenue; only a true capacity shortage -> SPLIT (a split cannot
        fix a price blocker, so it never leads)."""
        seg = req.segment.value
        cprob = C.SEGMENTS[seg]["counter_prob"]
        mkt = max(req.market_rate, 1.0)
        cands = [(DecisionKind.FLEX_WINDOW, i, opt, self.flex_discount)
                 for i, opt in enumerate(req.options)
                 if not opt.within_flex and sim.feasible(req, opt)]
        cands += [(DecisionKind.ALT_HUB, i, opt, self.alt_discount)
                  for i, opt in enumerate(req.alt_options)
                  if sim.feasible(req, opt)]
        best = None
        for kind, i, opt, fallback in cands:
            disc = self._discount(req, opt, eng, fallback)
            p = sim.quote(req, opt) * (1.0 - disc)
            ev = p * cprob * wtp_survival_seg(seg, p / mkt)
            if best is None or ev > best[0]:
                best = (ev, kind, i, disc)
        if best is not None:
            return BookingDecision(best[1], option_idx=best[2],
                                   discount_pct=best[3])
        # capacity blocker: split across a pair of departures that can each
        # take their half of the consignment. If no pair fits, the offer
        # could never be fulfilled — plain reject rather than a
        # guaranteed-declined counter.
        if len(req.options) >= 2:
            teu_a = max(1, int(round(req.teu * 0.6)))
            w_a = req.weight_t * teu_a / req.teu
            for i in range(len(req.options)):
                for j in range(i + 1, len(req.options)):
                    if sim.feasible(req, req.options[i], teu_a, w_a) and \
                            sim.feasible(req, req.options[j],
                                         req.teu - teu_a, req.weight_t - w_a):
                        return BookingDecision(
                            DecisionKind.SPLIT, option_idx=i, second_idx=j,
                            split_frac=0.6, discount_pct=self.split_discount)
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
