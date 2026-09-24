"use client";

import { Map, Ship } from "lucide-react";
import { useEpisode } from "@/components/dock/EpisodeProvider";
import { PortMap } from "@/components/fleet/PortMap";
import { VesselCards } from "@/components/fleet/VesselCards";
import { EmptiesTicker } from "@/components/fleet/EmptiesTicker";
import { DecisionLogRail } from "@/components/fleet/DecisionLogRail";
import { ShockReplay } from "@/components/fleet/ShockReplay";
import { CredibilityPanel } from "@/components/fleet/CredibilityPanel";

/**
 * The ops floor. Left: live fleet positions over the empties strip over
 * vessel spec cards. Right rail: decision log, shock replay, credibility.
 * Fills the chrome's overflow-hidden <main> — no page scroll on desktop;
 * below ~1100px it stacks and the column scrolls.
 */
export function FleetScreen() {
  const { ports, vessels, snapshot, episode } = useEpisode();
  const atSea = snapshot?.vessels.filter((v) => v.mode === "SEA").length ?? 0;
  const live = !!episode && (episode.status === "running" || episode.status === "paused");

  return (
    <div className="flex h-full flex-col overflow-y-auto scroll-thin min-[1100px]:flex-row min-[1100px]:overflow-hidden">
      {/* Left region — map dominates, ticker strip, vessel cards (~63%) */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4">
        <div className="panel flex min-h-[320px] flex-1 flex-col overflow-hidden rounded-2xl">
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-edge-soft px-3.5">
            <span className="flex items-center gap-2">
              <Map size={12} className="text-accent" strokeWidth={1.75} />
              <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
                fleet positions
              </span>
            </span>
            <span className="flex items-center gap-3 text-[9.5px] tabular-nums text-faint">
              <span>
                {ports.length} ports · {vessels.length} vessels
              </span>
              {live && (
                <span className="flex items-center gap-1.5 text-loaded-soft">
                  <span className="h-1.5 w-1.5 rounded-full bg-loaded shadow-[0_0_6px_rgba(63,191,177,0.9)] animate-pulse" />
                  {atSea} at sea
                </span>
              )}
            </span>
          </div>
          <div className="min-h-0 flex-1">
            <PortMap />
          </div>
        </div>

        <div className="panel-flat flex h-10 shrink-0 items-center overflow-hidden rounded-xl border-edge px-3">
          <EmptiesTicker />
        </div>

        <div className="shrink-0">
          <div className="flex items-center gap-2 px-1 pb-2">
            <Ship size={12} className="text-accent" strokeWidth={1.75} />
            <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
              vessels
            </span>
          </div>
          <div className="overflow-x-auto scroll-thin pb-1 [&>*>*]:min-w-[270px]">
            <VesselCards />
          </div>
        </div>
      </section>

      {/* Right rail — ops log + replay + ledger (~38%, 380–420px),
          one continuous surface divided by hairlines */}
      <aside className="panel-flat w-full shrink-0 overflow-y-auto scroll-thin border-t border-edge min-[1100px]:w-[38%] min-[1100px]:min-w-[380px] min-[1100px]:max-w-[420px] min-[1100px]:border-t-0 min-[1100px]:border-l">
        <div className="flex min-h-full flex-col">
          <div className="flex min-h-[380px] flex-1 flex-col px-4 pb-3 pt-3.5">
            <DecisionLogRail />
          </div>
          <div className="shrink-0 border-t border-edge-soft px-4 py-4">
            <ShockReplay />
          </div>
          <div className="shrink-0 border-t border-edge-soft px-4 py-4">
            <CredibilityPanel />
          </div>
        </div>
      </aside>
    </div>
  );
}
