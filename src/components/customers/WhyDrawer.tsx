"use client";

import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  CalendarClock,
  Container,
  FileQuestion,
  Gauge,
  Layers,
  Loader2,
  MoveRight,
  Ship,
  Tag,
  Weight,
  X,
} from "lucide-react";
import {
  api,
  type EpisodeEvent,
  type OfferData,
  type OfferExplain,
} from "@/lib/api";
import {
  CARGO_ICON,
  SEGMENT_COLORS,
  fmtUsd,
  humanizeToken,
  outcomeTone,
  stampFor,
} from "@/lib/offers";
import { Empty, HashChip, MeterBar, Pill } from "@/components/dock/ui";

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown) => (v == null ? "" : String(v));

/* The compare export is static per build — fetch once, share across opens. */
let offersPromise: Promise<OfferData[]> | null = null;
function compareOffers(): Promise<OfferData[]> {
  if (!offersPromise) {
    offersPromise = api.getCompare<OfferData[]>("offers");
    offersPromise.catch(() => {
      offersPromise = null; // allow a retry on the next open
    });
  }
  return offersPromise;
}

export function WhyDrawer({
  offer,
  onClose,
}: {
  offer: EpisodeEvent | null;
  onClose: () => void;
}) {
  const [exportOffers, setExportOffers] = useState<OfferData[] | null>(null);
  const [exportFailed, setExportFailed] = useState(false);

  useEffect(() => {
    if (!offer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [offer, onClose]);

  useEffect(() => {
    if (!offer || exportOffers || exportFailed) return;
    let cancelled = false;
    compareOffers()
      .then((d) => {
        if (!cancelled) setExportOffers(d);
      })
      .catch(() => {
        if (!cancelled) setExportFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [offer, exportOffers, exportFailed]);

  const exportLoading = !!offer && !exportOffers && !exportFailed;

  if (!offer) return null;

  const origin = str(offer.origin);
  const dest = str(offer.dest);
  const price = num(offer.price ?? offer.quoted);
  const market = num(offer.market_rate);
  const delta = market > 0 ? ((price - market) / market) * 100 : 0;
  const teu = num(offer.teu);
  const weight = num(offer.weight_t);
  const seg = str(offer.segment) || "standard";
  const segColor = SEGMENT_COLORS[seg] ?? "#a3abd6";
  const cargo = str(offer.cargo_type) || "dry";
  const reqDep = num(offer.req_dep_day);
  const flex = num(offer.flex_days);
  const nOptions = num(offer.n_options);
  const vessel = str(offer.vessel_id);
  const reason = offer.reason ? humanizeToken(str(offer.reason)) : null;
  const tone = outcomeTone(str(offer.outcome));
  const pillTone =
    tone === "won"
      ? "ok"
      : tone === "counter"
        ? "accent"
        : tone === "passed"
          ? "warn"
          : "bad";

  // match the export by request_id; else nearest honest analog
  const reqId = num(offer.request_id);
  let matched: OfferData | undefined;
  if (exportOffers) {
    matched =
      exportOffers.find((o) => o.request_id === reqId && o.explain) ??
      exportOffers.find(
        (o) => o.explain && o.origin === origin && o.dest === dest,
      ) ??
      exportOffers.find((o) => o.explain);
  }
  const explain = matched?.explain ?? null;

  return (
    <div className="absolute inset-0 z-40">
      <style>{`
        @keyframes whyIn {
          from { opacity: 0; transform: translateX(48px); }
          to { opacity: 1; transform: none; }
        }
        @keyframes whyFade { from { opacity: 0; } to { opacity: 1; } }
        .why-panel { animation: whyIn 0.28s cubic-bezier(0.32, 0.72, 0, 1) both; }
        .why-back { animation: whyFade 0.2s ease both; }
      `}</style>

      <div
        className="why-back absolute inset-0 bg-abyss/55 backdrop-blur-[2px]"
        onClick={onClose}
      />

      <aside className="why-panel panel absolute inset-y-0 right-0 flex w-[360px] flex-col border-l border-edge">
        {/* header */}
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="chip flex items-center gap-1.5 rounded-full px-2.5 py-1 font-display text-[11.5px] text-hi">
              {origin}
              <MoveRight size={11} className="text-low" strokeWidth={1.75} />
              {dest}
            </span>
            <Pill tone={pillTone}>{stampFor(offer).text}</Pill>
          </div>
          <button
            onClick={onClose}
            className="chip flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-mid transition-colors hover:text-hi"
          >
            <X size={13} strokeWidth={1.75} />
          </button>
        </div>

        {/* body */}
        <div className="scroll-thin flex-1 space-y-3 overflow-y-auto p-4">
          {/* hero price */}
          <div className="flex items-baseline gap-2 px-1">
            <span className="font-display text-[26px] font-semibold tracking-tight tabular-nums text-hi">
              {fmtUsd(price)}
            </span>
            <span className="text-[10px] uppercase tracking-[0.12em] text-faint">
              / teu
            </span>
            <span
              className={`ml-auto font-display text-[11px] font-medium tabular-nums ${
                delta <= 0 ? "text-loaded-soft" : "text-reserved-soft"
              }`}
            >
              {delta >= 0 ? "+" : "−"}
              {Math.abs(delta).toFixed(1)}% vs mkt
            </span>
          </div>

          {/* field grid */}
          <div className="grid grid-cols-2 gap-2">
            <Field icon={Gauge} label="market">
              <span className="font-display text-[13px] tabular-nums text-hi">
                {fmtUsd(market)}
              </span>
            </Field>
            <Field icon={Container} label="teu">
              <span className="font-display text-[13px] tabular-nums text-hi">
                {teu}
              </span>
            </Field>
            <Field icon={Weight} label="weight">
              <span className="font-display text-[13px] tabular-nums text-hi">
                {weight.toLocaleString("en-US")}t
              </span>
            </Field>
            <Field icon={Tag} label="segment">
              <span
                className="text-[12px] font-medium capitalize"
                style={{ color: segColor }}
              >
                {seg}
              </span>
            </Field>
            <Field icon={Container} label="cargo">
              <span className="text-[12px] capitalize text-mid">
                {CARGO_ICON[cargo] ?? "▣"} {cargo}
              </span>
            </Field>
            <Field icon={CalendarClock} label="dep day">
              <span className="font-display text-[13px] tabular-nums text-hi">
                d{Math.round(reqDep)}
                {flex > 0 && (
                  <span className="text-low"> ±{Math.round(flex)}d</span>
                )}
              </span>
            </Field>
            <Field icon={Layers} label="options">
              <span className="font-display text-[13px] tabular-nums text-hi">
                {nOptions}
              </span>
            </Field>
            <Field icon={Ship} label="vessel">
              <span className="text-[12px] tabular-nums text-mid">
                {vessel || "—"}
              </span>
            </Field>
          </div>

          {reason && (
            <div>
              <span className="chip inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] text-low">
                <Gauge size={10} strokeWidth={1.75} className="text-accent" />
                {reason}
              </span>
            </div>
          )}

          {/* deep explain */}
          <div className="panel-flat rounded-2xl p-3.5">
            <p className="mb-2.5 text-[10px] uppercase tracking-[0.14em] text-faint">
              why this price
            </p>
            {exportLoading ? (
              <div className="flex items-center justify-center py-6 text-low">
                <Loader2 size={15} className="animate-spin" />
              </div>
            ) : exportFailed ? (
              <Empty icon={FileQuestion}>explain export unavailable</Empty>
            ) : explain ? (
              <>
                <ExplainView ex={explain} />
                <p className="mt-2.5 border-t border-edge-soft pt-2 text-[9px] text-faint">
                  explain sample — holdout export
                </p>
              </>
            ) : (
              <Empty icon={FileQuestion}>
                no explain sample in the export yet
              </Empty>
            )}
          </div>
        </div>

        {/* footer */}
        <div className="flex items-center justify-between border-t border-edge-soft px-4 py-3">
          <span className="text-[9px] uppercase tracking-[0.14em] text-faint">
            sealed in ledger · seq {num(offer.seq)} · d{num(offer.day)}
          </span>
          <HashChip value={offer.hash} />
        </div>
      </aside>
    </div>
  );
}

function Field({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="panel-flat rounded-xl px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-faint">
        <Icon size={10} strokeWidth={1.75} />
        <span className="text-[9px] uppercase tracking-[0.12em]">{label}</span>
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function ExplainView({ ex }: { ex: OfferExplain }) {
  const maxV = Math.max(
    num(ex.quote_per_teu),
    num(ex.bid_price_per_teu),
    num(ex.market_rate_per_teu),
    ...(ex.legs ?? []).flatMap((l) => [num(l.bid_price), num(l.market_rate)]),
    1,
  );
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / maxV) * 100))}%`;

  const bars = [
    { label: "quote", v: num(ex.quote_per_teu), tone: "accent" as const },
    { label: "bid", v: num(ex.bid_price_per_teu), tone: "loaded" as const },
    { label: "market", v: num(ex.market_rate_per_teu), tone: "warn" as const },
  ];

  return (
    <div className="space-y-3">
      {ex.reason && (
        <div>
          <Pill tone="accent" icon={Gauge}>
            {humanizeToken(str(ex.reason))}
          </Pill>
        </div>
      )}
      <div className="space-y-1.5">
        {bars.map((b) => (
          <div key={b.label} className="flex items-center gap-2">
            <span className="w-11 shrink-0 text-[9px] uppercase tracking-[0.12em] text-faint">
              {b.label}
            </span>
            <div className="min-w-0 flex-1">
              <MeterBar pct={b.v / maxV} tone={b.tone} />
            </div>
            <span className="w-12 shrink-0 text-right font-display text-[10px] tabular-nums text-mid">
              {fmtUsd(b.v)}
            </span>
          </div>
        ))}
      </div>

      {(ex.legs ?? []).length > 0 && (
        <div className="space-y-2 border-t border-edge-soft pt-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[9px] uppercase tracking-[0.12em] text-faint">
              legs
            </span>
            <span className="flex items-center gap-2.5 text-[8.5px] text-faint">
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-loaded-soft" />
                bid
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-reserved-soft" />
                market
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1 w-2 rounded-sm bg-reserved/40" />
                pressure
              </span>
            </span>
          </div>
          {ex.legs.map((leg) => (
            <div key={leg.leg_idx}>
              <div className="flex items-baseline justify-between text-[9px] text-faint">
                <span>
                  leg {leg.leg_idx} · d{Math.round(num(leg.dep_day))}
                </span>
                <span className="tabular-nums">
                  {num(leg.remaining_teu)}/{num(leg.expected_teu)} teu
                </span>
              </div>
              <div className="relative mt-0.5 h-2 rounded-full bg-ink">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-reserved/35"
                  style={{
                    width: `${Math.min(100, Math.max(0, num(leg.pressure) * 100))}%`,
                  }}
                  title={`pressure ${(num(leg.pressure) * 100).toFixed(0)}%`}
                />
                <span
                  className="absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-loaded-soft"
                  style={{ left: pct(num(leg.bid_price)) }}
                  title={`bid ${fmtUsd(num(leg.bid_price))}`}
                />
                <span
                  className="absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-reserved-soft"
                  style={{ left: pct(num(leg.market_rate)) }}
                  title={`market ${fmtUsd(num(leg.market_rate))}`}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {ex.text && (
        <p className="text-[10px] italic leading-relaxed text-low">{ex.text}</p>
      )}
    </div>
  );
}
