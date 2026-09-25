import {
  ArrowUpRight,
  Expand,
  Mic,
  Plus,
  SlidersHorizontal,
  Sparkle,
} from "lucide-react";
import { sidebarContainers, type SidebarContainer } from "@/lib/data";

const toneStyles: Record<
  SidebarContainer["tone"],
  { bar: string; id: string; card: string }
> = {
  highlight: {
    bar: "bg-transparent",
    id: "text-hi",
    card: "bg-gradient-to-b from-accent-hi to-accent-deep border-transparent",
  },
  critical: { bar: "bg-critical", id: "text-critical", card: "panel-flat" },
  minor: { bar: "bg-warn", id: "text-warn", card: "panel-flat" },
  optimized: { bar: "bg-reserved", id: "text-reserved", card: "panel-flat" },
};

function ContainerCard({ c }: { c: SidebarContainer }) {
  const t = toneStyles[c.tone];
  const highlight = c.tone === "highlight";
  return (
    <div
      className={`relative overflow-hidden rounded-2xl px-4 pt-3.5 pb-4 ${t.card} ${
        highlight ? "" : "border"
      }`}
    >
      {!highlight && (
        <span className={`absolute left-0 top-3.5 h-3.5 w-[3px] rounded-r ${t.bar}`} />
      )}
      <div className="flex items-start justify-between">
        <div>
          <p className={`text-[13px] font-semibold tracking-wide ${t.id}`}>
            {c.id}
          </p>
          <p
            className={`mt-2 text-[11px] ${
              highlight ? "text-white/70" : "text-low"
            }`}
          >
            Platform{" "}
            <span className={highlight ? "text-white" : "text-mid"}>
              {c.platform}
            </span>
          </p>
          <p
            className={`mt-0.5 text-[11px] ${
              highlight ? "text-white/70" : "text-low"
            }`}
          >
            Status{" "}
            <span className={highlight ? "text-white" : "text-mid"}>
              {c.status}
            </span>
          </p>
        </div>
      </div>
      <div className="mt-4 flex items-end justify-between">
        <p className="font-display text-[22px] leading-none font-medium text-hi">
          {c.weight} <span className="text-[15px] font-normal">t</span>
        </p>
        <button
          className={`rounded-full p-1.5 transition-colors ${
            highlight
              ? "bg-white/15 text-white hover:bg-white/25"
              : "text-low hover:text-mid"
          }`}
          aria-label={`Expand ${c.id}`}
        >
          <ArrowUpRight size={14} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

/** Placeholder for the blueprint line-art asset — swap with an <Image> when supplied. */
function SideViewSchematic() {
  const stack = (x: number, colors: string[]) =>
    colors.map((c, i) => (
      <rect
        key={`${x}-${i}`}
        x={x}
        y={44 - i * 7}
        width="12"
        height="5"
        rx="1"
        fill={c}
        opacity="0.55"
      />
    ));
  return (
    <svg
      viewBox="0 0 300 76"
      className="h-[76px] w-full"
      fill="none"
      aria-hidden
    >
      {/* hull */}
      <path
        d="M8 52 L14 62 Q16 66 24 66 L268 66 Q282 66 290 52 L292 48"
        stroke="rgba(170,180,235,0.45)"
        strokeWidth="1"
      />
      <path
        d="M8 52 L292 48"
        stroke="rgba(170,180,235,0.3)"
        strokeWidth="1"
      />
      {/* bow deck line */}
      <path d="M8 52 L40 50" stroke="rgba(170,180,235,0.25)" strokeWidth="0.75" />
      {/* container stacks */}
      {stack(60, ["#e0566b", "#d9b13b", "#3fbdb0", "#3fbdb0"])}
      {stack(76, ["#d9b13b", "#3fbdb0", "#e0566b"])}
      {stack(92, ["#3fbdb0", "#3fbdb0", "#d9b13b", "#e0566b"])}
      {stack(108, ["#e0566b", "#3fbdb0", "#d9b13b"])}
      {stack(124, ["#d9b13b", "#e0566b", "#3fbdb0", "#3fbdb0"])}
      {stack(140, ["#3fbdb0", "#d9b13b", "#e0566b"])}
      {stack(156, ["#e0566b", "#3fbdb0", "#d9b13b", "#d9b13b"])}
      {stack(172, ["#3fbdb0", "#e0566b", "#3fbdb0"])}
      {stack(188, ["#d9b13b", "#3fbdb0", "#e0566b", "#3fbdb0"])}
      {/* superstructure */}
      <rect x="236" y="14" width="34" height="36" rx="1.5" stroke="rgba(170,180,235,0.45)" />
      <rect x="244" y="8" width="18" height="6" rx="1" stroke="rgba(170,180,235,0.4)" />
      <line x1="253" y1="2" x2="253" y2="8" stroke="rgba(170,180,235,0.4)" />
      <line x1="240" y1="24" x2="266" y2="24" stroke="rgba(170,180,235,0.25)" />
      <line x1="240" y1="34" x2="266" y2="34" stroke="rgba(170,180,235,0.25)" />
      {/* gantry hints */}
      <line x1="56" y1="52" x2="56" y2="18" stroke="rgba(170,180,235,0.22)" />
      <line x1="56" y1="18" x2="210" y2="18" stroke="rgba(170,180,235,0.22)" />
      <line x1="206" y1="18" x2="206" y2="52" stroke="rgba(170,180,235,0.22)" />
    </svg>
  );
}

export function Sidebar() {
  return (
    <aside className="flex w-[352px] shrink-0 flex-col gap-4 px-4 pt-4 pb-4">
      {/* brand + controls */}
      <div className="flex items-center justify-between">
        <span className="font-display text-[17px] font-bold italic tracking-tight text-hi">
          Arvion
        </span>
        <div className="flex items-center gap-2">
          <button className="flex h-8 w-12 items-center justify-center rounded-full bg-white text-abyss transition-colors hover:bg-white/90">
            <Sparkle size={15} fill="currentColor" />
          </button>
          <button className="flex h-8 w-8 items-center justify-center rounded-lg chip text-mid transition-colors hover:text-hi">
            <Expand size={14} strokeWidth={1.75} />
          </button>
          <button className="flex h-8 w-8 items-center justify-center rounded-lg chip text-mid transition-colors hover:text-hi">
            <SlidersHorizontal size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {/* container cards */}
      <div className="grid grid-cols-2 gap-3">
        {sidebarContainers.map((c) => (
          <ContainerCard key={c.id} c={c} />
        ))}
      </div>

      {/* cargo optimizer */}
      <div className="panel-flat rounded-2xl px-4 pt-3.5 pb-4">
        <div className="flex items-center justify-between">
          <p className="text-[12px] font-medium text-mid">Cargo Optimizer</p>
        </div>
        <div className="mt-2.5 flex items-center gap-4 text-[10.5px] text-low">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-pending" /> Pending
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-reserved" /> Reserved
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-loaded" /> Loaded
          </span>
        </div>
        <div className="mt-3 rounded-lg border hairline px-2 py-1.5">
          {/* ASSET: replace <SideViewSchematic/> with blueprint image when supplied */}
          <SideViewSchematic />
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-low">
          Current container layout on LYN-01 shows a left-heavy imbalance,
          particularly around Platforms B2 and C1. To optimize loading efficiency
          and reduce tilt risk, consider shifting CNT-C14 and CNT-C09 to central
          bays.
        </p>
      </div>

      {/* chat composer */}
      <div className="relative mt-auto">
        <div className="panel-flat relative overflow-hidden rounded-2xl px-4 pt-3.5 pb-3">
          <p className="min-h-[52px] text-[12px] leading-relaxed text-mid">
            Can you review container distribution on LYN-01 and suggest changes to
            improve weight
            <span className="ml-0.5 inline-block h-3.5 w-[1.5px] translate-y-0.5 animate-pulse bg-hi" />
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button className="flex h-8 w-8 items-center justify-center rounded-full border hairline text-mid transition-colors hover:text-hi">
              <Plus size={15} strokeWidth={1.75} />
            </button>
            <button className="flex h-8 w-8 items-center justify-center rounded-full text-mid transition-colors hover:text-hi">
              <Mic size={15} strokeWidth={1.75} />
            </button>
            <button className="ml-auto flex h-9 w-12 items-center justify-center rounded-full bg-white text-abyss transition-colors hover:bg-white/90">
              <ArrowUpRight size={16} strokeWidth={2} />
            </button>
          </div>
          {/* rainbow input glow */}
          <span className="pointer-events-none absolute inset-x-6 bottom-0 h-[2px] rounded-full bg-gradient-to-r from-rose-400 via-amber-300 via-emerald-300 via-cyan-300 to-indigo-400 blur-[2px]" />
        </div>
      </div>
    </aside>
  );
}
