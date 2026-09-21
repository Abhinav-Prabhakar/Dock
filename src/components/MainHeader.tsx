"use client";

import Link from "next/link";
import {
  Bell,
  CheckCheck,
  ChevronDown,
  Search,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from "lucide-react";
import { sidebarContainers } from "@/lib/data";
import { useOps } from "@/components/ops/OpsProvider";
import { AlertsPopover } from "@/components/ops/AlertsPopover";

function SideViewGlyph({ active }: { active?: boolean }) {
  const c = active ? "#eef0ff" : "rgba(154,161,201,0.9)";
  return (
    <svg viewBox="0 0 34 12" className="h-3 w-9" fill="none" aria-hidden>
      <path d="M2 5 L5 9 L28 9 L32 5 Z" fill={c} />
      <rect x="20" y="1.5" width="7" height="3.5" rx="0.75" fill={c} />
      <rect x="7" y="3" width="4" height="2" rx="0.5" fill={c} opacity="0.65" />
      <rect x="12" y="3" width="4" height="2" rx="0.5" fill={c} opacity="0.65" />
    </svg>
  );
}

function TopViewGlyph({ active }: { active?: boolean }) {
  const c = active ? "#eef0ff" : "rgba(154,161,201,0.9)";
  return (
    <svg viewBox="0 0 34 14" className="h-3.5 w-9" fill="none" aria-hidden>
      <rect x="2" y="1.5" width="30" height="11" rx="5.5" stroke={c} strokeWidth="1.25" />
      {[9, 14, 19, 24].map((x) => (
        <line key={x} x1={x} y1={4} x2={x} y2={10} stroke={c} strokeWidth="0.75" opacity="0.8" />
      ))}
    </svg>
  );
}

export function MainHeader() {
  const {
    query,
    setQuery,
    setSelected,
    view,
    setView,
    setAlertsOpen,
    alertAcked,
    resolved,
  } = useOps();

  const activeAlerts = sidebarContainers.filter(
    (c) => c.tone !== "optimized" && !resolved.has(c.id),
  );
  const showError = !alertAcked && activeAlerts.length > 0;

  const submitSearch = () => {
    const q = query.trim().toLowerCase();
    if (!q) return;
    const hit = sidebarContainers.find((c) =>
      `${c.id} ${c.platform} ${c.status}`.toLowerCase().includes(q),
    );
    if (hit) setSelected(hit.id);
  };

  const viewBtn = (active: boolean) =>
    `flex h-9 w-20 items-center justify-center rounded-full transition-colors ${
      active
        ? "border border-edge bg-panel-3 shadow-[0_0_16px_rgba(80,95,220,0.25)]"
        : "chip hover:border-edge"
    }`;

  return (
    <header className="relative">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-[30px] font-semibold tracking-tight text-hi">
            Dock Operations
          </h1>
          <p className="mt-1 text-[11.5px] text-low">Last update 1 min ago</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="chip flex h-9 w-52 items-center gap-2 rounded-full px-3.5 transition-colors focus-within:border-accent/50">
            <input
              id="ops-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitSearch()}
              onKeyUp={(e) => e.key === "Escape" && setQuery("")}
              placeholder="Container search"
              aria-label="Container search"
              className="min-w-0 flex-1 bg-transparent text-[11.5px] text-hi outline-none placeholder:text-low"
            />
            {query ? (
              <button
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="text-low transition-colors hover:text-hi"
              >
                <X size={13} />
              </button>
            ) : (
              <Search size={13} className="text-low" />
            )}
          </div>
          <Link
            href="/fleet"
            title="Fleet ops"
            aria-label="Fleet ops"
            className="chip flex h-9 w-9 items-center justify-center rounded-full text-mid transition-colors hover:text-hi"
          >
            <SlidersHorizontal size={14} strokeWidth={1.75} />
          </Link>
          <div className="relative">
            <button
              onClick={() => setAlertsOpen(true)}
              aria-label="Alerts"
              title="Alerts"
              className="chip relative flex h-9 w-9 items-center justify-center rounded-full text-mid transition-colors hover:text-hi"
            >
              <Bell size={14} strokeWidth={1.75} />
              {showError && (
                <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-critical" />
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-5 flex items-start justify-between">
        {/* view toggle */}
        <div className="flex items-start gap-3">
          <div className="flex flex-col items-center gap-1.5">
            <button
              onClick={() => setView("side")}
              aria-pressed={view === "side"}
              className={viewBtn(view === "side")}
            >
              <SideViewGlyph active={view === "side"} />
            </button>
            <span className={view === "side" ? "text-[10px] text-mid" : "text-[10px] text-low"}>
              Side View
            </span>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <button
              onClick={() => setView("top")}
              aria-pressed={view === "top"}
              className={viewBtn(view === "top")}
            >
              <TopViewGlyph active={view === "top"} />
            </button>
            <span className={view === "top" ? "text-[10px] text-mid" : "text-[10px] text-low"}>
              Top View
            </span>
          </div>
        </div>

        {/* alert chip — opens the same popover, clears on acknowledge */}
        <div>
          <button
            onClick={() => setAlertsOpen(true)}
            className={`chip flex items-center gap-2 rounded-full py-2 pr-2.5 pl-3 text-[11.5px] transition-colors hover:border-edge ${
              showError ? "text-hi" : "text-loaded-soft"
            }`}
          >
            {showError ? (
              <>
                <TriangleAlert
                  size={13}
                  className="text-critical"
                  fill="rgba(240,82,79,0.25)"
                />
                Cargo loading error
                <ChevronDown size={13} className="text-low" />
              </>
            ) : (
              <>
                <CheckCheck size={13} className="text-loaded-soft" />
                All clear
              </>
            )}
          </button>
        </div>
      </div>
      <AlertsPopover />
    </header>
  );
}
