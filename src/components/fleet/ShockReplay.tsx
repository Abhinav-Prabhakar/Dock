"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  CloudLightning,
  TriangleAlert,
  Zap,
  Loader2,
  Radio,
} from "lucide-react";
import { api, type ShockData, type TimelineDay } from "@/lib/api";
import { useEpisode, type ProfitPoint } from "@/components/dock/EpisodeProvider";
import { fmtUsdM, fmtPct } from "@/lib/offers";
import { Empty, Pill, SectionTitle } from "@/components/dock/ui";

/* Shock replay — the canned NLRTM-closure A/B (static vs ppo) from the compare
   export, plus a "run it live" button that races two real episodes through the
   volatile-shocks scenario on the same chart. */

const STATIC_COLOR = "#4c5380";
const PPO_COLOR = "#7c87f2";
const LIVE_STATIC_COLOR = "#a3abd6";
const LIVE_PPO_COLOR = "#a9b1ff";

const REPLAY_PARAMS = {
  scenario: "volatile-shocks",
  seed: 42,
  horizon_days: 90,
  speed_days_per_sec: 0,
} as const;

type Phase = "idle" | "static" | "ppo" | "done";

/** summary fields arrive as plain numbers in the shock export, but older
    exports may carry {mean,std} — coerce either. */
const statNum = (v: unknown): number =>
  typeof v === "number" ? v : Number((v as { mean?: number } | null)?.mean ?? 0);

const signedM = (v: number) => `${v > 0 ? "+" : ""}${fmtUsdM(v)}`;

function ShockChart({
  dayLo,
  dayHi,
  staticDaily,
  ppoDaily,
  liveStatic,
  livePpo,
}: {
  dayLo: number;
  dayHi: number;
  staticDaily: TimelineDay[];
  ppoDaily: TimelineDay[];
  liveStatic: ProfitPoint[];
  livePpo: ProfitPoint[];
}) {
  const width = 1000;
  const height = 300;
  const margin = { top: 14, right: 20, bottom: 30, left: 56 };
  const iw = width - margin.left - margin.right;
  const ih = height - margin.top - margin.bottom;

  let maxDay = 1;
  let yMin = 0;
  let yMax = 1;
  const feed = (day: number, v: number) => {
    if (day > maxDay) maxDay = day;
    if (v < yMin) yMin = v;
    if (v > yMax) yMax = v;
  };
  staticDaily.forEach((d) => feed(d.day, d.cum_profit));
  ppoDaily.forEach((d) => feed(d.day, d.cum_profit));
  liveStatic.forEach((d) => feed(d.day, d.cum_profit));
  livePpo.forEach((d) => feed(d.day, d.cum_profit));
  const pad = (yMax - yMin) * 0.08 || 1;
  yMin -= pad;
  yMax += pad;

  const getX = (day: number) => margin.left + ((day - 1) / Math.max(1, maxDay - 1)) * iw;
  const getY = (v: number) => margin.top + ih - ((v - yMin) / (yMax - yMin)) * ih;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * (yMax - yMin));
  const xTicks = Array.from({ length: 7 }, (_, i) => 1 + Math.round((i * (maxDay - 1)) / 6));

  const toPts = (days: { day: number; cum_profit: number }[]) =>
    days.map((d) => `${getX(d.day).toFixed(1)},${getY(d.cum_profit).toFixed(1)}`).join(" ");

  const bandX = getX(Math.min(dayLo, maxDay));
  const bandW = Math.max(2, getX(Math.min(dayHi, maxDay)) - bandX);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full">
      <defs>
        <filter id="shock-ppo-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
      </defs>

      {/* shock window */}
      <rect
        x={bandX}
        y={margin.top}
        width={bandW}
        height={ih}
        fill="rgba(240,82,79,0.10)"
      />
      <line x1={bandX} y1={margin.top} x2={bandX} y2={margin.top + ih} stroke="rgba(240,82,79,0.35)" strokeDasharray="2 4" />
      <line x1={bandX + bandW} y1={margin.top} x2={bandX + bandW} y2={margin.top + ih} stroke="rgba(240,82,79,0.35)" strokeDasharray="2 4" />
      <text
        x={bandX + bandW / 2}
        y={margin.top + 8}
        fill="rgba(240,82,79,0.7)"
        fontSize="9"
        textAnchor="middle"
        letterSpacing="1.5"
      >
        CLOSED
      </text>

      {yTicks.map((t, i) => (
        <g key={i}>
          <line
            x1={margin.left}
            y1={getY(t)}
            x2={width - margin.right}
            y2={getY(t)}
            stroke={Math.abs(t) < (yMax - yMin) * 0.02 ? "rgba(152,162,226,0.22)" : "rgba(152,162,226,0.09)"}
            strokeDasharray="3 5"
          />
          <text
            x={margin.left - 10}
            y={getY(t)}
            fill="#4c5380"
            fontSize="11"
            textAnchor="end"
            dominantBaseline="middle"
          >
            {fmtUsdM(t)}
          </text>
        </g>
      ))}
      {xTicks.map((t, i) => (
        <text key={i} x={getX(t)} y={height - 10} fill="#4c5380" fontSize="11" textAnchor="middle">
          d{t}
        </text>
      ))}

      {/* export runs */}
      {staticDaily.length > 1 && (
        <polyline
          points={toPts(staticDaily)}
          fill="none"
          stroke={STATIC_COLOR}
          strokeWidth={1.5}
          opacity={0.85}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {ppoDaily.length > 1 && (
        <>
          <polyline
            points={toPts(ppoDaily)}
            fill="none"
            stroke={PPO_COLOR}
            strokeWidth={7}
            opacity={0.25}
            filter="url(#shock-ppo-glow)"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <polyline
            points={toPts(ppoDaily)}
            fill="none"
            stroke={PPO_COLOR}
            strokeWidth={2.75}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </>
      )}

      {/* live replay overlays (dashed) */}
      {liveStatic.length > 1 && (
        <polyline
          points={toPts(liveStatic)}
          fill="none"
          stroke={LIVE_STATIC_COLOR}
          strokeWidth={1.5}
          strokeDasharray="6 4"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {livePpo.length > 1 && (
        <polyline
          points={toPts(livePpo)}
          fill="none"
          stroke={LIVE_PPO_COLOR}
          strokeWidth={1.75}
          strokeDasharray="6 4"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

export function ShockReplay() {
  const { episode, profitSeries, start, starting, error, backendUp } = useEpisode();

  const [data, setData] = useState<ShockData | null>(null);
  const [failed, setFailed] = useState(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [liveStatic, setLiveStatic] = useState<ProfitPoint[]>([]);
  const [livePpo, setLivePpo] = useState<ProfitPoint[]>([]);
  const t0Ref = useRef(0);
  const idsRef = useRef<{ static?: string; ppo?: string }>({});
  const capturedRef = useRef<string | null>(null);

  useEffect(() => {
    let mounted = true;
    api
      .getCompare<ShockData>("shock")
      .then((d) => mounted && setData(d))
      .catch(() => mounted && setFailed(true));
    return () => {
      mounted = false;
    };
  }, []);

  const epLive = !!episode && (episode.status === "running" || episode.status === "paused");
  const replaying = phase === "static" || phase === "ppo";

  const runReplay = async () => {
    idsRef.current = {};
    capturedRef.current = null;
    t0Ref.current = Date.now() / 1000;
    setLiveStatic([]);
    setLivePpo([]);
    setPhase("static");
    await start({ policy: "static", ...REPLAY_PARAMS });
  };

  // sequential runner: mark our episode once it's live, capture its profit
  // series the moment it leaves running/paused, then chain into the next leg.
  useEffect(() => {
    if (!replaying || !episode) return;
    const want = phase as "static" | "ppo";
    const live = episode.status === "running" || episode.status === "paused";
    if (episode.policy === want && (live || episode.created_at >= t0Ref.current)) {
      if (!idsRef.current[want]) idsRef.current[want] = episode.id;
    }
    if (idsRef.current[want] !== episode.id || live) return;
    if (capturedRef.current === episode.id) return; // StrictMode-safe one-shot
    capturedRef.current = episode.id;
    const series = profitSeries.slice();
    // transition in a microtask — keeps setState out of the effect body and
    // collapses a re-run before the task drains into a single capture
    queueMicrotask(() => {
      if (want === "static") {
        setLiveStatic(series);
        setPhase("ppo");
        void start({ policy: "ppo", ...REPLAY_PARAMS });
      } else {
        setLivePpo(series);
        setPhase("done");
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episode?.id, episode?.status, phase, profitSeries, start, replaying]);

  // if start() failed before our leg ever attached, bail out of the replay
  useEffect(() => {
    if (!error || !replaying) return;
    const want = phase as "static" | "ppo";
    if (idsRef.current[want]) return;
    queueMicrotask(() => setPhase("idle"));
  }, [error, replaying, phase]);

  const ev = data?.event;
  const sDaily = data?.runs?.static?.daily ?? [];
  const pDaily = data?.runs?.ppo?.daily ?? [];
  const sSum = data?.runs?.static?.summary;
  const pSum = data?.runs?.ppo?.summary;

  const dProfit = statNum(pSum?.profit_usd) - statNum(sSum?.profit_usd);
  const dUtil = statNum(pSum?.utilization) - statNum(sSum?.utilization);
  const sProfit = statNum(sSum?.profit_usd);
  const pProfit = statNum(pSum?.profit_usd);
  const sAcc = statNum(sSum?.accepted);
  const pAcc = statNum(pSum?.accepted);

  // while a leg is in flight, stream the provider's live series into the chart
  const chartStatic = phase === "static" ? profitSeries : liveStatic;
  const chartPpo = phase === "ppo" ? profitSeries : livePpo;
  const hasLive = chartStatic.length > 0 || chartPpo.length > 0;

  return (
    <div className="flex flex-col gap-3">
      <SectionTitle
        icon={CloudLightning}
        right={
          hasLive ? (
            <Pill tone="accent" icon={Radio}>
              live replay
            </Pill>
          ) : undefined
        }
      >
        shock replay
      </SectionTitle>

      {failed || !data ? (
        <Empty icon={CloudLightning}>
          {failed ? "shock export unavailable" : "loading shock export…"}
        </Empty>
      ) : (
        <div>
          {/* event banner */}
          {ev && (
            <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-critical/25 bg-critical/[0.07] px-3 py-2">
              <TriangleAlert size={13} className="mt-0.5 shrink-0 text-critical" strokeWidth={1.75} />
              <div className="min-w-0">
                <p className="text-[11.5px] font-medium text-hi">
                  {String(ev.port)} closure{" "}
                  <span className="font-display tabular-nums text-pending-soft">
                    · d{Number(ev.day_lo)}–{Number(ev.day_hi)}
                  </span>
                </p>
                <p className="truncate text-[10px] text-low">{String(ev.description)}</p>
              </div>
            </div>
          )}

          {/* legend */}
          <div className="mb-2 flex items-center justify-between px-1">
            <p className="text-[10px] uppercase tracking-[0.14em] text-faint">cumulative profit</p>
            <div className="flex items-center gap-3.5">
              <span className="flex items-center gap-1.5">
                <span className="h-[3px] w-4 rounded-full" style={{ backgroundColor: STATIC_COLOR }} />
                <span className="text-[10px] text-low">static</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-[3px] w-4 rounded-full" style={{ backgroundColor: PPO_COLOR }} />
                <span className="text-[10px] font-semibold text-accent">ppo</span>
              </span>
              {hasLive && (
                <span className="flex items-center gap-1.5">
                  <span className="h-[3px] w-4 rounded-full border-t border-dashed border-accent-soft" />
                  <span className="text-[10px] text-mid">live · seed 42</span>
                </span>
              )}
            </div>
          </div>

          <ShockChart
            dayLo={Number(ev?.day_lo ?? 0)}
            dayHi={Number(ev?.day_hi ?? 0)}
            staticDaily={sDaily}
            ppoDaily={pDaily}
            liveStatic={chartStatic}
            livePpo={chartPpo}
          />

          {/* delta chips */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Pill tone={dProfit > 0 ? "ok" : "bad"}>Δ profit {signedM(dProfit)}</Pill>
            <Pill tone={dUtil > 0 ? "ok" : "bad"}>
              Δ util {dUtil > 0 ? "+" : "−"}
              {(Math.abs(dUtil) * 100).toFixed(1)}pp
            </Pill>
            <span className="text-[10.5px] text-low tabular-nums">
              static sailed into it ({fmtUsdM(sProfit)} · {sAcc.toFixed(0)} bookings) — ppo
              repriced ({fmtUsdM(pProfit)} · {pAcc.toFixed(0)} bookings,{" "}
              {fmtPct(statNum(pSum?.utilization))} util)
            </span>
          </div>

          {/* run it live */}
          <div className="mt-3 flex items-center gap-2.5 border-t border-edge-soft pt-3">
            <button
              onClick={runReplay}
              disabled={epLive || replaying || starting || backendUp === false}
              className="chip flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium text-hi transition-colors hover:border-accent/50 hover:text-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
              title="Run two real episodes: static then ppo — volatile-shocks · seed 42 · 90d · flat out"
            >
              {replaying ? (
                <Loader2 size={12} className="animate-spin text-accent" strokeWidth={1.75} />
              ) : (
                <Zap size={12} className="text-accent" strokeWidth={1.75} />
              )}
              run it live
            </button>
            <span className="text-[10px] text-faint">
              live replay · volatile-shocks · seed 42
            </span>
            {replaying && episode && (
              <span className="ml-auto flex items-center gap-1.5 text-[10px] text-mid tabular-nums">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-loaded shadow-[0_0_8px_rgba(63,191,177,0.8)]" />
                {episode.policy} · d{Math.floor(Number(episode.day))}/{episode.horizon_days}
              </span>
            )}
            {phase === "done" && (
              <span className="ml-auto text-[10px] text-loaded-soft">
                replay complete — dashed lines
              </span>
            )}
          </div>

          {error && (
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-critical/30 bg-critical/10 px-3 py-1.5 text-[11px] text-pending-soft">
              <TriangleAlert size={11} className="shrink-0 text-critical" />
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
