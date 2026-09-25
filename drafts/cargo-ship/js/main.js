import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SHIP, LIVERIES, ENV } from './config.js';
import { WaveField } from './waves.js';
import { SkySystem } from './sky.js';
import { Ocean } from './ocean.js';
import { Ship, hullWaterlineProfile } from './ship.js';
import { Cargo } from './cargo.js';
import { ShipMotion } from './physics.js';
import { computeMetrics, staticAttitude } from './metrics.js';
import { MetricsPanel } from './metricsPanel.js';
import { COLOR_MODES, legendFor, boxColor } from './colors.js';
import { StowageView } from './stowage/view.js';
import { StatsPage } from './pages/stats.js';
import { ModelPage } from './pages/model.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

/* ------------------------------------------------------------------ renderer / scene */

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: params.has('capture') });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.5;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
$('viewport').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.5, 60000);
const DEFAULT_TARGET = new THREE.Vector3(18, 20, 0);
const DEFAULT_CAM = new THREE.Vector3(395, 78, -395); // front-left (port bow) quarter
camera.position.copy(DEFAULT_CAM);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(DEFAULT_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 35;
controls.maxDistance = 4000;
controls.maxPolarAngle = Math.PI * 0.497;
controls.zoomToCursor = true;
controls.rotateSpeed = 0.6;
controls.update();

/* ------------------------------------------------------------------ world */

const waves = new WaveField({ windDirDeg: ENV.windDirDeg, seaState: ENV.seaState });
const sky = new SkySystem(renderer, scene);
let ship, cargo, ocean, motion, metrics, panel, stowage;
const pages = {};
let render3D = true;
let screen = 'vessel';
let busy = false;
let metricsTimer = 0;

function recomputeMetrics() {
  metrics = computeMetrics(cargo, ship);
  panel.update(metrics);
  motion.setStatic(staticAttitude(metrics));
}

async function build() {
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
  ship = new Ship(params.get('livery') in LIVERIES ? params.get('livery') : 'magenta', LIVERIES);
  scene.add(ship.group);
  cargo = new Cargo(ship);
  cargo.fillAll({ seed: 2481 });
  ocean = new Ocean({ waves, hullProfile: hullWaterlineProfile(), ship });
  scene.add(ocean.mesh, ocean.spray.points);
  motion = new ShipMotion(waves);
  motion.setSpeedKnots(ENV.speedKnots);
  motion.speed = ENV.speedKnots * 0.514444;
  panel = new MetricsPanel($('metrics'), { onToggle: (open) => $('ui').classList.toggle('drawer-open', open) });
  $('ui').classList.add('drawer-open');
  recomputeMetrics();
  motion.static = { ...motion.staticTarget };
  // settle the hull before the first frame
  for (let i = 0; i < 240; i++) motion.update(1 / 30);
  stowage = new StowageView({
    root: $('stowage'), ship, cargo,
    getMetrics: () => metrics,
    getColorMode: () => cargo.colorMode,
    onColorMode: setColorMode,
    onExit: () => switchScreen('vessel'),
  });
  pages.stats = new StatsPage($('stats'));
  pages.model = new ModelPage($('model'));
  setupUI();
  onResize();
  if (params.has('night')) setTimeOfDay(ENV.nightTime);
  if (params.has('t')) setTimeOfDay(parseFloat(params.get('t')));
  renderer.compile(scene, camera);
  requestAnimationFrame(() => $('loader').classList.add('done'));
  if (params.get('screen') === 'stowage') setTimeout(() => switchScreen('stowage').then(() => params.has('play') && stowage.action('play')), 400);
  if (params.get('screen') in pages) setTimeout(() => switchScreen(params.get('screen')), 400);
  window.dock = { THREE, scene, camera, controls, renderer, ship, cargo, ocean, sky, motion, waves, stowage, pages, setTimeOfDay, goDay, goNight, switchScreen, get metrics() { return metrics; } };
  loop();
}

/* ------------------------------------------------------------------ post */

const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.15, 0.55, 1.5);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  const pr = renderer.getPixelRatio();
  bloom.setSize(w * pr * 0.5, h * pr * 0.5);
  ocean?.setSize(w * pr, h * pr, camera);
}
window.addEventListener('resize', onResize);

/* ------------------------------------------------------------------ time of day */

let tod = ENV.dayTime;
let todAnim = null;
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

function setTimeOfDay(h) {
  todAnim = null;
  tod = ((h % 24) + 24) % 24;
  sky.setTime(tod);
  syncTimeUI();
}

function animateTo(target) {
  let end = target;
  while (end <= tod) end += 24; // always run the clock forwards (through dusk or dawn)
  todAnim = { from: tod, to: end, t: 0, dur: ENV.transitionSeconds * Math.min(1.4, Math.max(0.6, (end - tod) / 8)) };
}
const goDay = () => animateTo(ENV.dayTime);
const goNight = () => animateTo(ENV.nightTime);

function syncTimeUI() {
  const hh = Math.floor(tod), mm = Math.floor((tod - hh) * 60);
  $('v-time').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  $('r-time').value = tod;
  const isNight = sky.state.night > 0.5;
  $('btn-day').classList.toggle('active', !isNight);
  $('btn-night').classList.toggle('active', isNight);
}

/* ------------------------------------------------------------------ UI */

function setupUI() {
  $('btn-day').onclick = goDay;
  $('btn-night').onclick = goNight;
  $('r-time').oninput = (e) => setTimeOfDay(parseFloat(e.target.value));
  $('r-speed').oninput = (e) => { const v = parseFloat(e.target.value); motion.setSpeedKnots(v); $('v-speed').textContent = `${v} kn`; };
  const seaNames = [[0.45, 'Calm'], [0.8, 'Slight'], [1.25, 'Moderate'], [1.8, 'Rough'], [9, 'Very rough']];
  $('r-sea').oninput = (e) => {
    const v = parseFloat(e.target.value);
    waves.setSeaState(v); ocean.syncWaves();
    $('v-sea').textContent = seaNames.find(([m]) => v <= m)[1];
  };
  $('btn-cam').onclick = resetCamera;
  $('collapse-cargo').onclick = () => $('cargo-panel').classList.toggle('collapsed');

  const bs = $('bay-select');
  bs.innerHTML = cargo.bayInfo().map((b) => `<option value="${b.bay}">Bay ${String(b.bay).padStart(2, '0')}  (20': ${b.bays20.map((n) => String(n).padStart(2, '0')).join('/')}) · ${b.rows.length} rows · ${String(b.maxDeckTier)}</option>`).join('');
  $('btn-load-bay').onclick = () => cargo.fillBay(+bs.value);
  $('btn-discharge-bay').onclick = () => cargo.clearBay(+bs.value);
  $('btn-restow').onclick = () => { cargo.clear({ hold: true }); cargo.fillAll({ seed: (Math.random() * 1e6) | 0 }); };
  $('btn-clear').onclick = () => cargo.clear();

  const ls = $('livery-select');
  ls.innerHTML = Object.entries(LIVERIES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  ls.value = ship.liveryKey;
  ls.onchange = () => ship.setLivery(ls.value);

  $('vessel-name').textContent = SHIP.name;
  const upd = (s) => {
    $('s-boxes').textContent = s.containers.toLocaleString();
    $('s-teu').textContent = s.teu.toLocaleString();
    $('s-util').textContent = `${Math.round((s.teu / s.deckCapacityTEU) * 100)}%`;
  };
  cargo.onChange((s, info) => {
    upd(s);
    if (info?.colorOnly) return;
    clearTimeout(metricsTimer);
    metricsTimer = setTimeout(recomputeMetrics, 120);
  });
  upd(cargo.stats());

  const cm = $('color-mode');
  cm.innerHTML = Object.entries(COLOR_MODES).map(([k, v]) => `<button data-m="${k}">${v.label}</button>`).join('');
  cm.querySelectorAll('button').forEach((b) => (b.onclick = () => setColorMode(b.dataset.m)));
  syncColorMode();

  document.querySelectorAll('#screen-switch button').forEach((b) => (b.onclick = () => switchScreen(b.dataset.screen)));
  requestAnimationFrame(() => placeGlider());
  window.addEventListener('resize', placeGlider);

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (screen !== 'vessel' || busy) return;
    if (e.key === 'n' || e.key === 'N') (sky.state.night > 0.5 ? goDay : goNight)();
    if (e.key === 'h' || e.key === 'H') $('ui').classList.toggle('hidden');
    if (screen !== 'vessel' || busy) return;
    if (e.key === 'c' || e.key === 'C') resetCamera();
    if (e.key === 'm' || e.key === 'M') panel.toggle();
  });
  setupPicking();
  syncTimeUI();
}

let camAnim = null;
function resetCamera() {
  camAnim = { t: 0, fromP: camera.position.clone(), fromT: controls.target.clone() };
}

/* ------------------------------------------------------------------ colour modes */

function syncColorMode() {
  const mode = cargo.colorMode;
  $('color-mode').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.m === mode));
  const lg = legendFor(mode);
  $('color-legend').innerHTML = lg.gradient
    ? `<span>${lg.range[0]} t</span><i class="grad" style="background:linear-gradient(90deg,${lg.gradient.map(([k, c]) => `${c} ${k * 100}%`).join(',')})"></i><span>${lg.range[1]} t</span>`
    : lg.items.map((i) => `<span><i style="background:${i.color}"></i>${i.label}</span>`).join('');
}

function setColorMode(mode) {
  cargo.setColorMode(mode);
  syncColorMode();
  stowage.syncMode();
}

/* ------------------------------------------------------------------ screens: vessel <-> stowage */

function placeGlider() {
  const nav = $('screen-switch');
  const b = nav.querySelector('button.active');
  const gl = nav.querySelector('.glider');
  gl.style.left = `${b.offsetLeft}px`;
  gl.style.width = `${b.offsetWidth}px`;
}

// Camera tween in spherical coordinates around a moving target, with a dolly-zoom (fov + distance)
// that keeps the apparent scale continuous — flattening the perspective into a near-orthographic elevation.
let camTween = null;
const sph = new THREE.Spherical();
function tweenCamera({ toTarget, toTheta, toPhi, toFov, toPpm, toDist, dur = 2.2 }) {
  return new Promise((resolve) => {
    const h = window.innerHeight;
    const off = camera.position.clone().sub(controls.target);
    sph.setFromVector3(off);
    const fromFov = camera.fov;
    const fromPpm = h / (2 * sph.radius * Math.tan(THREE.MathUtils.degToRad(fromFov) / 2));
    let dTheta = toTheta - sph.theta;
    dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    const endPpm = toPpm ?? h / (2 * toDist * Math.tan(THREE.MathUtils.degToRad(toFov) / 2));
    camTween = {
      t: 0, dur, resolve,
      fromTarget: controls.target.clone(), toTarget,
      theta0: sph.theta, dTheta, phi0: sph.phi, toPhi,
      fov0: fromFov, fov1: toFov, ppm0: fromPpm, ppm1: endPpm,
    };
  });
}

function stepCamTween(dt) {
  const c = camTween;
  c.t = Math.min(1, c.t + dt / c.dur);
  const k = ease(c.t);
  const h = window.innerHeight;
  const target = c.fromTarget.clone().lerp(c.toTarget, k);
  const fov = Math.exp(THREE.MathUtils.lerp(Math.log(c.fov0), Math.log(c.fov1), k));
  const ppm = Math.exp(THREE.MathUtils.lerp(Math.log(c.ppm0), Math.log(c.ppm1), k));
  const dist = h / (2 * ppm * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
  camera.fov = fov;
  camera.updateProjectionMatrix();
  sph.set(dist, THREE.MathUtils.lerp(c.phi0, c.toPhi, k), c.theta0 + c.dTheta * k);
  camera.position.setFromSpherical(sph).add(target);
  camera.lookAt(target);
  controls.target.copy(target);
  if (c.t >= 1) { camTween = null; c.resolve(); }
}

let savedView = null;
let camFlat = false; // camera parked in the broadside elevation that the stowage drawing cross-fades from
let pageZ = 35;

// Aim at the drawing's centre, offset by the hull's current sinkage so 3D and 2D line up at the cross-fade.
function flatCameraArgs(layout) {
  return { toTarget: new THREE.Vector3(layout.cx, layout.cy + ship.group.position.y, 0), toTheta: 0, toPhi: Math.PI / 2, toFov: 5, toPpm: layout.ppm };
}
function snapCamera(args) { tweenCamera({ ...args, dur: 1e-3 }); stepCamTween(1); }
function restoreCameraInstant() {
  const back = savedView || { pos: DEFAULT_CAM, target: DEFAULT_TARGET };
  camera.fov = 36; camera.updateProjectionMatrix();
  camera.position.copy(back.pos); controls.target.copy(back.target); camera.lookAt(back.target);
  camFlat = false;
}
const saveView = () => { savedView = { pos: camera.position.clone(), target: controls.target.clone(), drawer: panel.open }; };
const setMode = (m) => ['stowage', 'stats', 'model'].forEach((k) => document.body.classList.toggle(`mode-${k}`, k === m));

async function switchScreen(to) {
  if (busy || to === screen) return;
  busy = true;
  const from = screen;
  $('screen-switch').classList.add('busy');
  document.querySelectorAll('#screen-switch button').forEach((b) => b.classList.toggle('active', b.dataset.screen === to));
  placeGlider();
  $('tooltip').classList.remove('show', 'light');
  cargo.setHighlight(null);
  const toPage = pages[to], fromPage = pages[from];

  if (toPage) {
    // a DOM page fades in over whatever is showing; the screen underneath is then parked
    if (from === 'vessel') { saveView(); controls.enabled = false; $('ui').classList.add('away'); }
    toPage.root.style.zIndex = ++pageZ;
    setMode(to);
    screen = to;
    await toPage.show();
    if (from === 'vessel') render3D = false;
    if (from === 'stowage') stowage.suspend();
    if (fromPage) await fromPage.hide({ instant: true });
  } else if (fromPage) {
    screen = to;
    if (to === 'vessel') {
      if (camFlat) restoreCameraInstant();
      render3D = true; clock.getDelta();
      setMode(null);
      await fromPage.hide();
      $('ui').classList.remove('away');
      controls.enabled = true;
      controls.update();
    } else {
      // resume the drawing under the page; park the 3D camera in elevation so a later exit cross-fades cleanly
      if (!camFlat) { snapCamera(flatCameraArgs(stowage.startLayout(window.innerWidth, window.innerHeight))); camFlat = true; }
      stowage.resume();
      setMode('stowage');
      await fromPage.hide();
    }
  } else if (to === 'stowage') {
    saveView();
    controls.enabled = false;
    $('ui').classList.add('away');
    const layout = stowage.startLayout(window.innerWidth, window.innerHeight);
    await tweenCamera({ ...flatCameraArgs(layout), dur: 2.3 });
    camFlat = true;
    screen = 'stowage';
    await stowage.enter({ from: layout, onCovered: () => { render3D = false; setMode('stowage'); } });
  } else {
    await stowage.exit({ onUncover: () => { render3D = true; clock.getDelta(); setMode(null); } });
    screen = 'vessel';
    const back = savedView || { pos: DEFAULT_CAM, target: DEFAULT_TARGET };
    const off = back.pos.clone().sub(back.target);
    sph.setFromVector3(off);
    await tweenCamera({ toTarget: back.target.clone(), toTheta: sph.theta, toPhi: sph.phi, toFov: 36, toDist: sph.radius, dur: 2.3 });
    camFlat = false;
    $('ui').classList.remove('away');
    controls.enabled = true;
    controls.update();
  }
  $('screen-switch').classList.remove('busy');
  busy = false;
}

/* ------------------------------------------------------------------ picking */

function setupPicking() {
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tip = $('tooltip');
  let down = null, hoverPending = null;
  const el = renderer.domElement;
  const cast = (e) => {
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return cargo.pick(ray);
  };
  el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  el.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const hit = cast(e);
    if (!hit) return;
    const b = hit.box;
    if (e.shiftKey) cargo.removeById(b.id, { cascade: true });
    else if (e.altKey) cargo.stack(b.bayNumber, b.row, { type: b.type === '20' ? '20' : undefined });
  });
  el.addEventListener('pointermove', (e) => { hoverPending = e; });
  el.addEventListener('pointerleave', () => { hoverPending = null; tip.classList.remove('show'); cargo.setHighlight(null); });
  setInterval(() => {
    if (!hoverPending) return;
    const e = hoverPending; hoverPending = null;
    if (e.buttons) { tip.classList.remove('show'); return; }
    const hit = cast(e);
    if (!hit) { tip.classList.remove('show'); cargo.setHighlight(null); return; }
    const b = hit.box;
    cargo.setHighlight(b.id);
    const s = b.slot;
    tip.innerHTML = `<b>${s.slice(0, 2)} · ${s.slice(2, 4)} · ${s.slice(4, 6)}</b> <span class="mut">bay·row·tier</span><br>
      <span class="sw" style="background:${boxColor(b, cargo.colorMode)}"></span>${b.id} · ${b.type === '20' ? "20' GP" : b.type === '40' ? "40' GP" : "40' HC"} · ${b.weight.toFixed(1)} t<br>
      <span class="mut">${b.pod} · ${b.category}</span>`;
    tip.style.left = `${e.clientX}px`; tip.style.top = `${e.clientY}px`;
    tip.classList.add('show');
  }, 50);
}

/* ------------------------------------------------------------------ loop */

const clock = new THREE.Clock();
let elapsed = 0;
let uiTimer = 0;
let viewShift = 0;

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.1);
  elapsed += dt;

  if (todAnim) {
    todAnim.t += dt / todAnim.dur;
    const k = ease(Math.min(1, todAnim.t));
    tod = (todAnim.from + (todAnim.to - todAnim.from) * k) % 24;
    sky.setTime(tod);
    if (todAnim.t >= 1) todAnim = null;
    syncTimeUI();
  }

  if (!render3D) { motion.update(dt); return; }

  if (camAnim) {
    camAnim.t = Math.min(1, camAnim.t + dt / 1.6);
    const k = ease(camAnim.t);
    camera.position.lerpVectors(camAnim.fromP, DEFAULT_CAM, k);
    controls.target.lerpVectors(camAnim.fromT, DEFAULT_TARGET, k);
    if (camAnim.t >= 1) camAnim = null;
  }
  if (camTween) stepCamTween(dt);
  else {
    controls.update();
    if (camera.position.y < 4) camera.position.y = 4;
  }
  // keep the vessel framed above the metrics drawer
  const shiftTarget = screen === 'vessel' && !busy && panel.open && !$('ui').classList.contains('hidden') ? $('metrics').offsetHeight * 0.42 : 0;
  viewShift += (shiftTarget - viewShift) * Math.min(1, dt * 4);
  if (Math.abs(viewShift) > 0.5) camera.setViewOffset(window.innerWidth, window.innerHeight, 0, viewShift, window.innerWidth, window.innerHeight);
  else if (camera.view && camera.view.enabled) camera.clearViewOffset();

  const st = motion.update(dt);
  motion.apply(ship.group);
  const env = sky.state;
  sky.mesh.position.copy(camera.position);
  sky.update(dt, elapsed, controls.target);
  ocean.update(dt, motion.time, camera, { offset: { x: motion.distance, y: 0 }, speed: st.speed, env });
  ship.update(dt, elapsed, env, camera);

  renderer.toneMappingExposure = env.exposure;
  bloom.strength = env.bloomStrength;
  bloom.threshold = env.bloomThreshold;
  scene.fog = null;

  renderer.shadowMap.needsUpdate = true;
  ocean.renderReflection(renderer, scene, camera, [ocean.spray.points]);
  composer.render();

  uiTimer -= dt;
  if (uiTimer <= 0) {
    uiTimer = 0.15;
    $('t-sog').textContent = (st.speed / 0.514444).toFixed(1);
    $('t-hdg').textContent = String(Math.round((90 - THREE.MathUtils.radToDeg(st.yaw) + 360) % 360)).padStart(3, '0');
    $('t-heave').textContent = st.heave.toFixed(2);
    $('t-pitch').textContent = THREE.MathUtils.radToDeg(st.pitch).toFixed(2);
    $('t-roll').textContent = THREE.MathUtils.radToDeg(st.roll).toFixed(2);
  }
}

build();
