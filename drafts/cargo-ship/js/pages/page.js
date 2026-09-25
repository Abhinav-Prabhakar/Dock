// Shared plumbing for the full-screen DOM pages (Statistics, Model): fade lifecycle, a throttled
// animation loop, DPR-aware canvases, seeded RNG, easing and a few drawing primitives.

export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const easeOut = (x) => 1 - Math.pow(1 - clamp(x), 3);
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const nf = (v, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const money = (v, d = 1) => `${v < 0 ? '−' : ''}$${nf(Math.abs(v) / 1e6, d)}M`;

export function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const gauss = (R) => { let u = 0; for (let i = 0; i < 4; i++) u += R(); return (u - 2) / 0.577; };

// Size a canvas to its CSS box at device pixel ratio and return a cleared 2D context in CSS pixels.
export function fit(c) {
  const r = c.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  return { g, w: r.width, h: r.height };
}

export function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// Catmull-Rom spline through points -> dense polyline.
export function spline(pts, seg = 12) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 0; s < seg; s++) {
      const t = s / seg, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Point + heading at fraction u along a polyline.
export function along(poly, u) {
  if (!poly.cum) {
    poly.cum = [0];
    for (let i = 1; i < poly.length; i++) poly.cum.push(poly.cum[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
  }
  const L = poly.cum[poly.length - 1], d = clamp(u) * L;
  let i = 1;
  while (i < poly.length - 1 && poly.cum[i] < d) i++;
  const a = poly[i - 1], b = poly[i], k = (d - poly.cum[i - 1]) / Math.max(1e-6, poly.cum[i] - poly.cum[i - 1]);
  return { x: lerp(a[0], b[0], k), y: lerp(a[1], b[1], k), a: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

// Procedural paper grain tile as a data URL (no image assets).
let grain = null;
export function grainURL(alpha = 10) {
  if (grain) return grain;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const img = g.createImageData(256, 256);
  const R = mulberry32(77);
  for (let i = 0; i < img.data.length; i += 4) { const v = R() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = alpha; }
  g.putImageData(img, 0, 0);
  return (grain = c.toDataURL());
}

// Side-elevation pictogram of a container ship, bow to the right, keel on (x, y). len in px.
// fill: 0..1 of the stack slots coloured; colors: palette cycled per stack.
export function drawShip(g, x, y, len, { hull = '#2a241b', fill = 0.8, colors = ['#1d7fe0'], house = '#f4efe4', ink = 'rgba(43,36,25,0.7)', seed = 3, bowWave = 0 } = {}) {
  const h = len * 0.1, deck = y - h;
  g.save();
  // hull
  g.beginPath();
  g.moveTo(x, deck);
  g.lineTo(x + len * 0.94, deck);
  g.quadraticCurveTo(x + len * 1.02, deck - h * 0.15, x + len, deck);
  g.quadraticCurveTo(x + len * 0.97, y, x + len * 0.86, y);
  g.lineTo(x + len * 0.06, y);
  g.quadraticCurveTo(x - len * 0.01, y - h * 0.3, x, deck);
  g.closePath();
  g.fillStyle = hull; g.fill();
  // boot top
  g.fillStyle = 'rgba(160,40,40,0.9)';
  g.fillRect(x + len * 0.05, y - h * 0.22, len * 0.84, h * 0.22);
  // stacks
  const R = mulberry32(seed);
  const bays = 13, bw = (len * 0.68) / bays, maxT = 5;
  const bh = bw * 0.52;
  let k = 0;
  for (let i = 0; i < bays; i++) {
    const bx = x + len * 0.2 + i * bw;
    const cap = i < 2 ? maxT - 2 : i > bays - 3 ? maxT - 1 : maxT;
    const n = Math.round(cap * clamp(fill + (R() - 0.5) * 0.25));
    for (let t = 0; t < n; t++) {
      g.fillStyle = colors[(k++ + Math.floor(R() * 3)) % colors.length];
      g.fillRect(bx + 0.4, deck - (t + 1) * bh + 0.4, bw - 0.8, bh - 0.8);
    }
  }
  // accommodation (aft) + funnel
  const hx = x + len * 0.08, hw = len * 0.09;
  g.fillStyle = house; g.fillRect(hx, deck - h * 2.4, hw, h * 2.4);
  g.strokeStyle = ink; g.lineWidth = 0.7; g.strokeRect(hx + 0.35, deck - h * 2.4 + 0.35, hw - 0.7, h * 2.4 - 0.7);
  g.fillStyle = ink;
  for (let r = 0; r < 4; r++) g.fillRect(hx + hw * 0.15, deck - h * 2.2 + r * h * 0.5, hw * 0.7, Math.max(0.6, h * 0.12));
  g.fillStyle = hull; g.fillRect(hx - len * 0.035, deck - h * 1.9, len * 0.03, h * 1.9);
  if (bowWave > 0) {
    g.strokeStyle = `rgba(255,255,255,${0.7 * bowWave})`; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(x + len * 0.98, y - h * 0.3); g.quadraticCurveTo(x + len * 1.06, y - h * 0.05, x + len * 1.1, y + h * 0.1); g.stroke();
  }
  g.restore();
}

// Base class: fade in/out, own RAF loop (~30 fps) while visible, resize → redraw.
export class Page {
  constructor(root) {
    this.root = root;
    this.active = false;
    this.time = 0;
    window.addEventListener('resize', () => this.active && this.draw?.(0));
  }
  show() {
    this.active = true;
    this.root.classList.add('active');
    void this.root.offsetWidth;
    this.root.classList.add('in');
    this.onShow?.();
    this.loop();
    return new Promise((r) => setTimeout(r, 650));
  }
  hide({ instant = false } = {}) {
    this.root.classList.remove('in');
    return new Promise((r) => setTimeout(r, instant ? 0 : 650)).then(() => {
      this.active = false;
      this.root.classList.remove('active');
      this.onHide?.();
    });
  }
  loop() {
    if (this.raf) return;
    let last = performance.now(), acc = 0;
    const tick = (now) => {
      if (!this.active) { this.raf = null; return; }
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now; acc += dt;
      if (acc < 1 / 32) return;
      this.time += acc;
      this.draw?.(acc);
      acc = 0;
    };
    this.raf = requestAnimationFrame(tick);
  }
}
