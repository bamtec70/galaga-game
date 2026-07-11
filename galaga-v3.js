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
  let state = "title"; // title | intro | play | die | clear | challenge | over | pause
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

  function divePathFor(e) {
    const pts = [];
    const sx = e.x;
    const sy = e.y;
    const targetX = player ? player.x + rnd(-40, 40) : VW / 2;
    const side = e.slot.col < 5 ? -1 : 1;
    // leave formation with a deliberate loop
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const a = t * Math.PI;
      pts.push({
        x: sx + Math.sin(a) * 42 * side,
        y: sy - Math.sin(a) * 28,
      });
    }
    // wavy dive toward player (arcade-readable curves)
    const midY = VH * 0.52;
    for (let i = 1; i <= 40; i++) {
      const t = i / 40;
      pts.push({
        x: lerp(sx, targetX, t) + Math.sin(t * Math.PI * 2) * 28,
        y: lerp(sy, midY, t),
      });
    }
    // exit sweep
    const exitX = chance(0.5) ? -40 : VW + 40;
    for (let i = 1; i <= 32; i++) {
      const t = i / 32;
      pts.push({
        x: lerp(targetX, exitX, t),
        y: lerp(midY, VH + 40, t * 0.85 + 0.15),
      });
    }
    return pts;
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
      !!diving || e.state === "dive" || e.state === "beam" || e.state === "challenge";
    const hadCaptive = e.type === "boss" && e.hasCaptive;
    const diveRescue = hadCaptive && wasDiving;

    e.state = "dead";
    addScore(enemyScore(e, wasDiving));
    if (isChallenge) challengeHits++;

    // Captive rescue: destroy boss while diving with captive → dual fighter
    if (hadCaptive) {
      e.hasCaptive = false;
      capturedHeld = false;
      if (diveRescue) {
        dual = true;
        if (player) player.w = 36;
        sfx("rescue");
        flashMsg("FIGHTER RESCUED!", 1800);
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
    e.divePath = divePathFor(e);
    e.diveI = 0;
    e.diveT = 0;
    e.escorts = 0;
    // Butterflies can escort boss
    if (e.type === "boss") {
      const escorts = enemies.filter(
        (o) => o.state === "form" && o.type === "butterfly" && !o.divePath
      );
      let taken = 0;
      for (const o of escorts) {
        if (taken >= 2) break;
        if (Math.abs(o.x - e.x) < 80) {
          o.state = "dive";
          o.divePath = divePathFor(o);
          o.diveI = 0;
          o.diveT = 0;
          taken++;
          e.escorts++;
        }
      }
      // Chance to open tractor beam during dive
      e.willBeam = chance(0.35) && !capturedHeld && !dual;
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
        e.pathT += dt;
        const stepMs = 52; // slower convoy entry (arcade pace)
        while (e.pathT >= stepMs && e.pathI < e.path.length - 1) {
          e.pathT -= stepMs;
          e.pathI++;
          const p = e.path[e.pathI];
          const prev = e.path[e.pathI - 1] || p;
          e.x = p.x;
          e.y = p.y;
          e.angle = Math.atan2(p.y - prev.y, p.x - prev.x);
        }
        if (e.pathI >= e.path.length - 1) {
          e.state = "form";
          const fp = slotPos(e.slot, formSway);
          e.x = fp.x;
          e.y = fp.y;
          e.angle = Math.PI / 2;
          // Reattach captive to first boss if needed
          if (e.type === "boss" && capturedHeld && !enemies.some((o) => o.hasCaptive)) {
            e.hasCaptive = true;
          }
        }
      } else if (e.state === "form") {
        inFormation++;
        const fp = slotPos(e.slot, formSway);
        e.x = lerp(e.x, fp.x, 0.07);
        e.y = lerp(e.y, fp.y, 0.07);
        e.angle = Math.PI / 2;
      } else if (e.state === "dive" || e.state === "beam") {
        if (!e.divePath || !e.divePath.length) {
          e.state = "form";
          continue;
        }
        e.diveT += dt;
        const stepMs = 40; // slower dives — readable arcade curves
        while (e.diveT >= stepMs && e.diveI < e.divePath.length - 1) {
          e.diveT -= stepMs;
          e.diveI++;
          const p = e.divePath[e.diveI];
          const prev = e.divePath[Math.max(0, e.diveI - 1)];
          e.x = p.x;
          e.y = p.y;
          e.angle = Math.atan2(p.y - prev.y, p.x - prev.x);
        }

        // Tractor beam opportunity mid-dive
        if (
          e.type === "boss" &&
          e.willBeam &&
          !e.beamed &&
          e.diveI > 10 &&
          e.diveI < 30 &&
          player &&
          player.alive
        ) {
          if (Math.abs(e.x - player.x) < 50 && e.y < player.y - 40) {
            e.state = "beam";
            e.beamed = true;
            e.beamT = 0;
            beams.push({ enemy: e, life: 2200, x: e.x, y: e.y });
            sfx("beam");
          }
        }

        if (e.state === "beam") {
          e.beamT = (e.beamT || 0) + dt;
          e.x = lerp(e.x, player ? player.x : e.x, 0.02);
          // Hold position while beaming
          if (e.beamT > 2200) {
            e.state = "dive";
          }
          // Capture check
          if (
            player &&
            player.alive &&
            invuln <= 0 &&
            Math.abs(player.x - e.x) < 28 &&
            player.y > e.y &&
            player.y < e.y + 160
          ) {
            // Captured!
            sfx("capture");
            burst(player.x, player.y, C.cyan, 16);
            e.hasCaptive = true;
            capturedHeld = true;
            dual = false;
            lives--; // capture costs a life
            hud();
            flashMsg("FIGHTER CAPTURED!", 2000);
            if (lives <= 0) {
              player.alive = false;
              state = "over";
              showOV("GAME OVER", "SCORE " + pad(score), "PRESS SPACE OR TAP");
            } else {
              spawnPlayer();
              invuln = 2500;
            }
            e.state = "dive";
            // Return home after capture
            e.divePath = [
              { x: e.x, y: e.y },
              { x: e.x, y: 80 },
              slotPos(e.slot, formSway),
            ];
            e.diveI = 0;
            e.diveT = 0;
          }
        }

        // Shoot while diving
        e.shootT -= dt;
        if (e.shootT <= 0 && player && player.alive && e.y < VH - 80) {
          e.shootT = 1000 + Math.random() * 1200 - Math.min(250, stage * 15);
          eBullets.push({
            x: e.x,
            y: e.y + 8,
            vx: (player.x - e.x) * 0.07,
            vy: 78 + stage * 3,
          });
        }

        // Collision with player
        if (player && player.alive && invuln <= 0) {
          const hitR = dual ? 18 : 12;
          if (dist(e.x, e.y, player.x, player.y) < hitR + 10) {
            killEnemy(e, true);
            killPlayer();
          }
        }

        // End of dive: wrap back to formation or remove if offscreen challenge-style
        if (e.diveI >= e.divePath.length - 1) {
          if (e.y > VH + 20 || e.x < -40 || e.x > VW + 40) {
            // Return to formation from top
            e.state = "form";
            e.divePath = null;
            const fp = slotPos(e.slot, formSway);
            e.x = fp.x;
            e.y = -20;
          } else {
            e.state = "form";
            e.divePath = null;
          }
        }
      } else if (e.state === "challenge") {
        if (!e.challengeActive) continue;
        e.pathT += dt;
        const stepMs = 48;
        while (e.pathT >= stepMs && e.pathI < e.path.length - 1) {
          e.pathT -= stepMs;
          e.pathI++;
          const p = e.path[e.pathI];
          const prev = e.path[Math.max(0, e.pathI - 1)];
          e.x = p.x;
          e.y = p.y;
          e.angle = Math.atan2(p.y - prev.y, p.x - prev.x);
        }
        if (e.pathI >= e.path.length - 1) {
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

    // Player bullets vs enemies
    for (const b of bullets) {
      for (const e of enemies) {
        if (e.state === "dead") continue;
        if (e.x < -50) continue;
        if (Math.abs(b.x - e.x) < 12 && Math.abs(b.y - e.y) < 12) {
          b.y = -999;
          killEnemy(e, e.state === "dive" || e.state === "beam" || e.state === "challenge");
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
      // Still animate entry during intro
      updateEnemies(dt * 0.7);
      updateParticles(dt);
      if (introT <= 0) {
        state = "play";
        hideOV();
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
      const t = state === "clear" ? (clearT -= dt) : (challengeT -= dt);
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
    if (dual) {
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
    if (e.state === "dive" || e.state === "beam" || e.state === "challenge" || e.state === "enter") {
      ctx.rotate(e.angle + Math.PI / 2);
    }

    if (e.type === "bee") {
      blit(0, 0, frame ? SPR_BEE_B : SPR_BEE_A, 1.15);
    } else if (e.type === "butterfly") {
      blit(0, 0, frame ? SPR_BUTTER_B : SPR_BUTTER_A, 1.2);
    } else if (e.type === "boss") {
      const hurt = e.hp < 2;
      drawBossSprite(0, 0, hurt, frame);
      if (e.hasCaptive) {
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
      if (!beam.enemy) continue;
      const x = beam.x;
      const y = beam.y;
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 90);
      // Segmented tractor cone (arcade-like)
      for (let i = 0; i < 10; i++) {
        const t0 = i / 10;
        const t1 = (i + 1) / 10;
        const w0 = 4 + t0 * 36 * pulse;
        const w1 = 4 + t1 * 36 * pulse;
        const y0 = y + 10 + t0 * 150;
        const y1 = y + 10 + t1 * 150;
        ctx.globalAlpha = 0.15 + 0.12 * ((i % 2) + pulse);
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
      // boss emitter glow
      fillRect(x - 4, y + 6, 8, 4, "#80ffff");
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
  showOV("GALAGA", "INSERT COIN", "BUILD V3 — PRESS SPACE OR TAP");
})();
