"""Stowage constraint solver — deterministic, non-learned (plan.md §2.6).

Model (hackathon simplification): a vessel is a set of bays, each bay a single
stack of containers. Constraints enforced:

  * destination-order stacking — a container may only sit on top of containers
    discharged at the same or a later port call (top of stack discharges
    first). Evaluated against the *projected* stack top at the new container's
    board call, so future bookings are checked consistently.
  * weight order — heavier below lighter within a stack.
  * stack height / slot capacity — hard slot limit per bay.
  * hazmat segregation — hazmat containers only in designated hazmat bays;
    hazmat bays hold hazmat exclusively (IMDG segregation simplified to
    bay-level separation).
  * reefer plugs — reefer containers only in powered bays; powered slot count
    is capped by the vessel's reefer plug count.

Containers are placed eagerly (at accept time) into the projected plan. The
projected plan always represents the furthest-known future state: every
accepted booking's containers are in their bays tagged with (board_call,
discharge_call). When checking a container boarding at call b, the effective
top of a bay is the container with the largest board_call < b that is still
aboard at b (discharge_call > b).
"""

from __future__ import annotations

from dataclasses import dataclass, field

# CargoType is a str-enum defined in simulator.types; comparing to string
# literals keeps this module import-free of the simulator package (avoids a
# circular import: simulator.fleet depends on this module).
HAZMAT = "hazmat"
REEFER = "reefer"
DRY = "dry"

MAX_HAZMAT_PER_BAY = 2


@dataclass
class Slot:
    """One TEU slot worth of stowed cargo."""
    board_call: int
    discharge_call: int
    weight_t: float
    cargo_type: str


@dataclass
class Bay:
    idx: int
    height: int                 # max containers
    powered: bool               # has reefer plugs
    hazmat_ok: bool             # designated dangerous-goods bay
    slots: list[Slot] = field(default_factory=list)


class StowagePlan:
    """Projected stowage plan for one vessel across its forward schedule."""

    def __init__(self, n_bays: int, bay_height: int, reefer_plugs: int):
        self.n_bays = n_bays
        self.bay_height = bay_height
        self.reefer_plugs = reefer_plugs
        # ~1/3 of bays powered, spread out; hazmat bays = non-adjacent subset
        # of unpowered bays (reefer/hazmat don't share a bay).
        self.bays: list[Bay] = []
        for i in range(n_bays):
            powered = (i % 3 == 0)
            hazmat_ok = (not powered) and (i % 5 == 1)
            self.bays.append(Bay(i, bay_height, powered, hazmat_ok))
        # capacity used counters for O(1) gross checks
        self.used = 0
        self.reefer_used = 0
        self.hazmat_used = 0

    # -- internal ------------------------------------------------------------

    def _top_at(self, bay: Bay, board_call: int) -> Slot | None:
        """Projected top container of `bay` at the moment call `board_call`
        departs: the last-boarded container that is still aboard then."""
        top = None
        for s in bay.slots:
            if s.board_call < board_call and s.discharge_call > board_call:
                if top is None or s.board_call > top.board_call:
                    top = s
        return top

    def _can_stack(self, bay: Bay, slot: Slot) -> bool:
        if len(bay.slots) >= bay.height:
            return False
        if slot.cargo_type is HAZMAT:
            if not bay.hazmat_ok:
                return False
            if sum(1 for s in bay.slots
                   if s.discharge_call > slot.board_call) >= MAX_HAZMAT_PER_BAY:
                return False
        elif bay.hazmat_ok:
            # keep designated hazmat bays exclusive
            return False
        if slot.cargo_type is REEFER:
            if not bay.powered:
                return False
            if self.reefer_used >= self.reefer_plugs:
                return False
        top = self._top_at(bay, slot.board_call)
        if top is not None:
            # new container discharges first -> must sit on top and be lighter
            if not (slot.discharge_call <= top.discharge_call
                    and slot.weight_t <= top.weight_t):
                return False
        # same-call co-boarders: load order is free, but while both are
        # aboard the earlier-discharging one must be on top AND lighter
        for s in bay.slots:
            if s.board_call != slot.board_call:
                continue
            if s.discharge_call < slot.discharge_call \
                    and not s.weight_t <= slot.weight_t:
                return False
            if s.discharge_call > slot.discharge_call \
                    and not slot.weight_t <= s.weight_t:
                return False
        return True

    def _place(self, bay: Bay, slot: Slot) -> None:
        bay.slots.append(slot)
        self.used += 1
        if slot.cargo_type is REEFER:
            self.reefer_used += 1
        elif slot.cargo_type is HAZMAT:
            self.hazmat_used += 1

    def _pick_bay(self, slot: Slot) -> Bay | None:
        """First-fit on the tightest legal stack top: prefer the bay whose
        projected top discharges earliest after `slot` (keeps stacks sorted
        and preserves flexible bays for future placements)."""
        best = None
        best_key = None
        for bay in self.bays:
            if not self._can_stack(bay, slot):
                continue
            top = self._top_at(bay, slot.board_call)
            key = (top.discharge_call if top else 1 << 30, -len(bay.slots))
            if best is None or key < best_key:
                best, best_key = bay, key
        return best

    # -- public API ------------------------------------------------------------

    @property
    def capacity(self) -> int:
        return self.n_bays * self.bay_height

    @property
    def free_slots(self) -> int:
        return self.capacity - self.used

    def can_place(self, n: int, board_call: int, discharge_call: int,
                  weight_each_t: float, cargo_type: str) -> bool:
        """Feasibility check for a batch of identical containers (a booking).

        Trial-places each unit through the real `_pick_bay`/`_place` path,
        then rolls back — the check can never disagree with `place()`.
        """
        if cargo_type is REEFER and \
                self.reefer_used + n > self.reefer_plugs:
            return False
        placed: list[tuple[Bay, Slot]] = []
        ok = True
        for _ in range(n):
            slot = Slot(board_call, discharge_call, weight_each_t, cargo_type)
            bay = self._pick_bay(slot)
            if bay is None:
                ok = False
                break
            self._place(bay, slot)
            placed.append((bay, slot))
        for bay, slot in placed:
            bay.slots.remove(slot)
        self.used -= len(placed)
        self.reefer_used = sum(1 for b in self.bays for s in b.slots
                               if s.cargo_type is REEFER)
        self.hazmat_used = sum(1 for b in self.bays for s in b.slots
                               if s.cargo_type is HAZMAT)
        return ok

    def place(self, n: int, board_call: int, discharge_call: int,
              weight_each_t: float, cargo_type: str) -> bool:
        """Place `n` identical containers. Returns False (no mutation beyond
        already-placed prefix is impossible: we check first) if infeasible."""
        if not self.can_place(n, board_call, discharge_call, weight_each_t,
                              cargo_type):
            return False
        for _ in range(n):
            slot = Slot(board_call, discharge_call, weight_each_t, cargo_type)
            bay = self._pick_bay(slot)
            assert bay is not None
            self._place(bay, slot)
        return True

    def discharge_through(self, call_idx: int) -> int:
        """Remove all containers whose discharge_call <= call_idx (called when
        the vessel reaches that port). Returns number discharged."""
        n = 0
        for bay in self.bays:
            keep = [s for s in bay.slots if s.discharge_call > call_idx]
            n += len(bay.slots) - len(keep)
            bay.slots = keep
        # counters are projected (future loads included); recompute cheaply
        self.used = sum(len(b.slots) for b in self.bays)
        self.reefer_used = sum(1 for b in self.bays for s in b.slots
                               if s.cargo_type is REEFER)
        self.hazmat_used = sum(1 for b in self.bays for s in b.slots
                               if s.cargo_type is HAZMAT)
        return n

    def onboard_now(self, call_idx: int) -> int:
        """Containers physically aboard just after call `call_idx` departs."""
        return sum(1 for b in self.bays for s in b.slots
                   if s.board_call <= call_idx < s.discharge_call)
