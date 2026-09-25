"""Stowage solver invariants (plan.md §2.6 — hard constraints, never learned)."""

from __future__ import annotations

import pytest

from constraints.stowage import StowagePlan

DRY, REEFER, HAZ = "dry", "reefer", "hazmat"


@pytest.fixture
def plan() -> StowagePlan:
    return StowagePlan(n_bays=8, bay_height=4, reefer_plugs=2)


class TestCapacity:
    def test_capacity_and_free_slots(self, plan):
        assert plan.capacity == 32
        assert plan.free_slots == 32
        plan.place(5, 0, 3, 10, DRY)
        assert plan.free_slots == 27
        assert plan.used == 5

    def test_stack_height_limit(self):
        sp = StowagePlan(1, 2, 0)
        assert sp.place(2, 0, 5, 10, DRY)
        assert not sp.can_place(1, 0, 5, 10, DRY)

    def test_can_place_does_not_mutate(self, plan):
        before = [list(b.slots) for b in plan.bays]
        plan.can_place(3, 0, 5, 10, DRY)
        assert [list(b.slots) for b in plan.bays] == before
        assert plan.used == 0


class TestDischargeOrdering:
    def test_later_discharge_cannot_cover_earlier(self):
        sp = StowagePlan(1, 3, 0)
        sp.place(1, board_call=0, discharge_call=6, weight_each_t=10,
                 cargo_type=DRY)
        # new container discharging at 4 must go on top -> ok (4 <= 6, lighter)
        assert sp.can_place(1, board_call=1, discharge_call=4,
                            weight_each_t=8, cargo_type=DRY)
        # new container discharging at 9 can NOT go on top of the dis-6 one
        assert not sp.can_place(1, board_call=1, discharge_call=9,
                                weight_each_t=8, cargo_type=DRY)

    def test_earlier_discharge_stacks_on_later(self):
        sp = StowagePlan(1, 3, 0)
        assert sp.place(1, 0, 8, 15, DRY)
        assert sp.place(1, 1, 4, 10, DRY)     # earlier + lighter on top
        assert sp.bays[0].slots[-1].discharge_call == 4

    def test_top_at_respects_board_call(self):
        sp = StowagePlan(2, 3, 0)
        # container boarding at call 5 (future) must not block a placement
        # evaluated at call 1
        sp.place(1, board_call=5, discharge_call=9, weight_each_t=30,
                 cargo_type=DRY)
        assert sp.can_place(1, board_call=1, discharge_call=3,
                            weight_each_t=10, cargo_type=DRY)

    def test_same_call_weight_pairing(self):
        sp = StowagePlan(1, 3, 0)
        sp.place(1, board_call=0, discharge_call=9, weight_each_t=5,
                 cargo_type=DRY)
        # 20t discharging earlier than the 5t -> would sit on top -> illegal
        assert not sp.can_place(1, 0, 4, 20, DRY)
        # 10t discharging later -> sits below the 5t -> legal
        sp2 = StowagePlan(1, 3, 0)
        sp2.place(1, 0, 4, 5, DRY)
        assert sp2.can_place(1, 0, 9, 10, DRY)


class TestCargoTypes:
    def test_reefer_requires_powered_bay(self):
        sp = StowagePlan(3, 3, 1)
        assert sp.place(1, 0, 5, 8, REEFER)
        assert not sp.can_place(1, 0, 5, 8, REEFER)   # plugs exhausted

    def test_reefer_plug_capacity(self):
        sp = StowagePlan(6, 4, 2)
        assert sp.place(2, 0, 5, 8, REEFER)
        assert not sp.can_place(1, 0, 5, 8, REEFER)

    def test_hazmat_designated_bays_only(self):
        sp = StowagePlan(4, 3, 0)
        assert sp.place(1, 0, 4, 10, HAZ)
        used_bays = [b.idx for b in sp.bays if b.slots]
        assert all(sp.bays[i].hazmat_ok for i in used_bays)

    def test_non_hazmat_barred_from_hazmat_bays(self):
        sp = StowagePlan(4, 1, 0)             # height 1 -> every bay 1 slot
        n_dry = sum(1 for b in sp.bays if not b.hazmat_ok)
        assert sp.can_place(n_dry, 0, 5, 10, DRY)
        assert not sp.can_place(n_dry + 1, 0, 5, 10, DRY)

    def test_hazmat_bay_exclusivity(self):
        # a bay holding hazmat cannot also hold dry
        sp = StowagePlan(4, 3, 0)
        haz_bay = next(b for b in sp.bays if b.hazmat_ok)
        sp.place(1, 0, 4, 10, HAZ)
        assert haz_bay.slots
        # force-can_place into that bay manually via private API check:
        from constraints.stowage import Slot
        assert not sp._can_stack(haz_bay, Slot(0, 5, 8, DRY))


class TestDischarge:
    def test_discharge_through_removes_and_recounts(self, plan):
        plan.place(3, board_call=0, discharge_call=4, weight_each_t=10,
                   cargo_type=DRY)
        plan.place(2, board_call=0, discharge_call=9, weight_each_t=10,
                   cargo_type=DRY)
        n = plan.discharge_through(4)
        assert n == 3
        assert plan.used == 2

    def test_onboard_now(self, plan):
        plan.place(2, board_call=0, discharge_call=4, weight_each_t=10,
                   cargo_type=DRY)
        plan.place(1, board_call=2, discharge_call=8, weight_each_t=10,
                   cargo_type=DRY)
        assert plan.onboard_now(3) == 3      # call 3: all three aboard
        assert plan.onboard_now(5) == 1      # two discharged at call 4
