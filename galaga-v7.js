/**
 * GALAGA — Namco / Midway 1981 style recreation
 * Fixed-screen vertical shooter: formation, dives, tractor beam, dual fighter,
 * challenging stages. Multi-color arcade look.
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

  // ── Palette (Namco-ish bright primaries) ─────────────────────────────────
  const C = {
    black: "#000000",
    white: "#ffffff",
    red: "#ff3030",
    orange: "#ff8800",
    yellow: "#ffff40",
    green: "#40ff40",
    cyan: "#40ffff",
    blue: "#4060ff",
    purple: "#c040ff",
    pink: "#ff80c0",
    boss: "#40e040",
    bossEye: "#ffff00",
    bee: "#4060ff",
    beeWing: "#80a0ff",
    butter: "#ff4040",
    butterWing: "#ff8080",
    ship: "#ffffff",
    shipRed: "#ff4040",
    shipBlue: "#40a0ff",
  };

  // ── Audio ────────────────────────────────────────────────────────────────
  let AC = null;
  let muted = false;

  function unlockAudio() {
    try {
      if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
      if (AC.state === "suspended") AC.resume();
    } catch (_) {}
  }

  function tone(freq, dur, type = "square", vol = 0.04, when = 0, slideTo) {
    if (muted || !AC) return;
    try {
      const t0 = AC.currentTime + when;
      const o = AC.createOscillator();
      const g = AC.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t0);
      if (slideTo != null) o.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), t0 + dur);
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g);
      g.connect(AC.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.03);
    } catch (_) {}
  }

  function noise(dur, vol = 0.05, when = 0, ff = 1200) {
    if (muted || !AC) return;
    try {
      const n = Math.floor(AC.sampleRate * dur);
      const buf = AC.createBuffer(1, n, AC.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      const src = AC.createBufferSource();
      src.buffer = buf;
      const f = AC.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = ff;
      const g = AC.createGain();
      const t0 = AC.currentTime + when;
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f);
      f.connect(g);
      g.connect(AC.destination);
      src.start(t0);
      src.stop(t0 + dur + 0.03);
    } catch (_) {}
  }

  function sfx(name) {
    unlockAudio();
    if (muted || !AC) return;
    if (name === "fire") {
      tone(880, 0.05, "square", 0.03);
      tone(1320, 0.04, "square", 0.02, 0.02);
    } else if (name === "hit") {
      tone(220, 0.06, "square", 0.035);
      noise(0.05, 0.03, 0, 800);
    } else if (name === "kill") {
      noise(0.12, 0.06, 0, 900);
      tone(300, 0.1, "sawtooth", 0.03, 0, 80);
    } else if (name === "die") {
      noise(0.35, 0.08, 0, 500);
      tone(400, 0.4, "sawtooth", 0.05, 0, 60);
    } else if (name === "dive") {
      tone(600, 0.25, "square", 0.025, 0, 200);
    } else if (name === "beam") {
      tone(180, 0.15, "sawtooth", 0.04);
      tone(240, 0.2, "sawtooth", 0.035, 0.1);
      tone(300, 0.25, "sawtooth", 0.03, 0.25);
    } else if (name === "capture") {
      tone(150, 0.4, "sine", 0.05, 0, 80);
      noise(0.3, 0.04, 0.1, 400);
    } else if (name === "rescue") {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.1, "square", 0.04, i * 0.08));
    } else if (name === "stage") {
      [392, 523, 659, 784].forEach((f, i) => tone(f, 0.1, "square", 0.04, i * 0.09));
    } else if (name === "challenge") {
      [440, 554, 659, 880, 659, 880].forEach((f, i) => tone(f, 0.08, "square", 0.035, i * 0.07));
    } else if (name === "extra") {
      [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.08, "square", 0.04, i * 0.07));
    } else if (name === "perfect") {
      [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, 0.1, "square", 0.045, i * 0.09));
    } else if (name === "start") {
      [330, 392, 523, 659, 784].forEach((f, i) => tone(f, 0.09, "square", 0.04, i * 0.08));
    }
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
  let dual = false;
  let capturedHeld = false; // a fighter is captive in formation (boss)
  let captors = []; // bosses holding captive (usually 0-1)

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
  const FORM_OY = 100;
  const FORM_CW = 28;
  const FORM_CH = 26;

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
    for (let i = 0; i < 60; i++) {
      stars.push({
        x: Math.random() * VW,
        y: Math.random() * VH,
        s: chance(0.25) ? 2 : 1,
        sp: 12 + Math.random() * 28,
        c: chance(0.2) ? C.cyan : chance(0.1) ? C.yellow : C.white,
      });
    }
  }

  // ── HUD ──────────────────────────────────────────────────────────────────
  function hud() {
    if ($score) $score.textContent = pad(score);
    if ($high) $high.textContent = pad(high);
    if ($stage) $stage.textContent = String(stage);
    if ($lives) {
      let s = "";
      for (let i = 0; i < Math.max(0, lives); i++) s += "▲";
      $lives.textContent = s || "";
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
    player = {
      x: VW / 2,
      y: VH - 48,
      w: dual ? 36 : 18,
      alive: true,
    };
    invuln = 2000;
  }

  function enemyScore(e, diving) {
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
   * Original-style capture sequence:
   * 1) lock — lose control, beam fully open
   * 2) pull — fighter dragged up the beam, white→red
   * 3) attach — dock under boss, sparkle
   * 4) haul — boss returns to formation with red captive
   * 5) respawn — new fighter appears (if lives remain)
   */
  function startCaptureSequence(boss) {
    if (!player || !player.alive || captureSeq || capturedHeld) return;
    if (invuln > 0 && (boss.beamT || 0) < 350) return;

    const fromDual = dual;
    dual = false;
    if (player) player.w = 18;

    captureSeq = {
      phase: "lock",
      t: 0,
      boss,
      // free-floating fighter being abducted
      fx: player.x,
      fy: player.y,
      startX: player.x,
      startY: player.y,
      red: 0, // 0 white → 1 red
      beamPulse: 0,
      fromDual,
    };

    // Hide controllable player; sequence owns the fighter sprite
    player.alive = false;
    player.capturing = true;
    state = "capture";
    bullets = []; // clear shots during cinematic
    sfx("capture");
    flashMsg("", 0);
  }

  function finishCaptureHaul(seq) {
    const boss = seq.boss;
    if (!boss || boss.state === "dead") {
      captureSeq = null;
      return;
    }
    boss.hasCaptive = true;
    capturedHeld = true;
    boss.willBeam = false;
    boss.beamed = true;
    boss.state = "return";
    boss.pathPos = 0;
    const home = slotPos(boss.slot, formSway);
    boss.returnPath = [];
    for (let i = 0; i <= 48; i++) {
      const t = i / 48;
      // gentle arc home
      boss.returnPath.push({
        x: lerp(boss.x, home.x, t),
        y: lerp(boss.y, home.y, t * t),
      });
    }
    beams = beams.filter((b) => b.enemy !== boss);
  }

  function updateCaptureSequence(dt) {
    if (!captureSeq) return;
    const seq = captureSeq;
    const boss = seq.boss;
    seq.t += dt;
    seq.beamPulse += dt;

    // Boss holds still during lock/pull/attach
    if (boss && (seq.phase === "lock" || seq.phase === "pull" || seq.phase === "attach")) {
      boss.state = "beam";
      boss.angle = Math.PI / 2;
      boss.beamOpen = 1;
      // keep beam visual alive
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
    }

    if (seq.phase === "lock") {
      // ~0.45s: lose control, center under boss, beam fully open
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
      // ~2.0s: dragged up the beam, white → red (classic)
      const dur = 2000;
      const u = clamp(seq.t / dur, 0, 1);
      // ease-in-out rise
      const ease = u * u * (3 - 2 * u);
      const attachY = boss.y + 22;
      seq.fx = lerp(seq.startX, boss.x, ease);
      seq.fy = lerp(seq.startY, attachY, ease);
      seq.red = 0.15 + ease * 0.85;
      // beam particles along the path
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
        seq.fy = boss.y + 20;
        seq.red = 1;
        burst(boss.x, boss.y + 18, "#ff4040", 14);
        burst(boss.x, boss.y + 18, "#ffff40", 8);
        sfx("rescue"); // short chime for dock
        flashMsg("FIGHTER CAPTURED!", 2000);
      }
    } else if (seq.phase === "attach") {
      // ~0.55s: dock flash under boss
      const dur = 550;
      seq.fx = boss.x;
      seq.fy = boss.y + 20;
      seq.red = 1;
      if (seq.t >= dur) {
        seq.phase = "haul";
        seq.t = 0;
        finishCaptureHaul(seq);
        // captive now drawn on boss; free-floating sprite follows boss
        seq.attached = true;
      }
    } else if (seq.phase === "haul") {
      // Boss flies home with captive; wait for return to formation
      if (boss && boss.state === "form") {
        seq.phase = "respawn";
        seq.t = 0;
        beams = beams.filter((b) => b.enemy !== boss);
      } else if (boss && boss.state === "return") {
        // followPath runs in updateEnemies — keep seq.fx under boss for any late draw
        seq.fx = boss.x;
        seq.fy = boss.y + 20;
      } else if (!boss || boss.state === "dead") {
        // boss died mid-haul — abort to respawn
        seq.phase = "respawn";
        seq.t = 0;
        capturedHeld = false;
      }
      // safety timeout
      if (seq.t > 6000) {
        if (boss) {
          boss.state = "form";
          const fp = slotPos(boss.slot, formSway);
          boss.x = fp.x;
          boss.y = fp.y;
          boss.hasCaptive = true;
          capturedHeld = true;
        }
        seq.phase = "respawn";
        seq.t = 0;
      }
    } else if (seq.phase === "respawn") {
      // Brief pause, then new fighter (classic: capture costs a life)
      if (!seq.lifeTaken) {
        seq.lifeTaken = true;
        if (!seq.fromDual) {
          lives--;
          hud();
        }
      }
      if (seq.t >= 1000) {
        captureSeq = null;
        beams = [];
        if (seq.fromDual || lives > 0) {
          spawnPlayer();
          invuln = 2500;
          state = "play";
          hideOV();
        } else {
          state = "over";
          showOV("GAME OVER", "SCORE " + pad(score), "PRESS SPACE OR TAP");
        }
      }
    }
  }

  function drawCaptureFighter(seq) {
    if (!seq || seq.phase === "respawn") return;
    if (seq.attached && seq.phase === "haul") return; // boss draws captive
    const x = seq.fx;
    const y = seq.fy;
    // Blend white fighter → red captive
    const r = seq.red;
    ctx.save();
    ctx.translate(x, y);
    // body
    const body = r > 0.5 ? "#ff3030" : "#ffffff";
    const accent = r > 0.5 ? "#c02020" : "#3060ff";
    const wing = r > 0.5 ? "#ff6060" : "#ff3030";
    // pixel-ish fighter
    fillRect(-1, -12, 2, 6, r > 0.35 ? "#ff8080" : "#ffff40");
    fillRect(-4, -8, 8, 4, body);
    fillRect(-6, -4, 12, 8, body);
    fillRect(-3, -2, 6, 5, accent);
    fillRect(-9, 2, 4, 4, wing);
    fillRect(5, 2, 4, 4, wing);
    fillRect(-2, 6, 4, 3, body);
    // tractor sparkles
    if (seq.phase === "pull" || seq.phase === "lock") {
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(seq.beamPulse / 50);
      fillRect(-8, -2, 2, 2, "#40ffff");
      fillRect(6, 2, 2, 2, "#ffffff");
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function isChallengeStage(n) {
    // Classic: stages 3, 7, 11, 15...
    return n >= 3 && (n - 3) % 4 === 0;
  }

  function beginStage(n) {
    stage = n;
    isChallenge = isChallengeStage(n);
    enemies = [];
    bullets = [];
    eBullets = [];
    beams = [];
    particles = [];
    captureSeq = null;
    rescueSeq = null;
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
      // If we have a captive from before, attach to a boss once formed
      state = "intro";
      introT = 1800;
      showOV("STAGE " + stage, isChallenge ? "CHALLENGING STAGE" : "GET READY", "");
      sfx("stage");
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
    dual = false;
    capturedHeld = false;
    captors = [];
    initStars();
    spawnPlayer();
    beginStage(1);
    sfx("start");
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
        size: 1 + ((Math.random() * 2) | 0),
      });
    }
  }

  function fire() {
    if (!player || !player.alive || fireCD > 0 || state !== "play") return;
    // Original: limited shots on screen (2 per fighter ≈ dual 4)
    const maxShots = dual ? 4 : 2;
    const mine = bullets.filter((b) => b.friendly).length;
    if (mine >= maxShots) return;
    fireCD = 170;
    if (isChallenge) challengeShots++;
    if (dual) {
      bullets.push({ x: player.x - 10, y: player.y - 12, vy: -230, friendly: true });
      bullets.push({ x: player.x + 10, y: player.y - 12, vy: -230, friendly: true });
    } else {
      bullets.push({ x: player.x, y: player.y - 12, vy: -230, friendly: true });
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

    // Captive rescue: destroy boss while diving with captive → dual sequence
    if (hadCaptive) {
      e.hasCaptive = false;
      capturedHeld = false;
      if (diveRescue && player && player.alive && !rescueSeq) {
        startRescueSequence(e.x, e.y + 18);
        addScore(1000);
      } else if (diveRescue && (!player || !player.alive)) {
        // Player dead mid-rescue — grant dual on next spawn via flag
        dual = true;
        flashMsg("FIGHTER RESCUED!", 1600);
        addScore(1000);
      } else {
        flashMsg("FIGHTER LOST!", 1200);
      }
    }

    const col =
      e.type === "boss" ? C.green : e.type === "butterfly" ? C.red : C.blue;
    burst(e.x, e.y, col, 14);
    burst(e.x, e.y, C.yellow, 6);
    sfx("kill");
  }

  /**
   * Original rescue: freed fighter spins, turns white, flies down,
   * and docks beside the active fighter → dual ship.
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
          size: 1 + ((Math.random() * 2) | 0),
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

      const targetX = player && player.alive ? player.x + seq.side * 14 : VW / 2 + seq.side * 14;
      const targetY = player && player.alive ? player.y : VH - 48;
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
      // ~0.4s: snap to dual formation
      const dur = 400;
      if (player && player.alive) {
        seq.fx = player.x + seq.side * 14;
        seq.fy = player.y;
      }
      if (seq.t >= dur * 0.35 && !seq.docked) {
        seq.docked = true;
        dual = true;
        if (player) player.w = 36;
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
        flashMsg("DUAL FIGHTER!", 1600);
      }
      if (seq.t >= dur) {
        rescueSeq = null;
      }
    }
  }

  function drawRescueFighter(seq) {
    if (!seq || seq.phase === "dock" && seq.docked) return;
    // Once dual is formed, main drawPlayer shows both ships
    if (seq.docked && dual) return;

    const x = seq.fx;
    const y = seq.fy;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(seq.angle);

    // Red→white captive becoming free fighter
    const r = seq.red;
    const body = r > 0.45 ? "#ff3030" : "#ffffff";
    const accent = r > 0.45 ? "#c02020" : "#3060ff";
    const wing = r > 0.45 ? "#ff6060" : "#ff3030";
    const nose = r > 0.45 ? "#ff8080" : "#ffff40";

    fillRect(-1, -12, 2, 6, nose);
    fillRect(-4, -8, 8, 4, body);
    fillRect(-6, -4, 12, 8, body);
    fillRect(-3, -2, 6, 5, accent);
    fillRect(-9, 2, 4, 4, wing);
    fillRect(5, 2, 4, 4, wing);
    fillRect(-2, 6, 4, 3, body);

    // spin sparkle
    if (seq.phase === "spin" || seq.phase === "approach") {
      ctx.globalAlpha = 0.55 + 0.45 * Math.sin(seq.t / 40);
      fillRect(-10, -10, 2, 2, "#ffff80");
      fillRect(8, 8, 2, 2, "#80ffff");
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function killPlayer() {
    if (!player || !player.alive || invuln > 0) return;
    burst(player.x, player.y, C.white, 18);
    burst(player.x, player.y, C.orange, 10);
    sfx("die");
    if (dual) {
      // Dual breaks to single on hit (arcade-ish)
      dual = false;
      player.w = 18;
      invuln = 1500;
      flashMsg("DUAL FIGHTER HIT!", 1000);
      return;
    }
    player.alive = false;
    lives--;
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
    const margin = dual ? 22 : 14;
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
      } else if (e.state === "beam") {
        // During full capture cinematic, boss is driven by captureSeq
        if (captureSeq && captureSeq.boss === e) {
          continue;
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
        const done = followPath(e, e.returnPath, dt, 110);
        if (done) {
          e.state = "form";
          e.returnPath = null;
          e.pathPos = 0;
          e.divePath = null;
          e.angle = Math.PI / 2;
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
          const hitR = (dual ? 16 : 11) + (e.type === "boss" ? 6 : 0);
          if (dist(e.x, e.y, player.x, player.y) < hitR + 8) {
            killEnemy(e, true);
            killPlayer();
            continue;
          }
        }

        if (e.pathPos >= e.divePath.length - 1) {
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
          // Prefer lower bees/butterflies, sometimes boss
          pool.sort((a, b) => b.slot.row - a.slot.row);
          const pick =
            chance(0.2) && pool.some((e) => e.type === "boss")
              ? pool.find((e) => e.type === "boss")
              : pool[(Math.random() * Math.min(8, pool.length)) | 0];
          if (pick) startDive(pick);
        }
      }
    }

    // Stage clear
    if (state === "play" && enemies.length === 0) {
      if (isChallenge) {
        state = "challenge";
        challengeT = 2800;
        const acc =
          challengeShots > 0
            ? Math.round((challengeHits / challengeShots) * 100)
            : 0;
        // Perfect = all enemies hit (40)
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
        const hw = e.type === "boss" ? 16 : e.type === "butterfly" ? 13 : 11;
        const hh = e.type === "boss" ? 14 : 12;
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
        const hitW = dual ? 16 : 10;
        if (Math.abs(b.x - player.x) < hitW && Math.abs(b.y - player.y) < 12) {
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

    if (state === "title" || state === "over" || state === "pause") return;

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
      // Full tractor-beam cinematic: pull → red → dock → haul home → respawn
      updateCaptureSequence(dt);
      // Boss return path + other enemies idle in formation
      updateEnemies(dt);
      updateParticles(dt);
      // Don't expire cinematic beams via normal decay
      for (const b of beams) {
        if (captureSeq && b.enemy === captureSeq.boss) b.life = 9999;
      }
      return;
    }

    if (state === "die") {
      dieT -= dt;
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
      if ((state === "clear" && clearT <= 0) || (state === "challenge" && challengeT <= 0)) {
        beginStage(stage + 1);
      }
      return;
    }

    if (state !== "play") return;

    updatePlayer(dt);
    updateEnemies(dt);
    updateBullets(dt);
    updateBeams(dt);
    updateParticles(dt);
    updateRescueSequence(dt);
  }

  // ── Draw (detailed Namco-style pixel sprites) ────────────────────────────
  function fillRect(x, y, w, h, col) {
    ctx.fillStyle = col;
    ctx.fillRect(x | 0, y | 0, w, h);
  }

  // Palette index for sprite maps
  const SP = {
    _: null,
    W: "#ffffff",
    w: "#c8c8d8",
    R: "#ff3030",
    r: "#c02020",
    B: "#3060ff",
    b: "#1838c0",
    Y: "#ffff40",
    y: "#c8c020",
    G: "#30e030",
    g: "#189818",
    L: "#80ff80",
    C: "#40ffff",
    c: "#2080a0",
    O: "#ff8800",
    M: "#ff60a0",
    K: "#101018",
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
        fillRect(x0 + i * px, y0 + j * px, px, px, col);
      }
    }
  }

  // Fighter (Gyaraga) — classic white ship with blue body / red thrusters
  const SPR_FIGHTER = [
    "......W......",
    ".....WWW.....",
    "....WYWyw....",
    "....WWWWW....",
    "...WBBBBBW...",
    "..WBwWWWwBW..",
    ".WR.WWWWW.RW.",
    ".R..WwWwW..R.",
    "....R...R....",
  ];
  // Captured fighter (red-tinted)
  const SPR_CAPTURED = [
    "......R......",
    ".....RRR.....",
    "....RrRrR....",
    "....RRRRR....",
    "...RwwwwwR...",
    "..RwRRRRRwR..",
    ".RR.RRRRR.RR.",
    ".R..RrRrR..R.",
    "....R...R....",
  ];
  // Bee / Zako — blue body, yellow face, wing frames
  const SPR_BEE_A = [
    "..bb...bb..",
    ".bBBb.bBBb.",
    "..BYBYBYB..",
    ".BBWWWWWBB.",
    "bBBYYYYBBBb",
    ".BBBYYYBBB.",
    "..B.YYY.B..",
    "....YYY....",
    ".....Y.....",
  ];
  const SPR_BEE_B = [
    "b.bb...bb.b",
    ".bBBb.bBBb.",
    "..BYBYBYB..",
    ".BBWWWWWBB.",
    ".BBYYYYYBB.",
    "..BBYYYBB..",
    "...BYYYB...",
    "....YYY....",
    ".....Y.....",
  ];
  // Butterfly / Goei — red core, pink/white wings
  const SPR_BUTTER_A = [
    "MM.......MM",
    "MMrR...RrMM",
    ".MrWRWRWrM.",
    "..RWWWWWR..",
    ".RRWYWYWRR.",
    "RR.RWRWR.RR",
    "R...RRR...R",
    ".....R.....",
  ];
  const SPR_BUTTER_B = [
    ".MM.....MM.",
    "MMrR...RrMM",
    "MMrWRWRWrMM",
    ".RRWWWWWRR.",
    "..RWYWYWR..",
    ".R.RWRWR.R.",
    "R...RRR...R",
    ".....R.....",
  ];
  function drawStars() {
    for (const s of stars) {
      fillRect(s.x, s.y, s.s, s.s, s.c);
    }
  }

  function drawPlayer() {
    if (!player || !player.alive) return;
    if (invuln > 0 && ((invuln / 70) | 0) % 2 === 0) return;
    const x = player.x;
    const y = player.y;
    // During rescue approach, keep single ship until dock completes
    const showDual = dual && !(rescueSeq && !rescueSeq.docked);
    if (showDual) {
      blit(x - 14, y, SPR_FIGHTER, 1.15);
      blit(x + 14, y, SPR_FIGHTER, 1.15);
    } else {
      blit(x, y, SPR_FIGHTER, 1.2);
    }
  }

  function drawEnemy(e) {
    if (e.state === "dead") return;
    if (e.x < -50 || e.x > VW + 50 || e.y < -50) return;
    const x = e.x;
    const y = e.y;
    const frame = ((e.flap / 180) | 0) % 2;

    ctx.save();
    ctx.translate(x, y);
    // Beam / return: keep upright so captive docks below (not flipped)
    if (e.state === "dive" || e.state === "challenge" || e.state === "enter") {
      ctx.rotate(e.angle + Math.PI / 2);
    }

    if (e.type === "bee") {
      blit(0, 0, frame ? SPR_BEE_B : SPR_BEE_A, 1.15);
    } else if (e.type === "butterfly") {
      blit(0, 0, frame ? SPR_BUTTER_B : SPR_BUTTER_A, 1.2);
    } else if (e.type === "boss") {
      const hurt = e.hp < 2;
      drawBossSprite(0, 0, hurt, frame);
      if (e.hasCaptive || (captureSeq && captureSeq.boss === e && captureSeq.attached)) {
        blit(0, 18, SPR_CAPTURED, 0.95);
      }
    }

    ctx.restore();
  }

  function drawBossSprite(ox, oy, hurt, frame) {
    // Detailed boss Galaga: dual pods, yellow eyes, green armor, wing flaps
    const g = hurt ? "#ffb020" : "#28d828";
    const g2 = hurt ? "#c07010" : "#189818";
    const eye = hurt ? "#ff4040" : "#ffff40";
    const wing = hurt ? "#ffd070" : "#70ff70";
    const px = 1.2;
    // outer wing panels
    const wy = frame ? -1 : 1;
    fillRect(ox - 16 * px, oy - 2 * px + wy, 5 * px, 3 * px, wing);
    fillRect(ox + 11 * px, oy - 2 * px - wy, 5 * px, 3 * px, wing);
    fillRect(ox - 15 * px, oy + 1 * px + wy, 4 * px, 2 * px, g2);
    fillRect(ox + 11 * px, oy + 1 * px - wy, 4 * px, 2 * px, g2);
    // body
    fillRect(ox - 8 * px, oy - 6 * px, 16 * px, 12 * px, g);
    fillRect(ox - 6 * px, oy - 8 * px, 12 * px, 3 * px, g2);
    fillRect(ox - 5 * px, oy + 5 * px, 10 * px, 3 * px, g2);
    // dual "mirror" heads
    fillRect(ox - 9 * px, oy - 4 * px, 6 * px, 6 * px, g);
    fillRect(ox + 3 * px, oy - 4 * px, 6 * px, 6 * px, g);
    // eyes
    fillRect(ox - 7 * px, oy - 2 * px, 3 * px, 3 * px, eye);
    fillRect(ox + 4 * px, oy - 2 * px, 3 * px, 3 * px, eye);
    fillRect(ox - 6 * px, oy - 1 * px, 1 * px, 1 * px, "#000");
    fillRect(ox + 5 * px, oy - 1 * px, 1 * px, 1 * px, "#000");
    // center jewel
    fillRect(ox - 2 * px, oy + 1 * px, 4 * px, 3 * px, "#ffffff");
    fillRect(ox - 1 * px, oy + 2 * px, 2 * px, 1 * px, eye);
    // legs / thrusters
    fillRect(ox - 5 * px, oy + 8 * px, 2 * px, 3 * px, g2);
    fillRect(ox + 3 * px, oy + 8 * px, 2 * px, 3 * px, g2);
    fillRect(ox - 1 * px, oy + 8 * px, 2 * px, 2 * px, wing);
  }

  function drawBullets() {
    for (const b of bullets) {
      // classic twin-pixel yellow missile
      fillRect(b.x - 1, b.y - 7, 2, 10, "#ffff60");
      fillRect(b.x - 1, b.y - 7, 2, 3, "#ffffff");
      fillRect(b.x - 2, b.y - 1, 4, 2, "#c8c020");
    }
    for (const b of eBullets) {
      // Galaga-style enemy bomb (pink diamond)
      fillRect(b.x - 1, b.y - 3, 2, 6, "#ff80c0");
      fillRect(b.x - 2, b.y - 1, 4, 2, "#ff40a0");
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
      // During pull, beam reaches the rising fighter; otherwise to bottom row
      let targetY = VH - 40;
      if (captureSeq && captureSeq.boss === e && captureSeq.phase === "pull") {
        targetY = Math.max(captureSeq.fy + 20, y + 40);
      } else if (player && player.alive) {
        targetY = player.y + 20;
      }
      const open = e.beamOpen != null ? e.beamOpen : 1;
      const coneLen = Math.max(80, (targetY - y) * open);
      const coneHalf = 58 * open;
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 70);
      // Expanding rings (arcade tractor look)
      for (let i = 0; i < 16; i++) {
        const t0 = i / 16;
        const t1 = (i + 1) / 16;
        const w0 = 6 + t0 * coneHalf * pulse;
        const w1 = 6 + t1 * coneHalf * pulse;
        const y0 = y + 16 + t0 * coneLen;
        const y1 = y + 16 + t1 * coneLen;
        ctx.globalAlpha = (0.1 + 0.16 * ((i % 2) + pulse * 0.4)) * open;
        ctx.fillStyle = i % 2 ? "#40ffff" : "#ffffff";
        ctx.beginPath();
        ctx.moveTo(x - w0, y0);
        ctx.lineTo(x + w0, y0);
        ctx.lineTo(x + w1, y1);
        ctx.lineTo(x - w1, y1);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      fillRect(x - 7, y + 10, 14, 6, "#a0ffff");
      fillRect(x - 3, y + 8, 6, 4, "#ffffff");
    }
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = clamp(p.life / 400, 0, 1);
      fillRect(p.x, p.y, p.size || 2, p.size || 2, p.color);
    }
    ctx.globalAlpha = 1;
  }

  function drawMessages() {
    if (messageT > 0 && message) {
      ctx.fillStyle = C.yellow;
      ctx.font = '10px "Press Start 2P", monospace';
      ctx.textAlign = "center";
      ctx.fillText(message, VW / 2, VH * 0.55);
    }
  }

  function render() {
    // 2× crisp pixels; all draw code stays in logical VW×VH space
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
    player.x = clamp(x, 14, VW - 14);
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
  showOV("GALAGA", "INSERT COIN", "BUILD V7 — PRESS SPACE OR TAP");
})();
