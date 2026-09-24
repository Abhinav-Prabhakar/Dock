// Procedurally painted textures (no external assets): containers, hull livery, superstructure facades.
import * as THREE from 'three';
import { SHIP } from './config.js';

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const canvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
};

function toTexture(c, { srgb = true, repeat = false, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

// Height canvas (grey) -> tangent-space normal map canvas
function heightToNormal(src, strength) {
  const w = src.width, h = src.height;
  const sd = src.getContext('2d').getImageData(0, 0, w, h).data;
  const out = canvas(w, h);
  const octx = out.getContext('2d');
  const img = octx.createImageData(w, h);
  const d = img.data;
  const H = (x, y) => sd[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      d[i] = (-dx / len * 0.5 + 0.5) * 255;
      d[i + 1] = (dy / len * 0.5 + 0.5) * 255;
      d[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/* ------------------------------------------------------------------ containers */

export const ATLAS_ROWS = 8;
// Atlas row regions (u ranges, 2048 px wide): side | door end | front end | roof
export const ATLAS_REGIONS = {
  side: [0, 1280 / 2048],
  door: [1280 / 2048, 1536 / 2048],
  front: [1536 / 2048, 1792 / 2048],
  top: [1792 / 2048, 1],
};
const LOGOS = ['', 'TRITON', 'NOVA LINE', 'HELIX', 'SEAWAY', 'ORIENT', 'MERCATOR', 'ATLAS'];
const PREFIX = ['TRIU', 'NVLU', 'HLXU', 'SWYU', 'ORTU', 'MCTU', 'ATLU', 'CAXU', 'TGHU', 'SEGU'];

// Corrugation profile painter. Draws `n` trapezoidal ribs across width w (vertical ribs) into both ctxs.
function ribs(A, Hc, x, y, w, h, n, horizontal = false) {
  const p = (horizontal ? h : w) / n;
  for (let i = 0; i < n; i++) {
    const o = i * p;
    const seg = [
      [0, 0.34, 'rgba(255,255,255,0.10)', 255, 255],
      [0.34, 0.5, 'rgba(0,0,0,0.20)', 255, 40],
      [0.5, 0.84, 'rgba(0,0,0,0.07)', 40, 40],
      [0.84, 1, 'rgba(255,255,255,0.05)', 40, 255],
    ];
    for (const [a, b, col, h0, h1] of seg) {
      const s0 = o + a * p, s1 = o + b * p;
      A.fillStyle = col;
      if (horizontal) A.fillRect(x, y + s0, w, s1 - s0 + 0.5);
      else A.fillRect(x + s0, y, s1 - s0 + 0.5, h);
      const g = horizontal ? Hc.createLinearGradient(0, y + s0, 0, y + s1) : Hc.createLinearGradient(x + s0, 0, x + s1, 0);
      g.addColorStop(0, `rgb(${h0},${h0},${h0})`);
      g.addColorStop(1, `rgb(${h1},${h1},${h1})`);
      Hc.fillStyle = g;
      if (horizontal) Hc.fillRect(x, y + s0, w, s1 - s0 + 0.5);
      else Hc.fillRect(x + s0, y, s1 - s0 + 0.5, h);
    }
  }
}

function frame(A, Hc, x, y, w, h, t, shade = 'rgba(0,0,0,0.22)') {
  A.fillStyle = shade;
  A.fillRect(x, y, w, t); A.fillRect(x, y + h - t * 1.2, w, t * 1.2);
  A.fillRect(x, y, t, h); A.fillRect(x + w - t, y, t, h);
  Hc.fillStyle = '#ffffff';
  Hc.fillRect(x, y, w, t); Hc.fillRect(x, y + h - t * 1.2, w, t * 1.2);
  Hc.fillRect(x, y, t, h); Hc.fillRect(x + w - t, y, t, h);
}

export function makeContainerAtlas(lengthM) {
  const W = 2048, RH = 256;
  const albedo = canvas(W, RH * ATLAS_ROWS);
  const mask = canvas(W, RH * ATLAS_ROWS);
  const base = canvas(W, RH);
  const height = canvas(W, RH);
  const B = base.getContext('2d');
  const Hc = height.getContext('2d');
  const pxPerM = 1280 / lengthM;
  const sx = pxPerM / (RH / 2.591); // horizontal stretch factor for undistorted text

  // ---- base row (shared by all variants)
  B.fillStyle = '#dcdcd9'; B.fillRect(0, 0, W, RH);
  Hc.fillStyle = '#808080'; Hc.fillRect(0, 0, W, RH);
  // side: ribs every ~0.28 m
  ribs(B, Hc, 0, 0, 1280, RH, Math.round(lengthM / 0.278));
  frame(B, Hc, 0, 0, 1280, RH, 11);
  B.fillStyle = 'rgba(0,0,0,0.25)'; // corner posts
  B.fillRect(0, 0, 16, RH); B.fillRect(1264, 0, 16, RH);
  // door end: two leaves, 4 locking bars
  ribs(B, Hc, 1280, 0, 256, RH, 5, true);
  frame(B, Hc, 1280, 0, 256, RH, 12);
  B.fillStyle = 'rgba(0,0,0,0.45)'; B.fillRect(1407, 8, 3, RH - 16);
  Hc.fillStyle = '#202020'; Hc.fillRect(1407, 8, 3, RH - 16);
  for (const bx of [1318, 1372, 1444, 1498]) {
    B.fillStyle = 'rgba(40,40,40,0.55)'; B.fillRect(bx, 10, 5, RH - 20);
    Hc.fillStyle = '#ffffff'; Hc.fillRect(bx, 10, 5, RH - 20);
    B.fillStyle = 'rgba(30,30,30,0.7)'; B.fillRect(bx - 6, RH * 0.55, 17, 6); // handle
    for (const hy of [26, RH - 36]) { B.fillRect(bx - 4, hy, 13, 9); }  // cam keepers
  }
  for (const hy of [30, 95, 160, 220]) { // hinges
    B.fillStyle = 'rgba(20,20,20,0.6)';
    B.fillRect(1282, hy, 9, 14); B.fillRect(1525, hy, 9, 14);
  }
  // front end
  ribs(B, Hc, 1536, 0, 256, RH, 8);
  frame(B, Hc, 1536, 0, 256, RH, 12);
  // roof: shallow transverse dimples
  ribs(B, Hc, 1792, 0, 256, RH, Math.round(lengthM / 0.9));
  frame(B, Hc, 1792, 0, 256, RH, 6);
  // corner castings
  B.fillStyle = 'rgba(0,0,0,0.35)';
  for (const [cx, cw] of [[0, 1280], [1280, 256], [1536, 256]]) {
    B.fillRect(cx, 0, 18, 16); B.fillRect(cx + cw - 18, 0, 18, 16);
    B.fillRect(cx, RH - 16, 18, 16); B.fillRect(cx + cw - 18, RH - 16, 18, 16);
  }

  const A = albedo.getContext('2d');
  const M = mask.getContext('2d');
  M.fillStyle = '#fff'; M.fillRect(0, 0, W, RH * ATLAS_ROWS);

  for (let r = 0; r < ATLAS_ROWS; r++) {
    const y0 = (ATLAS_ROWS - 1 - r) * RH; // row r sits at v in [r/8, (r+1)/8] (canvas is flipped)
    const R = rng(1000 + r * 77 + Math.round(lengthM));
    A.drawImage(base, 0, y0);
    A.save(); A.beginPath(); A.rect(0, y0, W, RH); A.clip();

    // grime: darker toward the bottom, streaks from the top rail
    const g = A.createLinearGradient(0, y0, 0, y0 + RH);
    g.addColorStop(0, 'rgba(40,35,30,0.0)'); g.addColorStop(0.7, 'rgba(40,35,30,0.06)'); g.addColorStop(1, 'rgba(40,35,30,0.22)');
    A.fillStyle = g; A.fillRect(0, y0, W, RH);
    for (let i = 0; i < 40; i++) {
      const x = R() * W, len = 20 + R() * 140;
      const sg = A.createLinearGradient(0, y0 + 10, 0, y0 + 10 + len);
      sg.addColorStop(0, `rgba(30,25,20,${0.08 + R() * 0.12})`); sg.addColorStop(1, 'rgba(30,25,20,0)');
      A.fillStyle = sg; A.fillRect(x, y0 + 10, 1 + R() * 3, len);
    }
    // rust (untinted): patches near rails + runs
    const rust = (x, y, w, h, a) => {
      A.fillStyle = `rgba(${110 + R() * 40 | 0},${52 + R() * 20 | 0},${28 + R() * 10 | 0},${a})`;
      A.fillRect(x, y, w, h);
      M.fillStyle = `rgba(0,0,0,${a})`; M.fillRect(x, y, w, h);
    };
    for (let i = 0; i < 26 + r * 3; i++) {
      const x = R() * W;
      const bottom = R() < 0.6;
      const y = bottom ? y0 + RH - 14 - R() * 8 : y0 + 8 + R() * 6;
      rust(x, y, 2 + R() * 10, 2 + R() * 5, 0.25 + R() * 0.5);
      if (R() < 0.4) rust(x + R() * 3, y, 1 + R() * 2, (bottom ? -1 : 1) * (10 + R() * 50), 0.12 + R() * 0.2);
    }

    // logo on the long side (untinted white paint)
    const logo = LOGOS[r];
    if (logo) {
      const fs = logo.length > 7 ? 64 : 84;
      A.save(); M.save();
      A.translate(640, y0 + RH * 0.52); M.translate(640, y0 + RH * 0.52);
      A.scale(sx, 1); M.scale(sx, 1);
      A.font = M.font = `900 ${fs}px "Helvetica Neue", Arial, sans-serif`;
      A.textAlign = M.textAlign = 'center'; A.textBaseline = M.textBaseline = 'middle';
      A.fillStyle = 'rgba(245,245,242,0.95)'; A.fillText(logo, 0, 0);
      M.fillStyle = '#000'; M.fillText(logo, 0, 0);
      A.restore(); M.restore();
    }
    // box ID / ISO codes (side top-right and door)
    const id = `${PREFIX[(R() * PREFIX.length) | 0]} ${String((R() * 1e6) | 0).padStart(6, '0')} ${(R() * 10) | 0}`;
    const iso = lengthM > 7 ? '45G1' : '22G1';
    const txt = (s, x, y, size, scale) => {
      A.save(); M.save();
      A.translate(x, y); M.translate(x, y); A.scale(scale, 1); M.scale(scale, 1);
      A.font = M.font = `700 ${size}px Arial, sans-serif`;
      A.textAlign = M.textAlign = 'right'; A.textBaseline = M.textBaseline = 'top';
      A.fillStyle = 'rgba(240,240,236,0.9)'; A.fillText(s, 0, 0);
      M.fillStyle = '#000'; M.fillText(s, 0, 0);
      A.restore(); M.restore();
    };
    txt(id, 1240, y0 + 20, 17, sx);
    txt(iso, 1240, y0 + 40, 15, sx);
    txt(id.replace(/ /g, ''), 1520, y0 + 20, 13, 1);
    txt(iso, 1520, y0 + 36, 12, 1);
    // CSC plate on the door
    A.fillStyle = 'rgba(190,190,180,0.9)'; A.fillRect(1470, y0 + 150, 28, 18);
    M.fillStyle = '#000'; M.fillRect(1470, y0 + 150, 28, 18);
    // roof dirt
    A.fillStyle = 'rgba(50,45,40,0.12)'; A.fillRect(1792, y0, 256, RH);
    A.restore();
  }

  const normal = heightToNormal(height, 2.2);
  const map = toTexture(albedo);
  const maskTex = toTexture(mask, { srgb: false });
  const normalTex = toTexture(normal, { srgb: false });
  return { map, mask: maskTex, normal: normalTex };
}

/* ------------------------------------------------------------------ hull */

// Two stacked side paintings: top half = starboard (bow on the right), bottom half = port (bow on the left).
export function makeHullTexture(livery) {
  const { L, D, T } = SHIP;
  const W = 4096, HH = 512;
  const c = canvas(W, HH * 2);
  const g = c.getContext('2d');
  const R = rng(42);
  const pxm = W / L, pzm = HH / D;

  const side = (y0, bowRight) => {
    const X = (x) => (bowRight ? (x + L / 2) : (L / 2 - x)) * pxm;
    const Y = (z) => y0 + (D - z) * pzm;
    g.save(); g.beginPath(); g.rect(0, y0, W, HH); g.clip();
    // topside
    g.fillStyle = livery.hull; g.fillRect(0, y0, W, HH);
    // subtle vertical sheen variation (paint batches)
    for (let i = 0; i < 30; i++) {
      g.fillStyle = `rgba(${R() < 0.5 ? '255,255,255' : '0,0,0'},${0.015 + R() * 0.02})`;
      g.fillRect(R() * W, y0, 40 + R() * 300, HH);
    }
    // boot top + antifouling
    const wl = T + 0.9;
    g.fillStyle = livery.boot; g.fillRect(0, Y(wl + 0.25), W, (0.9) * pzm);
    g.fillStyle = livery.bottom; g.fillRect(0, Y(wl - 0.6), W, HH);
    // plating seams
    g.strokeStyle = 'rgba(0,0,0,0.07)'; g.lineWidth = 1;
    for (let z = 2.4; z < D; z += 2.4) { g.beginPath(); g.moveTo(0, Y(z)); g.lineTo(W, Y(z)); g.stroke(); }
    for (let x = -L / 2; x < L / 2; x += 12) { g.beginPath(); g.moveTo(X(x), y0); g.lineTo(X(x), y0 + HH); g.stroke(); }
    g.strokeStyle = 'rgba(255,255,255,0.05)';
    for (let x = -L / 2 + 1; x < L / 2; x += 12) { g.beginPath(); g.moveTo(X(x), y0); g.lineTo(X(x), Y(wl)); g.stroke(); }
    // rust / grime streaks from scuppers along the deck edge
    for (let x = -L / 2 + 4; x < L / 2 - 4; x += 3 + R() * 7) {
      const len = (1 + R() * 7) * pzm;
      const sg = g.createLinearGradient(0, y0, 0, y0 + len);
      const a = 0.08 + R() * 0.22;
      sg.addColorStop(0, `rgba(95,48,26,${a})`); sg.addColorStop(1, 'rgba(95,48,26,0)');
      g.fillStyle = sg; g.fillRect(X(x), y0 + 2, 1 + R() * 3, len);
    }
    // waterline grime band
    const wg = g.createLinearGradient(0, Y(wl + 1.8), 0, Y(wl));
    wg.addColorStop(0, 'rgba(30,35,25,0)'); wg.addColorStop(1, 'rgba(30,35,25,0.25)');
    g.fillStyle = wg; g.fillRect(0, Y(wl + 1.8), W, 1.8 * pzm);

    // anchor pocket + hawse streak
    const ax = L / 2 - 14;
    g.fillStyle = 'rgba(10,10,12,0.85)';
    g.beginPath(); g.ellipse(X(ax), Y(D - 5.5), 2.4 * pxm, 2.0 * pzm, 0, 0, Math.PI * 2); g.fill();
    const hg = g.createLinearGradient(0, Y(D - 7), 0, Y(D - 18));
    hg.addColorStop(0, 'rgba(100,50,25,0.55)'); hg.addColorStop(1, 'rgba(100,50,25,0)');
    g.fillStyle = hg; g.fillRect(X(ax) - 1.1 * pxm, Y(D - 7), 2.2 * pxm, 11 * pzm);

    // brand lettering
    g.save();
    g.fillStyle = livery.brandColor;
    g.font = `900 ${Math.round(9.5 * pzm)}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.translate(X(-8), Y(21.5));
    g.scale(1.18, 1);
    if ('letterSpacing' in g) g.letterSpacing = `${Math.round(2.5 * pxm)}px`;
    g.fillText(livery.brand, 0, 0);
    g.restore();
    // ship name near the bow
    g.fillStyle = livery.nameColor;
    g.font = `700 ${Math.round(1.7 * pzm)}px "Helvetica Neue", Arial, sans-serif`;
    g.textAlign = bowRight ? 'right' : 'left'; g.textBaseline = 'middle';
    g.fillText(SHIP.name, X(L / 2 - 22), Y(D - 3.2));
    // bow thruster mark
    const bt = X(L / 2 - 26), btz = Y(T + 3.4);
    g.strokeStyle = '#ffffff'; g.lineWidth = 3;
    g.beginPath(); g.arc(bt, btz, 1.2 * pzm, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(bt - 0.8 * pzm, btz - 0.8 * pzm); g.lineTo(bt + 0.8 * pzm, btz + 0.8 * pzm);
    g.moveTo(bt + 0.8 * pzm, btz - 0.8 * pzm); g.lineTo(bt - 0.8 * pzm, btz + 0.8 * pzm); g.stroke();
    // tug push marks
    g.lineWidth = 2;
    g.font = `700 ${Math.round(0.9 * pzm)}px Arial`; g.textAlign = 'center'; g.fillStyle = '#fff';
    for (const tx of [-L / 2 + 40, -60, 60, L / 2 - 60]) {
      g.strokeRect(X(tx) - 1.5 * pxm, Y(T + 5), 3 * pxm, 3 * pzm);
      g.fillText('TUG', X(tx), Y(T + 3.5));
    }
    // draught marks at stem, midship, stern
    g.font = `700 ${Math.round(0.55 * pzm)}px Arial`;
    for (const dx of [L / 2 - 8, 0, -L / 2 + 3]) {
      for (let z = 2; z <= 18; z += 1) {
        const lbl = z % 2 === 0 ? `${z}M` : '';
        if (lbl) g.fillText(lbl, X(dx), Y(z));
        else g.fillRect(X(dx) - 3, Y(z) - 1, 6, 2);
      }
    }
    // load line (Plimsoll) mark
    const px = X(-4), pz = Y(T + 0.2);
    g.strokeStyle = '#fff'; g.lineWidth = 2;
    g.beginPath(); g.arc(px, pz, 0.9 * pzm, 0, Math.PI * 2); g.stroke();
    g.fillRect(px - 1.3 * pzm, pz - 1, 2.6 * pzm, 2);
    g.fillRect(px + 1.8 * pzm, pz - 1.4 * pzm, 2, 2.2 * pzm);
    g.restore();
  };
  side(0, true);
  side(HH, false);
  return toTexture(c, { aniso: 16 });
}

export function makeTransomTexture(livery) {
  const c = canvas(1024, 512);
  const g = c.getContext('2d');
  g.fillStyle = livery.hull; g.fillRect(0, 0, 1024, 512);
  g.fillStyle = livery.bottom; g.fillRect(0, 470, 1024, 42);
  g.fillStyle = livery.nameColor;
  g.textAlign = 'center';
  g.font = '700 58px "Helvetica Neue", Arial, sans-serif';
  g.fillText(SHIP.name, 512, 210);
  g.font = '600 40px "Helvetica Neue", Arial, sans-serif';
  g.fillText(SHIP.port, 512, 270);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  for (let i = 0; i < 12; i++) g.fillRect(40 + i * 85, 0, 2, 512);
  return toTexture(c);
}

/* ------------------------------------------------------------------ superstructure */

// Window facade tile: 8 window bays x 8 decks = 24 m x 23.2 m. Returns albedo, emissive, roughness.
export function makeFacadeTextures(wallColor) {
  const S = 1024, cols = 8, rows = 8;
  const a = canvas(S, S), e = canvas(S, S), r = canvas(S, S);
  const A = a.getContext('2d'), E = e.getContext('2d'), Rg = r.getContext('2d');
  const R = rng(9);
  A.fillStyle = wallColor; A.fillRect(0, 0, S, S);
  E.fillStyle = '#000'; E.fillRect(0, 0, S, S);
  Rg.fillStyle = 'rgb(0,150,0)'; Rg.fillRect(0, 0, S, S);
  const cw = S / cols, rh = S / rows;
  for (let j = 0; j < rows; j++) {
    // deck line + streaking
    A.fillStyle = 'rgba(0,0,0,0.10)'; A.fillRect(0, j * rh + rh - 6, S, 6);
    const sg = A.createLinearGradient(0, j * rh + rh, 0, j * rh + rh + 50);
    sg.addColorStop(0, 'rgba(90,70,50,0.10)'); sg.addColorStop(1, 'rgba(90,70,50,0)');
    A.fillStyle = sg; A.fillRect(0, j * rh + rh, S, 50);
    for (let i = 0; i < cols; i++) {
      const x = i * cw + cw * 0.2, y = j * rh + rh * 0.3, w = cw * 0.6, h = rh * 0.42;
      A.fillStyle = 'rgba(0,0,0,0.35)'; A.fillRect(x - 3, y - 3, w + 6, h + 6);
      const gg = A.createLinearGradient(0, y, 0, y + h);
      gg.addColorStop(0, '#5a6a78'); gg.addColorStop(0.5, '#23303a'); gg.addColorStop(1, '#141b21');
      A.fillStyle = gg; A.fillRect(x, y, w, h);
      A.fillStyle = 'rgba(255,255,255,0.12)'; A.fillRect(x + w * 0.48, y, 3, h);
      Rg.fillStyle = 'rgb(0,18,0)'; Rg.fillRect(x, y, w, h);
      const lit = R();
      if (lit < 0.62) {
        const warm = R() < 0.75;
        const k = 0.55 + R() * 0.45;
        E.fillStyle = warm ? `rgba(255,${190 + R() * 30 | 0},${120 + R() * 30 | 0},${k})` : `rgba(210,230,255,${k})`;
        E.fillRect(x, y, w, h);
        // curtains / silhouettes
        if (R() < 0.4) { E.fillStyle = 'rgba(0,0,0,0.55)'; E.fillRect(x + R() * w * 0.6, y, w * (0.2 + R() * 0.3), h); }
      }
    }
  }
  return {
    map: toTexture(a, { repeat: true }),
    emissive: toTexture(e, { repeat: true }),
    roughness: toTexture(r, { srgb: false, repeat: true }),
  };
}

export function makeBridgeWindowTexture() {
  const c = canvas(512, 128), e = canvas(512, 128);
  const g = c.getContext('2d'), E = e.getContext('2d');
  g.fillStyle = '#e9e9e4'; g.fillRect(0, 0, 512, 128);
  E.fillStyle = '#000'; E.fillRect(0, 0, 512, 128);
  for (let i = 0; i < 8; i++) {
    const x = i * 64 + 4;
    const gg = g.createLinearGradient(0, 18, 0, 110);
    gg.addColorStop(0, '#6f8190'); gg.addColorStop(0.45, '#26343f'); gg.addColorStop(1, '#10161b');
    g.fillStyle = gg; g.fillRect(x, 18, 56, 92);
    E.fillStyle = 'rgba(120,170,255,0.18)'; E.fillRect(x, 60, 56, 50);
  }
  return { map: toTexture(c, { repeat: true }), emissive: toTexture(e, { repeat: true }) };
}

export function makeGlowTexture() {
  const c = canvas(128, 128);
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.15, 'rgba(255,255,255,0.6)');
  gr.addColorStop(0.4, 'rgba(255,255,255,0.12)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return toTexture(c, { srgb: false });
}

export function makeFunnelTexture(livery) {
  const c = canvas(512, 512);
  const g = c.getContext('2d');
  g.fillStyle = livery.funnel; g.fillRect(0, 0, 512, 512);
  g.fillStyle = livery.funnelTop; g.fillRect(0, 0, 512, 70);
  g.fillStyle = livery.hull; g.fillRect(0, 150, 512, 18);
  g.beginPath(); g.arc(256, 280, 70, 0, Math.PI * 2);
  g.fillStyle = livery.hull; g.fill();
  g.fillStyle = livery.funnel === livery.hull ? livery.super : livery.brandColor;
  g.font = '900 64px "Arial Black", Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(livery.brand[0], 256, 284);
  return toTexture(c);
}
