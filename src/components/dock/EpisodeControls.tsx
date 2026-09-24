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
  ChevronDown,
  type LucideIcon,
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
  running: "bg-loaded shadow-[0_0_8px_rgba(63,191,177,0.9)] animate-pulse",
  paused: "bg-warn",
  completed: "bg-accent",
  stopped: "bg-low",
};

/* One instrument field: icon + stacked micro-label over the control. */
function Field({
  icon: Icon,
  label,
  children,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2.5 px-4 py-2 transition-opacity ${
        disabled ? "opacity-45" : ""
      }`}
    >
      <Icon size={13} className="shrink-0 text-low" strokeWidth={1.75} />
      <div className="flex flex-col gap-0.5">
        <span className="text-[8px] font-medium uppercase leading-none tracking-[0.2em] text-faint">
          {label}
        </span>
        <div className="flex items-center">{children}</div>
      </div>
    </div>
  );
}

const Divider = () => <div className="w-px self-stretch bg-edge-soft/70" />;

const selectCls =
  "cursor-pointer appearance-none bg-transparent pr-4 font-display text-[12.5px] font-medium leading-tight text-hi outline-none disabled:cursor-not-allowed [&>option]:bg-ink";

const numInputCls =
  "w-10 bg-transparent font-display text-[12.5px] font-medium leading-tight tabular-nums text-hi outline-none disabled:cursor-not-allowed [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

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
    <div className="shrink-0 px-4 pt-3">
      <div className="panel scroll-thin flex items-stretch overflow-x-auto rounded-2xl">
        {/* config fields */}
        <Field icon={BrainCircuit} label="policy" disabled={!!live}>
          <div className="relative flex items-center">
            <select
              value={policy}
              onChange={(e) => setPolicy(e.target.value)}
              disabled={!!live}
              className={selectCls}
            >
              {policies.length === 0 && <option value={policy}>{titleCase(policy)}</option>}
              {policies.map((p) => (
                <option key={p.id} value={p.id} title={p.desc}>
                  {p.label}
                </option>
              ))}
            </select>
            <ChevronDown size={10} className="pointer-events-none absolute right-0 text-faint" />
          </div>
        </Field>

        <Divider />

        <Field icon={Globe} label="scenario" disabled={!!live}>
          <div className="relative flex items-center">
            <select
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
              disabled={!!live}
              className={selectCls}
            >
              {scenarios.length === 0 && <option value={scenario}>{titleCase(scenario)}</option>}
              {scenarios.map((s) => (
                <option key={s.scenario_id} value={s.scenario_id} title={s.description}>
                  {titleCase(s.scenario_id)}
                  {isShocky(s) ? " ⚡" : ""}
                </option>
              ))}
            </select>
            <ChevronDown size={10} className="pointer-events-none absolute right-0 text-faint" />
          </div>
        </Field>

        <Divider />

        <Field icon={Dices} label="seed" disabled={!!live}>
          <input
            type="number"
            value={seed}
            onChange={(e) => setSeed(Number(e.target.value))}
            disabled={!!live}
            className={numInputCls}
          />
        </Field>

        <Divider />

        <Field icon={CalendarDays} label="horizon" disabled={!!live}>
          <input
            type="number"
            value={horizon}
            min={5}
            max={365}
            onChange={(e) => setHorizon(Number(e.target.value))}
            disabled={!!live}
            className={numInputCls}
          />
          <span className="pl-0.5 text-[9px] leading-tight text-faint">d</span>
        </Field>

        <Divider />

        <Field icon={Gauge} label="speed">
          <input
            type="range"
            min={0.5}
            max={120}
            step={0.5}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            className="w-24 accent-accent"
            title="Sim speed (days / sec)"
          />
          <span className="w-9 pl-1.5 text-right font-display text-[11px] font-medium leading-tight text-mid tabular-nums">
            {speed}×
          </span>
        </Field>

        {/* episode status + transport */}
        <div className="ml-auto flex items-center gap-3 border-l border-edge-soft/70 px-4">
          {episode ? (
            <div className="flex items-center gap-2.5" title={`Day ${Math.floor(day)} of ${horizonDays}`}>
              <span
                className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[episode.status] ?? "bg-low"}`}
              />
              <div className="w-[72px]">
                <div className="flex items-baseline justify-between">
                  <span className="font-display text-[11.5px] font-semibold leading-none text-hi tabular-nums">
                    d{Math.floor(day)}
                  </span>
                  <span className="text-[9px] leading-none text-faint tabular-nums">
                    /{horizonDays}
                  </span>
                </div>
                <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-ink">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-500"
                    style={{ width: `${progress * 100}%` }}
                  />
                </div>
              </div>
            </div>
          ) : (
            <span className="text-[9px] font-medium uppercase tracking-[0.18em] text-faint">
              no episode
            </span>
          )}

          <div className="flex items-center gap-1.5">
            {!running ? (
              <button
                onClick={episode?.status === "paused" ? () => control("resume") : handleStart}
                disabled={starting}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-b from-accent-hi to-accent-deep text-white shadow-[0_0_16px_rgba(124,135,242,0.45)] transition-transform hover:scale-105 disabled:opacity-50"
                title={episode?.status === "paused" ? "Resume" : "Start episode"}
              >
                <Play size={13} fill="currentColor" className="ml-px" />
              </button>
            ) : (
              <button
                onClick={() => control("pause")}
                className="chip flex h-8 w-8 items-center justify-center rounded-full text-warn transition-colors hover:text-reserved-soft"
                title="Pause"
              >
                <Pause size={13} fill="currentColor" />
              </button>
            )}
            <button
              onClick={() => control("stop")}
              disabled={!episode}
              className="chip flex h-8 w-8 items-center justify-center rounded-full text-low transition-colors hover:text-critical disabled:opacity-40 disabled:hover:text-low"
              title="Stop"
            >
              <Square size={11} fill="currentColor" />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-2 flex items-center gap-2 rounded-xl border border-critical/25 bg-critical/[0.08] px-3.5 py-2 text-[11.5px] text-pending-soft">
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
