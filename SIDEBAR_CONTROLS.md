# Sidebar Controls — wiring status and how to extend

Last reviewed: 2026-09-15

Scope: the left sidebar (`src/components/Sidebar.tsx`) and the Cargo Optimizer panel
(`src/components/chat/AiChat.tsx`, `src/components/chat/SparkleButton.tsx`).

## Dependencies

Icons come from `lucide-react`, already declared in `package.json` (`^1.46.0`, installed 1.46.0).
No dependency changes are needed to run this UI; `npm install` is enough.

Icons currently used in the sidebar: `Star`, `Grid2x2Plus`, `SlidersVertical`, `Maximize2`, `Box`,
`Plus`, `Mic`, `Square`, `ArrowUpRight`, `Ship`, `Sparkles`, `Trash2`, `RotateCcw`, `Loader2`, `X`.

## Wired controls (already functional)

| Control | File | Behaviour |
|---|---|---|
| Star pill | `chat/SparkleButton.tsx` | Dispatches `dock:focus-composer`; `AiChat` listens and focuses the textarea |
| Composer `+` | `chat/AiChat.tsx` | Toggles the actions popover |
| Attach vessel snapshot | `chat/AiChat.tsx` | Sets `attachContext`, shows the LYN-01 chip |
| Insert example prompt | `chat/AiChat.tsx` | Fills the draft with the seed prompt |
| Clear conversation | `chat/AiChat.tsx` | Resets messages to the seed reply |
| Mic (tap) | `chat/AiChat.tsx` | Web Speech dictation into the draft |
| Mic (hold ~2.5s) | `chat/AiChat.tsx` | Opens `ApiSettingsDialog` |
| Send | `chat/AiChat.tsx` | Streams via `src/lib/llm.ts` to `src/app/api/chat/route.ts` |
| Stop | `chat/AiChat.tsx` | Aborts the in-flight stream |
| Retry request | `chat/AiChat.tsx` | Re-runs the last failed request |
| Notice dismiss / context chip X | `chat/AiChat.tsx` | Clears local UI state |

## NOT wired (visual only — no handler yet)

These render, hover, focus and press correctly, but have no `onClick`:

| Control | Location | Intended function |
|---|---|---|
| `Grid2x2Plus` | Brand row, `Sidebar.tsx` | Open a bay-grid picker to place a container into an empty slot |
| `SlidersVertical` | Brand row, `Sidebar.tsx` | Plan filters and thresholds (status, weight cap, reefer/hazmat) |
| `Maximize2` x4 | Each container card, `ContainerCard` in `Sidebar.tsx` | Expand that container into a detail view |

Related non-sidebar controls that are also visual only: the header search/filter/bell and
view toggles in `src/components/MainHeader.tsx`, the panel expand buttons in
`src/components/LoadingFlow.tsx` and `src/components/LoadBalance.tsx`, the timeline scrubber
in `src/components/TimelineRuler.tsx`, and the icon rail in `src/components/RightRail.tsx`.

## How to wire them

`src/app/page.tsx` is a server component, so sibling components cannot share React state
without a refactor. Two options, in order of cost.

### Option A — window custom events (no refactor)

This is the pattern already proven by `SparkleButton` to `AiChat`. Producer:

```tsx
<button
  type="button"
  onClick={() => window.dispatchEvent(new Event("dock:open-plan-filters"))}
  aria-label="Plan filters"
>
  <SlidersVertical size={14} strokeWidth={1.75} />
</button>
```

Consumer, inside any `"use client"` component:

```tsx
useEffect(() => {
  const open = () => setFiltersOpen(true);
  window.addEventListener("dock:open-plan-filters", open);
  return () => window.removeEventListener("dock:open-plan-filters", open);
}, []);
```

For events that carry data, use `CustomEvent`:

```tsx
window.dispatchEvent(
  new CustomEvent("dock:maximize-container", { detail: { id: c.id } }),
);
```

Suggested event names to keep things consistent:

- `dock:focus-composer` (exists)
- `dock:open-bay-grid`
- `dock:open-plan-filters`
- `dock:maximize-container` (detail: `{ id: string }`)

If this grows past a handful of events, add `src/lib/events.ts` with typed
`dispatchDockEvent` / `useDockEvent` helpers so names are not duplicated as string literals.

### Option B — client state container (better for real features)

Create `src/components/DockShell.tsx` marked `"use client"`, move the sidebar/main/rail
composition into it, hold shared state (selected container, active filters, bay-grid mode)
there, and pass props down. Then `src/app/page.tsx` renders `<DockShell />` only.

Use this when a control has to change what the vessel plan renders, since
`src/components/VesselPlan.tsx` reads `bayRows` from `src/lib/data.ts` directly and would
need filtered data passed in.

### Note on data

All sidebar content is mock data in `src/lib/data.ts` (`sidebarContainers`, `bayRows`,
`flowDots`). Real values should come from the backend demo artifacts in `public/demo/`
(`summary.json`, `timeline.json`, `offers.json`, `shock.json`, `meta.json`), which is the
`/compare` work described in `technical.md` section 4.2.
