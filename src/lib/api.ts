"use client";

import { useState, useEffect, useRef, useCallback } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_DOCK_API ?? "http://localhost:8399";

// --- Types ---

// Simulation Metrics
export interface Metrics {
  cum_revenue: number;
  cum_profit: number;
  teu_booked: number;
  utilization: number;
  requests: number;
  accepted: number;
  rejected: number;
  countered: number;
  counter_won: number;
  fuel_tonnes: number;
  co2_tonnes: number;
  costs: {
    fuel: number;
    carbon: number;
    port_fees: number;
    demurrage: number;
    reposition: number;
    lease: number;
    roll_comp: number;
  };
}

// Summary JSON
export interface SummaryStats {
  mean: number;
  std: number;
}
export interface SummaryPolicy {
  revenue_usd: SummaryStats;
  profit_usd: SummaryStats;
  revenue_per_teu: SummaryStats;
  utilization: SummaryStats;
  empty_teu_nm: SummaryStats;
  co2_per_teu: SummaryStats;
  fuel_tonnes: SummaryStats;
  counter_win_rate: SummaryStats;
  reject_to_counter_conv: SummaryStats;
  requests: SummaryStats;
  accepted: SummaryStats;
  teu_booked: SummaryStats;
  segments: {
    flexible: { requests: number; booked: number };
    standard: { requests: number; booked: number };
    urgent: { requests: number; booked: number };
  };
}
export interface SummaryLift {
  profit_usd_pct: number;
  revenue_per_teu_pct: number;
  utilization_pp: number;
}
export interface SummaryData {
  policies: Record<string, SummaryPolicy>;
  lift_vs_static: Record<string, SummaryLift>;
}

// Timeline JSON
export interface TimelineDay {
  day: number;
  cum_revenue: number;
  cum_profit: number;
  utilization: number;
  teu_booked: number;
  empty_teu_nm: number;
  mean_bid_pressure: number | null;
}
export interface TimelineData {
  policies: Record<string, TimelineDay[]>;
}

// Offers JSON
export interface OfferExplainLeg {
  leg_idx: number;
  dep_day: number;
  remaining_teu: number;
  expected_teu: number;
  pressure: number;
  market_rate: number;
  bid_price: number;
}
export interface OfferExplain {
  engine: string;
  quote_per_teu: number;
  bid_price_per_teu: number;
  market_rate_per_teu: number;
  reason: string;
  legs: OfferExplainLeg[];
  text: string;
}
export interface OfferData {
  request_id: number;
  day: number;
  origin: string;
  dest: string;
  teu: number;
  segment: string;
  cargo_type: string;
  req_dep_day: number;
  flex_days: number;
  decision_kind: string;
  option_idx: number;
  discount_pct: number;
  outcome: string;
  price: number;
  explain: OfferExplain | null;
}

// Shock JSON
export interface ShockData {
  event: {
    port: string;
    day_lo: number;
    day_hi: number;
    description: string;
  };
  runs: Record<string, {
    daily: TimelineDay[];
    summary: SummaryPolicy;
  }>;
}

// Meta JSON
export interface MetaData {
  git_sha: string | null;
  generated_at: string;
  seed: number;
  episodes: number;
  horizon_days: number;
  scenarios: any[];
  policies_present: string[];
  demand_model: string;
  notes: string;
}

// Entities
export interface Port {
  port_id: string;
  name: string;
  lat: number;
  lon: number;
  berths: number;
}
export interface Vessel {
  vessel_id: string;
  name: string;
  capacity_teu: number;
  reefer_plugs: number;
}
export interface Route {
  origin: string;
  dest: string;
  base_teu_wk: number;
  market_usd_per_teu: number;
  lane: string;
  direction: string;
}

export interface EpisodeVessel {
  vessel_id: string;
  name: string;
  mode: string;
  port: string | null;
  from_port: string;
  to_port: string;
  leg_start_day: number;
  leg_end_day: number;
  progress: number;
  onboard_teu: number;
  speed_kt: number;
}

export interface EpisodeSnapshot {
  id: string;
  policy: string;
  scenario: string;
  status: 'running' | 'paused' | 'stopped' | 'completed';
  day: number;
  metrics: Metrics;
  vessels: EpisodeVessel[];
  empties: Record<string, number>;
}

export interface Deal {
  deal_id: string;
  request_id: number;
  kind: string;
  origin: string;
  dest: string;
  teu: number;
  price_usd: number;
  segment: string;
  vessel_id: string;
  board_day: number;
  discharge_eta: number;
  terms: {
    window_lo: number;
    window_hi: number;
    delivery_deadline: number;
    penalty_bps: number;
  };
  status: string;
  register_day: number;
  actual_departure: number;
  actual_delivery: number;
  settled_outcome: string;
  settled_amount_usd: number;
  contract: string;
  tx: {
    register: string;
    departure: string;
    delivery: string;
    settle: string;
  };
}

// WebSocket Event Type
export interface EpisodeEvent {
  seq: number;
  day: number;
  type: string;
  prev_hash: string;
  hash: string;
  [key: string]: any; // payload details
}

// --- Fetch Functions ---

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export const api = {
  getHealth: () => fetchApi<{ ok: boolean }>('/health'),
  getPolicies: () => fetchApi<Array<{ id: string; label: string; desc: string }>>('/policies'),
  getScenarios: () => fetchApi<any[]>('/scenarios'),
  getPorts: () => fetchApi<Port[]>('/ports'),
  getVessels: () => fetchApi<Vessel[]>('/vessels'),
  getRoutes: () => fetchApi<Route[]>('/routes'),
  getModelsReport: () => fetchApi<any>('/models/report'),
  startEpisode: (params: { policy: string; scenario: string; seed: number; horizon_days: number; speed_days_per_sec: number }) =>
    fetchApi<any>('/episodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),
  getEpisodes: () => fetchApi<any[]>('/episodes'),
  getEpisode: (id: string) => fetchApi<EpisodeSnapshot>(`/episodes/${id}`),
  controlEpisode: (id: string, params: { action: 'pause' | 'resume' | 'stop' | 'set_speed'; speed?: number }) =>
    fetchApi<any>(`/episodes/${id}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),
  getEpisodeEvents: (id: string, after_seq = 0, limit = 500) =>
    fetchApi<{ events: EpisodeEvent[]; next_seq: number }>(`/episodes/${id}/events?after_seq=${after_seq}&limit=${limit}`),
  getEpisodeDeals: (id: string) => fetchApi<Deal[]>(`/episodes/${id}/deals`),
  verifyLedger: (id: string) => fetchApi<{ ok: boolean; n_events: number; first_bad_seq: number | null; detail: string }>(`/episodes/${id}/ledger/verify`),
  getCompare: (name: string) => fetchApi<any>(`/compare/${name}`),
};

// --- Hooks ---

export function useEpisodePolling(episodeId: string | null, intervalMs = 1000) {
  const [snapshot, setSnapshot] = useState<EpisodeSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!episodeId) return;

    let mounted = true;
    const poll = async () => {
      try {
        const data = await api.getEpisode(episodeId);
        if (mounted) {
          setSnapshot(data);
          setError(null);
        }
      } catch (err: any) {
        if (mounted) setError(err);
      }
    };

    poll(); // initial fetch
    const timer = setInterval(poll, intervalMs);

    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [episodeId, intervalMs]);

  return { snapshot, error };
}

export function useEpisodeStream(episodeId: string | null) {
  const [events, setEvents] = useState<EpisodeEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Event | null>(null);
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!episodeId) return;

    setEvents([]);
    setError(null);

    const wsUrl = `${API_BASE.replace(/^http/, 'ws')}/episodes/${episodeId}/stream`;
    const socket = new WebSocket(wsUrl);
    ws.current = socket;

    socket.onopen = () => setIsConnected(true);
    socket.onclose = () => setIsConnected(false);
    socket.onerror = (e) => setError(e);
    socket.onmessage = (msg) => {
      try {
        const event: EpisodeEvent = JSON.parse(msg.data);
        setEvents((prev) => [...prev, event]);
      } catch (e) {
        console.error('Failed to parse WS message:', e);
      }
    };

    return () => {
      socket.close();
      ws.current = null;
    };
  }, [episodeId]);

  return { events, isConnected, error };
}
