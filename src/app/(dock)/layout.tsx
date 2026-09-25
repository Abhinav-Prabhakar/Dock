import React from "react";
import { EpisodeProvider } from "@/components/dock/EpisodeProvider";
import { MoneyHUD } from "@/components/dock/MoneyHUD";
import { EpisodeControls } from "@/components/dock/EpisodeControls";
import { DockNav } from "@/components/dock/DockNav";

export default function DockLayout({ children }: { children: React.ReactNode }) {
  return (
    <EpisodeProvider>
      <div className="flex flex-col h-full dock-bg">
        <header className="panel-flat border-b border-edge flex items-center justify-between px-6 py-3 shrink-0">
          <DockNav />
          <MoneyHUD />
        </header>

        <EpisodeControls />

        <main className="flex-1 overflow-hidden relative">
          {children}
        </main>
      </div>
    </EpisodeProvider>
  );
}
