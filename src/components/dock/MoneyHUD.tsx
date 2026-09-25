"use client";

import React, { useEffect, useRef, useState } from "react";
import { ChartLine } from "lucide-react";
import { useEpisode } from "./EpisodeProvider";
import ComparisonDialog from "./ComparisonDialog";
import { api, type SummaryData } from "@/lib/api";

function Sparkline({ points }: { points: { day: number; cum_profit: number }[] }) {
  if (points.length < 2) return null;
  const w = 72;
  const h = 22;
  const vals = points.slice(-48).map((p) => p.cum_profit);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const pts = vals
    .map(
      (v, i) =>
        `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg width={w} height={h} className="shrink-0" aria-hidden>
      <polyline
        points={pts}
        fill="none"
        stroke="var(--color-loaded)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MoneyHUD() {
  const { metrics, profitSeries, episode } = useEpisode();
  const [fallback, setFallback] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const fetched = useRef(false);

  const live = !!episode && !!metrics;
  const profit = metrics?.cum_profit ?? fallback ?? 0;

  useEffect(() => {
    if (live || fetched.current) return;
    fetched.current = true;
    api
      .getCompare<SummaryData>("summary")
      .then((s) => setFallback(s?.policies?.ppo?.profit_usd?.mean ?? null))
      .catch(() => setFallback(null));
  }, [live]);

  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(profit);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="group flex items-center gap-3 rounded-xl border border-transparent px-3 py-1 transition-colors hover:border-edge hover:bg-white/[0.03]"
        title={live ? "Live cumulative profit — open policy comparison" : "PPO holdout average — open policy comparison"}
      >
        <Sparkline points={profitSeries} />
        <span className="flex flex-col items-end gap-0.5">
          <span className="flex items-center gap-1.5 text-[8px] font-medium uppercase leading-none tracking-[0.2em] text-faint">
            <span
              className={`h-1 w-1 rounded-full ${
                live ? "bg-loaded shadow-[0_0_6px_rgba(63,191,177,0.9)] animate-pulse" : "bg-faint"
              }`}
            />
            {live ? "cum profit · live" : "ppo holdout avg"}
          </span>
          <span
            className={`font-display text-[19px] font-semibold leading-tight tracking-tight tabular-nums ${
              profit < 0 ? "text-pending-soft" : "text-brass-soft"
            }`}
          >
            {formatted}
          </span>
        </span>
        <ChartLine
          size={13}
          className="text-faint transition-colors group-hover:text-accent-soft"
          strokeWidth={1.75}
        />
      </button>
      <ComparisonDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
