import {
  Anchor,
  ChevronsLeft,
  Container,
  Search,
  SlidersVertical,
} from "lucide-react";

export function RightRail() {
  return (
    <div className="flex w-11 shrink-0 flex-col items-center">
      <div className="flex flex-col gap-3 pt-[38vh]">
        {[Search, Anchor, Container, SlidersVertical].map((Icon, i) => (
          <button
            key={i}
            className="flex h-8 w-8 items-center justify-center rounded-full text-low transition-colors hover:text-hi"
          >
            <Icon size={14} strokeWidth={1.5} />
          </button>
        ))}
      </div>
      <button className="mt-auto mb-24 flex h-8 w-8 items-center justify-center rounded-full text-low transition-colors hover:text-hi">
        <ChevronsLeft size={15} strokeWidth={1.5} />
      </button>
    </div>
  );
}
