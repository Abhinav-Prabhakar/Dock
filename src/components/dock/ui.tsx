"use client";

import React, { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Hash, Check, Copy } from "lucide-react";
import { shortHash } from "@/lib/offers";

/* Shared micro-primitives — the Dock visual language in one place.
   Every new surface should be built from these so the app stays coherent:
   panel-flat cards, rounded-full chips, 9–12px micro-labels, lucide icons
   at strokeWidth 1.75, Outfit (font-display) numerals, tabular-nums. */

/** Uppercase micro section header with a leading icon. */
export function SectionTitle({
  icon: Icon,
  children,
  right,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-1 pb-2">
      <div className="flex items-center gap-2">
        <Icon size={12} className="text-accent" strokeWidth={1.75} />
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">
          {children}
        </span>
      </div>
      {right}
    </div>
  );
}

/** Small status pill — `tone` picks the colorway. */
export function Pill({
  tone = "neutral",
  icon: Icon,
  children,
}: {
  tone?: "ok" | "warn" | "bad" | "accent" | "neutral";
  icon?: LucideIcon;
  children: React.ReactNode;
}) {
  const tones = {
    ok: "bg-loaded/12 text-loaded-soft border-loaded/30",
    warn: "bg-reserved/12 text-reserved-soft border-reserved/30",
    bad: "bg-critical/12 text-pending-soft border-critical/30",
    accent: "bg-accent/15 text-[#aab4ff] border-accent/40",
    neutral: "bg-white/5 text-low border-edge",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${tones[tone]}`}
    >
      {Icon && <Icon size={10} strokeWidth={2} />}
      {children}
    </span>
  );
}

/** Live status dot (running pulse / warn / idle). */
export function StatusDot({
  tone = "idle",
}: {
  tone?: "live" | "warn" | "done" | "idle";
}) {
  const cls = {
    live: "bg-loaded shadow-[0_0_8px_rgba(63,189,176,0.8)] animate-pulse",
    warn: "bg-warn",
    done: "bg-accent",
    idle: "bg-faint",
  }[tone];
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`} />;
}

/** Copyable truncated hash (tx hashes, deal ids, contract addrs). */
export function HashChip({ value }: { value?: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-faint">—</span>;
  return (
    <button
      className="chip inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9.5px] text-low transition-colors hover:text-hi"
      title={`${value} — click to copy`}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      <Hash size={9} className="shrink-0 opacity-60" />
      {shortHash(value)}
      {copied ? (
        <Check size={9} className="text-loaded-soft" />
      ) : (
        <Copy size={9} className="opacity-0 transition-opacity group-hover:opacity-60" />
      )}
    </button>
  );
}

/** Thin capacity/progress meter bar. */
export function MeterBar({
  pct,
  tone = "accent",
}: {
  pct: number; // 0..1
  tone?: "accent" | "loaded" | "warn" | "bad";
}) {
  const fills = {
    accent: "bg-gradient-to-r from-accent-deep to-accent",
    loaded: "bg-gradient-to-r from-[#2a8a80] to-loaded",
    warn: "bg-gradient-to-r from-[#9c7f28] to-reserved",
    bad: "bg-gradient-to-r from-[#8f3a4e] to-critical",
  } as const;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink">
      <div
        className={`h-full rounded-full transition-[width] duration-500 ${fills[tone]}`}
        style={{ width: `${Math.min(100, Math.max(0, pct * 100))}%` }}
      />
    </div>
  );
}

/** Centered empty/idle state — icon + one line. */
export function Empty({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2.5 text-center">
      <Icon size={20} className="text-faint" strokeWidth={1.5} />
      <p className="max-w-[220px] text-[11px] leading-relaxed text-low">{children}</p>
    </div>
  );
}
