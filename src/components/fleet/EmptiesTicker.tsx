"use client";

import { Package } from "lucide-react";
import { useEpisode } from "@/components/dock/EpisodeProvider";
import { Pill } from "@/components/dock/ui";

/* One-row strip of port empties — Package icon + port_id + TEU count,
   sorted desc, thin horizontal scroll on overflow. Without an episode the
   strip stays mounted with a faint "no live data" pill. */
export function EmptiesTicker() {
  const { snapshot } = useEpisode();

  const entries = Object.entries(snapshot?.empties ?? {}).sort(
    (a, b) => b[1] - a[1],
  );

  return (
    <div className="scroll-thin flex items-center gap-1.5 overflow-x-auto">
      <span className="shrink-0 pr-0.5 text-[9px] uppercase tracking-[0.14em] text-faint">
        empties
      </span>
      {entries.length === 0 ? (
        <Pill tone="neutral">no live data</Pill>
      ) : (
        entries.map(([pid, teu]) => (
          <span
            key={pid}
            className="chip flex shrink-0 items-center gap-1.5 rounded-full px-2 py-[3px]"
          >
            <Package size={11} className="text-faint" strokeWidth={1.75} />
            <span className="text-[10px] font-medium text-mid">{pid}</span>
            <span className="font-display text-[11px] font-semibold text-hi tabular-nums">
              {Math.round(teu).toLocaleString("en-US")}
            </span>
          </span>
        ))
      )}
    </div>
  );
}
