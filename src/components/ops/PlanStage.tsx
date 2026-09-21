"use client";

import { useOps } from "./OpsProvider";
import { VesselPlan } from "@/components/VesselPlan";
import { VesselSideView } from "./VesselSideView";

/** Swaps the centerpiece graphic between top plan and side elevation. */
export function PlanStage() {
  const { view } = useOps();
  return view === "top" ? <VesselPlan /> : <VesselSideView />;
}
