"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Check,
  Expand,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { sidebarContainers, type SidebarContainer } from "@/lib/data";
import { AiChat } from "@/components/chat/AiChat";
import { SparkleButton } from "@/components/chat/SparkleButton";
import { useOps } from "@/components/ops/OpsProvider";

const toneStyles: Record<
  SidebarContainer["tone"],
  { bar: string; id: string; card: string }
> = {
  highlight: {
    bar: "bg-transparent",
    id: "text-hi",
    card: "bg-gradient-to-b from-accent-hi to-accent-deep border-transparent",
  },
  critical: { bar: "bg-critical", id: "text-critical", card: "panel-flat" },
  minor: { bar: "bg-warn", id: "text-warn", card: "panel-flat" },
  optimized: { bar: "bg-reserved", id: "text-reserved", card: "panel-flat" },
};

function ContainerCard({ c }: { c: SidebarContainer }) {
  const { query, selected, setSelected, resolved, resolve } = useOps();
  const isResolved = resolved.has(c.id);
  const t = toneStyles[isResolved ? "optimized" : c.tone];
  const highlight = c.tone === "highlight" && !isResolved;
  const isSelected = selected === c.id;
  const dimmed =
    query.trim() !== "" &&
    !`${c.id} ${c.platform} ${c.status}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());

  return (
    <button
      onClick={() => setSelected(isSelected ? null : c.id)}
      className={`relative overflow-hidden rounded-2xl px-4 pt-3.5 pb-4 text-left transition-all ${t.card} ${
        highlight ? "" : "border"
      } ${isSelected ? "ring-2 ring-accent" : ""} ${
        dimmed ? "opacity-30" : ""
      }`}
    >
      {!highlight && !isResolved && (
        <span className={`absolute left-0 top-3.5 h-3.5 w-[3px] rounded-r ${t.bar}`} />
      )}
      <div className="flex items-start justify-between">
        <div>
          <p className={`text-[13px] font-semibold tracking-wide ${t.id}`}>
            {c.id}
          </p>
          <p
            className={`mt-2 text-[11px] ${
              highlight ? "text-white/70" : "text-low"
            }`}
          >
            Platform{" "}
            <span className={highlight ? "text-white" : "text-mid"}>
              {c.platform}
            </span>
          </p>
          <p
            className={`mt-0.5 text-[11px] ${
              highlight ? "text-white/70" : "text-low"
            }`}
          >
            Status{" "}
            <span className={highlight ? "text-white" : "text-mid"}>
              {isResolved ? "Optimized" : c.status}
            </span>
          </p>
        </div>
      </div>
      <div className="mt-4 flex items-end justify-between">
        <p className="font-display text-[22px] leading-none font-medium text-hi">
          {c.weight} <span className="text-[15px] font-normal">t</span>
        </p>
        <span
          className={`rounded-full p-1.5 transition-colors ${
            highlight
              ? "bg-white/15 text-white"
              : isSelected
                ? "bg-accent/25 text-accent"
                : "text-low"
          }`}
        >
          <ArrowUpRight size={14} strokeWidth={1.75} />
        </span>
      </div>

      {/* selected details + action */}
      {isSelected && (
        <div className="mt-3 border-t border-white/10 pt-3">
          <p
            className={`text-[10px] uppercase tracking-[0.12em] ${
              highlight ? "text-white/60" : "text-faint"
            }`}
          >
            40ft hc · dry · bay {c.platform}
          </p>
          {!isResolved && c.tone !== "optimized" ? (
            <span
              role="button"
              onClick={(e) => {
                e.stopPropagation();
                resolve(c.id);
              }}
              className="chip mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-medium text-loaded-soft transition-colors hover:border-loaded/50"
            >
              <Sparkles size={10} strokeWidth={2} />
              Mark optimized
            </span>
          ) : (
            <span className="mt-2 inline-flex items-center gap-1 text-[10px] text-loaded-soft">
              <Check size={10} strokeWidth={2.5} /> optimized
            </span>
          )}
        </div>
      )}
    </button>
  );
}

export function Sidebar() {
  const [fs, setFs] = useState(false);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      setFs(false);
    } else {
      document.documentElement
        .requestFullscreen()
        .then(() => setFs(true))
        .catch(() => {});
    }
  }, []);

  return (
    <aside className="sticky top-0 flex h-screen w-[384px] shrink-0 flex-col gap-4 px-4 pt-4 pb-4">
      {/* brand + controls */}
      <div className="flex items-center justify-between">
        <span className="font-display text-[17px] font-bold italic tracking-tight text-hi">
          Arvion
        </span>
        <div className="flex items-center gap-2">
          <SparkleButton />
          <button
            onClick={toggleFullscreen}
            title={fs ? "Exit fullscreen" : "Fullscreen"}
            aria-label="Toggle fullscreen"
            className="flex h-8 w-8 items-center justify-center rounded-lg chip text-mid transition-colors hover:text-hi"
          >
            <Expand size={14} strokeWidth={1.75} />
          </button>
          <Link
            href="/fleet"
            title="Fleet controls"
            aria-label="Fleet controls"
            className="flex h-8 w-8 items-center justify-center rounded-lg chip text-mid transition-colors hover:text-hi"
          >
            <SlidersHorizontal size={14} strokeWidth={1.75} />
          </Link>
        </div>
      </div>

      {/* container cards */}
      <div className="grid shrink-0 grid-cols-2 gap-3">
        {sidebarContainers.map((c) => (
          <ContainerCard key={c.id} c={c} />
        ))}
      </div>

      {/* AI chat — blueprint analysis + composer */}
      <AiChat />
    </aside>
  );
}
