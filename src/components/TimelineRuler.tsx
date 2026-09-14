import { Ship } from "lucide-react";

export function TimelineRuler() {
  return (
    <div className="relative flex items-center gap-5 px-1 py-3">
      {/* minimap of the plan */}
      <svg viewBox="0 0 110 30" className="h-[26px] w-[100px] shrink-0" fill="none" aria-hidden>
        <rect x="2" y="3" width="106" height="24" rx="12" stroke="rgba(178,188,240,0.4)" />
        {Array.from({ length: 9 }, (_, i) => (
          <line
            key={i}
            x1={16 + i * 10}
            y1={7}
            x2={16 + i * 10}
            y2={23}
            stroke="rgba(178,188,240,0.3)"
            strokeWidth={0.75}
          />
        ))}
      </svg>

      {/* ruler track */}
      <div className="relative flex-1">
        <svg viewBox="0 0 1000 26" className="h-[26px] w-full" preserveAspectRatio="none" aria-hidden>
          <line x1="0" y1="13" x2="1000" y2="13" stroke="rgba(178,188,240,0.3)" />
          {Array.from({ length: 100 }, (_, i) => (
            <line
              key={i}
              x1={5 + i * 10}
              y1={13}
              x2={5 + i * 10}
              y2={i % 5 === 0 ? 5 : 9}
              stroke="rgba(178,188,240,0.35)"
              strokeWidth={0.75}
            />
          ))}
        </svg>
        {/* scrubber handle */}
        <div className="absolute top-1/2 left-[30%] flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border hairline bg-panel-3 shadow-[0_0_14px_rgba(80,95,220,0.45)]">
          <Ship size={12} className="text-hi" />
        </div>
      </div>
    </div>
  );
}
