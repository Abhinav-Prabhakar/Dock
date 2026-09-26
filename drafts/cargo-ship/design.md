# Dock — Vessel View · Design Document

A four-screen port-operator console for the four-ship Dock fleet (one vessel
on screen at a time, `?vessel=VES1…VES4`; see §5.1). **Vessel** is a real-time 3D view
with an instrument HUD and a load-metrics drawer; **Stowage** is a light,
paper-textured "technical drawing" with a side-elevation profile *and* a top-down
plan, both driven by an animated crane timeline; **Statistics** is the operator's
ledger drawn as an Admiralty chart; **Model** replays the decision engine one
decision at a time on a dark "night bridge". One design language, two treatments
— dark glass over a living sea, and warm ink-on-paper for the engineering and
reporting views. All data comes from the live backend simulation (no mocks).

No image, font, or audio assets are loaded. Every texture, icon, sound, and
pixel of the ship is generated procedurally at runtime.

---

## 1. Design principles

- **Instrument first.** The UI reads like bridge equipment: uppercase micro
  labels, tabular numerals, status dots, hairline rules, and restrained colour.
  Decorative elements are always functional (a dot is a status, a gradient is a
  legend).
- **Show, don't label.** Charts draw ship silhouettes, waterlines, and weight
  bars instead of describing them. Icons are hand-drawn inline SVG strokes.
- **Physical continuity.** The 3D ship floats on the exact Gerstner field that
  is rendered; the stowage screen cross-fades from a dolly-zoomed 3D frame into
  its flat elevation so the two views feel like one continuous object.
- **Two palettes, one grammar.** Dark glass HUD and cream "paper" stowage
  share the same tokens, radii, type scale, segmented controls, and component
  shapes — only the material changes.
- **Deterministic randomness.** All texture wear, container IDs, and fill
  patterns come from seeded `mulberry32` RNG — same seed, same ship.

---

## 2. Color system

### 2.1 Dark theme (vessel screen)

CSS custom properties on `:root`:

| Token | Value | Use |
|---|---|---|
| `--glass` | `rgba(12,18,26,0.46)` | panel surfaces |
| `--glass-strong` | `rgba(12,18,26,0.66)` | tooltips, drawer tab |
| `--line` | `rgba(255,255,255,0.12)` | hairline borders |
| `--text` | `#eef3f7` | primary text |
| `--muted` | `rgba(230,238,245,0.62)` | secondary text |
| `--accent` | `#7cc4ff` | ice-blue accent |
| `--radius` | `14px` | panel corner radius |

Body background `#0b1016`. Panels are frosted glass: `blur(16px)
saturate(140%)` backdrop, 1px hairline, `0 10px 40px rgba(0,0,0,.25)` shadow.

### 2.2 Semantic status colors (canvas + UI)

| Meaning | Color |
|---|---|
| OK / nominal | `#5fe39a` (with `0 0 8-10px` glow on dots) |
| Warning | `#ffc35a` |
| Critical | `#ff6b6b` |
| Accent / waterline / selection | `#7cc4ff` |
| Canvas ink | `rgba(236,243,248,0.92)` |
| Canvas muted | `rgba(230,238,245,0.55)` |
| Canvas faint (grids) | `rgba(230,238,245,0.14)` |

### 2.3 Light theme (stowage screen)

The same grammar re-materialized as a technical drawing:

| Element | Value |
|---|---|
| Paper background | `#f3eee2` + generated 256px noise tile (α=9) + warm radial vignette (`white .35` centre → `rgba(120,95,60,.10)` edge) |
| Ink base | `rgb(43,36,25)` applied as `rgba(43,36,25,α)` everywhere (`INK`) |
| Panel surface | `rgba(255,252,244,0.72)`, `blur(14px) saturate(120%)`, border `rgba(60,46,25,0.13)`, shadow `0 10px 34px rgba(80,60,30,0.10)` |
| Primary action | solid `#2a241b` fill, cream text `#fff8ec` |
| Load (load ops) | `#1d7fe0` blue — badge bg `rgba(29,127,224,.12)`, text `#1566b5` |
| Discharge ops | `#e27820`/`#b35b12` orange — bg `rgba(226,120,32,.14)` |
| Drafting grid | `rgba(110,85,50,0.06)` 10 m grid, drawn only when zoomed in enough |
| Waterline | `rgba(44,110,170,0.55)` dashed; summer load line `rgba(200,70,60,0.35)` dotted |

### 2.4 Data colorways

- **Container liveries** (`CONTAINER_PALETTE`): 14 weighted carrier colours —
  magenta, oxide red, brick, navy, mid/light blue, light/dark grey, white,
  green, orange, teal, yellow, brown, red.
- **Cargo categories**: Dry `#8f99a3`, Reefer `#e9f3ff`, IMDG `#ff7a2f`,
  Empty `#d8d0bf`.
- **Ports of discharge** (POD mode): Rotterdam `#4f9fe6`, Hamburg `#f0913a`,
  Antwerp `#d0506a`, Felixstowe `#63c28a`, Le Havre `#a98ee6`.
- **Weight mode**: 5-stop gradient 2 t → 30 t: `#2c7bb6 → #78bedc → #ece8aa →
  #f8a858 → #d62828` (interpolated per box).
- **Ship liveries**: full hull/boot/deck/funnel/superstructure token sets —
  `magenta` (NOVA), `black` (ATLAS, cream superstructure), `blue` (MERIDIAN).

---

## 3. Typography

- Single family: `"Inter", "SF Pro Text", -apple-system, "Segoe UI", Roboto`.
- Canvas text uses `Inter` at 9–12 px, weight 600–700.
- **Micro-labels** — the signature move: `font-size: 9–11px`,
  `letter-spacing: 0.12–0.28em`, `text-transform: uppercase`, muted colour.
- **Numerals** — always `font-variant-numeric: tabular-nums` on telemetry,
  stats, KPIs, timeline times so digits never jitter.
- Hierarchy: brand 11px/700/.28em · screen title 26px/700 · sub 12px muted ·
  telemetry value 17px/600 · KPI value 19px/700/-0.01em.
- `<kbd>` chips: bordered translucent keycaps, inherit the UI font.
- Stowage theme reuses identical scale with ink-coloured text.

---

## 4. Components

### 4.1 Loader
Full-screen radial navy (`#16324d → #081018`), `DOCK` wordmark with 0.5em
tracking, 220 px progress bar with a travelling accent segment, witty status
line ("Fairing hull & loading bays…"), 1.2 s fade-out.

### 4.2 HUD header (top-left)
Brand row (glowing status dot + `DOCK` + muted `<em>` qualifier), vessel name
h1, spec subtitle, then a 5-column telemetry strip: `LABEL / tabular value /
unit` — SOG, HDG, heave, pitch, roll. Text shadow `0 1px 12px rgba(0,0,0,.45)`.

### 4.3 Panels
Glass card (`--glass`, blur, hairline, radius 14). Header row is uppercase
micro-label; body padded 12–14 px. The stowage theme uses `.lpanel` — identical
shape, cream glass.

**Right rail** (vessel screen): under the profit card, a 268 px column holding
**Stowage** then **Bookings**. Both start **collapsed** on every load. The whole
header is the toggle (`.ph-toggle`, chevron rotates −90° when closed); a
collapsed header still reports its headline figure in muted tabular text
(`3,165 TEU · 40%`, `189 booked · 19% win`). The rail's max-height tracks
`--drawer-h`, so an open panel scrolls inside it instead of running under the
metrics drawer.

**Bookings** (`#bookings-panel`): KPI trio (Booked · Win rate · Avg $/TEU,
since page load) → segmented filter **All · Customers · Won · Lost** (persisted
per viewer) → a timeline feed. Each row: a status dot on one hairline spine
(green booked, red rejected, amber declined, accent blue customer order steps;
customer dots glow), the lane in bold with a drawn arrow (`CNSHA → NLRTM`), a
muted meta line (`D24 · BK-2459-TC · 6 TEU · standard`), and on the right the
price in tabular numerals over the outcome as coloured micro-text — no pills.
New rows slide in (6 px, house ease); a customer event flashes the header and,
while collapsed, raises an accent `N new` badge. Customer rows and the fleet's
other decisions are capped separately (12 / 30) so the busy decision stream
never flushes a customer's quote out of the feed.

### 4.4 Stats / KPI cards
- `.stats`: 3-up grid of `rgba(255,255,255,0.05)` tiles — big tabular number
  over a micro-label.
- `.kpi`: label with coloured status dot · value+unit baseline pair · muted
  sub-line · 3 px progress bar animated `width .6s cubic-bezier(.2,.8,.2,1)`
  in the status colour. Optional inline SVG glyph (a rotating ship pictogram
  for trim/heel).

### 4.5 Controls
- **Buttons**: translucent `rgba(255,255,255,0.07)`, hairline border, radius
  9 px; hover lifts to `.14` + brighter border; `:active` presses down 1 px.
- **Icon buttons**: borderless, transparent, glyph-only.
- **Segmented control** (`.seg`): dark pill track, active segment is a light
  inset pill. Light variant swaps to cream-on-ink.
- **Selects**: custom chevron drawn as two `linear-gradient` triangles — no
  native appearance.
- **Range sliders**: 3 px track, white 14 px round thumb with drop shadow.
- **Day/night toggle**: pill group, active segment is a raised light chip with
  icon + label.

### 4.6 Metrics drawer
Bottom sheet `clamp(300px, 40vh, 420px)` that hides to a 34 px lip.
Backdrop-blurred gradient + `mask-image` fade at the top edge so it dissolves
into the ocean. A floating pill `drawer-tab` (status dot · "LOAD METRICS" ·
alert count · rotating chevron) toggles it. Inside: 9-cell KPI grid + a 12-col
card row. Opening the drawer slides the bottom control bar up and shifts the
camera view-offset so the vessel stays framed.

### 4.7 Chart cards
Four canvas charts drawn DPR-aware with the semantic palette:
1. **Longitudinal distribution & strength** — deck/hold weight bars per bay,
   bending-moment (solid white) and shear-force (dashed amber) curves, red
   dashed permissible limits, hull silhouette + actual waterline under the
   axis, hover crosshair with readout.
2. **Transverse balance** — midship section, heel exaggerated ×3, port/stbd
   row weight bars (red/green), G/M markers.
3. **Stability** — semicircular GM gauge with four colour zones and a needle.
4. **Cargo mix** — donut of TEU per POD + category share bar + box-count
   footer.

### 4.8 Tooltip
Fixed glass card, `translate(14px,14px)` offset from cursor, 0.12 s fade.
Content: `BAY · ROW · TIER` slot, colour swatch, box ID, ISO type, weight,
POD + category. `.light` variant flips to cream glass + ink text on stowage.

### 4.9 Screen switcher
Top-centre glass pill with an animated `glider` that slides (0.5 s
cubic-bezier(.2,.8,.2,1)) to the active tab — Vessel (ship glyph) / Stowage
(grid glyph) / Statistics (bars over a swell) / Model (helm glyph). On the
paper screens (Stowage, Statistics) the pill re-materializes to cream; on Model
it deepens to a darker glass. Vessel ↔ Stowage uses the 3D dolly-zoom; the two
DOM pages (Statistics, Model) fade over whatever is underneath (0.6 s opacity +
10 px rise), and the stowage canvas is suspended/resumed rather than re-entered.

### 4.10 Stowage dock (light theme)
Bottom strip: **timeline panel** (phase badge · current move title/sub ·
`h:mm:ss` clocks · a canvas scrubber showing per-bay load/hatch/deck segments
with a playhead and hover seek label · transport buttons · 1–32× speed
segments · Follow + Sound toggles) + **row picker panel** — a midship
cross-section where each row is a proportional weight bar; click to select.

### 4.11 Operations copilot (stowage screen, `js/copilot.js`)
A side feature, never prominent: a single cream-glass `.lpanel` pill
(`✳ Copilot  /`) parked bottom-right just above the stowage dock; `/` or a
click expands it into a 344 px `.lpanel` chat (same surface, border and
blur as every light panel). Header: uppercase micro-label with the blue
(`#1566b5`) spark glyph + muted context (`Meridian Star · row 03`). The
operator's messages are solid-ink bubbles (`#2a241b` / cream text — the
primary-action treatment); replies sit on a faint ink tile with tabular
numerals; errors use the discharge orange tint. Composer is a rounded
cream field with a blue focus ring and a solid-ink send button. Opens with
the house motion (8–10 px rise, `cubic-bezier(.2,.8,.2,1)`); `Esc` closes
it (not the screen) and stowage shortcuts are ignored while typing.
Replies stream in (`/api/chat/operator/stream`, SSE) with a muted status
line while tools run ("Reading the stowage…").
Answers come from `POST /api/chat/operator` — a read-only agent over the
live stowage, fleet snapshot, booking decisions, customer orders and the
strategy comparison, told which vessel/row is on screen.

---

## 5. The 3D world

### 5.1 Ship model (`ship.js`, `textures.js`)
- **The fleet** (`config.js` `VESSELS`, matching `backend/data/calibration.py`):
  every hull, bay layout, superstructure and hydrostatic set is per vessel, and
  each ship has its own silhouette —

  | Vessel | Class | Hull | Drawn TEU | Signature |
  |---|---|---|---|---|
  | VES1 Pacific Aurora | 8,000 TEU post-Panamax | 334 × 42.8 m | 7,740 | magenta NOVA livery, two-island (bridge forward), round funnel |
  | VES2 Meridian Star | 5,500 TEU post-Panamax | 277 × 40 m | 5,346 | deep-blue MERIDIAN, island aft, twin side-by-side stacks |
  | VES3 Atlantic Pioneer | 4,000 TEU Panamax | 260 × 32.2 m | 3,650 | black ATLAS, all-aft island, tall raked funnel |
  | VES4 Coral Empress | 2,500 TEU geared feeder | 208 × 30 m | 2,212 | coral CORAL, two pedestal deck cranes, square funnel |

  Fittings were authored on a 366 × 51 × 30.2 m reference hull and scale via
  `kL/kB/kD/kT`. Switching vessel reloads the page (geometry is computed once
  at module load).
- Parametric hull: `halfBreadth(x, z)` drives a lofted mesh — parallel
  midbody, bulbous bow, transom stern, raked stem, rounded bilge. Same function
  feeds rendering, hydrostatics, and the waterline texture profile — one truth.
- **Procedural hull texture** (4096×1024, both sides in one canvas): livery
  topsides, boot top + antifouling bands, plate seams every 12 m / 2.4 m,
  scupper rust streaks, waterline grime gradient, anchor pocket + hawse wash,
  brand lettering (letter-spaced Arial Black), ship name at the bow, bow
  thruster ⊘, TUG push marks, draught marks, Plimsoll mark.
- **Container atlas** (2048×256×8 rows): corrugation ribs painted as albedo +
  a hand-built height map converted to a tangent-space normal map; door end
  with 4 locking bars/cams/hinges; corner castings; per-row carrier logo
  (TRITON, NOVA LINE, HELIX, SEAWAY, ORIENT, MERCATOR, ATLAS), ISO box IDs and
  CSC plates (untinted so tinting keeps white paint white), grime streaks and
  seeded rust.
- Superstructure facade texture tiles windows with per-room warm/cool emissive
  + curtain silhouettes; separate bridge-glass texture; funnel gets livery
  brand roundel.
- Instanced rendering per container type; per-instance `aVariant` picks an
  atlas row; a `tintMask` multiplies livery colour only onto paint, preserving
  printed white marks.

### 5.2 Ocean (`ocean.js`, `waves.js`)
- 8-component Gerstner spectrum (λ 236→12.5 m) shared verbatim between the GPU
  vertex shader and the CPU `heightAt()` used by the buoyancy solver — the
  hull literally floats on the rendered water. Waves shorter than ~4 vertex
  samples fade by LOD.
- Kelvin wake: stationary-phase ship-wave pattern from bow and stern pressure
  points, plus speed-squared bow wave piled at the stem and a shoulder trough.
- Foam from crest compression (Jacobian), spray particles, physically-based
  Fresnel/GGX shading, and a real-time planar reflection pass of ship + sky.

### 5.3 Sky (`sky.js`)
- Preetham daylight model in a fragment shader (Rayleigh + Mie), procedural
  FBM clouds with sun-lit silvering and drifting cover, plus night mode:
  starfield cells, milky-way band, moon disc with FBM maria + halo.
- One `setTime(h)` drives everything: sun colour/intensity from elevation
  stops, directional sun + moon + hemisphere lights, cloud tint, fog colour,
  exposure, bloom, and a PMREM environment regenerated when the sky changes
  meaningfully — so reflections and ambient match the hour.
- Post: `EffectComposer` → render pass → `UnrealBloomPass` (half-res) →
  output; ACES filmic tone mapping; exposure lifts ~0.5 → 0.95 at night while
  bloom strengthens for the lighting rig.

### 5.4 Motion (`physics.js`)
- Heave/pitch/roll/yaw as damped oscillators with realistic ULCV periods
  (9.5 s / 8.5 s / 23 s / 60 s). Forcing comes from sampling the Gerstner
  field across a 13×5 waterplane grid weighted by local breadth.
- The metrics engine feeds static sinkage, trim, list, and the GM-derived roll
  period back into the motion model — loading the ship visibly changes how it
  floats. Speed ramps with a 9 s time constant plus squat + stern trim.

### 5.5 Metrics (`metrics.js`)
Real naval architecture integrated from the same `halfBreadth` hull: nested
bisection for equilibrium draught/trim, waterplane inertia → BM/KM/GM with
free-surface correction, still-water shear & bending curves, SOLAS V/22
visibility, stack-weight and heavy-over-light checks, reefer plug count,
IMDG separation. Results arrive as `{level: ok|warn|crit}` alerts that colour
the whole UI.

---

## 6. Stowage screen — the paper view

- Cream canvas (`#f3eee2`) + procedural paper grain + warm vignette + a faint
  10 m drafting grid that appears only at sufficient zoom.
- The hull renders as a translucent x-ray (alpha morphs with the transition):
  ink-outline plating, dashed bulkheads, hatched "ENGINE ROOM / FORE PEAK /
  STEERING" voids, hold cargo visible through the shell. Ghost silhouettes
  show neighbouring rows' stack heights behind the selected row.
- Containers are drawn as side-elevation blocks: vertical-shade gradient,
  corrugation ticks, top/bottom rails, corner castings, door-gear hint —
  detail scales with zoom (`ppm`), ink hairline stroke, blue outline on hover.
- Labels: bay numbers below the keel line, 20' sub-bay numbers, deck/hold tier
  numbers rotated along the side, per-stack weight pills that turn amber/red
  at 85%/100% of the lashing limit.
- **Crane** (`crane.js`): black box-girder STS crane seen end-on — atmospheric
  perspective on the receding boom, blinking aviation lights, floodlight
  cones, trolley with operator cab and glass, four rigged wire ropes,
  headblock, telescopic spreader with flipper arms and twistlock LED
  indicators. Trolley depth is expressed as scale+haze receding into paper.
- **Side / Top toggle**: a `Side | Top` segmented control heads the legend panel
  (`V` toggles). The swap is a *paper wipe*: over 0.7 s the drawing folds
  slightly (y-scale 0.95) while a paper sheet fades over it, the renderer swaps at
  the midpoint when fully covered, then the sheet lifts. Pan/zoom reset on swap.
  Entering from 3D always lands on Side (it is what the dolly-zoom flattens
  into); leaving from Top first wipes back to Side.
- **Top plan** (`planview.js`): the ship lies port-side-to at the berth, bow to
  the right, quay up. World coords are `(x, −z)` so `makeView`, pan/zoom and
  crane-follow are shared with the profile. Drawn: ripple-marked water, the quay
  apron (expansion joints, twin crane rails, amber truck lane, fenders,
  bollards, mooring lines), the deck outline from the same `halfBreadth(x, D)`,
  full-width hatch-cover panels, lashing bridges, accommodation + bridge wings,
  casing + oval funnel, breakwater. Each (bay, row) cell shows the **top box
  per 20' half** as a roof (transverse corrugation, rails, castings, `×n` stack
  height at zoom) and a **cast shadow** thrown in proportion to stack height, so
  tall stacks read as tall without a legend. The selected row is a blue band with
  dashed edges; it follows the crane timeline — its hold wells show open (dark,
  top hold box dimmed) until that bay's hatch move lands, then the deck fills in.
  Other rows show as fully stowed. Click any cell to select its row; hover shows
  the top box, deck/hold counts and stack tonnes.
- **Plan crane**: portal legs on the rails, Warren-laced boom from backreach to
  outreach, machinery house, blinking tip light, trolley with cab glass,
  spreader frame with twistlock lamps (amber unlocked / green locked). The load
  hangs at the trolley with pendulum sway and a shadow whose throw grows with its
  height above the stow — the hoist reads in plan.
- **Plan** (`plan.js`): deterministic crane timeline — fetch → travel → lower
  → land → unlock → hoist → retreat per box, hatch covers between hold and
  deck stows; `stateAt(t)` is pure, so scrubbing forward/backward is exact.
  Load sway: quasi-static lag during gantry travel, then damped pendulum.

---

## 6b. Statistics — the Admiralty chart (`pages/stats.js`, `statsData.js`)

Same cream paper + grain as stowage, with a faint 60 px chart grid. Every figure
is a maritime picture rather than a stock chart:
- **KPI strip** — five paper tiles, each with a small canvas glyph (Plimsoll
  mark for utilisation, etc.).
- **The regatta** — cumulative profit per policy as ships racing along their own
  wakes (Dock PPO vs heuristic + bid, heuristic, greedy, static rate card), with
  a scrubbable ship's log underneath.
- **Chart of the rotation** — portolan-style map; lane line weight = TEU moved,
  port roundels coloured by congestion.
- **Compass of demand** — compass-rose petals, area ∝ TEU by destination.
- **The locks** — request → quote → booking → delivery funnel as canal locks.
- **The yard** — every request's outcome as a stacked container yard.
- **Tide table** — daily revenue, Dock vs static, as high/low water; moon = week.
- **The fleet at sea** — each vessel riding at its real draught; stack colour =
  customer segment, bow wave = speed.
Data is seeded and synthetic (`buildStats`), shaped for a later API swap.

## 6c. Model — "Inside the helm" (`pages/model.js`, `engine.js`)

A night-bridge treatment (navy radial + 48 px blueprint grid, dark glass cards)
that replays a mocked MaskablePPO engine decision by decision. A **voyage strip**
at the top sails a small ship through eight stations — Request → Forecast → Bid
price → Observe → Policy → Mask → Act → Settle — with per-stage latency; cards
below un-dim (`.pending` → lit) as their stage is reached. Transport: play/pause
(`Space`), step (`→`), 0.5–4× speed.
- **01 · What the agent sees** — the request as a container (reefer unit, IMDG
  diamond), voyage options as leg bars coloured by bid-price pressure with
  hatched infeasibility, the harbour as buoys whose colour/blink = congestion
  and the fleet at sea, and a teal swell for the 18-slot demand forecast with a
  calendar dial. Each card is tagged with its `obs[a:b]` slice.
- **02 · How it thinks** — the 112-float observation as a colour-banded tape,
  then two hidden layers (28 of 256 units shown) and the 44-row policy head.
  Edges are *currents*: width = |weight × activation|, blue positive / red
  negative, particles drift at a speed set by strength, and a wavefront sweeps
  the forward pass. Masked rows get struck out. After acting, glowing dashed
  **attribution streams** run from the top input features through the network
  into the chosen action, listed below as signed bars.
- **03 · What it does** — **the helm**: a teak ship's wheel whose 44 spokes are
  the action space (booking / speed / reposition arcs), spoke length = π,
  masked spokes collapse to anchored stubs, and the wheel turns until the chosen
  action sits under the lubber line. Then the top-5 policy bars, a pricing
  swell (expected margin = P(accept)·(p − bid) with bid, market and guard lines;
  or the v³ fuel curve for speed orders; or empties before/after for
  repositioning), and a settlement card with a rubber-stamp outcome and chained
  ledger hash.
- **Wake** — recent decisions float astern of a ship, height = expected margin,
  dashed = customer walked; beside it, the same request priced by the baseline
  "captains" as counterfactuals.

## 7. Motion & interaction language

- Signature ease: `cubic-bezier(.2,.8,.2,1)` (drawer, glider, bars) and cubic
  in-out `x<.5 ? 4x³ : 1−(−2x+2)³/2` for scripted tweens.
- Reveals are staggered fades + 8–10 px rises; press feedback is a 1 px dip;
  hovers brighten backgrounds rather than borders.
- **Screen transition**: 2.3 s camera tween in spherical coordinates with a
  dolly-zoom (FOV 36° → 5° while distance compensates) that flattens 3D into
  the elevation; the paper view then cross-fades in as the hull morphs
  transparent. Reverse restores the saved orbit view.
- Camera: OrbitControls with damping, zoom-to-cursor, 35–4000 m range,
  polar clamp just above the water; `C` re-frames with a 1.6 s lerp.
- Day/night always animates the clock *forwards* (through dusk or dawn), with
  duration scaled by the angular distance.
- Picking: raycast on pointer-up with a 5 px click/drag tolerance;
  `Shift`+click discharges a box + anything above it, `Alt`+click stacks.
- Keyboard: `N` day/night · `M` metrics · `H` hide UI · `C` camera ·
  `Space/←/→/Home/End` transport · `↑/↓` rows · `F` follow · `S` sound ·
  `V` side/top view · `Esc` back. Model page: `Space` play/pause, `→` step.

---

## 8. Sound (`stowage/audio.js`)

Fully procedural Web Audio — no samples. Diesel-electric rumble
(sawtooth + sub-square through a tanh shaper and load-driven low-pass, pulsed
by a firing-rate LFO), inverter whine tied to hoist speed, brown-noise gantry
rail rumble, 1240 Hz travel warning beeps, twistlock clacks (bandpass noise
pairs + hydraulic hiss), landing thuds (pitch-dropping thump + steel partial
ring), and a harbour wind bed with slow gusting. One-shot events fire off the
deterministic plan timeline; a dynamics compressor glues the bus.

---

## 9. Engineering conventions

- ES modules, Three.js 0.170 via import-map CDN — zero build step, zero deps.
- Everything in metres/seconds; ship-local frame +X bow, +Y up, +Z starboard,
  waterline y=0.
- ISO 9711 bay-row-tier addressing throughout (odd bays = 20', deck tiers
  82+, hold tiers 02+).
- Seeded `mulberry32` RNG everywhere randomness appears.
- All 2D canvases are DPR-aware (`setTransform(dpr,…)`) and redraw on a
  `ResizeObserver`.
- `window.dock` exposes the live scene graph for debugging.
- URL params: `?livery=`, `?night`, `?t=`, `?screen=stowage|stats|model`,
  `?play`, `?capture`.
- DOM pages extend `Page` (`pages/page.js`): fade lifecycle, own ~30 fps RAF
  loop only while visible, DPR-aware `fit()` canvases, shared drawing
  primitives (`drawShip` pictogram, splines, seeded RNG, paper grain URL).
