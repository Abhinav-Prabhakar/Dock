"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Anchor,
  BarChart3,
  ChevronsLeft,
  ChevronsRight,
  Handshake,
  Search,
} from "lucide-react";
import ComparisonDialog from "@/components/dock/ComparisonDialog";
import { useOps } from "@/components/ops/OpsProvider";

export function RightRail() {
  const { railCollapsed, toggleRail } = useOps();
  const [compareOpen, setCompareOpen] = useState(false);

  if (railCollapsed) {
    return (
      <div className="flex w-3 shrink-0 items-start justify-center pt-[38vh]">
        <button
          onClick={toggleRail}
          title="Open quick rail"
          aria-label="Open quick rail"
          className="flex h-8 w-8 items-center justify-center rounded-full text-faint transition-colors hover:text-hi"
        >
          <ChevronsRight size={14} strokeWidth={1.5} />
        </button>
      </div>
    );
  }

  const items: {
    icon: typeof Anchor;
    label: string;
    onClick?: () => void;
    href?: string;
  }[] = [
    {
      icon: Search,
      label: "Focus container search",
      onClick: () => document.getElementById("ops-search")?.focus(),
    },
    { icon: Handshake, label: "Booking desk", href: "/customers" },
    { icon: Anchor, label: "Fleet ops", href: "/fleet" },
    {
      icon: BarChart3,
      label: "Policy comparison",
      onClick: () => setCompareOpen(true),
    },
  ];

  return (
    <>
      <div className="flex w-11 shrink-0 flex-col items-center transition-all">
        <div className="flex flex-col gap-3 pt-[38vh]">
          {items.map(({ icon: Icon, label, onClick, href }) =>
            href ? (
              <Link
                key={label}
                href={href}
                title={label}
                aria-label={label}
                className="flex h-8 w-8 items-center justify-center rounded-full text-low transition-colors hover:bg-white/5 hover:text-hi"
              >
                <Icon size={14} strokeWidth={1.5} />
              </Link>
            ) : (
              <button
                key={label}
                onClick={onClick}
                title={label}
                aria-label={label}
                className="flex h-8 w-8 items-center justify-center rounded-full text-low transition-colors hover:bg-white/5 hover:text-hi"
              >
                <Icon size={14} strokeWidth={1.5} />
              </button>
            ),
          )}
        </div>
        <button
          onClick={toggleRail}
          title="Collapse rail"
          aria-label="Collapse rail"
          className="mt-auto mb-24 flex h-8 w-8 items-center justify-center rounded-full text-low transition-colors hover:text-hi"
        >
          <ChevronsLeft size={15} strokeWidth={1.5} />
        </button>
      </div>
      <ComparisonDialog open={compareOpen} onClose={() => setCompareOpen(false)} />
    </>
  );
}
