"use client";

import { Map, Ship } from "lucide-react";
import { SectionTitle } from "@/components/dock/ui";
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
  return (
    <div className="flex h-full flex-col overflow-y-auto scroll-thin min-[1100px]:flex-row min-[1100px]:overflow-hidden">
      {/* Left region — map dominates, ticker strip, vessel cards (~63%) */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4">
        <div className="flex min-h-[320px] flex-1 flex-col">
          <SectionTitle icon={Map}>fleet positions</SectionTitle>
          <div className="min-h-0 flex-1">
            {/* PortMap ships its own border — just give it a sized box */}
            <div className="h-full w-full">
              <PortMap />
            </div>
          </div>
        </div>

        <div className="panel-flat flex h-9 shrink-0 items-center overflow-hidden rounded-2xl border-edge px-3">
          <EmptiesTicker />
        </div>

        <div className="shrink-0">
          <SectionTitle icon={Ship}>vessels</SectionTitle>
          <div className="overflow-x-auto scroll-thin pb-1 [&>*>*]:min-w-[270px]">
            <VesselCards />
          </div>
        </div>
      </section>

      {/* Right rail — ops log + replay + ledger (~38%, 380–420px) */}
      <aside className="panel-flat w-full shrink-0 overflow-y-auto scroll-thin border-t border-edge min-[1100px]:w-[38%] min-[1100px]:min-w-[380px] min-[1100px]:max-w-[420px] min-[1100px]:border-t-0 min-[1100px]:border-l">
        <div className="flex min-h-full flex-col gap-3 p-4">
          <div className="panel-flat flex min-h-[420px] flex-1 flex-col overflow-hidden rounded-2xl border-edge">
            <DecisionLogRail />
          </div>
          <div className="panel-flat shrink-0 rounded-2xl border-edge">
            <ShockReplay />
          </div>
          <div className="panel-flat shrink-0 rounded-2xl border-edge">
            <CredibilityPanel />
          </div>
        </div>
      </aside>
    </div>
  );
}
