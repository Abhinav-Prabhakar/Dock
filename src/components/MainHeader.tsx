import {
  Bell,
  ChevronDown,
  Search,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";

function SideViewGlyph() {
  return (
    <svg viewBox="0 0 34 12" className="h-3 w-9" fill="none" aria-hidden>
      <path
        d="M2 5 L5 9 L28 9 L32 5 Z"
        fill="rgba(154,161,201,0.9)"
      />
      <rect x="20" y="1.5" width="7" height="3.5" rx="0.75" fill="rgba(154,161,201,0.9)" />
      <rect x="7" y="3" width="4" height="2" rx="0.5" fill="rgba(154,161,201,0.6)" />
      <rect x="12" y="3" width="4" height="2" rx="0.5" fill="rgba(154,161,201,0.6)" />
    </svg>
  );
}

function TopViewGlyph() {
  return (
    <svg viewBox="0 0 34 14" className="h-3.5 w-9" fill="none" aria-hidden>
      <rect x="2" y="1.5" width="30" height="11" rx="5.5" stroke="#eef0ff" strokeWidth="1.25" />
      {[9, 14, 19, 24].map((x) => (
        <line key={x} x1={x} y1={4} x2={x} y2={10} stroke="#eef0ff" strokeWidth="0.75" opacity="0.8" />
      ))}
    </svg>
  );
}

export function MainHeader() {
  return (
    <header>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-[30px] font-semibold tracking-tight text-hi">
            Dock Operations
          </h1>
          <p className="mt-1 text-[11.5px] text-low">Last update 1 min ago</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="chip flex h-9 w-52 items-center gap-2 rounded-full px-3.5">
            <span className="flex-1 text-[11.5px] text-low">
              Container search
            </span>
            <Search size={13} className="text-low" />
          </div>
          <button className="chip flex h-9 w-9 items-center justify-center rounded-full text-mid transition-colors hover:text-hi">
            <SlidersHorizontal size={14} strokeWidth={1.75} />
          </button>
          <button className="chip flex h-9 w-9 items-center justify-center rounded-full text-mid transition-colors hover:text-hi">
            <Bell size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="mt-5 flex items-start justify-between">
        {/* view toggle */}
        <div className="flex items-start gap-3">
          <div className="flex flex-col items-center gap-1.5">
            <button className="chip flex h-9 w-20 items-center justify-center rounded-full transition-colors hover:border-edge">
              <SideViewGlyph />
            </button>
            <span className="text-[10px] text-low">Side View</span>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <button className="flex h-9 w-20 items-center justify-center rounded-full border border-edge bg-panel-3 shadow-[0_0_16px_rgba(80,95,220,0.25)]">
              <TopViewGlyph />
            </button>
            <span className="text-[10px] text-mid">Top View</span>
          </div>
        </div>

        {/* alert */}
        <button className="chip flex items-center gap-2 rounded-full py-2 pr-2.5 pl-3 text-[11.5px] text-hi transition-colors hover:border-edge">
          <TriangleAlert size={13} className="text-critical" fill="rgba(240,82,79,0.25)" />
          Cargo loading error
          <ChevronDown size={13} className="text-low" />
        </button>
      </div>
    </header>
  );
}
