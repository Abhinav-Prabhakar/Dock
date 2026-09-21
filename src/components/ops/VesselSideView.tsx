import { bayRows, type CellStatus } from "@/lib/data";

/* Side elevation of the stowage plan — the "Side View" toggle target.
   Same viewBox + palette as VesselPlan so the swap reads as one graphic.
   Each plan column becomes a deck stack: height grows with occupied cells,
   tier colors follow the cell statuses underneath. */

const statusFill: Record<Exclude<CellStatus, "empty">, string> = {
  reserved: "#d9b13b",
  loaded: "#3f9eae",
  pending: "#d6546a",
};

const TIER_H = 26;
const TIER_GAP = 3;
const COL_W = 64;
const COL_STEP = 102;
const GRID_X = 252;
const DECK_Y = 240;

export function VesselSideView() {
  // per-column stack: [occupied count, dominant status per tier]
  const columns = Array.from({ length: 9 }, (_, c) => {
    const cells = [bayRows[0]?.[c], bayRows[1]?.[c]].filter(Boolean);
    const occupied = cells.filter((x) => x!.status !== "empty");
    const tiers = Math.min(5, 1 + occupied.length * 2); // 1,3,5 tiers
    const top = occupied[0]?.status ?? "empty";
    return { tiers, statuses: cells.map((x) => x!.status), top };
  });

  return (
    <svg viewBox="0 0 1240 420" className="w-full" fill="none" aria-hidden>
      <defs>
        <linearGradient id="side-sea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#161d47" stopOpacity="0.7" />
          <stop offset="1" stopColor="#060a20" stopOpacity="0.9" />
        </linearGradient>
        <filter id="side-glow" x="-20%" y="-40%" width="140%" height="180%">
          <feGaussianBlur stdDeviation="30" />
        </filter>
      </defs>

      {/* ambient glow */}
      <ellipse
        cx={620}
        cy={250}
        rx={540}
        ry={130}
        fill="rgba(88,102,220,0.12)"
        filter="url(#side-glow)"
      />

      {/* hull silhouette — raked bow left, stern right */}
      <path
        d="M40 240 L60 300 Q 70 340 130 348 L1120 348 Q 1170 340 1185 300 L1195 240 Z"
        fill="rgba(120,135,220,0.05)"
        stroke="rgba(178,188,240,0.5)"
        strokeWidth={1.75}
      />
      {/* boot-top line + keel marks */}
      <line x1="60" y1="300" x2="1185" y2="300" stroke="rgba(178,188,240,0.28)" />
      <path d="M40 240 L60 300" stroke="rgba(178,188,240,0.35)" strokeWidth={1.25} />
      <circle cx="52" cy="252" r="4" stroke="rgba(178,188,240,0.4)" />

      {/* stern castle — accommodation block + funnel */}
      <g stroke="rgba(178,188,240,0.45)" fill="rgba(18,24,60,0.8)">
        <rect x="1048" y="120" width="120" height="120" rx="4" />
        <rect x="1060" y="92" width="96" height="30" rx="3" />
        <rect x="1088" y="56" width="52" height="38" rx="3" />
      </g>
      {/* castle window rows */}
      {[0, 1, 2, 3].map((r) => (
        <line
          key={r}
          x1="1056"
          y1={140 + r * 24}
          x2="1160"
          y2={140 + r * 24}
          stroke="rgba(148,200,255,0.4)"
          strokeWidth={4}
          strokeDasharray="8 6"
        />
      ))}
      {/* funnel band */}
      <rect x="1088" y="56" width="52" height="10" rx="2" fill="rgba(106,115,234,0.5)" />

      {/* deck line */}
      <line x1="60" y1="240" x2="1185" y2="240" stroke="rgba(178,188,240,0.4)" strokeWidth={1.5} />

      {/* container stacks per bay column */}
      {columns.map((col, c) => (
        <g key={c}>
          {Array.from({ length: col.tiers }, (_, t) => {
            const status: CellStatus | undefined =
              t < col.statuses.length ? col.statuses[t] : col.top;
            const lit = status && status !== "empty" && t >= col.tiers - col.statuses.length;
            const y = DECK_Y - (t + 1) * (TIER_H + TIER_GAP);
            const fill = lit
              ? statusFill[status as Exclude<CellStatus, "empty">]
              : "rgba(148,158,220,0.16)";
            return (
              <g key={t}>
                <rect
                  x={GRID_X + c * COL_STEP + 14}
                  y={y}
                  width={COL_W}
                  height={TIER_H}
                  rx={3}
                  fill={fill}
                  fillOpacity={lit ? 0.4 : 1}
                  stroke={
                    lit
                      ? statusFill[status as Exclude<CellStatus, "empty">]
                      : "rgba(148,158,220,0.25)"
                  }
                  strokeOpacity={lit ? 0.7 : 1}
                />
                {/* corrugation ribs */}
                {[0.28, 0.5, 0.72].map((f) => (
                  <line
                    key={f}
                    x1={GRID_X + c * COL_STEP + 14 + COL_W * f}
                    y1={y + 4}
                    x2={GRID_X + c * COL_STEP + 14 + COL_W * f}
                    y2={y + TIER_H - 4}
                    stroke={
                      lit
                        ? "rgba(238,240,255,0.35)"
                        : "rgba(178,188,240,0.18)"
                    }
                    strokeWidth={0.75}
                  />
                ))}
              </g>
            );
          })}
          {/* column guide line down the hull */}
          <line
            x1={GRID_X + c * COL_STEP + 14 + COL_W / 2}
            y1={DECK_Y}
            x2={GRID_X + c * COL_STEP + 14 + COL_W / 2}
            y2={340}
            stroke="rgba(178,188,240,0.14)"
            strokeDasharray="2 4"
          />
        </g>
      ))}

      {/* waterline + wave ticks */}
      <line x1="0" y1="370" x2="1240" y2="370" stroke="rgba(148,158,220,0.3)" />
      {Array.from({ length: 40 }, (_, i) => (
        <line
          key={i}
          x1={20 + i * 31}
          y1={376}
          x2={28 + i * 31}
          y2={376}
          stroke="rgba(148,158,220,0.22)"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      ))}
      <line x1="0" y1="370" x2="1240" y2="370" stroke="url(#side-sea)" strokeWidth={2} />

      {/* bow/stern labels */}
      <text x="60" y="398" fontSize={9} letterSpacing={2} fill="#6c739b">BOW</text>
      <text x="1160" y="398" fontSize={9} letterSpacing={2} fill="#6c739b" textAnchor="end">STERN</text>
    </svg>
  );
}
