import { Grid2X2Plus, Maximize2, SlidersVertical } from "lucide-react";
import { sidebarContainers, type SidebarContainer } from "@/lib/data";
import { AiChat } from "@/components/chat/AiChat";
import { SparkleButton } from "@/components/chat/SparkleButton";

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
      className={`relative overflow-hidden rounded-2xl px-3.5 pt-3.5 pb-4 ${t.card} ${
        highlight ? "" : "border"
      }`}
    >
      {/* Title row: tone bar sits at content padding, ID immediately beside it */}
      <div className="flex items-center gap-2">
        <span className={`h-3.5 w-[3px] shrink-0 rounded-full ${t.bar}`} />
        <p className={`text-[13px] font-semibold tracking-wide ${t.id}`}>
          {c.id}
        </p>
      </div>

      {/* Body + weight share the bar's left edge */}
      <div className="mt-2">
        <p
          className={`text-[11px] ${
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

      <div className="mt-4 flex items-end justify-between">
        <p className="font-display text-[22px] leading-none font-medium text-hi">
          {c.weight} <span className="text-[15px] font-normal">t</span>
        </p>
        <button
          type="button"
          className={`cursor-pointer rounded-full p-1.5 transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
            highlight
              ? "bg-white/15 text-white hover:bg-white/25"
              : "text-low hover:text-mid"
          }`}
          aria-label={`Maximize ${c.id}`}
          title={`Maximize ${c.id}`}
        >
          <Maximize2 size={13} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="sticky top-0 flex h-screen w-[clamp(320px,28vw,384px)] shrink-0 flex-col gap-4 px-4 pt-4 pb-4">
      {/* brand + controls */}
      <div className="flex items-center justify-between">
        <span className="font-display text-[16px] font-semibold italic tracking-normal text-hi">
          Arvion
        </span>
        <div className="flex items-center gap-1.5">
          <SparkleButton />
          <button
            type="button"
            aria-label="Add container to bay grid"
            title="Add container to bay grid"
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-mid transition-all hover:text-hi active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <Grid2x2Plus size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label="Plan filters"
            title="Plan filters"
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-mid transition-all hover:text-hi active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <SlidersVertical size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {/* container cards */}
      <div className="grid shrink-0 grid-cols-2 gap-3">
        {sidebarContainers.map((c) => (
          <ContainerCard key={c.id} c={c} />
        ))}
      </div>

      {/* Cargo Optimizer + composer — flex so panel sits under cards */}
      <div className="flex min-h-0 flex-1 flex-col">
        <AiChat />
      </div>
    </aside>
  );
}
