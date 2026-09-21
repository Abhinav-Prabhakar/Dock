"use client";

import { Fragment, useCallback, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlarmClockCheck,
  Anchor,
  ArrowLeftRight,
  BadgeCheck,
  BadgePercent,
  CalendarCheck,
  CalendarClock,
  CalendarRange,
  Ghost,
  Hourglass,
  Landmark,
  Loader2,
  PackageCheck,
  PackageX,
  Route,
  ScrollText,
  ShieldCheck,
  Ship,
  Split,
} from "lucide-react";
import { api, ApiError, type Deal } from "@/lib/api";
import { useEpisode } from "@/components/dock/EpisodeProvider";
import {
  COUNTER_KIND_LABEL,
  SEGMENT_COLORS,
  fmtUsd,
  humanizeToken,
} from "@/lib/offers";
import { Empty, HashChip, Pill, SectionTitle } from "@/components/dock/ui";

const KIND_ICON: Record<string, LucideIcon> = {
  flex_window: CalendarClock,
  alt_hub: ArrowLeftRight,
  split: Split,
};

const STAGES: { key: string; icon: LucideIcon }[] = [
  { key: "registered", icon: CalendarCheck },
  { key: "departed", icon: Anchor },
  { key: "delivered", icon: PackageCheck },
  { key: "settled", icon: BadgeCheck },
];

const STAGE_COLOR = ["#6a73ea", "#d9b13b", "#3fbdb0", "#3fbdb0"];

function settleColor(outcome: string): string {
  if (outcome === "settled_penalty") return "#e5a33c";
  if (outcome === "refunded") return "#6c739b";
  return "#3fbdb0";
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

type VerifyState =
  | { state: "idle" }
  | { state: "busy" }
  | { state: "ok"; n: number }
  | { state: "bad"; msg: string };

export function DealsRail() {
  const { deals, episode } = useEpisode();
  // verify result is keyed to the episode it ran on — auto-resets on switch
  const [verify, setVerify] = useState<{ ep: string; v: VerifyState } | null>(
    null,
  );

  const runVerify = useCallback(async () => {
    if (!episode) return;
    const ep = episode.id;
    setVerify({ ep, v: { state: "busy" } });
    const done = (v: VerifyState) =>
      setVerify((cur) => (cur?.ep === ep ? { ep, v } : cur));
    try {
      const r = await api.verifyLedger(ep);
      done(
        r.ok
          ? { state: "ok", n: num(r.n_events) }
          : {
              state: "bad",
              msg: r.detail || `chain break at seq ${r.first_bad_seq ?? "?"}`,
            },
      );
    } catch (e) {
      done({
        state: "bad",
        msg: e instanceof ApiError ? e.message : "verify failed",
      });
    }
  }, [episode]);

  const verifyView: VerifyState =
    verify && verify.ep === episode?.id ? verify.v : { state: "idle" };

  const live = episode?.status === "running" || episode?.status === "paused";
  const sorted = [...deals]
    .sort(
      (a, b) =>
        num(b.register_day) - num(a.register_day) ||
        num(b.request_id) - num(a.request_id),
    )
    .slice(0, 50);
  const busy = verifyView.state === "busy";
  const verifyTitle = episode
    ? "re-hash the event chain and check each link"
    : "start an episode first";

  return (
    <aside className="flex h-full min-h-0 w-full flex-col">
      <style>{`
        @keyframes dealIn {
          from { opacity: 0; transform: translateY(8px) scale(0.985); }
          to { opacity: 1; transform: none; }
        }
        .deal-card { animation: dealIn 0.35s cubic-bezier(0.32, 0.72, 0, 1) both; }
      `}</style>

      <div className="px-4 pb-1 pt-4">
        <SectionTitle
          icon={ScrollText}
          right={
            <div className="flex items-center gap-1.5">
              <span className="chip rounded-full px-2 py-0.5 font-display text-[10px] text-low tabular-nums">
                {deals.length}
              </span>
              <button
                onClick={runVerify}
                disabled={!episode || busy}
                title={verifyTitle}
                className="chip flex h-5 w-5 items-center justify-center rounded-full text-low transition-colors hover:text-hi disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <ShieldCheck size={10} strokeWidth={1.75} />
                )}
              </button>
            </div>
          }
        >
          on-chain deals
        </SectionTitle>
      </div>

      <div className="scroll-thin min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 pb-3 pt-1">
        {sorted.length === 0 ? (
          live || episode ? (
            <Empty icon={PackageX}>
              no conditional deals yet — this policy never counters
            </Empty>
          ) : (
            <Empty icon={Ghost}>start an episode — deals appear here</Empty>
          )
        ) : (
          sorted.map((d) => <DealCard key={d.deal_id} deal={d} />)
        )}
      </div>

      <div className="border-t border-edge-soft px-3 py-2.5">
        <button
          onClick={runVerify}
          disabled={!episode || busy}
          title={verifyTitle}
          className="chip flex w-full items-center justify-center gap-1.5 rounded-full py-1.5 text-[10.5px] text-mid transition-colors hover:text-hi disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <ShieldCheck size={11} strokeWidth={1.75} />
          )}
          verify ledger
        </button>
        {verifyView.state === "ok" && (
          <p className="mt-1.5 text-center text-[10px] tabular-nums text-loaded-soft">
            {verifyView.n} events · hash chain intact
          </p>
        )}
        {verifyView.state === "bad" && (
          <p className="mt-1.5 text-center text-[10px] leading-snug text-pending-soft">
            {verifyView.msg}
          </p>
        )}
      </div>
    </aside>
  );
}

function DealCard({ deal }: { deal: Deal }) {
  const kind = String(deal.kind ?? "");
  const KindIcon = KIND_ICON[kind] ?? Route;
  const kindLabel = COUNTER_KIND_LABEL[kind] ?? humanizeToken(kind);
  const seg = String(deal.segment ?? "standard");
  const segColor = SEGMENT_COLORS[seg] ?? "#9aa1c9";
  const status = String(deal.status ?? "");
  const stageIdx = STAGES.findIndex((s) => s.key === status);
  const outcome = String(deal.settled_outcome ?? "");
  const terms = deal.terms ?? ({} as Deal["terms"]);
  const tx = deal.tx ?? {};

  const dayCell = (
    Icon: LucideIcon,
    label: string,
    v: unknown,
    done: boolean,
  ) => (
    <span className="flex items-center gap-1" title={label}>
      <Icon
        size={10}
        strokeWidth={1.75}
        className={done ? "text-low" : "text-faint"}
      />
      <span className={`tabular-nums ${done ? "text-mid" : "text-faint"}`}>
        {done ? `d${Math.round(num(v))}` : "—"}
      </span>
    </span>
  );

  return (
    <div className="deal-card panel-flat space-y-2 rounded-2xl p-3">
      <div className="flex items-center gap-2">
        <span className="chip flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-accent">
          <KindIcon size={12} strokeWidth={1.75} />
        </span>
        <span className="truncate font-display text-[12px] font-medium text-hi">
          {deal.origin} → {deal.dest}
        </span>
        <span className="ml-auto shrink-0 text-[9px] uppercase tracking-[0.12em] text-faint">
          {kindLabel}
        </span>
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className="font-display text-[15px] font-semibold tabular-nums text-hi">
          {fmtUsd(num(deal.price_usd))}
        </span>
        <span className="text-[9.5px] text-faint">/TEU</span>
        <span className="text-[10px] tabular-nums text-low">
          · {num(deal.teu)} TEU
        </span>
        <span
          className="ml-auto text-[10px] font-medium capitalize"
          style={{ color: segColor }}
        >
          {seg}
        </span>
      </div>

      {stageIdx === -1 ? (
        <div className="flex items-center gap-2">
          <Pill tone="warn" icon={Hourglass}>
            {humanizeToken(status) || "pending"}
          </Pill>
        </div>
      ) : (
        <div className="flex items-center px-0.5 pt-0.5">
          {STAGES.map((s, i) => {
            const reached = i <= stageIdx;
            const current = i === stageIdx;
            const col = i === 3 ? settleColor(outcome) : STAGE_COLOR[i];
            return (
              <Fragment key={s.key}>
                {i > 0 && (
                  <span
                    className="mx-1 h-px flex-1 rounded"
                    style={{
                      background: reached ? col : "rgba(148,158,220,0.14)",
                    }}
                  />
                )}
                <span
                  title={s.key}
                  className="inline-block h-2 w-2 shrink-0 rounded-full border"
                  style={
                    reached
                      ? {
                          background: col,
                          borderColor: col,
                          boxShadow: current ? `0 0 6px ${col}` : "none",
                        }
                      : { background: "#0b1130", borderColor: "#262e63" }
                  }
                />
              </Fragment>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between text-[9.5px]">
        {dayCell(CalendarCheck, "registered", deal.register_day, stageIdx >= 0)}
        {dayCell(Anchor, "departed", deal.actual_departure, stageIdx >= 1)}
        {dayCell(PackageCheck, "delivered", deal.actual_delivery, stageIdx >= 2)}
        {dayCell(BadgeCheck, "settled", stageIdx >= 3 ? deal.discharge_eta : null, stageIdx >= 3)}
      </div>

      <div className="flex items-center gap-3 border-t border-edge-soft pt-2 text-[10px] text-low">
        <span className="flex items-center gap-1" title="departure window">
          <CalendarRange size={10} strokeWidth={1.75} className="text-faint" />
          <span className="tabular-nums">
            d{Math.round(num(terms.window_lo))}–d{Math.round(num(terms.window_hi))}
          </span>
        </span>
        <span className="flex items-center gap-1" title="delivery deadline">
          <AlarmClockCheck size={10} strokeWidth={1.75} className="text-faint" />
          <span className="tabular-nums">
            d{Math.round(num(terms.delivery_deadline))}
          </span>
        </span>
        <span className="flex items-center gap-1" title="late penalty">
          <BadgePercent size={10} strokeWidth={1.75} className="text-faint" />
          <span className="tabular-nums">
            {(num(terms.penalty_bps) / 100).toFixed(1)}%
          </span>
        </span>
        {deal.vessel_id && (
          <span
            className="ml-auto flex items-center gap-1 text-faint"
            title={String(deal.vessel_id)}
          >
            <Ship size={10} strokeWidth={1.75} />
            <span className="max-w-[64px] truncate tabular-nums">
              {String(deal.vessel_id)}
            </span>
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <span title="contract">
          <Landmark size={10} strokeWidth={1.75} className="text-faint" />
        </span>
        <HashChip value={deal.contract} />
        {tx.register && <HashChip value={tx.register} />}
        {tx.departure && <HashChip value={tx.departure} />}
        {tx.delivery && <HashChip value={tx.delivery} />}
        {tx.settle && <HashChip value={tx.settle} />}
      </div>

      {status === "settled" && outcome && (
        <div>
          <Pill
            tone={
              outcome === "settled_full"
                ? "ok"
                : outcome === "settled_penalty"
                  ? "warn"
                  : "neutral"
            }
            icon={BadgeCheck}
          >
            {humanizeToken(outcome)} · {fmtUsd(num(deal.settled_amount_usd))}
          </Pill>
        </div>
      )}
    </div>
  );
}
