'use strict';
/*
 * NOVA '25 — hanging badge
 * Physics: verlet rope (lanyard) + rigid verlet body (card).
 * The rope constraints are one-sided (the strap pulls but can't push),
 * so it folds naturally when the card is lifted toward the anchor.
 * The card is a rigid triangle (clip-top + bottom corners + centre point)
 * so grabbing/flinging produces real rotation and momentum for free.
 */
(() => {

  // ---------- geometry (must match CSS) ----------
  const W = 300, H = 470, CLIP = 40;          // card size + clip overhang
  const ROPE_N = 16;                          // rope segment count
  const T  = ROPE_N;                          // attach point = clip top
  const BL = ROPE_N + 1, BR = ROPE_N + 2, CC = ROPE_N + 3;
  const ITER = 18, GRAV = 0.85, DAMP = 0.988, VMAX = 40;

  // ---------- DOM ----------
  const stage   = document.getElementById('stage');
  const badge   = document.getElementById('badge');
  const strapP  = document.getElementById('strapPath');
  const stitchP = document.getElementById('stitchPath');
  const anchorEl= document.getElementById('anchor');
  const hint    = document.getElementById('hint');
  const resetBtn= document.getElementById('reset');
  const dust    = document.getElementById('dust');
  const qr      = document.getElementById('qr');
  const barcode = document.getElementById('barcode');

  // ---------- world state ----------
  let scale = 1, stageW = 0, stageH = 0;
  let anchorX = 0, anchorY = 0, ropeLen = 200, rest = 12;
  let P = [];

  const cardCons = [
    [T,  BL, Math.hypot(W / 2, CLIP + H)],
    [T,  BR, Math.hypot(W / 2, CLIP + H)],
    [BL, BR, W],
    [T,  CC, CLIP + H / 2],
    [CC, BL, Math.hypot(W / 2, H / 2)],
    [CC, BR, Math.hypot(W / 2, H / 2)],
  ];

  function layout() {
    // The stage is viewport-sized and scaled down on small screens, so the
    // physics space is simply the element's own CSS-pixel space.
    scale = Math.min(1, innerWidth / 380, innerHeight / 760);
    stage.style.transform = `scale(${scale})`;
    stageW = innerWidth;
    stageH = innerHeight;
    const nax = stageW / 2, nay = 42;
    if (P.length) {
      const dx = nax - anchorX, dy = nay - anchorY;
      for (const p of P) { p.x += dx; p.y += dy; p.px += dx; p.py += dy; }
    }
    anchorX = nax; anchorY = nay;
    // keep the whole card inside the *visible* (post-scale) area
    ropeLen = clamp(stageH / scale - 580, 90, 230);
    rest = ropeLen / ROPE_N;
    anchorEl.style.transform = `translate(${anchorX}px, ${anchorY}px)`;
  }

  function init(offsetX) {
    P = [];
    // start as a rigid pendulum rotated by angle A (offsetX = horizontal swing)
    const pendLen = ropeLen + CLIP + H / 2;
    const A = Math.asin(clamp(offsetX / pendLen, -0.9, 0.9));
    const sx = Math.sin(A), cy = Math.cos(A);
    for (let i = 0; i <= ROPE_N; i++) {
      const x = anchorX + sx * i * rest;
      const y = anchorY + cy * i * rest;
      P.push({ x, y, px: x, py: y, pin: i === 0 });
    }
    const Tp = P[T];
    // rotate card-local offsets so the card's down-axis = (sx, cy)
    const mk = (lx, ly) => {
      const x = Tp.x + lx * cy + ly * sx;
      const y = Tp.y - lx * sx + ly * cy;
      return { x, y, px: x, py: y, pin: false };
    };
    P[BL] = mk(-W / 2, CLIP + H);
    P[BR] = mk( W / 2, CLIP + H);
    P[CC] = mk(0, CLIP + H / 2);
  }

  // ---------- solver ----------
  function solve(ai, bi, restLen, oneSided) {
    const a = P[ai], b = P[bi];
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1e-9;
    if (oneSided && d <= restLen) return;
    const diff = (d - restLen) / d;
    if (a.pin)      { b.x -= dx * diff; b.y -= dy * diff; }
    else if (b.pin) { a.x += dx * diff; a.y += dy * diff; }
    else {
      const h = diff * 0.5;
      a.x += dx * h; a.y += dy * h;
      b.x -= dx * h; b.y -= dy * h;
    }
  }

  let simT = 0;
  function step() {
    simT += 1 / 60;
    // faint ambient breeze so it never looks dead
    const wind = Math.sin(simT * 0.9) * 0.02 + Math.sin(simT * 0.31 + 1.3) * 0.014;

    for (let i = 1; i < P.length; i++) {
      const p = P[i];
      let vx = (p.x - p.px) * DAMP;
      let vy = (p.y - p.py) * DAMP;
      const s2 = vx * vx + vy * vy;
      if (s2 > VMAX * VMAX) { const s = VMAX / Math.sqrt(s2); vx *= s; vy *= s; }
      p.px = p.x; p.py = p.y;
      p.x += vx;
      p.y += vy + GRAV;
      if (i >= T) p.x += wind;
    }

    for (let k = 0; k < ITER; k++) {
      P[0].x = anchorX; P[0].y = anchorY;
      for (let i = 0; i < ROPE_N; i++) solve(i, i + 1, rest, true);  // strap: pull-only
      for (const c of cardCons) solve(c[0], c[1], c[2], false);      // card: rigid
      if (dragging && gp) {
        gp.x += (mx - gp.x) * 0.35;
        gp.y += (my - gp.y) * 0.35;
      }
    }
  }

  // ---------- render ----------
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const f1 = v => Math.round(v * 10) / 10;

  function render() {
    const Tp = P[T], blp = P[BL], brp = P[BR];
    const dx = (blp.x + brp.x) / 2 - Tp.x;
    const dy = (blp.y + brp.y) / 2 - Tp.y;
    // CSS rotate() is clockwise-positive; pendulum dx>0 (bottom swings right)
    // is counter-clockwise, hence the negated x component.
    const theta = Math.atan2(-dx, dy);

    badge.style.transform =
      `translate3d(${f1(Tp.x - W / 2)}px, ${f1(Tp.y + CLIP)}px, 0) rotate(${theta.toFixed(4)}rad)`;

    // smooth lanyard curve through the rope points
    let d = `M ${f1(P[0].x)} ${f1(P[0].y)}`;
    for (let i = 1; i < ROPE_N; i++) {
      const mx = (P[i].x + P[i + 1].x) / 2;
      const my = (P[i].y + P[i + 1].y) / 2;
      d += ` Q ${f1(P[i].x)} ${f1(P[i].y)} ${f1(mx)} ${f1(my)}`;
    }
    d += ` L ${f1(Tp.x)} ${f1(Tp.y)}`;
    strapP.setAttribute('d', d);
    stitchP.setAttribute('d', d);

    // tilt/motion-reactive lighting
    const tvx = Tp.x - Tp.px, tvy = Tp.y - Tp.py;
    const spd = Math.hypot(tvx, tvy);
    const deg = theta * 57.2958;
    badge.style.setProperty('--shx',  f1(clamp(-tvx * 2.4, -90, 90)) + 'px');
    badge.style.setProperty('--shy',  f1(30 + clamp(tvy * 1.8, -16, 55)) + 'px');
    badge.style.setProperty('--shb',  Math.round(34 + spd * 1.6) + 'px');   // tighter, crisper offset shadow
    badge.style.setProperty('--sho',  clamp(0.28 + spd * 0.007, 0.28, 0.55).toFixed(3)); // darkens as it lifts
    badge.style.setProperty('--shineA', f1(112 + deg * 1.7 + clamp(tvx * 2, -30, 30)) + 'deg');
    badge.style.setProperty('--holoP',  f1(50 + deg * 2.2 + clamp(tvx * 1.5, -40, 40)) + '%');
    badge.style.setProperty('--holoDeg', Math.round(deg * 3 + tvx * 4) + 'deg');
    badge.style.setProperty('--gl',   clamp(0.09 + spd * 0.028, 0.09, 0.6).toFixed(3));
    badge.style.setProperty('--ry',   f1(clamp(-tvx * 1.35, -18, 18)) + 'deg');
  }

  // ---------- interaction ----------
  let dragging = false, gp = null;
  let mx = 0, my = 0, pvx = 0, pvy = 0, lmx = 0, lmy = 0, lmt = 0;

  // screen px -> stage (element) px, accounting for the centered top scale
  const toStage = e => ({
    x: (e.clientX - innerWidth / 2) / scale + innerWidth / 2,
    y: e.clientY / scale,
  });

  badge.addEventListener('pointerdown', e => {
    e.preventDefault();
    dragging = true;
    badge.classList.add('grabbing');
    badge.setPointerCapture(e.pointerId);
    const p = toStage(e);
    mx = lmx = p.x; my = lmy = p.y; pvx = pvy = 0;
    lmt = performance.now();
    let best = Infinity;
    for (const i of [T, BL, BR, CC]) {
      const q = P[i];
      const dd = (q.x - mx) ** 2 + (q.y - my) ** 2;
      if (dd < best) { best = dd; gp = q; }
    }
    hint.classList.add('gone');
  });

  addEventListener('pointermove', e => {
    if (!dragging) return;
    const p = toStage(e);
    const now = performance.now();
    const dt = Math.max(1, now - lmt);
    pvx = 0.72 * pvx + 0.28 * (p.x - lmx) / dt * 16.7;
    pvy = 0.72 * pvy + 0.28 * (p.y - lmy) / dt * 16.7;
    lmx = p.x; lmy = p.y; lmt = now;
    mx = p.x; my = p.y;
  });

  function release() {
    if (!dragging) return;
    dragging = false;
    gp = null;
    badge.classList.remove('grabbing');
    // fling: inject pointer velocity into the card body
    const ax = clamp(pvx * 0.55, -28, 28);
    const ay = clamp(pvy * 0.55, -28, 28);
    for (const i of [T, BL, BR, CC]) {
      P[i].px -= ax; P[i].py -= ay;
    }
  }
  addEventListener('pointerup', release);
  addEventListener('pointercancel', release);

  resetBtn.addEventListener('click', () => init(110));
  addEventListener('resize', layout);

  // ---------- generated details ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function buildQR() {
    const M = 25, cell = 100 / M, rnd = mulberry32(20251);
    const inFinder = (x, y) => (x < 8 && y < 8) || (x >= M - 8 && y < 8) || (x < 8 && y >= M - 8);
    const onTiming = (x, y) => (y === 6 && x >= 8 && x <= M - 9) || (x === 6 && y >= 8 && y <= M - 9);
    let r = '';
    const put = (x, y) => {
      r += `<rect x="${(x * cell).toFixed(2)}" y="${(y * cell).toFixed(2)}" width="${(cell + 0.02).toFixed(2)}" height="${(cell + 0.02).toFixed(2)}"/>`;
    };
    for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
      if (inFinder(x, y)) continue;
      if (onTiming(x, y)) { if (((x + y) & 1) === 0) put(x, y); continue; }
      if (rnd() < 0.44) put(x, y);
    }
    const finder = (fx, fy) => {
      for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
        if (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4)) put(fx + x, fy + y);
      }
    };
    finder(0, 0); finder(M - 7, 0); finder(0, M - 7);
    qr.innerHTML = `<g fill="#0b0f1a">${r}</g>`;
  }

  function buildBarcode() {
    const rnd = mulberry32(777);
    let html = '';
    for (let i = 0; i < 34; i++) {
      const w = 1 + Math.floor(rnd() * 4);
      const g = 1 + Math.floor(rnd() * 3);
      html += `<i style="width:${w}px;margin-right:${g}px"></i>`;
    }
    barcode.innerHTML = html;
  }

  function buildDust() {
    const rnd = mulberry32(42);
    let html = '';
    for (let i = 0; i < 16; i++) {
      html += `<span style="left:${(rnd() * 100).toFixed(1)}%;top:${(30 + rnd() * 70).toFixed(1)}%;` +
              `width:${(1.5 + rnd() * 2.5).toFixed(1)}px;height:${(1.5 + rnd() * 2.5).toFixed(1)}px;` +
              `animation-duration:${(9 + rnd() * 14).toFixed(1)}s;animation-delay:${(-rnd() * 20).toFixed(1)}s"></span>`;
    }
    dust.innerHTML = html;
  }

  // ---------- main loop ----------
  layout();
  init(150);                 // start displaced so it swings in and settles
  buildQR(); buildBarcode(); buildDust();

  let acc = 0, last = performance.now();
  function frame(now) {
    acc += Math.min(50, now - last);
    last = now;
    while (acc >= 16.666) { step(); acc -= 16.666; }
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

})();
