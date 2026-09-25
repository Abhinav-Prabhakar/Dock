"use client";

import { useEffect, useState } from "react";
import {
  X,
  Loader2,
  TriangleAlert,
  Gauge,
  Leaf,
  Container,
  Handshake,
  Repeat,
  GitBranch,
  Dices,
  Layers,
  CalendarClock,
} from "lucide-react";
import { api, type SummaryData, type TimelineData, type MetaData } from "@/lib/api";

interface ComparisonDialogProps {
  open: boolean;
  onClose: () => void;
}

const POLICY_COLORS: Record<string, string> = {
  static: "#4c5380",
  greedy: "#a3abd6",
  heuristic: "#d9ae3c",
  heuristic_bid: "#3fbfb1",
  ppo: "#7c87f2",
};

const POLICY_NAMES: Record<string, string> = {
  static: "Static Rate Card",
  greedy: "Greedy",
  heuristic: "Heuristic",
  heuristic_bid: "Heuristic + Bid",
  ppo: "Dock · PPO",
};

const POLICY_ORDER = ["static", "greedy", "heuristic", "heuristic_bid", "ppo"];

const fmtM = (v: number) =>
  `${v < 0 ? "−" : ""}$${(Math.abs(v) / 1e6).toFixed(1)}M`;
const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;
const fmtSignedPct = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(1)}%`;

export default function ComparisonDialog({ open, onClose }: ComparisonDialogProps) {
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [timeline, setTimeline] = useState<TimelineData | null>(null);
  const [meta, setMeta] = useState<MetaData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setLoading(true);
        setFailed(false);
      }
    });
    Promise.all([
      api.getCompare<SummaryData>("summary"),
      api.getCompare<TimelineData>("timeline"),
      api.getCompare<MetaData>("meta"),
    ])
      .then(([s, t, m]) => {
        if (cancelled) return;
        setSummary(s);
        setTimeline(t);
        setMeta(m);
      })
      .catch(() => !cancelled && setFailed(true))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-abyss/80 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="panel relative flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border-edge shadow-[0_24px_80px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-6 py-4">
          <div className="flex items-center gap-3">
            <Layers size={15} className="text-accent" strokeWidth={1.75} />
            <h2 className="font-display text-[17px] font-semibold tracking-tight text-hi">
              Policy Ladder
            </h2>
            <span className="text-[10px] uppercase tracking-[0.14em] text-faint">
              identical scenarios · identical seeds
            </span>
          </div>
          <button
            onClick={onClose}
            className="chip flex h-8 w-8 items-center justify-center rounded-full text-mid transition-colors hover:text-hi"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          {loading ? (
            <div className="flex h-64 items-center justify-center text-low">
              <Loader2 size={20} className="animate-spin" />
            </div>
          ) : failed || !summary ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3 text-low">
              <TriangleAlert size={20} className="text-warn" />
              <p className="text-[12px]">comparison export missing — run scripts.export_demo</p>
            </div>
          ) : (
            <>
              <PolicyLadder summary={summary} meta={meta} />
              {timeline && <RacingChart timeline={timeline} />}
              <MetricsChips summary={summary} />
              <SegmentStrip summary={summary} />
              {meta && <Provenance meta={meta} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PolicyLadder({ summary, meta }: { summary: SummaryData; meta: MetaData | null }) {
  const present = new Set(meta?.policies_present ?? Object.keys(summary.policies));
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {POLICY_ORDER.map((key, i) => {
        const policy = summary.policies[key];
        if (!policy) return null;
        const lift = summary.lift_vs_static?.[key];
        const isPpo = key === "ppo";
        return (
          <div
            key={key}
            className={`relative rounded-2xl px-4 pb-4 pt-3.5 ${
              isPpo
                ? "border border-accent/50 bg-gradient-to-b from-accent/15 to-accent-deep/10 shadow-[0_0_24px_rgba(124,135,242,0.18)]"
                : "panel-flat"
            }`}
          >
            <div className="flex items-center justify-between">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: POLICY_COLORS[key] }}
              />
              <span className="text-[9px] uppercase tracking-[0.12em] text-faint">
                rung {i + 1}
              </span>
            </div>
            <p className={`mt-2 text-[11px] font-medium ${isPpo ? "text-hi" : "text-mid"}`}>
              {POLICY_NAMES[key] ?? key}
              {!present.has(key) && <span className="text-faint"> · n/a</span>}
            </p>
            <p className="mt-2 font-display text-[24px] leading-none font-semibold tracking-tight text-hi tabular-nums">
              {fmtM(policy.profit_usd.mean)}
            </p>
            <p className="mt-1 text-[10px] text-low tabular-nums">
              ± {fmtM(policy.profit_usd.std)}
            </p>
            {key !== "static" && (
              <div className="mt-2.5">
                {lift ? (
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums ${
                      lift.profit_usd_pct > 0
                        ? "bg-loaded/15 text-loaded-soft"
                        : "bg-critical/15 text-pending-soft"
                    }`}
                  >
                    {fmtSignedPct(lift.profit_usd_pct)}
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-low">
                    static ≤ 0
                  </span>
                )}
              </div>
            )}
            <div className="mt-3 space-y-1 border-t border-edge-soft pt-2.5 text-[10.5px]">
              <div className="flex justify-between">
                <span className="text-faint">rev/teu</span>
                <span className="text-mid tabular-nums">
                  ${policy.revenue_per_teu.mean.toFixed(0)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-faint">util</span>
                <span className="text-mid tabular-nums">
                  {fmtPct(policy.utilization.mean)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RacingChart({ timeline }: { timeline: TimelineData }) {
  const width = 1000;
  const height = 320;
  const margin = { top: 16, right: 24, bottom: 34, left: 56 };
  const iw = width - margin.left - margin.right;
  const ih = height - margin.top - margin.bottom;

  let maxProfit = 0;
  let maxDay = 90;
  Object.values(timeline.policies).forEach((days) => {
    days.forEach((d) => {
      if (d.cum_profit > maxProfit) maxProfit = d.cum_profit;
      if (d.day > maxDay) maxDay = d.day;
    });
  });
  const yMax = Math.max(1, Math.ceil(maxProfit / 1e7) * 1e7);
  const getX = (day: number) => margin.left + ((day - 1) / Math.max(1, maxDay - 1)) * iw;
  const getY = (v: number) => margin.top + ih - (v / yMax) * ih;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const xTicks = Array.from({ length: 7 }, (_, i) => 1 + Math.round((i * (maxDay - 1)) / 6));

  return (
    <div className="panel-flat rounded-2xl p-5">
      <div className="mb-3 flex items-center justify-between px-1">
        <p className="text-[10px] uppercase tracking-[0.14em] text-faint">
          cumulative profit
        </p>
        <div className="flex items-center gap-4">
          {POLICY_ORDER.map((key) => (
            <div key={key} className="flex items-center gap-1.5">
              <span
                className="h-[3px] w-4 rounded-full"
                style={{ backgroundColor: POLICY_COLORS[key] }}
              />
              <span
                className={`text-[10px] ${key === "ppo" ? "font-semibold text-accent" : "text-low"}`}
              >
                {POLICY_NAMES[key]}
              </span>
            </div>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full">
        <defs>
          <filter id="ppo-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="5" />
          </filter>
        </defs>
        {yTicks.map((t, i) => (
          <g key={i}>
            <line
              x1={margin.left}
              y1={getY(t)}
              x2={width - margin.right}
              y2={getY(t)}
              stroke="rgba(152,162,226,0.09)"
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
              ${(t / 1e6).toFixed(0)}M
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text
            key={i}
            x={getX(t)}
            y={height - 12}
            fill="#4c5380"
            fontSize="11"
            textAnchor="middle"
          >
            d{t}
          </text>
        ))}
        {POLICY_ORDER.map((key) => {
          const data = timeline.policies[key];
          if (!data?.length) return null;
          const pts = data.map((d) => `${getX(d.day)},${getY(d.cum_profit)}`).join(" ");
          return (
            <g key={key}>
              {key === "ppo" && (
                <polyline
                  points={pts}
                  fill="none"
                  stroke={POLICY_COLORS[key]}
                  strokeWidth={7}
                  opacity={0.25}
                  filter="url(#ppo-glow)"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )}
              <polyline
                points={pts}
                fill="none"
                stroke={POLICY_COLORS[key]}
                strokeWidth={key === "ppo" ? 2.75 : 1.5}
                opacity={key === "ppo" ? 1 : 0.75}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function MetricsChips({ summary }: { summary: SummaryData }) {
  const ppo = summary.policies.ppo;
  const stat = summary.policies.static;
  if (!ppo || !stat) return null;

  const chips = [
    {
      icon: Gauge,
      label: "utilization",
      value: fmtPct(ppo.utilization.mean),
      delta: ppo.utilization.mean - stat.utilization.mean,
      fmt: (v: number) => `${v > 0 ? "+" : "−"}${(Math.abs(v) * 100).toFixed(1)}pp`,
      good: (v: number) => v > 0,
    },
    {
      icon: Leaf,
      label: "co₂ / teu",
      value: `${ppo.co2_per_teu.mean.toFixed(2)}t`,
      delta: ppo.co2_per_teu.mean - stat.co2_per_teu.mean,
      fmt: (v: number) => `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}t`,
      good: (v: number) => v < 0,
    },
    {
      icon: Container,
      label: "empty teu·nm",
      value: `${(ppo.empty_teu_nm.mean / 1e6).toFixed(1)}M`,
      delta: (ppo.empty_teu_nm.mean - stat.empty_teu_nm.mean) / 1e6,
      fmt: (v: number) => `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}M`,
      good: (v: number) => v < 0,
    },
    {
      icon: Handshake,
      label: "counter win",
      value: fmtPct(ppo.counter_win_rate?.mean ?? 0),
    },
    {
      icon: Repeat,
      label: "reject→counter",
      value: fmtPct(ppo.reject_to_counter_conv?.mean ?? 0),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {chips.map((c) => (
        <div key={c.label} className="panel-flat flex flex-col gap-1.5 rounded-xl px-3.5 py-3">
          <div className="flex items-center gap-1.5 text-faint">
            <c.icon size={11} strokeWidth={1.75} />
            <span className="text-[9.5px] uppercase tracking-[0.12em]">{c.label}</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-display text-[17px] font-semibold text-hi tabular-nums">
              {c.value}
            </span>
            {c.delta !== undefined && c.delta !== 0 && c.fmt && (
              <span
                className={`text-[10px] font-medium tabular-nums ${
                  c.good!(c.delta) ? "text-loaded-soft" : "text-pending-soft"
                }`}
              >
                {c.fmt(c.delta)}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function SegmentStrip({ summary }: { summary: SummaryData }) {
  const ppo = summary.policies.ppo;
  if (!ppo?.segments) return null;
  return (
    <div className="panel-flat rounded-2xl p-5">
      <p className="mb-4 text-[10px] uppercase tracking-[0.14em] text-faint">
        dock · ppo — booked / requested by segment
      </p>
      <div className="grid grid-cols-3 gap-6">
        {(["urgent", "standard", "flexible"] as const).map((seg) => {
          const s = ppo.segments[seg];
          if (!s) return null;
          const pct = s.requests > 0 ? (s.booked / s.requests) * 100 : 0;
          return (
            <div key={seg}>
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="text-[11px] font-medium capitalize text-mid">{seg}</span>
                <span className="text-[10px] text-faint tabular-nums">
                  {s.booked.toFixed(0)}/{s.requests.toFixed(0)}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-accent-deep to-accent"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Provenance({ meta }: { meta: MetaData }) {
  const items: [typeof GitBranch, string][] = [
    [GitBranch, meta.git_sha ? meta.git_sha.slice(0, 8) : "worktree"],
    [CalendarClock, new Date(meta.generated_at).toLocaleDateString()],
    [Dices, `seed ${meta.seed}`],
    [Layers, `${meta.episodes} ep × ${meta.horizon_days}d`],
  ];
  return (
    <div className="flex items-center justify-between border-t border-edge-soft pt-4">
      <div className="flex items-center gap-4">
        {items.map(([Icon, text], i) => (
          <span key={i} className="flex items-center gap-1.5 text-[10px] text-faint">
            <Icon size={11} strokeWidth={1.75} />
            {text}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        {(meta.scenarios ?? []).map((s) => (
          <span key={s} className="chip rounded-full px-2 py-0.5 text-[9.5px] text-low">
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}
