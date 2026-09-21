"use client";

import React, { useEffect, useState } from "react";
import { useEpisode } from "./EpisodeProvider";
import {
  Play,
  Pause,
  Square,
  Dices,
  CalendarDays,
  Gauge,
  BrainCircuit,
  Globe,
  TriangleAlert,
  X,
} from "lucide-react";
import type { Scenario } from "@/lib/api";

function titleCase(id: string) {
  return id
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function isShocky(s: Scenario) {
  return (
    (s.port_closures?.length ?? 0) > 0 ||
    (s.canal_closures?.length ?? 0) > 0 ||
    (s.port_strikes?.length ?? 0) > 0 ||
    (s.demand_spike_events?.length ?? 0) > 0
  );
}

const STATUS_DOT: Record<string, string> = {
  running: "bg-loaded shadow-[0_0_8px_rgba(63,189,176,0.8)] animate-pulse",
  paused: "bg-warn",
  completed: "bg-accent",
  stopped: "bg-low",
};

export function EpisodeControls() {
  const {
    policies,
    scenarios,
    episode,
    starting,
    error,
    start,
    control,
    dismissError,
  } = useEpisode();

  const [policy, setPolicy] = useState("ppo");
  const [scenario, setScenario] = useState("baseline");
  const [seed, setSeed] = useState(42);
  const [horizon, setHorizon] = useState(90);
  const [speed, setSpeed] = useState(20);

  const live = episode && (episode.status === "running" || episode.status === "paused");
  const running = episode?.status === "running";
  const day = episode?.day ?? 0;
  const horizonDays = episode?.horizon_days ?? horizon;
  const progress = Math.min(1, day / Math.max(1, horizonDays));

  useEffect(() => {
    if (running) control("set_speed", speed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed]);

  const handleStart = () =>
    start({ policy, scenario, seed, horizon_days: horizon, speed_days_per_sec: speed });

  return (
    <div className="panel-flat border-edge border-b px-6 py-2">
      <div className="flex items-center justify-between gap-4">
        {/* selectors */}
        <div className="flex items-center gap-2">
          <div className="chip flex h-8 items-center gap-2 rounded-full px-3" title="Policy">
            <BrainCircuit size={13} className="text-accent shrink-0" strokeWidth={1.75} />
            <select
              value={policy}
              onChange={(e) => setPolicy(e.target.value)}
              disabled={!!live}
              className="bg-transparent text-[12px] font-medium text-hi outline-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed [&>option]:bg-ink"
            >
              {policies.length === 0 && <option value={policy}>{titleCase(policy)}</option>}
              {policies.map((p) => (
                <option key={p.id} value={p.id} title={p.desc}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="chip flex h-8 items-center gap-2 rounded-full px-3" title="Scenario">
            <Globe size={13} className="text-mid shrink-0" strokeWidth={1.75} />
            <select
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
              disabled={!!live}
              className="bg-transparent text-[12px] font-medium text-hi outline-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed [&>option]:bg-ink"
            >
              {scenarios.length === 0 && <option value={scenario}>{titleCase(scenario)}</option>}
              {scenarios.map((s) => (
                <option key={s.scenario_id} value={s.scenario_id} title={s.description}>
                  {titleCase(s.scenario_id)}
                  {isShocky(s) ? " ⚡" : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="chip flex h-8 items-center gap-1.5 rounded-full px-3" title="Seed">
            <Dices size={13} className="text-mid shrink-0" strokeWidth={1.75} />
            <input
              type="number"
              value={seed}
              onChange={(e) => setSeed(Number(e.target.value))}
              disabled={!!live}
              className="w-12 bg-transparent text-[12px] font-medium text-hi outline-none disabled:opacity-50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>

          <div className="chip flex h-8 items-center gap-1.5 rounded-full px-3" title="Horizon (days)">
            <CalendarDays size={13} className="text-mid shrink-0" strokeWidth={1.75} />
            <input
              type="number"
              value={horizon}
              min={5}
              max={365}
              onChange={(e) => setHorizon(Number(e.target.value))}
              disabled={!!live}
              className="w-12 bg-transparent text-[12px] font-medium text-hi outline-none disabled:opacity-50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>

          <div
            className="chip flex h-8 items-center gap-2 rounded-full px-3"
            title="Sim speed (days / sec)"
          >
            <Gauge size={13} className="text-mid shrink-0" strokeWidth={1.75} />
            <input
              type="range"
              min={0.5}
              max={120}
              step={0.5}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              className="w-20 accent-accent"
            />
            <span className="w-8 text-right font-display text-[11px] font-medium text-mid tabular-nums">
              {speed}×
            </span>
          </div>
        </div>

        {/* transport */}
        <div className="flex items-center gap-3">
          {episode && (
            <div className="flex items-center gap-2" title={`Day ${Math.floor(day)} of ${horizonDays}`}>
              <span
                className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[episode.status] ?? "bg-low"}`}
              />
              <div className="w-20">
                <div className="flex items-baseline justify-between">
                  <span className="font-display text-[11px] font-semibold text-hi tabular-nums">
                    d{Math.floor(day)}
                  </span>
                  <span className="text-[9px] text-faint tabular-nums">/{horizonDays}</span>
                </div>
                <div className="mt-0.5 h-[3px] w-full overflow-hidden rounded-full bg-ink">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-500"
                    style={{ width: `${progress * 100}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center gap-1 border-l border-edge pl-3">
            {!running ? (
              <button
                onClick={episode?.status === "paused" ? () => control("resume") : handleStart}
                disabled={starting}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-b from-accent-hi to-accent-deep text-white shadow-[0_0_14px_rgba(90,100,230,0.4)] transition-transform hover:scale-105 disabled:opacity-50"
                title={episode?.status === "paused" ? "Resume" : "Start episode"}
              >
                <Play size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={() => control("pause")}
                className="flex h-8 w-8 items-center justify-center rounded-full chip text-warn transition-colors hover:text-reserved-soft"
                title="Pause"
              >
                <Pause size={13} fill="currentColor" />
              </button>
            )}
            <button
              onClick={() => control("stop")}
              disabled={!episode}
              className="flex h-8 w-8 items-center justify-center rounded-full chip text-low transition-colors hover:text-critical disabled:opacity-40 disabled:hover:text-low"
              title="Stop"
            >
              <Square size={12} fill="currentColor" />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-critical/30 bg-critical/10 px-3 py-1.5 text-[11.5px] text-pending-soft">
          <TriangleAlert size={12} className="shrink-0 text-critical" />
          <span className="flex-1">{error}</span>
          <button onClick={dismissError} className="text-low hover:text-hi">
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
