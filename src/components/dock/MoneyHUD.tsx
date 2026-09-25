"use client";

import React from "react";
import { useEpisode } from "./EpisodeProvider";

export function MoneyHUD() {
  const { state } = useEpisode();
  
  // Use cumulative profit from metrics if running, otherwise use a placeholder
  const profit = state.metrics?.cum_profit ?? 17970000;
  
  const formattedProfit = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(profit);

  return (
    <button 
      onClick={() => console.log("Open comparison dialog")}
      className="chip flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-white/5 transition-colors"
    >
      <span className="text-mid text-sm font-medium">Live Profit</span>
      <span className="text-hi font-display font-semibold tracking-wide">
        {formattedProfit}
      </span>
      <span className="text-accent text-xs">▸</span>
    </button>
  );
}
