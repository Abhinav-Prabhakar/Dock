"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Anchor, Store, Radar } from "lucide-react";

const TABS = [
  { href: "/customers", label: "Customers", icon: Store },
  { href: "/fleet", label: "Fleet", icon: Radar },
];

export function DockNav() {
  const pathname = usePathname();

  return (
    <div className="flex items-center gap-5">
      <Link href="/" className="group flex items-center gap-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-b from-accent-hi to-accent-deep shadow-[0_0_18px_rgba(124,135,242,0.35)] transition-shadow group-hover:shadow-[0_0_24px_rgba(124,135,242,0.55)]">
          <Anchor size={15} className="text-white" strokeWidth={2.25} />
        </span>
        <span className="font-display text-[15px] font-semibold tracking-[0.16em] text-hi">
          DOCK
        </span>
      </Link>

      <nav className="flex items-center gap-0.5 rounded-xl border border-edge bg-ink/80 p-1">
        {TABS.map((tab) => {
          const active = pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12px] font-medium transition-colors ${
                active
                  ? "bg-panel-2 text-hi shadow-[inset_0_1px_0_rgba(198,206,255,0.07),0_2px_8px_rgba(0,0,0,0.35)]"
                  : "text-low hover:bg-white/[0.04] hover:text-mid"
              }`}
            >
              <tab.icon
                size={12}
                strokeWidth={1.75}
                className={active ? "text-accent-soft" : "text-faint"}
              />
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
