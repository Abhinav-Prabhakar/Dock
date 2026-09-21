import { Anchor } from "lucide-react";

export default function Loading() {
  return (
    <div className="dock-bg flex min-h-screen items-center justify-center">
      <Anchor size={28} className="animate-pulse text-accent" strokeWidth={1.5} />
    </div>
  );
}
