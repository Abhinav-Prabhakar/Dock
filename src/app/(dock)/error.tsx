"use client";

import { TriangleAlert } from "lucide-react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="panel flex max-w-sm flex-col items-center gap-4 rounded-2xl px-10 py-10 text-center">
        <TriangleAlert size={36} className="text-warn" strokeWidth={1.5} />
        <div>
          <h2 className="font-display text-lg font-semibold text-hi">
            The desk hit rough water
          </h2>
          {error.message && (
            <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-faint break-words">
              {error.message}
            </p>
          )}
        </div>
        <button
          onClick={() => reset()}
          className="chip mt-1 inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-medium text-accent transition-colors hover:border-accent/40 hover:text-hi"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
