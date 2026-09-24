// Procedural crane soundscape (Web Audio, no samples): diesel-electric drive rumble with firing pulse,
// inverter whine on the hoist, gantry rail rumble + travel warning beeps, spreader twistlock clacks,
// container landing thuds with steel ring, and a soft harbour wind bed.
export class CraneAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.beepT = 0;
    this.lastSfx = 0;
  }

  ensure() {
    if (!this.ctx) this.build();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  noiseBuffer(brown = false) {
    const ctx = this.ctx, n = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    return buf;
  }

  loop(buf) { const s = this.ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; }

  build() {
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.white = this.noiseBuffer(false);
    this.brown = this.noiseBuffer(true);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3.5; comp.attack.value = 0.004; comp.release.value = 0.2;
    this.master = ctx.createGain(); this.master.gain.value = this.enabled ? 0.8 : 0;
    this.master.connect(comp).connect(ctx.destination);
    this.sfxBus = ctx.createGain(); this.sfxBus.gain.value = 0.9; this.sfxBus.connect(this.master);

    // engine: sawtooth + sub square through a soft clipper and a load-dependent low-pass, pulsed by firing LFO
    const e1 = ctx.createOscillator(); e1.type = 'sawtooth'; e1.frequency.value = 40;
    const e2 = ctx.createOscillator(); e2.type = 'square'; e2.frequency.value = 20;
    const e2g = ctx.createGain(); e2g.gain.value = 0.35;
    const en = this.loop(this.white);
    const enf = ctx.createBiquadFilter(); enf.type = 'bandpass'; enf.frequency.value = 140; enf.Q.value = 0.8;
    const eng = ctx.createGain(); eng.gain.value = 0.18;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 2.2); }
    shaper.curve = curve;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260; lp.Q.value = 0.9;
    const engineGain = ctx.createGain(); engineGain.gain.value = 0;
    const pulse = ctx.createOscillator(); pulse.frequency.value = 12;
    const pulseDepth = ctx.createGain(); pulseDepth.gain.value = 0.35;
    const pulseOut = ctx.createGain(); pulseOut.gain.value = 1;
    pulse.connect(pulseDepth).connect(pulseOut.gain);
    e1.connect(shaper); e2.connect(e2g).connect(shaper); en.connect(enf).connect(eng).connect(shaper);
    shaper.connect(lp).connect(pulseOut).connect(engineGain).connect(this.master);
    e1.start(); e2.start(); pulse.start();
    Object.assign(this, { e1, e2, lp, engineGain, pulse });

    // hoist inverter whine
    const w1 = ctx.createOscillator(); w1.type = 'sine'; w1.frequency.value = 300;
    const w2 = ctx.createOscillator(); w2.type = 'triangle'; w2.frequency.value = 600;
    const w2g = ctx.createGain(); w2g.gain.value = 0.3;
    const whineGain = ctx.createGain(); whineGain.gain.value = 0;
    w1.connect(whineGain); w2.connect(w2g).connect(whineGain); whineGain.connect(this.master);
    w1.start(); w2.start();
    Object.assign(this, { w1, w2, whineGain });

    // gantry wheel/rail rumble
    const rn = this.loop(this.brown);
    const rf = ctx.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 180;
    const railGain = ctx.createGain(); railGain.gain.value = 0;
    rn.connect(rf).connect(railGain).connect(this.master);
    this.railGain = railGain;

    // harbour wind bed with slow gusts
    const an = this.loop(this.brown);
    const af = ctx.createBiquadFilter(); af.type = 'lowpass'; af.frequency.value = 520;
    const ag = ctx.createGain(); ag.gain.value = 0.05;
    const gust = ctx.createOscillator(); gust.frequency.value = 0.07;
    const gustD = ctx.createGain(); gustD.gain.value = 220;
    gust.connect(gustD).connect(af.frequency); gust.start();
    an.connect(af).connect(ag).connect(this.master);
    this.ambGain = ag;
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.ctx) this.master.gain.setTargetAtTime(on ? 0.8 : 0, this.ctx.currentTime, 0.08);
  }

  // Continuous motor state, called every frame. Speeds in m/s of crane motion (real time).
  update(dt, { active, hoist = 0, travel = 0, trolley = 0 }) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime, k = 0.08;
    const load = Math.min(1, hoist / 3 + travel / 5 + trolley * 0.9);
    const on = active ? 1 : 0;
    this.engineGain.gain.setTargetAtTime(on * (0.1 + 0.16 * load), now, k);
    this.e1.frequency.setTargetAtTime(36 + 26 * load, now, 0.25);
    this.e2.frequency.setTargetAtTime(18 + 13 * load, now, 0.25);
    this.pulse.frequency.setTargetAtTime(10 + 10 * load, now, 0.25);
    this.lp.frequency.setTargetAtTime(240 + 900 * load, now, 0.2);
    const h = Math.min(1, hoist / 3.5);
    this.w1.frequency.setTargetAtTime(220 + 760 * h, now, 0.1);
    this.w2.frequency.setTargetAtTime(440 + 1520 * h, now, 0.1);
    this.whineGain.gain.setTargetAtTime(on * 0.03 * Math.min(1, hoist / 1.2), now, 0.06);
    this.railGain.gain.setTargetAtTime(on * 0.35 * Math.min(1, travel / 4), now, 0.1);
    this.ambGain.gain.setTargetAtTime(active ? 0.05 : 0, now, 0.4);
    // travel warning beeps
    this.beepT -= dt;
    if (active && travel > 0.4 && this.beepT <= 0) { this.beep(); this.beepT = 0.62; }
  }

  env(node, t, a, peak, decay) {
    node.gain.setValueAtTime(0.0001, t);
    node.gain.exponentialRampToValueAtTime(peak, t + a);
    node.gain.exponentialRampToValueAtTime(0.0001, t + a + decay);
  }

  noiseHit(t, { f = 2000, q = 1, type = 'bandpass', peak = 0.3, decay = 0.05 }) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource(); s.buffer = this.white;
    const bf = ctx.createBiquadFilter(); bf.type = type; bf.frequency.value = f; bf.Q.value = q;
    const gn = ctx.createGain();
    s.connect(bf).connect(gn).connect(this.sfxBus);
    this.env(gn, t, 0.002, peak, decay);
    s.start(t, Math.random() * 2); s.stop(t + decay + 0.05);
  }

  tone(t, { f0, f1 = f0, type = 'sine', peak = 0.3, a = 0.004, decay = 0.3 }) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + decay);
    const gn = ctx.createGain();
    o.connect(gn).connect(this.sfxBus);
    this.env(gn, t, a, peak, decay);
    o.start(t); o.stop(t + a + decay + 0.05);
  }

  beep() {
    const t = this.ctx.currentTime;
    this.tone(t, { f0: 1240, type: 'square', peak: 0.045, a: 0.01, decay: 0.16 });
  }

  // One-shot events from the timeline.
  play(type, intensity = 1) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    if (t - this.lastSfx < 0.04) return;
    this.lastSfx = t;
    const k = Math.min(1.2, Math.max(0.35, intensity));
    switch (type) {
      case 'land':
      case 'hatch': {
        const heavy = type === 'hatch' ? 1.35 : 1;
        this.tone(t, { f0: 90 / heavy, f1: 34, peak: 0.75 * k * heavy, decay: 0.38 * heavy });
        this.noiseHit(t, { f: 700, q: 0.7, peak: 0.35 * k, decay: 0.09 });
        for (const f of [233, 389, 617, 851, 1190]) this.tone(t + 0.005, { f0: f * (0.94 + Math.random() * 0.12) / heavy, peak: 0.05 * k, decay: 0.7 + Math.random() * 0.6 });
        for (let i = 0; i < 3; i++) this.noiseHit(t + 0.06 + i * 0.045 + Math.random() * 0.02, { f: 2600, q: 3, peak: 0.12 * k, decay: 0.025 });
        break;
      }
      case 'unlock':
        this.noiseHit(t, { f: 3200, q: 4, peak: 0.25, decay: 0.02 });
        this.tone(t, { f0: 1800, f1: 1400, type: 'triangle', peak: 0.06, decay: 0.03 });
        this.noiseHit(t + 0.09, { f: 2900, q: 4, peak: 0.22, decay: 0.02 });
        this.noiseHit(t + 0.02, { f: 5000, type: 'highpass', peak: 0.04, decay: 0.22 }); // hydraulic hiss
        break;
      case 'lock':
        this.noiseHit(t, { f: 2400, q: 4, peak: 0.22, decay: 0.025 });
        this.noiseHit(t + 0.07, { f: 2100, q: 4, peak: 0.2, decay: 0.025 });
        this.noiseHit(t + 0.01, { f: 4500, type: 'highpass', peak: 0.035, decay: 0.3 });
        break;
      case 'travelStart':
        this.noiseHit(t, { f: 400, q: 0.8, peak: 0.12, decay: 0.2 });
        break;
      case 'travelEnd':
        this.tone(t, { f0: 70, f1: 50, peak: 0.12, decay: 0.25 });
        break;
      default:
    }
  }

  sleep() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const gn of [this.engineGain, this.whineGain, this.railGain, this.ambGain]) gn.gain.setTargetAtTime(0, now, 0.15);
    setTimeout(() => this.ctx && this.ctx.state === 'running' && !this.awake && this.ctx.suspend(), 800);
    this.awake = false;
  }

  wake() { this.ensure(); this.awake = true; }
}
