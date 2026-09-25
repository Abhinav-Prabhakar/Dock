"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Anchor } from "lucide-react";

export function DockNav() {
  const pathname = usePathname();

  return (
    <div className="flex items-center gap-8">
      <Link href="/" className="flex items-center gap-2 text-hi hover:text-accent transition-colors">
        <Anchor size={20} className="text-accent" />
        <span className="font-display font-semibold tracking-wide text-lg">Dock</span>
      </Link>
      
      <nav className="flex items-center gap-1 bg-ink rounded-lg p-1 border border-edge">
        <Link 
          href="/customers" 
          className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${pathname.startsWith('/customers') ? 'bg-white/10 text-hi' : 'text-mid hover:text-hi hover:bg-white/5'}`}
        >
          Customers
        </Link>
        <Link 
          href="/fleet" 
          className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${pathname.startsWith('/fleet') ? 'bg-white/10 text-hi' : 'text-mid hover:text-hi hover:bg-white/5'}`}
        >
          Fleet
        </Link>
      </nav>
    </div>
  );
}
