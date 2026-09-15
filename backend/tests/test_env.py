"""Gymnasium env contract: obs/mask validity, termination, determinism."""

from __future__ import annotations

import numpy as np
import pytest

pytest.importorskip("gymnasium")

from env import N_ACTIONS, OBS_DIM, CargoFleetEnv
from simulator import SimConfig, Simulator

from conftest import stub_forecaster


@pytest.fixture
def env() -> CargoFleetEnv:
    return CargoFleetEnv(
        SimConfig(horizon_days=30, seed=5, forecaster=stub_forecaster()),
        scenario_pool=["baseline"])


class TestContract:
    def test_reset_returns_valid_obs(self, env):
        obs, info = env.reset(seed=5)
        assert obs.shape == (OBS_DIM,)
        assert np.all(np.isfinite(obs))
        assert "scenario" in info

    def test_mask_always_has_legal_action(self, env):
        env.reset(seed=5)
        for _ in range(200):
            mask = env.action_masks()
            assert mask.dtype == bool and mask.shape == (N_ACTIONS,)
            assert mask.any()
            a = int(np.random.choice(np.flatnonzero(mask)))
            _, _, term, _, _ = env.step(a)
            if term:
                break

    def test_episode_terminates(self, env):
        env.reset(seed=9)
        steps = 0
        while True:
            mask = env.action_masks()
            a = int(np.random.choice(np.flatnonzero(mask)))
            _, _, term, truncated, _ = env.step(a)
            steps += 1
            if term or truncated:
                break
            assert steps < 100_000            # never hangs
        assert env.sim.done

    def test_step_returns_finite_reward(self, env):
        env.reset(seed=5)
        mask = env.action_masks()
        _, r, _, _, _ = env.step(int(np.flatnonzero(mask)[0]))
        assert np.isfinite(r)

    def test_env_obs_uses_forecaster_not_lam(self, env):
        """The demand-forecast obs slice must come from the bound
        forecaster (stub -> 400 TEU/route-week), not sim.demand.lam —
        deleting ground truth must not break obs building."""
        obs, _ = env.reset(seed=5)
        # obs layout: ... + demand forecast(N_ROUTES=18) + temporal(4)
        #             + decision flags(2)  ->  forecast ends 6 from the end
        i = OBS_DIM - 6 - 18
        np.testing.assert_allclose(obs[i:i + 18], 400.0 / 1200.0, rtol=1e-6)
        del env.sim.demand.lam
        obs2 = env._obs()
        np.testing.assert_allclose(obs2[i:i + 18], 400.0 / 1200.0,
                                   rtol=1e-6)
        assert np.all(np.isfinite(obs2))

    def test_booking_mask_reject_always_legal(self, env):
        env.reset(seed=5)
        # step until a booking step, then check action 0 is legal
        for _ in range(500):
            if env._req is not None:
                assert env.action_masks()[0]
                return
            mask = env.action_masks()
            env.step(int(np.random.choice(np.flatnonzero(mask))))
        pytest.fail("no booking decision encountered")

    def test_fleet_steps_mask_only_fleet_actions(self, env):
        env.reset(seed=5)
        for _ in range(500):
            if env._fleet_step:
                mask = env.action_masks()
                assert mask[0]                      # pass stays legal
                assert not mask[1:12].any()         # booking actions masked
                return
            mask = env.action_masks()
            env.step(int(np.random.choice(np.flatnonzero(mask))))
        pytest.fail("no fleet step encountered")


class TestDeterminism:
    def test_same_seed_same_first_obs(self):
        e1 = CargoFleetEnv(
            SimConfig(horizon_days=20, seed=5,
                      forecaster=stub_forecaster()),
            scenario_pool=["baseline"])
        e2 = CargoFleetEnv(
            SimConfig(horizon_days=20, seed=5,
                      forecaster=stub_forecaster()),
            scenario_pool=["baseline"])
        o1, _ = e1.reset(seed=42)
        o2, _ = e2.reset(seed=42)
        np.testing.assert_array_equal(o1, o2)

    def test_pinned_reset_reproduces_baseline_realization(self):
        """rl/evaluate.py fairness: options={"sim_seed", "scenario"} must
        pin the simulator to the identical demand realization a baseline
        SimConfig(seed=seed) produces. Fails if the pinning is removed."""
        seed, scen, h = 1234, "baseline", 25
        ref = Simulator(SimConfig(scenario=scen, horizon_days=h, seed=seed,
                                  pricing="bid_price",
                                  forecaster=stub_forecaster()))
        ref.reset()
        env = CargoFleetEnv(
            SimConfig(horizon_days=h, pricing="bid_price",
                      forecaster=stub_forecaster()),
            scenario_pool=["boom-market", "port-strike-season"])
        env.reset(seed=999,
                  options={"sim_seed": seed, "scenario": scen})
        assert env.sim.config.seed == seed
        assert env.sim.scenario_name == scen
        assert env.sim.start_week == ref.start_week
        np.testing.assert_array_equal(env.sim.demand.lam, ref.demand.lam)

    def test_unpinned_reset_still_randomizes(self):
        """Absent the options keys, training behaviour is unchanged: the
        sim seed is drawn, not the env seed."""
        env = CargoFleetEnv(
            SimConfig(horizon_days=20, forecaster=stub_forecaster()),
            scenario_pool=["baseline"])
        env.reset(seed=5)
        assert env.sim.config.seed != 5


class TestActionDecode:
    def test_every_action_decodes(self, env):
        """Every action id must produce a decision without exceptions."""
        env.reset(seed=5)
        from simulator.types import BookingDecision
        from conftest import make_request
        req = make_request()
        req.options = env.sim._options_for(req, req.dest)
        for a in range(12):                          # booking actions
            dec = env._decode_booking(a, req)
            assert isinstance(dec, BookingDecision)
        for a in range(12, N_ACTIONS):               # fleet actions
            acts = env._decode_fleet(a)
            assert isinstance(acts, list)
