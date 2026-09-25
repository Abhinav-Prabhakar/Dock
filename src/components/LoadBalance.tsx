"use client";

import { Expand, Ship } from "lucide-react";
import { useOps } from "@/components/ops/OpsProvider";
import { PanelZoom } from "@/components/ops/PanelZoom";

function BalanceRing({ size = 220 }: { size?: number }) {
  // ring geometry: r=78, circumference ≈ 490
  const C = 2 * Math.PI * 78;
  const leftArc = C * 0.28; // port arc (yellow)
  const rightArc = C * 0.24; // starboard arc (dim)
  return (
    <div className="relative mx-auto mt-2" style={{ height: size * 0.76, width: size }}>
      <svg viewBox="0 0 220 170" className="h-full w-full" fill="none" aria-hidden>
        <circle cx="110" cy="88" r="78" stroke="rgba(152,162,226,0.14)" strokeWidth="2" />
        <circle
          cx="110" cy="88" r="78"
          stroke="rgba(152,162,226,0.4)" strokeWidth="2.5"
          strokeLinecap="round" strokeDasharray={`${rightArc} ${C}`}
          transform="rotate(-38 110 88)"
        />
        <circle
          cx="110" cy="88" r="78"
          stroke="#e8c95c" strokeWidth="2.5"
          strokeLinecap="round" strokeDasharray={`${leftArc} ${C}`}
          transform="rotate(142 110 88)"
        />
      </svg>

      <span className="absolute left-8 top-6 text-[11px] text-low">L</span>
      <span className="absolute right-8 top-6 text-[11px] text-low">R</span>

      <p className="absolute left-4 bottom-7 font-display text-[20px] font-medium text-hi">
        54<span className="text-[12px] text-mid">%</span>
      </p>
      <p className="absolute right-4 bottom-7 font-display text-[20px] font-medium text-hi">
        42<span className="text-[12px] text-mid">%</span>
      </p>

      <div className="absolute inset-x-0 top-12 flex flex-col items-center">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg chip">
          <Ship size={15} className="text-hi" />
        </span>
        <p className="mt-2 font-display text-[15px] font-semibold text-hi">13%</p>
        <p className="text-[9px] text-low">
          Load imbalance
          <br />
          <span className="block text-center">indicator</span>
        </p>
      </div>
    </div>
  );
}

export function LoadBalance() {
  const { zoom, setZoom } = useOps();
  return (
    <section className="panel w-[300px] shrink-0 rounded-2xl px-5 pt-4 pb-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="font-display text-[14px] font-medium text-hi">
            Load Balance
          </h2>
          <p className="mt-0.5 text-[10.5px] text-low">Single TEU average</p>
        </div>
        <button
          onClick={() => setZoom("balance")}
          aria-label="Expand load balance"
          title="Expand"
          className="rounded-md p-1 text-low transition-colors hover:text-hi"
        >
          <Expand size={13} strokeWidth={1.75} />
        </button>
      </div>
      <BalanceRing />

      {zoom === "balance" && (
        <PanelZoom title="Load Balance — per side">
          <BalanceRing size={340} />
          <div className="mt-4 grid grid-cols-3 gap-3">
            {[
              ["Port", "11,496 t · 54%"],
              ["Starboard", "8,943 t · 42%"],
              ["Δ heel", "13 pt · within limits"],
            ].map(([k, v]) => (
              <div key={k} className="panel-flat rounded-xl px-3 py-2.5">
                <p className="text-[9.5px] uppercase tracking-[0.14em] text-faint">{k}</p>
                <p className="mt-1 font-display text-[15px] text-hi">{v}</p>
              </div>
            ))}
          </div>
        </PanelZoom>
      )}
    </section>
  );
}
