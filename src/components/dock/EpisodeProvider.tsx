"use client";

import React, { createContext, useContext, useState, ReactNode } from "react";

export interface EpisodeMetrics {
  cum_revenue: number;
  cum_profit: number;
  teu_booked: number;
  utilization: number;
}

export interface EpisodeState {
  episodeId: string | null;
  status: 'idle' | 'running' | 'paused' | 'finished' | 'error';
  day: number;
  horizonDays: number;
  policy: string;
  scenario: string;
  metrics: EpisodeMetrics | null;
}

interface EpisodeContextValue {
  state: EpisodeState;
  setState: React.Dispatch<React.SetStateAction<EpisodeState>>;
}

const EpisodeContext = createContext<EpisodeContextValue | undefined>(undefined);

export function EpisodeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<EpisodeState>({
    episodeId: null,
    status: 'idle',
    day: 0,
    horizonDays: 180,
    policy: 'ppo',
    scenario: 'baseline',
    metrics: null,
  });

  return (
    <EpisodeContext.Provider value={{ state, setState }}>
      {children}
    </EpisodeContext.Provider>
  );
}

export function useEpisode() {
  const context = useContext(EpisodeContext);
  if (context === undefined) {
    throw new Error("useEpisode must be used within an EpisodeProvider");
  }
  return context;
}
