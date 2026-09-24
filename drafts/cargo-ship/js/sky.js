// Atmosphere: Preetham daylight model + procedural clouds, stars and moon, driven by time of day.
// Also owns the sun/moon lights, image-based lighting (PMREM) and the lighting palette.
import * as THREE from 'three';

const SKY_VERT = /* glsl */`
uniform vec3 uSunDir;
uniform float uRayleigh;
uniform float uTurbidity;
uniform float uMie;
varying vec3 vWorldPosition;
varying float vSunE;
varying vec3 vBetaR;
varying vec3 vBetaM;
const float e = 2.718281828459045;
const vec3 totalRayleigh = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
const vec3 MieConst = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);
const float cutoffAngle = 1.6110731556870734;
const float steepness = 1.5;
const float EE = 1000.0;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPosition = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w;
  float zc = clamp(uSunDir.y, -1.0, 1.0);
  vSunE = EE * max(0.0, 1.0 - pow(e, -((cutoffAngle - acos(zc)) / steepness)));
  vBetaR = totalRayleigh * uRayleigh;
  vBetaM = 0.434 * (0.2 * uTurbidity) * 10E-18 * MieConst * uMie;
}`;

const SKY_FRAG = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uMieG;
uniform float uNight;
uniform float uTime;
uniform float uCloudCover;
uniform vec2 uCloudShift;
uniform vec3 uCloudSun;
uniform vec3 uCloudAmb;
uniform float uSunDisk;
varying vec3 vWorldPosition;
varying float vSunE;
varying vec3 vBetaR;
varying vec3 vBetaM;
const float pi = 3.141592653589793;
const float rayleighZenithLength = 8.4E3;
const float mieZenithLength = 1.25E3;
const float sunAngularDiameterCos = 0.99995;

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = r * p * 2.03 + 11.7; a *= 0.5; }
  return s;
}

vec3 preetham(vec3 dir) {
  vec3 up = vec3(0, 1, 0);
  float zenithAngle = acos(max(0.0, dir.y));
  float inv = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));
  vec3 Fex = exp(-(vBetaR * rayleighZenithLength * inv + vBetaM * mieZenithLength * inv));
  float cosTheta = dot(dir, uSunDir);
  float rPhase = 0.05968310365946075 * (1.0 + pow(cosTheta * 0.5 + 0.5, 2.0));
  float g2 = uMieG * uMieG;
  float mPhase = 0.07957747154594767 * ((1.0 - g2) / pow(1.0 - 2.0 * uMieG * cosTheta + g2, 1.5));
  vec3 bt = vBetaR * rPhase + vBetaM * mPhase;
  vec3 Lin = pow(vSunE * (bt / (vBetaR + vBetaM)) * (1.0 - Fex), vec3(1.5));
  Lin *= mix(vec3(1.0), pow(vSunE * (bt / (vBetaR + vBetaM)) * Fex, vec3(0.5)), clamp(pow(1.0 - uSunDir.y, 5.0), 0.0, 1.0));
  vec3 L0 = vec3(0.1) * Fex;
  float sundisk = smoothstep(sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta);
  L0 += (vSunE * 19000.0 * Fex) * sundisk * uSunDisk;
  vec3 texColor = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);
  return pow(texColor, vec3(1.0 / 2.4));
}

void main() {
  vec3 dir = normalize(vWorldPosition - cameraPosition);
  float below = smoothstep(0.0, -0.25, dir.y);
  vec3 hd = normalize(vec3(dir.x, max(dir.y, 0.0), dir.z));
  vec3 col = preetham(hd);

  // night sky: deep gradient with faint horizon glow
  float h = max(dir.y, 0.0);
  vec3 nightCol = mix(vec3(0.020, 0.030, 0.055), vec3(0.0035, 0.006, 0.016), pow(h, 0.45));
  col = mix(col, nightCol + col * 0.25, uNight);

  // moon + halo
  float md = dot(dir, uMoonDir);
  float moonR = 0.0115;
  float disk = smoothstep(cos(moonR * 1.04), cos(moonR * 0.96), md);
  vec3 mcol = vec3(0.0);
  if (disk > 0.0) {
    vec3 t1 = normalize(cross(uMoonDir, vec3(0, 1, 0)));
    vec3 t2 = cross(t1, uMoonDir);
    vec2 mp = vec2(dot(dir, t1), dot(dir, t2)) / moonR;
    float maria = fbm(mp * 2.2 + 4.0);
    float limb = sqrt(max(0.0, 1.0 - dot(mp, mp)));
    mcol = vec3(1.0, 0.97, 0.9) * (0.55 + 0.45 * limb) * (1.05 - smoothstep(0.45, 0.75, maria) * 0.45) * 3.2 * disk;
  }
  float halo = pow(max(md, 0.0), 900.0) * 0.35 + pow(max(md, 0.0), 60.0) * 0.035;
  mcol += vec3(0.75, 0.82, 1.0) * halo;

  // stars
  vec3 sp = dir * 320.0;
  vec3 cell = floor(sp);
  float sh = hash13(cell);
  float star = 0.0;
  if (sh > 0.9965) {
    vec3 c = cell + 0.5 + (vec3(hash13(cell + 1.3), hash13(cell + 7.1), hash13(cell + 3.7)) - 0.5) * 0.7;
    float d = length(sp - c);
    float mag = pow(hash13(cell + 5.5), 3.0);
    float tw = 0.75 + 0.25 * sin(uTime * (2.0 + mag * 5.0) + sh * 90.0);
    star = smoothstep(0.35 + mag * 0.25, 0.0, d) * (0.4 + mag * 3.5) * tw;
  }
  // milky way band
  float band = exp(-pow(dot(dir, normalize(vec3(0.3, 0.55, -0.78))), 2.0) * 18.0) * fbm(dir.xz * 9.0 + dir.y * 3.0);
  vec3 stars = (vec3(0.9, 0.95, 1.0) * star + vec3(0.05, 0.055, 0.07) * band) * smoothstep(0.0, 0.18, dir.y);
  col += (stars + mcol) * uNight;

  // clouds (fair-weather cumulus / cirrus on a flat layer)
  if (dir.y > 0.0 && uCloudCover > 0.0) {
    vec2 cp = dir.xz / (dir.y + 0.06);
    cp = cp * 0.55 + uCloudShift;
    float n = fbm(cp);
    float c0 = 1.0 - uCloudCover;
    float dens = smoothstep(c0, c0 + 0.28, n);
    float wisps = smoothstep(0.55, 0.9, fbm(cp * vec2(0.6, 3.0) * 1.6 + 17.0)) * 0.35;
    dens = max(dens, wisps * smoothstep(0.02, 0.25, dir.y));
    float nS = fbm(cp + uSunDir.xz * 0.12);
    float shadow = smoothstep(c0, c0 + 0.5, nS);
    float silver = pow(max(dot(dir, uSunDir), 0.0), 10.0) * (1.0 - dens) * 2.5;
    vec3 cc = uCloudSun * (1.0 - shadow * 0.55 + silver) + uCloudAmb;
    cc += vec3(0.8, 0.85, 1.0) * halo * 3.0 * uNight;
    dens *= smoothstep(0.0, 0.12, dir.y) * 0.95;
    col = mix(col, cc, dens);
  }

  // below the horizon: blend to a dark sea tone (matters for the reflection probe)
  col = mix(col, col * vec3(0.18, 0.24, 0.3), below);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const lerpColor = (stops, x) => {
  // stops: [[x, [r,g,b]], ...] ascending x
  if (x <= stops[0][0]) return stops[0][1].slice();
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const t = (x - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      return stops[i - 1][1].map((v, k) => lerp(v, stops[i][1][k], t));
    }
  }
  return stops[stops.length - 1][1].slice();
};

export class SkySystem {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDir: { value: new THREE.Vector3(-0.55, 0.16, 0.82).normalize() },
        uRayleigh: { value: 1.6 },
        uTurbidity: { value: 2.2 },
        uMie: { value: 0.004 },
        uMieG: { value: 0.82 },
        uNight: { value: 0 },
        uTime: { value: 0 },
        uCloudCover: { value: 0.34 },
        uCloudShift: { value: new THREE.Vector2() },
        uCloudSun: { value: new THREE.Color(1, 1, 1) },
        uCloudAmb: { value: new THREE.Color(0.4, 0.5, 0.6) },
        uSunDisk: { value: 1 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.material);
    this.mesh.scale.setScalar(40000);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    scene.add(this.mesh);

    // separate scene for the reflection probe
    this.envScene = new THREE.Scene();
    const envMat = this.material.clone();
    envMat.uniforms = Object.assign({}, this.material.uniforms, { uSunDisk: { value: 0.0 } });
    this.envMat = envMat;
    const envSky = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), envMat);
    envSky.scale.setScalar(100);
    this.envScene.add(envSky);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT = null;
    this.lastEnvKey = null;
    this.envTimer = 0;

    // lights
    this.sun = new THREE.DirectionalLight(0xffffff, 5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const sc = this.sun.shadow.camera;
    sc.left = -230; sc.right = 230; sc.top = 230; sc.bottom = -230; sc.near = 10; sc.far = 1600;
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.06;
    this.sun.shadow.radius = 2;
    scene.add(this.sun, this.sun.target);

    this.moon = new THREE.DirectionalLight(0x9fb4ff, 0.0);
    scene.add(this.moon, this.moon.target);

    this.hemi = new THREE.HemisphereLight(0x90a8d0, 0x0a1622, 0.0);
    scene.add(this.hemi);

    this.state = {};
    this.time = 14.5;
    this.cloudShift = new THREE.Vector2();
    this.setTime(this.time);
  }

  sunDirection(hours, out = new THREE.Vector3()) {
    // Simple solar path tuned so the default afternoon sun lights the port bow from behind the camera.
    const dayT = (hours - 6) / 12;                 // 0 at sunrise, 1 at sunset
    const elev = THREE.MathUtils.degToRad(62) * Math.sin(Math.PI * dayT);
    const az = THREE.MathUtils.degToRad(-82.5 + ((hours - 12) / 12) * 180);
    out.set(Math.cos(elev) * Math.cos(az), Math.sin(elev), Math.cos(elev) * Math.sin(az));
    return out.normalize();
  }

  setTime(hours) {
    this.time = ((hours % 24) + 24) % 24;
    const u = this.material.uniforms;
    const sunDir = this.sunDirection(this.time, u.uSunDir.value);
    const elev = THREE.MathUtils.radToDeg(Math.asin(sunDir.y));
    const night = smooth(1.5, -9, elev);
    const s = this.state;
    s.elevation = elev;
    s.night = night;
    s.lightsOn = smooth(5, -1.5, elev);
    s.sunDir = sunDir;
    s.moonDir = u.uMoonDir.value;
    u.uNight.value = night;

    // sun colour / intensity from elevation (atmospheric extinction)
    const sc = lerpColor([[-2, [1.0, 0.35, 0.12]], [2, [1.0, 0.52, 0.28]], [8, [1.0, 0.76, 0.55]], [20, [1.0, 0.9, 0.78]], [40, [1.0, 0.96, 0.9]]], elev);
    const si = 5.2 * smooth(-1.5, 6, elev) * (0.55 + 0.45 * smooth(5, 35, elev));
    this.sun.color.setRGB(sc[0], sc[1], sc[2]);
    this.sun.intensity = si;
    this.sun.visible = si > 0.001;
    s.sunColor = new THREE.Color(sc[0], sc[1], sc[2]).multiplyScalar(si);

    // moon
    this.moon.intensity = 0.28 * night;
    s.moonColor = new THREE.Color(0.62, 0.7, 1.0).multiplyScalar(0.6 * night);
    this.hemi.intensity = 0.55 * night;

    // cloud lighting
    const cs = lerpColor([[-8, [0.03, 0.035, 0.05]], [-2, [0.35, 0.16, 0.12]], [3, [1.0, 0.45, 0.25]], [10, [1.15, 0.85, 0.65]], [25, [1.3, 1.25, 1.2]], [50, [1.4, 1.38, 1.35]]], elev);
    const ca = lerpColor([[-8, [0.02, 0.025, 0.04]], [-2, [0.12, 0.1, 0.16]], [4, [0.3, 0.25, 0.3]], [20, [0.42, 0.5, 0.62]], [50, [0.48, 0.56, 0.68]]], elev);
    u.uCloudSun.value.setRGB(cs[0], cs[1], cs[2]);
    u.uCloudAmb.value.setRGB(ca[0], ca[1], ca[2]);

    // horizon haze / fog colour + ambient sky tint used by the ocean
    const fog = lerpColor([[-10, [0.012, 0.018, 0.03]], [-3, [0.12, 0.09, 0.12]], [2, [0.55, 0.36, 0.28]], [8, [0.62, 0.58, 0.58]], [20, [0.62, 0.72, 0.84]], [50, [0.6, 0.72, 0.86]]], elev);
    s.fogColor = new THREE.Color(fog[0], fog[1], fog[2]);
    const amb = lerpColor([[-10, [0.004, 0.007, 0.014]], [-3, [0.05, 0.05, 0.08]], [3, [0.25, 0.22, 0.28]], [15, [0.35, 0.45, 0.6]], [50, [0.4, 0.52, 0.7]]], elev);
    s.skyAmbient = new THREE.Color(amb[0], amb[1], amb[2]);

    s.exposure = lerp(0.5, 0.95, night);
    s.bloomStrength = lerp(0.12, 0.85, s.lightsOn);
    s.bloomThreshold = lerp(1.6, 0.55, s.lightsOn);
    s.envIntensity = lerp(1.0, 0.35, night);
  }

  update(dt, elapsed, focus) {
    const u = this.material.uniforms;
    u.uTime.value = elapsed;
    this.cloudShift.x += dt * 0.0022;
    this.cloudShift.y += dt * 0.0009;
    u.uCloudShift.value.copy(this.cloudShift);

    const d = this.state.sunDir;
    this.sun.position.copy(focus).addScaledVector(d, 800);
    this.sun.target.position.copy(focus);
    this.moon.position.copy(focus).addScaledVector(this.state.moonDir, 800);
    this.moon.target.position.copy(focus);

    // regenerate image-based lighting when the sky changed noticeably
    this.envTimer -= dt;
    const key = `${this.state.elevation.toFixed(1)}|${this.time.toFixed(2)}`;
    if (key !== this.lastEnvKey && this.envTimer <= 0) {
      this.lastEnvKey = key;
      this.envTimer = 0.2;
      const rt = this.pmrem.fromScene(this.envScene, 0.02, 0.1, 1000);
      if (this.envRT) this.envRT.dispose();
      this.envRT = rt;
      this.scene.environment = rt.texture;
    }
    this.scene.environmentIntensity = this.state.envIntensity;
  }
}
