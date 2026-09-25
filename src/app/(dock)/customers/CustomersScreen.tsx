"use client";

import { useState } from "react";
import { BookingDesk } from "@/components/customers/BookingDesk";
import { DealsRail } from "@/components/customers/DealsRail";
import { WhyDrawer } from "@/components/customers/WhyDrawer";
import type { EpisodeEvent } from "@/lib/api";

export function CustomersScreen() {
  const [selected, setSelected] = useState<EpisodeEvent | null>(null);
  const clear = () => setSelected(null);

  return (
    <div className="h-full flex">
      <div className="relative flex-1 min-w-0">
        <BookingDesk onSelect={setSelected} />
        <WhyDrawer offer={selected} onClose={clear} />
      </div>
      <aside className="w-[340px] shrink-0 border-l border-edge panel-flat overflow-y-auto scroll-thin">
        <DealsRail />
      </aside>
    </div>
  );
}
