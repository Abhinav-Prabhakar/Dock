# Dock — Arvion Dock Operations

Next.js (App Router) + TypeScript + Tailwind CSS v4. UI-only implementation of the
Dock Operations screen (vessel bay plan, container cards, loading flow, load balance).

## Run

```bash
npm install
npm run dev
```

## Structure

- `src/app/page.tsx` — layout shell
- `src/components/Sidebar.tsx` — Arvion rail: container cards, Cargo Optimizer, AI chat composer
- `src/components/MainHeader.tsx` — title, search, view toggle, alert pill
- `src/components/VesselPlan.tsx` — top-view bay plan (inline SVG, data-driven from `src/lib/data.ts`)
- `src/components/TimelineRuler.tsx` — scrubber track under the plan
- `src/components/LoadingFlow.tsx` — throughput card + dot timeline
- `src/components/LoadBalance.tsx` — port/starboard balance gauge
- `src/components/RightRail.tsx` — edge icon rail
- `src/lib/data.ts` — mock data (sidebar cards, bay cells, flow dots)

## Image assets

Drop supplied assets in `public/assets/`. Intended slots:

- `SideViewSchematic` in `src/components/Sidebar.tsx` — blueprint line-art of the
  vessel side elevation (currently a hand-drawn SVG placeholder).

No real functionality is wired yet — controls are visual only, pending the handoff README.
