"use client";

import { useEffect, useRef } from "react";
import {
  Bell,
  CheckCheck,
  OctagonAlert,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { sidebarContainers } from "@/lib/data";
import { useOps } from "./OpsProvider";

const toneIcon = {
  critical: OctagonAlert,
  minor: TriangleAlert,
  highlight: TriangleAlert,
  optimized: CheckCheck,
} as const;

const toneColor = {
  critical: "text-pending-soft",
  minor: "text-warn",
  highlight: "text-reserved-soft",
  optimized: "text-loaded-soft",
} as const;

const ALERT_MSG: Record<string, string> = {
  critical: "weight variance exceeds limit",
  minor: "minor stow deviation",
  highlight: "load warning — pending verification",
};

/** Alerts dropdown — opened by the bell or the "Cargo loading error" chip. */
export function AlertsPopover() {
  const { alertsOpen, setAlertsOpen, alertAcked, ackAlerts, setSelected } =
    useOps();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!alertsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setAlertsOpen(false);
    };
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && setAlertsOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [alertsOpen, setAlertsOpen]);

  if (!alertsOpen) return null;

  const alerts = sidebarContainers.filter((c) => c.tone !== "optimized");

  return (
    <div
      ref={ref}
      className="panel absolute right-0 top-11 z-50 w-[300px] rounded-2xl p-3 shadow-[0_18px_50px_rgba(0,0,0,0.6)]"
    >
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-faint">
          <Bell size={11} className="text-accent" strokeWidth={1.75} />
          alerts
        </span>
        <span className="chip rounded-full px-2 py-0.5 text-[9.5px] text-low">
          {alerts.length}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        {alerts.map((c) => {
          const Icon = toneIcon[c.tone];
          return (
            <button
              key={c.id}
              onClick={() => {
                setSelected(c.id);
                setAlertsOpen(false);
              }}
              className="flex items-start gap-2.5 rounded-xl border border-edge-soft bg-ink/40 px-3 py-2 text-left transition-colors hover:border-edge hover:bg-ink/70"
            >
              <Icon
                size={13}
                strokeWidth={1.75}
                className={`mt-0.5 shrink-0 ${toneColor[c.tone]}`}
              />
              <span className="min-w-0">
                <span className="block truncate text-[11.5px] font-medium text-hi">
                  {c.id}
                  <span className="ml-1.5 text-[10px] font-normal text-faint">
                    bay {c.platform}
                  </span>
                </span>
                <span className="block text-[10px] text-low">
                  {ALERT_MSG[c.tone] ?? c.status}
                </span>
              </span>
            </button>
          );
        })}
        <div className="flex items-start gap-2.5 rounded-xl border border-edge-soft bg-ink/40 px-3 py-2">
          <Wrench
            size={13}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0 text-mid"
          />
          <span className="min-w-0">
            <span className="block text-[11.5px] font-medium text-hi">
              Crane 2
            </span>
            <span className="block text-[10px] text-low">
              scheduled downtime 14:00
            </span>
          </span>
        </div>
      </div>

      {!alertAcked && (
        <button
          onClick={ackAlerts}
          className="chip mt-3 flex w-full items-center justify-center gap-1.5 rounded-full py-1.5 text-[10.5px] font-medium text-mid transition-colors hover:border-accent/50 hover:text-hi"
        >
          <CheckCheck size={12} strokeWidth={1.75} />
          Acknowledge all
        </button>
      )}
    </div>
  );
}
