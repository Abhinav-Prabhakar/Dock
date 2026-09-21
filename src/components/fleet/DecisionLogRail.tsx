"use client";

import React, { useMemo, useState } from "react";
import {
  ClipboardList,
  PackageCheck,
  Sailboat,
  Flag,
  FileCheck,
  Landmark,
  ScrollText,
  Layers,
  type LucideIcon,
} from "lucide-react";
import { useEpisode } from "@/components/dock/EpisodeProvider";
import type { EpisodeEvent } from "@/lib/api";
import { outcomeTone, stampFor, fmtUsd, shortHash } from "@/lib/offers";
import { Pill, Empty, SectionTitle } from "@/components/dock/ui";

/* Ops log of the live event stream — newest first, one dense line per row. */

type Filter = "all" | "bookings" | "cargo" | "sailings" | "chain";

const KNOWN = new Set([
  "booking.decision",
  "cargo.booked",
  "departure.confirmed",
  "delivery.confirmed",
]);

const FILTERS: { id: Filter; label: string; icon: LucideIcon; match: (t: string) => boolean }[] = [
  { id: "all", label: "all", icon: Layers, match: (t) => KNOWN.has(t) || t.startsWith("settlement.") },
  { id: "bookings", label: "bookings", icon: ClipboardList, match: (t) => t === "booking.decision" },
  { id: "cargo", label: "cargo", icon: PackageCheck, match: (t) => t === "cargo.booked" },
  {
    id: "sailings",
    label: "sailings",
    icon: Sailboat,
    match: (t) => t === "departure.confirmed" || t === "delivery.confirmed",
  },
  { id: "chain", label: "chain", icon: Landmark, match: (t) => t.startsWith("settlement.") },
];

const PILL_TONE = {
  won: "ok",
  counter: "accent",
  passed: "neutral",
  rejected: "bad",
} as const;

const SETTLE_TONE: Record<string, "ok" | "warn" | "neutral"> = {
  settled_full: "ok",
  settled_penalty: "warn",
  refunded: "neutral",
};

const WINDOW = 150;

function iconFor(type: string): LucideIcon {
  switch (type) {
    case "booking.decision":
      return ClipboardList;
    case "cargo.booked":
      return PackageCheck;
    case "departure.confirmed":
      return Sailboat;
    case "delivery.confirmed":
      return Flag;
    case "settlement.deal_registered":
      return Landmark;
    case "settlement.settled":
      return Landmark;
    default:
      return FileCheck; // settlement.departure_recorded / .delivery_recorded
  }
}

function mainText(ev: EpisodeEvent): string {
  const t = ev.type;
  if (t === "booking.decision" || t === "cargo.booked") {
    return `${String(ev.origin ?? "?")}→${String(ev.dest ?? "?")}`;
  }
  if (t === "departure.confirmed") {
    const dest = ev.dest_call ? `→${String(ev.dest_call)}` : " dep";
    return `${String(ev.port ?? "?")}${dest} · ${String(ev.vessel_id ?? "")}`;
  }
  if (t === "delivery.confirmed") {
    return `${String(ev.port ?? "?")} · ${String(ev.vessel_id ?? "")}`;
  }
  if (t === "settlement.deal_registered") {
    return `${String(ev.origin ?? "?")}→${String(ev.dest ?? "?")} · ${Number(ev.teu ?? 0)}teu`;
  }
  // settlement.*_recorded / settled — anchor on the deal id
  return shortHash(String(ev.deal_id ?? ""));
}

function rightFor(ev: EpisodeEvent): React.ReactNode {
  const t = ev.type;
  if (t === "booking.decision") {
    const stamp = stampFor(ev);
    return <Pill tone={PILL_TONE[outcomeTone(String(ev.outcome ?? ""))]}>{stamp.text}</Pill>;
  }
  if (t === "cargo.booked") {
    return (
      <span className="text-[10px] text-mid tabular-nums">
        {String(ev.vessel_id ?? "")} · d{Number(ev.board_day ?? ev.day ?? 0)}
      </span>
    );
  }
  if (t === "departure.confirmed") {
    const planned = Number(ev.planned_etd ?? NaN);
    const actual = Number(ev.actual_day ?? ev.day ?? 0);
    const late = Number.isFinite(planned) && actual > planned;
    return (
      <span className={`text-[10px] tabular-nums ${late ? "text-warn" : "text-mid"}`}>
        etd {Number.isFinite(planned) ? `d${planned}→` : ""}d{actual}
      </span>
    );
  }
  if (t === "delivery.confirmed") {
    return (
      <span className="text-[10px] text-loaded-soft tabular-nums">
        +{fmtUsd(Number(ev.price ?? 0))}
      </span>
    );
  }
  if (t === "settlement.deal_registered") {
    return (
      <span className="text-[10px] text-mid tabular-nums">{fmtUsd(Number(ev.price_usd ?? 0))}</span>
    );
  }
  if (t === "settlement.settled") {
    const outcome = String(ev.outcome ?? "");
    return (
      <span className="flex items-center gap-1.5">
        <span className="text-[10px] text-mid tabular-nums">
          {fmtUsd(Number(ev.amount_usd ?? 0))}
        </span>
        <Pill tone={SETTLE_TONE[outcome] ?? "neutral"}>
          {outcome.replace("settled_", "").replace("_", " ") || "settled"}
        </Pill>
      </span>
    );
  }
  // departure_recorded / delivery_recorded
  return (
    <span className="text-[10px] text-low tabular-nums">d{Number(ev.actual_day ?? ev.day ?? 0)}</span>
  );
}

export function DecisionLogRail() {
  const { events } = useEpisode();
  const [filter, setFilter] = useState<Filter>("all");

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, bookings: 0, cargo: 0, sailings: 0, chain: 0 };
    for (const ev of events) {
      for (const f of FILTERS) if (f.match(ev.type)) c[f.id] += 1;
    }
    return c;
  }, [events]);

  const rows = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter) ?? FILTERS[0];
    return events.filter((e) => f.match(e.type)).slice(-WINDOW).reverse();
  }, [events, filter]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <style>{`@keyframes dlog-in{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:none}}`}</style>
      <SectionTitle icon={ScrollText}>decision log</SectionTitle>

      {/* filter chips */}
      <div className="flex flex-wrap items-center gap-1.5 px-1 pb-2">
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                active
                  ? "border-accent/50 bg-accent/15 text-[#aab4ff]"
                  : "chip text-low hover:text-mid"
              }`}
            >
              <f.icon size={10} strokeWidth={1.75} />
              {f.label}
              <span className={`tabular-nums ${active ? "text-accent" : "text-faint"}`}>
                {counts[f.id]}
              </span>
            </button>
          );
        })}
      </div>

      {/* newest-first list */}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pr-1">
        {rows.length === 0 ? (
          <Empty icon={ScrollText}>no decisions yet — start an episode</Empty>
        ) : (
          <div className="space-y-0.5 pb-2">
            {rows.map((ev) => {
              const Icon = iconFor(ev.type);
              return (
                <div
                  key={ev.seq}
                  style={{ animation: "dlog-in .3s ease-out" }}
                  className="flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-white/[0.03]"
                >
                  <span className="w-7 shrink-0 font-display text-[10px] font-medium text-faint tabular-nums">
                    d{Number(ev.day ?? 0)}
                  </span>
                  <Icon size={11} strokeWidth={1.75} className="shrink-0 text-low" />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-mid">
                    {mainText(ev)}
                  </span>
                  <span className="shrink-0">{rightFor(ev)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
