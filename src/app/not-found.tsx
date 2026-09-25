import Link from "next/link";
import { Anchor } from "lucide-react";

export default function NotFound() {
  return (
    <div className="dock-bg flex min-h-screen items-center justify-center px-6">
      <div className="panel flex max-w-sm flex-col items-center gap-4 rounded-2xl px-10 py-12 text-center">
        <Anchor size={56} className="text-faint" strokeWidth={1.25} />
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-faint">
            404
          </p>
          <h1 className="mt-1 font-display text-2xl font-semibold text-hi">
            Lost at sea
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-mid">
            This port doesn&apos;t exist — the route you asked for isn&apos;t on
            any chart we hold.
          </p>
        </div>
        <Link
          href="/"
          className="chip mt-2 inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-medium text-accent transition-colors hover:border-accent/40 hover:text-hi"
        >
          Back to the dock
        </Link>
      </div>
    </div>
  );
}
