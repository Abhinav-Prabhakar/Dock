"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { useOps } from "./OpsProvider";

/** Zoom overlay for dashboard panels — fixed modal, backdrop + Esc close. */
export function PanelZoom({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const { setZoom } = useOps();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoom(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setZoom]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-abyss/70 p-8 backdrop-blur-sm"
      onClick={() => setZoom(null)}
    >
      <div
        className="panel w-full max-w-[860px] rounded-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-[15px] font-medium text-hi">
            {title}
          </h2>
          <button
            onClick={() => setZoom(null)}
            className="chip flex h-7 w-7 items-center justify-center rounded-full text-low transition-colors hover:text-hi"
            aria-label="Close"
          >
            <X size={13} strokeWidth={1.75} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
