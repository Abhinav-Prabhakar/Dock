"use client";

import React, { useEffect, useState } from "react";
import {
  Gauge,
  Loader2,
  Scale,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { api } from "@/lib/api";
import { useEpisode } from "@/components/dock/EpisodeProvider";
import { fmtPct, SEGMENT_COLORS } from "@/lib/offers";
import { Empty, MeterBar, Pill, SectionTitle } from "@/components/dock/ui";

/* Credibility — why trust the policy: how close the fitted demand /
   elasticity / WTP models sit to ground truth (models/report), plus a
   click-to-verify hash-chain check on the live episode ledger. */

interface SegPair {
  est: number;
  truth: number;
  err: number | null;
}

interface ModelReport {
  mape: number | null;
  maeTeu: number | null;
  n: number | null;
  seed: number | null;
  trainCount: number;
  holdout: string[];
  perScenario: [string, number][];
  elasticity: [string, SegPair][];
  wtp: [string, SegPair][];
}

interface LedgerVerdict {
  ok: boolean;
  n_events: number;
  detail: string;
}

const SEG_ORDER = ["flexible", "standard", "urgent"];

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

function segEntries(v: unknown): [string, Record<string, unknown>][] {
  const o = rec(v);
  const keys = Object.keys(o);
  keys.sort((a, b) => {
    const ia = SEG_ORDER.indexOf(a);
    const ib = SEG_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return keys.map((k) => [k, rec(o[k])]);
}

function pair(v: Record<string, unknown>, estKey: string, trueKey: string): SegPair | null {
  const est = num(v[estKey]);
  const truth = num(v[trueKey]);
  if (est === null || truth === null) return null;
  return { est, truth, err: num(v.abs_err) };
}

function parseReport(raw: unknown): ModelReport | null {
  const r = rec(raw);
  const models = rec(r.models);
  if (!Object.keys(models).length) return null;

  const demand = rec(models.demand);
  const elasticity = rec(rec(models.elasticity).per_segment);
  const wtp = rec(rec(models.wtp).per_segment);
  const split = rec(r.split);

  const perScenario = Object.entries(rec(demand.per_scenario))
    .map(([k, v]) => [k, num(v)] as [string, number | null])
    .filter((x): x is [string, number] => x[1] !== null);

  const toPairs = (
    o: Record<string, unknown>,
    estKey: string,
    trueKey: string,
  ): [string, SegPair][] =>
    segEntries(o)
      .map(([seg, v]) => [seg, pair(v, estKey, trueKey)] as [string, SegPair | null])
      .filter((x): x is [string, SegPair] => x[1] !== null);

  return {
    mape: num(demand.mape),
    maeTeu: num(demand.mae_teu),
    n: num(demand.n),
    seed: num(r.seed),
    trainCount: Array.isArray(split.train) ? split.train.length : 0,
    holdout: Array.isArray(split.holdout)
      ? split.holdout.filter((s): s is string => typeof s === "string")
      : [],
    perScenario,
    elasticity: toPairs(elasticity, "estimated", "true"),
    wtp: toPairs(wtp, "implied_mult", "true_mult"),
  };
}

function PairRows({ rows, decimals }: { rows: [string, SegPair][]; decimals: number }) {
  const maxV = Math.max(1e-9, ...rows.flatMap(([, p]) => [p.est, p.truth]));
  return (
    <div className="space-y-2">
      {rows.map(([seg, p]) => (
        <div key={seg} className="flex items-center gap-2.5">
          <span className="chip flex w-[76px] shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: SEGMENT_COLORS[seg] ?? "#aab4da" }}
            />
            <span className="truncate text-[9.5px] font-medium text-mid">{seg}</span>
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <MeterBar pct={p.est / maxV} tone="accent" />
            <MeterBar pct={p.truth / maxV} tone="loaded" />
          </div>
          <div
            className="w-[58px] shrink-0 space-y-1 text-right font-display tabular-nums"
            title={p.err !== null ? `abs err ${p.err.toFixed(4)}` : undefined}
          >
            <p className="text-[10px] leading-none text-hi">{p.est.toFixed(decimals)}</p>
            <p className="text-[9px] leading-none text-faint">{p.truth.toFixed(decimals)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function CredibilityPanel() {
  const { episode } = useEpisode();
  const epId = episode?.id ?? null;

  const [report, setReport] = useState<ModelReport | null>(null);
  const [failed, setFailed] = useState(false);

  // verdict + busy flag are keyed by episode id — a new episode id simply
  // hides the stale verdict, no reset effect needed
  const [busyId, setBusyId] = useState<string | null>(null);
  const [ledger, setLedger] = useState<(LedgerVerdict & { id: string }) | null>(null);

  useEffect(() => {
    let mounted = true;
    api
      .getModelsReport()
      .then((d) => {
        if (!mounted) return;
        const r = parseReport(d);
        if (r) setReport(r);
        else setFailed(true);
      })
      .catch(() => mounted && setFailed(true));
    return () => {
      mounted = false;
    };
  }, []);

  const verify = async () => {
    if (!epId || busyId === epId) return;
    setBusyId(epId);
    try {
      const res = await api.verifyLedger(epId);
      setLedger({
        id: epId,
        ok: Boolean(res.ok),
        n_events: Number(res.n_events ?? 0),
        detail: String(res.detail ?? ""),
      });
    } catch (e) {
      setLedger({
        id: epId,
        ok: false,
        n_events: 0,
        detail: e instanceof Error ? e.message : "verify failed",
      });
    } finally {
      setBusyId((cur) => (cur === epId ? null : cur));
    }
  };

  const verifying = busyId !== null && busyId === epId;
  const verdict = ledger && ledger.id === epId ? ledger : null;

  const legend = (
    <span className="flex items-center gap-3 pr-1">
      <span className="flex items-center gap-1.5">
        <span className="h-[3px] w-3.5 rounded-full bg-accent" />
        <span className="text-[9px] text-low">est</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-[3px] w-3.5 rounded-full bg-loaded" />
        <span className="text-[9px] text-low">true</span>
      </span>
    </span>
  );

  return (
    <div className="flex flex-col gap-3">
      <SectionTitle icon={Scale} right={report ? legend : undefined}>
        credibility
      </SectionTitle>

      <div>
        {failed || !report ? (
          <Empty icon={Gauge}>
            {failed ? "model report unavailable" : "loading model report…"}
          </Empty>
        ) : (
          <>
            {/* demand forecaster headline */}
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/25 bg-accent/10">
                <Gauge size={15} className="text-accent" strokeWidth={1.75} />
              </span>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-display text-[22px] font-semibold leading-none tracking-tight text-hi tabular-nums">
                    {report.mape !== null ? fmtPct(report.mape) : "—"}
                  </span>
                  <span className="text-[9.5px] uppercase tracking-[0.12em] text-faint">
                    demand mape
                  </span>
                </div>
                <p className="mt-1 truncate text-[10px] text-low tabular-nums">
                  {report.n !== null && `n ${Math.round(report.n).toLocaleString("en-US")}`}
                  {report.maeTeu !== null &&
                    ` · mae ${Math.round(report.maeTeu).toLocaleString("en-US")} teu`}
                  {report.perScenario.length > 0 &&
                    ` · ${report.perScenario
                      .map(([s, v]) => `${s} ${fmtPct(v)}`)
                      .join(" · ")}`}
                </p>
              </div>
            </div>

            {/* elasticity — est vs true */}
            {report.elasticity.length > 0 && (
              <div className="mt-4">
                <p className="mb-2 text-[10px] uppercase tracking-[0.14em] text-faint">
                  price elasticity · |ε|
                </p>
                <PairRows rows={report.elasticity} decimals={2} />
              </div>
            )}

            {/* willingness-to-pay multiplier — est vs true */}
            {report.wtp.length > 0 && (
              <div className="mt-4">
                <p className="mb-2 text-[10px] uppercase tracking-[0.14em] text-faint">
                  wtp multiplier · × market
                </p>
                <PairRows rows={report.wtp} decimals={2} />
              </div>
            )}

            {/* split provenance */}
            <p className="mt-4 text-[10px] leading-relaxed text-faint">
              fit on {report.trainCount} scenarios
              {report.holdout.length > 0 && ` · held out: ${report.holdout.join(", ")}`}
              {report.seed !== null && ` · seed ${report.seed}`}
            </p>
          </>
        )}

        {/* ledger verify */}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-edge-soft pt-3">
          {!epId ? (
            <span className="flex items-center gap-1.5 text-[10px] text-faint">
              <ShieldCheck size={11} strokeWidth={1.75} />
              no episode to verify
            </span>
          ) : (
            <>
              <button
                onClick={verify}
                disabled={verifying}
                className="chip flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium text-low transition-colors hover:border-loaded/40 hover:text-hi disabled:cursor-not-allowed disabled:opacity-50"
                title="Verify the episode event ledger hash chain"
              >
                {verifying ? (
                  <Loader2 size={11} className="animate-spin text-loaded" strokeWidth={1.75} />
                ) : (
                  <ShieldCheck size={11} className="text-loaded" strokeWidth={1.75} />
                )}
                verify ledger
              </button>
              {verdict &&
                (verdict.ok ? (
                  <Pill tone="ok" icon={ShieldCheck}>
                    {verdict.n_events} events · hash chain intact
                  </Pill>
                ) : (
                  <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-pending-soft">
                    <ShieldAlert size={11} className="shrink-0 text-critical" strokeWidth={1.75} />
                    <span className="truncate">
                      {verdict.detail || "hash chain broken"}
                    </span>
                  </span>
                ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
