import { bayRows, type BayCell, type CellStatus } from "@/lib/data";

const CELL_W = 94;
const CELL_H = 112;
const COL_STEP = 102;
const GRID_X = 252;
const ROW_Y = [80, 214];

const statusStyles: Record<
  Exclude<CellStatus, "empty">,
  { fill: string; stroke: string; label: string; name: string }
> = {
  reserved: {
    fill: "url(#grad-reserved)",
    stroke: "rgba(217,177,59,0.55)",
    label: "#ecd07a",
    name: "Reserved",
  },
  loaded: {
    fill: "url(#grad-loaded)",
    stroke: "rgba(90,190,200,0.45)",
    label: "#7fd9d0",
    name: "Loaded",
  },
  pending: {
    fill: "url(#grad-pending)",
    stroke: "rgba(224,86,107,0.5)",
    label: "#f0899a",
    name: "Pending",
  },
};

function Cell({ cell, x, y }: { cell: BayCell; x: number; y: number }) {
  if (cell.status === "empty") {
    return (
      <g>
        <rect
          x={x}
          y={y}
          width={CELL_W}
          height={CELL_H}
          rx={8}
          fill="rgba(16,22,56,0.55)"
          stroke="rgba(148,158,220,0.22)"
        />
        <circle
          cx={x + CELL_W / 2}
          cy={y + CELL_H / 2}
          r={8}
          fill="none"
          stroke="rgba(180,190,240,0.55)"
          strokeWidth={1.5}
        />
        <circle cx={x + CELL_W / 2} cy={y + CELL_H / 2} r={2} fill="rgba(180,190,240,0.7)" />
      </g>
    );
  }
  const s = statusStyles[cell.status];
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={CELL_W}
        height={CELL_H}
        rx={8}
        fill={s.fill}
        stroke={s.stroke}
      />
      <rect
        x={x + 1}
        y={y + 1}
        width={CELL_W - 2}
        height={CELL_H / 2}
        rx={9}
        fill="rgba(255,255,255,0.04)"
      />
      <text
        x={x + CELL_W / 2}
        y={y + 17}
        textAnchor="middle"
        fontSize={7.5}
        letterSpacing={0.4}
        fill={s.label}
      >
        {s.name}
      </text>
      <text
        x={x + CELL_W / 2}
        y={y + 40}
        textAnchor="middle"
        fontSize={12.5}
        fontWeight={600}
        fill="#eef0ff"
      >
        {cell.id}
      </text>
      <text
        x={x + CELL_W / 2}
        y={y + 58}
        textAnchor="middle"
        fontSize={8.5}
        fill="rgba(200,206,240,0.75)"
      >
        {cell.serial}
      </text>
      <g transform={`translate(${x + CELL_W - 18} ${y + CELL_H - 18})`}>
        <rect width={9} height={7} rx={1.5} fill="none" stroke="rgba(200,206,240,0.6)" strokeWidth={1} />
        <line x1={3} y1={0} x2={3} y2={7} stroke="rgba(200,206,240,0.6)" strokeWidth={0.75} />
        <line x1={6} y1={0} x2={6} y2={7} stroke="rgba(200,206,240,0.6)" strokeWidth={0.75} />
      </g>
      <circle cx={x + 14} cy={y + CELL_H - 14} r={2.5} fill={s.label} opacity={0.9} />
    </g>
  );
}

export function VesselPlan() {
  const boundaries = Array.from({ length: 10 }, (_, i) => GRID_X - 5 + i * COL_STEP);
  const dots = [
    [72, 180], [88, 158], [104, 192], [96, 236], [118, 160], [128, 262],
    [140, 184], [152, 228], [162, 152], [176, 206], [188, 262], [86, 270],
    [110, 292], [200, 172], [64, 226], [150, 292], [170, 248], [196, 300],
  ];
  return (
    <svg viewBox="0 0 1240 420" className="w-full" fill="none" aria-hidden>
      <defs>
        <linearGradient id="grad-reserved" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d9b13b" stopOpacity="0.34" />
          <stop offset="1" stopColor="#9c7f28" stopOpacity="0.16" />
        </linearGradient>
        <linearGradient id="grad-loaded" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3f9eae" stopOpacity="0.34" />
          <stop offset="1" stopColor="#2a6478" stopOpacity="0.18" />
        </linearGradient>
        <linearGradient id="grad-pending" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d6546a" stopOpacity="0.38" />
          <stop offset="1" stopColor="#8f3a4e" stopOpacity="0.2" />
        </linearGradient>
        <filter id="hull-glow" x="-20%" y="-40%" width="140%" height="180%">
          <feGaussianBlur stdDeviation="34" />
        </filter>
      </defs>

      {/* ambient glow beneath the hull */}
      <ellipse
        cx={620}
        cy={215}
        rx={540}
        ry={150}
        fill="rgba(88,102,220,0.13)"
        filter="url(#hull-glow)"
      />

      {/* hull */}
      <path
        d="M26 210 C 34 138, 110 84, 228 66 L1185 60 L1185 360 L228 354 C 110 336, 34 282, 26 210 Z"
        stroke="rgba(178,188,240,0.55)"
        strokeWidth={1.75}
        fill="rgba(120,135,220,0.05)"
      />
      {/* inner deck line */}
      <path
        d="M46 210 C 54 148, 122 100, 234 84 L1170 80 L1170 340 L234 336 C 122 320, 54 272, 46 210 Z"
        stroke="rgba(178,188,240,0.28)"
        strokeWidth={1}
      />

      {/* bow deck plating */}
      <path
        d="M46 210 C 56 156, 108 114, 190 96"
        stroke="rgba(178,188,240,0.22)"
        strokeDasharray="3 4"
      />
      <line x1={50} y1={210} x2={230} y2={210} stroke="rgba(178,188,240,0.18)" />
      <line x1={70} y1={160} x2={215} y2={128} stroke="rgba(178,188,240,0.12)" />
      <line x1={70} y1={260} x2={215} y2={292} stroke="rgba(178,188,240,0.12)" />

      {/* bow fittings — windlass, bollards, deck marks */}
      <rect x={96} y={196} width={26} height={28} rx={4} stroke="rgba(178,188,240,0.4)" />
      <line x1={96} y1={210} x2={122} y2={210} stroke="rgba(178,188,240,0.3)" />
      {dots.map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r={i % 3 === 0 ? 2.4 : 1.4} fill="rgba(190,198,244,0.5)" />
      ))}
      <rect x={140} y={126} width={14} height={5} rx={2} stroke="rgba(178,188,240,0.35)" />
      <rect x={140} y={288} width={14} height={5} rx={2} stroke="rgba(178,188,240,0.35)" />
      <circle cx={70} cy={210} r={5} stroke="rgba(178,188,240,0.4)" />

      {/* bay rails */}
      <line x1={238} y1={72} x2={1172} y2={70} stroke="rgba(178,188,240,0.3)" />
      <line x1={238} y1={334} x2={1172} y2={332} stroke="rgba(178,188,240,0.3)" />
      <line x1={238} y1={203} x2={1172} y2={203} stroke="rgba(178,188,240,0.25)" />

      {/* column separators with caps */}
      {boundaries.map((x, i) => (
        <g key={i} stroke="rgba(178,188,240,0.35)">
          <line x1={x} y1={60} x2={x} y2={76} />
          <line x1={x} y1={192} x2={x} y2={216} />
          <line x1={x} y1={326} x2={x} y2={344} />
          <line x1={x - 3} y1={60} x2={x + 3} y2={60} />
          <line x1={x - 3} y1={344} x2={x + 3} y2={344} />
        </g>
      ))}

      {/* corridor ticks between rows */}
      {Array.from({ length: 46 }, (_, i) => (
        <line
          key={i}
          x1={248 + i * 20}
          y1={206}
          x2={248 + i * 20}
          y2={211}
          stroke="rgba(178,188,240,0.25)"
        />
      ))}

      {/* cells */}
      {bayRows.map((row, r) =>
        row.map((cell, c) => (
          <Cell
            key={`${r}-${c}`}
            cell={cell}
            x={GRID_X + c * COL_STEP}
            y={ROW_Y[r]}
          />
        )),
      )}

      {/* stern cranes */}
      {[1176, 1200].map((x) => (
        <g key={x} stroke="rgba(178,188,240,0.4)">
          <line x1={x} y1={58} x2={x} y2={362} strokeWidth={2} />
          {Array.from({ length: 14 }, (_, i) => (
            <line key={i} x1={x} y1={72 + i * 21} x2={x + 10} y2={72 + i * 21} strokeWidth={0.75} />
          ))}
        </g>
      ))}
      <line x1={1176} y1={58} x2={1210} y2={58} stroke="rgba(178,188,240,0.4)" />
      <line x1={1176} y1={362} x2={1210} y2={362} stroke="rgba(178,188,240,0.4)" />
    </svg>
  );
}
