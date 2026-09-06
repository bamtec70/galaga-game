/**
 * GALAGA — Namco / Midway 1981 style recreation (Build V20)
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
  canvas.width = VW * SCALE;
  canvas.height = VH * SCALE;
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
  // V19: further ear-retune from private analysis — still constants only.
  // Galaga CPU3 drove a 3-voice WSG; 54xx-style LFSR covers shot/boom grit.
  let AC = null;
  let master = null;
  let muted = false;
  let wsg = null;          // { voices, schedule, node, ready }
  let noiseBuf = null;
  let beamLoopUntil = 0;
  let beamTimer = null;
  let beamActive = false;

  // 8 × 32 samples (0..15). Hand-authored to match Namco WSG cabinet
  // character (32-sample 4-bit stair-step). Values informed by private
  // PROM analysis — constants only; no PROM dumps or PCM in the repo.
  const WSG_WAVES_4BIT = [
    // 0 sine-ish (smooth lead) — slightly fuller mid for prelude lead
    [7,9,11,12,13,14,14,14,14,13,13,12,11,10,8,7,5,4,3,2,1,1,0,0,0,1,1,2,3,4,5,6],
    // 1 gated-buzzy (tractor / dive wail) — tighter gate duty (cabinet grit)
    [8,10,11,8,14,14,8,15,8,14,14,8,11,10,8,6,8,4,8,2,8,1,8,0,8,0,8,1,8,3,8,5],
    // 2 square (shots / accents)
    [15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    // 3 soft double-hump (harmony)
    [11,13,14,13,12,10,8,7,8,10,12,13,14,13,11,8,4,2,1,2,3,5,7,7,6,5,3,2,1,2,4,7],
    // 4 rich double-sine / brass (tractor sub)
    [7,10,12,14,14,13,11,9,6,3,1,0,0,1,3,5,8,12,14,14,12,9,5,2,0,0,1,3,6,12,8,1],
    // 5 metallic sparse (hits / sizzle) — brighter partials
    [8,15,12,8,13,15,9,6,13,15,12,7,11,10,6,1,9,14,8,3,6,8,2,0,4,9,5,1,4,7,3,0],
    // 6 warm saw / organ body (fanfare / dive body)
    [7,9,11,13,14,14,13,12,11,10,8,7,5,5,6,8,9,10,11,11,9,7,5,4,3,3,2,2,4,6,8,9],
    // 7 hollow organ (challenge / climb / capture lower)
    [10,12,13,11,7,6,8,11,14,14,12,9,5,4,5,7,9,9,7,3,1,0,1,3,6,8,7,4,2,2,4,7],
  ];

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
            wn.connect(master);
            try {
              sp.disconnect();
            } catch (_) {}
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
        master.gain.value = 0.9;
        master.connect(AC.destination);
        ensureNoiseBuf();
        wsg = createWSGEngine();
      }
      if (AC.state === "suspended") AC.resume();
      ensureNoiseBuf();
    } catch (_) {}
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

  function sfx(name) {
    unlockAudio();
    if (muted || !AC || !wsg) return;

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
      startBeamHum(1.95);
      // Pull-in cascade (V19) — denser chromatic drop, more gated grit
      const cap = [523, 466, 415, 370, 330, 294, 262, 233, 208, 185, 165, 147, 131, 117, 104];
      cap.forEach((f, i) => {
        const t = i * 0.078;
        vsched(1, t, f, 14, 1, i === 0);
        vsched(2, t, f * 0.5, 10, 7, i === 0);
        vsched(1, t + 0.068, f * 0.96, 0, 1, false);
        vsched(2, t + 0.068, f * 0.47, 0, 7, false);
      });
      noise(0.6, 0.045, 0.1, 480, 0.5, 100);
    } else if (name === "rescue") {
      stopBeamHum();
      vseq(
        1,
        [
          [523, 0.07],
          [659, 0.07],
          [784, 0.07],
          [988, 0.085],
          [1175, 0.1],
          [988, 0.07],
          [1319, 0.18],
        ],
        12,
        0
      );
      vseq(
        2,
        [
          [262, 0.14],
          [330, 0.14],
          [392, 0.14],
          [523, 0.3],
        ],
        8,
        3
      );
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
    schedVoice(0, bass, 6, 9, t0);
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
  let challengeMax = 40;
  let isChallenge = false;

  // Formation origin (top center)
  const FORM_OX = VW / 2;
  const FORM_OY = 92;
  const FORM_CW = 36;
  const FORM_CH = 34;

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

  function slotPos(slot, sway) {
    const cols = slot.row >= 3 ? 10 : slot.row === 0 ? 10 : 10;
    const x0 = FORM_OX - (cols - 1) * FORM_CW * 0.5;
    // bosses use col offset into 10-wide grid
    const x = x0 + slot.col * FORM_CW + (sway || 0);
    const y = FORM_OY + slot.row * FORM_CH;
    return { x, y };
  }

  // ── Stars ────────────────────────────────────────────────────────────────
  function initStars() {
    stars = [];
    // Three parallax layers like the arcade PCB star generator
    const layers = [
      { n: 55, s: 1, sp0: 10, sp1: 18, cols: [C.white, C.cyan, "#a0a0ff"] },
      { n: 40, s: 2, sp0: 28, sp1: 48, cols: [C.white, C.yellow, C.cyan, C.pink] },
      { n: 22, s: 3, sp0: 58, sp1: 95, cols: [C.white, C.yellow, C.red, C.magenta, C.green] },
    ];
    for (const L of layers) {
      for (let i = 0; i < L.n; i++) {
        stars.push({
          x: Math.random() * VW,
          y: Math.random() * VH,
          s: L.s,
          sp: L.sp0 + Math.random() * (L.sp1 - L.sp0),
          c: L.cols[(Math.random() * L.cols.length) | 0],
          tw: Math.random() * Math.PI * 2,
          twSp: 1.5 + Math.random() * 5,
          layer: L.s,
        });
      }
    }
  }

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
    if (score > high) {
      high = score;
      try {
        localStorage.setItem("galaga_hi_v1", String(high));
      } catch (_) {}
    }
    // Extra life every 20,000 (common setting)
    while (score >= (extrasAt + 1) * 20000) {
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
    if ($title) $title.textContent = title;
    if ($sub) $sub.textContent = sub || "";
    if ($hint) $hint.textContent = hint || "";
  }
  function hideOV() {
    if (overlay) overlay.classList.add("hidden");
  }

  function flashMsg(text, ms) {
    message = text;
    messageT = ms;
  }

  // ── Entities ─────────────────────────────────────────────────────────────
  function spawnPlayer() {
    if (fighterCount < 1) fighterCount = 1;
    player = {
      x: VW / 2,
      y: VH - 52,
      w: 28,
      alive: true,
    };
    syncFighters();
    invuln = 2000;
    hud();
  }

  function enemyScore(e, diving) {
    if (e.type === "hostile") return 1000;
    if (e.type === "bee") return diving ? 100 : 50;
    if (e.type === "butterfly") return diving ? 160 : 80;
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

  function entryPath(slot, delayGroup) {
    // Curving entry from sides/top into formation — Galaga-like convoy
    const dest = slotPos(slot, 0);
    const fromLeft = slot.col < 5;
    const startX = fromLeft ? -30 : VW + 30;
    const startY = 40 + (delayGroup % 3) * 20;
    const midX = fromLeft ? VW * 0.25 : VW * 0.75;
    const midY = 40 + rnd(0, 80);
    const pts = [];
    const steps = 64; // denser path = smoother, slower with stepMs
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = (1 - t) * (1 - t) * startX + 2 * (1 - t) * t * midX + t * t * dest.x;
      const y = (1 - t) * (1 - t) * startY + 2 * (1 - t) * t * midY + t * t * dest.y;
      pts.push({ x, y });
    }
    if (chance(0.5)) {
      for (let i = 1; i <= 20; i++) {
        const t = i / 20;
        const a = t * Math.PI;
        pts.push({
          x: dest.x + Math.cos(a) * (fromLeft ? 35 : -35) * (1 - t),
          y: dest.y - 20 + Math.sin(a) * 25,
        });
      }
      pts.push({ x: dest.x, y: dest.y });
    }
    return pts;
  }

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
  function beamConeHalf(e, dy) {
    const coneLen = Math.max(220, (player ? player.y : VH - 48) - e.y + 40);
    const coneHalf = 55;
    const t = clamp(dy / coneLen, 0, 1);
    return { half: 10 + t * coneHalf, coneLen };
  }

  function playerInBeamCone(e) {
    if (!player || !player.alive) return false;
    const dy = player.y - e.y;
    if (dy < 8) return false;
    const { half, coneLen } = beamConeHalf(e, dy);
    if (dy > coneLen) return false;
    return Math.abs(player.x - e.x) <= half + 6;
  }

  function beginTractorBeam(e) {
    if (e.state === "beam" || e.hasCaptive || capturedHeld || captureSeq) return;
    if (!player || !player.alive) return;
    e.state = "beam";
    e.beamT = 0;
    e.beamDuration = 4000; // long enough for full suck sequence if hit early
    e.captureHold = 0;
    e.beamOpen = 0; // 0→1 open animation
    e.angle = Math.PI / 2;
    const py = player.y;
    e.y = Math.min(e.y, py - 200);
    e.y = Math.max(FORM_OY + 50, e.y);
    e.x = clamp(player.x, 50, VW - 50);
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
      flashMsg("FIGHTER CAPTURED!", 1600);
    } else {
      player.alive = false;
      player.capturing = true;
      state = "capture";
      bullets = [];
      eBullets = [];
      sfx("capture");
      flashMsg("FIGHTER CAPTURED!", 2000);
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
      spawnPlayer();
      invuln = 2500;
      state = "play";
      hideOV();
      flashMsg("FIGHTER " + lives + " LEFT", 1400);
    } else {
      fighterCount = 0;
      state = "over";
      showOV("GAME OVER", "LAST FIGHTER CAPTURED", "PRESS SPACE OR TAP");
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
        spawnPlayer();
        invuln = 2500;
        state = "play";
        hideOV();
        flashMsg("FIGHTER " + lives + " LEFT", 1400);
      } else {
        fighterCount = 0;
        state = "over";
        showOV("GAME OVER", "LAST FIGHTER CAPTURED", "PRESS SPACE OR TAP");
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
        flashMsg("FIGHTER CAPTURED!", 2000);
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
    return n >= 3 && (n - 3) % 3 === 0;
  }

  function beginStage(n, opts) {
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
    diveTimer = 3800;
    fireCD = 0;
    challengeHits = 0;
    challengeShots = 0;
    captors = [];

    if (isChallenge) {
      challengeMax = 40;
      // Challenge: 5 waves of 8 that fly through without forming
      for (let w = 0; w < 5; w++) {
        for (let i = 0; i < 8; i++) {
          const type = w < 1 ? "boss" : w < 3 ? "butterfly" : "bee";
          const fromLeft = w % 2 === 0;
          const path = challengePath(w, i, fromLeft);
          enemies.push({
            type,
            slot: { row: 0, col: i, type, i: w * 8 + i },
            hp: type === "boss" ? 2 : 1,
            state: "challenge",
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
            shootT: 99999,
            flap: Math.random() * 100,
            escorts: 0,
            hasCaptive: false,
            captiveAngle: 0,
            id: Math.random(),
            enterDelay: w * 1800 + i * 120,
            challengeActive: false,
            challengeDone: false,
          });
        }
      }
      state = "intro";
      introT = 2200;
      showOV("CHALLENGING STAGE " + stage, "PERFECT BONUS 10000", "");
      sfx("challenge");
    } else {
      const slots = makeFormationSlots();
      // Stagger entry in convoy groups
      slots.forEach((slot, idx) => {
        const group = Math.floor(idx / 4);
        enemies.push(makeEnemy(slot.type, slot, group * 950 + (idx % 4) * 140));
      });
      // Carry captive into next stage: pin red fighter under a boss
      if (capturedHeld) {
        const carrier = enemies.find((e) => e.type === "boss");
        if (carrier) {
          carrier.hasCaptive = true;
          carrier.captureOwned = false;
        } else {
          capturedHeld = false;
        }
      }
      state = "intro";
      introT = 1800;
      showOV("STAGE " + stage, isChallenge ? "CHALLENGING STAGE" : "GET READY", "");
      // Skip short stage sting on credit/start — Prelude owns first stage audio
      if (!(opts && opts.prelude)) sfx("stage");
    }
    stageLabelT = 2000;
    hud();
  }

  function challengePath(wave, i, fromLeft) {
    const pts = [];
    const startX = fromLeft ? -20 : VW + 20;
    const startY = 60 + wave * 30 + i * 8;
    const endX = fromLeft ? VW + 20 : -20;
    const endY = VH * 0.35 + Math.sin(i) * 40;
    const midX = VW / 2;
    const midY = 80 + wave * 40;
    // figure-8 / arc through screen
    for (let s = 0; s <= 50; s++) {
      const t = s / 50;
      const x =
        (1 - t) * (1 - t) * startX +
        2 * (1 - t) * t * (midX + Math.sin(t * Math.PI * 2 + i) * 80) +
        t * t * endX;
      const y =
        (1 - t) * (1 - t) * startY +
        2 * (1 - t) * t * (midY + Math.cos(t * Math.PI * 3) * 50) +
        t * t * endY;
      pts.push({ x, y });
    }
    return pts;
  }

  function beginGame() {
    unlockAudio();
    score = 0;
    lives = 3;
    stage = 1;
    extrasAt = 0;
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
  }

  function burst(x, y, color, n = 10) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 140;
      particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 200 + Math.random() * 400,
        color,
        size: 2 + ((Math.random() * 3) | 0),
      });
    }
    // Multi-frame arcade explosion stamp (cycles SPR_EXP frames)
    particles.push({
      x,
      y,
      vx: 0,
      vy: 0,
      life: 280,
      color,
      size: 1,
      expl: true,
      explT0: performance.now(),
      explDur: 280,
    });
    // Bloom rings
    for (let r = 0; r < 3; r++) {
      particles.push({
        x,
        y,
        vx: 0,
        vy: 0,
        life: 90 + r * 45,
        color: r === 0 ? "#ffffff" : color,
        size: 3 + r * 4,
        ring: true,
        ringR: 4 + r * 7,
      });
    }
  }

  function fire() {
    if (!player || !player.alive || fireCD > 0 || state !== "play") return;
    // 2 shots on-screen per fighter (single 2, dual 4, triple 6)
    const n = Math.max(1, fighterCount);
    const maxShots = n * 2;
    const mine = bullets.filter((b) => b.friendly).length;
    if (mine >= maxShots) return;
    fireCD = 170;
    if (isChallenge) challengeShots++;
    const y = player.y - 18;
    if (n === 1) {
      bullets.push({ x: player.x, y, vy: -240, friendly: true });
    } else if (n === 2) {
      bullets.push({ x: player.x - 16, y, vy: -240, friendly: true });
      bullets.push({ x: player.x + 16, y, vy: -240, friendly: true });
    } else {
      bullets.push({ x: player.x - 28, y, vy: -240, friendly: true });
      bullets.push({ x: player.x, y, vy: -240, friendly: true });
      bullets.push({ x: player.x + 28, y, vy: -240, friendly: true });
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
    if (isChallenge) challengeHits++;

    // Captive rescue: destroy diving boss with captive → spin/dock dual
    // Formation kill with captive → hostile red fighter (classic Galaga)
    if (hadCaptive) {
      e.hasCaptive = false;
      capturedHeld = false;
      const othersLeft = enemies.some((o) => o !== e && o.state !== "dead");
      const canRescue = diveRescue || !othersLeft;

      if (canRescue && player && player.alive && !rescueSeq) {
        startRescueSequence(e.x, e.y + 22);
        addScore(1000);
      } else if (canRescue && (!player || !player.alive)) {
        fighterCount = Math.min(3, Math.max(1, fighterCount) + 1);
        syncFighters();
        flashMsg("FIGHTER RESCUED!", 1600);
        addScore(1000);
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
    sfx("kill");
  }

  function doStageClear() {
    pendingStageClear = false;
    if (isChallenge) {
      state = "challenge";
      challengeT = 2800;
      const acc =
        challengeShots > 0
          ? Math.round((challengeHits / challengeShots) * 100)
          : 0;
      const perfect = challengeHits >= challengeMax;
      if (perfect) {
        addScore(10000);
        sfx("perfect");
        showOV("PERFECT!", "BONUS 10000", "ACCURACY " + acc + "%");
      } else {
        const bonus = challengeHits * 100;
        addScore(bonus);
        showOV("CHALLENGING STAGE", "BONUS " + bonus, "ACCURACY " + acc + "%");
        sfx("stage");
      }
    } else {
      state = "clear";
      clearT = 1800;
      showOV("STAGE " + stage, "CLEARED", "");
      sfx("stage");
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
    sfx("rescue");
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
    burst(player.x, player.y, C.white, 18);
    burst(player.x, player.y, C.orange, 10);
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
    state = "die";
    dieT = 1600;
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
      e.type === "boss" && !capturedHeld && !e.hasCaptive;

    e.willBeam = tryBeam;
    e.divePath = divePathFor(e, { beamDive: tryBeam });

    // Butterflies can escort boss (not during beam attempt)
    if (e.type === "boss" && !tryBeam) {
      const escorts = enemies.filter(
        (o) => o.state === "form" && o.type === "butterfly"
      );
      let taken = 0;
      for (const o of escorts) {
        if (taken >= 2) break;
        if (Math.abs(o.x - e.x) < 90) {
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
    const left = leftHeld || keys.ArrowLeft || keys.KeyA || keys.a || keys.A;
    const right = rightHeld || keys.ArrowRight || keys.KeyD || keys.d || keys.D;
    // Arcade-paced lateral speed (~original feel at 448px wide)
    const spd = 118;
    if (left) player.x -= spd * (dt / 1000);
    if (right) player.x += spd * (dt / 1000);
    const margin = fighterCount >= 3 ? 40 : fighterCount === 2 ? 32 : 20;
    player.x = clamp(player.x, margin, VW - margin);

    if (fireHeld || keys.Space || keys[" "] || keys.Spacebar) fire();
    if (invuln > 0) invuln -= dt;
  }

  function updateEnemies(dt) {
    formSway += formSwayDir * 7.5 * (dt / 1000);
    if (formSway > 16) formSwayDir = -1;
    if (formSway < -16) formSwayDir = 1;

    let inFormation = 0;

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
        const done = followPath(e, e.path, dt, 95);
        if (done) {
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
        e.beamOpen = Math.min(1, (e.beamOpen || 0) + dt / 400);
        e.angle = Math.PI / 2;
        if (player && player.alive) {
          e.x = lerp(e.x, player.x, 0.05);
        }
        // Beam opening then try to catch player
        if (player && player.alive && e.beamOpen > 0.35) {
          if (playerInBeamCone(e)) {
            // Brief lock under beam, then full cinematic
            player.x = lerp(player.x, e.x, 0.12);
            e.captureHold = (e.captureHold || 0) + dt;
            if (e.captureHold > 220) {
              startCaptureSequence(e);
              continue;
            }
          } else {
            e.captureHold = Math.max(0, (e.captureHold || 0) - dt * 0.4);
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

        const diveSpeed = e.type === "boss" ? 100 : e.type === "butterfly" ? 115 : 120;
        followPath(e, e.divePath, dt, diveSpeed);

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
          e.shootT = 1100 + Math.random() * 1100 - Math.min(200, stage * 12);
          eBullets.push({
            x: e.x,
            y: e.y + 10,
            vx: (player.x - e.x) * 0.06,
            vy: 72 + stage * 2.5,
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
            e.x = fp.x;
            e.y = -16;
          } else {
            e.x = fp.x;
            e.y = fp.y;
          }
          e.angle = Math.PI / 2;
        }
      } else if (e.state === "challenge") {
        if (!e.challengeActive) continue;
        if (e.pathPos == null) e.pathPos = 0;
        const done = followPath(e, e.path, dt, 100);
        if (done) {
          e.state = "dead";
          e.challengeDone = true;
        }
      }
    }

    enemies = enemies.filter((e) => e.state !== "dead");

    // Dive scheduling (not on challenge)
    if (!isChallenge && state === "play") {
      diveTimer -= dt;
      const formed = enemies.filter((e) => e.state === "form");
      if (diveTimer <= 0 && formed.length) {
        diveTimer = Math.max(1500, 3400 - stage * 55);
        // Pick divers
        const n = 1 + (chance(0.3 + stage * 0.02) ? 1 : 0);
        for (let k = 0; k < n; k++) {
          const pool = enemies.filter((e) => e.state === "form");
          if (!pool.length) break;
          // Prefer captive-holding boss so rescue is available; else lower bees
          const captiveBoss = pool.find((e) => e.type === "boss" && e.hasCaptive);
          pool.sort((a, b) => b.slot.row - a.slot.row);
          let pick = null;
          if (captiveBoss && chance(0.55)) pick = captiveBoss;
          else if (chance(0.22) && pool.some((e) => e.type === "boss"))
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
    for (const s of stars) {
      s.y += s.sp * (dt / 1000);
      s.tw = (s.tw || 0) + (s.twSp || 3) * (dt / 1000);
      if (s.y > VH) {
        s.y = 0;
        s.x = Math.random() * VW;
      }
    }
  }

  function update(dt) {
    if (fireCD > 0) fireCD -= dt;
    if (messageT > 0) messageT -= dt;
    if (stageLabelT > 0) stageLabelT -= dt;

    updateStars(dt);

    // V20: title/pause freeze world; on game-over scrub any leftover capture ownership
    if (state === "title" || state === "pause") return;
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
      updateParticles(dt);
      if (dieT <= 0) {
        if (lives <= 0) {
          state = "over";
          showOV("GAME OVER", "SCORE " + pad(score), "PRESS SPACE OR TAP");
        } else {
          spawnPlayer();
          state = "play";
          hideOV();
        }
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
        state = "over";
        showOV("GAME OVER", "SCORE " + pad(score), "PRESS SPACE OR TAP");
        return;
      }
    }

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
    ctx.fillRect(x | 0, y | 0, w, h);
  }

  // Vivid Namco RGB palette indices (no muddy browns/pastels)
  const SP = {
    _: null,
    ".": null,
    W: "#ffffff",
    w: "#c8d0e8",
    R: "#ff2020",
    r: "#c01010",
    B: "#2060ff",
    b: "#1040c8",
    Y: "#ffff20",
    y: "#d0c010",
    G: "#20f020",
    g: "#10a818",
    L: "#80ff90",
    C: "#20ffff",
    c: "#1090c0",
    O: "#ff9000",
    M: "#ff40b0",
    m: "#d02078",
    P: "#e060ff",
    K: "#080810",
    A: "#40b0ff",
    T: "#ff4040",
    F: "#a0ffff",
    D: "#60ff60",
    E: "#ff80c0",
    H: "#ffd0a0",
    // soft AA / edge tones for rounder silhouettes (V19)
    n: "#6878a0",
    o: "#c06010",
    u: "#58a058",
    v: "#3870d0",
    x: "#b02828",
    z: "#c05090",
  };

  /** Draw a row-string sprite. Chars map via SP. px = pixel size. */
  function blit(ox, oy, rows, px, flipX) {
    const h = rows.length;
    const w = rows[0].length;
    const x0 = ox - (w * px) / 2;
    const y0 = oy - (h * px) / 2;
    for (let j = 0; j < h; j++) {
      const row = rows[j];
      for (let i = 0; i < w; i++) {
        const ch = row[flipX ? w - 1 - i : i];
        const col = SP[ch];
        if (!col) continue;
        fillRect(x0 + i * px, y0 + j * px, px + 0.2, px + 0.2, col);
      }
    }
  }

  // Fighter (Gyaraga) — white hull, cyan/blue core, red wing cannons
  // V19: rounder oval hull, soft AA edges, curved cannons (arcade PCB detail)
  const SPR_FIGHTER = [
    ".........W.........",
    "........WwW........",
    ".......WwWwW.......",
    "......WWwAwWW......",
    ".....WWWA.AWWW.....",
    "....WWWwWwWwWWW....",
    "...WWwWWWWWWWwWW...",
    "..WW.WwAWAWwW.WW...",
    ".WTn..WWWWWWW..nTW.",
    ".T.....T.W.T.....T.",
    "..T.....T.T.....T..",
    ".........T.........",
  ];
  const SPR_CAPTURED = [
    ".........R.........",
    "........RrR........",
    ".......RrRrR.......",
    "......RRrwrRR......",
    ".....RRRw.wRRR.....",
    "....RRRRrRrRRRR....",
    "...RRrRRRRRRRrRR...",
    "..RR.RrwrwRrR.RR...",
    ".RRx..RRRRRRR..xRR.",
    ".R.....R.R.R.....R.",
    "..R.....R.R.....R..",
    ".........R.........",
  ];

  // Bee / Zako — 4 wing frames, blue lobes, yellow oval abdomen, white eyes
  // V19: rounder wing cups, antennae, soft AA, arcade thorax banding
  const SPR_BEE = [
    [
      "..R.........R..",
      "...bb.....bb...",
      "..bBBv...vBBb..",
      ".bBYBYBYBYBYb..",
      ".BBWWWWWWWBB...",
      "bBBYYYYYYYYBBb.",
      ".BBBYYyYyYBBB..",
      "..BbYK.KYBb....",
      "...bYYYYYb.....",
      "....bYYYb......",
      ".....YYY.......",
    ],
    [
      "..R.........R..",
      "..b.bb...bb.b..",
      "..bBBb...bBBb..",
      "..bBYBYBYBYb...",
      "..BBWWWWWBB....",
      ".bBBYYYYYYBBb..",
      "..BBBYYyYBBB...",
      "...BYK.KYB.....",
      "....YYYYY......",
      ".....YYY.......",
      "......Y........",
    ],
    [
      "...R.......R...",
      ".b..bb...bb..b.",
      "..b.BBb.bBB.b..",
      "...bBYBYBYb....",
      "...BBWWWWWBB...",
      "...BBYYYYYBB...",
      "....BBYYyBB....",
      ".....BYKYB.....",
      "....bYYYYb.....",
      ".....YYY.......",
      "......Y........",
    ],
    [
      "..R.........R..",
      "..b.bb...bb.b..",
      "..bBBb...bBBb..",
      "..bBYBYBYBYb...",
      "..BBWWWWWBB....",
      ".bBBYYYYYYBBb..",
      "..BBBYYyYBBB...",
      "...BYK.KYB.....",
      "....YYYYY......",
      ".....YYY.......",
      "......Y........",
    ],
  ];

  // Butterfly / Goei — magenta/red lobed wings, yellow body, 4 flap frames
  // V19: heart-lobed rounder wings, soft AA, denser arcade wing veins
  const SPR_BUTTER = [
    [
      ".zM...........Mz.",
      "MMmRR.......RRmMM",
      "MmWRWR.....WRWRmM",
      "MMRWWWR.RWWWRMM..",
      "MMrYWYWYWYWYRmM..",
      ".MMRWRWRWRWRMM...",
      ".zM.RRRYRRR.Mz...",
      "..M...RRR...M....",
      "...M...R...M.....",
      ".......R.........",
    ],
    [
      "..zM.........Mz..",
      ".MMmRR.....RRmMM.",
      ".MmWRWR...WRWRmM.",
      ".MMRWWWRWWWRMM...",
      ".MMrYWYWYWYRmM...",
      "MMmRWRWRWRRMmM...",
      ".zM.RRRYRRR.Mz...",
      "..M...RRR...M....",
      "...M...R...M.....",
      ".......R.........",
    ],
    [
      "...zM.......Mz...",
      "..MMmRR...RRmMM..",
      "..MmWRWR.WRWRmM..",
      "...MRWWWWWRM.....",
      "...MRYWYWYRM.....",
      "..MmRWRWRRmM.....",
      "..zM.RRRRR.Mz....",
      "...M...R...M.....",
      ".......R.........",
      ".......R.........",
    ],
    [
      "..zM.........Mz..",
      ".MMmRR.....RRmMM.",
      ".MmWRWR...WRWRmM.",
      ".MMRWWWRWWWRMM...",
      ".MMrYWYWYWYRmM...",
      "MMmRWRWRWRRMmM...",
      ".zM.RRRYRRR.Mz...",
      "..M...RRR...M....",
      "...M...R...M.....",
      ".......R.........",
    ],
  ];

  // Boss Galaga healthy (green bird) — dual eye-pods, wing bob frames
  // V19: rounder bird body, curved wing cups, soft AA, arcade eye pods
  const SPR_BOSS = [
    [
      ".L.uGG.....GGu.L.",
      "LGGGGg...gGGGGL..",
      ".GGYGGYGGYGGGG...",
      "GGWWYGGGYWWGG....",
      ".GGYWWWWWYGGg....",
      "..GgGGGGGgGG.....",
      ".uGG.GGG.GGu.....",
      "..GG.G.G.GG......",
      "...G..G..G.......",
      "....G...G........",
      ".....G.G.........",
    ],
    [
      "..LuGG.....GGuL..",
      ".LGGGGg.gGGGGL...",
      ".GGYGGYGGYGGG....",
      ".GWWYGGGYWWGG....",
      ".GGYWWWWWYGGg....",
      "..GgGGGGGgGG.....",
      "..uG.GGG.Gu......",
      "...G.G.G.G.......",
      "....G.G.G........",
      ".....G.G.........",
      "......G..........",
    ],
    [
      "...LuGG...GGuL...",
      "..LGGGg.gGGGL....",
      "..GGYGGYGGYG.....",
      "..GWWYGYWWG......",
      "..GGYWWWWYG......",
      "...GgGGGGg.......",
      "...uG.G.Gu.......",
      "....G.G.G........",
      ".....G.G.........",
      "......G..........",
      ".................",
    ],
    [
      "..LuGG.....GGuL..",
      ".LGGGGg.gGGGGL...",
      ".GGYGGYGGYGGG....",
      ".GWWYGGGYWWGG....",
      ".GGYWWWWWYGGg....",
      "..GgGGGGGgGG.....",
      "..uG.GGG.Gu......",
      "...G.G.G.G.......",
      "....G.G.G........",
      ".....G.G.........",
      "......G..........",
    ],
  ];
  // Boss damaged — classic blue after first hit (same rounder silhouette)
  const SPR_BOSS_HURT = [
    [
      ".C.vBB.....BBv.C.",
      "CBBBBb...bBBBBC..",
      ".BBYBBYBBYBBBB...",
      "BBWWYBBYYWWBB....",
      ".BBYWWWWWYBBb....",
      "..BbBBBBBbBB.....",
      ".vBB.BBB.BBv.....",
      "..BB.B.B.BB......",
      "...B..B..B.......",
      "....B...B........",
      ".....B.B.........",
    ],
    [
      "..CvBB.....BBvC..",
      ".CBBBBb.bBBBBC...",
      ".BBYBBYBBYBBB....",
      ".BWWYBBYYWWBB....",
      ".BBYWWWWWYBBb....",
      "..BbBBBBBbBB.....",
      "..vB.BBB.Bv......",
      "...B.B.B.B.......",
      "....B.B.B........",
      ".....B.B.........",
      "......B..........",
    ],
    [
      "...CvBB...BBvC...",
      "..CBBBb.bBBBC....",
      "..BBYBBYBBYB.....",
      "..BWWYBYWWB......",
      "..BBYWWWWYB......",
      "...BbBBBBb.......",
      "...vB.B.Bv.......",
      "....B.B.B........",
      ".....B.B.........",
      "......B..........",
      ".................",
    ],
    [
      "..CvBB.....BBvC..",
      ".CBBBBb.bBBBBC...",
      ".BBYBBYBBYBBB....",
      ".BWWYBBYYWWBB....",
      ".BBYWWWWWYBBb....",
      "..BbBBBBBbBB.....",
      "..vB.BBB.Bv......",
      "...B.B.B.B.......",
      "....B.B.B........",
      ".....B.B.........",
      "......B..........",
    ],
  ];

  // Multi-frame explosion (arcade bloom: white → yellow → orange → red → dim)
  // V19: fuller circular bloom + soft AA spokes (arcade PCB rings)
  const SPR_EXP = [
    [
      "........W........",
      ".......WwW.......",
      "......WwWwW......",
      ".......WwW.......",
      "........W........",
    ],
    [
      ".......Y.Y.......",
      ".....YWWWWWY.....",
      "....YWWwWwWWY....",
      "...YWwWWWWWwWY...",
      "....YWWwWwWWY....",
      ".....YWWWWWY.....",
      ".......Y.Y.......",
    ],
    [
      "......O.Y.O......",
      "....OYWYWYWYO....",
      "...OYWWwWwWWYO...",
      "..OYWwYWYWYwWYO..",
      "...OYWWwWwWWYO...",
      "....OYWYWYWYO....",
      "......O.Y.O......",
    ],
    [
      ".....R.OYO.R.....",
      "...ROYWYWYWYOR...",
      "..ROYWWwWwWWYOR..",
      ".ROYwYWYWYWYwYOR.",
      "..ROYWWwWwWWYOR..",
      "...ROYWYWYWYOR...",
      ".....R.OYO.R.....",
    ],
    [
      "....r..O.O..r....",
      "...r.ROYOYOR.r...",
      "..r.ROY.Y.YOR.r..",
      ".r.RO..Y.Y..OR.r.",
      "..r.ROY.Y.YOR.r..",
      "...r.ROYOYOR.r...",
      "....r..O.O..r....",
    ],
    [
      ".......r.r.......",
      ".....r.....r.....",
      "....r.......r....",
      "...r.........r...",
      "....r.......r....",
      ".....r.....r.....",
      ".......r.r.......",
    ],
  ];

  function drawStars() {
    for (const s of stars) {
      const tw = 0.45 + 0.55 * Math.sin(s.tw || 0);
      ctx.globalAlpha = tw;
      fillRect(s.x, s.y, s.s, s.s, s.c);
      // Bright mid/far stars get a 1px sparkle cross like arcade
      if (s.layer >= 2 && tw > 0.85) {
        fillRect(s.x - 1, s.y, s.s + 2, 1, s.c);
        fillRect(s.x, s.y - 1, 1, s.s + 2, s.c);
      }
    }
    ctx.globalAlpha = 1;
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
      blit(x - 22, y, SPR_FIGHTER, px * 0.98);
      blit(x + 22, y, SPR_FIGHTER, px * 0.98);
    } else {
      blit(x - 32, y, SPR_FIGHTER, px * 0.94);
      blit(x, y, SPR_FIGHTER, px);
      blit(x + 32, y, SPR_FIGHTER, px * 0.94);
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
    const frame = ((e.flap / 90) | 0) % 4;

    ctx.save();
    ctx.translate(x, y);
    if (e.state === "dive" || e.state === "challenge" || e.state === "enter") {
      ctx.rotate(e.angle + Math.PI / 2);
    }

    if (e.type === "hostile") {
      blit(0, 0, SPR_CAPTURED, SPR_PX_SHIP * 0.95);
    } else if (e.type === "bee") {
      blit(0, 0, SPR_BEE[frame], SPR_PX);
    } else if (e.type === "butterfly") {
      blit(0, 0, SPR_BUTTER[frame], SPR_PX * 1.02);
    } else if (e.type === "boss") {
      const hurt = e.hp < 2;
      drawBossSprite(0, 0, hurt, frame);
      if (e.hasCaptive || (captureSeq && captureSeq.boss === e && captureSeq.attached)) {
        blit(0, 28, SPR_CAPTURED, SPR_PX_SHIP * 0.88);
      }
    }

    ctx.restore();
  }

  function drawBossSprite(ox, oy, hurt, frame) {
    const rows = hurt ? SPR_BOSS_HURT[frame] : SPR_BOSS[frame];
    blit(ox, oy, rows, SPR_PX_BOSS);
  }

  function drawBullets() {
    for (const b of bullets) {
      // Arcade fighter missile — thin yellow with white tip
      fillRect(b.x - 1.5, b.y - 14, 3, 18, "#ffff28");
      fillRect(b.x - 1.5, b.y - 14, 3, 4, "#ffffff");
      fillRect(b.x - 2.5, b.y - 1, 5, 2, "#e0a010");
    }
    for (const b of eBullets) {
      // Enemy bomb — magenta diamond
      fillRect(b.x - 2, b.y - 7, 4, 14, "#ff50b8");
      fillRect(b.x - 3.5, b.y - 3.5, 7, 7, "#ff2088");
      fillRect(b.x - 1, b.y - 1, 2, 2, "#ffffff");
    }
  }

  function drawBeams() {
    for (const beam of beams) {
      const e = beam.enemy;
      if (!e) continue;
      const active =
        e.state === "beam" ||
        (captureSeq &&
          captureSeq.boss === e &&
          (captureSeq.phase === "lock" ||
            captureSeq.phase === "pull" ||
            captureSeq.phase === "attach"));
      if (!active) continue;
      const x = e.x;
      const y = e.y;
      let targetY = VH - 40;
      if (captureSeq && captureSeq.boss === e && captureSeq.phase === "pull") {
        targetY = Math.max(captureSeq.fy + 20, y + 40);
      } else if (player && player.alive) {
        targetY = player.y + 20;
      }
      const open = e.beamOpen != null ? e.beamOpen : 1;
      const coneLen = Math.max(80, (targetY - y) * open);
      const coneHalf = 62 * open;
      const tNow = performance.now();
      const frame = ((tNow / 70) | 0) % 4;
      const pulse = 0.82 + 0.18 * Math.sin(tNow / 55);
      // Pixel trapezoid bands (arcade tractor — discrete frames, not soft glow)
      const bands = 18;
      for (let i = 0; i < bands; i++) {
        const t0 = i / bands;
        const t1 = (i + 1) / bands;
        const w0 = (4 + t0 * coneHalf) * pulse;
        const w1 = (4 + t1 * coneHalf) * pulse;
        const y0 = y + 14 + t0 * coneLen;
        const y1 = y + 14 + t1 * coneLen;
        const parity = (i + frame) & 1;
        ctx.globalAlpha = (parity ? 0.22 : 0.42) * open;
        ctx.fillStyle = parity ? "#ffffff" : i % 3 === 0 ? "#20ffff" : "#80ffff";
        ctx.beginPath();
        ctx.moveTo(x - w0, y0);
        ctx.lineTo(x + w0, y0);
        ctx.lineTo(x + w1, y1);
        ctx.lineTo(x - w1, y1);
        ctx.closePath();
        ctx.fill();
      }
      // Outer edge rails
      ctx.globalAlpha = 0.55 * open;
      ctx.strokeStyle = "#a0ffff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 4, y + 14);
      ctx.lineTo(x - coneHalf * pulse, y + 14 + coneLen);
      ctx.moveTo(x + 4, y + 14);
      ctx.lineTo(x + coneHalf * pulse, y + 14 + coneLen);
      ctx.stroke();
      ctx.globalAlpha = 1;
      fillRect(x - 8, y + 8, 16, 7, "#a0ffff");
      fillRect(x - 4, y + 6, 8, 5, "#ffffff");
      fillRect(x - 2, y + 10, 4, 3, "#20ffff");
    }
  }

  function drawParticles() {
    for (const p of particles) {
      const a = clamp(p.life / 400, 0, 1);
      if (p.expl) {
        const elapsed = p.explDur - p.life;
        const fi = Math.min(SPR_EXP.length - 1, (elapsed / (p.explDur / SPR_EXP.length)) | 0);
        ctx.globalAlpha = Math.min(1, a * 1.4);
        blit(p.x, p.y, SPR_EXP[fi], SPR_PX * 1.15);
        ctx.globalAlpha = 1;
        continue;
      }
      ctx.globalAlpha = a;
      if (p.ring) {
        const r = (p.ringR || 6) * (1.2 - a * 0.5);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        fillRect(p.x, p.y, p.size || 2, p.size || 2, p.color);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawMessages() {
    if (messageT > 0 && message) {
      ctx.fillStyle = C.yellow;
      ctx.font = '12px "Press Start 2P", monospace';
      ctx.textAlign = "center";
      ctx.fillText(message, VW / 2, VH * 0.55);
    }
  }

  function render() {
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
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
        if (state === "title" || state === "over") beginGame();
        else if (state === "pause") {
          state = "play";
          hideOV();
        } else fireHeld = true;
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
      unlockAudio();
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

  bindBtn("btn-left", () => (leftHeld = true), () => (leftHeld = false));
  bindBtn("btn-right", () => (rightHeld = true), () => (rightHeld = false));
  bindBtn(
    "btn-fire",
    () => {
      fireHeld = true;
      if (state === "title" || state === "over") beginGame();
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
      } else if (state === "title" || state === "over") beginGame();
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
    if (state === "title" || state === "over") beginGame();
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
      if (state === "title" || state === "over") beginGame();
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
  showOV("GALAGA", "INSERT COIN", "BUILD V18 - PRESS SPACE OR TAP");
})();
