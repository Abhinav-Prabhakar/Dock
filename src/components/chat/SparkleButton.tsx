"use client";

import { Star } from "lucide-react";

export function SparkleButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("dock:focus-composer"))}
      aria-label="Ask Cargo Optimizer"
      title="Ask Cargo Optimizer"
      className="flex h-8 w-12 cursor-pointer items-center justify-center rounded-full bg-white text-abyss transition-all hover:bg-white/90 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <Star size={15} fill="currentColor" strokeWidth={1.75} />
    </button>
  );
}
