import { Sidebar } from "@/components/Sidebar";
import { MainHeader } from "@/components/MainHeader";
import { VesselPlan } from "@/components/VesselPlan";
import { TimelineRuler } from "@/components/TimelineRuler";
import { LoadingFlow } from "@/components/LoadingFlow";
import { LoadBalance } from "@/components/LoadBalance";
import { RightRail } from "@/components/RightRail";

export default function Page() {
  return (
    <div className="dock-bg flex min-h-screen">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col px-6 pt-6 pb-4">
        <MainHeader />
        <div className="mt-2 flex flex-1 items-center">
          <VesselPlan />
        </div>
        <TimelineRuler />
        <div className="mt-2 flex gap-4">
          <LoadingFlow />
          <LoadBalance />
        </div>
      </main>
      <RightRail />
    </div>
  );
}
