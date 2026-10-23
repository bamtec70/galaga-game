/**
 * GALAGA — Namco / Midway 1981 style recreation (Build V22)
 * V22: rescue save fanfare — stop kill SFX from stomping it; longer rising theme.
 * V21: fix silent prelude/capture — transfer WSG schedule on AudioWorklet
 *       handoff, await AudioContext resume, music voice-lock, capture melody
 *       no longer stomped by beam LFO.
 * V20: capture freeze regression fix — harden FSM soft-lock breakers, always
 * tick captureSeq (even during die/pause/clear), clear orphaned captureOwned,
 * prevent beam_loop renew spam from stalling the cinematic. Sprites/audio
 * from V19 retained.
 */
(() => {
  "use strict";

  const canvas = document.getElementById("game");
  if (!canvas) return;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return;

  // Logical playfield (game math). Display is 2× via SCALE + CSS.
  const VW = 448;
  const VH = 576;
  const SCALE = 2;
  // Dig Dug uses ~3× original 16px tiles; Galaga sprites were ~1.1px logical.
  // SPR_PX ~2.1 ≈ arcade-faithful proportions at readable cabinet size.
  const SPR_PX = 2.0;
  const SPR_PX_BOSS = 2.15;
  const SPR_PX_SHIP = 2.05;
  // V25: native arcade raster 224x288; CSS scales it with nearest-neighbour.
  const AW = 224, AH = 288;
  canvas.width = AW;
  canvas.height = AH;
  document.documentElement.style.setProperty("--board-w", VW * SCALE + "px");
  document.documentElement.style.setProperty("--board-h", VH * SCALE + "px");
  document.documentElement.style.setProperty("--aspect-w", String(VW));
  document.documentElement.style.setProperty("--aspect-h", String(VH));
  ctx.imageSmoothingEnabled = false;

  const overlay = document.getElementById("overlay");
  const $title = document.getElementById("overlay-title");
  const $sub = document.getElementById("overlay-sub");
  const $hint = document.getElementById("overlay-hint");
  const $score = document.getElementById("score");
  const $high = document.getElementById("high-score");
  const $stage = document.getElementById("stage");
  const $lives = document.getElementById("lives");
  const $stageIcons = document.getElementById("stage-icons");

  // ── Palette (1981 Namco RGB — vivid arcade, not muddy 5200 pastels) ─────
  const C = {
    black: "#000000",
    white: "#ffffff",
    red: "#ff2020",
    orange: "#ff9000",
    yellow: "#ffff20",
    green: "#20ff40",
    cyan: "#20ffff",
    blue: "#2060ff",
    purple: "#e040ff",
    pink: "#ff40b0",
    magenta: "#ff20a0",
    boss: "#20f020",
    bossEye: "#ffff00",
    bee: "#2060ff",
    beeWing: "#80c0ff",
    butter: "#ff3030",
    butterWing: "#ff60a0",
    ship: "#ffffff",
    shipRed: "#ff3030",
    shipBlue: "#40a0ff",
  };

  // ── Audio — real Namco WSG (3 voices × 32-sample 4-bit) + LFSR noise ─────
  // Hand-authored wavetables + scripted register sequences. No ROM dumps.
  // Galaga CPU3 drove a 3-voice WSG; 54xx-style LFSR covers shot/boom grit.
  let AC = null;
  let master = null;
  let muted = false;
  let musicLockUntil = 0; // performance.now() — protect prelude/capture melody
  let wsg = null;          // { voices, schedule, node, ready }
  let noiseBuf = null;
  let beamLoopUntil = 0;
  let beamTimer = null;
  let beamActive = false;

  // 8 × 32 samples (0..15). Hand-authored to match Namco WSG cabinet
  // character (32-sample 4-bit stair-step). 
  // V31: every wavetable is generated from simple math (sine/harmonic mixes,
  // square, saw) and quantised to 4 bits — nothing copied from any PROM.
  const WSG_WAVES_4BIT = (() => {
    const q = (f) => Array.from({ length: 32 }, (_, i) => {
      const v = f((i / 32) * Math.PI * 2, i / 32);
      return Math.max(0, Math.min(15, Math.round(7.5 + 7.5 * v)));
    });
    const s = Math.sin;
    return [
      q((a) => s(a)),                                             // 0 sine lead
      q((a, p) => (p < 0.25 ? 1 : -0.6) * (0.6 + 0.4 * s(3 * a))), // 1 gated buzz
      q((a, p) => (p < 0.5 ? 1 : -1)),                             // 2 square
      q((a) => 0.6 * s(a) + 0.4 * s(2 * a)),                       // 3 double hump
      q((a) => 0.55 * s(a) + 0.45 * s(3 * a)),                     // 4 brass
      q((a) => 0.4 * s(a) + 0.35 * s(5 * a) + 0.25 * s(9 * a)),    // 5 metallic
      q((a, p) => 1 - 2 * p),                                      // 6 saw
      q((a) => 0.5 * s(a) + 0.3 * s(2 * a + 1) + 0.2 * s(4 * a)),  // 7 hollow organ
    ];
  })();

  function wavesToFloat(tables) {
    return tables.map((w) => {
      const f = new Float32Array(32);
      for (let i = 0; i < 32; i++) f[i] = (w[i] - 7.5) / 7.5;
      return f;
    });
  }

  function ensureNoiseBuf() {
    if (!AC || noiseBuf) return;
    const len = (AC.sampleRate * 0.55) | 0;
    noiseBuf = AC.createBuffer(1, len, AC.sampleRate);
    const d = noiseBuf.getChannelData(0);
    // 17-bit LFSR white-ish noise (54xx-flavored grit, not a ROM sample)
    let reg = 0x1ffff;
    for (let i = 0; i < len; i++) {
      const bit = ((reg >> 0) ^ (reg >> 3)) & 1;
      reg = (reg >> 1) | (bit << 16);
      d[i] = bit ? 0.55 : -0.55;
      if ((i & 3) === 0) d[i] *= 0.85;
    }
  }

  function createWSGEngine() {
    const tables = wavesToFloat(WSG_WAVES_4BIT);
    const voices = [0, 1, 2].map(() => ({
      freq: 0,
      vol: 0,
      wave: 0,
      phase: 0,
    }));
    const schedule = []; // { at, ch, freq, vol, wave }
    let gainScale = 0.22;

    // Prefer AudioWorklet; fall back to ScriptProcessor
    const useWorklet = !!(AC.audioWorklet && window.AudioWorkletNode);
    let node = null;
    let ready = false;

    const shared = { voices, tables, schedule, gainScale };

    function applyDue(now) {
      while (schedule.length && schedule[0].at <= now) {
        const ev = schedule.shift();
        const v = voices[ev.ch & 3];
        if (!v) continue;
        if (ev.freq != null) v.freq = Math.max(0, ev.freq);
        if (ev.vol != null) v.vol = Math.max(0, Math.min(15, ev.vol));
        if (ev.wave != null) v.wave = ev.wave & 7;
        if (ev.resetPhase) v.phase = 0;
      }
    }

    function render(out, sr, now0) {
      const n = out.length;
      for (let i = 0; i < n; i++) {
        const t = now0 + i / sr;
        applyDue(t);
        let mix = 0;
        for (let ch = 0; ch < 3; ch++) {
          const v = voices[ch];
          if (v.vol <= 0 || v.freq <= 0) continue;
          // Advance phase in wavetable samples (32 samples = 1 period)
          v.phase += (v.freq * 32) / sr;
          if (v.phase >= 32) v.phase -= 32 * Math.floor(v.phase / 32);
          const idx = v.phase & 31;
          // 4-bit stair-step — no interpolation (WSG character)
          mix += tables[v.wave][idx] * (v.vol / 15);
        }
        out[i] = mix * shared.gainScale;
      }
    }

    if (useWorklet) {
      const code = `
        class NamcoWSGProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this.voices = [0,1,2].map(() => ({freq:0,vol:0,wave:0,phase:0}));
            this.tables = null;
            this.schedule = [];
            this.gainScale = 0.22;
            this.port.onmessage = (e) => {
              const m = e.data || {};
              if (m.type === 'init') {
                this.tables = m.tables.map((a) => new Float32Array(a));
              } else if (m.type === 'set') {
                const v = this.voices[m.ch & 3];
                if (!v) return;
                if (m.freq != null) v.freq = m.freq;
                if (m.vol != null) v.vol = m.vol;
                if (m.wave != null) v.wave = m.wave & 7;
                if (m.resetPhase) v.phase = 0;
              } else if (m.type === 'sched') {
                this.schedule.push(m.ev);
                this.schedule.sort((a,b) => a.at - b.at);
              } else if (m.type === 'clearSched') {
                this.schedule.length = 0;
              } else if (m.type === 'silence') {
                this.schedule.length = 0;
                for (const v of this.voices) { v.freq = 0; v.vol = 0; }
              }
            };
          }
          applyDue(now) {
            while (this.schedule.length && this.schedule[0].at <= now) {
              const ev = this.schedule.shift();
              const v = this.voices[ev.ch & 3];
              if (!v) continue;
              if (ev.freq != null) v.freq = Math.max(0, ev.freq);
              if (ev.vol != null) v.vol = Math.max(0, Math.min(15, ev.vol));
              if (ev.wave != null) v.wave = ev.wave & 7;
              if (ev.resetPhase) v.phase = 0;
            }
          }
          process(_inputs, outputs) {
            const out = outputs[0][0];
            if (!out || !this.tables) {
              if (out) out.fill(0);
              return true;
            }
            const sr = sampleRate;
            const now0 = currentTime;
            for (let i = 0; i < out.length; i++) {
              const t = now0 + i / sr;
              this.applyDue(t);
              let mix = 0;
              for (let ch = 0; ch < 3; ch++) {
                const v = this.voices[ch];
                if (v.vol <= 0 || v.freq <= 0) continue;
                v.phase += (v.freq * 32) / sr;
                if (v.phase >= 32) v.phase -= 32 * Math.floor(v.phase / 32);
                mix += this.tables[v.wave][v.phase & 31] * (v.vol / 15);
              }
              out[i] = mix * this.gainScale;
            }
            return true;
          }
        }
        registerProcessor('namco-wsg', NamcoWSGProcessor);
      `;
      const blob = new Blob([code], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      // Sync path: ScriptProcessor first so unlock isn't silent;
      // worklet upgrades when module loads.
      const sp = AC.createScriptProcessor(256, 1, 1);
      sp.onaudioprocess = (e) => {
        if (ready && node && node !== sp) {
          e.outputBuffer.getChannelData(0).fill(0);
          return;
        }
        render(e.outputBuffer.getChannelData(0), AC.sampleRate, AC.currentTime);
      };
      sp.connect(master);
      node = sp;
      ready = true;

      AC.audioWorklet
        .addModule(url)
        .then(() => {
          try {
            const wn = new AudioWorkletNode(AC, "namco-wsg", {
              numberOfInputs: 0,
              numberOfOutputs: 1,
              outputChannelCount: [1],
            });
            wn.port.postMessage({
              type: "init",
              tables: tables.map((t) => Array.from(t)),
            });
            // Mirror current voice state
            for (let ch = 0; ch < 3; ch++) {
              const v = voices[ch];
              wn.port.postMessage({
                type: "set",
                ch,
                freq: v.freq,
                vol: v.vol,
                wave: v.wave,
              });
            }
            // V21: transfer pending schedule — without this, mid-prelude Worklet
            // swap disconnects ScriptProcessor and drops the fanfare to silence.
            for (let i = 0; i < schedule.length; i++) {
              wn.port.postMessage({ type: "sched", ev: schedule[i] });
            }
            try {
              sp.disconnect();
            } catch (_) {}
            wn.connect(master);
            node = wn;
            shared.worklet = wn;
            URL.revokeObjectURL(url);
          } catch (_) {}
        })
        .catch(() => {
          URL.revokeObjectURL(url);
        });
    } else {
      const sp = AC.createScriptProcessor(256, 1, 1);
      sp.onaudioprocess = (e) => {
        render(e.outputBuffer.getChannelData(0), AC.sampleRate, AC.currentTime);
      };
      sp.connect(master);
      node = sp;
      ready = true;
    }

    function postSet(ch, freq, vol, wave, resetPhase) {
      const v = voices[ch];
      if (freq != null) v.freq = Math.max(0, freq);
      if (vol != null) v.vol = Math.max(0, Math.min(15, vol));
      if (wave != null) v.wave = wave & 7;
      if (resetPhase) v.phase = 0;
      if (shared.worklet) {
        shared.worklet.port.postMessage({
          type: "set",
          ch,
          freq: v.freq,
          vol: v.vol,
          wave: v.wave,
          resetPhase: !!resetPhase,
        });
      }
    }

    function sched(ch, delay, freq, vol, wave, resetPhase) {
      const at = AC.currentTime + Math.max(0, delay);
      const ev = { at, ch, freq, vol, wave, resetPhase: !!resetPhase };
      schedule.push(ev);
      schedule.sort((a, b) => a.at - b.at);
      if (shared.worklet) {
        shared.worklet.port.postMessage({ type: "sched", ev });
      }
    }

    function silenceAll() {
      schedule.length = 0;
      for (let ch = 0; ch < 3; ch++) postSet(ch, 0, 0, voices[ch].wave, false);
      if (shared.worklet) shared.worklet.port.postMessage({ type: "silence" });
    }

    function clearSched() {
      schedule.length = 0;
      if (shared.worklet) shared.worklet.port.postMessage({ type: "clearSched" });
    }

    return {
      voices,
      schedule,
      node,
      postSet,
      sched,
      silenceAll,
      clearSched,
      shared,
    };
  }

  function unlockAudio() {
    try {
      if (!AC) {
        AC = new (window.AudioContext || window.webkitAudioContext)();
        master = AC.createGain();
        master.gain.value = muted ? 0 : 0.9;
        master.connect(AC.destination);
        ensureNoiseBuf();
        wsg = createWSGEngine();
      }
      ensureNoiseBuf();
      if (AC.state === "suspended") return AC.resume().catch(function () {});
    } catch (_) {}
    return Promise.resolve();
  }

  function dest() {
    return master || (AC && AC.destination);
  }

  // Soft noise burst (54xx-flavored) mixed beside WSG
  function noise(dur, vol = 0.05, when = 0, ff = 1200, q = 0.8, slideFf) {
    if (muted || !AC || !noiseBuf || !dest()) return;
    try {
      const t0 = AC.currentTime + when;
      const src = AC.createBufferSource();
      src.buffer = noiseBuf;
      const f = AC.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.setValueAtTime(Math.max(80, ff), t0);
      if (slideFf != null) {
        f.frequency.exponentialRampToValueAtTime(Math.max(80, slideFf), t0 + dur);
      }
      f.Q.value = q;
      const g = AC.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f);
      f.connect(g);
      g.connect(dest());
      src.start(t0);
      src.stop(t0 + dur + 0.03);
    } catch (_) {}
  }

  /** Immediate voice write */
  function vset(ch, freq, vol, wave, resetPhase) {
    if (!wsg) return;
    wsg.postSet(ch, freq, vol, wave, resetPhase);
  }

  /** Schedule voice write at delay seconds from now */
  function vsched(ch, delay, freq, vol, wave, resetPhase) {
    if (!wsg) return;
    wsg.sched(ch, delay, freq, vol, wave, resetPhase);
  }

  /** Play a melodic register sequence on one voice: [freqHz, durSec, vol?, wave?]? gap via 0 freq */
  function vseq(ch, notes, baseVol = 12, wave = 0, startDelay = 0) {
    if (!wsg) return;
    let t = startDelay;
    for (const n of notes) {
      const f = n[0];
      const d = n[1];
      const vol = n[2] != null ? n[2] : baseVol;
      const wv = n[3] != null ? n[3] : wave;
      const gap = n[4] || 0;
      if (f > 0) {
        vsched(ch, t, f, vol, wv, true);
        vsched(ch, t + Math.max(0.01, d * 0.92), f, 0, wv, false);
      } else {
        vsched(ch, t, 0, 0, wave, false);
      }
      t += d + gap;
    }
  }

  function stopBeamHum() {
    beamActive = false;
    beamLoopUntil = 0;
    if (beamTimer) {
      clearInterval(beamTimer);
      beamTimer = null;
    }
    if (!wsg) return;
    // Release voice 0 gently
    vsched(0, 0, 0, 0, 1, false);
  }

  function startBeamHum(seconds) {
    if (demo) return;
    unlockAudio();
    if (muted || !AC || !wsg) return;
    stopBeamHum();
    beamActive = true;
    const tEnd = performance.now() + seconds * 1000;
    beamLoopUntil = tEnd;
    // Cabinet tractor: wave1 gated drone + wave4 brass sub — heavier LFO (V19 retune).
    let phase = 0;
    vset(0, 96, 15, 1, true);
    vsched(1, 0, 192, 7, 4, true);
    beamTimer = setInterval(() => {
      if (!beamActive || muted || !wsg) {
        stopBeamHum();
        return;
      }
      if (performance.now() >= tEnd) {
        stopBeamHum();
        return;
      }
      phase += 0.58;
      const wob = Math.sin(phase) * 56 + Math.sin(phase * 0.41) * 26 + Math.sin(phase * 2.85) * 12;
      const volWob = 12 + Math.floor(3 + 3 * Math.sin(phase * 2.35));
      vset(0, 88 + wob, Math.min(15, volWob), 1, false);
      vset(1, 176 + wob * 1.85, 6 + (volWob >> 2), 4, false);
    }, 28);
    vsched(0, seconds, 0, 0, 1, false);
    vsched(1, seconds, 0, 0, 4, false);
  }

  // -- Audio unlock (sound ON by default): first tap/click/key anywhere resumes Web Audio --
  (function () {
    function silentWav() {
      const n = 800, b = new Uint8Array(44 + n), v = new DataView(b.buffer);
      const s = (o, t) => { for (let i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i); };
      s(0, "RIFF"); v.setUint32(4, 36 + n, true); s(8, "WAVEfmt "); v.setUint32(16, 16, true);
      v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true);
      v.setUint16(32, 1, true); v.setUint16(34, 8, true); s(36, "data"); v.setUint32(40, n, true); b.fill(128, 44);
      let str = ""; for (let i = 0; i < b.length; i++) str += String.fromCharCode(b[i]);
      return "data:audio/wav;base64," + btoa(str);
    }
    let tag = null, kicked = null;
    function onGesture() {
      try { if (navigator.audioSession && navigator.audioSession.type !== "playback") navigator.audioSession.type = "playback"; } catch (_) {}
      try { if (!tag) { tag = new Audio(silentWav()); tag.setAttribute("playsinline", ""); tag.loop = true; tag.volume = 0.01; } if (tag.paused) { const p = tag.play(); if (p && p.catch) p.catch(function () {}); } } catch (_) {}
      try { unlockAudio(); } catch (_) {}
      try {
        const c = AC;
        if (c) {
          if (c.state !== "running" && c.resume) c.resume().catch(function () {});
          if (kicked !== c) { kicked = c; const sb = c.createBuffer(1, 1, 22050), src = c.createBufferSource(); src.buffer = sb; src.connect(c.destination); src.start(0); }
        }
      } catch (_) {}
    }
    ["pointerdown", "touchstart", "touchend", "mousedown", "click", "keydown"].forEach(function (t) {
      window.addEventListener(t, onGesture, { capture: true, passive: true });
    });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) { try { const c = AC; if (c && c.state === "suspended") c.resume().catch(function () {}); } catch (_) {} } });
    window.__audioInfo = function () { const c = AC; return { ctx: c ? c.state : "none", muted: muted }; };
  })();

  function sfx(name) {
    if (demo) return; // V30: attract mode is silent
    unlockAudio();
    if (muted || !AC || !wsg) return;

    // V21: keep prelude/capture melody from being stolen by dive/fire/beam
    const musicLocked = performance.now() < musicLockUntil;
    if (
      musicLocked &&
      name !== "prelude" &&
      name !== "start" &&
      name !== "capture" &&
      name !== "rescue" &&
      name !== "attach"
    ) {
      if (
        name === "dive" ||
        name === "beam" ||
        name === "beam_loop" ||
        name === "stage" ||
        name === "challenge" ||
        name === "die"
      ) {
        return;
      }
      if (name === "hit" || name === "kill") {
        noise(0.05, 0.045, 0, 1300, 1.05, 480);
        if (name === "kill") {
          noise(0.09, 0.1, 0, 2600, 0.5, 520);
          noise(0.18, 0.06, 0.03, 880, 0.4, 180);
        }
        return;
      }
      if (name === "fire") {
        noise(0.012, 0.042, 0, 9000, 2.8, 3200);
        noise(0.024, 0.016, 0.005, 2400, 1.15, 900);
        return;
      }
    }

    if (name === "fire") {
      // Arcade Galaga zip (V19): sharper LFSR click + higher start chirp, faster fall.
      noise(0.012, 0.042, 0, 9000, 2.8, 3200);
      noise(0.024, 0.016, 0.005, 2400, 1.15, 900);
      vset(2, 3180, 15, 2, true);
      vsched(2, 0.005, 2460, 14, 2, false);
      vsched(2, 0.012, 1780, 12, 2, false);
      vsched(2, 0.022, 1180, 10, 6, false);
      vsched(2, 0.034, 780, 7, 6, false);
      vsched(2, 0.046, 440, 3, 4, false);
      vsched(2, 0.056, 0, 0, 2, false);
    } else if (name === "hit") {
      noise(0.05, 0.045, 0, 1300, 1.05, 480);
      vset(1, 560, 14, 2, true);
      vsched(1, 0.012, 360, 12, 5, false);
      vsched(1, 0.035, 210, 8, 3, false);
      vsched(1, 0.07, 0, 0, 3, false);
      vset(2, 840, 10, 5, true);
      vsched(2, 0.03, 0, 0, 5, false);
    } else if (name === "kill") {
      // Boom (V19): deeper thud + brighter metallic sizzle (WSG+LFSR only).
      noise(0.09, 0.12, 0, 2600, 0.5, 520);
      noise(0.22, 0.09, 0.035, 880, 0.4, 180);
      noise(0.42, 0.06, 0.09, 300, 0.3, 75);
      vset(1, 280, 15, 6, true);
      vsched(1, 0.028, 155, 14, 5, false);
      vsched(1, 0.075, 92, 11, 5, false);
      vsched(1, 0.15, 55, 7, 0, false);
      vsched(1, 0.3, 0, 0, 0, false);
      vset(2, 195, 13, 2, true);
      vsched(2, 0.045, 100, 10, 5, false);
      vsched(2, 0.13, 52, 6, 0, false);
      vsched(2, 0.28, 0, 0, 0, false);
    } else if (name === "die") {
      noise(0.65, 0.13, 0, 1500, 0.42, 140);
      noise(0.55, 0.09, 0.09, 360, 0.32, 60);
      vset(0, 480, 15, 6, true);
      vsched(0, 0.06, 270, 14, 5, false);
      vsched(0, 0.16, 150, 12, 5, false);
      vsched(0, 0.32, 88, 9, 0, false);
      vsched(0, 0.5, 48, 5, 0, false);
      vsched(0, 0.72, 0, 0, 0, false);
      vset(1, 220, 12, 2, true);
      vsched(1, 0.12, 110, 10, 3, false);
      vsched(1, 0.36, 58, 6, 0, false);
      vsched(1, 0.64, 0, 0, 0, false);
    } else if (name === "dive") {
      // Cabinet dive cry (V19): gated-buzzy + organ, wider warble, slightly higher start.
      const steps = 32;
      for (let i = 0; i < steps; i++) {
        const t = i * 0.034;
        const base = 1120 * Math.pow(0.896, i);
        const warble = Math.sin(i * 2.48) * (62 + i * 2.7) + Math.sin(i * 0.7) * 26;
        const vol = Math.max(4, 15 - Math.floor(i / 3.0));
        vsched(1, t, Math.max(64, base + warble), vol, 1, i === 0);
        vsched(2, t, Math.max(48, (base + warble) * 0.48), Math.max(2, vol - 3), 6, i === 0);
      }
      vsched(1, steps * 0.034 + 0.03, 0, 0, 1, false);
      vsched(2, steps * 0.034 + 0.03, 0, 0, 6, false);
    } else if (name === "beam") {
      startBeamHum(1.4);
      for (let i = 0; i < 12; i++) {
        const t = i * 0.085;
        const f = 185 + (i % 6) * 44;
        vsched(2, t, f, 6, 1, i === 0);
        vsched(2, t + 0.065, f, 0, 1, false);
      }
    } else if (name === "beam_loop") {
      startBeamHum(1.0);
    } else if (name === "capture") {
      stopBeamHum();
      // V21: drone only on voice 0 — do NOT startBeamHum (its LFO stomped the melody)
      const capDur = 2.05;
      for (let i = 0; i < 28; i++) {
        const t = i * 0.07;
        const wob = Math.sin(i * 0.85) * 48 + Math.sin(i * 0.31) * 18;
        vsched(0, t, Math.max(70, 92 + wob), 11 + (i % 3), 1, i === 0);
      }
      vsched(0, capDur, 0, 0, 1, false);
      // Pull-in capture fanfare on voices 1+2 (audible descending "gotcha")
      const cap = [
        784, 740, 698, 659, 622, 587, 554, 523, 494, 466, 440, 415, 392, 370, 349, 330, 311, 294, 277, 262,
      ];
      cap.forEach((f, i) => {
        const t = 0.04 + i * 0.088;
        vsched(1, t, f, 15, 6, i === 0);
        vsched(2, t, f * 0.5, 12, 7, i === 0);
        vsched(1, t + 0.078, f, 0, 6, false);
        vsched(2, t + 0.078, f * 0.5, 0, 7, false);
      });
      noise(0.7, 0.055, 0.08, 520, 0.5, 110);
      musicLockUntil = Math.max(musicLockUntil, performance.now() + 2300);
    } else if (name === "rescue") {
      stopBeamHum();
      if (wsg) wsg.clearSched();
      // V22: longer rising "fighter saved" fanfare (~2.2s) — WSG only, covers spin
      vseq(
        1,
        [
          [392, 0.09],
          [523, 0.09],
          [659, 0.09],
          [784, 0.1],
          [988, 0.1],
          [1175, 0.12],
          [1319, 0.14],
          [1175, 0.09],
          [1568, 0.22],
          [1319, 0.12],
          [1760, 0.28],
        ],
        15,
        6
      );
      vseq(
        2,
        [
          [196, 0.18],
          [262, 0.18],
          [330, 0.18],
          [392, 0.2],
          [523, 0.22],
          [659, 0.24],
          [784, 0.45],
        ],
        11,
        3
      );
      vseq(
        0,
        [
          [98, 0.2],
          [131, 0.2],
          [165, 0.2],
          [196, 0.25],
          [262, 0.55],
        ],
        10,
        6
      );
      noise(0.12, 0.04, 0.05, 2200, 1.2, 900);
      musicLockUntil = Math.max(musicLockUntil, performance.now() + 2400);
    } else if (name === "stage") {
      vseq(
        1,
        [
          [392, 0.08],
          [523, 0.08],
          [659, 0.08],
          [784, 0.095],
          [659, 0.08],
          [784, 0.08],
          [1047, 0.2],
        ],
        12,
        0
      );
      vseq(
        2,
        [
          [196, 0.16],
          [262, 0.16],
          [330, 0.16],
          [392, 0.16],
          [523, 0.32],
        ],
        8,
        3
      );
    } else if (name === "challenge") {
      vseq(
        1,
        [
          [523, 0.07],
          [659, 0.07],
          [784, 0.07],
          [988, 0.085],
          [784, 0.07],
          [988, 0.07],
          [1175, 0.085],
          [1319, 0.16],
        ],
        12,
        7
      );
      vseq(
        2,
        [
          [262, 0.14],
          [330, 0.14],
          [392, 0.14],
          [523, 0.14],
          [659, 0.28],
        ],
        7,
        0
      );
    } else if (name === "transform") {
      // V31: warbling split — rising buzz then three quick blips
      vseq(2, [[220, 0.05], [330, 0.05], [262, 0.05], [392, 0.05], [330, 0.05], [494, 0.05], [660, 0.06], [0, 0.04], [880, 0.04], [988, 0.04], [1175, 0.06]], 11, 1);
    } else if (name === "extra") {
      vseq(
        1,
        [
          [659, 0.055],
          [784, 0.055],
          [988, 0.055],
          [1175, 0.065],
          [1319, 0.075],
          [1175, 0.075],
          [1568, 0.18],
        ],
        13,
        0
      );
    } else if (name === "perfect") {
      vseq(
        1,
        [
          [523, 0.07],
          [659, 0.07],
          [784, 0.07],
          [1047, 0.085],
          [1319, 0.085],
          [1568, 0.1],
          [2093, 0.18],
          [1568, 0.085],
          [2093, 0.22],
        ],
        13,
        7
      );
      vseq(
        2,
        [
          [262, 0.14],
          [330, 0.14],
          [392, 0.14],
          [523, 0.28],
        ],
        7,
        3
      );
    } else if (name === "start" || name === "prelude") {
      // Galaga Prelude / Game Start fanfare (~7–8s), hand-entered from
      // public melody transcriptions of Nobuyuki Ohnogi's opening jingle.
      // Multi-voice WSG register writes — NOT ripped VGM/ROM/samples.
      // Rhythm: dotted-8th + 16th bounce (DOT/SIX), then closing triplets.
      playGalagaPrelude();
    } else if (name === "attach") {
      noise(0.07, 0.035, 0.01, 1800, 1.0, 700);
      vset(1, 920, 13, 2, true);
      vsched(1, 0.045, 1400, 11, 0, false);
      vsched(1, 0.11, 0, 0, 0, false);
    }
  }

  /** Classic Galaga start music — 3-voice WSG approximation.
   * Note contour / tick rhythm informed by private arcade CPU3 script analysis
   * (melody indices + durations). Frequencies are hand-mapped ET Hz — no ROM
   * bytes, VGM, or PCM are embedded. Wave 6/7 organ-saw blend for fanfare. */
  function playGalagaPrelude() {
    if (!wsg) return;
    wsg.clearSched();
    vset(0, 0, 0, 6, false);
    vset(1, 0, 0, 7, false);
    vset(2, 0, 0, 3, false);

    // Sound-CPU note byte → Hz (ordered pitch ring observed in scripts).
    // Ascending order: 0x83..0x8b then 0x70..0x7b
    const ORDER = [
      0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x70, 0x71, 0x72,
      0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e,
    ];
    const BASE = 261.63; // C4; one semitone per step (V19 ear-retune toward cabinet)
    const NOTE_HZ = {};
    ORDER.forEach((id, i) => {
      NOTE_HZ[id] = +(BASE * Math.pow(2, i / 12)).toFixed(2);
    });
    function hz(n) {
      return NOTE_HZ[n] || 220;
    }

    // Sequencer tick ≈ 5.7 frames @ 60Hz — yields ~7–8s (V19 tighter bounce)
    const TICK = 0.094;

    function schedVoice(ch, events, wave, vol, startAt) {
      let t = startAt;
      for (const ev of events) {
        if (ev[0] === "rest") {
          t += ev[1] * TICK;
          continue;
        }
        const f = hz(ev[0]);
        const d = ev[1] * TICK;
        const vv = ev[2] != null ? ev[2] : vol;
        const wv = ev[3] != null ? ev[3] : wave;
        vsched(ch, t, f, vv, wv, true);
        vsched(ch, t + Math.max(0.02, d * 0.88), f, 0, wv, false);
        t += d;
      }
      return t;
    }

    // Phrase A (CPU3-style): chromatic turn then descending run — INIT wave 6
    const melA = [
      [0x71, 1], [0x72, 1], [0x73, 1], [0x75, 1], [0x74, 1], [0x73, 1],
      [0x72, 1], [0x71, 1], [0x70, 1], [0x8b, 1], [0x8a, 1],
      ["rest", 4],
      [0x86, 1], [0x87, 1], [0x88, 1], [0x89, 1], [0x8a, 1], [0x89, 1],
      [0x88, 1], [0x87, 1], [0x86, 1], [0x85, 1], [0x84, 1], [0x83, 1],
    ];
    // Phrase B: triplet arpeggio climbs (public-tab / script 0x0845 character)
    const melB = [
      ["rest", 1],
      [0x89, 1], [0x8a, 1], [0x8b, 1], ["rest", 1],
      [0x70, 1], [0x71, 1], [0x72, 1], ["rest", 1],
      [0x73, 1], [0x74, 1], [0x75, 1], ["rest", 3],
      [0x8b, 1], [0x70, 1], [0x71, 1], ["rest", 1],
      [0x72, 1], [0x73, 1], [0x74, 1], ["rest", 1],
      [0x75, 1], [0x76, 1], [0x77, 1], ["rest", 3],
      [0x71, 1], [0x72, 1], [0x73, 1], ["rest", 1],
      [0x74, 1], [0x75, 1], [0x76, 1], ["rest", 1],
      [0x77, 1], [0x78, 1], [0x79, 1],
      [0x78, 2], [0x75, 2], [0x71, 3],
    ];

    const t0 = 0.025;
    let tMel = schedVoice(1, melA, 6, 14, t0);
    tMel = schedVoice(1, melB, 7, 15, tMel + TICK);

    // Harmony voice — diatonic thirds below (wave 0/3), slightly quieter
    function below(n, semitones) {
      const idx = ORDER.indexOf(n);
      if (idx < 0) return n;
      return ORDER[Math.max(0, idx - semitones)];
    }
    const harA = melA.map((ev) =>
      ev[0] === "rest" ? ev : [below(ev[0], 3), ev[1], 8, 3]
    );
    const harB = melB.map((ev) =>
      ev[0] === "rest" ? ev : [below(ev[0], 4), ev[1], 9, 0]
    );
    let tHar = schedVoice(2, harA, 3, 9, t0);
    tHar = schedVoice(2, harB, 0, 10, tHar + TICK);

    // Bass pulses on phrase downbeats (wave 6 saw)
    const bass = [
      [0x83, 2, 9, 6], ["rest", 2], [0x83, 2, 9, 6], ["rest", 2],
      [0x86, 2, 9, 6], ["rest", 2], [0x83, 4, 10, 6],
      ["rest", 2],
      [0x86, 3, 9, 6], ["rest", 1], [0x83, 3, 9, 6], ["rest", 1],
      [0x8a, 3, 10, 6], ["rest", 3],
      [0x86, 3, 9, 6], ["rest", 1], [0x83, 3, 9, 6], ["rest", 1],
      [0x8a, 3, 10, 6], ["rest", 3],
      [0x70, 2, 10, 6], [0x8b, 2, 9, 6], [0x83, 4, 11, 6],
    ];
    const tBass = schedVoice(0, bass, 6, 9, t0);
    // Hold voice lock for full fanfare so dive/fire cannot mute it mid-phrase
    const endSec = Math.max(tMel, tHar, tBass) + 0.2;
    musicLockUntil = performance.now() + endSec * 1000;
  }


  // ── Helpers ──────────────────────────────────────────────────────────────
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function pad(n) {
    return String(Math.floor(n) | 0).padStart(2, "0");
  }
  function rnd(a, b) {
    return a + Math.random() * (b - a);
  }
  function chance(p) {
    return Math.random() < p;
  }
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function dist(ax, ay, bx, by) {
    return Math.hypot(ax - bx, ay - by);
  }

  // ── State ────────────────────────────────────────────────────────────────
  let state = "title"; // title | intro | play | die | clear | challenge | over | pause | capture
  let score = 0;
  let high = 0;
  try {
    high = Number(localStorage.getItem("galaga_hi_v1") || 0);
  } catch (_) {}
  let stage = 1;
  let lives = 3;
  let extrasAt = 0;

  let player = null;
  // Active ships under player control: 1 = single, 2 = dual, 3 = triple
  // Capture always takes ONE ship. Dual + rescue captive → triple.
  let fighterCount = 1;
  let dual = false; // kept in sync with fighterCount >= 2 for legacy checks
  let capturedHeld = false; // a fighter is captive in formation (boss)
  let captors = []; // bosses holding captive (usually 0-1)

  function syncFighters() {
    dual = fighterCount >= 2;
    if (player) {
      player.w = fighterCount === 1 ? 28 : fighterCount === 2 ? 52 : 72;
    }
  }

  let enemies = [];
  let bullets = []; // player
  let eBullets = []; // enemy
  let particles = [];
  let stars = [];
  let beams = []; // tractor beams

  // Full capture cinematic (Namco-style sequence)
  // phases: lock → pull → attach → haul → respawn
  let captureSeq = null;
  // Rescue cinematic: spin → dive-to-player → dock as dual
  // phases: spin → approach → dock
  let rescueSeq = null;
  // When last enemy dies mid-rescue, wait for dock before stage clear
  let pendingStageClear = false;

  let fireCD = 0;
  let diveTimer = 0;
  let introT = 0;
  let dieT = 0;
  let clearT = 0;
  let challengeT = 0;
  let invuln = 0;
  let stageLabelT = 0;
  let message = "";
  let messageT = 0;

  // Challenge stage stats
  let challengeHits = 0;
  let challengeShots = 0;
  let totalShots = 0;
  let totalHits = 0;
  let formBreath = 0;
  let formBreathT = 0;
  let formFull = false;
  let challengeMax = 40;
  let isChallenge = false;

  // Formation origin (top center)
  const FORM_OX = VW / 2;
  const FORM_OY = 92;
  const FORM_CW = 32;
  const FORM_CH = 32;

  // Input
  const keys = Object.create(null);
  let leftHeld = false;
  let rightHeld = false;
  let fireHeld = false;

  // ── Formation slots ──────────────────────────────────────────────────────
  // Rows: 0 bosses (4), 1-2 butterflies (8+8), 3-4 bees (10+10) — classic-ish
  function makeFormationSlots() {
    const slots = [];
    // Bosses — top row, 4 centered
    for (let i = 0; i < 4; i++) {
      slots.push({ row: 0, col: i + 3, type: "boss", i: slots.length });
    }
    // Butterflies — 2 rows of 8
    for (let r = 1; r <= 2; r++) {
      for (let c = 0; c < 8; c++) {
        slots.push({ row: r, col: c + 1, type: "butterfly", i: slots.length });
      }
    }
    // Bees — 2 rows of 10
    for (let r = 3; r <= 4; r++) {
      for (let c = 0; c < 10; c++) {
        slots.push({ row: r, col: c, type: "bee", i: slots.length });
      }
    }
    return slots;
  }

  // MAME-measured formation (arcade px): rows at the contracted / expanded
  // extremes of the "breathing" cycle; column pitch 16 -> 22.5 px.
  const ROW_MIN = [42, 60, 73, 86, 99];
  const ROW_MAX = [48, 70, 89, 108, 127];
  function slotPos(slot, sway) {
    const k = formFull ? formBreath : 0;
    const pitch = (16 + 6.5 * k) * 2;
    const x = VW / 2 + (slot.col - 4.5) * pitch + (formFull ? 0 : sway || 0);
    const y = 2 * (ROW_MIN[slot.row] + (ROW_MAX[slot.row] - ROW_MIN[slot.row]) * k);
    return { x, y };
  }

  // ── Stars ────────────────────────────────────────────────────────────────
  // MAME: ~95 stars visible at once; 4 interleaved sets each lit for 16 of
  // every 32 frames (two sets visible at a time); colours are the 2-bit-per-gun
  // levels 0/71/151/222; scroll 1 arcade px per frame (60 px/s) downward.
  const STAR_LV = [0, 71, 151, 222];
  function initStars() {
    stars = [];
    for (let i = 0; i < 190; i++) {
      let r, g, b;
      do {
        r = STAR_LV[(Math.random() * 4) | 0]; g = STAR_LV[(Math.random() * 4) | 0]; b = STAR_LV[(Math.random() * 4) | 0];
      } while (r + g + b === 0);
      stars.push({ x: (Math.random() * AW) | 0, y: Math.random() * AH, set: i & 3, c: `rgb(${r},${g},${b})` });
    }
  }
  let starFrame = 0;

  // ── HUD ──────────────────────────────────────────────────────────────────
  function hud() {
    if ($score) $score.textContent = pad(score);
    if ($high) $high.textContent = pad(high);
    if ($stage) $stage.textContent = String(stage);
    if ($lives) {
      // Stock fighters (start at 3). Each solo capture/death spends one.
      let s = "";
      for (let i = 0; i < Math.max(0, lives); i++) s += "▲";
      $lives.textContent = s ? "FIGHTERS " + s : "FIGHTERS —";
    }
    if ($stageIcons) {
      // Stage badges: flags every 10, others as marks
      let n = stage;
      let out = "";
      while (n >= 10) {
        out += "⚑";
        n -= 10;
      }
      while (n >= 5) {
        out += "◆";
        n -= 5;
      }
      while (n > 0) {
        out += "●";
        n--;
      }
      $stageIcons.textContent = out;
    }
  }

  function addScore(n) {
    score += n;
    if (demo) { hud(); return; } // V30: demo never touches high score / storage / extends
    if (score > high) {
      high = score;
      try {
        localStorage.setItem("galaga_hi_v1", String(high));
      } catch (_) {}
    }
    // Extra life every 20,000 (common setting)
    // Arcade default DIP (observed in MAME attract): 20000, 70000, every 70000
    while (score >= (extrasAt === 0 ? 20000 : 70000 * extrasAt)) {
      extrasAt++;
      lives++;
      sfx("extra");
      flashMsg("EXTRA FIGHTER!", 1500);
    }
    hud();
  }

  function showOV(title, sub, hint) {
    if (!overlay) return;
    overlay.classList.remove("hidden");
    const oc = document.getElementById("overlay-controls");
    if (oc) oc.style.display = state === "title" || state === "over" ? "" : "none";
    if ($title) $title.textContent = title;
    if ($sub) $sub.textContent = sub || "";
    if ($hint) $hint.textContent = hint || "";
  }
  function hideOV() {
    if (overlay) overlay.classList.add("hidden");
  }


  // ── Arcade message sequencer: the ONLY owner of centre-screen text ───────
  // Steps run strictly one after another; a step replaces the previous lines
  // unless add:true. Timings are arcade frames measured in MAME (60 fps).
  const TXT_C = "#00ffde", TXT_R = "#ff0000", TXT_Y = "#ffff00", TXT_W = "#dedede";
  let msgLines = [];
  let msgQ = [];
  let msgStepT = 0;
  let overReady = false;
  function msgClear() { msgLines = []; msgQ = []; msgStepT = 0; }
  function msgBusy() { return msgStepT > 0 || msgQ.length > 0; }
  function msgNext() {
    for (let guard = 0; guard < 64; guard++) {
      const st = msgQ.shift();
      if (!st) { msgLines = []; msgStepT = 0; return; }
      msgLines = st.add ? msgLines.concat(st.lines || []) : (st.lines || []).slice();
      msgStepT = ((st.f || 0) * 1000) / 60;
      if (st.fn) st.fn();
      if (msgStepT > 0) return;
      if (!msgQ.length) return; // instant final step keeps its lines (if any) until next run
    }
  }
  function msgRun(steps) { msgClear(); msgQ = steps.slice(); msgNext(); }
  function msgAfter(steps) {
    if (!msgBusy()) { msgRun(steps); return; }
    msgQ = msgQ.concat(steps);
  }
  function updateMsgs(dt) {
    if (msgStepT > 0) {
      msgStepT -= dt;
      if (msgStepT <= 0) msgNext();
    }
  }
  function L(t, col, row, color) { return { t, col, row, color: color || TXT_C }; }
  function stageLine(n) { return L("STAGE " + n, 10, 18); }
  function drawMsgs() { for (const l of msgLines) drawText(l.t, l.col, l.row, l.color); }

  // Game over → results (arcade: GAME OVER 190f, results 446f)
  function gameOver() {
    if (demo) { attractPhase("heroes"); return; } // V30: demo never enters initials
    if (state === "over") return;
    state = "over";
    overReady = false;
    fighterCount = 0;
    if (player) player.alive = false;
    const ratio = totalShots ? ((totalHits / totalShots) * 100).toFixed(1) : "0.0";
    msgAfter([
      { lines: [L("GAME OVER", 10, 18)], f: 190 },
      {
        lines: [
          L("-RESULTS-", 9, 17, TXT_R),
          L("SHOTS FIRED", 4, 20, TXT_Y), L(String(totalShots), 20, 20, TXT_Y),
          L("NUMBER OF HITS", 4, 23, TXT_Y), L(String(totalHits), 20, 23, TXT_Y),
          L("HIT-MISS RATIO", 4, 26, TXT_W), L(ratio + " %", 20, 26, TXT_W),
        ],
        f: 446,
        fn: () => { enemies = []; bullets = []; eBullets = []; beams = []; captureSeq = null; stopBeamHum(); },
      },
      { lines: [], f: 0, fn: () => {
          if (qualifies(score)) { startInitials(); return; }
          overReady = true; renderHsDom(); showOV("GALAGA", "GAME OVER", "BUILD V31 - PRESS SPACE OR TAP"); } },
    ]);
  }
  function canStart() { return state === "title" || (state === "over" && overReady); }

  // ── V30: arcade attract mode ─────────────────────────────────────────────
  // title idles 10s → score table → demo play (~40s) → GALACTIC HEROES → title
  let demo = false;
  let attract = null; // { phase: "table" | "demo" | "heroes", t }
  let idleT = 0;
  let demoAI = { fireT: 0, beamForced: false, diveForced: false };
  const ATTRACT_TABLE_MS = 8000, ATTRACT_HEROES_MS = 7000, DEMO_MS = 40000;
  function resetWorld() {
    enemies = []; bullets = []; eBullets = []; beams = []; particles = [];
    captureSeq = null; rescueSeq = null; capturedHeld = false; captors = [];
    pendingStageClear = false; fighterCount = 1; dual = false;
    stopBeamHum(); msgClear();
  }
  function attractPhase(ph) {
    attract = { phase: ph, t: 0 };
    window.__attractLog = (window.__attractLog || []).concat(ph);
    if (ph === "demo") {
      demo = true;
      resetWorld();
      score = 0; lives = 3; stage = 1; extrasAt = 99; totalShots = 0; totalHits = 0;
      demoAI = { fireT: 0, beamForced: false, diveForced: false };
      initStars(); spawnPlayer(); beginStage(1);
    } else {
      if (demo) { demo = false; resetWorld(); score = 0; lives = 3; stage = 1; hud(); }
      state = "attract";
      if (player) player.alive = false;
    }
    hideOV();
  }
  function startAttract() { idleT = 0; window.__attractLog = []; attractPhase("table"); }
  function stopAttract() {
    if (!attract) return false;
    const wasDemo = demo;
    attract = null; demo = false;
    resetWorld();
    score = 0; lives = 3; stage = 1; extrasAt = 0; totalShots = 0; totalHits = 0;
    if (player) player.alive = false;
    player = null;
    state = "title"; idleT = 0;
    hud();
    renderHsDom();
    showOV("GALAGA", "INSERT COIN", "BUILD V31 - PRESS SPACE OR TAP");
    window.__attractExit = (window.__attractExit || 0) + 1;
    return wasDemo || true;
  }
  function updateAttract(dt) {
    if (state === "title") { idleT += dt; if (idleT > 10000) startAttract(); return; }
    if (!attract) return;
    attract.t += dt;
    if (attract.phase === "table" && attract.t > ATTRACT_TABLE_MS) attractPhase("demo");
    else if (attract.phase === "demo" && attract.t > DEMO_MS) attractPhase("heroes");
    else if (attract.phase === "heroes" && attract.t > ATTRACT_HEROES_MS) { stopAttract(); window.__attractLoops = (window.__attractLoops || 0) + 1; }
  }
  // Demo pilot: dodge nearby bombs, chase the lowest enemy, fire when lined up,
  // and walk into one tractor beam so the demo shows a capture + rescue attempt.
  function demoPilot(dt) {
    if (!player || !player.alive) return;
    let tx = player.x;
    const beamBoss = enemies.find((e) => e.state === "beam");
    const captive = enemies.find((e) => e.hasCaptive && e.state === "dive");
    const threat = eBullets.filter((b) => b.y < player.y && b.y > player.y - 170 && Math.abs(b.x - player.x) < 36);
    if (beamBoss && fighterCount === 1 && lives > 1 && !capturedHeld) tx = beamBoss.x;
    else if (threat.length) tx = player.x + (threat[0].x > player.x ? -90 : 90);
    else {
      const tgt = captive || enemies.filter((e) => e.state !== "dead" && e.y > 0 && e.y < player.y - 40).sort((a, b) => b.y - a.y)[0];
      if (tgt) tx = tgt.x;
    }
    const spd = 180 * (dt / 1000);
    if (Math.abs(tx - player.x) > 3) player.x += Math.sign(tx - player.x) * Math.min(spd, Math.abs(tx - player.x));
    const margin = fighterCount >= 2 ? 32 : 20;
    player.x = clamp(player.x, margin, VW - margin);
    demoAI.fireT -= dt;
    const lined = enemies.some((e) => e.y < player.y && Math.abs(e.x - player.x) < 18 && !(e.hasCaptive && Math.abs(e.x - player.x) < 6 && e.y > player.y - 120));
    if (demoAI.fireT <= 0 && lined && !(beamBoss && fighterCount === 1 && !capturedHeld)) { demoAI.fireT = 160; fire(); }
    // scripted moments
    if (!demoAI.beamForced && formFull && attract && attract.t > 9000 && state === "play" && !capturedHeld) {
      const b = enemies.find((e) => e.type === "boss" && e.state === "form");
      if (b) { demoAI.beamForced = true; b.forceBeam = true; startDive(b); window.__demoBeam = (window.__demoBeam || 0) + 1; }
    }
    if (capturedHeld && !demoAI.diveForced && state === "play" && attract && attract.t > 22000) {
      const cb = enemies.find((e) => e.hasCaptive && e.state === "form");
      if (cb) { demoAI.diveForced = true; startDive(cb); }
    }
  }
  function drawAttract() {
    if (demo && attract) {
      drawText("DEMO", 21, 1, "#ff0000");
      return;
    }
    if (!attract) return;
    if (attract.phase === "table") {
      drawText("GALAGA", 11, 5, TXT_C);
      drawText("-- SCORE --", 9, 8, TXT_C);
      drawText("FORMATION", 9, 11, TXT_Y); drawText("DIVING", 20, 11, TXT_Y);
      const rows = [["bee", "50", "100"], ["butterfly", "80", "160"], ["boss", "150", "400"]];
      const t = attract.t;
      rows.forEach(([ty, a, d], i) => {
        if (t < 800 + i * 900) return;
        const y = (14 + i * 4) * 8 + 4;
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (ty === "bee") blit(52, y, SPR_BEE[0], 1);
        else if (ty === "butterfly") blit(52, y, SPR_BUTTER[0], 1);
        else blit(52, y, SPR_BOSS[0], 1);
        ctx.restore();
        drawText(a, 15 - a.length, 14 + i * 4, TXT_W);
        drawText(d, 25 - d.length, 14 + i * 4, TXT_W);
      });
      if (t > 3800) {
        drawText("BOSS WITH ESCORTS", 4, 27, TXT_C);
        drawText("800  1600", 13, 29, TXT_W);
      }
      if (t > 4600) drawText("PUSH SPACE OR TAP", 5, 33, TXT_R);
    } else if (attract.phase === "heroes") {
      drawText("GAME OVER", 10, 10, TXT_R);
      for (const l of heroesLines(-1)) drawText(l.t, l.col, l.row, l.color);
    }
  }

  // ── V28: arcade high-score table ("THE GALACTIC HEROES") + initials entry ──
  // Root cause of the V27 bug: there was no initials entry at all — game over
  // went straight to the results/overlay, only a single number was stored,
  // and the font had no J/K/Q/W/X/Z. This implements the arcade flow:
  // joystick left/right cycles the letter, FIRE locks it, three letters.
  const HS_KEY = "galaga_scores_v2";
  const HS_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ. ";
  function loadScores() {
    let t = null;
    try { t = JSON.parse(localStorage.getItem(HS_KEY) || "null"); } catch (_) {}
    if (!Array.isArray(t) || !t.length) t = [0, 1, 2, 3, 4].map(() => ({ s: 20000, n: "N.N" }));
    t = t.filter((r) => r && typeof r.s === "number").map((r) => ({ s: r.s, n: String(r.n || "").slice(0, 3) }));
    while (t.length < 5) t.push({ s: 20000, n: "N.N" });
    return t.sort((a, b) => b.s - a.s).slice(0, 5);
  }
  function saveScores(t) { try { localStorage.setItem(HS_KEY, JSON.stringify(t)); } catch (_) {} }
  let hsTable = loadScores();
  high = Math.max(high, hsTable[0].s);
  function qualifies(sc) { return sc > 0 && sc > hsTable[4].s; }
  let ini = null;
  const ORD = ["1ST", "2ND", "3RD", "4TH", "5TH"];
  function heroesLines(hl) {
    const out = [L("THE GALACTIC HEROES", 4, 19, TXT_R), L("SCORE", 8, 21, TXT_C), L("NAME", 17, 21, TXT_C)];
    hsTable.forEach((r, i) => {
      const c = i === hl ? TXT_Y : TXT_W;
      const sc = String(r.s);
      out.push(L(ORD[i], 3, 23 + i * 2, c), L(sc, 14 - sc.length, 23 + i * 2, c), L(r.n, 17, 23 + i * 2, c));
    });
    return out;
  }
  function startInitials() {
    state = "initials";
    const rank = hsTable.filter((r) => r.s >= score).length;
    ini = { letters: [], cur: 0, rank, t: 0, idle: 0 };
    msgClear();
    drawInitials();
  }
  function drawInitials() {
    if (!ini) return;
    const lines = [
      L("ENTER YOUR INITIALS !", 3, 10, TXT_R),
      L("SCORE", 7, 13, TXT_C), L("NAME", 17, 13, TXT_C),
    ];
    const sc = String(score);
    lines.push(L(sc, 12 - sc.length, 15, TXT_W));
    for (let i = 0; i < 3; i++) {
      const ch = i < ini.letters.length ? ini.letters[i] : i === ini.letters.length ? HS_CHARS[ini.cur] : "";
      const blinkOff = i === ini.letters.length && ((ini.t / 250) | 0) % 2 === 1;
      if (i === ini.letters.length) lines.push(L("_", 17 + i, 16, TXT_Y));
      if (ch && ch !== " " && !blinkOff) lines.push(L(ch, 17 + i, 15, i === ini.letters.length ? TXT_Y : TXT_W));
    }
    lines.push(L("LEFT RIGHT OR TYPE A-Z", 3, 19, TXT_C));
    lines.push(L("FIRE OR ENTER - OK", 5, 21, TXT_C));
    msgLines = lines;
  }
  function iniMove(d) { if (!ini) return; ini.cur = (ini.cur + d + HS_CHARS.length) % HS_CHARS.length; ini.idle = 0; drawInitials(); }
  function iniSet(ch) { if (!ini) return; const k = HS_CHARS.indexOf(ch); if (k >= 0) { ini.cur = k; iniConfirm(); } }
  function iniBack() { if (!ini || !ini.letters.length) return; ini.cur = Math.max(0, HS_CHARS.indexOf(ini.letters.pop())); drawInitials(); }
  function iniConfirm() {
    if (!ini) return;
    ini.letters.push(HS_CHARS[ini.cur]);
    ini.idle = 0;
    if (ini.letters.length >= 3) { finishInitials(); return; }
    drawInitials();
  }
  function finishInitials() {
    const name = ini.letters.join("");
    const rank = ini.rank;
    hsTable.splice(rank, 0, { s: score, n: name });
    hsTable = hsTable.slice(0, 5);
    saveScores(hsTable);
    high = Math.max(high, hsTable[0].s);
    window.__hsSaved = { name, score, rank };
    ini = null;
    state = "over";
    msgRun([
      { lines: heroesLines(rank), f: 300 },
      { lines: [], f: 0, fn: () => { overReady = true; renderHsDom(); showOV("GALAGA", "GAME OVER", "BUILD V31 - PRESS SPACE OR TAP"); } },
    ]);
  }
  function updateInitials(dt) {
    if (state !== "initials" || !ini) return;
    ini.t += dt; ini.idle += dt;
    if (ini.idle > 30000) { while (ini && ini.letters.length < 3) iniConfirm(); return; }
    drawInitials();
  }
  function renderHsDom() {
    if (!overlay) return;
    let el = document.getElementById("hs-table");
    if (!el) { el = document.createElement("div"); el.id = "hs-table"; el.style.cssText = "margin:10px auto;font-size:10px;line-height:1.7;color:#dedede;white-space:pre;text-align:left;display:inline-block"; const oc = document.getElementById("overlay-controls"); overlay.insertBefore(el, oc || null); }
    el.innerHTML = '<div style="color:#f00;text-align:center">THE GALACTIC HEROES</div>' +
      hsTable.map((r, i) => '<div class="hs-row"><span style="color:#0fd">' + ORD[i] + '</span>  ' + String(r.s).padStart(7, " ") + '  <span class="hs-name">' + r.n.replace(/[<>&]/g, "") + '</span></div>').join("");
  }

  // Player lost (or captured) and has ships left: READY 96f, then respawn.
  function readyRespawn() {
    state = "die";
    dieT = Infinity;
    msgAfter([
      { lines: [L("READY", 10, 18)], f: 96 },
      { lines: [], f: 0, fn: () => {
          fighterCount = Math.max(1, fighterCount);
          spawnPlayer();
          invuln = 1500;
          state = "play";
        } },
    ]);
  }

  // Challenging Stage paths: leader track observed frame-by-frame in MAME
  // stage 3 (arcade px, one point per 2 frames; smoothed, extended off-screen).
  const CH_PATHS = {
    W2: [-11.5, 258.7, -6.5, 257.3, -1.5, 255.9, 3.5, 254.5, 8.5, 253.1, 13.5, 251.7, 18.5, 250.2, 23.5, 248.8, 28.5, 247.4, 33.5, 246.0, 38.5, 244.8, 43.5, 243.2, 48.5, 241.8, 53.5, 240.0, 58.5, 238.0, 63.5, 235.8, 68.5, 233.2, 73.5, 230.8, 78.5, 228.0, 83.5, 225.0, 88.5, 222.0, 93.5, 219.0, 98.5, 216.0, 103.5, 212.8, 108.5, 209.0, 113.5, 205.0, 118.5, 201.0, 123.6, 197.0, 128.9, 193.0, 134.0, 188.8, 138.8, 184.0, 142.8, 179.1, 145.8, 174.4, 147.6, 169.4, 148.6, 164.1, 149.0, 159.0, 148.8, 154.0, 148.5, 149.0, 148.5, 144.0, 148.5, 139.0, 148.5, 134.0, 147.9, 129.0, 147.0, 124.0, 147.1, 119.0, 147.5, 114.0, 147.5, 109.0, 147.1, 104.1, 145.6, 99.4, 142.6, 94.6, 138.4, 91.1, 133.5, 90.4, 128.5, 91.5, 123.4, 93.5, 119.1, 97.1, 117.1, 102.4, 116.6, 107.9, 116.5, 113.0, 116.8, 118.0, 117.2, 123.0, 117.5, 128.0, 117.5, 132.6, 117.5, 137.2, 117.5, 142.6, 117.5, 148.0, 117.8, 153.0, 117.9, 158.0, 118.1, 162.9, 120.0, 167.6, 123.4, 172.4, 127.6, 176.4, 132.5, 178.2, 137.5, 177.2, 142.4, 173.9, 146.9, 169.4, 150.8, 164.5, 154.4, 159.5, 158.0, 154.5, 161.4, 149.5, 164.8, 144.5, 168.2, 139.5, 172.0, 134.5, 175.8, 129.5, 179.2, 124.5, 183.0, 119.5, 186.8, 114.5, 190.0, 109.5, 193.2, 104.5, 196.8, 99.5, 200.2, 94.5, 204.0, 89.5, 207.8, 84.5, 211.2, 79.5, 214.5, 74.5, 217.0, 68.9, 219.0, 62.0, 221.6, 56.2, 224.2, 50.3, 226.8, 44.5, 229.3, 38.7, 231.9, 32.8, 234.5, 27.0],
    W3: [238.0, 253.2, 233.0, 252.7, 228.0, 252.3, 223.0, 251.9, 218.0, 251.5, 213.0, 251.2, 208.0, 250.8, 203.0, 250.2, 198.0, 249.5, 193.0, 248.2, 188.0, 246.8, 183.0, 245.5, 178.0, 244.2, 173.0, 242.5, 168.0, 240.5, 163.0, 238.5, 158.0, 236.5, 153.0, 234.2, 147.9, 231.6, 142.6, 228.9, 137.5, 226.0, 132.5, 223.0, 127.5, 220.0, 122.5, 217.0, 117.5, 213.8, 112.5, 210.0, 107.5, 206.0, 102.5, 202.0, 97.8, 198.1, 93.2, 194.4, 88.5, 190.5, 83.5, 186.2, 78.9, 181.2, 75.5, 175.9, 73.6, 170.9, 72.5, 166.0, 71.8, 160.8, 71.5, 155.5, 71.8, 150.8, 72.2, 146.0, 72.5, 141.0, 72.5, 136.0, 72.6, 131.0, 72.8, 125.8, 72.6, 120.5, 72.5, 115.8, 72.8, 111.0, 73.2, 106.0, 74.6, 100.9, 78.2, 95.8, 83.2, 92.0, 88.1, 90.6, 93.1, 91.4, 98.0, 94.5, 101.2, 99.2, 102.6, 104.1, 103.2, 109.0, 103.5, 114.0, 103.5, 119.0, 103.5, 124.0, 103.5, 129.0, 103.5, 134.0, 103.5, 139.0, 103.2, 144.0, 102.8, 149.0, 102.5, 154.0, 102.5, 159.0, 102.2, 164.0, 100.9, 169.1, 97.5, 174.0, 92.8, 177.5, 87.9, 179.1, 82.9, 178.6, 78.0, 175.5, 73.9, 170.6, 70.2, 165.5, 66.8, 160.5, 63.0, 155.5, 59.2, 150.5, 55.8, 145.5, 52.2, 140.5, 48.8, 135.5, 45.0, 130.5, 41.2, 125.5, 37.8, 120.5, 34.2, 115.5, 30.8, 110.5, 27.0, 105.5, 23.2, 100.5, 19.8, 95.5, 16.2, 90.5, 12.8, 85.5, 9.4, 80.5, 6.8, 75.4, 5.0, 70.0, 2.4, 64.8, -0.2, 59.7, -2.8, 54.5, -5.3, 49.3, -7.9, 44.2, -10.5, 39.0],
    W4: [126.5, -11.8, 126.5, -9.4, 126.5, -6.9, 126.5, -4.5, 126.5, -2.0, 126.5, 0.4, 126.5, 2.9, 126.5, 5.3, 126.5, 7.8, 126.5, 10.2, 126.5, 12.7, 126.5, 15.1, 126.5, 17.6, 126.5, 20.0, 126.5, 24.2, 126.5, 29.0, 126.5, 34.0, 126.5, 38.9, 126.5, 43.8, 126.1, 48.9, 125.8, 54.0, 126.1, 59.0, 126.5, 64.0, 126.5, 69.0, 126.5, 74.0, 126.2, 79.0, 125.8, 84.1, 124.9, 89.2, 123.5, 94.0, 122.9, 98.8, 123.0, 103.9, 122.5, 109.0, 121.5, 114.0, 120.5, 119.0, 119.5, 124.0, 118.5, 129.0, 117.2, 134.0, 115.8, 139.0, 114.5, 144.0, 113.2, 149.0, 111.8, 154.0, 110.2, 159.0, 108.5, 164.0, 106.5, 169.0, 104.5, 174.0, 102.8, 179.0, 101.0, 184.0, 98.8, 189.0, 96.5, 194.0, 94.5, 199.0, 92.2, 204.0, 89.6, 208.9, 87.1, 213.4, 84.9, 217.2, 82.1, 220.8, 78.1, 224.6, 73.5, 228.4, 69.5, 230.9, 65.9, 232.4, 62.0, 233.2, 58.0, 233.5, 54.0, 233.2, 49.9, 232.1, 45.6, 229.9, 41.8, 227.1, 38.2, 224.1, 34.9, 220.2, 31.9, 215.8, 29.6, 211.6, 28.4, 207.9, 27.5, 204.0, 27.0, 200.0, 27.6, 196.0, 29.1, 191.9, 31.2, 187.6, 34.1, 183.8, 37.9, 180.1, 42.2, 176.6, 46.2, 174.1, 50.1, 172.4, 54.9, 170.9, 60.0, 169.2, 65.0, 167.1, 70.0, 165.2, 75.0, 163.5, 80.0, 161.8, 85.0, 160.2, 90.0, 158.5, 95.0, 156.5, 100.0, 154.8, 105.0, 153.2, 110.0, 151.5, 115.0, 149.8, 120.0, 148.2, 125.0, 146.5, 130.1, 144.5, 135.2, 142.8, 140.1, 141.2, 145.0, 139.5, 150.0, 137.5, 155.0, 135.8, 160.0, 134.2, 165.0, 132.5, 170.0, 131.1, 175.0, 130.0, 180.0, 127.9, 185.0, 125.5, 190.0, 123.8, 195.0, 122.2, 200.0, 120.5, 205.0, 118.8, 210.0, 117.4, 214.6, 115.8, 218.5, 113.5, 223.0, 111.8, 227.5, 110.0, 232.0, 108.2, 236.5, 106.5],
    W5: [94.5, -11.8, 94.5, -9.4, 94.5, -6.9, 94.5, -4.5, 94.5, -2.0, 94.5, 0.4, 94.5, 2.9, 94.5, 5.3, 94.5, 7.8, 94.5, 10.2, 94.5, 12.7, 94.5, 15.1, 94.5, 17.6, 94.5, 20.0, 94.9, 24.1, 94.9, 28.8, 94.6, 33.9, 94.5, 39.0, 94.5, 44.0, 94.5, 49.0, 94.4, 54.0, 94.2, 59.0, 94.2, 64.0, 94.2, 69.0, 94.6, 74.0, 95.2, 79.0, 95.8, 84.0, 96.6, 89.0, 97.8, 93.9, 98.4, 98.8, 98.5, 103.9, 98.8, 109.0, 99.5, 114.0, 100.5, 119.0, 101.8, 124.0, 103.2, 129.0, 104.5, 133.9, 105.8, 138.8, 107.2, 143.9, 108.9, 149.0, 110.5, 154.0, 111.6, 159.0, 113.0, 163.8, 115.2, 168.5, 117.5, 173.8, 119.5, 179.0, 121.5, 184.0, 123.5, 189.0, 125.8, 194.0, 128.0, 199.0, 130.0, 204.0, 132.4, 208.9, 134.9, 213.4, 137.4, 217.2, 140.6, 220.8, 144.8, 224.6, 149.2, 228.4, 153.4, 230.9, 157.1, 232.1, 161.0, 233.0, 165.0, 233.8, 169.0, 233.5, 173.1, 232.1, 177.4, 229.9, 181.2, 226.9, 184.5, 223.4, 187.6, 219.2, 190.6, 214.8, 192.9, 210.6, 194.1, 206.9, 194.8, 203.0, 195.0, 199.0, 194.5, 195.0, 193.1, 190.9, 190.9, 186.6, 187.9, 182.8, 184.1, 179.4, 179.8, 176.1, 175.6, 173.4, 171.6, 171.6, 167.0, 170.2, 162.0, 168.5, 157.0, 166.8, 152.0, 165.2, 147.0, 163.5, 142.0, 161.8, 137.0, 160.2, 132.0, 158.5, 127.0, 156.8, 122.0, 155.2, 117.0, 153.5, 112.0, 151.8, 107.0, 150.2, 102.0, 148.5, 97.0, 146.8, 92.0, 145.2, 87.0, 143.5, 81.9, 141.5, 76.8, 139.8, 71.9, 138.2, 67.0, 136.5, 62.0, 134.8, 57.0, 133.2, 52.0, 131.5, 47.0, 129.8, 41.9, 128.2, 36.8, 126.5, 31.9, 124.8, 27.0, 123.2, 22.0, 121.5, 17.0, 119.6, 12.0, 118.0, 7.6, 116.5, 4.5, 115.0, 0.3, 113.5, -3.8, 111.9, -8.0, 110.4, -12.2, 108.8],
  };
  const CH_SHIP_GAP = 8; // frames between ships in a line (20 px at ~2.5 px/frame)
  // Lines: [path, first-appearance frame after CHALLENGING STAGE clears, ships]
  const CH_WAVES = [
    [["W5", 12, 4, "bee"], ["W4", 12, 4, "bee"]],
    [["W2", 314, 8, "mix"]],
    [["W3", 622, 8, "bee"]],
    [["W4", 940, 8, "bee"]],
    [["W5", 1260, 8, "bee"]],
  ];
  // V27: each Challenging Stage gets its own pattern (variant by index, cycles).
  function chFlat(shp) { const a = []; for (const p of shp.pts) a.push(p.x, p.y); return a; }
  function chLoopPath(x, y, hdg, segs) {
    // extend so the train leaves the screen
    const r = arcPath(x, y, hdg, segs.concat([{ line: 320 }]));
    return chFlat(r);
  }
  function chMirror(p) { const a = p.slice(); for (let i = 0; i < a.length; i += 2) a[i] = 224 - a[i]; return a; }
  // V28: the arcade has 8 Challenging Stages (3,7,11,...,31, then repeat),
  // each built around one enemy type plus four Boss Galagas, 5 waves of 8.
  // Themes per Namco wiki: Zako, Goei, Tonbo, Ogawamushi, Momiji, Ei,
  // Galboss, Spaceship. Pattern #1 is the MAME-observed stage-3 track;
  // the flight shapes of #2–#8 are hand-authored approximations.
  const CH_VARIANTS = (() => {
    const R = Math.PI / 180;
    const v = [];
    const T = (waves, theme) => waves.map((ln) => ln.map(([p, f, n, k]) => [p, f, n, k === "T" ? theme : k]));
    const STD = [[["W5", 12, 4, "T"], ["W4", 12, 4, "T"]], [["W2", 314, 8, "mix"]], [["W3", 622, 8, "T"]], [["W4", 940, 8, "T"]], [["W5", 1260, 8, "T"]]];
    v.push({ name: "ZAKO", paths: CH_PATHS, waves: T(STD, "bee") });
    const M = {}; for (const k in CH_PATHS) M[k] = chMirror(CH_PATHS[k]);
    v.push({ name: "GOEI", paths: M, waves: T([[["W5", 12, 4, "T"], ["W4", 12, 4, "T"]], [["W3", 314, 8, "mix"]], [["W2", 622, 8, "T"]], [["W5", 940, 8, "T"]], [["W4", 1260, 8, "T"]]], "butterfly") });
    const P3 = {
      A: chLoopPath(-12, 60, 10 * R, [{ line: 60 }, { r: 44, turn: 330 * R }, { line: 40 }, { r: 30, turn: -120 * R }]),
      B: chLoopPath(236, 60, 170 * R, [{ line: 60 }, { r: 44, turn: -330 * R }, { line: 40 }, { r: 30, turn: 120 * R }]),
      C: chLoopPath(60, -12, 90 * R, [{ line: 80 }, { r: 40, turn: -270 * R }, { line: 30 }, { r: 40, turn: 200 * R }]),
      D: chLoopPath(164, -12, 90 * R, [{ line: 80 }, { r: 40, turn: 270 * R }, { line: 30 }, { r: 40, turn: -200 * R }]),
    };
    v.push({ name: "TONBO", paths: P3, waves: T([[["A", 12, 4, "T"], ["B", 12, 4, "T"]], [["C", 314, 8, "mix"]], [["D", 622, 8, "T"]], [["A", 940, 8, "T"]], [["B", 1260, 8, "T"]]], "tonbo") });
    const P4 = {
      A: chLoopPath(-12, 250, -30 * R, [{ line: 50 }, { r: 26, turn: -120 * R }, { r: 26, turn: 220 * R }, { r: 30, turn: -200 * R }]),
      B: chLoopPath(236, 250, 210 * R, [{ line: 50 }, { r: 26, turn: 120 * R }, { r: 26, turn: -220 * R }, { r: 30, turn: 200 * R }]),
      C: chLoopPath(112, -12, 90 * R, [{ line: 40 }, { r: 24, turn: 360 * R }, { line: 30 }, { r: 24, turn: -360 * R }, { r: 50, turn: 60 * R }]),
    };
    v.push({ name: "OGAWAMUSHI", paths: P4, waves: T([[["C", 12, 8, "T"]], [["A", 314, 4, "mix"], ["B", 314, 4, "mix"]], [["A", 622, 8, "T"]], [["B", 940, 8, "T"]], [["C", 1260, 8, "T"]]], "ogawa") });
    const P5 = { // corkscrews in from the sides, exit top
      A: chLoopPath(-12, 150, -10 * R, [{ line: 40 }, { r: 20, turn: -360 * R }, { line: 40 }, { r: 20, turn: 360 * R }, { line: 20 }, { r: 40, turn: -80 * R }]),
      B: chLoopPath(236, 150, 190 * R, [{ line: 40 }, { r: 20, turn: 360 * R }, { line: 40 }, { r: 20, turn: -360 * R }, { line: 20 }, { r: 40, turn: 80 * R }]),
      C: chLoopPath(30, -12, 70 * R, [{ line: 90 }, { r: 36, turn: -250 * R }, { line: 40 }]),
      D: chLoopPath(194, -12, 110 * R, [{ line: 90 }, { r: 36, turn: 250 * R }, { line: 40 }]),
    };
    v.push({ name: "MOMIJI", paths: P5, waves: T([[["C", 12, 4, "T"], ["D", 12, 4, "T"]], [["A", 314, 8, "mix"]], [["B", 622, 8, "T"]], [["C", 940, 8, "T"]], [["D", 1260, 8, "T"]]], "momiji") });
    const P6 = { // wide U sweeps from the top corners
      A: chLoopPath(10, -12, 80 * R, [{ line: 120 }, { r: 50, turn: -180 * R }, { line: 60 }, { r: 30, turn: 140 * R }]),
      B: chLoopPath(214, -12, 100 * R, [{ line: 120 }, { r: 50, turn: 180 * R }, { line: 60 }, { r: 30, turn: -140 * R }]),
      C: chLoopPath(-12, 230, -60 * R, [{ line: 70 }, { r: 60, turn: 120 * R }, { line: 40 }]),
      D: chLoopPath(236, 230, 240 * R, [{ line: 70 }, { r: 60, turn: -120 * R }, { line: 40 }]),
    };
    v.push({ name: "EI", paths: P6, waves: T([[["A", 12, 4, "T"], ["B", 12, 4, "T"]], [["C", 314, 4, "mix"], ["D", 314, 4, "mix"]], [["A", 622, 8, "T"]], [["B", 940, 8, "T"]], [["C", 1260, 4, "T"], ["D", 1260, 4, "T"]]], "ei") });
    const P7 = { // figure-eights through the centre
      A: chLoopPath(-12, 100, 0, [{ line: 70 }, { r: 30, turn: 360 * R }, { line: 20 }, { r: 30, turn: -360 * R }, { line: 20 }]),
      B: chLoopPath(236, 100, Math.PI, [{ line: 70 }, { r: 30, turn: -360 * R }, { line: 20 }, { r: 30, turn: 360 * R }, { line: 20 }]),
      C: chLoopPath(112, -12, 90 * R, [{ line: 60 }, { r: 34, turn: 330 * R }, { r: 34, turn: -330 * R }, { line: 20 }]),
    };
    v.push({ name: "GALBOSS", paths: P7, waves: T([[["C", 12, 8, "T"]], [["A", 314, 8, "mix"]], [["B", 622, 8, "T"]], [["A", 940, 4, "T"], ["B", 940, 4, "T"]], [["C", 1260, 8, "T"]]], "galboss") });
    const P8 = { // zig-zag traverses
      A: chLoopPath(-12, 60, 30 * R, [{ line: 50 }, { r: 20, turn: -120 * R }, { line: 40 }, { r: 20, turn: 120 * R }, { line: 40 }, { r: 20, turn: -120 * R }, { line: 40 }, { r: 20, turn: 120 * R }]),
      B: chLoopPath(236, 60, 150 * R, [{ line: 50 }, { r: 20, turn: 120 * R }, { line: 40 }, { r: 20, turn: -120 * R }, { line: 40 }, { r: 20, turn: 120 * R }, { line: 40 }, { r: 20, turn: -120 * R }]),
      C: chLoopPath(-12, 260, -40 * R, [{ line: 90 }, { r: 30, turn: 260 * R }, { line: 60 }]),
      D: chLoopPath(236, 260, 220 * R, [{ line: 90 }, { r: 30, turn: -260 * R }, { line: 60 }]),
    };
    v.push({ name: "SPACESHIP", paths: P8, waves: T([[["A", 12, 4, "T"], ["B", 12, 4, "T"]], [["C", 314, 8, "mix"]], [["D", 622, 8, "T"]], [["A", 940, 8, "T"]], [["B", 1260, 8, "T"]]], "ship") });
    return v;
  })();
  let chVar = CH_VARIANTS[0];
  let chClock = 0; // frames of challenge play
  function chAppear(path) {
    for (let i = 0; i < path.length / 2; i++) {
      const x = path[2 * i], y = path[2 * i + 1];
      if (x >= 0 && x <= 224 && y >= 16 && y <= 252) return i;
    }
    return 0;
  }
  function chPos(path, idx) {
    const n = path.length / 2;
    const i = Math.max(0, Math.min(n - 2, Math.floor(idx)));
    const t = Math.max(0, Math.min(1, idx - i));
    const x0 = path[2 * i], y0 = path[2 * i + 1], x1 = path[2 * i + 2], y1 = path[2 * i + 3];
    return { x: (x0 + (x1 - x0) * t) * 2, y: (y0 + (y1 - y0) * t) * 2, a: Math.atan2(y1 - y0, x1 - x0) };
  }

  function flashMsg(text, ms) {
    // V26: arcade shows no pop-up captions; centre text belongs to the sequencer
  }

  // ── Entities ─────────────────────────────────────────────────────────────
  function spawnPlayer() {
    if (fighterCount < 1) fighterCount = 1;
    player = {
      x: VW / 2,
      y: VH - 47,
      w: 28,
      alive: true,
    };
    syncFighters();
    invuln = 2000;
    hud();
  }

  function enemyScore(e, diving) {
    if (e.type === "hostile") return 1000;
    if (e.xchild) return 160;
    if (e.type === "bee") return diving ? 100 : 50;
    if (e.type === "butterfly") return diving ? 160 : 80;
    if (e.type === "tonbo" || e.type === "momiji" || e.type === "ship") return 160;
    if (e.type === "ogawa" || e.type === "ei") return 100;
    if (e.type === "galboss") return 150;
    // boss
    if (diving) {
      if (e.escorts >= 2) return 1600;
      if (e.escorts >= 1) return 800;
      return 400;
    }
    return 150;
  }

  function makeEnemy(type, slot, enterDelay) {
    const path = entryPath(slot, enterDelay);
    return {
      type,
      slot,
      hp: type === "boss" ? 2 : 1,
      state: "enter", // enter | form | dive | beam | dead
      x: path[0].x,
      y: path[0].y,
      angle: 0,
      path,
      pathI: 0,
      pathT: 0,
      formWait: 0,
      divePath: null,
      diveI: 0,
      diveT: 0,
      shootT: rnd(400, 1200),
      flap: Math.random() * 100,
      escorts: 0,
      hasCaptive: false,
      captiveAngle: 0,
      id: Math.random(),
      enterDelay,
    };
  }

  // ── Arcade entry choreography (observed frame-by-frame in MAME 'galaga') ──
  // Wave 1: two 4-ship trains drop in from the top centre and peel apart
  //         (butterflies right, bees left), dip, loop and climb home.
  // Wave 2: bosses interleaved with butterflies sweep in from bottom-left.
  // Wave 3: 8 butterflies from bottom-right (mirror of wave 2).
  // Wave 4: 8 bees from the top-right; Wave 5: 8 bees from the top-left.
  // Built in arcade pixels (224x288) then scaled x2.
  function arcPath(x, y, hdg, segs) {
    const pts = [{ x, y }];
    for (const sg of segs) {
      if (sg.line) {
        const n = Math.max(2, Math.round(sg.line / 4));
        for (let i = 1; i <= n; i++) pts.push({ x: x + Math.cos(hdg) * sg.line * i / n, y: y + Math.sin(hdg) * sg.line * i / n });
        x += Math.cos(hdg) * sg.line; y += Math.sin(hdg) * sg.line;
      } else {
        const n = Math.max(4, Math.round(Math.abs(sg.turn) * sg.r / 4));
        const dir = Math.sign(sg.turn);
        const cx = x + Math.cos(hdg + dir * Math.PI / 2) * sg.r;
        const cy = y + Math.sin(hdg + dir * Math.PI / 2) * sg.r;
        const a0 = Math.atan2(y - cy, x - cx);
        for (let i = 1; i <= n; i++) {
          const a = a0 + sg.turn * i / n;
          pts.push({ x: cx + Math.cos(a) * sg.r, y: cy + Math.sin(a) * sg.r });
        }
        hdg += sg.turn; x = pts[pts.length - 1].x; y = pts[pts.length - 1].y;
      }
    }
    return { pts, x, y, hdg };
  }
  const D2R = Math.PI / 180;
  // V27: difficulty ramp (capped so it stays playable)
  function diff() {
    const k = Math.max(0, stage - 1);
    return {
      diveGap: Math.max(900, 3400 - k * 160),          // ms between dive launches
      maxDivers: Math.min(4, 1 + Math.floor(k / 3)),    // simultaneous launches
      extraP: Math.min(0.75, 0.25 + k * 0.05),
      shootBase: Math.max(520, 1100 - k * 45),          // dive shot interval
      bulletVy: Math.min(130, 72 + k * 4),
      bulletAim: Math.min(0.11, 0.06 + k * 0.004),
      speed: Math.min(1.45, 1 + k * 0.035),              // dive / entry speed mult
      bossP: Math.min(0.5, 0.22 + k * 0.025),           // boss dive pick chance
      escorts: Math.min(3, 2 + Math.floor(k / 6)),
      escortR: Math.min(150, 90 + k * 5),
      beamP: Math.min(1, 0.55 + k * 0.06),              // chance a boss dive is a beam dive
    };
  }
  window.__diff = diff;
  let entrySet = 0; // always the observed arcade shapes
  let entryFire = [0, 0, 0, 0, 0];
  let lastAttack = false; // V28: last few enemies stop returning and attack
  function waveShape(wave, side) {
    // side: -1 = left-hand train/mirror, +1 = right-hand
    const s = side;
    if (wave === 0 || wave === 3 || wave === 4) {
      const x0 = wave === 0 ? 112 + s * 8 : 112 + s * 40;
      return arcPath(x0, -12, 90 * D2R, [
        { line: 40 },
        { r: 34, turn: -s * 60 * D2R },
        { line: 30 },
        { r: 26, turn: -s * 200 * D2R },
        { line: 20 },
      ]);
    }
    // waves 1 & 2: from bottom edge corner, sweep inward and loop up
    return arcPath(s < 0 ? -12 : 236, 236, (s < 0 ? -20 : 200) * D2R, [
      { line: 40 },
      { r: 36, turn: s * 250 * D2R },
      { line: 16 },
    ]);
  }
  // V28: documented arcade entrance patterns (StrategyWiki walkthrough +
  // per-stage tables published by players). Spawn points: A = top-left of
  // centre, B = top-right, C = bottom-left, D = bottom-right.
  //   "C" single file, one side at a time (stage 1, then 6, 10, 14, 18 ...)
  //   "B" double-width rows from one side at a time (stage 2, 5, 9, 13 ...)
  //   "A" both sides at once (stage 4, 8, 12, 16 ...) — the hardest
  // Wave contents are fixed: 1 Goei+Zako from A/B, 2 Boss+Goei from C(/D),
  // 3 Goei from D(/C), 4 Zako from B(/A), 5 Zako from A(/B).
  function stagePattern(n) {
    if (n === 1) return "C";
    if (n === 2) return "B";
    if (n === 3) return "CS";
    return ["A", "B", "C", "CS"][(n - 4) % 4];
  }
  // Pre-challenge "service" stages: no shots during the entrance, no rammers.
  function serviceStage(n) { return n === 1 || (n >= 10 && (n - 10) % 8 === 0); }
  // Extra entrants that break off and ram the player instead of joining the
  // formation (documented from stage 4 on: ~1 per train, 2 from stage 13).
  function rammersPerTrain(n, single) {
    if (n < 4 || serviceStage(n)) return 0;
    const r = n < 13 ? 1 : 2;
    return single ? r * (n >= 14 ? 2 : 1) : r;
  }
  function entryShots(n) { return serviceStage(n) ? 0 : n < 16 ? 3 + (n % 2) : 6 + (n % 3); }
  function entryPath(slot) {
    const dest = slotPos(slot, 0);
    const shp = waveShape(slot.shape != null ? slot.shape : slot.wave || 0, slot.side || 1);
    const pts = shp.pts.map((p) => ({ x: p.x * 2, y: p.y * 2 }));
    if (slot.lane) {
      // double-width row: second train flies beside the first
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
        pts[i] = { x: pts[i].x - (dy / l) * 32 * slot.lane, y: pts[i].y + (dx / l) * 32 * slot.lane };
      }
    }
    // glide home (quadratic toward the slot, keeping the exit heading)
    const L = pts[pts.length - 1];
    const cx = L.x + Math.cos(shp.hdg) * 60, cy = L.y + Math.sin(shp.hdg) * 60;
    for (let i = 1; i <= 24; i++) {
      const t = i / 24;
      pts.push({
        x: (1 - t) * (1 - t) * L.x + 2 * (1 - t) * t * cx + t * t * dest.x,
        y: (1 - t) * (1 - t) * L.y + 2 * (1 - t) * t * cy + t * t * dest.y,
      });
    }
    return pts;
  }
  // Slot plan per wave: [type,row,col] lists in train order
  function entryPlan() {
    const W = [[], [], [], [], []];
    const B = (r, c) => ["butterfly", r, c], E = (r, c) => ["bee", r, c], G = (c) => ["boss", 0, c];
    W[0] = [[B(1, 4), B(2, 4), B(1, 5), B(2, 5)], [E(3, 4), E(4, 4), E(3, 5), E(4, 5)]];
    W[1] = [[G(3), B(1, 3), G(4), B(2, 3), G(5), B(1, 6), G(6), B(2, 6)]];
    W[2] = [[B(1, 1), B(2, 1), B(1, 2), B(2, 2), B(1, 7), B(2, 7), B(1, 8), B(2, 8)]];
    W[3] = [[E(3, 6), E(4, 6), E(3, 7), E(4, 7), E(3, 8), E(4, 8), E(3, 9), E(4, 9)]];
    W[4] = [[E(3, 0), E(4, 0), E(3, 1), E(4, 1), E(3, 2), E(4, 2), E(3, 3), E(4, 3)]];
    return W;
  }
  const WAVE_GAP = 2000; // ms between waves (MAME: ~120 frames)
  const TRAIN_GAP = 110; // ms between ships in a train (~7 frames)

  function divePathFor(e, opts) {
    opts = opts || {};
    const pts = [];
    const sx = e.x;
    const sy = e.y;
    const aimX = player ? player.x : VW / 2;
    const targetX = opts.beamDive ? aimX : aimX + rnd(-36, 36);
    const side = e.slot.col < 5 ? -1 : 1;
    // leave formation with a deliberate loop
    for (let i = 0; i <= 28; i++) {
      const t = i / 28;
      const a = t * Math.PI;
      pts.push({
        x: sx + Math.sin(a) * 42 * side,
        y: sy - Math.sin(a) * 28,
      });
    }
    // Beam altitude must be close enough that cone reaches the player (y≈VH-48)
    // Player ~528; cone ~240 → boss should sit around y 280–320
    const midY = opts.beamDive ? Math.min(VH * 0.52, (player ? player.y : VH - 48) - 200) : VH * 0.55;
    for (let i = 1; i <= 48; i++) {
      const t = i / 48;
      pts.push({
        x: lerp(sx, targetX, t) + (opts.beamDive ? 0 : Math.sin(t * Math.PI * 2) * 26),
        y: lerp(sy, midY, t),
      });
    }
    if (opts.beamDive) {
      // Freeze marker: end of approach (before home path)
      e.beamAtIndex = pts.length - 1;
      e.beamTargetY = midY;
      const home = slotPos(e.slot, 0);
      for (let i = 1; i <= 40; i++) {
        const t = i / 40;
        pts.push({
          x: lerp(targetX, home.x, t),
          y: lerp(midY, home.y, t * t),
        });
      }
    } else {
      const exitX = chance(0.5) ? -40 : VW + 40;
      for (let i = 1; i <= 36; i++) {
        const t = i / 36;
        pts.push({
          x: lerp(targetX, exitX, t),
          y: lerp(midY, VH + 40, t * 0.85 + 0.15),
        });
      }
    }
    return pts;
  }

  /** Smooth path follower: advances along polyline at speed (px/s). Returns true when finished. */
  function followPath(e, path, dt, speed) {
    if (!path || path.length < 2) return true;
    if (e.pathPos == null) e.pathPos = 0;
    let distLeft = speed * (dt / 1000);
    while (distLeft > 0 && e.pathPos < path.length - 1) {
      const i = e.pathPos | 0;
      const a = path[i];
      const b = path[i + 1];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y) || 0.001;
      const frac = e.pathPos - i;
      const along = frac * segLen;
      const remain = segLen - along;
      if (distLeft < remain) {
        const t = (along + distLeft) / segLen;
        e.x = lerp(a.x, b.x, t);
        e.y = lerp(a.y, b.y, t);
        e.angle = Math.atan2(b.y - a.y, b.x - a.x);
        e.pathPos += distLeft / segLen;
        distLeft = 0;
      } else {
        distLeft -= remain;
        e.pathPos = i + 1;
        e.x = b.x;
        e.y = b.y;
        e.angle = Math.atan2(b.y - a.y, b.x - a.x);
      }
    }
    return e.pathPos >= path.length - 1;
  }

  // Tractor cone: reaches from boss down to near the fighter row
  // ── Tractor beam (measured in MAME 'galaga', 60 fps) ─────────────────────
  // Boss hovers; the beam grows down from it for ~96 frames (1.6 s) until it
  // reaches the fighter row, holds ~1.6 s, then retracts ~1 s. Its width is
  // fixed: ~40 arcade px (80 here) at the bottom. A fighter is only caught if
  // its centre stays inside that span after the beam has reached its row
  // (~24 frames / 0.4 s). Moving out first escapes. No pull, no tracking.
  const BEAM_EXTEND = 1600, BEAM_HOLD = 1600, BEAM_RETRACT = 1000;
  const BEAM_TOP_HALF = 16, BEAM_BOT_HALF = 40, BEAM_CATCH_MS = 400;
  function beamFullLen(e) {
    return Math.max(80, (player ? player.y : VH - 52) + 16 - (e.y + 14));
  }
  function beamLenNow(e) {
    const t = e.beamT || 0, full = beamFullLen(e);
    if (t < BEAM_EXTEND) return full * (t / BEAM_EXTEND);
    if (t < BEAM_EXTEND + BEAM_HOLD) return full;
    return full * Math.max(0, 1 - (t - BEAM_EXTEND - BEAM_HOLD) / BEAM_RETRACT);
  }
  function beamConeHalf(e, dy) {
    const coneLen = beamFullLen(e);
    const t = clamp(dy / coneLen, 0, 1);
    return { half: BEAM_TOP_HALF + t * (BEAM_BOT_HALF - BEAM_TOP_HALF), coneLen };
  }
  function playerInBeamCone(e) {
    if (!player || !player.alive) return false;
    const t = e.beamT || 0;
    if (t < BEAM_EXTEND || t > BEAM_EXTEND + BEAM_HOLD) return false;
    const dy = player.y - (e.y + 14);
    if (dy < 8 || dy > beamLenNow(e) + 4) return false;
    const { half } = beamConeHalf(e, dy);
    return Math.abs(player.x - e.x) <= half;
  }

  function beginTractorBeam(e) {
    if (e.state === "beam" || e.hasCaptive || capturedHeld || captureSeq) return;
    if (!player || !player.alive) return;
    e.state = "beam";
    e.beamT = 0;
    e.beamDuration = BEAM_EXTEND + BEAM_HOLD + BEAM_RETRACT;
    e.captureHold = 0;
    e.beamOpen = 0; // 0→1 open animation
    e.angle = Math.PI / 2;
    // Hover where the dive put it (no snapping over the player)
    e.y = clamp(player.y - 178, FORM_OY + 50, player.y - 140); // MAME: boss ~89 px above fighter
    e.x = clamp(e.x, 40, VW - 40);
    beams = beams.filter((b) => b.enemy !== e);
    beams.push({
      enemy: e,
      life: e.beamDuration,
      x: e.x,
      y: e.y,
      maxLife: e.beamDuration,
    });
    sfx("beam");
  }

  /**
   * Original-style capture sequence (one fighter only):
   * 1) lock — beam open
   * 2) pull — that fighter dragged up, white→red
   * 3) attach — dock under boss
   * 4) haul — boss returns to formation with captive
   * 5) solo ship captured: costs one of 3 stock fighters; respawn if any left, else game over.
   *    dual/triple: only one wingman taken; remaining keep playing (no stock life lost).
   */
  function startCaptureSequence(boss) {
    if (!player || !player.alive || captureSeq || capturedHeld) return;
    if (!boss || boss.state === "dead") return;
    if (invuln > 0 && (boss.beamT || 0) < 350) return;
    if (fighterCount < 1) return;

    const hadMulti = fighterCount > 1;
    const takeSide = fighterCount >= 2 ? (chance(0.5) ? -1 : 1) : 0;
    const capX = player.x + takeSide * (fighterCount >= 3 ? 28 : 22);
    const capY = player.y;

    fighterCount -= 1;
    syncFighters();

    captureSeq = {
      phase: "lock",
      t: 0,
      age: 0,
      boss,
      fx: capX,
      fy: capY,
      startX: capX,
      startY: capY,
      red: 0,
      beamPulse: 0,
      partial: hadMulti,
      fromDual: hadMulti,
      attached: false,
      lifeTaken: false,
    };

    boss.captureOwned = true;
    boss.angle = Math.PI / 2;
    boss.beamOpen = 1;
    boss.state = "beam";

    if (hadMulti) {
      state = "play";
      invuln = 1200;
      sfx("capture");
      msgAfter([{ lines: [L("FIGHTER CAPTURED", 5, 19, TXT_R)], f: 160 }, { lines: [], f: 0 }]);
    } else {
      player.alive = false;
      player.capturing = true;
      state = "capture";
      bullets = [];
      eBullets = [];
      sfx("capture");
    }
  }

  function snapBossToFormation(boss) {
    if (!boss) return;
    const fp = slotPos(boss.slot, formSway);
    boss.x = fp.x;
    boss.y = fp.y;
    boss.angle = Math.PI / 2;
    boss.state = "form";
    boss.returnPath = null;
    boss.divePath = null;
    boss.pathPos = 0;
    boss.captureOwned = false;
  }

  function finishCaptureHaul(seq) {
    const boss = seq.boss;
    if (!boss || boss.state === "dead") {
      // CRITICAL: never null captureSeq while state may be "capture"
      seq.phase = "resolve";
      seq.t = 0;
      seq.attached = false;
      capturedHeld = false;
      stopBeamHum();
      beams = beams.filter((b) => b.enemy !== boss);
      return;
    }
    boss.hasCaptive = true;
    capturedHeld = true;
    boss.willBeam = false;
    boss.beamed = true;
    boss.captureOwned = true;
    boss.state = "return";
    boss.pathPos = 0;
    boss.angle = Math.PI / 2;
    const home = slotPos(boss.slot, formSway);
    boss.returnPath = [];
    for (let i = 0; i <= 56; i++) {
      const t = i / 56;
      boss.returnPath.push({
        x: lerp(boss.x, home.x, t),
        y: lerp(boss.y, home.y, t * t),
      });
    }
    stopBeamHum();
    beams = beams.filter((b) => b.enemy !== boss);
  }

  function resolveSoloCapture(seq) {
    if (!seq.lifeTaken) {
      seq.lifeTaken = true;
      lives = Math.max(0, lives - 1);
      hud();
    }
    captureSeq = null;
    beams = beams.filter((b) => !(seq.boss && b.enemy === seq.boss));
    stopBeamHum();
    if (seq.boss && seq.boss.state !== "dead") {
      seq.boss.captureOwned = false;
    }
    if (lives > 0) {
      fighterCount = 1;
      readyRespawn();
    } else {
      gameOver();
    }
  }

  function endPartialCapture(seq) {
    captureSeq = null;
    stopBeamHum();
    beams = beams.filter((b) => !(seq.boss && b.enemy === seq.boss));
    if (seq.boss && seq.boss.state !== "dead") {
      seq.boss.captureOwned = false;
    }
    if (pendingStageClear && enemies.length === 0 && state === "play") {
      doStageClear();
    }
  }

  /** V20: absolute escape hatch — never remain soft-locked in capture */
  function forceResolveCapture(reason) {
    const seq = captureSeq;
    stopBeamHum();
    if (seq && seq.boss && seq.boss.state !== "dead") {
      const docked =
        seq.attached ||
        seq.phase === "haul" ||
        seq.phase === "attach" ||
        seq.phase === "respawn" ||
        (seq.phase === "pull" && seq.t > 900);
      seq.boss.captureOwned = false;
      if (docked) {
        seq.boss.hasCaptive = true;
        capturedHeld = true;
        if (seq.boss.state !== "form") {
          snapBossToFormation(seq.boss);
          seq.boss.hasCaptive = true;
        }
      } else if (seq.boss.state === "beam" || seq.boss.state === "return") {
        snapBossToFormation(seq.boss);
      }
    }
    beams = beams.filter((b) => !(seq && seq.boss && b.enemy === seq.boss));
    if (seq && seq.partial) {
      endPartialCapture(seq);
      return;
    }
    if (seq) {
      if (!seq.lifeTaken && state === "capture") {
        seq.lifeTaken = true;
        lives = Math.max(0, lives - 1);
        hud();
      }
      captureSeq = null;
    } else {
      captureSeq = null;
    }
    for (const e of enemies) {
      if (e.captureOwned) e.captureOwned = false;
    }
    if (state === "capture") {
      if (lives > 0) {
        fighterCount = Math.max(1, fighterCount);
        readyRespawn();
      } else {
        gameOver();
      }
    }
  }

  function updateCaptureSequence(dt) {
    if (!captureSeq) return;
    const seq = captureSeq;
    const boss = seq.boss;
    seq.t += dt;
    seq.age = (seq.age || 0) + dt;
    seq.beamPulse += dt;

    // Absolute soft-lock breaker (any phase) — V20: tighter than V14's 14s
    if (seq.age > 7500) {
      stopBeamHum();
      beams = beams.filter((b) => !(boss && b.enemy === boss));
      if (boss && boss.state !== "dead") {
        boss.captureOwned = false;
        if (seq.attached || seq.phase === "haul" || seq.phase === "attach") {
          boss.hasCaptive = true;
          capturedHeld = true;
          snapBossToFormation(boss);
          boss.hasCaptive = true;
        } else {
          snapBossToFormation(boss);
        }
      }
      if (seq.partial) {
        endPartialCapture(seq);
      } else {
        seq.phase = "resolve";
        seq.t = 0;
      }
      return;
    }

    // V20: per-phase ceilings so a single phase cannot stall forever
    const phaseMax = { lock: 900, pull: 3200, attach: 1200, haul: 5000, respawn: 2000, resolve: 1200 };
    if (phaseMax[seq.phase] != null && seq.t > phaseMax[seq.phase]) {
      if (seq.phase === "lock") {
        seq.phase = "pull";
        seq.t = 0;
        seq.startX = seq.fx;
        seq.startY = seq.fy;
      } else if (seq.phase === "pull") {
        seq.phase = "attach";
        seq.t = 0;
        if (boss) {
          seq.fx = boss.x;
          seq.fy = boss.y + 26;
        }
        seq.red = 1;
      } else if (seq.phase === "attach") {
        seq.phase = "haul";
        seq.t = 0;
        finishCaptureHaul(seq);
        if (captureSeq && captureSeq.phase === "haul") seq.attached = true;
      } else if (seq.phase === "haul") {
        if (boss && boss.state !== "dead") {
          snapBossToFormation(boss);
          boss.hasCaptive = true;
          capturedHeld = true;
        }
        beams = beams.filter((b) => !(boss && b.enemy === boss));
        if (seq.partial) {
          endPartialCapture(seq);
        } else {
          seq.phase = "respawn";
          seq.t = 0;
        }
        return;
      } else if (seq.phase === "respawn" || seq.phase === "resolve") {
        if (seq.partial) endPartialCapture(seq);
        else resolveSoloCapture(seq);
        return;
      }
    }

    if (boss && boss.state === "dead" && seq.phase !== "resolve" && seq.phase !== "respawn") {
      const almostDocked =
        seq.phase === "attach" || seq.phase === "haul" || (seq.phase === "pull" && seq.t > 900);
      capturedHeld = false;
      stopBeamHum();
      beams = beams.filter((b) => b.enemy !== boss);
      if (almostDocked && seq.partial && player && player.alive && !rescueSeq) {
        startRescueSequence(seq.fx || boss.x, seq.fy || boss.y + 24);
        endPartialCapture(seq);
        return;
      }
      seq.phase = "resolve";
      seq.t = 0;
    }

    if (
      boss &&
      boss.state !== "dead" &&
      (seq.phase === "lock" || seq.phase === "pull" || seq.phase === "attach")
    ) {
      boss.state = "beam";
      boss.angle = Math.PI / 2;
      boss.beamOpen = 1;
      boss.captureOwned = true;
      if (!beams.some((b) => b.enemy === boss)) {
        beams.push({ enemy: boss, life: 9999, x: boss.x, y: boss.y, maxLife: 9999 });
      }
      for (const b of beams) {
        if (b.enemy === boss) {
          b.x = boss.x;
          b.y = boss.y;
          b.life = 9999;
        }
      }
      // V20: renew only when hum inactive (startBeamHum sets beamActive)
      if (!beamActive) {
        sfx("beam_loop");
      }
    }

    if (seq.phase === "lock") {
      if (!boss || boss.state === "dead") {
        seq.phase = "resolve";
        seq.t = 0;
        return;
      }
      const dur = 450;
      const u = clamp(seq.t / dur, 0, 1);
      seq.fx = lerp(seq.startX, boss.x, u * 0.85);
      seq.fy = seq.startY;
      seq.red = u * 0.15;
      if (seq.t >= dur) {
        seq.phase = "pull";
        seq.t = 0;
        seq.startX = seq.fx;
        seq.startY = seq.fy;
        sfx("beam");
      }
    } else if (seq.phase === "pull") {
      if (!boss || boss.state === "dead") {
        seq.phase = "resolve";
        seq.t = 0;
        return;
      }
      const dur = 2000;
      const u = clamp(seq.t / dur, 0, 1);
      const ease = u * u * (3 - 2 * u);
      const attachY = boss.y + 28;
      seq.fx = lerp(seq.startX, boss.x, ease);
      seq.fy = lerp(seq.startY, attachY, ease);
      seq.red = 0.15 + ease * 0.85;
      if (Math.random() < 0.35) {
        particles.push({
          x: seq.fx + rnd(-6, 6),
          y: seq.fy + rnd(-4, 4),
          vx: rnd(-20, 20),
          vy: rnd(-40, 10),
          life: 200 + Math.random() * 200,
          color: chance(0.5) ? "#40ffff" : "#ffffff",
          size: 1 + (Math.random() * 2) | 0,
        });
      }
      if (seq.t >= dur) {
        seq.phase = "attach";
        seq.t = 0;
        seq.fx = boss.x;
        seq.fy = boss.y + 26;
        seq.red = 1;
        burst(boss.x, boss.y + 24, "#ff4040", 16);
        burst(boss.x, boss.y + 24, "#ffff40", 10);
        sfx("attach");
        // MAME: red FIGHTER CAPTURED (row 19) for 160f once the ship turns red
        msgRun([{ lines: [L("FIGHTER CAPTURED", 5, 19, TXT_R)], f: 160 }, { lines: [], f: 0 }]);
      }
    } else if (seq.phase === "attach") {
      if (!boss || boss.state === "dead") {
        seq.phase = "resolve";
        seq.t = 0;
        return;
      }
      const dur = 550;
      seq.fx = boss.x;
      seq.fy = boss.y + 26;
      seq.red = 1;
      if (seq.t >= dur) {
        seq.phase = "haul";
        seq.t = 0;
        finishCaptureHaul(seq);
        if (!captureSeq || captureSeq.phase !== "haul") return;
        seq.attached = true;
      }
    } else if (seq.phase === "haul") {
      // Capture FSM drives return so we never hang if enemies-list skips the boss
      if (boss && boss.state === "dead") {
        capturedHeld = false;
        seq.phase = "resolve";
        seq.t = 0;
      } else if (boss) {
        if (boss.state !== "return" && boss.state !== "form") {
          finishCaptureHaul(seq);
        }
        if (boss.state === "return" && boss.returnPath && boss.returnPath.length >= 2) {
          const done = followPath(boss, boss.returnPath, dt, 125);
          seq.fx = boss.x;
          seq.fy = boss.y + 26;
          if (done) {
            snapBossToFormation(boss);
            boss.hasCaptive = true;
            capturedHeld = true;
          }
        } else if (boss.state === "form") {
          boss.hasCaptive = true;
          capturedHeld = true;
        }
        seq.fx = boss.x;
        seq.fy = boss.y + 26;

        if (boss.state === "form" || seq.t > 4000) {
          if (boss.state !== "form") {
            snapBossToFormation(boss);
            boss.hasCaptive = true;
            capturedHeld = true;
          }
          beams = beams.filter((b) => b.enemy !== boss);
          if (seq.partial) {
            endPartialCapture(seq);
          } else {
            seq.phase = "respawn";
            seq.t = 0;
          }
        }
      } else {
        seq.phase = "resolve";
        seq.t = 0;
      }
    } else if (seq.phase === "respawn") {
      if (seq.partial) {
        endPartialCapture(seq);
        return;
      }
      if (!seq.lifeTaken) {
        seq.lifeTaken = true;
        lives = Math.max(0, lives - 1);
        hud();
      }
      if (seq.t >= 1000) {
        resolveSoloCapture(seq);
      }
    } else if (seq.phase === "resolve") {
      if (seq.partial) {
        endPartialCapture(seq);
      } else if (seq.t >= 400) {
        resolveSoloCapture(seq);
      }
    }
  }

  function drawCaptureFighter(seq) {
    if (!seq || seq.phase === "respawn" || seq.phase === "resolve") return;
    if (seq.attached && seq.phase === "haul") return;
    const x = seq.fx;
    const y = seq.fy;
    const r = seq.red;
    ctx.save();
    ctx.translate(x, y);
    if (r > 0.45) {
      blit(0, 0, SPR_CAPTURED, SPR_PX_SHIP * 0.95);
    } else {
      blit(0, 0, SPR_FIGHTER, SPR_PX_SHIP * 0.95);
    }
    if (seq.phase === "pull" || seq.phase === "lock") {
      ctx.globalAlpha = 0.45 + 0.55 * Math.sin(seq.beamPulse / 50);
      fillRect(-10, -4, 3, 3, "#40ffff");
      fillRect(8, 2, 3, 3, "#ffffff");
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function isChallengeStage(n) {
    // Classic Galaga: challenging stages every 3rd starting at 3 → 3,6,9,12...
    return n >= 3 && (n - 3) % 4 === 0; // arcade: 3, 7, 11, 15 ...
  }

  function beginStage(n, opts) {
    hideOV();
    stage = n;
    isChallenge = isChallengeStage(n);
    enemies = [];
    bullets = [];
    eBullets = [];
    beams = [];
    particles = [];
    captureSeq = null;
    // Do not wipe fighterCount — dual/triple carries across stages
    rescueSeq = null;
    stopBeamHum();
    pendingStageClear = false;
    diveTimer = Math.max(1800, 3800 - (n - 1) * 150);
    entrySet = 0;
    fireCD = 0;
    challengeHits = 0;
    challengeShots = 0;
    captors = [];

    if (isChallenge) {
      challengeMax = 40;
      chClock = 0;
      const ci = Math.floor((n - 3) / 4);
      chVar = CH_VARIANTS[ci % CH_VARIANTS.length];
      window.__chVariant = ci % CH_VARIANTS.length;
      window.__chName = chVar.name;
      chVar.waves.forEach((lines) => {
        lines.forEach(([pk, appear, n, kind]) => {
          const path = chVar.paths[pk];
          const start = appear - chAppear(path) * 2;
          for (let k = 0; k < n; k++) {
            const theme = (lines.find((l) => l[3] !== "mix") || [0, 0, 0, "bee"])[3];
            const type = kind === "mix" ? (k % 2 === 0 ? "boss" : chVar.waves.flat().find((l) => l[3] !== "mix")[3]) : kind;
            enemies.push({
              type,
              slot: { row: 0, col: k, type, i: enemies.length },
              hp: type === "boss" ? 2 : 1,
              state: "challenge",
              x: -100, y: -100, angle: 0,
              chPath: path, chStart: start + k * CH_SHIP_GAP,
              path: null, pathI: 0, pathT: 0, formWait: 0, divePath: null, diveI: 0, diveT: 0,
              shootT: 99999, flap: Math.random() * 100, escorts: 0, hasCaptive: false, captiveAngle: 0,
              id: Math.random(), enterDelay: 0, challengeActive: true, challengeDone: false,
            });
          }
        });
      });
      state = "intro";
      introT = Infinity;
      msgRun([
        { lines: [L("CHALLENGING STAGE", 5, 18)], f: 96 },
        { lines: [], f: 0, fn: () => { if (state === "intro") state = "play"; } },
      ]);
      sfx("challenge");
    } else {
      formFull = false;
      formBreath = 0;
      const plan = entryPlan();
      const pat = stagePattern(n);
      let si = 0;
      // spawn point → [shape index for waveShape, side]
      // top shapes: 0 = centre pair (wave 1), 3 = outer top; bottom: 1
      const PT = { A: [3, -1], B: [3, 1], C: [1, -1], D: [1, 1] };
      const trainsFor = (w) => {
        const all = plan[w].flat();
        if (w === 0) return [{ pos: "B", m: plan[0][0], sh: 0 }, { pos: "A", m: plan[0][1], sh: 0 }];
        const home = ["", "C", "D", "B", "A"][w], other = { A: "B", B: "A", C: "D", D: "C" }[home];
        if (pat === "C") return [{ pos: home, m: all }];
        let h1, h2;
        if (w === 1) { h1 = all.filter((x) => x[0] === "boss"); h2 = all.filter((x) => x[0] !== "boss"); }
        else { const srt = all.slice().sort((p, q) => p[2] - q[2]); h1 = srt.slice(0, 4); h2 = srt.slice(4); if (home === "D" || home === "B") [h1, h2] = [h2, h1]; }
        if (pat === "B") return [{ pos: home, m: h1, lane: 0 }, { pos: home, m: h2, lane: 1 }];
        return [{ pos: home, m: h1 }, { pos: other, m: h2 }]; // "A": both sides at once
      };
      for (let w = 0; w < 5; w++) {
        const trains = trainsFor(w);
        const single = trains.length === 1;
        trains.forEach((tr) => {
          const [shape0, side] = PT[tr.pos];
          const shape = tr.sh != null ? tr.sh : shape0;
          let k = 0;
          const delay0 = 400 + w * WAVE_GAP;
          tr.m.forEach(([type, row, col]) => {
            const slot = { row, col, type, i: si++, wave: w, side, shape, lane: tr.lane || 0 };
            const e = makeEnemy(type, slot, delay0 + k++ * TRAIN_GAP);
            e.entryWave = w;
            enemies.push(e);
          });
          // rammers tag along at the end of the train
          const nr = rammersPerTrain(n, single);
          for (let r = 0; r < nr; r++) {
            const [type, row, col] = tr.m[tr.m.length - 1 - (r % tr.m.length)];
            const slot = { row, col, type, i: -1, wave: w, side, shape, lane: tr.lane || 0 };
            const e = makeEnemy(type, slot, delay0 + k++ * TRAIN_GAP);
            e.rammer = true; e.hostile = false; e.entryWave = w;
            if (e.hp > 1) e.hp = 1;
            enemies.push(e);
          }
        });
      }
      // documented entrance fire: ~3–4 shots per wave (6–8 from stage 16), none on service stages
      entryFire = [0, 0, 0, 0, 0].map(() => entryShots(n));
      // Carry captive into next stage: pin red fighter under a boss
      if (capturedHeld) {
        const carrier = enemies.find((e) => e.type === "boss" && !e.rammer);
        if (carrier) {
          carrier.hasCaptive = true;
          carrier.captureOwned = false;
        } else {
          capturedHeld = false;
        }
      }
      state = "intro";
      introT = Infinity;
      const go = { lines: [], f: 0, fn: () => { if (state === "intro") state = "play"; } };
      if (opts && opts.prelude) {
        // MAME: PLAYER 1 230f → STAGE n 96f → PLAYER 1 + STAGE n 96f → clear
        msgRun([
          { lines: [L("PLAYER 1", 11, 18)], f: 230 },
          { lines: [stageLine(stage)], f: 96 },
          { lines: [L("PLAYER 1", 10, 16), stageLine(stage)], f: 96 },
          go,
        ]);
      } else {
        msgRun([{ lines: [stageLine(stage)], f: 96 }, go]);
      }
      hideOV();
      // Skip short stage sting on credit/start — Prelude owns first stage audio
      if (!(opts && opts.prelude)) sfx("stage");
    }
    stageLabelT = 2000;
    hud();
  }

  // Challenging Stage: 5 trains of 8 fly the arcade entry curves, then keep
  // going and leave the screen (no shooting, no formation) — as in MAME stage 3.
  function challengePath(wave, i, fromLeft) {
    const side = wave === 0 ? (i < 4 ? 1 : -1) : fromLeft ? -1 : 1;
    const shp = waveShape(wave, side);
    const ext = arcPath(shp.x, shp.y, shp.hdg, [{ r: 40, turn: side * 120 * D2R }, { line: 260 }]);
    return shp.pts.concat(ext.pts.slice(1)).map((p) => ({ x: p.x * 2, y: p.y * 2 }));
  }

  function beginGame() {
    const kick = () => {
      score = 0;
      lives = 3;
      stage = 1;
      extrasAt = 0;
      totalShots = 0;
      totalHits = 0;
      fighterCount = 1;
      dual = false;
      capturedHeld = false;
      captors = [];
      captureSeq = null;
      rescueSeq = null;
      pendingStageClear = false;
      stopBeamHum();
      initStars();
      spawnPlayer();
      beginStage(1, { prelude: true });
      sfx("prelude");
    };
    // V21: wait for AudioContext resume so the first fanfare isn't scheduled while suspended
    const p = unlockAudio();
    if (p && typeof p.then === "function") p.then(kick).catch(kick);
    else kick();
  }

  // Arcade-style explosion: a single animated sprite (no debris particles).
  // Enemy: 4 observed frames over ~20 arcade frames; first boss hit = no burst.
  function burst(x, y, color, n = 10) {
    if (n <= 4) return;
    const now = performance.now();
    if (particles.some((p) => p.expl && Math.abs(p.x - x) < 2 && Math.abs(p.y - y) < 2 && now - p.explT0 < 30)) return;
    particles.push({ x, y, vx: 0, vy: 0, life: 340, expl: true, explT0: now, explDur: 340 });
  }
  // Player: 4 observed frames over ~64 arcade frames
  function pexplode(x, y) {
    particles.push({ x, y, vx: 0, vy: 0, life: 1070, expl: true, pexp: true, explT0: performance.now(), explDur: 1070 });
  }

  function fire() {
    if (!player || !player.alive || fireCD > 0 || state !== "play") return;
    // 2 shots on-screen per fighter (single 2, dual 4, triple 6)
    const n = Math.max(1, fighterCount);
    const maxShots = n * 2;
    const mine = bullets.filter((b) => b.friendly).length;
    if (mine >= maxShots) return;
    fireCD = 0; // V28: no fire-rate gate beyond the 2-shots-on-screen limit
    if (isChallenge) challengeShots++;
    totalShots++;
    const y = player.y - 36;
    if (n === 1) {
      bullets.push({ x: player.x, y, vy: -720, friendly: true });
    } else if (n === 2) {
      bullets.push({ x: player.x - 16, y, vy: -720, friendly: true });
      bullets.push({ x: player.x + 16, y, vy: -720, friendly: true });
    } else {
      bullets.push({ x: player.x - 28, y, vy: -720, friendly: true });
      bullets.push({ x: player.x, y, vy: -720, friendly: true });
      bullets.push({ x: player.x + 28, y, vy: -720, friendly: true });
    }
    sfx("fire");
  }

  function killEnemy(e, diving) {
    if (e.state === "dead") return;
    e.hp--;
    if (e.hp > 0) {
      sfx("hit");
      burst(e.x, e.y, C.white, 4);
      return;
    }
    // Shooting the boss (2nd hit) mid-beam cancels the beam
    if (e.state === "beam" && !(captureSeq && captureSeq.boss === e)) {
      beams = beams.filter((b) => b.enemy !== e);
      stopBeamHum();
    }
    // If this boss is mid-capture, clear ownership; capture FSM will resolve
    if (captureSeq && captureSeq.boss === e) {
      e.captureOwned = false;
    }
    const wasDiving =
      !!diving ||
      e.state === "dive" ||
      e.state === "beam" ||
      e.state === "return" ||
      e.state === "challenge";
    const hadCaptive = e.type === "boss" && e.hasCaptive;
    // Rescue only if boss is away from formation (diving/beam/return), not parked in formation
    const diveRescue = hadCaptive && wasDiving && e.state !== "form";

    e.state = "dead";
    addScore(enemyScore(e, wasDiving));
    if (e.grp && ++e.grp.killed === 3) { addScore(e.grp.bonus); flashMsg(String(e.grp.bonus), 1400); }
    if (isChallenge) challengeHits++;
    totalHits++;

    // Captive rescue: destroy diving boss with captive → spin/dock dual
    // Formation kill with captive → hostile red fighter (classic Galaga)
    let rescuedNow = false;
    if (hadCaptive) {
      e.hasCaptive = false;
      capturedHeld = false;
      const othersLeft = enemies.some((o) => o !== e && o.state !== "dead");
      const canRescue = diveRescue || !othersLeft;

      if (canRescue && player && player.alive && !rescueSeq) {
        startRescueSequence(e.x, e.y + 22);
        addScore(1000);
        rescuedNow = true;
      } else if (canRescue && (!player || !player.alive)) {
        fighterCount = Math.min(3, Math.max(1, fighterCount) + 1);
        syncFighters();
        flashMsg("FIGHTER RESCUED!", 1600);
        addScore(1000);
        rescuedNow = true;
      } else {
        // Boss destroyed in formation while holding captive → hostile ship
        spawnHostileCaptive(e.x, e.y + 22);
        flashMsg("FIGHTER HOSTILE!", 1400);
      }
    }

    const col =
      e.type === "boss"
        ? C.green
        : e.type === "butterfly"
          ? C.red
          : e.type === "hostile"
            ? "#ff4040"
            : C.blue;
    burst(e.x, e.y, col, 14);
    burst(e.x, e.y, C.yellow, 6);
    // V22: rescue fanfare must play AFTER any boom — kill WSG was stomping it
    if (rescuedNow) {
      noise(0.09, 0.1, 0, 2600, 0.5, 520);
      noise(0.18, 0.07, 0.03, 880, 0.4, 180);
      sfx("rescue");
    } else {
      sfx("kill");
    }
  }

  function doStageClear() {
    pendingStageClear = false;
    const next = () => beginStage(stage + 1);
    if (isChallenge) {
      state = "challenge";
      challengeT = Infinity;
      const hits = challengeHits;
      const perfect = hits >= challengeMax;
      const hitsTxt = String(hits);
      // MAME stage 3: ~212f after the last line leaves, then each line 96f apart
      const steps = [
        { lines: [], f: 212 },
        { lines: [L("NUMBER OF HITS", 5, 18)], f: 96 },
        { add: true, lines: [L(hitsTxt, 22 - hitsTxt.length, 18)], f: 96 },
      ];
      if (perfect) {
        steps.push({ add: true, lines: [L("PERFECT !", 9, 21, TXT_R)], f: 96, fn: () => sfx("perfect") });
        steps.push({ add: true, lines: [L("SPECIAL BONUS 10000 PTS", 3, 23, TXT_Y)], f: 192, fn: () => addScore(10000) });
      } else {
        const bonus = String(hits * 100);
        steps.push({ add: true, lines: [L("BONUS", 8, 21)], f: 96 });
        steps.push({ add: true, lines: [L(bonus, 14, 21)], f: 192, fn: () => { addScore(hits * 100); sfx("stage"); } });
      }
      steps.push({ lines: [], f: 0, fn: next });
      msgRun(steps);
    } else {
      state = "clear";
      clearT = Infinity;
      msgRun([{ lines: [], f: 90 }, { lines: [], f: 0, fn: next }]);
    }
  }

  /**
   * Classic: shooting a formation boss that holds your ship turns the
   * captive hostile — it leaves the formation and dives at you.
   */
  function spawnHostileCaptive(x, y) {
    const aimX = player && player.alive ? player.x : VW / 2;
    const path = [];
    for (let i = 0; i <= 48; i++) {
      const t = i / 48;
      path.push({
        x: lerp(x, aimX + Math.sin(t * Math.PI * 3) * 50, t),
        y: lerp(y, VH + 40, t * t * 0.85 + t * 0.15),
      });
    }
    enemies.push({
      type: "hostile",
      slot: { row: 0, col: 0, type: "hostile", i: -1 },
      hp: 1,
      state: "dive",
      x,
      y,
      angle: Math.PI / 2,
      path: null,
      pathPos: 0,
      divePath: path,
      diveI: 0,
      diveT: 0,
      shootT: 600,
      flap: 0,
      escorts: 0,
      hasCaptive: false,
      captiveAngle: 0,
      id: Math.random(),
      enterDelay: 0,
      willBeam: false,
      beamed: false,
      hostile: true,
    });
  }

  /**
   * Original rescue: freed fighter spins, turns white, flies down,
   * and docks beside the active fighter → dual/triple ship.
   */
  function startRescueSequence(fromX, fromY) {
    rescueSeq = {
      phase: "spin",
      t: 0,
      fx: fromX,
      fy: fromY,
      startX: fromX,
      startY: fromY,
      angle: 0,
      spins: 0,
      red: 1, // start red (captive), go white
      side: 1, // dock on right of player (+1) or left (-1)
      docked: false,
    };
    // V22: sfx("rescue") played by caller AFTER kill boom so it isn't stomped
    flashMsg("FIGHTER RESCUED!", 2000);
  }

  function updateRescueSequence(dt) {
    if (!rescueSeq) return;
    const seq = rescueSeq;
    seq.t += dt;

    if (seq.phase === "spin") {
      // ~1.1s: spin in place while fading red → white (classic free)
      const dur = 1100;
      const u = clamp(seq.t / dur, 0, 1);
      seq.angle += (dt / 1000) * Math.PI * 8; // ~4 rev/sec
      seq.spins = seq.angle / (Math.PI * 2);
      seq.red = 1 - u;
      // slight float
      seq.fy = seq.startY + Math.sin(seq.t / 80) * 3;
      seq.fx = seq.startX;
      if (Math.random() < 0.4) {
        particles.push({
          x: seq.fx + rnd(-10, 10),
          y: seq.fy + rnd(-10, 10),
          vx: rnd(-40, 40),
          vy: rnd(-40, 40),
          life: 180 + Math.random() * 200,
          color: chance(0.5) ? "#ffffff" : "#ffff40",
          size: 2 + ((Math.random() * 3) | 0),
        });
      }
      if (seq.t >= dur) {
        seq.phase = "approach";
        seq.t = 0;
        seq.startX = seq.fx;
        seq.startY = seq.fy;
        seq.red = 0;
        // Choose dock side: prefer clearer side of player
        if (player && player.alive) {
          seq.side = player.x < VW * 0.5 ? 1 : -1;
        }
      }
    } else if (seq.phase === "approach") {
      // ~1.35s: fly down to sit beside the player
      const dur = 1350;
      const u = clamp(seq.t / dur, 0, 1);
      const ease = u * u * (3 - 2 * u);
      // Keep spinning while descending, slow the spin near dock
      const spinRate = Math.PI * 6 * (1 - u * 0.85);
      seq.angle += (dt / 1000) * spinRate;

      const targetX = player && player.alive ? player.x + seq.side * 22 : VW / 2 + seq.side * 22;
      const targetY = player && player.alive ? player.y : VH - 52;
      seq.fx = lerp(seq.startX, targetX, ease);
      seq.fy = lerp(seq.startY, targetY, ease);

      if (Math.random() < 0.25) {
        particles.push({
          x: seq.fx + rnd(-4, 4),
          y: seq.fy + rnd(-4, 4),
          vx: rnd(-15, 15),
          vy: rnd(-20, 10),
          life: 150 + Math.random() * 150,
          color: "#80c0ff",
          size: 1,
        });
      }

      if (seq.t >= dur) {
        seq.phase = "dock";
        seq.t = 0;
        seq.angle = 0;
        seq.red = 0;
      }
    } else if (seq.phase === "dock") {
      // ~0.45s: join formation (dual or triple)
      const dur = 450;
      const spacing = fighterCount >= 2 ? 28 : 22;
      if (player && player.alive) {
        seq.fx = player.x + seq.side * spacing;
        seq.fy = player.y;
      }
      if (seq.t >= dur * 0.3 && !seq.docked) {
        seq.docked = true;
        fighterCount = Math.min(3, fighterCount + 1);
        syncFighters();
        burst(
          player ? player.x : seq.fx,
          player ? player.y : seq.fy,
          "#ffffff",
          12
        );
        burst(
          player ? player.x : seq.fx,
          player ? player.y : seq.fy,
          "#40ffff",
          8
        );
        sfx("attach");
        sfx("extra");
        if (fighterCount >= 3) flashMsg("TRIPLE FIGHTER!", 1800);
        else flashMsg("DUAL FIGHTER!", 1600);
      }
      if (seq.t >= dur) {
        rescueSeq = null;
        // Stage was empty while we animated — clear now that dual/triple is set
        if (pendingStageClear && enemies.length === 0 && state === "play") {
          doStageClear();
        }
      }
    }
  }

  function drawRescueFighter(seq) {
    if (!seq) return;
    if (seq.docked) return;

    const x = seq.fx;
    const y = seq.fy;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(seq.angle);
    const r = seq.red;
    if (r > 0.45) blit(0, 0, SPR_CAPTURED, SPR_PX_SHIP * 0.95);
    else blit(0, 0, SPR_FIGHTER, SPR_PX_SHIP * 0.95);
    ctx.restore();
  }

  function killPlayer() {
    if (!player || !player.alive || invuln > 0) return;
    pexplode(player.x, player.y);
    sfx("die");
    if (fighterCount > 1) {
      // Lose one ship from the formation (triple→dual→single)
      fighterCount -= 1;
      syncFighters();
      invuln = 1500;
      if (fighterCount === 2) flashMsg("TRIPLE HIT!", 1000);
      else flashMsg("DUAL FIGHTER HIT!", 1000);
      return;
    }
    player.alive = false;
    lives--;
    fighterCount = 1;
    hud();
    bullets = [];
    state = "die";
    msgClear(); // a death cancels any intro text; READY follows (MAME: 110f after the blast)
    dieT = (110 * 1000) / 60;
  }

  // V31: enemy transformations. Stages 4-7 Scorpion, 8-11 Bosconian, 12-15
  // Galaxian flagship, then repeating. Three ships, 160 each, bonus if all 3 die.
  const XFORM = [["scorpion", 1000], ["bosconian", 2000], ["galflag", 3000]];
  function xformKind() { return XFORM[Math.floor((stage - 4) / 4) % 3]; }
  function spawnTransform(src) {
    src.state = "dead"; src.silent = true;
    if (src.slot) src.slot.taken = false;
    const [kind, bonus] = xformKind();
    const grp = { killed: 0, bonus, kind };
    const aim = player ? player.x : VW / 2;
    [-1, 0, 1].forEach((k) => {
      const pts = [];
      let x = src.x, y = src.y;
      for (let i = 0; i <= 60; i++) {
        const t = i / 60;
        pts.push({ x: x + k * 70 * Math.min(1, t * 3) + (aim - x) * t * 0.6 + Math.sin(t * Math.PI * 3) * 26 * (k || 1), y: y + t * (VH + 80 - y) });
      }
      enemies.push({ type: kind, xchild: true, grp, hp: 1, state: "dive", x, y, angle: Math.PI / 2, divePath: pts, pathPos: 0,
        shootT: rnd(300, 900), flap: Math.random() * 100, escorts: 0, id: Math.random() });
    });
    burst(src.x, src.y, C.white, 8);
    sfx("transform");
  }

  function startDive(e) {
    if (e.state !== "form") return;
    e.state = "dive";
    e.pathPos = 0;
    e.diveI = 0;
    e.diveT = 0;
    e.escorts = 0;
    e.beamed = false;
    e.beamAtIndex = -1;

    // Boss: always try tractor beam when no fighter is already captive
    const tryBeam =
      e.type === "boss" && !capturedHeld && !e.hasCaptive && !beams.length && (e.forceBeam || chance(diff().beamP));
    e.forceBeam = false;

    e.willBeam = tryBeam;
    // V31: from stage 4 a diving Zako may split into three "transform" ships
    e.xformAt = 0;
    if (e.type === "bee" && stage >= 4 && !isChallenge && !lastAttack && !enemies.some((o) => o.xchild && o.state !== "dead") && chance(window.__xformP != null ? window.__xformP : 0.3)) e.xformAt = 6;
    e.divePath = divePathFor(e, { beamDive: tryBeam });

    // Butterflies can escort boss (not during beam attempt)
    if (e.type === "boss" && !tryBeam) {
      const escorts = enemies.filter(
        (o) => o.state === "form" && o.type === "butterfly"
      );
      let taken = 0;
      for (const o of escorts) {
        if (taken >= diff().escorts) break;
        if (Math.abs(o.x - e.x) < diff().escortR) {
          o.state = "dive";
          o.pathPos = 0;
          o.divePath = divePathFor(o, { beamDive: false });
          o.willBeam = false;
          o.beamed = false;
          taken++;
          e.escorts++;
        }
      }
    }
    sfx("dive");
  }

  // ── Update ───────────────────────────────────────────────────────────────
  let formSway = 0;
  let formSwayDir = 1;

  function updatePlayer(dt) {
    if (!player || !player.alive) return;
    if (demo) { demoPilot(dt); if (invuln > 0) invuln -= dt; return; }
    const left = leftHeld || keys.ArrowLeft || keys.KeyA || keys.a || keys.A;
    const right = rightHeld || keys.ArrowRight || keys.KeyD || keys.d || keys.D;
    // Arcade-paced lateral speed (~original feel at 448px wide)
    const spd = 180; // MAME: ~1.5 arcade px/frame
    if (left) player.x -= spd * (dt / 1000);
    if (right) player.x += spd * (dt / 1000);
    const margin = fighterCount >= 3 ? 40 : fighterCount === 2 ? 32 : 20;
    player.x = clamp(player.x, margin, VW - margin);

    // V28: arcade fires one shot per press (no auto-fire); see keydown handler
    if (invuln > 0) invuln -= dt;
  }

  function updateEnemies(dt) {
    formSway += formSwayDir * 7.5 * (dt / 1000);
    if (formSway > 16) formSwayDir = -1;
    if (formSway < -16) formSwayDir = 1;

    let inFormation = 0;
    if (!isChallenge) {
      const entering = enemies.some((e) => e.state === "enter");
      if (!entering && !formFull && enemies.length) {
        formFull = true;
        formBreathT = 0;
      }
      if (formFull) {
        formBreathT += dt;
        formBreath = 0.5 * (1 - Math.cos((formBreathT / 4250) * Math.PI * 2)); // 255-frame cycle
        formSway = lerp(formSway, 0, 0.05);
      }
    }

    for (const e of enemies) {
      if (e.state === "dead") continue;
      e.flap += dt;

      // Delayed activation for challenge
      if (e.state === "challenge" || e.enterDelay > 0) {
        if (e.enterDelay > 0) {
          e.enterDelay -= dt;
          if (e.enterDelay > 0) {
            // hold offscreen
            e.x = -100;
            e.y = -100;
            continue;
          }
          if (e.state === "challenge") e.challengeActive = true;
        }
      }

      if (e.state === "enter") {
        if (e.pathPos == null) e.pathPos = 0;
        const done = followPath(e, e.path, dt, 330 * diff().speed);
        // V28: enemies drop a few shots while flying in (arcade)
        if (!e.returning && e.entryWave != null && entryFire[e.entryWave] > 0 && player && player.alive &&
            e.y > 80 && e.y < VH * 0.6 && chance(0.012)) {
          entryFire[e.entryWave]--;
          eBullets.push({ x: e.x, y: e.y + 10, vx: (player.x - e.x) * diff().bulletAim, vy: diff().bulletVy });
        }
        // rammers peel off toward the player near the end of the entrance loop
        if (e.rammer && e.pathPos > e.path.length - 26) {
          e.state = "dive"; e.hostile = true; e.pathPos = 0;
          const pts = [];
          const tx = player ? player.x : VW / 2;
          for (let i = 1; i <= 40; i++) { const t = i / 40; pts.push({ x: lerp(e.x, tx, Math.min(1, t * 1.3)), y: lerp(e.y, VH + 40, t) }); }
          e.divePath = pts; e.willBeam = false;
          continue;
        }
        if (done) {
          e.returning = false;
          e.state = "form";
          e.pathPos = 0;
          const fp = slotPos(e.slot, formSway);
          e.x = fp.x;
          e.y = fp.y;
          e.angle = Math.PI / 2;
          if (e.type === "boss" && capturedHeld && !enemies.some((o) => o.hasCaptive && o !== e)) {
            // keep captive on existing boss only
          }
        }
      } else if (e.state === "form") {
        inFormation++;
        const fp = slotPos(e.slot, formSway);
        e.x = lerp(e.x, fp.x, 0.08);
        e.y = lerp(e.y, fp.y, 0.08);
        e.angle = Math.PI / 2;
      } else if (captureSeq && captureSeq.boss === e) {
        // Capture FSM owns this boss for the whole cinematic (lock→haul)
        continue;
      } else if (e.state === "beam") {
        // Safety: never freeze a boss in beam with captureOwned if FSM ended
        if (e.captureOwned && (!captureSeq || captureSeq.boss !== e)) {
          e.captureOwned = false;
          e.beamT = e.beamDuration || 4000;
        }
        if (e.captureOwned && captureSeq && captureSeq.boss === e) {
          continue; // Capture FSM owns boss motion
        }
        e.beamT = (e.beamT || 0) + dt;
        e.beamOpen = 1;
        e.beamLen = beamLenNow(e);
        e.angle = Math.PI / 2;
        // Boss hovers in place; fighter keeps full control (no pull/snap)
        if (player && player.alive && state === "play") {
          if (playerInBeamCone(e)) {
            e.captureHold = (e.captureHold || 0) + dt;
            if (e.captureHold >= BEAM_CATCH_MS) {
              startCaptureSequence(e);
              continue;
            }
          } else {
            e.captureHold = 0;
          }
        }
        for (const b of beams) {
          if (b.enemy === e) {
            b.x = e.x;
            b.y = e.y;
            b.life = Math.max(0, e.beamDuration - e.beamT);
          }
        }
        if (e.state === "beam" && e.beamT >= e.beamDuration && !captureSeq) {
          e.state = "dive";
          e.beamed = true;
          e.willBeam = false;
          beams = beams.filter((b) => b.enemy !== e);
          if (e.beamAtIndex >= 0) e.pathPos = e.beamAtIndex + 0.05;
        }
      } else if (e.state === "return") {
        // V20: orphaned capture haul (seq gone) must not hang mid-return
        if (e.captureOwned && (!captureSeq || captureSeq.boss !== e)) {
          e.captureOwned = false;
          if (!e.returnPath || e.returnPath.length < 2) {
            snapBossToFormation(e);
            continue;
          }
        }
        if (!e.returnPath || e.returnPath.length < 2) {
          e.state = "form";
          e.returnPath = null;
          e.pathPos = 0;
          e.divePath = null;
          e.angle = Math.PI / 2;
          e.captureOwned = false;
          continue;
        }
        const done = followPath(e, e.returnPath, dt, 110);
        if (done) {
          e.state = "form";
          e.returnPath = null;
          e.pathPos = 0;
          e.divePath = null;
          e.angle = Math.PI / 2;
          e.captureOwned = false;
        }
      } else if (e.state === "dive") {
        if (!e.divePath || !e.divePath.length) {
          e.state = "form";
          continue;
        }

        const diveSpeed = (e.type === "boss" ? 100 : e.type === "butterfly" ? 115 : 120) * diff().speed;
        const pathDone = followPath(e, e.divePath, dt, diveSpeed);
        if (e.xchild) {
          if (pathDone || e.y > VH + 30) { e.state = "dead"; e.silent = true; continue; }
        } else if (e.xformAt && e.pathPos >= e.xformAt) { spawnTransform(e); continue; }

        // After move: open tractor beam at marker (always for bosses without a captive)
        if (
          e.type === "boss" &&
          e.willBeam &&
          !e.beamed &&
          e.beamAtIndex >= 0 &&
          e.pathPos >= e.beamAtIndex - 0.5
        ) {
          const p = e.divePath[Math.min(e.beamAtIndex, e.divePath.length - 1)];
          if (p) {
            e.x = p.x;
            e.y = p.y;
          }
          e.pathPos = e.beamAtIndex;
          beginTractorBeam(e);
          continue;
        }

        // Shoot while diving
        e.shootT -= dt;
        if (e.shootT <= 0 && player && player.alive && e.y < VH - 90 && e.y > 60) {
          { const d = diff(); e.shootT = d.shootBase + Math.random() * d.shootBase; }
          eBullets.push({
            x: e.x,
            y: e.y + 10,
            vx: (player.x - e.x) * diff().bulletAim,
            vy: diff().bulletVy,
          });
        }

        // Ram collision
        if (player && player.alive && invuln <= 0) {
          const hitR =
            (fighterCount >= 3 ? 28 : fighterCount === 2 ? 22 : 15) +
            (e.type === "boss" ? 8 : 0);
          if (dist(e.x, e.y, player.x, player.y) < hitR + 10) {
            killEnemy(e, true);
            killPlayer();
            continue;
          }
        }

        if (e.pathPos >= e.divePath.length - 1) {
          if (e.type === "hostile" || e.hostile) {
            e.state = "dead";
            continue;
          }
          e.state = "form";
          e.divePath = null;
          e.pathPos = 0;
          const fp = slotPos(e.slot, formSway);
          if (e.y > VH - 20 || e.x < -20 || e.x > VW + 20) {
            // V28: off the bottom → reappear at the top. Normally fly back
            // down into the slot; when only a few remain they keep attacking.
            e.x = clamp(e.x, 30, VW - 30);
            e.y = -16;
            if (lastAttack) { e.x = fp.x; startDive(e); continue; }
            e.state = "enter"; e.returning = true;
            e.path = [];
            for (let i = 0; i <= 30; i++) { const t = i / 30; e.path.push({ x: lerp(e.x, fp.x, t), y: lerp(-16, fp.y, t) }); }
            e.pathPos = 0;
          } else {
            e.x = fp.x;
            e.y = fp.y;
          }
          e.angle = Math.PI / 2;
        }
      } else if (e.state === "challenge") {
        const idx = (chClock - e.chStart) / 2;
        if (idx < 0) { e.x = -100; e.y = -100; continue; }
        if (idx >= e.chPath.length / 2 - 1) { e.state = "dead"; e.challengeDone = true; (window.__chEsc = window.__chEsc || []).push([e.type, e.chStart, Math.round(e.x), Math.round(e.y)]); continue; }
        const q = chPos(e.chPath, idx);
        e.x = q.x; e.y = q.y; e.angle = q.a;
      }
    }

    enemies = enemies.filter((e) => e.state !== "dead");

    // Dive scheduling (not on challenge)
    if (!isChallenge && state === "play") {
      diveTimer -= dt;
      // V28: when the formation is down to its last few ships, they all
      // leave and attack continuously (arcade end-of-stage behaviour)
      lastAttack = formFull && enemies.length > 0 && enemies.length <= Math.min(8, 4 + Math.floor(stage / 8));
      if (lastAttack && diveTimer > 600) diveTimer = 600;
      if (lastAttack && diveTimer <= 0) {
        diveTimer = 600;
        const f = enemies.find((e) => e.state === "form");
        if (f) startDive(f);
      }
      const formed = lastAttack ? [] : enemies.filter((e) => e.state === "form");
      if (diveTimer <= 0 && formed.length && formFull) {
        const D = diff();
        diveTimer = D.diveGap * rnd(0.8, 1.2);
        // Pick divers (V27 ramp)
        let n = 1;
        while (n < D.maxDivers && chance(D.extraP)) n++;
        for (let k = 0; k < n; k++) {
          const pool = enemies.filter((e) => e.state === "form");
          if (!pool.length) break;
          // Prefer captive-holding boss so rescue is available; else lower bees
          const captiveBoss = pool.find((e) => e.type === "boss" && e.hasCaptive);
          pool.sort((a, b) => b.slot.row - a.slot.row);
          let pick = null;
          if (captiveBoss && chance(0.55)) pick = captiveBoss;
          else if (chance(diff().bossP) && pool.some((e) => e.type === "boss"))
            pick = pool.find((e) => e.type === "boss");
          else pick = pool[(Math.random() * Math.min(8, pool.length)) | 0];
          if (pick) startDive(pick);
        }
      }
    }

    // Stage clear — wait if a rescue dock is still in progress
    if (state === "play" && enemies.length === 0) {
      if (rescueSeq && !rescueSeq.docked) {
        pendingStageClear = true;
        // keep playing so rescue spin/approach/dock can finish
      } else if (captureSeq) {
        pendingStageClear = true;
      } else {
        doStageClear();
      }
    }
  }

  function updateBullets(dt) {
    for (const b of bullets) {
      b.y += b.vy * (dt / 1000);
    }
    bullets = bullets.filter((b) => b.y > -20);

    for (const b of eBullets) {
      b.x += (b.vx || 0) * (dt / 1000);
      b.y += b.vy * (dt / 1000);
    }
    eBullets = eBullets.filter((b) => b.y < VH + 20 && b.x > -20 && b.x < VW + 20);

    // Player bullets vs enemies (larger hitboxes for bigger sprites)
    for (const b of bullets) {
      for (const e of enemies) {
        if (e.state === "dead") continue;
        if (e.x < -50 || e.y < -50) continue;
        const hw =
          e.type === "boss" ? 22 : e.type === "butterfly" ? 18 : e.type === "hostile" ? 16 : 16;
        const hh = e.type === "boss" ? 20 : 18;
        if (Math.abs(b.x - e.x) < hw && Math.abs(b.y - e.y) < hh) {
          b.y = -999;
          killEnemy(
            e,
            e.state === "dive" || e.state === "beam" || e.state === "return" || e.state === "challenge"
          );
          break;
        }
      }
    }
    bullets = bullets.filter((b) => b.y > -20);

    // Enemy bullets vs player
    if (player && player.alive && invuln <= 0) {
      for (const b of eBullets) {
        const hitW = fighterCount >= 3 ? 28 : fighterCount === 2 ? 22 : 14;
        if (Math.abs(b.x - player.x) < hitW && Math.abs(b.y - player.y) < 16) {
          b.y = VH + 100;
          killPlayer();
          break;
        }
      }
    }
  }

  function updateBeams(dt) {
    for (const beam of beams) {
      beam.life -= dt;
      if (beam.enemy && beam.enemy.state === "beam") {
        beam.x = beam.enemy.x;
        beam.y = beam.enemy.y;
      }
    }
    beams = beams.filter((b) => b.life > 0);
  }

  function updateParticles(dt) {
    for (const p of particles) {
      p.x += p.vx * (dt / 1000);
      p.y += p.vy * (dt / 1000);
      p.life -= dt;
    }
    particles = particles.filter((p) => p.life > 0);
  }

  function updateStars(dt) {
    const d = 60 * (dt / 1000);
    starFrame += d;
    for (const st of stars) {
      st.y += d;
      if (st.y >= AH) { st.y -= AH; st.x = (Math.random() * AW) | 0; }
    }
  }

  function update(dt) {
    if (fireCD > 0) fireCD -= dt;
    if (messageT > 0) messageT -= dt;
    updateAttract(dt);
    if (state === "initials") updateInitials(dt);
    else if (state !== "title" && state !== "pause") updateMsgs(dt);
    if (stageLabelT > 0) stageLabelT -= dt;

    updateStars(dt);

    // V20: title/pause freeze world; on game-over scrub any leftover capture ownership
    if (state === "title" || state === "pause" || state === "initials" || state === "attract") return;
    if (state === "over") {
      if (captureSeq) forceResolveCapture("over");
      else {
        for (const e of enemies) {
          if (e.captureOwned) e.captureOwned = false;
        }
      }
      return;
    }

    if (state === "intro") {
      introT -= dt;
      updateEnemies(dt * 0.7);
      updateParticles(dt);
      if (introT <= 0) {
        state = "play";
        hideOV();
      }
      return;
    }

    if (state === "capture") {
      // Full cinematic when the last on-screen ship is captured
      if (!captureSeq) {
        // V20: never remain frozen in capture without a sequence
        forceResolveCapture("null-seq");
        return;
      }
      updateCaptureSequence(dt);
      // If FSM cleared itself mid-frame, leave capture immediately
      if (!captureSeq && state === "capture") {
        forceResolveCapture("seq-cleared");
        return;
      }
      updateEnemies(dt);
      updateParticles(dt);
      for (const b of beams) {
        if (captureSeq && b.enemy === captureSeq.boss) b.life = 9999;
      }
      return;
    }

    if (state === "die") {
      dieT -= dt;
      // V20: partial-capture can overlap death — keep FSM alive
      if (captureSeq) updateCaptureSequence(dt);
      if (isChallenge) chClock += (dt * 60) / 1000;
      updateEnemies(dt);
      updateBullets(dt);
      updateParticles(dt);
      if (dieT <= 0) {
        if (lives <= 0) gameOver();
        else readyRespawn();
      }
      return;
    }

    if (state === "clear" || state === "challenge") {
      clearT = state === "clear" ? clearT - dt : clearT;
      challengeT = state === "challenge" ? challengeT - dt : challengeT;
      updateParticles(dt);
      // V20: keep capture/rescue FSMs alive under banners
      if (captureSeq) updateCaptureSequence(dt);
      if (rescueSeq) updateRescueSequence(dt);
      if ((state === "clear" && clearT <= 0) || (state === "challenge" && challengeT <= 0)) {
        // Never wipe an in-progress rescue by advancing stage
        if (rescueSeq && !rescueSeq.docked) {
          // hold clear timer until docked
          if (state === "clear") clearT = Math.max(clearT, 200);
          if (state === "challenge") challengeT = Math.max(challengeT, 200);
        } else {
          beginStage(stage + 1);
        }
      }
      return;
    }

    if (state !== "play") return;

    // Safety: play requires a living player object (unless mid partial-capture handled)
    if (!player || (!player.alive && !captureSeq && !rescueSeq)) {
      if (lives > 0) {
        fighterCount = Math.max(1, fighterCount);
        spawnPlayer();
        invuln = 2500;
      } else {
        gameOver();
        return;
      }
    }

    if (isChallenge) chClock += (dt * 60) / 1000;
    updatePlayer(dt);
    updateEnemies(dt);
    updateBullets(dt);
    updateBeams(dt);
    updateParticles(dt);
    // Capture cinematic (partial dual/triple, or any leftover seq) alongside play
    if (captureSeq) {
      updateCaptureSequence(dt);
      for (const b of beams) {
        if (captureSeq && b.enemy === captureSeq.boss) b.life = 9999;
      }
    } else {
      // Clear orphaned captureOwned flags
      for (const e of enemies) {
        if (e.captureOwned) e.captureOwned = false;
      }
    }
    updateRescueSequence(dt);
    // Pending clear after rescue finished mid-frame
    if (pendingStageClear && !rescueSeq && !captureSeq && enemies.length === 0) {
      doStageClear();
    }
  }

  // ── Draw (1981 Namco arcade PCB pixel art — denser than 5200 stamps) ─────
  function fillRect(x, y, w, h, col) {
    ctx.fillStyle = col;
    const m = ctx.getTransform();
    if (m.b === 0 && m.c === 0) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillRect(Math.round(m.a * x + m.e), Math.round(m.d * y + m.f), Math.max(1, Math.round(m.a * w)), Math.max(1, Math.round(m.d * h)));
      ctx.restore();
    } else ctx.fillRect(x, y, w, h);
  }

  // ── V25 arcade palette (sampled colour-by-colour from MAME 'galaga' snapshots) ──
  const SP = {
    ".": null,
    W: "#dedede", R: "#ff0000", B: "#0068de", Y: "#ffff00", T: "#009797",
    C: "#00ffde", O: "#de4700", b: "#0000de", P: "#9700de", M: "#ff00de",
    G: "#00ff00", o: "#ff9700", c: "#00b8de", L: "#b8b8de", V: "#b800de",
  };

  // Sprite cache: each row-string sprite rendered once to a 1x canvas.
  const sprCache = new Map();
  function sprCanvas(rows, flipX) {
    const key = rows.join("|") + (flipX ? "F" : "");
    let c = sprCache.get(key);
    if (c) return c;
    const h = rows.length, w = rows[0].length;
    c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const col = SP[rows[j][flipX ? w - 1 - i : i]];
        if (col) { g.fillStyle = col; g.fillRect(i, j, 1, 1); }
      }
    sprCache.set(key, c);
    return c;
  }

  /** Draw a sprite centred at (ox,oy) in current logical space, one arcade
   *  pixel per sprite pixel (px kept for call compatibility; ignored). */
  function blit(ox, oy, rows, px, flipX) {
    const m = ctx.getTransform();
    const dx = m.a * ox + m.c * oy + m.e;
    const dy = m.b * ox + m.d * oy + m.f;
    const c = sprCanvas(rows, flipX);
    const rot = Math.atan2(m.b, m.a);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (Math.abs(rot) < 0.01) {
      ctx.drawImage(c, Math.round(dx - c.width / 2), Math.round(dy - c.height / 2));
    } else {
      // arcade uses 16 headings — quantise to 22.5 degree steps
      const q = Math.round(rot / (Math.PI / 8)) * (Math.PI / 8);
      ctx.translate(Math.round(dx), Math.round(dy));
      ctx.rotate(q);
      ctx.drawImage(c, -Math.round(c.width / 2), -Math.round(c.height / 2));
    }
    ctx.restore();
  }

  const SPR_FIGHTER = [
    ".......W.......",
    ".......W.......",
    ".......W.......",
    "......WWW......",
    "......WWW......",
    "...R..WWW..R...",
    "...R..WWW..R...",
    "...W.WWWWW.W...",
    "R..WBWWRWWBW..R",
    "R..BWWRRRWWB..R",
    "W..WWWRWRWWW..W",
    "W.WWWWWWWWWWW.W",
    "WWWWWRWWWRWWWWW",
    "WWW.RRWWWRR.WWW",
    "WW..RR.W.RR..WW",
    "W......W......W",
  ];
  const SPR_CAPTURED = [
    ".......R.......",
    ".......R.......",
    ".......R.......",
    "......RRR......",
    "......RRR......",
    "...L..RRR..L...",
    "...L..RRR..L...",
    "...R.RRRRR.R...",
    "L..RBRRLRRBR..L",
    "L..BRRLLLRRB..L",
    "R..RRRLRLRRR..R",
    "R.RRRRRRRRRRR.R",
    "RRRRRLRRRLRRRRR",
    "RRR.LLRRRLL.RRR",
    "RR..LL.R.LL..RR",
    "R......R......R",
  ];
  const SPR_RESERVE = [
    "......W......",
    "......W......",
    ".....WWW.....",
    ".....WWW.....",
    "..R..WWW..R..",
    "..R..WWW..R..",
    "R.W.WWRWW.W.R",
    "R.WBWRRRWBW.R",
    "W.BWWRWRWWB.W",
    "W.WWWWWWWWW.W",
    "WWWWRWWWRWWWW",
    "WWWRRWWWRRWWW",
    "WW.RR.W.RR.WW",
    "W.....W.....W",
  ];
  const SPR_SHOT = [
    ".B.",
    ".B.",
    "BBB",
    "BWB",
    ".R.",
    ".R.",
    ".R.",
    ".R.",
  ];
  const SPR_EBULLET = [
    ".W.",
    ".W.",
    ".W.",
    ".W.",
    "RCR",
    "RRR",
    ".R.",
    ".R.",
  ];
  const SPR_BADGE1 = [
    "WWWWWWW",
    "RRRRRRR",
    "RRRRRRR",
    "WWWWWWW",
    "RRRRRRR",
    "RRRRRRR",
    "WWWWWWW",
    "WbWWWbW",
    "WWbWbWW",
    ".WWbWW.",
    "..WWW..",
    "...W...",
  ];
  const SPR_BADGE5 = [
    "WWWWWWW",
    "RRRRRRR",
    "RWWWWWR",
    "RWWRRRR",
    "RWWWWWR",
    "RRRRWWR",
    "RWWWWWR",
    "RRRRRRR",
    "WWWWWWW",
    "WWWWWWW",
    "WbWWWbW",
    ".WbWbW.",
    "..WbW..",
    "...W...",
  ];
  const SPR_BADGE10 = [
    "bbbbbbbbbbbbb",
    "bbbbbbYbbbbbb",
    "bbbbbYYYbbbbb",
    "bYYYbbYbbYYYb",
    "bbbYYbYbYYbbb",
    "bbYYYYYYYYYbb",
    "bbbbYYYYYbbbb",
    "bbbYYbYbYYbbb",
    ".bbbYbYbYbbb.",
    "..bbYbYbYbb..",
    "...bbbYbbb...",
    "....bbbbb....",
    ".....bbb.....",
    "......b......",
  ];
  const SPR_BADGE20 = [
    "VVVVVVVVVVVVVVV",
    "VVVVVVVYVVVVVVV",
    "VVVVVVYYYVVVVVV",
    "VVVYYVVYVVYYVVV",
    "VVYYYYVYVYYYYVV",
    "VYYVVYYYYYVVYYV",
    "VYVVVVYYYVVVVYV",
    "VYYVVVVYVVVVYYV",
    "VVYYVVVYVVVYYVV",
    ".VVYYVVVVVYYVV.",
    "..VVYYYYYYYVV..",
    "...VVYVVVYVV...",
    "....VYYYYYV....",
    ".....VVVVV.....",
    "......VVV......",
    ".......V.......",
  ];
  const SPR_BADGE30 = [
    "YYYYYYYYYYYYYYY",
    "YYYYYYbbbYYYYYY",
    "YYbYYYbb.bbYbYY",
    "YbbbYYbbbYYbbbY",
    "YbbbbbbbbbbbbbY",
    "Ybb.bbbbbbb.bbY",
    "Ybbbb.bbb.bbbbY",
    "YbbbbbbbbbbbbbY",
    "YbYbYb.b.bYbYbY",
    ".bYYYYbbbYYYYb.",
    "..YYYYbbbYYYY..",
    "...YYbbbbbYY...",
    "....YbYYYbY....",
    ".....YYYYY.....",
    "......YYY......",
    ".......Y.......",
  ];
  const SPR_BADGE50 = [
    "WWWWWWWWWWWWWWW",
    "WWWWWWWWWWWWWWW",
    "WWRRRRWWWRRRRWW",
    "bbRRRRbbbRRRRbb",
    "WWRRRRWWWRRRRWW",
    "WWRRRRWWWRRRRWW",
    "bbRRRRbbbRRRRbb",
    "WWRRRRWWWRRRRWW",
    "WWWRRRRWRRRRWWW",
    ".WWWRRRRRRRWWW.",
    "..WWWRRRRRWWW..",
    "...WWWRRRWWW...",
    "....WWWRWWW....",
    ".....WWWWW.....",
    "......WWW......",
    ".......W.......",
  ];
  // 2-frame wing flap (formation) / explosion frames as observed
  const SPR_BEE = [
    [
      ".B....Y....B.",
      "..B.YRYRY.B..",
      "...BRRYRRB...",
      "....YYYYY....",
      "...BBYYYBB...",
      "..BBBRRRBBB..",
      ".BBB.RRR.BBB.",
      "BBBB.YYY.BBBB",
      "BBB..RRR..BBB",
      "BBB...R...BBB",
    ],
    [
      "..B...Y...B..",
      "..B.YRYRY.B..",
      "...BRRYRRB...",
      "....YYYYY....",
      "...BBYYYBB...",
      "...BBRRRBB...",
      "..BB.RRR.BB..",
      "..BB.YYY.BB..",
      "..BB.RRR.BB..",
      "..BB..R..BB..",
    ],
  ];
  // 2-frame wing flap (formation) / explosion frames as observed
  const SPR_BUTTER = [
    [
      "..R..B.B..R..",
      "RRR..B.B..RRR",
      "RRR.WRWRW.RRR",
      "RRR.WWWWW.RRR",
      ".RRRRWWWRRRR.",
      "..RRRBBBRRR..",
      ".RRRRBBBRRRR.",
      "RRRRRWWWRRRRR",
      ".RRR.BBB.RRR.",
      "...R.....R...",
    ],
    [
      "..R.......R..",
      "..R..B.B..R..",
      "..R.WRWRW.R..",
      "..R.WWWWW.R..",
      "..RRRWWWRRR..",
      "....RBBBR....",
      "..RRRBBBRRR..",
      "..RRRWWWRRR..",
      "..RR.BBB.RR..",
      "..RR..B..RR..",
    ],
  ];
  // 2-frame wing flap (formation) / explosion frames as observed
  const SPR_BOSS = [
    [
      "......T.T......",
      "......T.T......",
      "...TTOOTOOTT...",
      "....TOOTOOT....",
      ".....TTTTT.....",
      "....TYYTYYT....",
      "..TTTYYYYYTTT..",
      "TTTTTYYYYYTTTTT",
      ".TTTTYYYYYTTTT.",
      ".TOTT.O.O.TTOT.",
      "TTOT..O.O..TOTT",
      "TOTT.......TTOT",
      "TOOT.......TOOT",
      "TOOT.......TOOT",
      "TTTT.......TTTT",
      ".TT.........TT.",
    ],
    [
      "......T.T......",
      "...TTOOTOOTT...",
      "....TOOTOOT....",
      ".....TTTTT.....",
      "...TTYYTYYTT...",
      "..TTTYYYYYTTT..",
      "TTTTTYYYYYTTTTT",
      ".TTT.YYYYY.TTT.",
      "..TT..O.O..TT..",
      "..TT..O.O..TT..",
      "..TTT.....TTT..",
      "...TT.....TT...",
      "....TT...TT....",
      ".....TT.TT.....",
      "......T.T......",
    ],
  ];
  // 2-frame wing flap (formation) / explosion frames as observed
  const SPR_BOSS_HURT = [
    [
      "......B.B......",
      "......B.B......",
      "...BBMMBMMBB...",
      "....BMMBMMB....",
      ".....BBBBB.....",
      "....BPPBPPB....",
      "..BBBPPPPPBBB..",
      "BBBBBPPPPPBBBBB",
      ".BBBBPPPPPBBBB.",
      ".BMBB.M.M.BBMB.",
      "BBMB..M.M..BMBB",
      "BMBB.......BBMB",
      "BMMB.......BMMB",
      "BMMB.......BMMB",
      "BBBB.......BBBB",
      ".BB.........BB.",
    ],
    [
      "......B.B......",
      "...BBMMBMMBB...",
      "....BMMBMMB....",
      ".....BBBBB.....",
      "...BBPPBPPBB...",
      "..BBBPPPPPBBB..",
      "BBBBBPPPPPBBBBB",
      ".BBB.PPPPP.BBB.",
      "..BB..M.M..BB..",
      "..BB..M.M..BB..",
      "..BBB.....BBB..",
      "...BB.....BB...",
      "....BB...BB....",
      ".....BB.BB.....",
      "......B.B......",
    ],
  ];
  // 2-frame wing flap (formation) / explosion frames as observed
  const SPR_EXP = [
    [
      ".....W.",
      ".W.....",
      "..WRW..",
      "W.RWR.W",
      "..WRWW.",
      "W.WRR.W",
      ".W.WW..",
      ".....W.",
    ],
    [
      ".......W....",
      "...W........",
      ".YY.W.W..Y..",
      "..Y..W.W.Y..",
      ".W.W.RR.....",
      "W..YYY.WRW.R",
      "..RRRYRRR...",
      "...YRWYR..W.",
      "R.WRRRR..W..",
      "...YYWRRW.Y.",
      ".WYYYY.W..YY",
      "...YYW..W...",
      "...R..W.....",
    ],
    [
      "....W...R.....",
      "....Y.W..W...R",
      "....R..YY..W..",
      "....Y...Y.R...",
      "....Y.W..W..W.",
      "....Y..W...W..",
      ".....W...R.Y..",
      "Y........R.Y.W",
      ".Y.....W..W...",
      ".YRR.W........",
      "W.Y.....W..W.W",
      "...W.W...RR.Y.",
      "...W...Y.RR.Y.",
      ".WYY...Y......",
      ".Y.YYY.......Y",
      ".R.R.Y..W.....",
    ],
    [
      "...R.....R....W...R.",
      ".....W......W....W..",
      ".......W........W...",
      "..YY......R..W......",
      ".......Y..R.......R.",
      "....W.YY...WYY..Y...",
      "...............W...W",
      ".................YY.",
      "R...RW............Y.",
      ".W..R........R..W...",
      "...Y....W........R..",
      "...Y.W.............W",
      "W...................",
      "...R......W.....WW..",
      "..................W.",
      "...Y..W.........Y...",
      "..Y..W...R..WR..Y...",
      "........Y.W.......R.",
      "....R...YW....Y....W",
      "R..W.......W...W....",
    ],
  ];
  // 2-frame wing flap (formation) / explosion frames as observed
  const SPR_PEXP = [
    [
      "..................W..........",
      "...........CC....C.CC........",
      ".........CC..CC.CCWW.C.......",
      ".......CC..WW..C.C....C......",
      "......C..R...........WWC.....",
      "......CR............R..C.....",
      ".....CR.C.....R.....CCC......",
      ".....C..C.....R......C..C....",
      "....CW.W......R.....R..CC....",
      "....C.CW.....RRR.........W...",
      "......W......RRR.......R..C..",
      "....CC....R..RRR..R.....C..C.",
      "...W......R..RRR..R.....C.W.C",
      "...C.R....R.RRRRR.R.....RC..C",
      "..C.C..R..R.RRRRR.R..R...C.C.",
      "..C.C..R..RRRRRRRRR..R.....C.",
      ".WWWW..R..RRRRRRRRR..R....W..",
      "C......R.RRRRRRRRRRR.R..CC...",
      "C...C..RRRRRRRRRRRRRRR....W..",
      ".WWWC..RRR.RRRRRRR.RRR..W.W..",
      "..CCCR.RR..RR.R.RR..RR..W..C.",
      "...CC.CR......R......R.R.C.C.",
      ".....WW................R..C..",
      ".......CC...CC..C.....C..C...",
      "......C..R....R..C..RR..W....",
      ".......CC..W...C..WWCCCC.....",
      ".........CC.....CCCCWW.......",
      "..................WW.........",
    ],
    [
      "CC.........................CC",
      "..C.......CC.CCC...C......CC.",
      "...CC....CCCCCCCC...R...CCC..",
      "....C.R..CCCC.R.CC...CC.C....",
      ".....C..CC.R.C.CCC.....W.....",
      "...CC...CCW.CCCCCCCCC..WWW...",
      ".......C.CCCCC.CC.CCCC.......",
      "..R...CCC.CCCWCCCCCCCCCC.....",
      "CC..CCCCCWWWWWW.WWWRC.CC..CCC",
      "...CCC.C.WW..WWWW.WCRC.CC..C.",
      "..CCC.CCW.W.W.W..WWCCC.CC..CC",
      "..CC.CCCWWWW.W.W.WWWC.CCC.W..",
      "..CC.CCC.WWC..RW...WCCCC.....",
      "...CC.CCC....WWWWWW..CCC.....",
      "..CC.CCRWWWW.WRW....WCCCC....",
      "..CCC.CRWWW...WWR.WWWC.CCC...",
      "..CCCCCWW.WW.W.W.WWWWCC.CC...",
      "...CCCC.CWW.W.....WWRW.CCC...",
      "...CCCC.CW...WW.WW.WWWC.CC.R.",
      ".C..CC.CCW.WWWW.WWWWC.CC.....",
      "..C...CCCCCWRWCCCWRWC.CCC.C..",
      ".......CCCCCCCCCCCCC.CC......",
      "...CC..CC.CC.CCCC.CCC..WW....",
      "..C..W..CC..CC.CCC.CC..W.....",
      "....R.C..CCCCCC.CCCCC...C....",
      "...R..C...CC.CC...CC.....W...",
      "..C..................C....C..",
      ".C........CCCC......C......CC",
      "..........C.C................",
      ".........C...................",
    ],
    [
      "..C....CCCCCCC.CCCCC.C.WWCC.CC..",
      "..CCC.CCWW..CCCCCWW.W.W.WWC...R.",
      "...R..CCW.WW.CWWWW.WWWWW.WCC.R..",
      ".......WRWWWW.WWCWWWWCWWW.CC....",
      "....CCWWWWWCWWWRRWWWWWCWWW.C....",
      "...CWW.WCWWWCCCCW.WWWWWRWW.CCC..",
      "..CCW.WWCWWWWWWWW.WCWWRCW.WWWCC.",
      ".CCW.WWCWWWWW.WWW.WWWWWCWWWW.CC.",
      ".CC.WWWCWW.WWW.WW.WWW.WWWWCWC.CC",
      ".CC.WWWWWWW.WRWW.WWW.WW.WWCW.CC.",
      ".CCW.WRWW..W.W...W...WCW.WCWW.CC",
      "..CWWCWWCW..W..W..W.WWWW.WWWW.CC",
      "..CCWCWWCWW..W.W.W..WWW.WWWW.CCC",
      "...C.WCWCWC...WWWW...WWWWWW.CCC.",
      "..C.CWWWWW.WRWWWWRWW.WWWRW.CCC..",
      "..CCWRWWW...W..WW.....WWWWCCC...",
      "..CCWWCWWWWW.W..WW..WWWWWWCC.C..",
      "..CC.WWCWWW..W...W.WWWCWWRCC.CC.",
      "...CCWWWWWW.W.......WWWWWWCC.C.R",
      "....C.WWCW...WW.WWW..WWWWC...C..",
      "...CCWWW.WWWWWW.W.WW.WW..CC...CC",
      "...CCWWWW.WWRWWWWW.WWWWW.CCCC...",
      "....CCCCC.WWWWRWWWWWWRWW.WCCC...",
      "..R..CCCCC.W.WW.WWWWWWW.WWWCC...",
      ".C.....CCC.WW..WWWW.WCCCCCCC....",
      "....R..CC.CCCWWWWWWWCC.CCCC..WW.",
      "...CCC....CCCCCCW.WWC.......W...",
      "..RR.......CC...CWWWCC.....R.R..",
      ".CC............CCCCCCC........C.",
      "CC...............CCCC..........C",
    ],
    [
      "CC.........................WW",
      "..R.......WW.RWC...C......CC.",
      "...WW....WCCWWWWW...C...RWW..",
      "....W.W..WWWC.W.WW...WW.R....",
      ".....W..WW.W.W.CCW.....W.....",
      "...WW...WWW.WRCCCCWWW..WWW...",
      ".......W.WWWWW.WW.CWWW.......",
      "..W...CWW.WRWWWWWWWCWCWC.....",
      "CC..WWWWWWWWWWW.WWWRW.WC..WWW",
      "...WWW.W.WW..WWWW.WRWW.WC..W.",
      "..CWW.WWW.W.W.W..WWWWW.WW..RW",
      "..CW.WWWWWWW.W.W.WWWW.WWW.R..",
      "..WC.WWW.WWW..WR...WWWWC.....",
      "...RW.WWW....WWWWWW..WWC.....",
      "..CR.WWWWWWW.WWW....WWWWW....",
      "..CWW.WWWWW...WWW.WWWW.CWC...",
      "..CWCWWWW.WW.R.W.WWWWWW.WC...",
      "...WWWW.WWW.W.....WWWW.WWC...",
      "...WCWW.WW...WW.WW.WRWW.CW.R.",
      ".W..CW.WWW.WWWW.WWWWW.WW.....",
      "..W...CWWWWWCCWWWWWWW.CWC.C..",
      ".......CWWWWWWRWWWWW.WW......",
      "...WW..CC.WW.WWWW.WWW..WW....",
      "..W..W..CW..CC.WWW.WC..W.....",
      "....W.W..WCCCWW.CCWWC...W....",
      "...W..W...WW.WW...WC.....C...",
      "..R..................C....R..",
      ".R........WWWW......C......WW",
      "..........W.W................",
      ".........W...................",
    ],
  ];
  // 8x8 arcade font (hand-recreated from the HUD/results text seen in MAME)
  // 8x8 arcade font, hand-transcribed from MAME screen text ('!' authored)
  const FONT = {
    "!": ["...##...", "...##...", "...##...", "...##...", "...##...", "........", "...##..."],
    "%": ["..#....#", ".#.#..#.", "..#..#..", "....#...", "...#..#.", "..#..#.#", ".#....#."],
    "-": ["........", "........", "........", "########", "........", "........", "........"],
    ".": ["........", "........", "........", "........", "........", "..##....", "..##...."],
    "0": ["...###..", "..#..##.", ".##...##", ".##...##", ".##...##", "..##..#.", "...###.."],
    "1": ["....##..", "...###..", "....##..", "....##..", "....##..", "....##..", "..######"],
    "2": ["..#####.", ".##...##", ".....###", "...####.", "..####..", ".###....", ".#######"],
    "3": ["..######", ".....##.", "....##..", "...####.", "......##", ".##...##", "..#####."],
    "4": ["....###.", "...####.", "..##.##.", ".##..##.", ".#######", ".....##.", ".....##."],
    "5": [".######.", ".##.....", ".######.", "......##", "......##", ".##...##", "..#####."],
    "6": ["...####.", "..##....", ".##.....", ".######.", ".##...##", ".##...##", "..#####."],
    "7": [".#######", ".##...##", ".....##.", "....##..", "...##...", "...##...", "...##..."],
    "8": ["..####..", ".##...#.", ".###..#.", "..####..", ".#..####", ".#....##", "..#####."],
    "9": ["..#####.", ".##...##", ".##...##", "..######", "......##", ".....##.", "..####.."],
    "A": ["...###..", "..##.##.", ".##...##", ".##...##", ".#######", ".##...##", ".##...##"],
    "B": [".######.", ".##...##", ".##...##", ".######.", ".##...##", ".##...##", ".######."],
    "C": ["...####.", "..##..##", ".##.....", ".##.....", ".##.....", "..##..##", "...####."],
    "D": [".#####..", ".##..##.", ".##...##", ".##...##", ".##...##", ".##..##.", ".#####.."],
    "E": ["..######", "..##....", "..##....", "..#####.", "..##....", "..##....", "..######"],
    "F": [".#######", ".##.....", ".##.....", ".######.", ".##.....", ".##.....", ".##....."],
    "G": ["...#####", "..##....", ".##.....", ".##..###", ".##...##", "..##..##", "...#####"],
    "H": [".##...##", ".##...##", ".##...##", ".#######", ".##...##", ".##...##", ".##...##"],
    "I": ["..######", "....##..", "....##..", "....##..", "....##..", "....##..", "..######"],
    "L": ["..##....", "..##....", "..##....", "..##....", "..##....", "..##....", "..######"],
    "M": [".##...##", ".###.###", ".#######", ".#######", ".##.#.##", ".##...##", ".##...##"],
    "N": [".##...##", ".###..##", ".####.##", ".#######", ".##.####", ".##..###", ".##...##"],
    "O": ["..#####.", ".##...##", ".##...##", ".##...##", ".##...##", ".##...##", "..#####."],
    "P": [".######.", ".##...##", ".##...##", ".##...##", ".######.", ".##.....", ".##....."],
    "R": [".######.", ".##...##", ".##...##", ".##..###", ".#####..", ".##.###.", ".##..###"],
    "S": ["..####..", ".##..##.", ".##.....", "..#####.", "......##", ".##...##", "..#####."],
    "T": ["..######", "....##..", "....##..", "....##..", "....##..", "....##..", "....##.."],
    "U": [".##...##", ".##...##", ".##...##", ".##...##", ".##...##", ".##...##", "..#####."],
    "V": [".##...##", ".##...##", ".##...##", ".###.###", "..#####.", "...###..", "....#..."],
    "Y": ["..##..##", "..##..##", "..##..##", "...####.", "....##..", "....##..", "....##.."],
    "J": [".....##.", ".....##.", ".....##.", ".....##.", ".....##.", ".##..##.", "..####.."],
    "K": [".##...##", ".##..##.", ".##.##..", ".####...", ".##.##..", ".##..##.", ".##...##"],
    "Q": ["..#####.", ".##...##", ".##...##", ".##...##", ".##.#.##", ".##..##.", "..####.#"],
    "W": [".##...##", ".##...##", ".##.#.##", ".#######", ".#######", ".###.###", ".##...##"],
    "X": [".##...##", ".###.###", "..#####.", "...###..", "..#####.", ".###.###", ".##...##"],
    "Z": [".#######", ".....###", "....###.", "...###..", "..###...", ".###....", ".#######"],
    "_": ["........", "........", "........", "........", "........", "........", ".#######"],
  };
  function drawText(str, col, row, color) {
    // col/row in 8px arcade character cells
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = color;
    for (let k = 0; k < str.length; k++) {
      const g = FONT[str[k]];
      if (!g) continue;
      for (let j = 0; j < g.length; j++)
        for (let i = 0; i < 8; i++) if (g[j][i] === "#") ctx.fillRect((col + k) * 8 + i, row * 8 + j, 1, 1);
    }
    ctx.restore();
  }
  function scoreStr(n) { return n === 0 ? "00" : String(n); }
  let hudBlink = 0;
  function drawHUD() {
    hudBlink += 1;
    const playing = state !== "title";
    if (!playing || ((hudBlink / 16) | 0) % 2 === 0) drawText("1UP", 3, 0, "#ff0000");
    drawText("HIGH SCORE", 9, 0, "#ff0000");
    const sc = scoreStr(score);
    drawText(sc, 7 - sc.length, 1, "#dedede");
    const hs = String(Math.max(high, 20000));
    drawText(hs, 17 - hs.length, 1, "#dedede");
    // reserve fighters bottom-left (16 px pitch)
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const res = Math.max(0, lives - (player && player.alive ? 1 : 0));
    const rc = sprCanvas(SPR_RESERVE);
    for (let i = 0; i < Math.min(res, 6); i++) ctx.drawImage(rc, 1 + i * 16, 273);
    // stage badges bottom-right: 50/30/20/10 (16 px) then 5/1 (8 px), right-aligned
    let n = stage;
    const list = [];
    for (const [v, spr] of [[50, SPR_BADGE50], [30, SPR_BADGE30], [20, SPR_BADGE20], [10, SPR_BADGE10], [5, SPR_BADGE5], [1, SPR_BADGE1]]) {
      while (n >= v) { list.push([v, spr]); n -= v; }
    }
    let x = 224;
    for (let i = list.length - 1; i >= 0; i--) {
      const [v, spr] = list[i];
      const c = sprCanvas(spr);
      x -= v >= 10 ? 16 : 8;
      ctx.drawImage(c, x + (v >= 10 ? (16 - c.width) >> 1 : 0) + (v >= 10 ? -1 : 2), 288 - c.height - 1);
      if (x < 120) break;
    }
    ctx.restore();
  }

  function drawStars() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const f = starFrame | 0;
    for (const st of stars) {
      if (((f + st.set * 8) & 31) >= 16) continue;
      ctx.fillStyle = st.c;
      ctx.fillRect(st.x, st.y | 0, 1, 1);
    }
    ctx.restore();
  }

  function drawPlayer() {
    if (!player || !player.alive) return;
    if (invuln > 0 && ((invuln / 70) | 0) % 2 === 0) return;
    const x = player.x;
    const y = player.y;
    const n = fighterCount;
    const px = SPR_PX_SHIP;
    if (n <= 1) {
      blit(x, y, SPR_FIGHTER, px);
    } else if (n === 2) {
      blit(x - 16, y, SPR_FIGHTER, px);
      blit(x + 16, y, SPR_FIGHTER, px);
    } else {
      blit(x - 32, y, SPR_FIGHTER, px);
      blit(x, y, SPR_FIGHTER, px);
      blit(x + 32, y, SPR_FIGHTER, px);
    }
  }

  function drawEnemy(e) {
    if (e.state === "dead") return;
    if (e.x < -60 || e.x > VW + 60 || e.y < -60) return;
    const x = e.x;
    // Soft bob in formation (arcade Boss/formation sway)
    const bob =
      e.state === "form" || e.state === "idle"
        ? Math.sin((e.flap || 0) / 180) * (e.type === "boss" ? 2.2 : 1.2)
        : 0;
    const y = e.y + bob;
    const frame = ((e.flap / 533) | 0) % 2;

    ctx.save();
    ctx.translate(x, y);
    if (e.xchild) {
      ctx.rotate(e.angle - Math.PI / 2);
    } else if (e.state === "dive" || e.state === "challenge" || e.state === "enter") {
      ctx.rotate(e.angle + Math.PI / 2);
    }

    if (e.type === "hostile") {
      blit(0, 0, SPR_CAPTURED, SPR_PX_SHIP * 0.95);
    } else if (e.type === "bee") {
      blit(0, 0, SPR_BEE[frame], SPR_PX);
    } else if (e.type === "butterfly") {
      blit(0, 0, SPR_BUTTER[frame], SPR_PX * 1.02);
    } else if (SPR_THEME[e.type]) {
      blit(0, 0, SPR_THEME[e.type][frame % SPR_THEME[e.type].length], SPR_PX);
    } else if (e.type === "boss") {
      const hurt = e.hp < 2;
      drawBossSprite(0, 0, hurt, frame);
      if (e.hasCaptive || (captureSeq && captureSeq.boss === e && captureSeq.attached)) {
        blit(0, 28, SPR_CAPTURED, SPR_PX_SHIP * 0.88);
      }
    }

    ctx.restore();
  }

  // V28: Challenging Stage theme sprites (original pixel art, not ROM data)
  const SPR_THEME = {
    tonbo: [[
      "......Y......", ".....YGY.....", "GGG..GGG..GGG", ".GGGGGGGGGGG.", "...GG.G.GG...",
      "......G......", "......G......", "......G......", "......Y......", "......Y......"]],
    ogawa: [[
      "....ooooo....", "..ooOOOOOoo..", ".oOOoOOOoOOo.", "oOOOOOOOOOOOo", "oOoOoOoOoOoOo",
      "oOOOOOOOOOOOo", ".oOOoOOOoOOo.", "..ooOOOOOoo..", "..W.W...W.W..", "............."]],
    momiji: [[
      "......R......", ".....RRR.....", "R...RRRRR...R", "RR.RRoRoRR.RR", ".RRRRoooRRRR.",
      "..RRRRoRRRR..", ".RRR.RRR.RRR.", "R.....R.....R", "......o......", "......o......"]],
    ei: [[
      "......C......", ".....CGC.....", "...CCGGGCC...", ".CCGGGWGGGCC.", "CGGGGWWWGGGGC",
      ".CCGGGGGGGCC.", "...CC.G.CC...", "......G......", "......G......", "......C......"]],
    galboss: [[
      "....GG.GG....", "...GGGGGGG...", "..GGoGGGoGG..", "...GGGGGGG...", "..G.GGGGG.G..",
      ".GG.YYYYY.GG.", "GG..YoYoY..GG", "GG..YYYYY..GG", ".G...Y.Y...G.", "............."]],
    ship: [[
      "......W......", ".....WWW.....", ".....WRW.....", "....WWWWW....", "...WWBWBWW...",
      "..WWWWWWWWW..", ".RWW.WWW.WWR.", "RR...WWW...RR", "R.....R.....R", "............."]],
  };
  // V31: hand-drawn transform ships (original pixel art in the arcade's spirit)
  SPR_THEME.scorpion = [[
    "....G...G....", "...GYG.GYG...", "....G...G....", "..GGGGGGGGG..", ".GGYGGGGGYGG.",
    "GG.GGGYGGG.GG", "G..GGGGGGG..G", "....GGGGG....", ".....GYG.....", "......G......", "......Y......"], [
    "....G...G....", "...GYG.GYG...", "....G...G....", "..GGGGGGGGG..", ".GGYGGGGGYGG.",
    ".GGGGGYGGGGG.", "G..GGGGGGG..G", "G...GGGGG...G", ".....GYG.....", "......G......", "......Y......"]];
  SPR_THEME.bosconian = [[
    "......Y......", ".....YYY.....", "....YYBYY....", "...YYBBBYY...", "..YYYBBBYYY..",
    ".YY.YYBYY.YY.", "YY..YYYYY..YY", "Y....YYY....Y", ".....R.R.....", ".....R.R....."]];
  SPR_THEME.galflag = [[
    "......Y......", ".....YYY.....", "..R..YRY..R..", ".RR.YYYYY.RR.", "RRbbYYYYYbbRR",
    "RbbbbYYYbbbbR", "Rbb.bbYbb.bbR", "R....bbb....R", ".....b.b.....", "............."]];
  function drawBossSprite(ox, oy, hurt, frame) {
    const rows = hurt ? SPR_BOSS_HURT[frame] : SPR_BOSS[frame];
    blit(ox, oy, rows, SPR_PX_BOSS);
  }

  function drawBullets() {
    for (const b of bullets) blit(b.x, b.y - 4, SPR_SHOT, 1);
    for (const b of eBullets) blit(b.x, b.y, SPR_EBULLET, 1);
  }

  // Tractor beam as seen in MAME: 44x72 nested-arc pattern whose three
  // colours (#0068de/#00b8de/#00ffde) rotate every few frames.
  const SPR_BEAM = [
    ["..............c..............c..............","..............c..............c..............","..............c..............c..............","...............c............c...............","...............c............c...............",".............C..cc........cc..C.............","..............C...c......c...C..............","...............CC..cccccc..CC...............",".................CC......CC.................",".............B.....CCCCCC.....B.............","..............BB............BB..............","................BBB......BBB................","............c......BBBBBB......c............",".............cc..............cc.............","...........C...cc..........cc...C...........","............CC...cccccccccc...CC............","..............CC............CC..............","...........B....CCCCCCCCCCCC....B...........","............BB................BB............","..............BBB..........BBB..............","..........c......BBBBBBBBBB......c..........","...........ccc................ccc...........","..........C...ccc..........ccc...C..........","...........CCC...cccccccccc...CCC...........","..............CC............CC..............",".........B......CCCCCCCCCCCC......B.........","..........BBB..................BBB..........",".............BBB............BBB.............",".........c......BBBBBBBBBBBB......c.........","..........cc....................cc..........","........C...cccc............cccc...C........",".........CCC....cccccccccccc....CCC.........","............CCCC............CCCC............","........B.......CCCCCCCCCCCC.......B........",".........BB......................BB.........","...........BBBB..............BBBB...........",".......c.......BBBBBBBBBBBBBB.......c.......","........ccc......................ccc........","...........cccc..............cccc...........","...............cccccccccccccc...............","......CCCCCCCC................CCCCCCCC......","......B.......CCCCCCCCCCCCCCCC.......B......",".......BBB........................BBB.......","..........BBBB................BBBB..........",".....c........BBBBBBBBBBBBBBBB........c.....","......cccc........................cccc......","..........ccccc..............ccccc..........",".....C.........cccccccccccccc.........C.....","......CCCCCCCC................CCCCCCCC......","....BBB.......CCCCCCCCCCCCCCCC.......BBB....",".......BBBB......................BBBB.......","...........BBB................BBB...........","....ccc.......BBBBBBBBBBBBBBBB.......ccc....",".......cccc......................cccc.......","...........cccccc..........cccccc...........","....CC...........cccccccccc...........CC....","......CCCCCCCCC..............CCCCCCCCC......","...BBB.........CCCCCCCCCCCCCC.........BBB...","......BBBB........................BBBB......","..........BBBB................BBBB..........","..ccc.........BBBBBBBBBBBBBBBB.........ccc..",".....cccc..........................cccc.....","..CC.....ccccc................ccccc.....CC..","....CC........cccccccccccccccc........CC....","......CCCCCCCC................CCCCCCCC......",".BB...........CCCCCCCCCCCCCCCC...........BB.","...BBBBB............................BBBBB...","........BBBBBB................BBBBBB........",".ccc..........BBBBBBBBBBBBBBBB..........ccc.","....ccccc..........................ccccc....","CCC......ccccc................ccccc......CCC","...CCC........cccccccccccccccc........CCC..."],
    ["..............B..............B..............","..............B..............B..............","..............B..............B..............","...............B............B...............","...............B............B...............",".............c..BB........BB..c.............","..............c...B......B...c..............","...............cc..BBBBBB..cc...............",".................cc......cc.................",".............C.....cccccc.....C.............","..............CC............CC..............","................CCC......CCC................","............B......CCCCCC......B............",".............BB..............BB.............","...........c...BB..........BB...c...........","............cc...BBBBBBBBBB...cc............","..............cc............cc..............","...........C....cccccccccccc....C...........","............CC................CC............","..............CCC..........CCC..............","..........B......CCCCCCCCCC......B..........","...........BBB................BBB...........","..........c...BBB..........BBB...c..........","...........ccc...BBBBBBBBBB...ccc...........","..............cc............cc..............",".........C......cccccccccccc......C.........","..........CCC..................CCC..........",".............CCC............CCC.............",".........B......CCCCCCCCCCCC......B.........","..........BB....................BB..........","........c...BBBB............BBBB...c........",".........ccc....BBBBBBBBBBBB....ccc.........","............cccc............cccc............","........C.......cccccccccccc.......C........",".........CC......................CC.........","...........CCCC..............CCCC...........",".......B.......CCCCCCCCCCCCCC.......B.......","........BBB......................BBB........","...........BBBB..............BBBB...........","...............BBBBBBBBBBBBBB...............","......cccccccc................cccccccc......","......C.......cccccccccccccccc.......C......",".......CCC........................CCC.......","..........CCCC................CCCC..........",".....B........CCCCCCCCCCCCCCCC........B.....","......BBBB........................BBBB......","..........BBBBB..............BBBBB..........",".....c.........BBBBBBBBBBBBBB.........c.....","......cccccccc................cccccccc......","....CCC.......cccccccccccccccc.......CCC....",".......CCCC......................CCCC.......","...........CCC................CCC...........","....BBB.......CCCCCCCCCCCCCCCC.......BBB....",".......BBBB......................BBBB.......","...........BBBBBB..........BBBBBB...........","....cc...........BBBBBBBBBB...........cc....","......ccccccccc..............ccccccccc......","...CCC.........cccccccccccccc.........CCC...","......CCCC........................CCCC......","..........CCCC................CCCC..........","..BBB.........CCCCCCCCCCCCCCCC.........BBB..",".....BBBB..........................BBBB.....","..cc.....BBBBB................BBBBB.....cc..","....cc........BBBBBBBBBBBBBBBB........cc....","......cccccccc................cccccccc......",".CC...........cccccccccccccccc...........CC.","...CCCCC............................CCCCC...","........CCCCCC................CCCCCC........",".BBB..........CCCCCCCCCCCCCCCC..........BBB.","....BBBBB..........................BBBBB....","ccc......BBBBB................BBBBB......ccc","...ccc........BBBBBBBBBBBBBBBB........ccc..."],
    ["..............C..............C..............","..............C..............C..............","..............C..............C..............","...............C............C...............","...............C............C...............",".............B..CC........CC..B.............","..............B...C......C...B..............","...............BB..CCCCCC..BB...............",".................BB......BB.................",".............c.....BBBBBB.....c.............","..............cc............cc..............","................ccc......ccc................","............C......cccccc......C............",".............CC..............CC.............","...........B...CC..........CC...B...........","............BB...CCCCCCCCCC...BB............","..............BB............BB..............","...........c....BBBBBBBBBBBB....c...........","............cc................cc............","..............ccc..........ccc..............","..........C......cccccccccc......C..........","...........CCC................CCC...........","..........B...CCC..........CCC...B..........","...........BBB...CCCCCCCCCC...BBB...........","..............BB............BB..............",".........c......BBBBBBBBBBBB......c.........","..........ccc..................ccc..........",".............ccc............ccc.............",".........C......cccccccccccc......C.........","..........CC....................CC..........","........B...CCCC............CCCC...B........",".........BBB....CCCCCCCCCCCC....BBB.........","............BBBB............BBBB............","........c.......BBBBBBBBBBBB.......c........",".........cc......................cc.........","...........cccc..............cccc...........",".......C.......cccccccccccccc.......C.......","........CCC......................CCC........","...........CCCC..............CCCC...........","...............CCCCCCCCCCCCCC...............","......BBBBBBBB................BBBBBBBB......","......c.......BBBBBBBBBBBBBBBB.......c......",".......ccc........................ccc.......","..........cccc................cccc..........",".....C........cccccccccccccccc........C.....","......CCCC........................CCCC......","..........CCCCC..............CCCCC..........",".....B.........CCCCCCCCCCCCCC.........B.....","......BBBBBBBB................BBBBBBBB......","....ccc.......BBBBBBBBBBBBBBBB.......ccc....",".......cccc......................cccc.......","...........ccc................ccc...........","....CCC.......cccccccccccccccc.......CCC....",".......CCCC......................CCCC.......","...........CCCCCC..........CCCCCC...........","....BB...........CCCCCCCCCC...........BB....","......BBBBBBBBB..............BBBBBBBBB......","...ccc.........BBBBBBBBBBBBBB.........ccc...","......cccc........................cccc......","..........cccc................cccc..........","..CCC.........cccccccccccccccc.........CCC..",".....CCCC..........................CCCC.....","..BB.....CCCCC................CCCCC.....BB..","....BB........CCCCCCCCCCCCCCCC........BB....","......BBBBBBBB................BBBBBBBB......",".cc...........BBBBBBBBBBBBBBBB...........cc.","...ccccc............................ccccc...","........cccccc................cccccc........",".CCC..........cccccccccccccccc..........CCC.","....CCCCC..........................CCCCC....","BBB......CCCCC................CCCCC......BBB","...BBB........CCCCCCCCCCCCCCCC........BBB..."],
  ];
  function drawBeams() {
    for (const beam of beams) {
      const e = beam.enemy;
      if (!e) continue;
      const active =
        e.state === "beam" ||
        (captureSeq &&
          captureSeq.boss === e &&
          (captureSeq.phase === "lock" || captureSeq.phase === "pull" || captureSeq.phase === "attach"));
      if (!active) continue;
      const fr = SPR_BEAM[((performance.now() / 100) | 0) % 3];
      const full = beamFullLen(e);
      const len = e.state === "beam" ? (e.beamLen != null ? e.beamLen : 0) : full;
      const n = Math.max(0, Math.min(fr.length, Math.round((fr.length * len) / full)));
      if (n < 1) continue;
      const c = sprCanvas(fr);
      const m = ctx.getTransform();
      const ax = Math.round(m.a * e.x + m.e - c.width / 2);
      const ay = Math.round(m.d * e.y + m.f + 8);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(c, 0, 0, c.width, n, ax, ay, c.width, n);
      ctx.restore();
    }
  }

  function drawParticles() {
    for (const p of particles) {
      if (!p.expl) continue;
      const frames = p.pexp ? SPR_PEXP : SPR_EXP;
      const elapsed = p.explDur - p.life;
      const fi = Math.min(frames.length - 1, (elapsed / (p.explDur / frames.length)) | 0);
      blit(p.x, p.y, frames[fi], 1);
    }
  }

  function drawMessages() {
    drawMsgs();
    if (false) {
      ctx.fillStyle = C.yellow;
      ctx.font = '12px "Press Start 2P", monospace';
      ctx.textAlign = "center";
      ctx.fillText(message, VW / 2, VH * 0.55);
    }
  }

  function render() {
    ctx.setTransform(AW / VW, 0, 0, AH / VH, 0, 0);
    ctx.imageSmoothingEnabled = false;
    fillRect(0, 0, VW, VH, C.black);
    drawStars();
    drawBeams();
    for (const e of enemies) drawEnemy(e);
    drawBullets();
    drawParticles();
    drawPlayer();
    if (captureSeq) drawCaptureFighter(captureSeq);
    if (rescueSeq) drawRescueFighter(rescueSeq);
    drawMessages();
    drawAttract();
    drawHUD();
  }

  // ── Loop ─────────────────────────────────────────────────────────────────
  let last = 0;
  function tick(ts) {
    if (!last) last = ts;
    let dt = ts - last;
    last = ts;
    if (dt > 50) dt = 50;
    try {
      update(dt);
      render();
    } catch (err) {
      console.error(err);
      showOV("ERROR", String(err.message || err).slice(0, 48), "RELOAD");
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ── Input ────────────────────────────────────────────────────────────────
  window.addEventListener(
    "keydown",
    (e) => {
      keys[e.code] = true;
      keys[e.key] = true;
      if (["ArrowLeft", "ArrowRight", " ", "ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
      }
      unlockAudio();
      if (state === "title") idleT = 0;
      if (attract) {
        e.preventDefault();
        stopAttract();
        if (e.code === "Space" || e.key === " " || e.key === "Enter") beginGame();
        return;
      }
      if (state === "initials") {
        e.preventDefault();
        const arrow = e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown";
        if (e.repeat && !arrow) return;
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") iniMove(-1);
        else if (e.key === "ArrowRight" || e.key === "ArrowUp") iniMove(1);
        else if (e.key === "Enter" || e.key === " " || e.code === "Space") iniConfirm();
        else if (e.key === "Backspace") iniBack();
        else if (/^[a-zA-Z.]$/.test(e.key)) iniSet(e.key.toUpperCase());
        return;
      }
      if (e.key === "m" || e.key === "M") {
        muted = !muted;
        if (master) master.gain.value = muted ? 0 : 0.9;
        if (muted) { stopBeamHum(); if (wsg) wsg.silenceAll(); }
        return;
      }
      if (e.key === "p" || e.key === "P" || e.key === "Escape") {
        if (state === "play") {
          state = "pause";
          showOV("PAUSED", "PRESS P OR SPACE", "");
        } else if (state === "pause") {
          state = "play";
          hideOV();
        }
        return;
      }
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        if (canStart()) beginGame();
        else if (state === "pause") {
          state = "play";
          hideOV();
        } else {
          fireHeld = true;
          if (!e.repeat) fire(); // V28: one shot per press
        }
      }
    },
    { passive: false }
  );
  window.addEventListener("keyup", (e) => {
    keys[e.code] = false;
    keys[e.key] = false;
    if (e.code === "Space" || e.key === " ") fireHeld = false;
  });

  function bindBtn(id, down, up) {
    const el = document.getElementById(id);
    if (!el) return;
    const d = (ev) => {
      ev.preventDefault();
      try { if (ev.pointerId !== undefined) el.setPointerCapture(ev.pointerId); } catch (e) {}
      unlockAudio();
      idleT = 0;
      if (attract) { stopAttract(); if (id === "btn-fire") beginGame(); return; }
      down();
    };
    const u = (ev) => {
      ev.preventDefault();
      if (up) up();
    };
    el.addEventListener("pointerdown", d);
    el.addEventListener("pointerup", u);
    el.addEventListener("pointerleave", u);
    el.addEventListener("pointercancel", u);
  }

  bindBtn("btn-left", () => { if (state === "initials") iniMove(-1); else leftHeld = true; }, () => (leftHeld = false));
  bindBtn("btn-right", () => { if (state === "initials") iniMove(1); else rightHeld = true; }, () => (rightHeld = false));
  bindBtn(
    "btn-fire",
    () => {
      fireHeld = true;
      if (state === "initials") { iniConfirm(); return; }
      if (canStart()) beginGame();
      else if (state === "pause") {
        state = "play";
        hideOV();
      } else fire();
    },
    () => (fireHeld = false)
  );
  bindBtn(
    "btn-pause",
    () => {
      if (state === "play") {
        state = "pause";
        showOV("PAUSED", "TAP FIRE TO RESUME", "");
      } else if (state === "pause") {
        state = "play";
        hideOV();
      } else if (canStart()) beginGame();
    },
    () => {}
  );
  bindBtn(
    "btn-mute",
    () => {
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : 0.9;
      if (muted) { stopBeamHum(); if (wsg) wsg.silenceAll(); }
    },
    () => {}
  );

  // Touch drag on canvas to move
  let dragging = false;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    unlockAudio();
    canvas.setPointerCapture(e.pointerId);
    idleT = 0;
    if (attract) { stopAttract(); dragging = false; beginGame(); return; }
    if (state === "initials") {
      const rect = canvas.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / rect.width;
      dragging = false;
      if (fx < 0.33) iniMove(-1); else if (fx > 0.67) iniMove(1); else iniConfirm();
      return;
    }
    if (canStart()) beginGame();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging || !player || !player.alive) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * VW;
    player.x = clamp(x, 20, VW - 20);
  });
  canvas.addEventListener("pointerup", () => {
    dragging = false;
  });

  if (overlay) {
    overlay.style.pointerEvents = "auto";
    overlay.addEventListener("click", () => {
      unlockAudio();
      idleT = 0;
      if (attract) { stopAttract(); return; }
      if (canStart()) beginGame();
      else if (state === "pause") {
        state = "play";
        hideOV();
      }
    });
  }

  // Boot
  initStars();
  hud();
  if ($high) $high.textContent = pad(high);
  renderHsDom();
  // V31: ONE scaled stage — uniform min-ratio scale of the 224x288 raster,
  // centred, recomputed on resize / orientationchange / visualViewport.
  function fitInteger() {
    const wrap = document.getElementById("canvas-wrap");
    if (!wrap) return;
    const vv = window.visualViewport;
    const vw = Math.round(vv ? vv.width : innerWidth), vh = Math.round(vv ? vv.height : innerHeight);
    const touch = matchMedia("(max-width: 900px), (pointer: coarse)").matches;
    const land = touch && vw > vh && vh <= 520;
    let aw = vw - 16, ah = vh - 16;
    if (land) aw = vw - 2 * 196;            // L/R pad on left, FIRE + pause/mute on right
    else if (touch) ah = vh - 124;           // controls row under the stage
    const k = Math.max(0.5, Math.min(aw / AW, ah / AH));
    const w = Math.floor(k * AW), h = Math.floor(k * AH);
    const set = (el, prop, v) => el.style.setProperty(prop, v, "important");
    set(canvas, "width", w + "px"); set(canvas, "height", h + "px");
    set(canvas, "max-height", "none"); set(canvas, "max-width", "none");
    set(wrap, "width", w + 6 + "px"); set(wrap, "height", h + 6 + "px");
    if (land) {
      set(wrap, "position", "fixed");
      set(wrap, "left", Math.round((vw - w - 6) / 2) + "px");
      set(wrap, "top", Math.round((vh - h - 6) / 2) + "px");
    } else {
      set(wrap, "position", "relative"); set(wrap, "left", "auto"); set(wrap, "top", "auto");
    }
    document.body.dataset.layout = land ? "landscape" : touch ? "portrait" : "desktop";
    window.__stageScale = k;
  }
  let fitRaf = 0;
  const refit = () => { cancelAnimationFrame(fitRaf); fitRaf = requestAnimationFrame(fitInteger); };
  window.addEventListener("resize", refit);
  window.addEventListener("orientationchange", () => { refit(); setTimeout(fitInteger, 250); setTimeout(fitInteger, 700); });
  if (window.visualViewport) visualViewport.addEventListener("resize", refit);
  setTimeout(fitInteger, 0);

  // Test hook (headless QA): jump to a stage
  window.__galagaQA = { dual: () => { fighterCount = 2; syncFighters(); return fighterCount; }, xform: () => { window.__xformP = 1; const b = enemies.find((e) => e.type === "bee" && e.state === "form"); if (!b) return false; startDive(b); return !!b.xformAt; }, xinfo: () => enemies.filter((e) => e.xchild).map((e) => [e.type, e.state, e.x | 0, e.y | 0]), forceDive: (t) => { const b = enemies.find((e) => e.type === t && e.state === "form"); if (b) startDive(b); return !!b; }, attract: () => ({ ph: attract && attract.phase, t: attract && attract.t, demo, log: window.__attractLog, cap: capturedHeld, fc: fighterCount, score }), stage: (n) => beginStage(n), setScore: (n) => { score = n; }, gameOver: () => { lives = 0; gameOver(); }, hs: () => hsTable, ini: () => ini && { letters: ini.letters.join(""), cur: HS_CHARS[ini.cur] }, pattern: () => ({ entry: stagePattern(stage), ch: window.__chVariant, chName: window.__chName }), info: () => ({ state, stage, score, lives, n: enemies.length, formFull, px: player && player.x, palive: !!(player && player.alive), cap: !!captureSeq, beams: enemies.filter((e) => e.state === "beam").map((e) => ({ x: e.x, y: e.y, t: e.beamT, hp: e.hp })) }),
    forceBeam: () => { const b = enemies.find((e) => e.type === "boss" && e.state === "form"); if (!b) return false; b.state = "dive"; b.divePath = [{ x: b.x, y: b.y }]; b.pathPos = 0; beginTractorBeam(b); return true; },
    setLives: (n) => { lives = n; hud(); },
    msgs: () => msgLines.map((l) => l.t + "@" + l.row + "@" + l.col), ch: () => ({ hits: challengeHits, shots: challengeShots, clock: chClock, isChallenge, bullets: bullets.length, en: enemies.filter((e) => e.state !== "dead" && e.x > -50).map((e) => ({ x: e.x, y: e.y, t: e.type, hp: e.hp })) }),
    chAt: (f) => enemies.filter((e) => e.state === "challenge").map((e) => { const idx = (chClock + f - e.chStart) / 2; if (idx < 0 || idx >= e.chPath.length / 2 - 1) return null; const q = chPos(e.chPath, idx); return { x: q.x, y: q.y, id: e.id, hp: e.hp, rem: (e.chPath.length / 2 - 1 - idx) * 2 }; }).filter(Boolean),
    bul: () => bullets.filter((b) => b.friendly && b.y > -20).map((b) => ({ x: b.x, y: b.y })),
    kill: () => { invuln = 0; killPlayer(); }, clearAll: () => { enemies = []; }, setInvuln: (ms) => { invuln = ms; }, setPX: (x) => { if (player) player.x = x; }, hitBeamBoss: () => { const b = enemies.find((e) => e.state === "beam"); if (b) { killEnemy(b, true); killEnemy(b, true); } return !!b; } };
  showOV("GALAGA", "INSERT COIN", "BUILD V31 - PRESS SPACE OR TAP");
})();
