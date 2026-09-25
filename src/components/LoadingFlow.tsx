"use client";

import { Check, Expand } from "lucide-react";
import { flowDots } from "@/lib/data";
import { useOps } from "@/components/ops/OpsProvider";
import { PanelZoom } from "@/components/ops/PanelZoom";

const dotFill = { hi: "#eef0ff", mid: "#8a92e8", low: "#4a52a8" } as const;
const labels = ["30m", "25m", "20m", "15m", "10m", "5m"];

function FlowStats({ big }: { big?: boolean }) {
  return (
    <div className="mt-3 flex items-center gap-3">
      <span className="flex h-4 w-4 items-center justify-center rounded-full border-2 border-hi">
        <span className="h-1.5 w-1.5 rounded-full bg-hi" />
      </span>
      <p className={`font-display leading-none font-medium text-hi ${big ? "text-[34px]" : "text-[24px]"}`}>
        161.35 <span className="text-[13px] font-normal text-mid">t/h</span>
      </p>
      <span className="chip mx-auto rounded-md px-2 py-1 text-[10px] text-mid">
        24ms
      </span>
      <p className={`font-display leading-none font-medium text-hi ${big ? "text-[34px]" : "text-[24px]"}`}>
        96.15 <span className="text-[13px] font-normal text-mid">t/h</span>
      </p>
      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent">
        <Check size={10} strokeWidth={3} className="text-white" />
      </span>
    </div>
  );
}

function Scatter({ h = 64 }: { h?: number }) {
  return (
    <>
      <div className="mt-3 h-[2px] w-full rounded-full bg-gradient-to-r from-white/70 via-indigo-400/60 to-transparent" />
      <svg viewBox="0 0 720 56" style={{ height: h }} className="mt-1 w-full" aria-hidden>
        {flowDots.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={d.tone === "hi" ? 2.2 : 1.6} fill={dotFill[d.tone]} opacity={d.tone === "low" ? 0.7 : 0.95} />
        ))}
        <line x1="0" y1="42" x2="720" y2="42" stroke="rgba(178,188,240,0.25)" />
        {Array.from({ length: 60 }, (_, i) => (
          <line
            key={`t${i}`}
            x1={8 + i * 12}
            y1={42}
            x2={8 + i * 12}
            y2={i % 10 === 0 ? 34 : 38}
            stroke="rgba(178,188,240,0.3)"
            strokeWidth={0.75}
          />
        ))}
      </svg>
      <div className="flex justify-between px-1 text-[10px] text-low">
        {labels.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
    </>
  );
}

export function LoadingFlow() {
  const { zoom, setZoom } = useOps();
  return (
    <section className="panel relative flex-1 rounded-2xl px-5 pt-4 pb-3">
      <div className="flex items-start justify-between">
        <h2 className="font-display text-[14px] font-medium text-hi">
          Loading Flow
        </h2>
        <button
          onClick={() => setZoom("flow")}
          aria-label="Expand loading flow"
          title="Expand"
          className="rounded-md p-1 text-low transition-colors hover:text-hi"
        >
          <Expand size={13} strokeWidth={1.75} />
        </button>
      </div>
      <FlowStats />
      <Scatter />

      {zoom === "flow" && (
        <PanelZoom title="Loading Flow — 30 min">
          <FlowStats big />
          <Scatter h={180} />
          <div className="mt-4 grid grid-cols-4 gap-3">
            {[
              ["Peak", "212.4 t/h"],
              ["Avg", "138.0 t/h"],
              ["Moves", "412"],
              ["Queue", "7 boxes"],
            ].map(([k, v]) => (
              <div key={k} className="panel-flat rounded-xl px-3 py-2.5">
                <p className="text-[9.5px] uppercase tracking-[0.14em] text-faint">{k}</p>
                <p className="mt-1 font-display text-[16px] text-hi">{v}</p>
              </div>
            ))}
          </div>
        </PanelZoom>
      )}
    </section>
  );
}
