"""Live episode management for the Dock API.

One episode = one Simulator driven day-by-day on a daemon thread, paced at
``speed_days_per_sec`` (0 = flat out). The Simulator has a native event bus
(``sim.events``: subscriber callables ``fn(event_dict)``, fanned out by
``sim.emit``) emitting ``cargo.booked`` / ``booking.decision`` /
``departure.confirmed`` / ``delivery.confirmed`` / ``day.summary``; the
episode ingests that stream and adds episode-level events of its own
(``episode.status`` / ``episode.end`` / ``day.metrics`` and, when no
settlement processor is attached, ``deal.*`` lifecycle events).

If the Simulator ever lacks the bus (older trees), the driver falls back to
synthesizing the whole stream itself: booking.decision after each
apply_decision, departure/delivery detected from vessel state transitions
after each end_day, day.summary from the metrics tracker — selected per
episode via ``ep._native``. ``_ingest`` additionally dedupes the four core
types so the two sources can never double-log.

Every event is stamped ``{"type", "day", "seq"}``, appended to
``ep.events``, mirrored to the per-episode ledger
(``runs/ledger/<ep_id>.jsonl``, hash-chained via ``ledger.store.Ledger``
when available), and pushed into each subscriber's plain ``queue.Queue``
(the bridge to async WS senders). When a
``settlement.processor.SettlementProcessor`` is attached to the bus it
drives the on-chain deal lifecycle and its ``settlement.*`` events flow
through the same ingest path.
"""

from __future__ import annotations

import json
import queue
import threading
import time
import uuid
from pathlib import Path

from data import scenarios as SC
from simulator import SimConfig, Simulator
from simulator.fleet import SEA

BACKEND = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND.parent
RUNS_DIR = BACKEND / "runs"
DEFAULT_LEDGER_DIR = RUNS_DIR / "ledger"

TERMINAL = {"done", "stopped", "error"}
ACTIVE = {"running", "paused"}
# booking kinds that become tracked conditional deals (matches
# settlement.processor.CONTRACT_KINDS)
CONTRACT_KINDS = {"flex_window", "alt_hub", "split"}

MIN_SPEED, MAX_SPEED, DEFAULT_SPEED = 0.5, 120.0, 20.0


def _clamp_speed(speed: float | None) -> float:
    if speed is None:
        return DEFAULT_SPEED
    speed = float(speed)
    if speed <= 0:
        return 0.0                      # flat out
    return float(min(max(speed, MIN_SPEED), MAX_SPEED))


class EpisodeConflict(RuntimeError):
    """Raised when a second live episode is requested."""


class Episode:
    """Runtime state for one live episode."""

    def __init__(self, policy: str, scenario: str, seed: int,
                 horizon_days: int, speed_days_per_sec: float):
        self.id = uuid.uuid4().hex[:12]
        self.policy = policy
        self.scenario = scenario
        self.seed = int(seed)
        self.horizon_days = int(horizon_days)
        self.speed_days_per_sec = _clamp_speed(speed_days_per_sec)
        self.status = "running"          # running|paused|done|stopped|error
        self.error: str | None = None

        self.events: list[dict] = []     # full event log (mirrored to ledger)
        self.day = 0.0
        self.deals: dict[str, dict] = {} # deal_id -> deal record
        self.sim: Simulator | None = None
        self.thread: threading.Thread | None = None
        self.subscribers: list[queue.Queue] = []   # WS fanout
        self.created_at = time.time()

        self._lock = threading.Lock()
        self._pause = threading.Event()  # set => running, clear => paused
        self._pause.set()
        self._stop = threading.Event()
        self._ledger = None
        # single bound-method object: appended to sim.events and used for
        # identity checks in emit() (fresh self._ingest objects would fail
        # `is` comparison)
        self._subscriber = self._ingest
        self._native = False             # sim emits core events itself
        self._seen: set = set()          # dedupe keys for core event types
        self._shipments: list[dict] = [] # booked consignments in flight
        self._log_cursor = 0             # sim.metrics.decision_log consumed
        self._reqs: dict[int, object] = {}  # request_id -> BookingRequest
        self._ctx: dict = {}             # prepared driver context
        self._settlement = None          # SettlementProcessor, if available

    # ------------------------------------------------------------------
    # Event sink
    # ------------------------------------------------------------------

    def _bus(self) -> list:
        """The sim's event-subscriber list, creating the attribute if the
        Simulator doesn't provide one yet."""
        if self.sim is None:
            return []
        bus = getattr(self.sim, "events", None)
        if bus is None:
            bus = []
            self.sim.events = bus
        return bus

    def emit(self, type: str, **payload) -> None:
        """Episode event sink (also the signature SettlementProcessor
        expects). Stamps type+day, ingests locally, and rebroadcasts to
        other bus subscribers."""
        ev = {"type": type, "day": float(payload.pop("day", self.day))}
        ev.update(payload)
        self._ingest(ev)
        for fn in list(self._bus()):
            if fn is self._subscriber:
                continue
            try:
                fn(dict(ev))
            except Exception:
                pass                     # subscribers must not kill the sim

    @staticmethod
    def _dedupe_key(ev: dict):
        t = ev.get("type")
        if t == "booking.decision":
            return ("bd", ev.get("request_id"))
        if t == "day.summary":
            return ("ds", int(ev.get("day", -1)))
        if t == "departure.confirmed":
            return ("dep", ev.get("request_id"), ev.get("vessel_id"),
                    ev.get("call_idx"))
        if t == "delivery.confirmed":
            return ("del", ev.get("request_id"), ev.get("vessel_id"),
                    ev.get("board_call"), ev.get("port"))
        return None

    def _ingest(self, ev: dict) -> None:
        """Single storage path for all events (native-bus or synthesized):
        dedupe -> seq -> events list -> deals -> ledger -> subscribers."""
        key = self._dedupe_key(ev)
        with self._lock:
            if key is not None:
                if key in self._seen:
                    return
                self._seen.add(key)
            ev = dict(ev)
            stored = None
            if self._ledger is not None:
                # hash-chained ledger is the canonical record — its seq,
                # prev_hash and hash become the event's own fields so the
                # in-memory log, WS stream and ledger file agree exactly
                payload = {k: v for k, v in ev.items()
                           if k not in ("type", "day")}
                try:
                    stored = self._ledger.append(
                        ev["type"], float(ev.get("day", 0.0)), **payload)
                except Exception:
                    stored = None         # ledger hiccup must not kill stream
            if stored is not None:
                ev = stored
            else:
                ev["seq"] = len(self.events) + 1
            self.events.append(ev)
            self._handle_event(ev)
            for q in list(self.subscribers):
                try:
                    q.put_nowait(ev)
                except Exception:
                    pass

    # ------------------------------------------------------------------
    # Deal bookkeeping (driven off the event stream)
    # ------------------------------------------------------------------

    def _handle_event(self, ev: dict) -> None:
        t = ev.get("type")
        if t == "cargo.booked":
            # native sim event: a consignment was booked. Conditional
            # (contract-kind) bookings become tracked deals — unless the
            # settlement processor is attached, in which case it owns the
            # lifecycle via settlement.* events.
            if self._settlement is None \
                    and ev.get("kind") in CONTRACT_KINDS:
                did = (f"{self.id}-{ev.get('request_id')}"
                       f"-{ev.get('board_call')}-{ev.get('discharge_call')}")
                self.deals[did] = {
                    "deal_id": did,
                    "request_id": ev.get("request_id"),
                    "kind": ev.get("kind"),
                    "origin": ev.get("origin"),
                    "dest": ev.get("dest"),
                    "teu": ev.get("teu"),
                    "price_usd": ev.get("price"),
                    "segment": ev.get("segment"),
                    "vessel_id": ev.get("vessel_id"),
                    "board_call": ev.get("board_call"),
                    "discharge_call": ev.get("discharge_call"),
                    "board_day": ev.get("board_day"),
                    "discharge_eta": ev.get("discharge_day_est"),
                    "status": "registered",
                    "register_day": ev.get("day"),
                    "actual_departure": None,
                    "actual_delivery": None,
                    "settled_outcome": None,
                    "settled_amount_usd": None,
                }
        elif t in ("deal.registered", "settlement.deal_registered"):
            did = str(ev.get("deal_id"))
            self.deals[did] = {
                "deal_id": did,
                "request_id": ev.get("request_id"),
                "kind": ev.get("kind"),
                "origin": ev.get("origin"),
                "dest": ev.get("dest"),
                "teu": ev.get("teu"),
                "price_usd": ev.get("price_usd"),
                "segment": ev.get("segment"),
                "vessel_id": ev.get("vessel_id"),
                "board_day": ev.get("board_day"),
                "discharge_eta": ev.get("discharge_eta"),
                "status": "registered",
                "register_day": ev.get("day"),
                "actual_departure": None,
                "actual_delivery": None,
                "settled_outcome": None,
                "settled_amount_usd": None,
                "terms": ev.get("terms"),
                "contract": ev.get("contract"),
                "tx": {"register": ev.get("tx_hash")},
            }
        elif t in ("departure.confirmed", "deal.departure",
                   "settlement.departure_recorded"):
            d = self._match_deal(ev)
            if d is not None:
                d["actual_departure"] = ev.get("actual_day")
                if d["status"] == "registered":
                    d["status"] = "departed"
                if ev.get("tx_hash") is not None:
                    d.setdefault("tx", {})["departure"] = ev["tx_hash"]
        elif t in ("delivery.confirmed", "deal.delivery",
                   "settlement.delivery_recorded"):
            d = self._match_deal(ev)
            if d is not None:
                d["actual_delivery"] = ev.get("actual_day")
                if d["status"] in ("registered", "departed"):
                    d["status"] = "delivered"
                if ev.get("tx_hash") is not None:
                    d.setdefault("tx", {})["delivery"] = ev["tx_hash"]
        elif t in ("deal.settled", "settlement.settled"):
            d = self._match_deal(ev)
            if d is not None:
                d["status"] = "settled"
                d["settled_outcome"] = ev.get("outcome")
                d["settled_amount_usd"] = ev.get("amount_usd")
                if ev.get("tx_hash") is not None:
                    d.setdefault("tx", {})["settle"] = ev["tx_hash"]

    def _match_deal(self, ev: dict) -> dict | None:
        did = ev.get("deal_id")
        if did is not None and str(did) in self.deals:
            return self.deals[str(did)]
        rid = ev.get("request_id")
        cands = [d for d in self.deals.values()
                 if d.get("request_id") == rid and d["status"] != "settled"]
        if not cands:
            return None
        # disambiguate split shipments (same request) by vessel / board call
        vid = ev.get("vessel_id")
        bc = ev.get("call_idx", ev.get("board_call"))
        for d in cands:
            if vid is not None and d.get("vessel_id") == vid \
                    and (bc is None or d.get("board_call") == bc):
                return d
        for d in cands:
            if vid is not None and d.get("vessel_id") == vid:
                return d
        return cands[0]

    # ------------------------------------------------------------------
    # Thread controls
    # ------------------------------------------------------------------

    def _wait_paused(self) -> None:
        while not self._pause.is_set() and not self._stop.is_set():
            self._pause.wait(0.1)

    def _pace(self) -> None:
        """Throttle to speed_days_per_sec (one call = one sim-day),
        responsive to pause/stop."""
        sp = self.speed_days_per_sec
        if sp <= 0:
            return
        delay = 1.0 / sp
        t0 = time.monotonic()
        while True:
            if self._stop.is_set():
                return
            self._wait_paused()
            remaining = delay - (time.monotonic() - t0)
            if remaining <= 0:
                return
            time.sleep(min(0.02, remaining))

    # ------------------------------------------------------------------
    # Subscribers (WS fanout)
    # ------------------------------------------------------------------

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=10000)
        with self._lock:
            self.subscribers.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self.subscribers:
                self.subscribers.remove(q)

    def descriptor(self) -> dict:
        return {
            "id": self.id,
            "policy": self.policy,
            "scenario": self.scenario,
            "seed": self.seed,
            "horizon_days": self.horizon_days,
            "speed_days_per_sec": self.speed_days_per_sec,
            "status": self.status,
            "day": self.day,
            "error": self.error,
            "n_events": len(self.events),
            "n_deals": len(self.deals),
            "created_at": self.created_at,
        }


# ---------------------------------------------------------------------------
# Policy registry
# ---------------------------------------------------------------------------

def _policy_table():
    from baselines import (DynamicHeuristicPolicy, GreedyPolicy,
                           StaticRateCardPolicy)
    return {
        "static": {
            "label": "Static rate card",
            "desc": "Flat calibrated route rates, binary accept/reject — "
                    "the industry baseline.",
            "factory": StaticRateCardPolicy,
            "pricing": "rate_card",
        },
        "greedy": {
            "label": "Greedy dynamic",
            "desc": "Dynamic quotes; accepts anything that fits above a "
                    "marginal-cost floor. No counters, no repositioning.",
            "factory": GreedyPolicy,
            "pricing": "dynamic",
        },
        "heuristic": {
            "label": "Dynamic heuristic",
            "desc": "Greedy accepts + flex-window / alt-hub / split "
                    "counter-offers, congestion-aware speed and empty "
                    "repositioning.",
            "factory": DynamicHeuristicPolicy,
            "pricing": "dynamic",
        },
        "heuristic_bid": {
            "label": "Heuristic + bid price",
            "desc": "DynamicHeuristicPolicy on the bid-price engine: "
                    "opportunity-cost floors and bid-justified counter "
                    "discounts. Requires the trained demand forecaster.",
            "factory": DynamicHeuristicPolicy,
            "pricing": "bid_price",
        },
        "ppo": {
            "label": "MaskablePPO",
            "desc": "Trained MaskablePPO policy driving CargoFleetEnv "
                    "(bid-price pricing, masked feasible actions). Requires "
                    "a checkpoint under runs/ and the demand forecaster.",
            "factory": None,             # RL driver, not a policy object
            "pricing": "bid_price",
        },
    }


def list_policies() -> list[dict]:
    return [{"id": k, "label": v["label"], "desc": v["desc"]}
            for k, v in _policy_table().items()]


def _ppo_model_path() -> Path:
    """Best PPO checkpoint: DOCK_PPO_MODEL env override, else the highest
    curriculum stage runs/ppo_c<N>/model.zip, else any runs/ppo_*/model.zip."""
    import os
    env = os.environ.get("DOCK_PPO_MODEL")
    if env:
        return Path(env)
    def stage(p: Path) -> int:
        try:
            return int(p.parent.name.split("_c")[1])
        except Exception:
            return -1
    cands = sorted(RUNS_DIR.glob("ppo_c*/model.zip"), key=stage)
    if not cands:
        cands = sorted(RUNS_DIR.glob("ppo_*/model.zip"))
    if not cands:
        raise FileNotFoundError(
            "no PPO checkpoint found under runs/ — set DOCK_PPO_MODEL")
    return cands[-1]


class EpisodeManager:
    def __init__(self, ledger_dir: Path = DEFAULT_LEDGER_DIR):
        self.ledger_dir = Path(ledger_dir)
        self.ledger_dir.mkdir(parents=True, exist_ok=True)
        self._episodes: dict[str, Episode] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self, policy: str, scenario: str, seed: int = 42,
              horizon_days: int = 90,
              speed_days_per_sec: float = DEFAULT_SPEED) -> Episode:
        table = _policy_table()
        if policy not in table:
            raise ValueError(f"unknown policy '{policy}' — "
                             f"one of {sorted(table)}")
        if scenario not in SC.SCENARIOS:
            raise ValueError(f"unknown scenario '{scenario}' — "
                             f"one of {sorted(SC.SCENARIOS)}")
        with self._lock:
            for ep in self._episodes.values():
                if ep.status in ACTIVE:
                    raise EpisodeConflict(
                        f"episode {ep.id} is {ep.status} — stop it first")
            ep = Episode(policy, scenario, seed, horizon_days,
                         speed_days_per_sec)
            self._episodes[ep.id] = ep
        ep._ledger = self._open_ledger(ep)
        try:
            self._prepare(ep)            # may raise (e.g. missing forecaster)
        except Exception as e:
            ep.status = "error"
            ep.error = str(e)
            self._close_ledger(ep)
            raise
        ep.thread = threading.Thread(target=self._drive, args=(ep,),
                                     name=f"episode-{ep.id}", daemon=True)
        ep.thread.start()
        return ep

    def _open_ledger(self, ep: Episode):
        """Per-episode event ledger. Prefers the hash-chained
        ledger.store.Ledger (tamper-evident JSONL); falls back to a plain
        JSONL appender with the same append(type, day, **payload) -> record
        interface if that package isn't available."""
        path = self.ledger_dir / f"{ep.id}.jsonl"
        meta = {"episode_id": ep.id, "policy": ep.policy,
                "scenario": ep.scenario, "seed": ep.seed,
                "horizon_days": ep.horizon_days,
                "created_at": ep.created_at}
        try:
            from ledger.store import Ledger
            return Ledger(path, meta=meta)
        except Exception:
            pass

        class _PlainLedger:
            def __init__(self, p):
                self.path = Path(p)
                self._seq = 0

            def append(self, event_type, day, **payload):
                self._seq += 1
                rec = {"seq": self._seq, "day": day, "type": event_type,
                       **payload}
                with self.path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, default=str) + "\n")
                return rec

        return _PlainLedger(path)

    def get(self, ep_id: str) -> Episode | None:
        return self._episodes.get(ep_id)

    def list(self) -> list[Episode]:
        return list(self._episodes.values())

    def control(self, ep_id: str, action: str,
                speed: float | None = None) -> Episode:
        ep = self._episodes.get(ep_id)
        if ep is None:
            raise KeyError(ep_id)
        if action == "pause":
            if ep.status == "running":
                ep.status = "paused"
                ep._pause.clear()
                ep.emit("episode.status", status="paused")
        elif action == "resume":
            if ep.status == "paused":
                ep.status = "running"
                ep._pause.set()
                ep.emit("episode.status", status="running")
        elif action == "stop":
            if ep.status in ACTIVE:
                ep._stop.set()
                ep._pause.set()          # unblock the driver
        elif action == "set_speed":
            if speed is None:
                raise ValueError("set_speed requires 'speed'")
            ep.speed_days_per_sec = _clamp_speed(speed)
        else:
            raise ValueError(f"unknown control action '{action}'")
        return ep

    # ------------------------------------------------------------------
    # Snapshot
    # ------------------------------------------------------------------

    def snapshot(self, ep_id: str) -> dict:
        ep = self._episodes.get(ep_id)
        if ep is None:
            raise KeyError(ep_id)
        sim = ep.sim
        metrics: dict = {}
        vessels: list[dict] = []
        empties: dict = {}
        if sim is not None and getattr(sim, "metrics", None) is not None:
            m = sim.metrics
            profit = (m.revenue - m.fuel_cost - m.carbon_cost - m.port_fees
                      - m.demurrage_cost - m.reposition_cost - m.lease_cost
                      - m.roll_compensation)
            metrics = {
                "cum_revenue": round(m.revenue, 2),
                "cum_profit": round(profit, 2),
                "teu_booked": round(m.teu_booked, 1),
                "utilization": round(
                    m.teu_nm_carried / max(m.capacity_nm, 1.0), 4),
                "requests": m.n_requests,
                "accepted": m.n_accepted,
                "rejected": m.n_rejected,
                "countered": m.n_countered,
                "counter_won": m.n_counter_won,
                "fuel_tonnes": round(m.fuel_tonnes, 1),
                "co2_tonnes": round(m.co2_tonnes, 1),
                "costs": {
                    "fuel": round(m.fuel_cost, 0),
                    "carbon": round(m.carbon_cost, 0),
                    "port_fees": round(m.port_fees, 0),
                    "demurrage": round(m.demurrage_cost, 0),
                    "reposition": round(m.reposition_cost, 0),
                    "lease": round(m.lease_cost, 0),
                    "roll_comp": round(m.roll_compensation, 0),
                },
            }
            day = float(sim.day)
            for v in sim.vessels.values():
                if v.mode == SEA:
                    from_port = v.calls[v.at_call_idx].port
                    to_port = (v.calls[v.sailing_to_call].port
                               if 0 <= v.sailing_to_call < len(v.calls)
                               else None)
                    leg_start = getattr(v, "leg_start_day", None)
                    leg_end = getattr(v, "leg_end_day", None)
                    if leg_start is not None and leg_end and leg_end > leg_start:
                        progress = round(min(max(
                            (day - leg_start) / (leg_end - leg_start),
                            0.0), 1.0), 4)
                    else:
                        progress = None
                    port = None
                else:
                    port = v.port
                    from_port = to_port = None
                    leg_start = leg_end = progress = None
                vessels.append({
                    "vessel_id": v.spec.vessel_id,
                    "name": getattr(v, "name", v.spec.vessel_id),
                    "mode": v.mode.upper(),
                    "port": port,
                    "from_port": from_port,
                    "to_port": to_port,
                    "leg_start_day": leg_start,
                    "leg_end_day": leg_end,
                    "progress": progress,
                    "onboard_teu": getattr(v, "onboard_teu", 0),
                    "speed_kt": round(v.speed_kt, 2),
                })
            empties = {p: round(t, 1) for p, t in sim.empties.items()}
        return {
            "id": ep.id,
            "policy": ep.policy,
            "scenario": ep.scenario,
            "status": ep.status,
            "day": ep.day,
            "horizon_days": ep.horizon_days,
            "metrics": metrics,
            "vessels": vessels,
            "empties": empties,
        }

    # ------------------------------------------------------------------
    # Driver — prepare runs on the request thread so config errors
    # (missing forecaster / checkpoint / bad scenario) surface as HTTP
    # errors; the day loop itself runs on the episode thread.
    # ------------------------------------------------------------------

    def _prepare(self, ep: Episode) -> None:
        if ep.policy == "ppo":
            self._prepare_ppo(ep)
            return
        spec = _policy_table()[ep.policy]
        policy = spec["factory"]()
        cfg = SimConfig(scenario=ep.scenario, horizon_days=ep.horizon_days,
                        seed=ep.seed, pricing=spec["pricing"])
        sim = Simulator(cfg)
        ep.sim = sim
        self._attach_bus(ep)
        sim.reset()                      # may raise RuntimeError -> 500
        ep._ctx = {"policy": policy}

    def _prepare_ppo(self, ep: Episode) -> None:
        from sb3_contrib import MaskablePPO   # heavy: keep out of module top
        from env.fleet_env import CargoFleetEnv
        model = MaskablePPO.load(str(_ppo_model_path()))
        cfg = SimConfig(scenario=ep.scenario, horizon_days=ep.horizon_days,
                        seed=ep.seed, pricing="bid_price")
        env = CargoFleetEnv(cfg, scenario_pool=[ep.scenario])
        ep.sim = env.sim
        self._attach_bus(ep)
        obs, _ = env.reset(options={"sim_seed": ep.seed,
                                    "scenario": ep.scenario})
        ep._ctx = {"model": model, "env": env, "obs": obs}

    def _attach_bus(self, ep: Episode) -> None:
        """Attach ep._subscriber to the sim's event bus (creating the list
        if the Simulator doesn't provide one) and flag whether the sim
        emits core events natively — in which case the driver skips its
        own synthesis of those types."""
        ep._native = callable(getattr(ep.sim, "emit", None))
        bus = ep._bus()
        if ep._subscriber not in bus:
            bus.append(ep._subscriber)
        self._maybe_attach_settlement(ep)

    def _maybe_attach_settlement(self, ep: Episode) -> None:
        """Wire the settlement bridge. Default: a real local EVM
        (eth-tester/py-evm) with the DockSettlement contract deployed per
        episode. ``DOCK_SETTLEMENT=off`` is an explicit opt-out for
        environments without web3; contract/deploy failures propagate as
        episode errors rather than silently degrading."""
        import os
        from settlement.processor import SettlementProcessor
        chain = None
        if os.environ.get("DOCK_SETTLEMENT", "on").lower() != "off":
            from settlement.chain import SettlementChain
            chain = SettlementChain()      # deploys the contract on py-evm
        ep._settlement = SettlementProcessor(ep.id, ep.emit, chain)
        ep._bus().append(ep._settlement)

    def _drive(self, ep: Episode) -> None:
        try:
            ep.emit("episode.status", status="running")
            if ep.policy == "ppo":
                self._drive_ppo(ep)
            else:
                self._drive_policy(ep)
            self._finalize(ep)
        except Exception as e:
            ep.status = "error"
            ep.error = str(e)
            try:
                ep.emit("episode.status", status="error", error=str(e))
            finally:
                self._close_ledger(ep)

    def _drive_policy(self, ep: Episode) -> None:
        sim = ep.sim
        policy = ep._ctx["policy"]
        while not sim.done and not ep._stop.is_set():
            ep._wait_paused()
            if ep._stop.is_set():
                break
            reqs = sim.begin_day()
            for req in reqs:
                ep._reqs[req.request_id] = req
                dec = policy.decide_booking(req, sim)
                res = sim.apply_decision(req, dec)
                if not ep._native:
                    ep.emit("booking.decision",
                            request_id=req.request_id, origin=req.origin,
                            dest=req.dest, teu=req.teu,
                            weight_t=round(req.weight_t, 1),
                            cargo_type=req.cargo_type.value,
                            segment=req.segment.value,
                            market_rate=round(req.market_rate, 2),
                            req_dep_day=req.req_dep_day,
                            flex_days=req.flex_days,
                            n_options=len(req.options),
                            decision=dec.kind.value,
                            outcome=res.get("outcome"),
                            kind=res.get("kind"),
                            price=res.get("price"),
                            quoted=res.get("quoted"),
                            reason=res.get("reason"))
                    self._drain_decision_log(ep, sim)
            if sim.config.fleet_actions \
                    and int(sim.day) % sim.config.fleet_every == 0:
                for act in policy.decide_fleet(sim):
                    sim.apply_fleet_action(act)
            sim.end_day()
            ep.day = float(sim.day)
            if not ep._native:
                self._drain_decision_log(ep, sim)
                self._emit_vessel_transitions(ep, sim)
                self._emit_day_summary(ep, sim)
            else:
                self._emit_day_metrics(ep, sim)
            ep._pace()

    def _drive_ppo(self, ep: Episode) -> None:
        env = ep._ctx["env"]
        model = ep._ctx["model"]
        obs = ep._ctx["obs"]
        sim = ep.sim
        last_day = int(sim.day)
        term = False
        while not term and not ep._stop.is_set():
            ep._wait_paused()
            if ep._stop.is_set():
                break
            req = env._req               # booking request under decision
            outcomes_before = dict(sim.metrics.outcomes)
            log_before = len(sim.metrics.decision_log)
            a, _ = model.predict(obs, action_masks=env.action_masks())
            obs, _r, term, _trunc, _ = env.step(int(a))
            if req is not None:
                ep._reqs[req.request_id] = req
                if not ep._native:
                    self._emit_ppo_decision(ep, env, sim, req, int(a),
                                            outcomes_before, log_before)
            if not ep._native:
                self._drain_decision_log(ep, sim)
            advanced = int(sim.day) > last_day
            while int(sim.day) > last_day:
                last_day += 1
                ep.day = float(last_day)
                if not ep._native:
                    self._emit_vessel_transitions(ep, sim)
                    self._emit_day_summary(ep, sim, day=float(last_day))
                else:
                    self._emit_day_metrics(ep, sim, day=float(last_day))
            if advanced:
                ep._pace()               # throttle per sim-day advanced
        ep.day = float(sim.day)

    def _emit_ppo_decision(self, ep: Episode, env, sim, req, action: int,
                           outcomes_before: dict, log_before: int) -> None:
        """Synthesize booking.decision for an env-stepped request. The env
        applies the decision internally, so the outcome is recovered from
        the metrics.outcomes counter delta / decision_log growth."""
        new_outcomes = dict(sim.metrics.outcomes)
        delta = {k: new_outcomes.get(k, 0) - outcomes_before.get(k, 0)
                 for k in new_outcomes}
        delta = {k: v for k, v in delta.items() if v > 0}
        outcome, reason = "rejected", None
        if delta:
            key = max(delta, key=delta.get)
            outcome, _, reason = key.partition(":")
        try:
            decision = env._decode_booking(action, req).kind.value
        except Exception:
            decision = f"ppo_action_{action}"
        booked = len(sim.metrics.decision_log) > log_before
        kind = None
        if booked:
            kind = sim.metrics.decision_log[-1].get("kind")
            outcome = "booked"
        ep.emit("booking.decision",
                request_id=req.request_id, origin=req.origin,
                dest=req.dest, teu=req.teu,
                weight_t=round(req.weight_t, 1),
                cargo_type=req.cargo_type.value,
                segment=req.segment.value,
                market_rate=round(req.market_rate, 2),
                req_dep_day=req.req_dep_day,
                flex_days=req.flex_days,
                n_options=len(req.options),
                decision=decision,
                outcome=outcome, kind=kind,
                price=(sim.metrics.decision_log[-1].get("price")
                       if booked else None),
                reason=reason or None)

    # ------------------------------------------------------------------
    # Shared event synthesis
    # ------------------------------------------------------------------

    def _drain_decision_log(self, ep: Episode, sim) -> None:
        """Newly booked consignments -> shipment tracking + deal.registered
        for contract-kind bookings."""
        log = sim.metrics.decision_log
        while ep._log_cursor < len(log):
            entry = log[ep._log_cursor]
            ep._log_cursor += 1
            req = ep._reqs.get(entry["request_id"])
            vid, bc, dc = entry["vessel"], entry["board_call"], \
                entry["discharge_call"]
            v = sim.vessels.get(vid)
            board_day = v.calls[bc].planned_etd if v and bc < len(v.calls) \
                else None
            eta = v.calls[dc].planned_etd if v and dc < len(v.calls) else None
            n_for_req = sum(1 for s in ep._shipments
                            if s["request_id"] == entry["request_id"])
            did = f"{ep.id}-{entry['request_id']}-{n_for_req}"
            ep._shipments.append({
                "deal_id": did,
                "request_id": entry["request_id"],
                "kind": entry.get("kind"),
                "vessel_id": vid,
                "board_call": bc,
                "discharge_call": dc,
                "board_day": board_day,
                "discharge_eta": eta,
                "origin": getattr(req, "origin", None),
                "dest": getattr(req, "dest", None),
                "teu": entry.get("teu"),
                "price_usd": entry.get("price"),
                "segment": getattr(getattr(req, "segment", None),
                                   "value", None),
                "departed": False,
                "delivered": False,
            })
            if entry.get("kind") in CONTRACT_KINDS \
                    and ep._settlement is None:
                ep.emit("deal.registered", deal_id=did,
                        request_id=entry["request_id"],
                        kind=entry.get("kind"),
                        origin=getattr(req, "origin", None),
                        dest=getattr(req, "dest", None),
                        teu=entry.get("teu"), price_usd=entry.get("price"),
                        segment=getattr(getattr(req, "segment", None),
                                        "value", None),
                        vessel_id=vid, board_day=board_day,
                        discharge_eta=eta)

    def _emit_vessel_transitions(self, ep: Episode, sim) -> None:
        """Detect departures/deliveries of tracked shipments after end_day."""
        for s in ep._shipments:
            if s["delivered"]:
                continue
            v = sim.vessels.get(s["vessel_id"])
            if v is None:
                continue
            bc, dc = s["board_call"], s["discharge_call"]
            if not s["departed"] and (
                    v.at_call_idx > bc
                    or (v.at_call_idx == bc and v.mode == SEA)):
                s["departed"] = True
                actual = (float(v.leg_start_day)
                          if v.at_call_idx == bc
                          and getattr(v, "leg_start_day", None) is not None
                          else float(sim.day))
                port = v.calls[bc].port if bc < len(v.calls) else None
                ep.emit("departure.confirmed",
                        request_id=s["request_id"], deal_id=s["deal_id"],
                        vessel_id=s["vessel_id"], call_idx=bc, port=port,
                        actual_day=actual, planned_etd=s["board_day"])
            if not s["delivered"] and s["departed"] \
                    and v.at_call_idx >= dc:
                s["delivered"] = True
                port = v.calls[dc].port if dc < len(v.calls) else None
                ep.emit("delivery.confirmed",
                        request_id=s["request_id"], deal_id=s["deal_id"],
                        vessel_id=s["vessel_id"], board_call=bc, port=port,
                        actual_day=float(sim.day))

    def _day_metrics_payload(self, sim) -> dict:
        m = sim.metrics
        profit = (m.revenue - m.fuel_cost - m.carbon_cost - m.port_fees
                  - m.demurrage_cost - m.reposition_cost - m.lease_cost
                  - m.roll_compensation)
        return {
            "cum_revenue": round(m.revenue, 2),
            "cum_profit": round(profit, 2),
            "teu_booked": round(m.teu_booked, 1),
            "utilization": round(
                m.teu_nm_carried / max(m.capacity_nm, 1.0), 4),
            "requests": m.n_requests, "accepted": m.n_accepted,
            "rejected": m.n_rejected, "countered": m.n_countered,
            "counter_won": m.n_counter_won,
            "fuel_tonnes": round(m.fuel_tonnes, 1),
            "co2_tonnes": round(m.co2_tonnes, 1),
            "leased_containers": round(m.leased_containers, 1),
            "repositioned_teu": round(m.repositioned_teu, 1),
            "vessels_at_sea": sum(1 for v in sim.vessels.values()
                                if v.mode == SEA),
        }

    def _emit_day_metrics(self, ep: Episode, sim,
                          day: float | None = None) -> None:
        """Rich per-day metrics event. Emitted alongside the sim's own
        (thin) day.summary when a native bus is present."""
        ep.emit("day.metrics",
                day=float(sim.day if day is None else day),
                **self._day_metrics_payload(sim))

    def _emit_day_summary(self, ep: Episode, sim,
                          day: float | None = None) -> None:
        ep.emit("day.summary",
                day=float(sim.day if day is None else day),
                **self._day_metrics_payload(sim))

    # ------------------------------------------------------------------
    # Finalize
    # ------------------------------------------------------------------

    def _finalize(self, ep: Episode) -> None:
        sim = ep.sim
        ep.day = float(sim.day) if sim is not None else ep.day
        status = "stopped" if ep._stop.is_set() else (
            "done" if sim is not None and sim.done else "stopped")
        ep.status = status
        self._settle_open_deals(ep, sim)
        metrics = {}
        if sim is not None and getattr(sim, "metrics", None) is not None:
            try:
                metrics = sim.metrics.report()
            except Exception:
                metrics = {}
        ep.emit("episode.end", status=status, metrics=metrics)
        ep.emit("episode.status", status=status)
        self._close_ledger(ep)

    def _settle_open_deals(self, ep: Episode, sim) -> None:
        """Offline settlement for deals — only when no settlement
        processor is attached (processor owns settlement otherwise;
        deals past horizon but inside their deadline stay 'pending')."""
        if ep._settlement is not None:
            return
        for did, d in list(ep.deals.items()):
            if d["status"] == "settled":
                continue
            if d["status"] == "delivered":
                outcome = "settled_full"
                amount = round((d.get("price_usd") or 0.0)
                               * (d.get("teu") or 0.0), 2)
            else:
                outcome, amount = "refunded", 0.0
            ep.emit("deal.settled", deal_id=did,
                    request_id=d.get("request_id"),
                    outcome=outcome, amount_usd=amount)

    def _close_ledger(self, ep: Episode) -> None:
        # Ledger writes+fsyncs per line and holds no open handle
        ep._ledger = None
