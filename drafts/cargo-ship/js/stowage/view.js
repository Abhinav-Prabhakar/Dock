// Stowage screen controller: cream technical-drawing view of one row, crane load/discharge timeline.
import { SHIP, CONTAINER_TYPES } from '../config.js';
import { Y_CARGO } from '../ship.js';
import { COLOR_MODES, legendFor, boxColor } from '../colors.js';
import { fmt } from '../cargo.js';
import { buildPlan, stateAt, describeMove, CRANE } from './plan.js';
import { makeView, drawProfile, ghostTops, drawRowPicker } from './profile.js';
import { drawCrane } from './crane.js';
import { CraneAudio } from './audio.js';

const { L, T } = SHIP;
const BG = '#f3eee2';
const SPEEDS = [1, 2, 4, 8, 16, 32];
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const clock = (s) => { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60); return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; };
const ICON = {
  start: '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 5v14M19 5l-10 7 10 7z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  end: '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M18 5v14M5 5l10 7-10 7z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  prev: '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 5l11 7-11 7z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>',
  rev: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M16 5L5 12l11 7z" fill="currentColor"/></svg>',
  sound: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  mute: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  follow: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="3.2" fill="currentColor"/><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" stroke="currentColor" stroke-width="1.6"/></svg>',
};

export class StowageView {
  constructor({ root, ship, cargo, getMetrics, getColorMode, onColorMode, onExit }) {
    Object.assign(this, { root, ship, cargo, getMetrics, getColorMode, onColorMode, onExit });
    this.audio = new CraneAudio();
    this.active = false;
    this.t = 0; this.playing = false; this.dir = 1; this.speedIdx = 3;
    this.follow = false;
    this.user = { zoom: 1, panX: 0, panY: 0 };
    this.anim = { k: 0 };
    this.row = null;
    this.prevRow = null;
    this.hoverId = null;
    this.buildDOM();
    this.paper = this.makePaper();
    window.addEventListener('resize', () => this.active && this.resize());
  }

  /* ---------------------------------------------------------------- DOM */
  buildDOM() {
    const r = this.root;
    r.innerHTML = `
      <canvas class="stow-canvas"></canvas>
      <div class="stow-ui">
        <header class="stow-hud">
          <div class="brand"><span class="dot"></span>DOCK <em>Stowage profile</em></div>
          <h1><span data-k="rowTitle">Row 01</span> <small data-k="rowSide">starboard</small></h1>
          <div class="sub">Side elevation, bow to the right · hull shown transparent</div>
          <div class="stow-stats">
            <div><label>Loaded</label><span data-k="loaded">0</span><small data-k="loadedOf">/ 0</small></div>
            <div><label>Weight</label><span data-k="tonnes">0</span><small>t</small></div>
            <div><label>TEU</label><span data-k="teu">0</span></div>
            <div><label>Crane time</label><span data-k="clock">0:00:00</span></div>
            <div><label>Rate</label><span data-k="rate">0</span><small>mph</small></div>
          </div>
        </header>
        <aside class="lpanel stow-legend">
          <div class="seg light" data-k="modes"></div>
          <div class="legend light" data-k="legend"></div>
        </aside>
        <footer class="stow-dock">
          <div class="lpanel stow-timeline">
            <div class="tl-top">
              <div class="tl-move"><span class="tl-badge" data-k="phase">Idle</span><b data-k="moveTitle">Fully loaded</b><span data-k="moveSub">Press play to replay the loading sequence</span></div>
              <div class="tl-time"><b data-k="tNow">0:00:00</b> / <span data-k="tTotal">0:00:00</span></div>
            </div>
            <canvas class="tl-track"></canvas>
            <div class="tl-controls">
              <div class="tl-buttons">
                <button data-a="start" title="Start (Home)">${ICON.start}</button>
                <button data-a="prev" title="Previous move (←)">${ICON.prev}</button>
                <button data-a="rev" title="Play in reverse — discharge">${ICON.rev}</button>
                <button data-a="play" class="primary" title="Play / pause (Space)">${ICON.play}</button>
                <button data-a="next" title="Next move (→)">${ICON.next}</button>
                <button data-a="end" title="End (End)">${ICON.end}</button>
              </div>
              <div class="seg light speed" data-k="speeds"></div>
              <div class="tl-toggles">
                <button data-a="follow" title="Follow the crane (F)">${ICON.follow}<span>Follow</span></button>
                <button data-a="sound" class="on" title="Sound (S)">${ICON.sound}</button>
              </div>
            </div>
          </div>
          <div class="lpanel stow-rows">
            <div class="rows-head"><span>Row</span><b data-k="rowBadge">01</b>
              <div class="rows-nav"><button data-a="rowPrev" title="Row to port (↑)">${ICON.prev}</button><button data-a="rowNext" title="Row to starboard (↓)">${ICON.next}</button></div>
            </div>
            <canvas class="rows-canvas"></canvas>
          </div>
        </footer>
      </div>`;
    this.canvas = r.querySelector('.stow-canvas');
    this.g = this.canvas.getContext('2d');
    this.ui = r.querySelector('.stow-ui');
    this.track = r.querySelector('.tl-track');
    this.rowsCanvas = r.querySelector('.rows-canvas');
    this.k = {};
    r.querySelectorAll('[data-k]').forEach((el) => (this.k[el.dataset.k] = el));
    this.btn = {};
    r.querySelectorAll('[data-a]').forEach((el) => { this.btn[el.dataset.a] = el; el.onclick = () => this.action(el.dataset.a); });
    this.k.speeds.innerHTML = SPEEDS.map((s, i) => `<button data-i="${i}">${s}×</button>`).join('');
    this.k.speeds.querySelectorAll('button').forEach((b) => (b.onclick = () => this.setSpeed(+b.dataset.i)));
    this.k.modes.innerHTML = Object.entries(COLOR_MODES).map(([k, v]) => `<button data-m="${k}">${v.label}</button>`).join('');
    this.k.modes.querySelectorAll('button').forEach((b) => (b.onclick = () => this.onColorMode(b.dataset.m)));
    this.setSpeed(this.speedIdx);

    // canvas interaction: hover, pan, zoom
    const c = this.canvas;
    let drag = null;
    c.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, px: this.user.panX, py: this.user.panY }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', (e) => {
      if (drag && e.buttons) {
        const v = this.view;
        this.user.panX = drag.px - (e.clientX - drag.x) / v.ppm;
        this.user.panY = drag.py + (e.clientY - drag.y) / v.ppm;
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) this.setFollow(false);
        this.hover(null);
      } else this.hover(e);
    });
    c.addEventListener('pointerup', () => (drag = null));
    c.addEventListener('pointerleave', () => this.hover(null));
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const v = this.view;
      const [wx, wy] = v.toWorld(e.clientX, e.clientY);
      const z0 = this.user.zoom;
      this.user.zoom = Math.min(8, Math.max(0.7, z0 * Math.pow(1.0015, -e.deltaY)));
      const f = z0 / this.user.zoom;
      const cx = this.base.cx + this.user.panX, cy = this.base.cy + this.user.panY;
      this.user.panX = wx - (wx - cx) * f - this.base.cx;
      this.user.panY = wy - (wy - cy) * f - this.base.cy;
    }, { passive: false });
    c.addEventListener('dblclick', () => { this.user = { zoom: 1, panX: 0, panY: 0 }; this.setFollow(false); });

    // scrubber
    const tr = this.track;
    let scrubbing = false;
    const seekFrom = (e) => { const b = tr.getBoundingClientRect(); this.seek(((e.clientX - b.left) / b.width) * this.plan.duration, true); };
    tr.addEventListener('pointerdown', (e) => { scrubbing = true; this.wasPlaying = this.playing; this.playing = false; tr.setPointerCapture(e.pointerId); this.audio.wake(); seekFrom(e); });
    tr.addEventListener('pointermove', (e) => { const b = tr.getBoundingClientRect(); this.trackHover = (e.clientX - b.left) / b.width; if (scrubbing) seekFrom(e); });
    tr.addEventListener('pointerup', () => { scrubbing = false; this.scrubbing = false; if (this.wasPlaying) this.playing = true; this.syncButtons(); });
    tr.addEventListener('pointerleave', () => (this.trackHover = null));

    // row picker
    const rc = this.rowsCanvas;
    rc.addEventListener('pointermove', (e) => { const x = e.clientX - rc.getBoundingClientRect().left; this.rowHover = this.rowHits?.find((h) => x >= h.x0 && x <= h.x1)?.row ?? null; });
    rc.addEventListener('pointerleave', () => (this.rowHover = null));
    rc.addEventListener('click', () => { if (this.rowHover != null) this.setRow(this.rowHover); });

    window.addEventListener('keydown', (e) => {
      if (!this.active || this.anim.running) return;
      const k = e.key;
      if (k === ' ') { e.preventDefault(); this.action('play'); }
      else if (k === 'ArrowLeft') this.action('prev');
      else if (k === 'ArrowRight') this.action('next');
      else if (k === 'ArrowUp') { e.preventDefault(); this.action('rowPrev'); }
      else if (k === 'ArrowDown') { e.preventDefault(); this.action('rowNext'); }
      else if (k === 'Home') this.action('start');
      else if (k === 'End') this.action('end');
      else if (k === 'f' || k === 'F') this.action('follow');
      else if (k === 's' || k === 'S') this.action('sound');
      else if (k === 'Escape') this.onExit?.();
    });
  }

  makePaper() {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    const img = g.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 9;
    }
    g.putImageData(img, 0, 0);
    return this.g.createPattern(c, 'repeat');
  }

  /* ---------------------------------------------------------------- layout */
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth; this.h = window.innerHeight;
    this.canvas.width = this.w * dpr; this.canvas.height = this.h * dpr;
    this.dpr = dpr;
    this.base = this.finalLayout();
  }

  // Layout matching the broadside 3D frame at the moment of the cross-fade.
  startLayout(w = window.innerWidth, h = window.innerHeight) {
    return { ppm: Math.min((w * 0.84) / L, (h * 0.5) / 64), cx: 0, cy: 14 };
  }

  finalLayout() {
    const w = this.w, h = this.h;
    const top = 88, bottom = h - 196;
    const y0 = -T - 9, y1 = CRANE.y + 12;
    const ppm = Math.min((w - 70) / (L + 44), (bottom - top) / (y1 - y0));
    const areaMid = (top + bottom) / 2, yMid = (y0 + y1) / 2;
    return { ppm, cx: -8, cy: yMid - (h / 2 - areaMid) / ppm };
  }

  /* ---------------------------------------------------------------- data */
  setRow(row, { instant = false } = {}) {
    if (row === this.row) return;
    const frac = this.plan ? this.t / Math.max(1, this.plan.duration) : 1;
    if (this.row != null && !instant) this.prevSnap = { boxes: this.rowBoxes, placed: this.placedIds, alpha: 1 };
    this.row = row;
    this.plan = buildPlan(this.cargo, row);
    this.t = frac * this.plan.duration;
    this.rowBoxes = [];
    this.cargo.bays.forEach((b, bi) => {
      const s = this.cargo.stackLayout(bi, row);
      for (const p of s.hold) this.rowBoxes.push({ ...p, deck: false, bayIndex: bi });
      for (const p of s.deck) this.rowBoxes.push({ ...p, deck: true, bayIndex: bi });
    });
    this.ghost = ghostTops(this.cargo, row);
    this.rowAlpha = instant ? 1 : 0;
    this.placedCount = -1;
    this.lastEventT = this.t;
    const rz = this.cargo.allRows().find((q) => q.row === row);
    this.k.rowTitle.textContent = `Row ${fmt(row)}`;
    this.k.rowBadge.textContent = fmt(row);
    this.k.rowSide.textContent = row === 0 ? 'centreline' : rz.z > 0 ? 'starboard' : 'port';
    this.k.loadedOf.textContent = `/ ${this.plan.moves.filter((m) => m.kind === 'box').length}`;
    this.rowCounts = new Map();
    for (const b of this.cargo.boxes.values()) {
      const c = this.rowCounts.get(b.row) || { deck: 0, hold: 0 };
      if (b.tier >= 80) c.deck++; else c.hold++;
      this.rowCounts.set(b.row, c);
    }
  }

  refresh() {
    // cargo changed while away: rebuild everything for the current row
    const r = this.row; this.row = null; this.setRow(r ?? this.cargo.allRows()[0].row, { instant: true });
  }

  updatePlaced() {
    const st = this.state;
    if (st.placed === this.placedCount) return;
    this.placedCount = st.placed;
    this.placedIds = new Set();
    this.hatches = new Set();
    let tonnes = 0, teu = 0, n = 0;
    for (let i = 0; i < st.placed; i++) {
      const m = this.plan.moves[i];
      if (m.kind === 'hatch') { this.hatches.add(m.bayIndex); continue; }
      this.placedIds.add(m.box.id); tonnes += m.box.weight; teu += CONTAINER_TYPES[m.box.type].teu; n++;
    }
    // stack weight tags (deck) for placed boxes in this row
    const tags = new Map();
    for (const p of this.rowBoxes) {
      if (!p.deck || !this.placedIds.has(p.box.id)) continue;
      const b = this.cargo.bays[p.bayIndex];
      const s = tags.get(b.index) || { x: b.x, top: Y_CARGO, w: 0 };
      s.w += p.box.weight; s.top = Math.max(s.top, p.y + p.h);
      tags.set(b.index, s);
    }
    this.stackTags = [...tags.values()];
    this.k.loaded.textContent = n;
    this.k.tonnes.textContent = Math.round(tonnes).toLocaleString();
    this.k.teu.textContent = teu;
  }

  /* ---------------------------------------------------------------- controls */
  action(a) {
    this.audio.wake();
    const ms = this.plan.moves;
    switch (a) {
      case 'play':
        if (this.playing && this.dir === 1) this.playing = false;
        else { if (this.t >= this.plan.duration - 0.01) this.seek(0); this.dir = 1; this.playing = true; }
        break;
      case 'rev':
        if (this.playing && this.dir === -1) this.playing = false;
        else { if (this.t <= 0.01) this.seek(this.plan.duration); this.dir = -1; this.playing = true; }
        break;
      case 'start': this.playing = false; this.seek(0); break;
      case 'end': this.playing = false; this.seek(this.plan.duration); break;
      case 'prev': {
        this.playing = false;
        const i = ms.findLastIndex((m) => m.t0 < this.t - 0.05);
        this.seek(i >= 0 ? ms[i].t0 : 0); break;
      }
      case 'next': {
        this.playing = false;
        const m = ms.find((q) => q.t0 > this.t + 0.05);
        this.seek(m ? m.t0 : this.plan.duration); break;
      }
      case 'follow': this.setFollow(!this.follow); break;
      case 'sound':
        this.audio.setEnabled(!this.audio.enabled);
        this.btn.sound.classList.toggle('on', this.audio.enabled);
        this.btn.sound.innerHTML = this.audio.enabled ? ICON.sound : ICON.mute;
        break;
      case 'rowPrev': case 'rowNext': {
        const rows = this.cargo.allRows();                      // starboard -> port
        const i = rows.findIndex((r) => r.row === this.row);
        const j = Math.min(rows.length - 1, Math.max(0, i + (a === 'rowPrev' ? 1 : -1)));
        this.setRow(rows[j].row); break;
      }
      default:
    }
    this.syncButtons();
  }

  setFollow(on) { this.follow = on; this.btn.follow.classList.toggle('on', on); if (!on) this.followZoom = null; }
  setSpeed(i) { this.speedIdx = i; this.k.speeds.querySelectorAll('button').forEach((b, j) => b.classList.toggle('active', j === i)); }
  syncButtons() {
    this.btn.play.innerHTML = this.playing && this.dir === 1 ? ICON.pause : ICON.play;
    this.btn.rev.innerHTML = this.playing && this.dir === -1 ? ICON.pause : ICON.rev;
    this.btn.rev.classList.toggle('on', this.playing && this.dir === -1);
  }

  seek(t, scrub = false) {
    this.t = Math.min(this.plan.duration, Math.max(0, t));
    this.scrubbing = scrub;
  }

  /* ---------------------------------------------------------------- lifecycle */
  enter({ from, onCovered }) {
    this.active = true;
    this.root.classList.add('active');
    this.resize();
    this.from = from;
    this.refresh();
    this.t = this.plan.duration;
    this.user = { zoom: 1, panX: 0, panY: 0 };
    this.syncMode();
    this.audio.wake();
    return this.animate(0, 1, 2600, (k) => { if (k >= 0.3 && onCovered) { onCovered(); onCovered = null; } });
  }

  exit({ onUncover } = {}) {
    this.playing = false; this.syncButtons();
    this.audio.sleep();
    this.from = this.startLayout(this.w, this.h);
    return this.animate(1, 0, 1900, (k) => { if (k <= 0.34 && onUncover) { onUncover(); onUncover = null; } })
      .then(() => { this.active = false; this.root.classList.remove('active'); });
  }

  // Park the drawing while a DOM page covers it, and bring it straight back (no 3D cross-fade).
  suspend() {
    this.playing = false; this.syncButtons();
    this.audio.sleep();
    this.hover(null);
    this.active = false;
    this.root.classList.remove('active');
  }

  resume() {
    this.active = true;
    this.root.classList.add('active');
    this.resize();
    this.refresh();
    this.anim = { k: 1, running: false };
    this.syncMode();
    this.audio.wake();
    this.loop();
  }

  animate(k0, k1, ms, onStep) {
    return new Promise((resolve) => {
      this.anim = { k: k0, running: true };
      const t0 = performance.now();
      let last = t0;
      const step = (now) => {
        const u = Math.min(1, (now - t0) / ms);
        this.anim.k = lerp(k0, k1, u);
        onStep?.(this.anim.k);
        this.frame(Math.min(0.05, (now - last) / 1000));
        last = now;
        if (u < 1) requestAnimationFrame(step);
        else { this.anim.running = false; resolve(); if (this.active && k1 === 1) this.loop(); }
      };
      requestAnimationFrame(step);
    });
  }

  loop() {
    let last = performance.now();
    const tick = (now) => {
      if (!this.active || this.anim.running) return;
      this.frame(Math.min(0.05, (now - last) / 1000));
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  syncMode() {
    const mode = this.getColorMode();
    this.k.modes.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.m === mode));
    const lg = legendFor(mode);
    this.k.legend.innerHTML = lg.gradient
      ? `<span>${lg.range[0]} t</span><i class="grad" style="background:linear-gradient(90deg,${lg.gradient.map(([k, c]) => `${c} ${k * 100}%`).join(',')})"></i><span>${lg.range[1]} t</span>`
      : lg.items.map((i) => `<span><i style="background:${i.color}"></i>${i.label}</span>`).join('');
  }

  /* ---------------------------------------------------------------- per frame */
  frame(dt) {
    const k = this.anim.k;
    // timeline
    const prevT = this.t;
    if (this.playing && !this.anim.running) {
      this.t += dt * SPEEDS[this.speedIdx] * this.dir;
      if (this.t >= this.plan.duration || this.t <= 0) { this.t = Math.min(this.plan.duration, Math.max(0, this.t)); this.playing = false; this.syncButtons(); }
    }
    const prevState = this.state;
    this.state = stateAt(this.plan, this.t);
    this.updatePlaced();
    this.sound(prevT, prevState, dt);

    if (this.prevSnap) { this.prevSnap.alpha -= dt * 4; if (this.prevSnap.alpha <= 0) this.prevSnap = null; }
    this.rowAlpha = Math.min(1, (this.rowAlpha ?? 1) + dt * 4);

    // camera: blend 3D-matching start layout -> final, then user pan/zoom and crane follow
    const mix = ease(smoothstep(0.25, 0.78, k));
    const b = this.base, f = this.from || this.startLayout();
    if (this.follow) {
      const tz = 2.6, tx = this.state.crane.x - b.cx, ty = (this.state.crane.spreaderY + 20) / 2 - b.cy;
      const a = 1 - Math.exp(-dt * 3);
      this.user.zoom = lerp(this.user.zoom, tz, a);
      this.user.panX = lerp(this.user.panX, tx, a);
      this.user.panY = lerp(this.user.panY, ty, a);
    }
    const ppm = lerp(f.ppm, b.ppm * this.user.zoom, mix);
    const cx = lerp(f.cx, b.cx + this.user.panX, mix);
    const cy = lerp(f.cy, b.cy + this.user.panY, mix);
    this.view = makeView(this.w, this.h, ppm, cx, cy);

    this.draw(k);
    this.ui.style.opacity = smoothstep(0.72, 1, k);
    this.ui.style.pointerEvents = k > 0.95 ? 'auto' : 'none';
    this.updateHUD();
  }

  sound(prevT, prevState, dt) {
    const a = this.audio;
    if (!a.ctx || !this.state) return;
    const c = this.state.crane, p = prevState?.crane;
    const rt = Math.max(dt, 1e-3);
    const hoist = p ? Math.abs(c.spreaderY - p.spreaderY) / rt : 0;
    const travel = p ? Math.abs(c.x - p.x) / rt : 0;
    const trolley = p ? Math.abs(c.depth - p.depth) / rt : 0;
    const moving = this.t !== prevT;
    const fast = Math.abs(this.t - prevT) / rt > 20;
    a.update(dt, { active: this.anim.k > 0.8 && (moving || this.playing), hoist: fast ? hoist * 0.2 : Math.min(hoist, 8), travel: fast ? 0 : travel, trolley: fast ? 0 : trolley });
    if (!moving) return;
    const lo = Math.min(prevT, this.t), hi = Math.max(prevT, this.t);
    if (hi - lo > 12) return; // big jumps: no event spam
    let fired = 0;
    for (const ev of this.plan.events) {
      if (ev.t > lo && ev.t <= hi && fired < 3) {
        a.play(ev.type, ev.m.box ? ev.m.box.weight / 22 : 1.2);
        fired++;
      }
    }
  }

  draw(k) {
    const g = this.g, v = this.view, dpr = this.dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    const bgA = smoothstep(0.02, 0.3, k);
    g.globalAlpha = bgA;
    g.fillStyle = BG; g.fillRect(0, 0, this.w, this.h);
    g.fillStyle = this.paper; g.fillRect(0, 0, this.w, this.h);
    const vg = g.createRadialGradient(this.w / 2, this.h * 0.45, this.h * 0.2, this.w / 2, this.h * 0.5, this.h);
    vg.addColorStop(0, 'rgba(255,255,255,0.35)'); vg.addColorStop(1, 'rgba(120,95,60,0.10)');
    g.fillStyle = vg; g.fillRect(0, 0, this.w, this.h);
    // drafting grid
    g.strokeStyle = 'rgba(110,85,50,0.06)'; g.lineWidth = 1;
    const step = 10 * v.ppm;
    if (step > 12) {
      const ox = v.X(0) % step, oy = v.Y(0) % step;
      g.beginPath();
      for (let x = ox; x < this.w; x += step) { g.moveTo(x, 0); g.lineTo(x, this.h); }
      for (let y = oy; y < this.h; y += step) { g.moveTo(0, y); g.lineTo(this.w, y); }
      g.stroke();
    }
    g.globalAlpha = smoothstep(0, 0.12, k);

    const livery = this.ship.liveries[this.ship.liveryKey];
    const mode = this.getColorMode();
    const hullMorph = smoothstep(0.28, 0.66, k);
    drawProfile(g, v, {
      ship: this.ship, cargo: this.cargo, livery, hullMorph,
      ghostAlpha: hullMorph, ghost: this.ghost,
      placedIds: this.placedIds, hatches: this.hatches, colorMode: mode, hoverId: this.hoverId,
      metrics: hullMorph > 0.5 ? this.getMetrics() : null,
      rowBoxes: this.rowBoxes, rowAlpha: this.rowAlpha,
      prev: this.prevSnap && { boxes: this.prevSnap.boxes.filter((p) => this.prevSnap.placed?.has(p.box.id)), alpha: this.prevSnap.alpha },
      stackTags: this.stackTags,
    });
    const st = this.state;
    const m = st.move;
    const carry = m && st.crane.carrying ? (m.kind === 'hatch' ? { len: m.len, h: m.h } : { len: m.len, h: m.h, color: boxColor(m.box, mode) }) : null;
    drawCrane(g, v, st, { carry, appear: smoothstep(0.5, 0.92, k), time: performance.now() / 1000, hatchColor: livery.hatch });
    g.globalAlpha = 1;
  }

  updateHUD() {
    const st = this.state, plan = this.plan;
    this.k.tNow.textContent = clock(this.t);
    this.k.tTotal.textContent = clock(plan.duration);
    this.k.clock.textContent = clock(this.t);
    const boxes = plan.moves.filter((q) => q.kind === 'box').length;
    this.k.rate.textContent = plan.duration ? Math.round((boxes / plan.duration) * 3600) : 0;
    const names = { fetch: 'Trolley in', travel: 'Gantry travel', lower: 'Lowering', land: 'Landing', unlock: 'Twistlocks', hoist: 'Hoisting', retreat: 'Trolley out', idle: 'Idle' };
    const d = describeMove(st.move, this.cargo);
    const loading = this.dir === 1 || !this.playing;
    this.k.phase.textContent = st.move ? (loading ? names[st.phase] : `Discharge · ${names[st.phase]}`) : this.t <= 0 ? 'Empty' : 'Complete';
    this.k.phase.className = `tl-badge ${st.move ? (loading ? 'load' : 'dis') : ''}`;
    this.k.moveTitle.textContent = d ? d.title : this.t <= 0 ? 'Row empty' : 'Row fully loaded';
    this.k.moveSub.textContent = d ? d.sub : this.t <= 0 ? 'Press play to load this row' : 'Press play to replay the loading sequence, or ◀ to discharge';
    this.drawTrack();
    this.drawRows();
  }

  drawTrack() {
    const c = this.track, dpr = this.dpr;
    const r = c.getBoundingClientRect();
    if (c.width !== Math.round(r.width * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = r.width, h = r.height, D = this.plan.duration || 1;
    g.clearRect(0, 0, w, h);
    const X = (t) => (t / D) * w;
    const ty = 14, th = 12;
    g.fillStyle = 'rgba(43,36,25,0.07)'; g.fillRect(0, ty, w, th);
    const col = { hold: 'rgba(43,36,25,0.42)', hatch: '#e2a520', deck: 'rgba(29,127,224,0.78)' };
    for (const s of this.plan.segments) {
      g.fillStyle = col[s.kind];
      g.globalAlpha = s.t1 <= this.t ? 1 : 0.35;
      g.fillRect(X(s.t0), ty, Math.max(1, X(s.t1) - X(s.t0) - 0.5), th);
    }
    g.globalAlpha = 1;
    // bay ticks + labels
    g.fillStyle = 'rgba(43,36,25,0.55)'; g.font = '600 9px Inter, sans-serif'; g.textAlign = 'left';
    let lastX = -99, lastBay = null;
    for (const s of this.plan.segments) {
      if (s.bayIndex === lastBay) continue;
      lastBay = s.bayIndex;
      const x = X(s.t0);
      g.fillRect(x, ty - 4, 1, 4);
      if (x - lastX > 26) { g.fillText(fmt(s.bay), x + 2, ty - 3); lastX = x; }
    }
    // progress + playhead
    const px = X(this.t);
    g.fillStyle = 'rgba(29,127,224,0.12)'; g.fillRect(0, ty - 2, px, th + 4);
    g.fillStyle = '#1d7fe0';
    g.fillRect(px - 1, ty - 6, 2, th + 12);
    g.beginPath(); g.arc(px, ty + th + 7, 5, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(px, ty + th + 7, 2, 0, Math.PI * 2); g.fill();
    if (this.trackHover != null) {
      const t = this.trackHover * D;
      const i = this.plan.moves.findLastIndex((m) => m.t0 <= t);
      const m = this.plan.moves[Math.max(0, i)];
      const label = `${clock(t)} · ${m ? (m.kind === 'hatch' ? `hatch ${fmt(m.bay.bay)}` : this.cargo.describe(m.box).slot) : ''}`;
      g.font = '600 10px Inter, sans-serif';
      const tw = g.measureText(label).width + 12, hx = Math.min(w - tw, Math.max(0, this.trackHover * w - tw / 2));
      g.fillStyle = 'rgba(43,36,25,0.85)'; g.fillRect(hx, ty + th + 14, tw, 16);
      g.fillStyle = '#fff'; g.fillText(label, hx + 6, ty + th + 25.5);
    }
  }

  drawRows() {
    const c = this.rowsCanvas, dpr = this.dpr;
    const r = c.getBoundingClientRect();
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.rowHits = drawRowPicker(g, r.width, r.height, this.cargo.allRows(), this.rowCounts, this.row, this.rowHover);
  }

  hover(e) {
    const tip = document.getElementById('tooltip');
    if (!e || !this.view || this.anim.running) { this.hoverId = null; tip.classList.remove('show', 'light'); return; }
    const [wx, wy] = this.view.toWorld(e.clientX, e.clientY);
    const hit = this.rowBoxes.find((p) => this.placedIds?.has(p.box.id) && Math.abs(wx - p.x) <= p.len / 2 && wy >= p.y && wy <= p.y + p.h);
    this.hoverId = hit?.box.id ?? null;
    if (!hit) { tip.classList.remove('show'); return; }
    const d = this.cargo.describe(hit.box);
    tip.innerHTML = `<b>${d.slot.slice(0, 2)} · ${d.slot.slice(2, 4)} · ${d.slot.slice(4)}</b> <span class="mut">bay·row·tier</span><br>
      <span class="sw" style="background:${boxColor(d, this.getColorMode())}"></span>${d.id} · ${CONTAINER_TYPES[d.type].label} · ${d.weight.toFixed(1)} t<br>
      <span class="mut">${d.pod} · ${d.category}${hit.deck ? ' · on deck' : ' · in hold'}</span>`;
    tip.style.left = `${e.clientX}px`; tip.style.top = `${e.clientY}px`;
    tip.classList.add('show', 'light');
  }
}
