"use client";

import React, { useEffect, useRef, useState } from "react";
import { ChartLine } from "lucide-react";
import { useEpisode } from "./EpisodeProvider";
import ComparisonDialog from "./ComparisonDialog";
import { api, type SummaryData } from "@/lib/api";

function Sparkline({ points }: { points: { day: number; cum_profit: number }[] }) {
  if (points.length < 2) return null;
  const w = 64;
  const h = 18;
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
        className="chip flex items-center gap-2.5 rounded-full py-1.5 pl-3.5 pr-3 transition-colors hover:border-edge"
        title={live ? "Live cumulative profit — open policy comparison" : "PPO holdout average — open policy comparison"}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            live ? "bg-loaded shadow-[0_0_8px_rgba(63,189,176,0.9)] animate-pulse" : "bg-faint"
          }`}
        />
        {live && <Sparkline points={profitSeries} />}
        <span
          className={`font-display text-[15px] font-semibold tracking-wide tabular-nums ${
            profit < 0 ? "text-pending-soft" : "text-hi"
          }`}
        >
          {formatted}
        </span>
        <ChartLine size={13} className="text-accent" strokeWidth={1.75} />
      </button>
      <ComparisonDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
