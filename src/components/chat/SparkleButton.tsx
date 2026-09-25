"use client";

import { Sparkle } from "lucide-react";

export function SparkleButton() {
  return (
    <button
      onClick={() => window.dispatchEvent(new Event("dock:focus-composer"))}
      aria-label="Focus AI composer"
      className="flex h-8 w-12 items-center justify-center rounded-full bg-white text-abyss transition-colors hover:bg-white/90"
    >
      <Sparkle size={15} fill="currentColor" />
    </button>
  );
}
