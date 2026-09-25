"""Gymnasium environment wrapper — CargoFleetEnv (plan.md §2.3, §3).

One episode = one simulated quarter. Two interleaved decision types:

  * booking steps — one per pending request; actions accept / reject /
    counter-offer (flex window, alt hub, split with parameter tiers).
  * fleet steps — one every `fleet_every` sim-days; actions set bunker speed
    per vessel or reposition empty containers between ports.

Single flat Discrete action space (MaskablePPO-compatible); `action_masks()`
exposes the feasible-action mask computed by the stowage solver + capacity
checks — hard constraints are never learned.

Action layout (N_ACTIONS = 44):
    0           reject
    1           accept at quoted price (earliest within-flex option)
    2..5        flex-window discount {5,10,15,20}% on a later option
    6..8        alt-hub discount {5,10,15}% to the alternate discharge port
    9..11       split consignment {50/50, 60/40, 70/30}
    12..27      set speed {12,14,16,18}kt for vessel i  (fleet steps only)
    28..43      reposition {75,150} TEU empties on top deficit pairs
                (fleet steps only)

Reward = per-step profit delta (revenue minus fuel/carbon/port/lease/
demurrage/compensation costs) minus a small empty-mile penalty.
"""

from __future__ import annotations

import numpy as np

try:
    import gymnasium as gym
    from gymnasium import spaces
except ImportError:  # keep the module importable without gymnasium installed
    gym = None
    spaces = None

from data import calibration as C
from data import demand as D
from simulator import SimConfig, Simulator
from simulator.types import (BookingDecision, BookingRequest, DecisionKind,
                             FleetAction)

FLEX_TIERS = (0.05, 0.10, 0.15, 0.20)
ALT_TIERS = (0.05, 0.10, 0.15)
SPLIT_TIERS = (0.5, 0.6, 0.7)
SPEED_TIERS = (12.0, 14.0, 16.0, 18.0)
REPO_TIERS = (75, 150)
# top reposition OD candidates: surplus->deficit pairs chosen at fleet step
N_REPO = 8

N_BOOKING_ACTIONS = 12
N_ACTIONS = N_BOOKING_ACTIONS + 4 * len(SPEED_TIERS) + N_REPO * len(REPO_TIERS)

N_PORTS = len(C.PORTS)
N_ROUTES = len(D.ROUTE_KEYS)
# obs: request(14) + options(4*4) + market(6) + ports(3*8) + vessels(6*4)
#      + demand forecast(N_ROUTES) + temporal(4) + decision flag(2)
OBS_DIM = 14 + 16 + 6 + 3 * N_PORTS + 6 * 4 + N_ROUTES + 4 + 2

EMPTY_MILE_PENALTY = 2e-6          # per empty TEU-nm sailed per step


class CargoFleetEnv(gym.Env if gym else object):
    metadata = {"render_modes": []}

    def __init__(self, sim_config: SimConfig | None = None,
                 scenario_pool: list[str] | None = None):
        if gym is None:
            raise ImportError("gymnasium is required for CargoFleetEnv")
        self.sim_config = sim_config or SimConfig()
        # train-time scenario randomization (holdout set stays untouched)
        self.scenario_pool = scenario_pool or [
            "baseline", "high-imbalance", "seasonal-peak", "steady-growth",
            "boom-market", "port-strike-season"]
        self.sim = Simulator(self.sim_config)
        self.action_space = spaces.Discrete(N_ACTIONS)
        self.observation_space = spaces.Box(-np.inf, np.inf,
                                            shape=(OBS_DIM,), dtype=np.float32)
        self._rng = np.random.default_rng()
        self._pending: list[BookingRequest] = []
        self._req: BookingRequest | None = None
        self._fleet_step = False
        self._last_profit = 0.0
        self._last_empty_nm = 0.0

    # ------------------------------------------------------------------

    def reset(self, seed: int | None = None, options: dict | None = None):
        super().reset(seed=seed)
        if seed is not None:
            self._rng = np.random.default_rng(seed)
        scen = self.scenario_pool[
            self._rng.integers(0, len(self.scenario_pool))]
        self.sim.config.scenario = scen
        self.sim.config.seed = int(self._rng.integers(0, 1 << 31))
        self.sim.reset()
        self._pending = []
        self._req = None
        self._fleet_step = False
        self._last_profit = 0.0
        self._last_empty_nm = 0.0
        self._advance_to_decision()
        return self._obs(), {"scenario": scen}

    def _advance_to_decision(self) -> None:
        """Move the sim forward until a decision is required (or done)."""
        while not self.sim.done:
            if self._req is None and not self._fleet_step:
                if not self._pending:
                    self._pending = self.sim.begin_day()
                    if int(self.sim.day) % self.sim.config.fleet_every == 0:
                        self._fleet_step = True
                        return
                if self._pending:
                    self._req = self._pending.pop(0)
                    return
                self.sim.end_day()
            else:
                return

    # ------------------------------------------------------------------

    def step(self, action: int):
        assert self._req is not None or self._fleet_step
        if self._fleet_step:
            for act in self._decode_fleet(action):
                self.sim.apply_fleet_action(act)
            self._fleet_step = False
        else:
            dec = self._decode_booking(action, self._req)
            self.sim.apply_decision(self._req, dec)
            self._req = None
        if not self._fleet_step and self._req is None and not self._pending \
                and not self.sim.done:
            self.sim.end_day()

        # reward: profit delta since last step, minus empty-mile penalty
        m = self.sim.metrics
        profit = (m.revenue - m.fuel_cost - m.carbon_cost - m.port_fees
                  - m.demurrage_cost - m.reposition_cost - m.lease_cost
                  - m.roll_compensation)
        reward = (profit - self._last_profit) / 10_000.0
        reward -= EMPTY_MILE_PENALTY * (m.empty_teu_nm - self._last_empty_nm)
        self._last_profit = profit
        self._last_empty_nm = m.empty_teu_nm

        self._advance_to_decision()
        terminated = self.sim.done
        obs = self._obs() if not terminated else np.zeros(
            OBS_DIM, dtype=np.float32)
        return obs, float(reward), terminated, False, {}

    # ------------------------------------------------------------------
    # Action decode
    # ------------------------------------------------------------------

    def _decode_booking(self, a: int, req: BookingRequest) -> BookingDecision:
        if a == 0 or req is None:
            return BookingDecision(DecisionKind.REJECT, note="policy")
        if a == 1:
            for i, o in enumerate(req.options):
                if o.within_flex:
                    return BookingDecision(DecisionKind.ACCEPT, option_idx=i)
            return BookingDecision(DecisionKind.REJECT, note="no_flex_opt")
        if 2 <= a <= 5:                    # flex window on a later option
            later = [i for i, o in enumerate(req.options)
                     if not o.within_flex]
            idx = later[0] if later else len(req.options) - 1
            return BookingDecision(DecisionKind.FLEX_WINDOW, option_idx=idx,
                                   discount_pct=FLEX_TIERS[a - 2])
        if 6 <= a <= 8:
            return BookingDecision(DecisionKind.ALT_HUB, option_idx=0,
                                   discount_pct=ALT_TIERS[a - 6])
        frac = SPLIT_TIERS[a - 9]
        return BookingDecision(DecisionKind.SPLIT, option_idx=0,
                               second_idx=min(1, len(req.options) - 1),
                               split_frac=frac)

    def _decode_fleet(self, a: int) -> list[FleetAction]:
        acts: list[FleetAction] = []
        a0 = a - N_BOOKING_ACTIONS
        if a0 < 4 * len(SPEED_TIERS):
            vid = f"VES{a0 // len(SPEED_TIERS) + 1}"
            return [FleetAction(kind="set_speed", vessel_id=vid,
                                speed_kt=SPEED_TIERS[a0 % len(SPEED_TIERS)])]
        a0 -= 4 * len(SPEED_TIERS)
        pairs = self._repo_pairs()
        if a0 // len(REPO_TIERS) < len(pairs):
            src, dst = pairs[a0 // len(REPO_TIERS)]
            acts.append(FleetAction(kind="reposition", port_from=src,
                                    port_to=dst,
                                    teu=REPO_TIERS[a0 % len(REPO_TIERS)]))
        return acts

    def _repo_pairs(self) -> list[tuple[str, str]]:
        """Top-N surplus->deficit port pairs by empty inventory imbalance."""
        order = sorted(self.sim.empties, key=self.sim.empties.get)
        pairs = []
        for dst in order[:4]:
            for src in reversed(order[-4:]):
                if src != dst:
                    pairs.append((src, dst))
        return pairs[:N_REPO]

    # ------------------------------------------------------------------
    # Action mask (hard constraints — never learned)
    # ------------------------------------------------------------------

    def action_masks(self) -> np.ndarray:
        mask = np.zeros(N_ACTIONS, dtype=bool)
        if self._fleet_step:
            lo = N_BOOKING_ACTIONS
            hi = N_BOOKING_ACTIONS + 4 * len(SPEED_TIERS)
            mask[lo:hi] = True                       # speed always legal
            pairs = self._repo_pairs()
            for i, (src, _dst) in enumerate(pairs):
                for k in range(len(REPO_TIERS)):
                    mask[hi + i * len(REPO_TIERS) + k] = (
                        self.sim.empties.get(src, 0) >= REPO_TIERS[k])
            return mask

        req = self._req
        mask[0] = True                               # reject always legal
        if req is None:
            return mask
        feas = [self.sim.feasible(req, o) for o in req.options]
        mask[1] = any(o.within_flex and f
                      for o, f in zip(req.options, feas))
        mask[2:6] = any((not o.within_flex) and f
                        for o, f in zip(req.options, feas))
        mask[6:9] = bool(req.alt_options) and any(
            self.sim.feasible(req, o) for o in req.alt_options)
        if len(req.options) >= 2:
            a, b = req.options[0], req.options[1]
            half = max(1, req.teu // 2)
            mask[9:12] = (self.sim.feasible(req, a, half)
                          and self.sim.feasible(req, b, req.teu - half))
        return mask

    # ------------------------------------------------------------------
    # Observation
    # ------------------------------------------------------------------

    def _obs(self) -> np.ndarray:
        sim, v = self.sim, np.zeros(OBS_DIM, dtype=np.float32)
        i = 0
        req = self._req
        if req is not None:
            v[0] = req.teu / 250.0
            v[1] = req.weight_t / 7000.0
            v[2 + list(C.CARGO_MIX).index(req.cargo_type.value)] = 1.0
            v[5 + list(C.SEGMENTS).index(req.segment.value)] = 1.0
            v[8] = req.flex_days / 7.0
            v[9] = (req.req_dep_day - sim.day) / 60.0
            v[10] = req.market_rate / 3000.0
            v[11] = len(req.options) / 4.0
            v[12] = len(req.alt_options) / 4.0
            v[13] = 1.0
        i = 14
        if req is not None:
            for k, o in enumerate(req.options[:4]):
                vv = sim.vessels[o.vessel_id]
                cap = vv.leg_cap(o.legs[0])
                v[i + 4 * k + 0] = (o.board_day - sim.day) / 60.0
                v[i + 4 * k + 1] = cap.teu / max(vv.own_lift_teu, 1)
                v[i + 4 * k + 2] = float(o.within_flex)
                v[i + 4 * k + 3] = float(o.capacity_ok)
        i += 16
        v[i:i + 6] = [
            sim.demand.fuel_price(sim.day) / 1000.0,
            sim.demand.ets_price(sim.day) / 120.0,
            sim.day / max(sim.config.horizon_days, 1),
            float(sim.start_week) / C.N_WEEKS,
            0.0, 0.0]
        i += 6
        for k, p in enumerate(sim.port_ids):
            di = int(min(sim.day, len(sim.port_wait[p]) - 1))
            v[i + 3 * k + 0] = sim.port_wait[p][di] / 200.0
            v[i + 3 * k + 1] = sim.empties[p] / 2000.0
            v[i + 3 * k + 2] = float(sim.port_closed[p][di])
        i += 3 * N_PORTS
        vessels = list(sim.vessels.values())[:4]
        for k, vv in enumerate(vessels):
            v[i + 6 * k + 0] = vv.speed_kt / 20.0
            v[i + 6 * k + 1] = float(vv.mode == "sea")
            v[i + 6 * k + 2] = vv.stowage.used / max(vv.stowage.capacity, 1)
            v[i + 6 * k + 3] = vv.onboard_teu / vv.spec.capacity_teu
            v[i + 6 * k + 4] = vv.empty_aboard / max(vv.own_lift_teu, 1)
            nxt = vv.next_event_day - sim.day
            v[i + 6 * k + 5] = np.clip(nxt / 30.0, -1, 1)
        i += 6 * 4
        # demand forecast: next-week intensity per route (state the policy
        # conditions on; the supervised forecaster refines this later)
        w = min(int(sim.day // 7) + 1, sim.horizon_weeks - 1)
        v[i:i + N_ROUTES] = sim.demand.lam[:, w] / 1200.0
        i += N_ROUTES
        v[i:i + 4] = [np.sin(2 * np.pi * sim.day / 7),
                      np.cos(2 * np.pi * sim.day / 7),
                      np.sin(2 * np.pi * sim.day / 90),
                      np.cos(2 * np.pi * sim.day / 90)]
        i += 4
        v[i] = float(self._fleet_step)
        v[i + 1] = float(req is not None)
        return v

    def render(self):
        pass
