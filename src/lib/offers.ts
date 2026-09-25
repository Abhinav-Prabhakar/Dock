import type { EpisodeEvent } from "@/lib/api";

/** Human label for negotiated (counter-offer) kinds. */
export const COUNTER_KIND_LABEL: Record<string, string> = {
  flex_window: "flex window",
  alt_hub: "alt hub",
  split: "split",
};

export const CARGO_ICON: Record<string, string> = {
  dry: "▣",
  reefer: "❄",
  hazmat: "⚠",
};

export const SEGMENT_COLORS: Record<string, string> = {
  urgent: "#f0899a",
  standard: "#a8b8d8",
  flexible: "#7fd9d0",
};

export interface StampVerdict {
  cls: "booked" | "counter" | "passed" | "rejected";
  text: string;
}

/**
 * Map a live booking.decision event to its rubber-stamp verdict.
 * outcome: booked* | price_reject | declined | counter_declined* | rejected*
 * kind:    accept | flex_window | alt_hub | split | reject ...
 */
export function stampFor(ev: EpisodeEvent): StampVerdict {
  const outcome = String(ev.outcome ?? "");
  const kind = String(ev.kind ?? "");
  const counter = COUNTER_KIND_LABEL[kind];
  if (outcome.startsWith("booked")) {
    return counter
      ? { cls: "counter", text: `DEAL · ${counter.toUpperCase()}` }
      : { cls: "booked", text: "BOOKED" };
  }
  if (outcome.startsWith("counter_declined")) return { cls: "passed", text: "NO DEAL" };
  if (outcome === "declined" || outcome === "price_reject")
    return { cls: "passed", text: "PASSED" };
  return { cls: "rejected", text: "REJECTED" };
}

/** Coarse outcome bucket for colouring/pill logic across surfaces. */
export function outcomeTone(
  outcome: string,
): "won" | "counter" | "passed" | "rejected" {
  if (outcome.startsWith("booked")) {
    return "won"; // note: booked:flex_window etc. count as won deals too
  }
  if (outcome.startsWith("counter_declined")) return "passed";
  if (outcome === "declined" || outcome === "price_reject") return "passed";
  return "rejected";
}

export const fmtUsd = (v: number) => "$" + Math.round(v).toLocaleString("en-US");

export const fmtUsdM = (v: number) =>
  `${v < 0 ? "−" : ""}$${(Math.abs(v) / 1e6).toFixed(1)}M`;

export const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;

export const shortHash = (h?: string | null) =>
  h ? `${h.slice(0, 8)}…${h.slice(-4)}` : "—";

/** "flex_window" → "Flex Window", also handles "booked:flex_window" prefixes. */
export function humanizeToken(s: string) {
  return s
    .split(":")[0]
    .split(/[_-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
