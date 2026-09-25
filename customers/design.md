# customers — MERIDIAN LINE Booking Credential

*The customer-facing page. First visit (no orders in the mock `ml.orders` store) lands here; returning customers are routed to the fleet dashboard. `?new` always forces this screen so customers can file additional requests.*

**One-line concept:** a physically simulated cargo-booking badge — a laminated shipping-line credential hanging from a braided leather cord on a brass wall hook — that you can grab, fling, and swing, next to a two-step "booking details" paper deck that slides in from the right.

Everything is hand-built from three files: no frameworks, no assets, no fonts loaded. All artwork (barcode, QR, container illustrations, stamps, ship) is inline SVG or seeded-canvas, generated at runtime.

---

## Contents

1. [At a glance](#at-a-glance)
2. [File map](#file-map)
3. [Scene composition & layer stack](#scene-composition--layer-stack)
4. [Art direction](#art-direction)
5. [The badge — anatomy](#the-badge--anatomy)
6. [Generated print artwork](#generated-print-artwork)
7. [Physics engine](#physics-engine)
8. [Visual response (per-frame rendering)](#visual-response-per-frame-rendering)
9. [Interaction model](#interaction-model)
10. [Split view — the booking deck](#split-view--the-booking-deck)
11. [Column 1 · CARGO — request size](#column-1--cargo--request-size)
12. [Column 2 · ROUTE — scheduling calendar](#column-2--route--scheduling-calendar)
13. [Column 2 · ROUTE — port pair & price](#column-2--route--port-pair--price)
14. [Booking confirmation flow](#booking-confirmation-flow)
15. [Responsive strategy](#responsive-strategy)
16. [Accessibility](#accessibility)
17. [Key constants reference](#key-constants-reference)
18. [Design rules the system obeys](#design-rules-the-system-obeys)

---

## At a glance

| Aspect | Value |
|---|---|
| Theme | Light mode — warm cream plaster wall, printed-ephemera realism |
| Subject | "MERIDIAN LINE — Booking Request BK-2481-TC", Singapore → Oakland, FCL Trans-Pacific |
| Badge size | 332 × 468 px, hanging from a peg near top-center |
| Core gimmick | Rigid-body badge on a verlet-simulated leather cord; real momentum, torque, one-sided strap coupling |
| Companion UI | Right-docked two-column booking deck (auto-opens ~1.65 s after load) |
| Stack | Vanilla HTML + CSS + one `<script>`; DOM + one full-viewport `<canvas>` for the cord |
| Dependencies | None |

## File map

| File | Role |
|---|---|
| `index.html` | Scene markup: wall hook SVG, shadow div, strap canvas, the badge (`#card`) with all its print layers, the panel deck (`#panel` with `#col1` / `#col2`), hint line |
| `style.css` | All styling. Design tokens in `:root`; sections for the card, the laminate/optics, the deck, steppers, cargo types, calendar (`.cal-*`), port pair (`.pp-*`) |
| `script.js` | Seeded print generation (barcode/QR/stack), the physics loop, cord rendering, input handling, split-view choreography, cargo type blocks, calendar, port pair + price |

---

## Scene composition & layer stack

The page is one fixed full-viewport `.scene` (with `perspective: 1400px`, origin 50% 42%) plus the fixed `#panel` deck. Z-order:

| Layer | Z | Notes |
|---|---|---|
| `#cardShadow` (badge's wall shadow) | 1 | absolutely positioned 332×468 rounded rect, transform/blur/opacity driven per-frame |
| `#strap` canvas (leather cord) | 2 | fixed, full-viewport, DPR-aware |
| `#panel` deck | 3 | `pointer-events: none` until `.on` |
| `#card` (the badge) | 4 | `pointer-events: auto` — the only interactive thing inside the inert `.scene` |
| `.mount` (brass hook) + `.hint` | 5–6 | both ride the peg's x-offset via JS transform |
| `body::after` room vignette | 60 | fixed overlay, pointer-events none |

Key trick: `.scene` itself is `pointer-events: none`, so when the badge swings over the panel, clicks fall through to the panel. Card physics is driven by **window-level** pointer handlers with a card-local hit test, so the badge never needs to capture events.

Background dressing:

- **Wall:** cream `#f4f0e4` + an inline-SVG fractal-noise plaster grain tile (140×140) + a warm light pool `radial-gradient` at 50% 30%.
- **Room vignette** (`body::after`): white glow at top, soft brown-darkening at edges.
- **Wall arcs:** two huge dashed circles (sage at 10% and terracotta at 9% opacity) peeking from above — faint great-circle route arcs behind the badge (`.scene::before/::after`).

---

## Art direction

### Palette

Design tokens (`:root`):

| Token | Hex | Use |
|---|---|---|
| `--wall` | `#f4f0e4` | wall cream |
| `--ink` | `#1d1a14` | primary ink |
| `--ink2` | `#45423a` | secondary ink |
| `--faint` | `#908d81` | captions, eyebrows |
| `--hair` | `#d9d3c1` | hairline rules (always paired with a 1px white highlight below — "letterpress" rule) |
| `--accent` | `#3a5a44` | **deep sage** — booked routing, fills, primary buttons |
| `--terra` | `#b96f4b` | **terracotta** — alternates, endpoints, highlights |

Supporting material hues (not tokens): brass gradients (`#e8d29a → #6f5220` family) for hook/grommet/ring; leather browns (`#6b4c2d`, `#5a4128`) for the cord and loop. Container paint order for the deck is a fixed six-color sequence (see [Column 1](#column-1--cargo--request-size)). Cargo-state chips add amber `#c98f1f` (hazmat) and ice-blue `#4a7f9e` (reefer).

**One sanctioned off-palette element:** the containers breakdown tooltip is pure black `#0e0d0b` with cream text — noted in the CSS as "the one allowed off-palette element."

### Typography

System stacks only, in three registers:

| Register | Stack | Roles |
|---|---|---|
| Serif display | Georgia / Times | booking ID (21 px), stat numerals, calendar hero count (34 px), day-cell numerals, port codes, stepper values, price |
| Mono label | ui-monospace / SF Mono / Menlo | eyebrows, tags, rows, microtext, buttons, captions, ship hull text |
| Sans | Helvetica Neue / -apple-system | body defaults, org name |

Conventions: mono is always uppercase, tiny (5–9 px), and heavily letterspaced (`.14em`–`.34em`). Numerals that change at runtime use `font-variant-numeric: tabular-nums` so scrolling values don't jitter. Hero serif figures sit at `opacity: .94` — "slightly imperfect ink density."

### Print-craft motifs

The badge is styled as a real printed security credential, using a recurring kit of effects:

- **Guilloché** — a fan of 10 rotated ellipses in sage at 55% opacity, behind the card's mid section.
- **UV watermark** — a faint fern drawn in `#3a5a44` strokes at 6% opacity.
- **Microtext line** — 5.2 px mono repeating "MERIDIAN LINE · BOOKING REQUEST BK-2481-TC · VERIFY AT OPS.MERIDIANLINE.COM", clipped by overflow.
- **Print misregistration ghosts** — any dynamic serif numeral (`data-t` attribute) gets `::before`/`::after` duplicates in translucent red `rgba(196,84,60,.10)` and green `rgba(58,120,90,.10)`, offset ±0.6 px — cheap offset-litho misprint. Applied to the booking ID, container count, calendar count, and price.
- **Ink grain** — full-face SVG `feTurbulence` fractal-noise rect at 16% opacity, `mix-blend-mode: multiply`.
- **Rubber stamps** — the port-pair datestamps use a speckled-ink SVG filter (`feTurbulence` → `feColorMatrix` threshold → `feComposite in`) so ink coverage is distressed like a real hand stamp.
- **Holographic foil** — a 34 px circular patch on the photo frame corner: `conic-gradient` hue wheel + fine concentric rings, with a white "M", whose angle is driven live by card tilt (`--ho`).
- **Misregistration ghost outline** — the ship illustration has a terracotta outline copy offset by (0.55, 0.35) at 13% opacity.

### Material realism

- **Laminate slab:** `.edge` behind the face at `translateZ(-3px)` gives the card thickness on tilt, with a mid-strata `::before` at +1.5 px; inset shadows fake top-light/bottom-shade on the slab.
- **Laminate gloss:** `.laminate` layer at `translateZ(1px)` carries two soft diagonal sheens plus:
  - a **sweeping specular band** (`::before`, 102° gradient, white core, `mix-blend-mode: screen`, blurred 0.6 px) translated by CSS var `--sx` as the card tilts;
  - faint vertical streak texture (`::after`, 1 px repeating stripes).
- **Brass hardware:** cup-hook wall mount (plate, screw+slot, threaded stem, J-hook, ball tip — 4 gradients), grommet around the punched hole, split ring on the card — all hand-drawn SVG.
- **Contact AO:** a blurred radial darkening where the leather loop grips the card top.
- **Card shadow on the wall:** a live rounded-rect that sharpens/darkens when settled and drifts, blurs, and fades when lifted or swinging.

---

## The badge — anatomy

`#card` (332×468, 12 px radius) is a `preserve-3d` stack of five layers, back to front:

1. `.edge` — laminate slab edge.
2. `.face` — the printed face (overflow hidden, cream gradient), containing:
   - **grommet** — punched hole at top-center with brass washer.
   - **guilloché** + **fern UV** security prints.
   - **header** — container-shipping mark (SVG), `MERIDIAN LINE / PACIFIC FREIGHT SERVICE`, sage `BOOKING` tag chip.
   - `.rule` — letterpress hairline.
   - **`.mid`** — framed print + info column:
     - `.frame` — 116×118 white photo frame containing an inline-SVG **container-ship illustration** (sky/sea gradients, container stacks with corrugation ribs, hull with waterline stripe and "MERIDIAN LINE" text, aft castle, funnel, foremast with pennant, bow wave, stern wake, vignette + print grain, misregistration ghost) and the `.holo` foil patch overlapping its corner.
     - `.info` — "BOOKING REQUEST" label, serif ID `BK-2481-TC` (with misregistration ghosts), route `Singapore → Oakland`, `FCL · Trans-Pacific Service`, and a mono ledger of `Voyage ML-114E / Issued 28 FEB 2025 / Status PENDING`.
   - **`.stats`** strip (three cells, divided by hairlines):
     - *Containers* — serif `24` + generated 8×3 mini container-stack SVG; hover/focus reveals the black tooltip `DRY ×18 · REEFER ×4 · HAZMAT ×2`.
     - *Gross weight* — serif `412.6 t` + a 3 px capacity gauge (64% sage fill, terracotta needle at the read point).
     - *Earliest start* — calendar chip (`MAR` terracotta header over `14` serif) + `FRI 2025` mono caption.
   - **`.hubs`** — alternative-routing stepper: SVG map with dashed sage baseline SIN → HKG → OAK and two dashed terracotta alternates bending through BUS (above) and KHH (below); arrow markers, port nodes, mono port codes.
   - **`.micro`** — microtext line.
   - **`.bottom`** — canvas barcode (`2481 0314` caption) | hairline divider | canvas QR (`SCAN · VERIFY`).
   - **`.band`** — bottom status band: deep sage `#2c4234` with inset terracotta top edge, glowing terracotta dot, `BOOKING REQUEST — PENDING REVIEW`, trailing mark.
   - **`.grain`** — ink-grain overlay.
3. `.laminate` — gloss layer.
4. `.ao` — loop contact occlusion.
5. `.clip` — brass split ring + leather loop + keeper wrap SVG, sitting above the grommet at `translateZ(2px)`.

CSS vars on `#card`: `--sx` (specular sweep x-offset) and `--ho` (holo hue angle) — both set from JS each frame. The transform is composed in JS only (`translate3d + rotate + rotateY + rotateX`); CSS never positions the card.

---

## Generated print artwork

All deterministic via **mulberry32 PRNG** (`mulberry(seed)` in script.js) — same seed, same art, every load.

| Piece | Seed | Method |
|---|---|---|
| Barcode (118×34 canvas) | `24810314` (encodes the caption 2481 0314) | random 1–3 px bars, ~74% duty, guard bars at both ends, near-black `#16181d` |
| QR (66×66 canvas, 21×21 modules ×3 px) | `5119733` | ~44% random fill excluding finder zones; three proper 7-module finder patterns drawn on top |
| Mini container stack (badge stats) | `248114` | 8×3 grid of 6.6×5.4 rects in the five palette inks, each with a center corrugation rib |
| Container side-views (deck) | `idx*991 + i*37 + 11` | full procedural 20′ GP container — see [Column 1](#column-1--cargo--request-size) |

---

## Physics engine

Header comment in script.js summarizes the approach: *the strap is a verlet particle chain pinned to a wall peg; its last particle is welded to the clip ring on the card; the card is a free 2-DOF rigid body; the strap↔card coupling is a one-sided pin constraint (the strap can pull, never push) solved with positional dynamics and proper generalized inverse mass.*

### Bodies

- **Rope:** `N = 15` particles, segment rest length `SEG = 16 px`. Particle 0 is pinned to `ANCHOR` (the peg, `y = 62`, x animated by the split-view logic). The last particle is welded to the card's clip-ring attach point `ATT = (0, −H/2 − 27)` in card space.
- **Card:** state `{x, y, th, w}` — center position, angle, angular velocity. `MASS = 10`, `INER = M(W²+H²)/12`, gravity `G = 2500 px/s²`.

### Substep (fixed `h = 1/180 s`, ≤ 8 per frame, dt clamped to 50 ms)

1. **Forces on card:** gravity; *air currents* (two slow sine terms on vx, one on ω — the badge perpetually micro-sways when not held); if grabbed, a **critically-damped-feel spring at the grab point** (`k = 110/s², damping = 16/s`) that produces both linear force and torque via the moment arm — off-center grabs twist the card — plus "palm friction" `ω *= e^(−0.5h)` while held; exponential air drag (linear `e^(−0.12h)`, angular `e^(−0.55h)`); soft spring bounds at viewport edges (12 px margin).
2. **Predict:** explicit Euler positions/angle.
3. **Rope:** verlet integration with 0.985 damping + gravity; if the strap itself is grabbed, the grabbed particle is hard-pinned to the mouse.
4. **Constraint solve (8 iterations):**
   - re-pin particle 0;
   - distance constraints between free rope particles (pin end moves only the partner);
   - **one-sided last-segment constraint** to the card attach point: only acts when stretched (`d > SEG`). Uses the generalized inverse mass `K = (IM + cr²·II) + 1` where `cr` is the moment arm cross-product — the correction is split between the rope particle and the card's linear *and rotational* DOFs by their inverse-mass shares. This is what makes a lifted card fold the cord while a released card keeps its momentum.
   - weld rope end to the ring.
5. **Recover** card velocities from projected positions; clamp speed to 4200 px/s and ω to ±24 rad/s; give the welded end particle the ring's true velocity so the rope inherits card flings.

### Anchor movement

`stepAnchor()` glides `ANCHOR.x` toward `anchorGoal()` with cubic in-out ease (750–900 ms). The **pin moves, never the card** — the rope physically drags the badge across the wall. `anchorGoal()` keeps the peg centered in the space left of the deck columns (clamped to `W/2 + 16` minimum); when the panel is closed or in sheet mode it returns viewport center. On window resize, the whole simulation (all rope particles + card) is shifted horizontally by the anchor delta so the strap isn't yanked.

---

## Visual response (per-frame rendering)

`render()` runs after physics each rAF:

- **Pseudo-3D tilt:** the badge tips toward its velocity like a real hanging card — `rotateY = clamp(vx·0.005, ±14°) + 2°`, `rotateX = clamp(−vy·0.0025, ±8°) + 1.2°` — appended after the physics rotation in the card transform.
- **Optics:** `--sx = clamp(deg·1.6 + ry·9, ±170 px)` slides the laminate specular band; `--ho = deg·3 + ry·10` rotates the holo conic gradient.
- **Wall shadow:** offset grows with `lift` (distance above rest) and card angle; `blur = 7 + lift·0.045 + speed·0.004` (max 30); opacity falls from 0.42 toward 0.12 as it lifts/moves.
- **Hook + hint:** both translate with the anchor's offset from viewport center (mount is CSS-anchored at 50%).

`drawStrap()` renders the cord on the full-viewport canvas:

- Per-particle frame (tangent/normal); **half-width tapers near the ring** when the card twists (`hw = 4.2·(1 − 0.30·|sin(th·0.9)|·(i/(N−1))^1.6)`) — the cord reads as twisting.
- The cord body is a smooth quad-curve **ribbon** (offset left/right point lists) filled with a repeating 8 px **braided-leather canvas pattern** (rising light strands + falling dark strands over `#6b4c2d`), outlined dark.
- **Cylindrical shading:** two fixed-offset polylines — warm specular above-left, shade below-right.
- **Chevron braid wraps** alternating dark/light strokes at each particle.
- A **brass bead** (radial gradient, highlight dot) slid down near the top of the cord, and a **leather-wrap knot** (rounded rect with wrap lines and highlight) oriented along the final segment where the cord meets the split ring.
- The cord casts **its own blurred shadow** on the wall (ribbon re-filled dark, offset +9/+15, blur grows with lift).

---

## Interaction model

All input via window-level pointer events (the card is the only pass-through target in the inert scene):

| Gesture | Behavior |
|---|---|
| Press on badge (hit test in card-local space, including a 52 px halo above the card for the clip zone) | Grab at that exact card-space point — off-center grabs produce real torque via the spring. Adds `body.grabbing` (cursor). |
| Drag | Spring pulls the grab point toward the pointer; card swings, cord folds. |
| Release / fling | Card keeps linear + angular momentum; air currents resume. |
| Press on the cord (nearest rope particle within 42 px) | That particle is pinned to the mouse — drag the cord itself. |
| Quick still tap on the badge while the deck is closed (<350 ms, <7 px movement) | Reopens the deck (`setSplit(true)`). |
| Press inside `#panel` | Ignored by card physics — belongs to the panel. |
| Hover / keyboard-focus the Containers stat | Black tooltip appears (`.tip` transition). |

The hint line reads `DRAG THE BADGE · FLING IT · GRAB THE CORD`.

---

## Split view — the booking deck

`#panel.panel-deck` is a fixed right-docked flex row of two `.panel-col` sheets (cream gradient, hairline left border, long soft shadow, inner white highlight), each `clamp(330px, 32vw, 440px)` wide, full height, with an inner column layout: head / rule / scrollable questions region (`.pg-scroll`, thin scrollbar) / footer buttons pinned via `margin-top: auto`.

### Choreography

- **Auto-open:** ~1650 ms after load, `setSplit(true)` — the peg glides left over 900 ms, the badge physically swings aside on its cord, the deck slides in.
- **Deck transform states:** hidden at `translateX(calc(col-w * 2 + 40px))`; `.on.step-1` shows column 1 (deck offset by one column); `.on.step-2` at `translateX(0)` reveals both columns — CONTINUE doesn't cover col1, it **pushes it left and slides col2 in beside it**.
- **Reveal cascade:** every panel element carries `.rvl` (opacity 0, translateY 9 px); `rvlShow()` staggers `classList.add('on')` per group (head → questions → buttons) with 140–250 ms steps. Reveals replay only the first time per open (`col2Revealed` latch); afterwards they snap on.
- **Step-2 polish:** col1's button row fades/slides out and its buttons get `tabindex="-1"`; returning to step-1 restores them with a delayed ease.
- **CANCEL:** in step-2 it steps back to step-1; in step-1 it collapses the whole deck (`setSplit(false)`) — everything glides home, `.rvl.on` classes are stripped so the next open re-cascades, and a tap on the badge reopens.

### Shared deck components

- **Header:** mono eyebrow `MERIDIAN LINE · BOOKING BK-2481-TC` + right chip `01 · CARGO` (sage) or `02 · ROUTE` (terracotta `.p-tag-alt`), over a letterpress rule.
- **Question blocks (`.q`):** bold mono heading with a trailing hairline that flexes to fill, plus a smaller instruction subline (`IN TEU · 20′ EQUIVALENT UNITS`, `DRAG ACROSS DAYS`, `TAP A STAMP TO RE-ROUTE · SCROLL THE RATE`).
- **Vertical steppers (`.stepper`):** chevron buttons (`.sbtn`) above/below a serif tabular-numeral value; value is a focusable `role="spinbutton"` with `aria-valuemin/max/now`; supports **click chevrons, mouse wheel on the numeral, and ArrowUp/ArrowDown**; `cursor: ns-resize` on the value.
- **Buttons:** `.btn.ghost` (hairline outline, terracotta hover) and `.btn.go` (sage fill, lifted hover with arrow nudge, disabled at 38% opacity). Active state presses down 1 px.

---

## Column 1 · CARGO — request size

Up to **six container TYPE blocks**, added one at a time via `+ ADD NEW TYPE` (disabled at six: `— ALL SIX TYPES LISTED`); TYPE 1 appears with the load cascade, later ones pop in on double-rAF.

### Fixed paint order (per spec)

| Type | Body `--cc` | Stencil ink `--cc-ink` |
|---|---|---|
| 1 | orange `#c96a2a` | `#f5e9d2` |
| 2 | white `#e9e5d7` | `#3a352a` |
| 3 | grey `#8f918a` | `#f2ecda` |
| 4 | blue `#2f5b7e` | `#efe8d2` |
| 5 | red `#a8402f` | `#f0e6d0` |
| 6 | black `#2a2721` | `#cfc7ae` |

### Type block layout (`.ctype`)

- **Head:** `TYPE n` mono + paint swatch chip (9 px, `--cc`) + **cargo-type cycle chip** + weight stepper.
- **Cargo chip** (20 px round button): cycles DRY → HAZMAT → REEFER per block. Grey dot / amber trefoil / ice-blue snowflake — hand-drawn 12 px SVG glyphs recolored via `currentColor`, disc tinted via `data-cargo` CSS. The icon `<span>` is re-inserted each change so the pop keyframe (`cg-pop`, overshoot cubic-bezier) replays.
- **Body:** a 3×2 grid of container cells + the TEU unit-count stepper.
- **Cells light up left-to-right** as the count climbs (dimmed at opacity .24 / saturate .3 → full). Past 6 units, the last cell gains a cream `+n` overflow chip.

### Procedural container art (`containerArt(seed)`)

One 132×56 side-view 20′ GP per cell, a single SVG recolored through CSS classes driven by `--cc` with `color-mix()` shades (`cc-body/door/hi/lo/dark/hw/hw2`, stencil ink `--cc-ink` for dark colorways):

- corrugated wall (alternating light-edge/dark-crease strips), flat twin-leaf door end with gasket shadow, leaf seam, **4 locking rods** with cams + handles, 3 hinge knuckles, riveted CSC plate;
- stencils: `MLSU 2481 034`, `MAX GROSS 30 480 KG · 22G1`, `20′ GP`;
- seeded weathering: 6 scuffs/scratches, 4 rust weeps off the top rail, 2 dents;
- corner posts, black top/bottom side rails with fork pockets, 4 protruding corner castings with slotted ISO holes;
- ground-contact ellipse shadow only — no box outline.

### Stepper ranges

- Weight per unit: 50–30 000 **KG**, step 50.
- Units: 1–99 **TEU**, step 1 (drives the cell lighting).

---

## Column 2 · ROUTE — scheduling calendar

A flexible departure window — **one month block at a time** over 14 months (MAR 2025 → APR 2026), paged with ‹ › chevrons riding the month header (same `.sbtn` register; disabled at range ends; the fresh block slides in from the direction of travel, 200 ms).

- **Stat line:** big serif count of bookable days in the selected window (with misregistration ghosts; em-dash in muted `#b2ab98` when empty) + `DAY WINDOW` sage caption + range text (`14 MAR → 21 MAR` or `DRAG TO SELECT`), over a letterpress rule.
- **Grid:** Monday-first weekday row (Sunday column tinted terracotta), 7-column day cells; each day is a **26 px circle** — thin printed ring, Georgia numeral.
- **Selection:** press a bookable day and sweep — a pure **drag-select range**. Interior days fill sage (cream numeral, pop-in keyframe), the two endpoints fill terracotta, and adjacent selected circles are joined by a tinted sage band built from per-cell half-bars (`.cal-l`/`.cal-r`), suppressed at week-row edges so the strip breaks across rows.
- **Not-bookable days:** Sundays, anything before the 14 MAR earliest start, and a seeded ~15% of the rest — faint numeral, dashed ring, diagonal hatch fill. They're skipped by selection (gaps stay unpainted within a dragged range).
- **Architecture:** a **global day table** (one `{date, ok}` entry per calendar day, bookability from a seeded PRNG keyed by the date) means the committed range survives month paging; repainting any month is a pure function of `(lo, hi)`. Drag tracking uses `elementFromPoint` on pointermove (no pointer capture) so fast sweeps stay honest; `pointerup/cancel` on window ends the drag.
- The **CONFIRM BOOKING button stays disabled until a window exists** (`stat()` re-enables it).

---

## Column 2 · ROUTE — port pair & price

### Port pair map

Two **rubber datestamps** pressed onto the sheet — ink-only rings (the paper shows through), origin in sage tilted −3.5°, destination in terracotta tilted +2.5°. Each stamp: outer + double inner rings, separator dots, city name on a curved `textPath` over the top, role (ORIGIN/DESTINATION) curved under the bottom, big serif code (SIN/OAK), and a small mono date/voyage line. A **ghost misregistration ring** in the opposite ink floats behind each. All ink passes through the speckled-distress filter.

Between them: the **booked route** — a sagging dashed sage quadratic leg with an arrowhead — plus a faint dashed terracotta **alternate arc** above it, echoing the badge's hub map. Underneath, a mono ledger readout `≈ 7,320 NM · 16 DAYS`. A **miniature freighter** (hull, superstructure, funnel, three containers, wake strokes) is parked mid-voyage on the path, gently bobbing (2.8 s translateY loop).

**Tapping a stamp** (invisible circular button hit targets over each stamp — real buttons, so Enter/Space work; hover shows a faint terracotta ring):

1. The stamp **slams** — keyframes scale 1.7 → 0.93 → 1 (300 ms overshoot ease); mid-slam (~150 ms) the port text swaps, so the stamp comes down re-inked with the next port in its lane.
2. The route **redraws** with a dash-offset flick (`.pp-run`, 0.7 s).
3. The freighter **re-sails** the new path over 950 ms (`getPointAtLength` + heading rotation, cubic in-out).
4. The ledger updates: great-circle distance from a fixed NM matrix (450 NM/day, min 8 days).

Port lanes: origin cycles SIN → HKG → BUS → SHA; destination cycles OAK → LAX → SEA → VAN.

### Request price

A vertical stepper in the shared register: **USD 0–999,990, step 10**, serif tabular numerals with misregistration ghost (`data-t` refreshed on every set), `role="spinbutton"`, chevrons + wheel + arrow keys. Caption `REQUEST PRICE`.

---

## Booking confirmation flow

Pressing **CONFIRM BOOKING** (enabled only after a departure window exists):

- The button becomes `✓ BOOKING SUBMITTED`, disabled, dark sage background.
- The **badge itself updates**: the Status ledger row flips `PENDING → CONFIRMED`, and the bottom band reads `BOOKING REQUEST — CONFIRMED`. The credential and the form stay one document.

---

## Responsive strategy

| Breakpoint | Behavior |
|---|---|
| > 860 px | Full design. Column width `clamp(330px, 32vw, 440px)`. |
| ≤ 860 px | Columns narrow (`min(85vw, 400px)`), tighter padding/gaps. |
| ≤ 640 px (`SHEET_VW`) | The deck becomes a **bottom sheet**: `min(56vh, 440px)` tall, 200 vw wide, sliding up over the centered badge; step-2 pages horizontally by −100 vw. Columns become full-width pages with right hairline borders. The anchor stays at viewport center (badge remains centered above the sheet). |

---

## Accessibility

- Decorative SVG/canvas is `aria-hidden`; the badge itself has `aria-label="Cargo booking request credential — drag it, fling it"`.
- Stats carry text `aria-label`s (e.g. "24 containers — 18 dry, 4 reefer, 2 hazmat"); the containers stat is focusable (`tabindex="0"`) so the tooltip is keyboard-reachable.
- All steppers: focusable values with `role="spinbutton"` + `aria-valuemin/max/now` + arrow-key support; chevrons have `aria-label`s.
- Stamp hit targets are real `<button>`s with dynamic `aria-label`s ("Origin port — SINGAPORE SIN. Activate to change.").
- Calendar pager buttons are labelled and disabled at range ends; day cells are pointer-only (drag-select), but the range is mirrored in the stat line text.
- Consistent `:focus-visible` treatment: 0.8–0.9 px sage ring with 2–3 px offset (buttons, chips, steppers, hits).
- Step transitions manage `tabindex` on hidden button rows so focus doesn't get trapped off-screen.
- `touch-action: none` + `user-select: none` on body keep drag physics clean on touch.

---

## Key constants reference

**Physics:** card 332×468 · `MASS 10` · `INER M(W²+H²)/12` · `G 2500 px/s²` · rope `N 15` × `SEG 16 px` · attach `(0, −261)` card-space · anchor `y 62` · substep `1/180 s` (max 8/frame, dt clamp 50 ms) · 8 constraint iterations · verlet damping `0.985` · drag `e^(−0.12h)` linear / `e^(−0.55h)` angular · grab spring `k 110, c 16` · palm friction `e^(−0.5h)` · speed cap 4200 px/s · ω cap ±24 · strap grab radius 42 px · bounds margin 12 px.

**Choreography:** auto-open at **1650 ms** · split anchor glide **900 ms** · step glide **750 ms** · cubic in-out ease · rvl cascade base 320–480 ms, step 140–250 ms · stamp slam 300 ms (swap at 150 ms) · re-sail 950 ms · month slide 200 ms.

**Calendar:** 14 months (MAR 2025 → APR 2026) · earliest start 14 MAR 2025 · Sundays + seeded 15% not bookable · day count from PRNG seed `y*10000 + m*100 + day + 2481`.

**Price:** USD 0–999,990 · step 10 · default 4,820.

---

## Design rules the system obeys

1. **Move the pin, never the card.** Every layout change (open, step, resize) relocates the anchor and lets the verlet rope physically drag the badge. The card is only ever moved by physics.
2. **The strap can pull, never push.** The one-sided constraint is what makes the coupling feel like a real cord.
3. **Torque comes for free.** Forces apply at the grab point through the generalized inverse mass, so off-center grabs, flings, and swings are emergent — never scripted poses.
4. **Everything printed is seeded.** Barcode, QR, container art, weathering, and non-bookable days all come from mulberry32 — deterministic, regenerable, no assets.
5. **Repaint from state, not from elements.** The calendar's month DOM is disposable; selection lives in a global day table and painting is a pure function of `(lo, hi)`.
6. **The credential and the form are one document.** Confirming the booking re-inks the badge (status row + band), not a toast.
7. **Palette discipline.** Two inks (sage, terracotta) on cream with brass/leather hardware; exactly one off-palette element (the black tooltip), and two functional accent hues reserved for cargo semantics (amber hazmat, ice-blue reefer).
8. **Print imperfection is a feature, not noise.** Misregistration ghosts, ink grain, distressed stamp ink, 0.94 ink density, and misprint outlines are applied systematically to anything that would otherwise look digital.
9. **Letterpress rules.** Every hairline is paired with a 1 px white highlight beneath; every hard shadow sits on an inner light — paper on paper.
