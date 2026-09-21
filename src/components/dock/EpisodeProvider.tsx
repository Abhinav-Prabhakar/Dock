"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  wsUrl,
  ApiError,
  type ControlAction,
  type Deal,
  type EpisodeDescriptor,
  type EpisodeEvent,
  type EpisodeSnapshot,
  type Metrics,
  type PolicyDescriptor,
  type Port,
  type Route,
  type Scenario,
  type Vessel,
} from "@/lib/api";

const MAX_EVENTS = 3000;
const SNAPSHOT_MS = 1000;
const DEALS_MS = 2500;

export interface ProfitPoint {
  day: number;
  cum_profit: number;
}

export interface StartParams {
  policy: string;
  scenario: string;
  seed: number;
  horizon_days: number;
  speed_days_per_sec: number;
}

interface DockContextValue {
  backendUp: boolean | null;
  policies: PolicyDescriptor[];
  scenarios: Scenario[];
  ports: Port[];
  vessels: Vessel[];
  routes: Route[];
  episode: EpisodeDescriptor | null;
  metrics: Metrics | null;
  profitSeries: ProfitPoint[];
  events: EpisodeEvent[];
  deals: Deal[];
  snapshot: EpisodeSnapshot | null;
  wsConnected: boolean;
  starting: boolean;
  error: string | null;
  start: (params: StartParams) => Promise<void>;
  control: (action: ControlAction, speed?: number) => Promise<void>;
  dismissError: () => void;
}

const DockContext = createContext<DockContextValue | undefined>(undefined);

function isLive(status: string | undefined) {
  return status === "running" || status === "paused";
}

export function EpisodeProvider({ children }: { children: ReactNode }) {
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  const [policies, setPolicies] = useState<PolicyDescriptor[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [ports, setPorts] = useState<Port[]>([]);
  const [vessels, setVessels] = useState<Vessel[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [episode, setEpisode] = useState<EpisodeDescriptor | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [profitSeries, setProfitSeries] = useState<ProfitPoint[]>([]);
  const [events, setEvents] = useState<EpisodeEvent[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [snapshot, setSnapshot] = useState<EpisodeSnapshot | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const snapTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const dealTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const episodeRef = useRef<EpisodeDescriptor | null>(null);
  episodeRef.current = episode;

  const clearTimers = useCallback(() => {
    if (snapTimer.current) clearInterval(snapTimer.current);
    if (dealTimer.current) clearInterval(dealTimer.current);
    snapTimer.current = null;
    dealTimer.current = null;
  }, []);

  const closeWs = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setWsConnected(false);
  }, []);

  const pollSnapshot = useCallback(async (id: string) => {
    try {
      const snap = await api.getEpisode(id);
      setSnapshot(snap);
      setEpisode((e) =>
        e ? { ...e, status: snap.status, day: snap.day } : e,
      );
      if (snap.metrics) setMetrics(snap.metrics);
    } catch {
      /* episode may be gone; next tick retries */
    }
  }, []);

  const pollDeals = useCallback(async (id: string) => {
    try {
      setDeals(await api.getEpisodeDeals(id));
    } catch {
      /* non-fatal */
    }
  }, []);

  const handleEvent = useCallback((ev: EpisodeEvent) => {
    setEvents((prev) =>
      prev.length >= MAX_EVENTS ? [...prev.slice(-MAX_EVENTS + 1), ev] : [...prev, ev],
    );
    if (ev.type === "day.summary" || ev.type === "day.metrics") {
      const m = ev as unknown as Metrics & { day: number };
      setMetrics(m);
      setProfitSeries((prev) =>
        prev.length && prev[prev.length - 1].day === m.day
          ? prev
          : [...prev, { day: m.day, cum_profit: m.cum_profit }],
      );
      setEpisode((e) => (e ? { ...e, day: m.day } : e));
    } else if (ev.type === "episode.status") {
      const status = ev.status as EpisodeDescriptor["status"];
      setEpisode((e) => (e ? { ...e, status } : e));
    } else if (ev.type === "episode.end") {
      setEpisode((e) =>
        e ? { ...e, status: (ev.status as EpisodeDescriptor["status"]) ?? "completed" } : e,
      );
    }
  }, []);

  const attach = useCallback(
    (desc: EpisodeDescriptor) => {
      closeWs();
      clearTimers();
      setEpisode(desc);
      setEvents([]);
      setProfitSeries([]);
      setDeals([]);
      setMetrics(null);
      setSnapshot(null);

      const socket = new WebSocket(wsUrl(desc.id));
      wsRef.current = socket;
      socket.onopen = () => setWsConnected(true);
      socket.onclose = () => setWsConnected(false);
      socket.onmessage = (msg) => {
        try {
          handleEvent(JSON.parse(msg.data));
        } catch {
          /* malformed frame */
        }
      };

      pollSnapshot(desc.id);
      pollDeals(desc.id);
      snapTimer.current = setInterval(() => pollSnapshot(desc.id), SNAPSHOT_MS);
      dealTimer.current = setInterval(() => pollDeals(desc.id), DEALS_MS);
    },
    [clearTimers, closeWs, handleEvent, pollDeals, pollSnapshot],
  );

  // stop timers once the episode leaves the live state
  useEffect(() => {
    if (episode && !isLive(episode.status)) {
      clearTimers();
      pollSnapshot(episode.id);
      pollDeals(episode.id);
    }
  }, [episode?.status, episode, clearTimers, pollDeals, pollSnapshot]);

  const start = useCallback(
    async (params: StartParams) => {
      setStarting(true);
      setError(null);
      try {
        const desc = await api.startEpisode(params);
        attach(desc);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          const list = await api.getEpisodes().catch(() => []);
          const running = list.find((e) => isLive(e.status));
          if (running) {
            attach(running);
            setError("An episode was already running — attached to it.");
          } else {
            setError(err.message);
          }
        } else {
          setError(err instanceof Error ? err.message : "Failed to start episode");
        }
      } finally {
        setStarting(false);
      }
    },
    [attach],
  );

  const control = useCallback(
    async (action: ControlAction, speed?: number) => {
      const ep = episodeRef.current;
      if (!ep) return;
      setError(null);
      try {
        const desc = await api.controlEpisode(ep.id, { action, speed });
        setEpisode((e) => (e ? { ...e, ...desc } : e));
        if (action === "stop") {
          clearTimers();
          pollSnapshot(ep.id);
          pollDeals(ep.id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to ${action}`);
      }
    },
    [clearTimers, pollDeals, pollSnapshot],
  );

  const dismissError = useCallback(() => setError(null), []);

  // boot: health, reference data, adopt an in-flight episode (refresh resilience)
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await api.getHealth();
        if (mounted) setBackendUp(true);
      } catch {
        if (mounted) setBackendUp(false);
        return;
      }
      const [pols, scens, eps, pts, ves, rts] = await Promise.all([
        api.getPolicies().catch(() => []),
        api.getScenarios().catch(() => []),
        api.getEpisodes().catch(() => []),
        api.getPorts().catch(() => []),
        api.getVessels().catch(() => []),
        api.getRoutes().catch(() => []),
      ]);
      if (!mounted) return;
      setPolicies(pols);
      setScenarios(scens);
      setPorts(pts);
      setVessels(ves);
      setRoutes(rts);
      const live = eps.find((e) => isLive(e.status));
      if (live) attach(live);
    })();
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // teardown on unmount
  useEffect(() => () => {
    clearTimers();
    wsRef.current?.close();
  }, [clearTimers]);

  return (
    <DockContext.Provider
      value={{
        backendUp,
        policies,
        scenarios,
        ports,
        vessels,
        routes,
        episode,
        metrics,
        profitSeries,
        events,
        deals,
        snapshot,
        wsConnected,
        starting,
        error,
        start,
        control,
        dismissError,
      }}
    >
      {children}
    </DockContext.Provider>
  );
}

export function useEpisode() {
  const context = useContext(DockContext);
  if (context === undefined) {
    throw new Error("useEpisode must be used within an EpisodeProvider");
  }
  return context;
}
