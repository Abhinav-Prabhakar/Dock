import {
  ArrowUpRight,
  Expand,
  SlidersHorizontal,
} from "lucide-react";
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

export function Sidebar() {
  return (
    <aside className="sticky top-0 flex h-screen w-[384px] shrink-0 flex-col gap-4 px-4 pt-4 pb-4">
      {/* brand + controls */}
      <div className="flex items-center justify-between">
        <span className="font-display text-[17px] font-bold italic tracking-tight text-hi">
          Arvion
        </span>
        <div className="flex items-center gap-2">
          <SparkleButton />
          <button className="flex h-8 w-8 items-center justify-center rounded-lg chip text-mid transition-colors hover:text-hi">
            <Expand size={14} strokeWidth={1.75} />
          </button>
          <button className="flex h-8 w-8 items-center justify-center rounded-lg chip text-mid transition-colors hover:text-hi">
            <SlidersHorizontal size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {/* container cards */}
      <div className="grid shrink-0 grid-cols-2 gap-3">
        {sidebarContainers.map((c) => (
          <ContainerCard key={c.id} c={c} />
        ))}
      </div>

      {/* AI chat — blueprint analysis + composer */}
      <AiChat />
    </aside>
  );
}
