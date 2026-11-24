import { useEffect } from 'react';
import './App.css';

// Core game logic for Soulshift
//
// NOTE: this project is now LightShuttle (a bullet heaven game). Soulshift was
// the abandoned Hollow Knight-style predecessor. Leftovers from it (audio
// generation, the old player/dash/immunity model, `minions`, etc.) are kept on
// purpose because LightShuttle still reuses some of them.

/* ==========================================================================
   CONSTANTS
   ========================================================================== */

const DEBUG = false;

// Everything inside the arena (players, bullets, bombs, lasers, markers) is drawn and
// hit-tested 1.3x bigger than before, because the arena itself became about 2x larger.
const ENTITY_SCALE = 1.3;
// Lasers are long enough to stretch across the whole screen at any angle
const LASER_LENGTH = 3600;

// All randomness goes through rand() so Pattern Library demos can be seeded and
// therefore repeat exactly (see seedRandom / LESSONS).
const realRandom = Math.random.bind(Math);
let rng = realRandom;
function rand() {
    return rng();
}
function seedRandom(seed) {
    let a = seed >>> 0;
    rng = function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function unseedRandom() {
    rng = realRandom;
}
const TAU = Math.PI * 2;
const PHI = (1 + Math.sqrt(5)) / 2; // golden ratio

// --- Simulation ---------------------------------------------------------
// The simulation always advances in fixed 1/60 s ticks. All speeds, timers and
// cooldowns in this file are expressed in ticks, exactly like the old
// per-frame values, so gameplay feels the same as a 60 Hz monitor everywhere.
const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;
const MAX_CATCHUP_STEPS = 8; // never try to catch up more than this per frame

// --- Layout (logical pixels; CSS scales the canvas to the window) ---------
// The playable area is about 2x the old 800x600 (1120x840 = 1.96x the area).
const PLAY_W = 1120;
const PLAY_H = 840;
// Menus are laid out on a fixed 800x600 board and centred inside the arena
const HUB_W = 800;
const HUB_H = 600;
const HUB_OX = (PLAY_W - HUB_W) / 2;
const HUB_OY = (PLAY_H - HUB_H) / 2;
const GUTTER = 48; // negative space around the play area (spawn indicators)
const HUD_H = 64; // strip ABOVE the play area (health, dash, heal, speed / time)
const CANVAS_W = PLAY_W + GUTTER * 2;
const CANVAS_H = PLAY_H + GUTTER * 2 + HUD_H;
const PLAY_OY = HUD_H + GUTTER; // top edge of the play area on the canvas
const UI_OY = (CANVAS_H - 760) / 2; // title / game-over screens are laid out for 760 px of height

// --- Projectile loading system -------------------------------------------
const LOADER = {
    capacity: 6, // bullet slots per cycle
    baseInterval: 3.5 * TICK_RATE, // normal load interval (3.5 s)
    distractInterval: 4 * TICK_RATE, // interval when a distraction is loaded (4 s)
    minInterval: 90, // earliest an "everything despawned" reload may happen
    lead: 72, // telegraph time before the first loaded pattern fires
    stagger: 36, // ticks between patterns of one batch
    maxCarry: 2, // patterns allowed to wait for the next cycle
    bulletSoftCap: 280 // loaded patterns wait while this many bullets are alive
};

// --- Player ------------------------------------------------------------------
const DASH_GRACE_TICKS = 6; // 0.1 s of invulnerability after a dash ends
const HEAL_DELAY_TICKS = 12 * TICK_RATE; // damage-free time needed to heal 1 hit

/* ==========================================================================
   GAME STATE
   ========================================================================== */

let gameRunning = false;
const highScores = { normal: 0, hitless: 0 };
try {
    highScores.normal = Number(localStorage.getItem('highScore')) || 0;
    highScores.hitless = Number(localStorage.getItem('highScoreHitless')) || 0;
} catch (e) {
    // storage unavailable, ignore
}
let gameStartTime = 0; // wall clock, only used for debug output
let survivalTime = 0;
// 'normal': 6 slots, scaling difficulty, timed unlocks, damage-free healing.
// 'hitless': 4 slots, one hit ends the run, no scaling, every pattern unlocked
//            from the start, no healing.
let gameMode = 'normal';
const HITLESS_CAPACITY = 4;
const DUEL_CAPACITY = 8; // 1v1 loads 8 slots per batch
const DUEL_HEAL_TICKS = 4 * TICK_RATE; // 1v1 heals after 4 s without damage

// Screen flow: title -> menu (physical arena hubs) -> playing / practice /
// lesson / tutorial -> over. Everything (title, menus, game over) is drawn on
// the canvas, so the game needs no HTML other than the <canvas> React renders.
let gameState = 'title';
let hub = null; // arena hub currently shown while gameState === 'menu'

// Hold-to-select times (ticks). Holding is what prevents accidental picks
// when you only pass near an option.
const MENU_DWELL = {
    mode: 4 * TICK_RATE, // Normal / Hitless (the iris wipe closes over this time)
    gateway: 3 * TICK_RATE, // Practice
    sub: 2 * TICK_RATE, // practice sub-options, library lessons
    toggle: TICK_RATE, // custom practice on/off pads
    back: 90 // back pads
};
const menu = { screen: 'main', progress: {}, locked: {}, t: 0, msg: '', msgTimer: 0 };

// Shared by every training state (practice / lesson / tutorial): hits are
// counted instead of costing health.
const practice = { hits: 0, t: 0 };
let lastRun = { mode: 'normal', time: 0, best: 0 };

const lesson = {
    index: 0, phase: 'demo', t: 0, entry: null, demoKeys: emptyKeys(),
    scriptedDash: false, endTimer: 0, demoHits: 0, streak: 0, cycles: 0,
    cycleActive: false, cooldown: 0, cycleHits0: 0
};
const tutorial = {
    step: 0, t: 0, moved: 0, dashes: 0, lastX: 0, lastY: 0, hits0: 0,
    entries: [], settle: 0, msg: '', msgTimer: 0
};

// Patterns enabled in Custom Practice (remembered between sessions)
let customSel = new Set(['circle', 'spread', 'shotgun']);
try {
    const saved = JSON.parse(localStorage.getItem('customPractice'));
    if (Array.isArray(saved) && saved.length) customSel = new Set(saved);
} catch (e) {
    // storage unavailable, ignore
}

// Smooth screen changes: fade out -> switch state -> fade in
const transition = { active: false, phase: 'out', timer: 0, outTicks: 16, inTicks: 24, action: null, iris: false };

const pointer = { x: -1, y: -1 }; // mouse position in canvas coordinates

// Optional artwork: set PAD_IMAGES.normal = someLoadedImage (etc., keyed by pad
// id) and it replaces the drawn illustration for that pad.
const PAD_IMAGES = {};

/* ==========================================================================
   AUDIO (Web Audio API generated sounds)
   ========================================================================== */

let audioContext = null;
const sounds = {};

// Created lazily so it is only made after a user gesture
function getAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioContext;
}

// Generate simple sound effects
function generateSound(type, duration = 0.1, volume = 0.5) {
    const sampleRate = getAudioContext().sampleRate;
    const buffer = getAudioContext().createBuffer(1, Math.floor(sampleRate * duration), sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        let value = 0;

        switch (type) {
            case 'hit':
                // Short click sound
                value = Math.sin(2 * Math.PI * 880 * t) * Math.exp(-20 * t) * volume;
                break;
            case 'dash':
                // Whoosh sound
                value = Math.sin(2 * Math.PI * (800 - 600 * t) * t) * Math.exp(-4 * t) * volume;
                break;
            case 'explosion':
                // Low boom sound
                value = (rand() * 2 - 1) * Math.exp(-5 * t) * volume;
                break;
            case 'shoot':
                // Short beep
                value = Math.sin(2 * Math.PI * 660 * t) * Math.exp(-15 * t) * volume;
                break;
            case 'heal':
                // Rising two-tone blip
                value = Math.sin(2 * Math.PI * (520 + 700 * t) * t) * Math.exp(-6 * t) * volume;
                break;
            case 'background':
                // Simple background drone
                value = (Math.sin(2 * Math.PI * 220 * t) * 0.3 +
                    Math.sin(2 * Math.PI * 440 * t) * 0.2) *
                    (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.5 * t)) *
                    volume * 0.3;
                break;
            default:
                // Default case for unexpected types
                value = 0;
                break;
        }

        data[i] = value;
    }

    return buffer;
}

// Initialize all sounds
function initSounds() {
    sounds.hit = generateSound('hit', 0.1, 0.7);
    sounds.dash = generateSound('dash', 0.3, 0.5);
    sounds.explosion = generateSound('explosion', 0.5, 0.6);
    sounds.shoot = generateSound('shoot', 0.15, 0.4);
    sounds.heal = generateSound('heal', 0.3, 0.5);
    sounds.background = generateSound('background', 4.0, 0.3);
}

// Play sound function
function playSound(soundName, volume = 1.0, rate = 1.0) {
    if (!sounds[soundName]) return null;

    try {
        const ac = getAudioContext();
        const source = ac.createBufferSource();
        const gainNode = ac.createGain();

        source.buffer = sounds[soundName];
        source.playbackRate.value = rate;
        gainNode.gain.value = Math.min(1, Math.max(0, volume));

        // For background music, set it to loop (must be set before start)
        if (soundName === 'background') {
            source.loop = true;
        }

        source.connect(gainNode);
        gainNode.connect(ac.destination);
        source.start();

        return source;
    } catch (e) {
        console.warn('Error playing sound:', e);
        return null;
    }
}

/* ==========================================================================
   CANVAS
   ========================================================================== */

let canvas = null;
let ctx = null;

/* The canvas always fills the whole browser window. The game itself is drawn
   at a fixed logical size (CANVAS_W x CANVAS_H) and scaled to the largest size
   that fits, so a wider monitor never gets more arena - it only gets more
   background around the same arena. */
const view = { w: CANVAS_W, h: CANVAS_H, scale: 1, ox: 0, oy: 0 };

function resizeCanvas() {
    const cssW = window.innerWidth || CANVAS_W;
    const cssH = window.innerHeight || CANVAS_H;
    let ratio = Math.min(window.devicePixelRatio || 1, 2);
    const pixels = cssW * cssH * ratio * ratio;
    if (pixels > 4.2e6) ratio *= Math.sqrt(4.2e6 / pixels); // keep very large / hi-dpi screens fast
    view.w = Math.max(1, Math.floor(cssW * ratio));
    view.h = Math.max(1, Math.floor(cssH * ratio));
    canvas.width = view.w;
    canvas.height = view.h;
    view.scale = Math.min(view.w / CANVAS_W, view.h / CANVAS_H);
    view.ox = (view.w - CANVAS_W * view.scale) / 2;
    view.oy = (view.h - CANVAS_H * view.scale) / 2;
}

// The whole window expressed in logical (game) coordinates
function screenRect() {
    return { x: -view.ox / view.scale, y: -view.oy / view.scale, w: view.w / view.scale, h: view.h / view.scale };
}

function fillScreen(style) {
    const r = screenRect();
    ctx.fillStyle = style;
    ctx.fillRect(r.x, r.y, r.w, r.h);
}

/* ==========================================================================
   PLAYER
   ========================================================================== */

const player = {
    id: 1,
    fill: 'rgba(0, 100, 255, 0.9)', // body colour
    dashFill: 'rgba(0, 200, 255, 0.7)',
    ghostColor: '#4da6ff',
    ramDone: false,
    x: 100,
    y: 300,
    width: 24, // 0.75 of 32
    height: 24, // 0.75 of 32
    speed: 5,
    maxHits: 8,
    hitsRemaining: 8,
    isMoving: false,
    direction: { x: 0, y: 0 },
    vx: 0, // per-tick velocity (used by the sniper to aim slightly ahead)
    vy: 0,
    facing: 0, // last facing angle (radians); kept when no key is held
    // Dash properties
    isDashing: false,
    dashSpeed: 15,
    dashDuration: 10, // length of a dash in ticks (constant)
    dashTimer: 0, // ticks left in the current dash
    dashGrace: 0, // ticks of invulnerability left AFTER a dash
    dashCooldown: 0,
    dashCooldownMax: 30,
    dashDirection: { x: 0, y: 0 },
    // Immunity properties
    isImmune: false,
    immunityTimer: 0,
    immunityDuration: 120, // 2 seconds at 60 ticks/s
    flashTimer: 0,
    flashRate: 5,
    isVisible: true,
    // Legacy passive-regen fields (Soulshift). Normal Mode now heals through
    // `noHitTimer` instead; these are kept so nothing else breaks.
    healTimer: 0,
    healInterval: 20 * 60,
    // Damage-free time (ticks). Reset by taking damage.
    noHitTimer: 0
};

// Player 2 (1v1 only): same model as player 1, different colours
const player2 = {
    ...player,
    id: 2,
    fill: 'rgba(255, 140, 40, 0.92)',
    dashFill: 'rgba(255, 220, 120, 0.8)',
    ghostColor: '#ff9f43',
    direction: { x: 0, y: 0 },
    dashDirection: { x: -1, y: 0 }
};
let twoPlayer = false; // true only during a 1v1 match

function activePlayers() {
    return twoPlayer ? [player, player2] : [player];
}

// Who an aimed attack targets. Solo: always the player (and no random numbers
// are drawn, so seeded lessons stay repeatable). 1v1: a random living player.
function pickTarget() {
    if (!twoPlayer) return player;
    const alive = activePlayers().filter(p => p.hitsRemaining > 0);
    return alive.length ? alive[Math.floor(rand() * alive.length)] : player;
}

/* ---------- Key bindings (rebindable in Main Menu > Controls) ---------- */

const ACTIONS = ['up', 'down', 'left', 'right', 'dash'];
const DEFAULT_BINDINGS = {
    p1: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', dash: 'Space' },
    p2: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', dash: 'Control' }
};
let bindings = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));
try {
    const saved = JSON.parse(localStorage.getItem('keybinds'));
    if (saved && saved.p1 && saved.p2) {
        ['p1', 'p2'].forEach(who => ACTIONS.forEach(a => {
            if (typeof saved[who][a] === 'string') bindings[who][a] = saved[who][a];
        }));
    }
} catch (e) {
    // storage unavailable, ignore
}

function saveBindings() {
    try {
        localStorage.setItem('keybinds', JSON.stringify(bindings));
    } catch (e) {
        // storage unavailable, ignore
    }
}

function resetBindings() {
    bindings = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));
    saveBindings();
}

// Left / right modifier keys count as the same key
function normalizeCode(code) {
    if (!code) return '';
    if (code.startsWith('Control')) return 'Control';
    if (code.startsWith('Shift')) return 'Shift';
    if (code.startsWith('Alt')) return 'Alt';
    return code;
}

function keyLabel(code) {
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    const names = {
        ArrowUp: '\u2191 UP', ArrowDown: '\u2193 DOWN', ArrowLeft: '\u2190 LEFT', ArrowRight: '\u2192 RIGHT',
        Space: 'SPACE', Control: 'CTRL', Shift: 'SHIFT', Alt: 'ALT', Enter: 'ENTER', Tab: 'TAB', Backspace: 'BACKSPACE'
    };
    return names[code] || code.toUpperCase();
}

const held = new Set(); // normalized key codes currently held
const rebind = { active: false, who: 'p1', action: 'up' };

function emptyKeys() {
    return { ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false, w: false, a: false, s: false, d: false };
}

// Movement input for one player. Solo modes accept Player 1's keys AND Player 2's
// movement keys (so WASD and the arrows both work); 1v1 keeps them separate.
function moveInput(pl) {
    if (pl.id === 1 && gameState === 'lesson' && lesson.phase === 'demo') {
        const k = lesson.demoKeys; // scripted by the lesson
        return { up: k.ArrowUp, down: k.ArrowDown, left: k.ArrowLeft, right: k.ArrowRight };
    }
    const own = pl.id === 1 ? bindings.p1 : bindings.p2;
    const extra = !twoPlayer && pl.id === 1 ? bindings.p2 : null;
    const on = a => held.has(own[a]) || (extra && held.has(extra[a]));
    return { up: on('up'), down: on('down'), left: on('left'), right: on('right') };
}

function isDashInvulnerable(pl = player) {
    return pl.isDashing || pl.dashGrace > 0;
}

function startDash(pl = player) {
    pl.isDashing = true;
    pl.ramDone = false;
    pl.dashTimer = pl.dashDuration;
    pl.dashCooldown = pl.dashCooldownMax;
    if (pl.id === 1 && gameState === 'tutorial') tutorial.dashes++;
    // Store dash direction based on current movement
    pl.dashDirection = { ...pl.direction };
    // If not moving, dash the way the player is facing
    if (pl.dashDirection.x === 0 && pl.dashDirection.y === 0) {
        pl.dashDirection = { x: Math.cos(pl.facing), y: Math.sin(pl.facing) };
    }
    playSound('dash', 0.5, 1.0 + rand() * 0.2);
}

function handleRebindKey(e, code) {
    if (e.key === 'Escape') {
        rebind.active = false;
        return;
    }
    if (!code || e.key === 'Meta' || e.key === 'OS') return;
    const mine = bindings[rebind.who];
    const old = mine[rebind.action];
    // A key can only do one thing: if another action had it, that action gets the old key
    ['p1', 'p2'].forEach(who => ACTIONS.forEach(a => {
        if (bindings[who][a] === code && !(who === rebind.who && a === rebind.action)) bindings[who][a] = old;
    }));
    mine[rebind.action] = code;
    rebind.active = false;
    held.clear();
    saveBindings();
}

function onKeyDown(e) {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const code = normalizeCode(e.code);

    if (rebind.active) {
        handleRebindKey(e, code);
        e.preventDefault();
        return;
    }
    if (handleUiKey(e, key)) return;

    held.add(code);
    if (canControl() && ACTIONS.some(a => bindings.p1[a] === code || bindings.p2[a] === code)) {
        e.preventDefault(); // stop the page scrolling on arrows / space
    }

    // Dash keys (each player has their own)
    if (canControl() && !e.repeat) {
        const scripted = gameState === 'lesson' && lesson.phase === 'demo';
        for (const pl of activePlayers()) {
            const b = pl.id === 1 ? bindings.p1 : bindings.p2;
            if (code === b.dash && !(scripted && pl.id === 1) && !pl.isDashing && pl.dashCooldown <= 0) {
                startDash(pl);
            }
        }
    }
}

function onKeyUp(e) {
    held.delete(normalizeCode(e.code));
}

function onWindowBlur() {
    // Avoid "stuck" movement keys when the window loses focus
    held.clear();
}

function healDelayTicks() {
    return gameMode === '1v1' ? DUEL_HEAL_TICKS : HEAL_DELAY_TICKS;
}

// Update movement / dash / immunity / healing for one player
function updatePlayer(pl = player) {
    const prevX = pl.x;
    const prevY = pl.y;

    // Reset direction, then read this player's input
    pl.direction = { x: 0, y: 0 };
    const k = moveInput(pl);
    if (k.up) pl.direction.y = -1;
    if (k.down) pl.direction.y = 1;
    if (k.left) pl.direction.x = -1;
    if (k.right) pl.direction.x = 1;

    // Scripted dash (lesson demos)
    if (pl.id === 1 && lesson.scriptedDash) {
        lesson.scriptedDash = false;
        if (!pl.isDashing && pl.dashCooldown <= 0) startDash(pl);
    }

    // Remember which way the player is facing (dash direction wins mid-dash)
    const faceDir = pl.isDashing ? pl.dashDirection : pl.direction;
    if (faceDir.x !== 0 || faceDir.y !== 0) {
        pl.facing = Math.atan2(faceDir.y, faceDir.x);
    }

    // Post-dash grace counts down once the dash is over
    if (!pl.isDashing && pl.dashGrace > 0) {
        pl.dashGrace--;
    }

    // Handle dashing
    if (pl.isDashing) {
        pl.x += pl.dashDirection.x * pl.dashSpeed;
        pl.y += pl.dashDirection.y * pl.dashSpeed;

        pl.dashTimer--;
        if (pl.dashTimer <= 0) {
            pl.isDashing = false;
            pl.dashGrace = DASH_GRACE_TICKS; // ~0.1 s extra invulnerability
        }
    } else {
        // Normalize diagonal movement
        if (pl.direction.x !== 0 && pl.direction.y !== 0) {
            pl.direction.x *= 0.7;
            pl.direction.y *= 0.7;
        }
        pl.x += pl.direction.x * pl.speed;
        pl.y += pl.direction.y * pl.speed;
    }

    // Update dash cooldown
    if (pl.dashCooldown > 0) {
        pl.dashCooldown--;
    }

    // Update immunity timer
    if (pl.immunityTimer > 0) {
        pl.immunityTimer--;
        pl.flashTimer = (pl.flashTimer + 1) % (pl.flashRate * 2);
        pl.isVisible = pl.flashTimer < pl.flashRate;

        if (pl.immunityTimer <= 0) {
            pl.isImmune = false;
            pl.isVisible = true;
        }
    }

    // Healing (Normal and 1v1): reward avoiding damage; any hit resets the timer
    // (frozen while the player is camping a wall - see CAMP)
    if ((gameMode === 'normal' || gameMode === '1v1') && !(gameState === 'playing' && pl.camp > CAMP.healBlock)) {
        const delay = healDelayTicks();
        if (pl.noHitTimer < delay) {
            pl.noHitTimer++;
        }
        if (pl.noHitTimer >= delay && pl.hitsRemaining < pl.maxHits) {
            pl.hitsRemaining++;
            pl.noHitTimer = 0; // the next heal needs another clean stretch
            playSound('heal', 0.5, 1.2);
        }
    }

    // Boundary checks
    pl.x = Math.max(0, Math.min(PLAY_W - pl.width, pl.x));
    pl.y = Math.max(0, Math.min(PLAY_H - pl.height, pl.y));
    pl.vx = pl.x - prevX;
    pl.vy = pl.y - prevY;
}

// Player hit handling
function takeHit(damage = 1, pl = player) {
    // Practice / lesson / tutorial: count the hit instead of losing health
    if (!pl.isImmune && isTrainingState()) {
        practice.hits++;
        pl.isImmune = true;
        pl.immunityTimer = 60;
        pl.noHitTimer = 0;
        playSound('hit', 0.7, 1.0 + rand() * 0.2);
        return;
    }
    if (!pl.isImmune && pl.hitsRemaining > 0) {
        pl.hitsRemaining = Math.max(0, pl.hitsRemaining - Math.max(1, damage));
        pl.isImmune = true;
        pl.immunityTimer = pl.immunityDuration;
        pl.noHitTimer = 0; // damage resets the healing timer

        playSound('hit', 0.7, 1.0 + rand() * 0.2);
        checkGameOver();
    }
}

// Central place that decides whether a hit lands.
// `ignoreDash` is used by the big bullet: dashing into it must hurt.
function tryHitPlayer(opts = {}, pl = player) {
    if (pl.isImmune) return false;
    if (!opts.ignoreDash && isDashInvulnerable(pl)) return false;
    takeHit(opts.damage || 1, pl);
    return true;
}

/* ---------- Anti corner-camping: wall pressure ----------
   Standing on a wall (and especially in a corner) fills a per-player meter.
   While it fills: the walls glow and a ring around the ship shows the meter,
   and healing stops. When it is full a Wall Strike fires: a laser (with the
   normal 1 s warning) runs through the camper PARALLEL to their wall, so the
   only way out is inward. Keep camping and strikes repeat faster; in a corner
   the second strike adds a crossing beam. Leaving the walls drains the meter. */

const CAMP = {
    edgeBand: 110, // px from a wall that counts as "on the wall"
    cornerBand: 200, // within this distance of BOTH walls = corner
    fillEdge: 1 / (7 * TICK_RATE), // full after 7 s on a wall
    fillCorner: 1 / (3.5 * TICK_RATE), // full after 3.5 s in a corner
    drain: 1 / (1.5 * TICK_RATE), // empties in 1.5 s away from the walls
    resetTo: 0.5, // after a strike the meter drops to here
    healBlock: 0.5 // no heal progress above this
};

function campZone(pl) {
    const cx = pl.x + pl.width / 2;
    const cy = pl.y + pl.height / 2;
    const dx = Math.min(cx, PLAY_W - cx);
    const dy = Math.min(cy, PLAY_H - cy);
    return {
        cx, cy, dx, dy,
        edge: Math.min(dx, dy) < CAMP.edgeBand,
        corner: dx < CAMP.cornerBand && dy < CAMP.cornerBand,
        vertical: dx < dy // nearest wall is the left / right one
    };
}

function wallStrike(pl, z) {
    // Parallel to the nearest wall, so escaping means moving inward
    const angle = z.vertical ? Math.PI / 2 : 0;
    bulletHell.lasers.push(makeLaser(z.cx, z.cy, angle));
    if (pl.campStrikes >= 1 && z.corner) bulletHell.lasers.push(makeLaser(z.cx, z.cy, angle + Math.PI / 2));
}

function updateCamping(pl) {
    if (gameState !== 'playing') {
        pl.camp = 0;
        return;
    }
    if (pl.hitsRemaining <= 0) return;
    const z = campZone(pl);
    const rate = z.corner ? CAMP.fillCorner : z.edge ? CAMP.fillEdge : -CAMP.drain;
    pl.camp = Math.max(0, pl.camp + rate);
    if (pl.camp === 0) pl.campStrikes = 0;
    if (pl.camp >= 1) {
        wallStrike(pl, z);
        pl.camp = CAMP.resetTo;
        pl.campStrikes++;
    }
}

/* ---------- 1v1: dashing into the other player hurts THE OTHER player ---------- */

let ramCooldown = 0;

function playersOverlap(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function ramDamage(pl) {
    if (pl.hitsRemaining <= 0) return;
    pl.hitsRemaining--; // 1 hp, ignores bullet immunity and dash invulnerability
    pl.noHitTimer = 0;
    pl.isImmune = true;
    pl.immunityTimer = Math.max(pl.immunityTimer, 40);
    playSound('hit', 0.8, 0.8);
}

function checkRam() {
    if (!twoPlayer) return;
    if (ramCooldown > 0) ramCooldown--;
    for (const [a, b] of [[player, player2], [player2, player]]) {
        if (a.isDashing && !a.ramDone && ramCooldown <= 0 && playersOverlap(a, b)) {
            a.ramDone = true; // once per dash
            ramCooldown = 30;
            ramDamage(b); // only the player who was dashed into loses the hp
            checkGameOver();
            return;
        }
    }
}

/* ==========================================================================
   BULLET HELL: PATTERN DEFINITIONS
   ========================================================================== */

// `slots`   = how many of the 6 loader slots the pattern uses
// `cooldown` = ticks before the pattern may be loaded again
// `minTime`  = unlock time in seconds
// Slot costs for the "other patterns" are first-pass tuning values.
const bulletHell = {
    // Legacy spawn-timer fields (superseded by the loader below)
    spawnTimer: 0,
    spawnRate: 10,
    projectiles: [],
    lasers: [],
    sniperWarnings: [],
    bombs: [],
    patterns: [
        // `casts: 2` = the difficulty system may double-cast it (20% at most, and only
        // when half a slot is free). 0 = always a single cast. Triple casting is a
        // Cross-only feature: its three crosses are built into the pattern itself.
        // Basic patterns (available from start)
        { id: 'circle', type: 'circle', label: 'Circle', slots: 1, color: '#4dd2ff', speed: 1.0, amount: 8, cooldown: 200, minTime: 0, casts: 2 },
        { id: 'spread', type: 'spread', label: 'Spread', slots: 1, color: '#ffb347', speed: 1.5, amount: 5, spread: 60, cooldown: 150, minTime: 0, casts: 2 },

        // Unlock after 30 / 45 seconds
        { id: 'spiral', type: 'spiral', label: 'Spiral', slots: 2, color: '#b388ff', speed: 0.7, amount: 16, cooldown: 240, minTime: 30, casts: 0 },
        { id: 'laser', type: 'laser', label: 'Laser', slots: 2, color: '#ff5c5c', cooldown: 220, groupSize: 1, minTime: 45, noScale: true, casts: 2 },

        // Ratio: golden-ratio spiral arms (kept as hard as it was)
        { id: 'ratio', type: 'ratio', label: 'Ratio', slots: 3, color: '#ffd24d', speed: 1.1, amount: 7, arms: 3, cooldown: 420, minTime: 90, noScale: true, casts: 0 },

        // Mid-game
        { id: 'shotgun', type: 'shotgun', label: 'Shotgun', slots: 2, color: '#ff8080', speed: 1.0, amount: 14, spread: 70, cooldown: 260, minTime: 100, casts: 2 },
        { id: 'doubleSpiral', type: 'doubleSpiral', label: 'Double Spiral', slots: 3, color: '#5eead4', speed: 0.6, amount: 20, cooldown: 320, minTime: 120, casts: 2 },
        // Cross fires instantly, three crosses at once (no extra warning)
        { id: 'cross', type: 'cross', label: 'Cross', slots: 1, color: '#ff6b6b', speed: 1.2, amount: 4, cooldown: 220, minTime: 120, instant: true, noMarker: true, noScale: true, casts: 0 },
        { id: 'bigbullet', type: 'bigbullet', label: 'Big Bullet', slots: 3, color: '#ff00ff', speed: 1.5, amount: 1, cooldown: 400, minTime: 120, size: 80, damage: 1, noScale: true, casts: 2 },
        // Rotating distraction bullets (visual only, they never collide)
        { id: 'rotating', type: 'rotating', label: 'Distract', slots: 4, color: '#9aa0b4', isDistract: true, amount: 8, cooldown: 480, boost: 2.5, minTime: 120, orbitRadius: 120, orbitSpeed: 0.05, life: 420, noScale: true, casts: 0 },

        { id: 'wave', type: 'wave', label: 'Sine', slots: 2, color: '#7dd87d', speed: 1.0, amount: 12, cooldown: 280, minTime: 150, casts: 0 },
        // Sniper has its own tracking warning, so no generic one on top of it
        { id: 'sniper', type: 'sniper', label: 'Sniper', slots: 2, color: '#fff0a6', speed: 80, amount: 1, cooldown: 420, warningTime: 90, lockTime: 70, minTime: 150, instant: true, noMarker: true, noScale: true, casts: 2 },

        // After 180 seconds
        { id: 'homing', type: 'homing', label: 'Homing', slots: 2, color: '#ff9900', speed: 0.8, amount: 4, cooldown: 320, minTime: 180, casts: 2 },
        { id: 'bomb', type: 'bomb', label: 'Bomb', slots: 2, color: '#ff3b3b', speed: 2.0, amount: 2, cooldown: 350, minTime: 180, size: 30, damage: 1, noScale: true, casts: 0 },

        { id: 'pulse', type: 'pulse', label: 'Pulse', slots: 2, color: '#f472b6', speed: 1.0, amount: 8, cooldown: 300, minTime: 210, casts: 2 },
        { id: 'laser2', type: 'laser', label: 'Laser x2', slots: 3, color: '#ff5c5c', cooldown: 220, groupSize: 2, minTime: 240, noScale: true, casts: 0 },
        // Anti corner-camp: a saw that rides the edge of the field, two laps, then breaks
        { id: 'sawblade', type: 'sawblade', label: 'Sawblade', slots: 1, color: '#c9d1dc', speed: 3.2, amount: 1, cooldown: 300, minTime: 150, laps: 2, damage: 2, noScale: true, casts: 0 }
    ],
    sparks: [], // sawblade break-up bursts
    impact: null, // white impact frame shown when a sniper fires
    lastPatternTime: 0,
    minTimeBetweenPatterns: 60,
    gameTime: 0, // simulation ticks since the run started
    difficulty: 1.0
};

// Per-pattern runtime fields (reset every run)
function resetPatternRuntime() {
    bulletHell.patterns.forEach(pattern => {
        pattern.readyAt = 0; // tick at which the pattern may be selected again
        pattern.lastFireTick = -9999;
        pattern.lastUsed = -9999; // legacy field
    });
}
resetPatternRuntime();

// Minions (Soulshift leftover, still referenced by the update loop)
const minions = [];

// Projectiles
let projectiles = [];

/* ==========================================================================
   PROJECTILE LOADER (central authority for ALL pattern spawning)
   ========================================================================== */

const loader = {
    batch: [], // entries: { def, id, label, color, slots, plan, fireAt, fired }
    carry: [], // patterns that did not fit and wait for the next 6-slot cycle
    cycleStart: 0,
    cycleLength: LOADER.baseInterval,
    lastPickedId: null
};

function loaderCapacity() {
    if (gameState === 'playing' && gameMode === 'hitless') return HITLESS_CAPACITY;
    if (gameState === 'playing' && gameMode === '1v1') return DUEL_CAPACITY;
    return LOADER.capacity;
}

// Hitless and Custom Practice have every attack unlocked from the start
function unlockAll() {
    return (gameMode === 'hitless' && gameState === 'playing') || gameState === 'practice';
}

// Custom Practice only draws from the patterns the player switched on
function loaderPatterns() {
    return gameState === 'practice'
        ? bulletHell.patterns.filter(d => customSel.has(d.id))
        : bulletHell.patterns;
}

function resetLoader() {
    loader.batch = [];
    loader.carry = [];
    loader.cycleStart = 0;
    loader.cycleLength = LOADER.baseInterval;
    loader.lastPickedId = null;
}

function randomEdgePoint(offset) {
    const edge = Math.floor(rand() * 4);
    switch (edge) {
        case 0: return { edge, x: rand() * PLAY_W, y: -offset }; // top
        case 1: return { edge, x: PLAY_W + offset, y: rand() * PLAY_H }; // right
        case 2: return { edge, x: rand() * PLAY_W, y: PLAY_H + offset }; // bottom
        default: return { edge: 3, x: -offset, y: rand() * PLAY_H }; // left
    }
}

const CENTER_SPAWN_TYPES = ['circle', 'spread', 'wave', 'spiral'];

// Decide WHERE a pattern will spawn at load time so the player can be warned
// (indicator in the gutter / ring in the field) before it fires.
function planPattern(def) {
    switch (def.type) {
        case 'laser':
            return {}; // lasers telegraph themselves
        case 'ratio':
            return { x: PLAY_W / 2, y: PLAY_H / 2 };
        case 'cross': {
            if (rand() < 0.7) return { x: PLAY_W / 2, y: PLAY_H / 2 };
            const margin = 150;
            return {
                x: margin + rand() * (PLAY_W - 2 * margin),
                y: margin + rand() * (PLAY_H - 2 * margin)
            };
        }
        case 'rotating':
            return { spawns: Array.from({ length: def.amount }, () => randomEdgePoint(30)) };
        case 'bomb': {
            // Two bombs from two different edges
            const first = randomEdgePoint(20);
            let second = randomEdgePoint(20);
            while (second.edge === first.edge) second = randomEdgePoint(20);
            return { spawns: [first, second] };
        }
        default:
            if (CENTER_SPAWN_TYPES.includes(def.type) && rand() < 0.3) {
                return { x: PLAY_W / 2, y: PLAY_H / 2 };
            }
            return randomEdgePoint(20);
    }
}

function patternCooldownTicks(def) {
    let cooldown = def.cooldown / (1 + (bulletHell.difficulty - 1) * 0.3);
    if (def.minTime < 60) cooldown *= 0.8; // early patterns come back sooner
    if (gameState === 'practice') cooldown *= 0.5; // more reps in practice
    return cooldown;
}

// Weighted random: patterns that have not been seen for a while are more
// likely, and the same pattern is unlikely to be picked twice in a row. This
// keeps the system learnable while staying random.
function pickWeighted(list, now) {
    const weights = list.map(def => {
        let w = 1 + Math.min(2, Math.max(0, now - def.lastFireTick) / 600);
        if (def.id === loader.lastPickedId) w *= 0.25;
        w *= def.boost || 1;
        return w;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rand() * total;
    for (let i = 0; i < list.length; i++) {
        r -= weights[i];
        if (r <= 0) return list[i];
    }
    return list[list.length - 1];
}

function loadBatch(now) {
    const seconds = now / TICK_RATE;
    const batch = [];
    let used = 0;

    const addEntry = def => {
        // Instant patterns (Cross, Sniper) skip the generic telegraph
        const fireAt = def.instant ? now : now + LOADER.lead + batch.length * LOADER.stagger;
        def.readyAt = fireAt + patternCooldownTicks(def); // cooldown starts at fire time
        // Difficulty system: a double cast costs an extra half slot and is only
        // possible when that half slot is actually free
        const plans = castPlans(def, loaderCapacity() - used - def.slots >= 0.5);
        batch.push({
            def,
            id: def.id,
            label: def.label,
            color: def.color,
            slots: def.slots,
            plan: plans[0],
            plans,
            fireAt,
            fired: false
        });
        used += def.slots + (plans.length > 1 ? 0.5 : 0);
        loader.lastPickedId = def.id;
    };

    // 1) Patterns that did not fit last cycle go first
    const stillWaiting = [];
    for (const def of loader.carry) {
        if (used + def.slots <= loaderCapacity()) addEntry(def);
        else stillWaiting.push(def);
    }
    loader.carry = stillWaiting.slice(0, LOADER.maxCarry);

    // 2) Fill the remaining slots with random eligible patterns
    const rejected = new Set();
    let guard = 0;
    while (used < loaderCapacity() && guard++ < 16) {
        const fireAt = now + LOADER.lead + batch.length * LOADER.stagger;
        const eligible = loaderPatterns().filter(def =>
            (unlockAll() || seconds >= def.minTime) && // unlocked (all in hitless / practice)
            def.readyAt <= fireAt && // not on cooldown
            !rejected.has(def) &&
            !loader.carry.includes(def)
        );
        if (eligible.length === 0) break;

        const def = pickWeighted(eligible, now);
        if (used + def.slots > loaderCapacity()) {
            // Does not fit: queue it for the next 6-slot cycle
            rejected.add(def);
            if (loader.carry.length < LOADER.maxCarry) loader.carry.push(def);
            continue;
        }
        addEntry(def);
    }

    loader.batch = batch;
    loader.cycleStart = now;
    if (batch.length === 0) {
        loader.cycleLength = LOADER.minInterval;
    } else if (batch.some(e => e.def.isDistract)) {
        loader.cycleLength = LOADER.distractInterval; // distraction => 7 s cycle
    } else {
        loader.cycleLength = LOADER.baseInterval;
    }

    if (DEBUG) {
        console.log('[loader] batch', batch.map(e => `${e.label}(${e.slots})`).join(', '),
            'carry', loader.carry.map(d => d.label).join(', '));
    }
}

/* ---------- Difficulty: progressive double / triple casting ----------
   Separate from cooldowns and from the scheduler: the scheduler decides WHICH
   pattern is loaded; this only decides how many instances of it are cast. */

function castChances() {
    if (gameState !== 'playing') return { dbl: 0 }; // practice / lessons: none
    if (gameMode === 'hitless') return { dbl: 0.2 }; // hitless: no scaling, fixed 20%
    const t = bulletHell.gameTime / TICK_RATE; // survival time (simulation seconds)
    return { dbl: Math.min(1, Math.max(0, (t - 30) / 270)) * 0.2 }; // 0% at 30 s -> 20% (the cap) at 5 min
}

// A double cast needs `canDouble` (half a free slot in the queue)
function castCount(def, canDouble) {
    if (!def.casts || !canDouble) return 1;
    return rand() < castChances().dbl ? 2 : 1;
}

// A different origin for an extra cast so instances never stack on one point
function variantPlan(def, existing) {
    const far = (p, o) => Math.hypot(p.x - o.x, p.y - o.y) > 170;
    for (let tries = 0; tries < 10; tries++) {
        let plan;
        if (def.type === 'ratio') plan = { x: 130 + rand() * (PLAY_W - 260), y: 130 + rand() * (PLAY_H - 260) };
        else plan = planPattern(def);
        const clash = existing.some(o => (o.edge !== undefined && o.edge === plan.edge) ||
            (o.x !== undefined && plan.x !== undefined && o.edge === undefined && plan.edge === undefined && !far(plan, o)));
        if (!clash || tries === 9) return plan;
    }
    return planPattern(def);
}

function castPlans(def, canDouble = false) {
    const plans = [planPattern(def)];
    const n = castCount(def, canDouble);
    for (let k = 1; k < n; k++) plans.push(variantPlan(def, plans));
    return plans;
}

/* ---------- Practice: random selector (no cooldowns, repeats allowed) ---------- */

const PRACTICE_STAGGER = 6;

function loadPracticeBatch(now) {
    const pool = bulletHell.patterns.filter(d => customSel.has(d.id));
    const batch = [];
    if (pool.length) {
        const picks = 1 + Math.floor(rand() * 4); // 1-4 patterns in one attack
        for (let i = 0; i < picks; i++) {
            const def = pool[Math.floor(rand() * pool.length)]; // repeats allowed
            const plan = planPattern(def);
            batch.push({
                def, id: def.id, label: def.label, color: def.color, slots: def.slots,
                plan, plans: [plan],
                fireAt: now + (def.instant ? 0 : LOADER.lead) + i * PRACTICE_STAGGER,
                fired: false
            });
        }
    }
    loader.batch = batch;
    loader.cycleStart = now;
    if (batch.length === 0) loader.cycleLength = LOADER.minInterval;
    else if (batch.some(e => e.def.isDistract)) loader.cycleLength = LOADER.distractInterval;
    else loader.cycleLength = 210;
}

function scalePattern(def) {
    const d = bulletHell.difficulty;
    const scaled = { ...def, speed: def.speed ? def.speed * (1 + (d - 1) * 0.08) : def.speed };
    if (!def.noScale && def.amount > 1) {
        const cap = def.type === 'doubleSpiral' ? 12 : 14;
        scaled.amount = Math.min(
            Math.ceil(def.amount * (1 + (d - 1) * 0.2)),
            Math.max(def.amount, cap)
        );
    }
    return scaled;
}

function fireEntry(entry, now) {
    entry.fired = true;
    entry.def.lastFireTick = now;
    entry.def.lastUsed = now; // legacy field
    bulletHell.lastPatternTime = now;
    const scaled = scalePattern(entry.def);
    // One instance per planned cast; each has its own origin / angle
    (entry.plans || [entry.plan]).forEach(plan => {
        projectiles.push(...createBulletPattern(scaled, plan));
    });
}

function updateLoader(autoLoad = true) {
    const now = bulletHell.gameTime;

    // Fire patterns whose telegraph time has elapsed
    for (const entry of loader.batch) {
        if (entry.fired || now < entry.fireAt) continue;
        if (projectiles.length >= LOADER.bulletSoftCap) {
            entry.fireAt = now + 12; // too cluttered right now, wait a moment
            continue;
        }
        fireEntry(entry, now);
    }

    // Lessons and the tutorial queue their own attacks; only runs and Custom
    // Practice load batches automatically
    if (!autoLoad) return;

    // Load the next batch: after the interval, or early once everything is gone
    const elapsed = now - loader.cycleStart;
    const allFired = loader.batch.every(e => e.fired);
    const fieldClear = projectiles.length === 0 &&
        bulletHell.lasers.length === 0 &&
        bulletHell.sniperWarnings.length === 0;

    if (elapsed >= loader.cycleLength ||
        (allFired && fieldClear && elapsed >= LOADER.minInterval)) {
        if (gameState === 'practice') loadPracticeBatch(now);
        else loadBatch(now);
    }
}

/* ==========================================================================
   PROJECTILE CREATION
   ========================================================================== */

/* ---------- Visual identity: per-pattern glow, trails and afterimages ----------
   glow  = [halo radius multiplier, halo alpha]   (only signature bullets; cheap additive halo)
   trail = number of recorded positions in the bullet's trail
   ghost = leaves a faint, slowly fading imprint on the arena                    */
const FX = {
    // Plain bullets: trail only, no glow
    circle: { trail: 7 },
    spread: { trail: 7 },
    spiral: { trail: 8 },
    doubleSpiral: { trail: 9 },
    shotgun: { trail: 6 },
    cross: { trail: 8 },
    // Signature bullets keep their own glow
    ratio: { glow: [3.4, 0.38], trail: 10, ghost: true, ghostEvery: 6 },
    bigbullet: { glow: [1.5, 0.22], trail: 14, ghost: true, ghostEvery: 5 },
    wave: { glow: [2.4, 0.30], trail: 10 },
    homing: { glow: [3.4, 0.40], trail: 12, ghost: true, ghostEvery: 5 },
    pulse: { glow: [2.8, 0.32], trail: 6 },
    bomb: { glow: [1.9, 0.30], trail: 8, ghost: true, ghostEvery: 6 }
};

const pops = []; // small ring flashes when a Distract dot is deleted by the wall
const ghosts = []; // short-lived historical imprints (player + special bullets)
const GHOST_LIFE = 90;
const GHOST_MAX = 360;
let ghostClock = 0;

function stampGhost(x, y, r, color, shape, angle) {
    if (ghosts.length >= GHOST_MAX) ghosts.shift();
    ghosts.push({ x, y, r, color, shape, angle, age: 0 });
}

function updateGhosts() {
    for (let i = pops.length - 1; i >= 0; i--) {
        if (++pops[i].age >= 16) pops.splice(i, 1);
    }
    for (let i = ghosts.length - 1; i >= 0; i--) {
        if (++ghosts[i].age >= GHOST_LIFE) ghosts.splice(i, 1);
    }
    ghostClock++;
    if (ghostClock % 3 === 0) {
        for (const pl of activePlayers()) {
            const cx = pl.x + pl.width / 2;
            const cy = pl.y + pl.height / 2;
            if (Math.hypot(cx - (pl.ghostX || 0), cy - (pl.ghostY || 0)) > 3) {
                stampGhost(cx, cy, pl.width / 2, pl.ghostColor, 'tri', pl.facing);
                pl.ghostX = cx;
                pl.ghostY = cy;
            }
        }
    }
    for (const p of projectiles) {
        if (p.ghost && !p.dead && (ghostClock + (p.ghostPhase || 0)) % (p.ghostEvery || 5) === 0) {
            stampGhost(p.x + p.width / 2, p.y + p.height / 2, Math.max(p.width, p.height) / 2, p.color, 'dot', 0);
        }
    }
}

function recordTrail(p) {
    if (!p.trailLen) return;
    const t = p.trail || (p.trail = []);
    t.push(p.x + p.width / 2, p.y + p.height / 2);
    if (t.length > p.trailLen * 2) t.splice(0, 2);
}

function makeMover(x, y, size, angle, speed, color, acceleration, extra) {
    return {
        x,
        y,
        width: size * ENTITY_SCALE,
        height: size * ENTITY_SCALE,
        speed,
        baseSpeed: speed,
        damage: 1,
        isPlayerProjectile: false,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        color,
        acceleration,
        ...extra
    };
}

// Create bullets for one pattern. `plan` was decided when the pattern was loaded.
// One laser: a red outline for 1 s, then a beam for half a second
function makeLaser(x, y, angle) {
    return {
        x,
        y,
        width: LASER_LENGTH, // stretches across the whole screen
        height: 45 * ENTITY_SCALE,
        isWarning: true,
        warningTime: 60, // 1 second warning
        activeTime: 30, // 0.5 seconds active
        timer: 0,
        damage: 2,
        isPlayerProjectile: false,
        angle,
        trails: [],
        trailLifetime: 40
    };
}

function createBulletPattern(pattern, plan = {}) {
    const bullets = [];
    const x = plan.x !== undefined ? plan.x : PLAY_W / 2;
    const y = plan.y !== undefined ? plan.y : PLAY_H / 2;
    const angleIncrement = TAU / (pattern.amount || 1);
    const now = bulletHell.gameTime;
    const tgt = pickTarget(); // who aimed attacks go after
    const tcx = tgt.x + tgt.width / 2;
    const tcy = tgt.y + tgt.height / 2;

    if (DEBUG) {
        console.log(`[DEBUG] Spawning pattern: ${pattern.type}`, { x: x.toFixed(0), y: y.toFixed(0) });
    }

    switch (pattern.type) {
        case 'sniper': {
            // Tracks the player, then locks (see updateBulletHell) and fires along the locked line
            bulletHell.sniperWarnings.push({
                x,
                y,
                angle: Math.atan2(tcy - y, tcx - x),
                target: tgt,
                timer: 0,
                warningTime: pattern.warningTime || 90,
                lockTime: pattern.lockTime || 70,
                locked: false,
                shotSpeed: pattern.speed || 80
            });
            break;
        }

        case 'circle':
            for (let i = 0; i < pattern.amount; i++) {
                const speed = pattern.speed * (0.8 + rand() * 0.4);
                bullets.push(makeMover(x, y, 6, angleIncrement * i, speed,
                    `hsl(${rand() * 60 + 180}, 100%, 60%)`, 1.01));
            }
            break;

        case 'spiral': {
            // Four curving arms. The head bullet of each arm flies straight; the ones
            // behind it are slower and bend a little more each, so the arms look like
            // they are spinning (unlike Circle's straight rays).
            const arms = 4;
            const perArm = Math.max(1, Math.round(pattern.amount / arms));
            const offset = rand() * TAU;
            for (let a = 0; a < arms; a++) {
                const armAngle = offset + (a * TAU) / arms;
                for (let k = 0; k < perArm; k++) {
                    const speed = pattern.speed * (1.15 - 0.2 * k) * (0.95 + rand() * 0.1);
                    const r = k * 12;
                    bullets.push(makeMover(x + Math.cos(armAngle) * r, y + Math.sin(armAngle) * r, 5, armAngle, speed,
                        `hsl(${(a * 90 + k * 12) % 360}, 100%, 65%)`, 1.01, { turn: 0.004 * k }));
                }
            }
            break;
        }

        case 'doubleSpiral': {
            // Dense wall: two interleaved spirals, 12 rays each, several bullets per ray
            const spiralOffset = rand() * TAU;
            const step = TAU / 12;
            for (let i = 0; i < pattern.amount; i++) {
                const angle1 = step * i * 1.2 + spiralOffset;
                const angle2 = step * i * 1.2 - spiralOffset;
                const speed1 = pattern.speed * (0.8 + rand() * 0.4);
                const speed2 = pattern.speed * (0.8 + rand() * 0.4);
                bullets.push(makeMover(x, y, 5, angle1, speed1, 'hsl(180, 100%, 60%)', 1.005));
                // Second spiral (rotated 180 degrees)
                bullets.push(makeMover(x, y, 5, angle2 + Math.PI, speed2, 'hsl(330, 100%, 65%)', 1.005));
            }
            break;
        }

        case 'spread': {
            // Fan is aimed from the spawn point toward the middle of the field
            // so edge spawns actually enter the arena.
            const aim = Math.atan2(PLAY_H / 2 - y, PLAY_W / 2 - x);
            const startAngle = aim - (pattern.spread * Math.PI / 180) / 2;
            const angleStep = (pattern.spread * Math.PI / 180) / (pattern.amount - 1);
            for (let i = 0; i < pattern.amount; i++) {
                const speed = pattern.speed * (0.9 + rand() * 0.2);
                bullets.push(makeMover(x, y, 6, startAngle + angleStep * i, speed,
                    `hsl(${30 + (i * 10) % 60}, 100%, 60%)`, 1.01));
            }
            break;
        }

        case 'laser': {
            // Warning first (red outline), then the beam
            const groupSize = pattern.groupSize || 1;
            for (let g = 0; g < groupSize; g++) {
                const lx = PLAY_W / 2 + (rand() - 0.5) * 200;
                const ly = PLAY_H / 2 + (rand() - 0.5) * 200;
                const laser = makeLaser(lx, ly, rand() * TAU);
                // For multiple lasers, space them out by angle
                if (groupSize > 1) {
                    laser.angle = (TAU * g) / groupSize;
                }
                bulletHell.lasers.push(laser);
            }
            break;
        }

        case 'sawblade': {
            // Starts at a random point on the edge and runs the full perimeter
            // `laps` times, then breaks apart. It is aimed at corners, so a
            // corner camper must leave the corner or take the hit.
            const perim = 2 * (PLAY_W + PLAY_H);
            const start = rand() * perim;
            const dir = rand() < 0.5 ? 1 : -1;
            const saw = {
                x: 0,
                y: 0,
                width: 22 * ENTITY_SCALE,
                height: 22 * ENTITY_SCALE,
                damage: pattern.damage || 2,
                round: true,
                isPlayerProjectile: false,
                isSawblade: true,
                color: '#c9d1dc',
                saw: { along: start, dir, travelled: 0, total: perim * (pattern.laps || 2), speed: pattern.speed, spin: 0 },
                lifetime: 100000,
                update: function () {
                    const w = this.saw;
                    w.along += w.dir * w.speed;
                    w.travelled += w.speed;
                    w.spin += 0.35;
                    const p = ((w.along % perim) + perim) % perim;
                    let px, py;
                    if (p < PLAY_W) { px = p; py = 0; }
                    else if (p < PLAY_W + PLAY_H) { px = PLAY_W; py = p - PLAY_W; }
                    else if (p < 2 * PLAY_W + PLAY_H) { px = PLAY_W - (p - PLAY_W - PLAY_H); py = PLAY_H; }
                    else { px = 0; py = PLAY_H - (p - 2 * PLAY_W - PLAY_H); }
                    this.x = Math.max(0, Math.min(PLAY_W, px)) - this.width / 2;
                    this.y = Math.max(0, Math.min(PLAY_H, py)) - this.height / 2;
                    this.vx = 0;
                    this.vy = 0;
                    if (w.travelled >= w.total) {
                        // breaks apart into a short burst of sparks after its second lap
                        this.dead = true;
                        bulletHell.sparks.push({ x: this.x + this.width / 2, y: this.y + this.height / 2, age: 0 });
                    }
                }
            };
            bullets.push(saw);
            break;
        }

        case 'bomb': {
            const base = pattern.speed * 0.5;
            const spawns = plan.spawns || [randomEdgePoint(20), randomEdgePoint(20)];
            spawns.forEach(spawn => {
            let bombVx = 0;
            let bombVy = 0;
            switch (spawn.edge) {
                case 0: bombVx = (rand() - 0.5) * 2; bombVy = base; break; // top
                case 1: bombVx = -base; bombVy = (rand() - 0.5) * 2; break; // right
                case 2: bombVx = (rand() - 0.5) * 2; bombVy = -base; break; // bottom
                default: bombVx = base; bombVy = (rand() - 0.5) * 2; break; // left
            }
            bullets.push({
                x: spawn.x,
                y: spawn.y,
                width: pattern.size * ENTITY_SCALE,
                height: pattern.size * ENTITY_SCALE,
                speed: pattern.speed,
                vx: bombVx,
                vy: bombVy,
                damage: pattern.damage,
                type: 'bomb',
                round: true,
                isPlayerProjectile: false,
                color: '#ff0000',
                lifetime: 120, // 2 seconds
                explosionRadius: 100,
                flashTimer: 0,
                flashInterval: 10,
                originalColor: '#ff0000',
                explosionParticles: [],
                hasExploded: false
            });
            });
            break;
        }

        case 'pulse': {
            // Breathing ring: neighbours pulse in opposition so gaps open and
            // close. Small = cyan (safe-ish), large = red (a wall).
            const period = 72; // 1.2 s breathing cycle
            const offset = rand() * TAU;
            for (let i = 0; i < pattern.amount; i++) {
                const angle = offset + (TAU * i) / pattern.amount;
                const bullet = {
                    x,
                    y,
                    cx: x,
                    cy: y,
                    width: 5 * ENTITY_SCALE,
                    height: 5 * ENTITY_SCALE,
                    vx: Math.cos(angle) * pattern.speed,
                    vy: Math.sin(angle) * pattern.speed,
                    speed: pattern.speed,
                    damage: 1,
                    isPlayerProjectile: false,
                    round: true,
                    pulse: true,
                    minSize: 5 * ENTITY_SCALE,
                    maxSize: 28 * ENTITY_SCALE,
                    pulsePeriod: period,
                    pulsePhase: (i % 2) * Math.PI,
                    age: 0,
                    color: '#4dd2ff',
                    update: function () {
                        this.age++;
                        const t = (Math.sin((TAU * this.age) / this.pulsePeriod + this.pulsePhase) + 1) / 2;
                        const size = this.minSize + (this.maxSize - this.minSize) * t;
                        this.width = size;
                        this.height = size;
                        this.cx += this.vx;
                        this.cy += this.vy;
                        this.x = this.cx - size / 2;
                        this.y = this.cy - size / 2;
                        this.color = `hsl(${190 + 170 * t}, 100%, 60%)`;
                    }
                };
                bullets.push(bullet);
            }
            break;
        }

        case 'ratio': {
            // Golden spiral: r = R0 * PHI^(2*theta/PI), i.e. the radius grows
            // by PHI every quarter turn. Bullets are laid out along each arm at
            // golden spacing and then slide outward along the same curve.
            const R0 = 36;
            const B = (2 * Math.log(PHI)) / Math.PI; // dr/dtheta = B * r
            const arms = pattern.arms || 3;
            const baseRotation = rand() * TAU;
            const spin = rand() < 0.5 ? 1 : -1;
            for (let a = 0; a < arms; a++) {
                const armAngle = baseRotation + (TAU * a) / arms;
                for (let k = 0; k < pattern.amount; k++) {
                    const r = R0 * Math.pow(PHI, k / 2);
                    bullets.push({
                        x,
                        y,
                        width: 7 * ENTITY_SCALE,
                        height: 7 * ENTITY_SCALE,
                        speed: pattern.speed,
                        damage: 1,
                        isPlayerProjectile: false,
                        round: true,
                        color: `hsl(${48 - k * 2}, 100%, ${62 + (k % 2) * 6}%)`,
                        ratio: { cx: x, cy: y, r, armAngle, spin, dr: pattern.speed },
                        update: function () {
                            const q = this.ratio;
                            q.r += q.dr;
                            const ang = q.armAngle + q.spin * (Math.log(q.r / R0) / B);
                            this.x = q.cx + Math.cos(ang) * q.r - this.width / 2;
                            this.y = q.cy + Math.sin(ang) * q.r - this.height / 2;
                        }
                    });
                }
            }
            break;
        }

        case 'cross': {
            // Three crosses at once from different places, each with one arm aimed
            // at the target. Never spawns on top of any player.
            const others = activePlayers();
            const clearOfPlayers = (ox, oy) => others.every(pl => Math.hypot(ox - (pl.x + pl.width / 2), oy - (pl.y + pl.height / 2)) >= 170);
            const origins = [];
            for (let tries = 0; tries < 120 && origins.length < 3; tries++) {
                const ox = 100 + rand() * (PLAY_W - 200);
                const oy = 100 + rand() * (PLAY_H - 200);
                if (!clearOfPlayers(ox, oy)) continue;
                if (origins.some(o => Math.hypot(o.x - ox, o.y - oy) < 170)) continue;
                origins.push({ x: ox, y: oy });
            }
            const corners = [{ x: 90, y: 90 }, { x: PLAY_W - 90, y: 90 }, { x: 90, y: PLAY_H - 90 }, { x: PLAY_W - 90, y: PLAY_H - 90 }];
            for (let c = 0; origins.length < 3 && c < corners.length; c++) {
                if (clearOfPlayers(corners[c].x, corners[c].y)) origins.push(corners[c]);
            }
            origins.forEach(o => {
                const aim = Math.atan2(tcy - o.y, tcx - o.x);
                for (let i = 0; i < 4; i++) {
                    const speed = pattern.speed * (0.9 + rand() * 0.2);
                    bullets.push(makeMover(o.x, o.y, 7, aim + (i * Math.PI) / 2, speed, '#ff4444', 1.02));
                }
            });
            break;
        }

        case 'wave': {
            // "Sine": big bullets that swerve hard and unpredictably while bending
            // toward the player's position, so they converge around you. Dashing
            // straight into the swarm runs into the converging paths.
            const waveBase = pattern.speed * 1.5;
            for (let i = 0; i < pattern.amount; i++) {
                const baseAngle = (i / pattern.amount) * TAU + (rand() - 0.5) * 0.3;
                const speed = waveBase * (0.85 + rand() * 0.3);
                const size = (9 + rand() * 4) * ENTITY_SCALE;
                bullets.push({
                    x,
                    y,
                    width: size,
                    height: size,
                    speed,
                    baseSpeed: speed,
                    damage: 1,
                    isPlayerProjectile: false,
                    vx: 0,
                    vy: 0,
                    round: true,
                    lifetime: 360, // they home gently, so they must not live forever
                    target: tgt,
                    color: `hsl(${(i * 360 / pattern.amount + now * 0.6) % 360}, 100%, 60%)`,
                    wave: {
                        heading: baseAngle,
                        phase: rand() * TAU,
                        omega: 0.05 + rand() * 0.07,
                        amp: 3.2 + rand() * 2.6,
                        age: 0
                    },
                    update: function () {
                        const w = this.wave;
                        w.age++;
                        // Re-roll the swing now and then so the path is hard to read
                        if (w.age % 50 === 0) {
                            w.omega = 0.05 + rand() * 0.07;
                            w.phase += (rand() - 0.5) * 2;
                        }
                        // Bend the overall heading toward the player after a short delay
                        if (w.age > 30) {
                            const tp = this.target || player;
                            const toPlayer = Math.atan2(
                                tp.y + tp.height / 2 - (this.y + this.height / 2),
                                tp.x + tp.width / 2 - (this.x + this.width / 2)
                            );
                            const diff = Math.atan2(Math.sin(toPlayer - w.heading), Math.cos(toPlayer - w.heading));
                            w.heading += diff * 0.018;
                        }
                        const swing = Math.sin(w.age * w.omega + w.phase) * w.amp;
                        const perp = w.heading + Math.PI / 2;
                        this.vx = Math.cos(w.heading) * this.speed + Math.cos(perp) * swing;
                        this.vy = Math.sin(w.heading) * this.speed + Math.sin(perp) * swing;
                        this.x += this.vx;
                        this.y += this.vy;
                    }
                });
            }
            break;
        }

        case 'homing':
            for (let i = 0; i < pattern.amount; i++) {
                const speed = pattern.speed * (0.9 + rand() * 0.2);
                bullets.push(makeMover(x, y, 7, (TAU * i) / pattern.amount, speed, '#ff9900', 1.01, {
                    homing: true,
                    target: tgt,
                    homingStrength: 0.05,
                    maxHomingSpeed: 3.0
                }));
            }
            break;

        case 'shotgun': {
            // Uncontrolled bullet spray aimed at the player
            const aim = Math.atan2(tcy - y, tcx - x);
            for (let i = 0; i < pattern.amount; i++) {
                const spreadAngle = (rand() - 0.5) * (pattern.spread * Math.PI / 180);
                const speed = pattern.speed * (0.7 + rand() * 0.6);
                bullets.push(makeMover(x, y, 5, aim + spreadAngle, speed, '#ff6666', 1.02));
            }
            break;
        }

        case 'bigbullet': {
            // Single big bullet toward the player (with slight randomness)
            const aim = Math.atan2(tcy - y, tcx - x) +
                (rand() - 0.5) * 0.4;
            const speed = pattern.speed * (0.8 + rand() * 0.4);
            bullets.push(makeMover(x, y, pattern.size, aim, speed, '#FF00FF', 1.005, {
                isBigBullet: true,
                round: true,
                hasHit: false
            }));
            break;
        }

        case 'rotating': {
            // Visual-only bullets that enter from offscreen and orbit the player
            for (let i = 0; i < pattern.amount; i++) {
                const spawn = (plan.spawns && plan.spawns[i]) || randomEdgePoint(30);
                const orbitRadius = pattern.orbitRadius + (rand() - 0.5) * 40;
                const orbitSpeed = pattern.orbitSpeed * (0.8 + rand() * 0.4);
                const entryAngle = Math.atan2(tcy - spawn.y, tcx - spawn.x);
                bullets.push({
                    x: spawn.x,
                    y: spawn.y,
                    width: 9 * ENTITY_SCALE,
                    height: 9 * ENTITY_SCALE,
                    damage: 1,
                    isPlayerProjectile: false,
                    color: `hsl(${rand() * 360}, 100%, 60%)`,
                    isDistraction: true,
                    trailLen: 16,
                    rotating: true,
                    state: 'entering',
                    life: pattern.life || 420, // 7 s of orbiting at most, then it fades away
                    entryAngle,
                    entrySpeed: 4 + rand() * 1.5,
                    target: tgt,
                    orbitCenterX: tcx,
                    orbitCenterY: tcy,
                    orbitRadius,
                    orbitAngle: entryAngle + (rand() - 0.5) * 0.5,
                    orbitSpeed,
                    colorChangeSpeed: 0.02 + rand() * 0.03,
                    colorHue: rand() * 360
                });
            }
            break;
        }

        default:
            // Handle unexpected pattern types
            break;
    }

    const fx = FX[pattern.type];
    if (fx) {
        bullets.forEach((b, i) => {
            b.glow = fx.glow;
            b.trailLen = fx.trail;
            if (fx.ghost) {
                b.ghost = true;
                b.ghostEvery = fx.ghostEvery;
                b.ghostPhase = i;
            }
        });
    }

    return bullets;
}

/* ==========================================================================
   UPDATE: BULLET HELL (loader, sniper warnings, lasers)
   ========================================================================== */

function updateBulletHell() {
    bulletHell.gameTime += 1;
    const gameTimeInSeconds = bulletHell.gameTime / TICK_RATE;
    // Hitless has no scaling: difficulty stays at 1
    bulletHell.difficulty = gameState !== 'playing' || gameMode === 'hitless'
        ? 1.0
        : 1.0 + Math.min(gameTimeInSeconds / 240, 1.0);

    // The loader is the ONLY thing that spawns patterns
    updateLoader(gameState === 'playing' || gameState === 'practice');

    // White impact frame countdown
    if (bulletHell.impact) {
        bulletHell.impact.timer++;
        if (bulletHell.impact.timer >= bulletHell.impact.duration) bulletHell.impact = null;
    }

    // Sawblade break-up sparks (visual only)
    for (let i = bulletHell.sparks.length - 1; i >= 0; i--) {
        if (++bulletHell.sparks[i].age >= 24) bulletHell.sparks.splice(i, 1);
    }

    // Sniper warnings: track the player, lock the aim a moment before firing
    // (slightly ahead of where the player is heading, so a last-second walk
    // sideways does not work), flash the locked line, then shoot along it.
    for (let i = bulletHell.sniperWarnings.length - 1; i >= 0; i--) {
        const warning = bulletHell.sniperWarnings[i];
        warning.timer += 1;
        const sTarget = warning.target || player;
        const pcx = sTarget.x + sTarget.width / 2;
        const pcy = sTarget.y + sTarget.height / 2;

        if (!warning.locked) {
            if (warning.timer >= warning.lockTime) {
                const lead = warning.warningTime - warning.lockTime + 4;
                const vx = sTarget.isDashing ? 0 : sTarget.vx;
                const vy = sTarget.isDashing ? 0 : sTarget.vy;
                const tx = Math.max(0, Math.min(PLAY_W, pcx + vx * lead));
                const ty = Math.max(0, Math.min(PLAY_H, pcy + vy * lead));
                warning.angle = Math.atan2(ty - warning.y, tx - warning.x);
                warning.locked = true;
            } else {
                warning.angle = Math.atan2(pcy - warning.y, pcx - warning.x);
            }
        }

        if (warning.timer >= warning.warningTime) {
            projectiles.push({
                x: warning.x,
                y: warning.y,
                width: 18 * ENTITY_SCALE,
                height: 8 * ENTITY_SCALE,
                speed: warning.shotSpeed,
                vx: Math.cos(warning.angle) * warning.shotSpeed,
                vy: Math.sin(warning.angle) * warning.shotSpeed,
                damage: 2,
                isPlayerProjectile: false,
                isSniperShot: true,
                color: '#fff0a6',
                glow: [2.2, 0.35],
                trailLen: 14,
                ghost: true,
                ghostEvery: 3
            });
            bulletHell.impact = {
                timer: 0,
                duration: 10,
                x: warning.x,
                y: warning.y,
                angle: warning.angle
            };
            playSound('explosion', 0.35, 1.6);
            bulletHell.sniperWarnings.splice(i, 1);
        }
    }

    // Update lasers
    for (let i = bulletHell.lasers.length - 1; i >= 0; i--) {
        const laser = bulletHell.lasers[i];
        laser.timer++;

        if (laser.isWarning && laser.timer >= laser.warningTime) {
            laser.isWarning = false;
            laser.timer = 0;
        } else if (!laser.isWarning && laser.timer >= laser.activeTime) {
            bulletHell.lasers.splice(i, 1);
            continue;
        }

        // Collision with the player when active
        if (!laser.isWarning) {
            for (const pl of activePlayers()) {
                if (isDashInvulnerable(pl) || pl.isImmune) continue;
                const dx = pl.x + pl.width / 2 - laser.x;
                const dy = pl.y + pl.height / 2 - laser.y;
                const cos = Math.cos(-laser.angle);
                const sin = Math.sin(-laser.angle);
                const localX = dx * cos - dy * sin;
                const localY = dx * sin + dy * cos;

                if (Math.abs(localX) < laser.width / 2 && Math.abs(localY) < laser.height / 2) {
                    tryHitPlayer({ damage: laser.damage }, pl);
                }
            }
        }

        // Lasting red trail (sampled, so it stays light and readable)
        if (!laser.isWarning && laser.timer % 3 === 0) {
            laser.trails.push({
                x: laser.x,
                y: laser.y,
                width: laser.width,
                height: laser.height,
                angle: laser.angle,
                life: laser.trailLifetime
            });
        }
        for (let t = laser.trails.length - 1; t >= 0; t--) {
            laser.trails[t].life--;
            if (laser.trails[t].life <= 0) laser.trails.splice(t, 1);
        }
    }
}

/* ==========================================================================
   UPDATE: PROJECTILES
   ========================================================================== */

// Circle-vs-rectangle for round bullets, rectangle-vs-rectangle otherwise
function overlapsPlayer(p, pl = player) {
    if (p.round) {
        const r = Math.min(p.width, p.height) / 2;
        const cx = p.x + p.width / 2;
        const cy = p.y + p.height / 2;
        const nx = Math.max(pl.x, Math.min(cx, pl.x + pl.width));
        const ny = Math.max(pl.y, Math.min(cy, pl.y + pl.height));
        const dx = cx - nx;
        const dy = cy - ny;
        return dx * dx + dy * dy < r * r;
    }
    return p.x < pl.x + pl.width && p.x + p.width > pl.x &&
        p.y < pl.y + pl.height && p.y + p.height > pl.y;
}

// Returns true when the bullet was consumed by the contact
function handleContact(p) {
    if (p.dead || p.isPlayerProjectile || p.hasExploded) return false;
    for (const pl of activePlayers()) {
        if (!overlapsPlayer(p, pl)) continue;

        if (p.isBigBullet) {
            // Dashing into the big bullet hurts, and the bullet is never destroyed
            // by touching a player. It can hit each player once.
            p.hitIds = p.hitIds || {};
            if (!p.hitIds[pl.id]) {
                p.hitIds[pl.id] = true;
                tryHitPlayer({ ignoreDash: true, damage: p.damage }, pl);
            }
            continue;
        }

        tryHitPlayer({ damage: p.damage }, pl);
        p.dead = true;
        return true;
    }
    return false;
}

function explodeBomb(p) {
    p.hasExploded = true;
    const at = { x: p.x + p.width / 2, y: p.y + p.height / 2 };

    // Ring of exactly 8 bullets, one per compass direction (N, NE, E, SE, S, SW, W, NW)
    const bullets = createBulletPattern({ type: 'circle', amount: 8, speed: 3.0 }, at);
    bullets.forEach(bullet => {
        bullet.acceleration = 1.01;
    });
    // ...then a Sine burst of 4 bullets that wall the player off as they curve in
    bullets.push(...createBulletPattern({ type: 'wave', amount: 4, speed: 1.0 }, at));
    projectiles.push(...bullets);

    // Explosion particles
    for (let i = 0; i < 50; i++) {
        p.explosionParticles.push({
            x: at.x,
            y: at.y,
            vx: (rand() - 0.5) * 8,
            vy: (rand() - 0.5) * 8,
            size: rand() * 8 + 2,
            color: ['#ff0000', '#ff5500', '#ffaa00', '#ffff00'][Math.floor(rand() * 4)],
            lifetime: 30 + rand() * 30
        });
    }

    // Short delay before removing the bomb to show particles
    p.lifetime = 30;
    playSound('explosion', 0.5, 1.0);
}

function updateRotating(p) {
    // Orbit center follows the player
    const orbitTarget = p.target || player;
    p.orbitCenterX = orbitTarget.x + orbitTarget.width / 2;
    p.orbitCenterY = orbitTarget.y + orbitTarget.height / 2;

    p.colorHue = (p.colorHue + p.colorChangeSpeed) % 360;
    p.color = `hsl(${p.colorHue}, 100%, 60%)`;

    if (p.state === 'entering') {
        p.x += Math.cos(p.entryAngle) * p.entrySpeed;
        p.y += Math.sin(p.entryAngle) * p.entrySpeed;

        const dist = Math.hypot(p.x - p.orbitCenterX, p.y - p.orbitCenterY);
        if (dist <= p.orbitRadius) {
            p.state = 'orbiting';
            p.orbitAngle = Math.atan2(p.y - p.orbitCenterY, p.x - p.orbitCenterX);
        }
        // Safety: never wander forever if it somehow misses the player
        if (p.x < -200 || p.x > PLAY_W + 200 || p.y < -200 || p.y > PLAY_H + 200) {
            p.dead = true;
        }
    } else {
        p.orbitAngle += p.orbitSpeed;
        p.x = p.orbitCenterX + Math.cos(p.orbitAngle) * p.orbitRadius;
        p.y = p.orbitCenterY + Math.sin(p.orbitAngle) * p.orbitRadius;

        p.life--;
        if (p.life <= 0) p.dead = true;
        // Remove orbiting bullets once they hit the visible edge
        if (p.x < -p.width || p.x > PLAY_W + p.width ||
            p.y < -p.height || p.y > PLAY_H + p.height) {
            p.dead = true;
            // visible "dispel" pop at the wall (what the Distract lesson teaches)
            pops.push({ x: Math.max(0, Math.min(PLAY_W, p.x)), y: Math.max(0, Math.min(PLAY_H, p.y)), color: p.color, age: 0 });
        }
    }
    // Distraction bullets are purely visual: they never collide.
}

function updateProjectile(p) {
    if (p.dead) return;

    // Big bullet destroys overlapping bullets
    if (p.isBigBullet) {
        const r = p.width / 2;
        const cx = p.x + p.width / 2;
        const cy = p.y + p.height / 2;
        for (const other of projectiles) {
            if (other === p || other.dead || other.isBigBullet) continue;
            const dist = Math.hypot(cx - (other.x + other.width / 2), cy - (other.y + other.height / 2));
            if (dist < r + other.width / 2) other.dead = true;
        }
    }

    if (p.rotating) {
        updateRotating(p);
        recordTrail(p);
        return;
    }

    if (p.type === 'bomb') {
        p.speed = Math.max(0.5, p.speed * 0.99);
        p.vx *= 0.99;
        p.vy *= 0.99;

        // Flash faster as it gets closer to exploding
        p.flashTimer++;
        if (p.flashTimer >= p.flashInterval) {
            p.flashTimer = 0;
            p.color = p.color === p.originalColor ? '#ffffff' : p.originalColor;
            if (p.lifetime < 60) p.flashInterval = 5;
        }

        p.lifetime--;
        if (p.lifetime <= 0 && !p.hasExploded) {
            explodeBomb(p);
        }

        for (let j = p.explosionParticles.length - 1; j >= 0; j--) {
            const part = p.explosionParticles[j];
            part.x += part.vx;
            part.y += part.vy;
            part.vy += 0.1; // Gravity
            part.lifetime--;
            if (part.lifetime <= 0) p.explosionParticles.splice(j, 1);
        }

        // Remove the bomb once the explosion is complete
        if (p.hasExploded && p.explosionParticles.length === 0) {
            p.dead = true;
            return;
        }
    } else if (p.homing) {
        // Limit homing speed to prevent instant tracking
        const maxSpeed = p.maxHomingSpeed || 2.0;
        const homingStrength = p.homingStrength || 0.03;
        const hTarget = p.target || player;
        const dx = hTarget.x + hTarget.width / 2 - (p.x + p.width / 2);
        const dy = hTarget.y + hTarget.height / 2 - (p.y + p.height / 2);
        const dist = Math.hypot(dx, dy);

        if (dist > 0) {
            p.vx += (dx / dist) * homingStrength;
            p.vy += (dy / dist) * homingStrength;

            const currentSpeed = Math.hypot(p.vx, p.vy);
            if (currentSpeed > maxSpeed) {
                p.vx = (p.vx / currentSpeed) * maxSpeed;
                p.vy = (p.vy / currentSpeed) * maxSpeed;
            }

            // Second steering pass toward the desired velocity (original behaviour)
            p.vx += ((dx / dist) * p.maxHomingSpeed - p.vx) * p.homingStrength;
            p.vy += ((dy / dist) * p.maxHomingSpeed - p.vy) * p.homingStrength;

            const speed = Math.hypot(p.vx, p.vy);
            if (speed > p.maxHomingSpeed) {
                p.vx = (p.vx / speed) * p.maxHomingSpeed;
                p.vy = (p.vy / speed) * p.maxHomingSpeed;
            }
        }
    }

    // Lifetime for ordinary bullets (bombs use `lifetime` as their fuse)
    if (p.type !== 'bomb' && p.lifetime !== undefined) {
        p.lifetime--;
        if (p.lifetime <= 0) {
            p.dead = true;
            return;
        }
    }

    // Curving bullets (Spiral's trailing bullets) turn a little every tick
    if (p.turn) {
        const c = Math.cos(p.turn);
        const sn = Math.sin(p.turn);
        const nvx = p.vx * c - p.vy * sn;
        p.vy = p.vx * sn + p.vy * c;
        p.vx = nvx;
    }

    if (p.acceleration) {
        p.speed *= p.acceleration;
        const angle = Math.atan2(p.vy, p.vx);
        p.vx = Math.cos(angle) * p.speed;
        p.vy = Math.sin(angle) * p.speed;
    }

    // Movement + collision
    if (p.update) {
        p.update();
        handleContact(p);
    } else if (p.vx !== undefined && p.vy !== undefined) {
        // Sub-step fast bullets so they cannot tunnel through the player
        const dist = Math.hypot(p.vx, p.vy);
        const steps = Math.max(1, Math.ceil(dist / 8));
        const sx = p.vx / steps;
        const sy = p.vy / steps;
        for (let s = 0; s < steps; s++) {
            p.x += sx;
            p.y += sy;
            if (handleContact(p)) break;
        }
    } else {
        p.x += p.speed * (p.isPlayerProjectile ? 1 : -1);
        handleContact(p);
    }

    recordTrail(p);

    // Remove if off screen
    if (!p.dead && (p.x < -50 || p.x > PLAY_W + 50 || p.y < -50 || p.y > PLAY_H + 50)) {
        p.dead = true;
    }
}

function updateProjectiles() {
    // Bullets spawned during this pass (bomb explosions) are updated next tick
    const count = projectiles.length;
    for (let i = 0; i < count; i++) {
        updateProjectile(projectiles[i]);
    }
    projectiles = projectiles.filter(p => !p.dead);
}

// Update minions (simplified for bullet hell)
function updateMinions() {
    // Clear minions for now since we're focusing on bullet hell
    minions.length = 0;
}

/* ==========================================================================
   RENDERING
   ========================================================================== */

function drawArrow(px, py, dx, dy, size) {
    const tipX = px + dx * size;
    const tipY = py + dy * size;
    const baseX = px - dx * size;
    const baseY = py - dy * size;
    const nx = -dy * size * 0.9;
    const ny = dx * size * 0.9;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(baseX + nx, baseY + ny);
    ctx.lineTo(baseX - nx, baseY - ny);
    ctx.closePath();
    ctx.fill();
}

// Indicators for loaded-but-not-yet-fired patterns: arrows in the gutter for
// off-screen spawns, rings for spawns inside the field.
function drawEntryMarkers(now) {
    for (const entry of loader.batch) {
        if (entry.fired) continue;
        const timeLeft = entry.fireAt - now;
        const urgent = timeLeft < 24;
        const blink = Math.floor(now / (urgent ? 3 : 9)) % 2 === 0;
        if (entry.def.noMarker) continue; // Cross / Sniper: no extra pre-warning
        const markers = [];
        (entry.plans || [entry.plan]).forEach(pl => {
            if (pl.spawns) markers.push(...pl.spawns);
            else if (pl.x !== undefined) markers.push(pl);
        });

        for (const m of markers) {
            ctx.save();
            ctx.globalAlpha = blink ? 0.95 : 0.4;
            ctx.fillStyle = entry.color;
            ctx.strokeStyle = entry.color;
            ctx.lineWidth = 2;

            if (m.edge === undefined) {
                ctx.beginPath();
                ctx.arc(m.x, m.y, (urgent ? 22 : 16) * ENTITY_SCALE, 0, TAU);
                ctx.stroke();
            } else if (m.edge === 0) {
                drawArrow(Math.max(12, Math.min(PLAY_W - 12, m.x)), -GUTTER / 2, 0, 1, 11 * ENTITY_SCALE);
            } else if (m.edge === 1) {
                drawArrow(PLAY_W + GUTTER / 2, Math.max(12, Math.min(PLAY_H - 12, m.y)), -1, 0, 11 * ENTITY_SCALE);
            } else if (m.edge === 2) {
                drawArrow(Math.max(12, Math.min(PLAY_W - 12, m.x)), PLAY_H + GUTTER / 2, 0, -1, 11 * ENTITY_SCALE);
            } else {
                drawArrow(-GUTTER / 2, Math.max(12, Math.min(PLAY_H - 12, m.y)), 1, 0, 11 * ENTITY_SCALE);
            }
            ctx.restore();
        }
    }
}

function drawPlayer(pl = player) {
    ctx.save();
    if (!pl.isVisible) ctx.globalAlpha = 0.35; // hit-immunity flash
    ctx.translate(pl.x + pl.width / 2, pl.y + pl.height / 2);
    ctx.rotate(pl.facing);

    ctx.beginPath();
    ctx.moveTo(pl.width / 2, 0);
    ctx.lineTo(-pl.width / 2, -pl.width / 2);
    ctx.lineTo(-pl.width / 2, pl.width / 2);
    ctx.closePath();

    // Visual feedback for dashing (and the short post-dash invulnerability)
    if (isDashInvulnerable(pl)) {
        ctx.fillStyle = pl.dashFill;
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.stroke();
    } else {
        ctx.fillStyle = pl.fill;
    }
    ctx.fill();
    ctx.restore();
}

function drawSparks() {
    ctx.save();
    for (const sp of bulletHell.sparks) {
        const t = sp.age / 24;
        ctx.globalAlpha = 1 - t;
        ctx.strokeStyle = '#e6ecf5';
        ctx.lineWidth = 2;
        for (let k = 0; k < 10; k++) {
            const a = (k * TAU) / 10;
            const r0 = 10 + t * 30;
            ctx.beginPath();
            ctx.moveTo(sp.x + Math.cos(a) * r0, sp.y + Math.sin(a) * r0);
            ctx.lineTo(sp.x + Math.cos(a) * (r0 + 12), sp.y + Math.sin(a) * (r0 + 12));
            ctx.stroke();
        }
    }
    ctx.restore();
}

function drawSniperWarnings() {
    bulletHell.sniperWarnings.forEach(warning => {
        const progress = warning.timer / warning.warningTime;
        const flashing = warning.locked && Math.floor(warning.timer / 3) % 2 === 0;
        const lineLength = Math.hypot(PLAY_W, PLAY_H) * 1.5;

        ctx.save();
        // dim while it is still tracking; bright + flashing once the aim is locked
        ctx.globalAlpha = warning.locked ? (flashing ? 1 : 0.7) : 0.28 + progress * 0.2;
        ctx.strokeStyle = warning.locked ? '#ff2d44' : '#ff4d5e';
        ctx.lineWidth = warning.locked ? 3 : 1.5;
        ctx.beginPath();
        ctx.moveTo(
            warning.x - Math.cos(warning.angle) * lineLength,
            warning.y - Math.sin(warning.angle) * lineLength
        );
        ctx.lineTo(
            warning.x + Math.cos(warning.angle) * lineLength,
            warning.y + Math.sin(warning.angle) * lineLength
        );
        ctx.stroke();
        ctx.restore();
    });
}

function drawLasers() {
    bulletHell.lasers.forEach(laser => {
        // Lasting trail segments first so the laser sits on top
        laser.trails.forEach(trail => {
            const alpha = Math.max(0, trail.life / laser.trailLifetime) * 0.25;
            ctx.save();
            ctx.translate(trail.x, trail.y);
            ctx.rotate(trail.angle);
            ctx.fillStyle = `rgba(255, 0, 0, ${alpha})`;
            ctx.fillRect(-trail.width / 2, -trail.height / 2, trail.width, trail.height);
            ctx.restore();
        });

        ctx.save();
        ctx.translate(laser.x, laser.y);
        ctx.rotate(laser.angle);

        if (laser.isWarning) {
            ctx.strokeStyle = 'rgba(255, 0, 0, 0.7)';
            ctx.lineWidth = 3;
            ctx.strokeRect(-laser.width / 2, -laser.height / 2, laser.width, laser.height);

            const pulse = Math.sin(laser.timer * 0.2) * 0.5 + 0.5;
            ctx.fillStyle = `rgba(255, 0, 0, ${0.1 + pulse * 0.1})`;
            ctx.fillRect(-laser.width / 2, -laser.height / 2, laser.width, laser.height);
        } else {
            const gradient = ctx.createLinearGradient(-laser.width / 2, 0, laser.width / 2, 0);
            gradient.addColorStop(0, 'rgba(255, 100, 100, 0.9)');
            gradient.addColorStop(0.5, 'rgba(255, 200, 200, 0.9)');
            gradient.addColorStop(1, 'rgba(255, 100, 100, 0.9)');
            ctx.fillStyle = gradient;
            ctx.shadowColor = 'rgba(255, 100, 100, 0.8)';
            ctx.shadowBlur = 16;
            ctx.fillRect(-laser.width / 2, -laser.height / 2, laser.width, laser.height);
            ctx.shadowBlur = 0;
        }
        ctx.restore();
    });
}

function drawSawblade(p) {
    const cx = p.x + p.width / 2;
    const cy = p.y + p.height / 2;
    const r = p.width / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(p.saw.spin);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    const teeth = 12;
    for (let i = 0; i < teeth * 2; i++) {
        const rr = i % 2 === 0 ? r : r * 0.72;
        const a = (i * Math.PI) / teeth;
        if (i === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#2a2f38';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#2a2f38';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.22, 0, TAU);
    ctx.fill();
    ctx.restore();
}

function drawProjectile(p) {
    if (p.isSawblade) {
        drawSawblade(p);
        return;
    }
    if (p.type === 'bomb') {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x + p.width / 2, p.y + p.height / 2, p.width / 2, 0, TAU);
        ctx.fill();

        p.explosionParticles.forEach(part => {
            ctx.globalAlpha = Math.min(1, part.lifetime / 30);
            ctx.fillStyle = part.color;
            ctx.beginPath();
            ctx.arc(part.x, part.y, part.size, 0, TAU);
            ctx.fill();
        });
        ctx.globalAlpha = 1;
    } else if (p.isSniperShot) {
        ctx.save();
        ctx.translate(p.x + p.width / 2, p.y + p.height / 2);
        ctx.rotate(Math.atan2(p.vy, p.vx));
        ctx.fillStyle = p.color;
        ctx.shadowColor = '#ff4055';
        ctx.shadowBlur = 14;
        ctx.fillRect(-p.width / 2, -p.height / 2, p.width, p.height);
        ctx.restore();
    } else if (p.isBigBullet) {
        ctx.save();
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 30;
        ctx.beginPath();
        ctx.arc(p.x + p.width / 2, p.y + p.height / 2, p.width / 2, 0, TAU);
        ctx.fill();

        const pulse = Math.sin(bulletHell.gameTime * 0.1) * 0.5 + 0.5;
        ctx.strokeStyle = `rgba(255, 0, 255, ${0.5 + pulse * 0.5})`;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.restore();
    } else if (p.round) {
        ctx.fillStyle = p.color || 'rgba(255, 50, 50, 0.8)';
        ctx.beginPath();
        ctx.arc(p.x + p.width / 2, p.y + p.height / 2, p.width / 2, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.lineWidth = 1;
        ctx.stroke();
    } else {
        // Regular projectiles (no glow: keeps the screen readable and fast)
        ctx.fillStyle = p.color ||
            (p.isPlayerProjectile ? 'rgba(0, 255, 0, 0.8)' : 'rgba(255, 50, 50, 0.8)');
        ctx.fillRect(p.x, p.y, p.width, p.height);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.lineWidth = 1;
        ctx.strokeRect(p.x, p.y, p.width, p.height);
    }
}

function drawDistraction(p) {
    // Original look: translucent, soft glow and a heavy dark outline
    const fade = p.state === 'orbiting' ? Math.min(1, p.life / 40) : 1;
    if (p.trail && p.trail.length >= 4) {
        ctx.save();
        ctx.globalAlpha = fade;
        drawTrail(p, 1.7, 1.4);
        ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = 0.42 * fade;
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.arc(p.x + p.width / 2, p.y + p.height / 2, p.width / 2, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
}

// Trails: three tapered, fading strokes per bullet (cheap, and never opaque
// enough to hide the bullet, which is drawn on top)
function drawTrail(p, scale = 1, widthScale = 1) {
    const t = p.trail;
    const n = t.length / 2;
    if (n < 2) return;
    const w = Math.max(1.5, Math.min(p.width, 10) * 0.6);
    ctx.strokeStyle = p.color;
    ctx.lineCap = 'round';
    for (let seg = 0; seg < 3; seg++) {
        const from = Math.floor((n - 1) * seg / 3);
        const to = Math.floor((n - 1) * (seg + 1) / 3) + 1;
        ctx.globalAlpha = (0.14 + seg * 0.13) * scale;
        ctx.lineWidth = w * (0.4 + seg * 0.3) * widthScale;
        ctx.beginPath();
        ctx.moveTo(t[from * 2], t[from * 2 + 1]);
        for (let i = from + 1; i <= to && i < n; i++) ctx.lineTo(t[i * 2], t[i * 2 + 1]);
        if (seg === 2) ctx.lineTo(p.x + p.width / 2, p.y + p.height / 2);
        ctx.stroke();
    }
}

// Historical afterimages: faint, slowly fading imprints of where the player
// and the special bullets have been
// Extra window space on wide / tall monitors: the same field, a faint grid, and
// in 1v1 each player's key reminder. Nothing out here is playable or ever shows bullets.
function drawSideDecor() {
    const sr = screenRect();
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = 48;
    for (let gx = Math.floor(sr.x / step) * step; gx < sr.x + sr.w; gx += step) {
        ctx.moveTo(gx, sr.y);
        ctx.lineTo(gx, sr.y + sr.h);
    }
    for (let gy = Math.floor(sr.y / step) * step; gy < sr.y + sr.h; gy += step) {
        ctx.moveTo(sr.x, gy);
        ctx.lineTo(sr.x + sr.w, gy);
    }
    ctx.stroke();
    ctx.restore();

    // 1v1 key legends in the side margins (only when there is room)
    const sideW = -sr.x; // width of one side margin, in logical units
    if (twoPlayer && sideW > 120) {
        const legend = (who, cx, color, name) => {
            const b = bindings[who];
            const midY = CANVAS_H / 2;
            hudText(name, cx, midY - 54, color, 18, 'center');
            const short = code => ({ ArrowUp: '\u2191', ArrowDown: '\u2193', ArrowLeft: '\u2190', ArrowRight: '\u2192' }[code] || keyLabel(code));
            hudText([b.up, b.left, b.down, b.right].map(short).join('  '), cx, midY - 20, '#cfd3dc', 15, 'center');
            hudText('move', cx, midY + 2, '#6b7080', 11, 'center');
            hudText(keyLabel(b.dash), cx, midY + 36, '#cfd3dc', 15, 'center');
            hudText('dash', cx, midY + 58, '#6b7080', 11, 'center');
        };
        legend('p1', sr.x / 2, '#4da6ff', 'PLAYER 1');
        legend('p2', CANVAS_W + (sr.w + sr.x - CANVAS_W) / 2, '#ff9f43', 'PLAYER 2');
    }
}

// Wall glow + a ring around the ship that fills with the camping meter
function drawWallPressure() {
    if (gameState !== 'playing') return;
    for (const pl of activePlayers()) {
        if (pl.camp < 0.15 || pl.hitsRemaining <= 0) continue;
        const z = campZone(pl);
        const a = Math.min(1, pl.camp);
        const pulse = 0.65 + 0.35 * Math.sin(menu.t * 0.25);

        // ring around the ship: fills clockwise as the meter fills
        ctx.save();
        ctx.lineWidth = 3;
        ctx.strokeStyle = a > 0.75 ? '#ff3b3b' : '#ffb347';
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(z.cx, z.cy, 30 * ENTITY_SCALE, -Math.PI / 2, -Math.PI / 2 + TAU * a);
        ctx.stroke();
        ctx.restore();

        // walls heat up once the meter is meaningful
        if (pl.camp >= 0.3) {
            const strength = Math.min(1, (pl.camp - 0.3) / 0.7) * 0.55 * pulse;
            const depth = 70;
            const strips = [];
            if (z.vertical || z.corner) strips.push(z.cx < PLAY_W / 2 ? 'left' : 'right');
            if (!z.vertical || z.corner) strips.push(z.cy < PLAY_H / 2 ? 'top' : 'bottom');
            for (const side of strips) {
                let g;
                let rx = 0;
                let ry = 0;
                let rw = PLAY_W;
                let rh = PLAY_H;
                if (side === 'left') { g = ctx.createLinearGradient(0, 0, depth, 0); rw = depth; }
                else if (side === 'right') { g = ctx.createLinearGradient(PLAY_W, 0, PLAY_W - depth, 0); rx = PLAY_W - depth; rw = depth; }
                else if (side === 'top') { g = ctx.createLinearGradient(0, 0, 0, depth); rh = depth; }
                else { g = ctx.createLinearGradient(0, PLAY_H, 0, PLAY_H - depth); ry = PLAY_H - depth; rh = depth; }
                g.addColorStop(0, 'rgba(255, 60, 40, 0.9)');
                g.addColorStop(1, 'rgba(255, 60, 40, 0)');
                ctx.save();
                ctx.globalAlpha = strength;
                ctx.fillStyle = g;
                ctx.fillRect(rx, ry, rw, rh);
                ctx.restore();
            }
        }
    }
}

function drawGhosts() {
    ctx.save();
    for (const pop of pops) {
        ctx.globalAlpha = 1 - pop.age / 16;
        ctx.strokeStyle = pop.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pop.x, pop.y, (4 + pop.age * 1.4) * ENTITY_SCALE, 0, TAU);
        ctx.stroke();
    }
    for (const g of ghosts) {
        ctx.globalAlpha = 0.24 * Math.pow(1 - g.age / GHOST_LIFE, 1.6);
        ctx.fillStyle = g.color;
        if (g.shape === 'tri') {
            ctx.save();
            ctx.translate(g.x, g.y);
            ctx.rotate(g.angle);
            ctx.beginPath();
            ctx.moveTo(g.r, 0);
            ctx.lineTo(-g.r, -g.r);
            ctx.lineTo(-g.r, g.r);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        } else {
            ctx.beginPath();
            ctx.arc(g.x, g.y, g.r, 0, TAU);
            ctx.fill();
        }
    }
    ctx.restore();
}

function drawProjectiles() {
    // 1) additive pass: per-pattern glow halos and trails
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of projectiles) {
        if (p.rotating) continue;
        if (p.trail && p.trail.length >= 4) drawTrail(p);
        if (p.glow && p.glow[0] > 0) {
            ctx.globalAlpha = p.glow[1];
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x + p.width / 2, p.y + p.height / 2, (Math.max(p.width, p.height) / 2) * p.glow[0], 0, TAU);
            ctx.fill();
        }
    }
    ctx.restore();
    // 2) distraction bullets underneath, 3) real attacks on top
    projectiles.forEach(p => { if (p.rotating) drawDistraction(p); });
    projectiles.forEach(p => { if (!p.rotating) drawProjectile(p); });
}

// Anime-style impact frame: pure white with a black streak along the shot for
// the first 3 ticks (~50 ms), then a quick fade.
function drawImpactFrame() {
    const f = bulletHell.impact;
    if (!f) return;
    const hard = f.timer < 3;
    const alpha = hard ? 1 : Math.max(0, 1 - (f.timer - 3) / (f.duration - 3));
    const len = Math.hypot(PLAY_W, PLAY_H) * 1.5;
    const dx = Math.cos(f.angle);
    const dy = Math.sin(f.angle);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, PLAY_W, PLAY_H);
    ctx.clip();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PLAY_W, PLAY_H);
    if (hard) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#000000';
        [[0, 7], [-14, 3], [14, 3], [-30, 1.5], [30, 1.5]].forEach(([off, width]) => {
            ctx.lineWidth = width;
            ctx.beginPath();
            ctx.moveTo(f.x - dx * len - dy * off, f.y - dy * len + dx * off);
            ctx.lineTo(f.x + dx * len - dy * off, f.y + dy * len + dx * off);
            ctx.stroke();
        });
    }
    ctx.restore();
}

function hudText(text, x, y, color = '#cfd3dc', size = 11, align = 'left') {
    ctx.fillStyle = color;
    ctx.font = `${size}px monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
}

function formatTime(sec) {
    const m = Math.floor(sec / 60);
    return `${m}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

function hudStrip() {
    const r = screenRect(); // the strip spans the whole window width
    ctx.fillStyle = '#070707';
    ctx.fillRect(r.x, 0, r.w, HUD_H);
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(r.x, HUD_H - 1, r.w, 1);
}

// Top HUD strip: health box, dash bar, heal bar (Normal) and speed / time.
// Normal and Hitless do not show the projectile loading list (the scheduler
// still runs underneath); Practice shows its upcoming picks as small chips.
// One player's health box + dash bar + heal bar. `x0` is the panel's left edge.
function drawPlayerPanel(pl, x0, compact, tag) {
    const heartSize = 16;
    const spacing = 4;
    hudText(tag ? `${tag} HEALTH` : 'HEALTH', x0, 14, pl.id === 2 ? '#ffb070' : '#8d93a5', 10);
    for (let i = 0; i < pl.maxHits; i++) {
        const hx = x0 + i * (heartSize + spacing);
        if (i < pl.hitsRemaining) {
            ctx.fillStyle = 'red';
            ctx.fillRect(hx, 26, heartSize, heartSize);
        }
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1;
        ctx.strokeRect(hx + 0.5, 26.5, heartSize, heartSize);
    }

    // Dash bar (fixed slot, so it can never collide with the hearts)
    const barW = compact ? 90 : 120;
    const dx = x0 + 8 * (heartSize + spacing) + (compact ? 16 : 36);
    const dashReady = pl.dashCooldown <= 0;
    const dashFill = dashReady ? 1 : 1 - pl.dashCooldown / pl.dashCooldownMax;
    hudText('DASH', dx, 14, '#8d93a5', 10);
    ctx.fillStyle = dashReady ? 'rgba(0, 200, 255, 0.9)' : 'rgba(0, 200, 255, 0.45)';
    ctx.fillRect(dx, 28, barW * dashFill, 10);
    ctx.strokeStyle = 'white';
    ctx.strokeRect(dx + 0.5, 28.5, barW, 10);

    // Heal bar (Normal / 1v1): fills while you stay undamaged
    const hx2 = dx + barW + (compact ? 24 : 40);
    if (gameState === 'playing' && (gameMode === 'normal' || gameMode === '1v1')) {
        const healing = pl.hitsRemaining < pl.maxHits;
        const progress = healing ? Math.min(1, pl.noHitTimer / healDelayTicks()) : 0;
        hudText('HEAL', hx2, 14, '#8d93a5', 10);
        ctx.fillStyle = 'rgba(80, 255, 140, 0.85)';
        ctx.fillRect(hx2, 28, barW * progress, 10);
        ctx.strokeStyle = healing ? '#6c8' : '#345';
        ctx.strokeRect(hx2 + 0.5, 28.5, barW, 10);
    }
    return hx2;
}

// Top HUD strip. Normal / Hitless / 1v1 do not show the projectile loading list
// (the scheduler still runs underneath); Practice shows its upcoming picks.
function drawHud() {
    hudStrip();

    if (twoPlayer) {
        // Player 1 on the left, Player 2 mirrored on the right, match info in the middle
        drawPlayerPanel(player, GUTTER, true, 'P1');
        drawPlayerPanel(player2, CANVAS_W - GUTTER - 380, true, 'P2');
        const mx = CANVAS_W / 2;
        hudText(`1 VS 1  x${simSpeed().toFixed(2)}`, mx, 16, '#8aa0b0', 11, 'center');
        hudText(formatTime(run.realMs / 1000), mx, 38, '#e6e9f2', 16, 'center');
        return;
    }

    const hx2 = drawPlayerPanel(player, GUTTER, false, '');

    // Practice: the upcoming picks (the one place the list is still useful)
    if (gameState === 'practice') {
        hudText('NEXT', hx2, 14, '#8d93a5', 10);
        loader.batch.slice(0, 4).forEach((entry, i) => {
            const cx = hx2 + i * 72;
            ctx.globalAlpha = entry.fired ? 0.25 : 0.9;
            ctx.fillStyle = entry.color;
            ctx.fillRect(cx, 24, 68, 20);
            ctx.globalAlpha = 1;
            hudText(entry.label.slice(0, 9), cx + 34, 35, entry.fired ? '#6b7080' : '#101010', 10, 'center');
        });
    }

    // Right side: mode + game speed, run clock, hits (training)
    const rx = CANVAS_W - GUTTER;
    hudText(`${modeLabel()}  x${simSpeed().toFixed(2)}`, rx, 13, gameMode === 'hitless' && gameState === 'playing' ? '#ff8a8a' : '#8aa0b0', 11, 'right');
    if (gameState === 'playing' || gameState === 'practice') hudText(formatTime(run.realMs / 1000), rx, 32, '#e6e9f2', 16, 'right');
    if (isTrainingState()) hudText(`HITS TAKEN ${practice.hits}`, rx, 52, '#ff8a8a', 11, 'right');
}

/* ==========================================================================
   MENU / SCREEN DRAWING
   ========================================================================== */

function dot(x, y, r, color) {
    if (color) ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
}

function roundRectPath(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function wrapText(text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let line = '';
    words.forEach(word => {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && line) {
            lines.push(line);
            line = word;
        } else {
            line = test;
        }
    });
    if (line) lines.push(line);
    return lines;
}

function drawButton(b) {
    const hover = pointer.x >= b.x && pointer.x <= b.x + b.w && pointer.y >= b.y && pointer.y <= b.y + b.h;
    ctx.save();
    roundRectPath(b.x, b.y, b.w, b.h, 6);
    ctx.fillStyle = hover ? '#666' : '#4a4a4a';
    ctx.fill();
    ctx.strokeStyle = '#777';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '20px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
    ctx.restore();
}

function titleButton() {
    return { x: CANVAS_W / 2 - 130, y: 320 + UI_OY, w: 260, h: 58, label: 'START GAME', action: startFromTitle };
}

function overButtons() {
    return [
        { x: CANVAS_W / 2 - 215, y: 400 + UI_OY, w: 200, h: 54, label: 'CONTINUE', action: retryRun },
        { x: CANVAS_W / 2 + 15, y: 400 + UI_OY, w: 200, h: 54, label: 'MENU', action: () => goHub('main') }
    ];
}

function currentButtons() {
    if (gameState === 'title') return [titleButton()];
    if (gameState === 'over') return overButtons();
    return [];
}

function drawTitle() {
    const cx = CANVAS_W / 2;
    // faint drifting bullets for atmosphere
    for (let i = 0; i < 30; i++) {
        const a = menu.t * 0.004 * (1 + (i % 3)) + i * 2.4;
        dot(cx + Math.cos(a + i) * (180 + ((i * 37) % 260)),
            CANVAS_H * 0.45 + Math.sin(a * 1.3 + i) * (120 + ((i * 53) % 160)),
            2 + (i % 3), `hsla(${(i * 37) % 360}, 100%, 60%, 0.22)`);
    }

    ctx.save();
    ctx.translate(0, UI_OY);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 66px Arial, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.shadowColor = '#ff0000';
    ctx.shadowBlur = 24;
    ctx.fillText('Light Shuttle', cx, 230);
    ctx.fillText('Light Shuttle', cx, 230);
    ctx.shadowBlur = 0;
    ctx.restore();

    drawButton(titleButton());
    ctx.save();
    ctx.globalAlpha = 0.5 + 0.4 * Math.sin(menu.t * 0.06);
    hudText('or press any key', cx, 405 + UI_OY, '#9aa0b4', 14, 'center');
    ctx.restore();

    // Controls panel
    ctx.save();
    ctx.translate(0, UI_OY);
    roundRectPath(cx - 190, 450, 380, 150, 10);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffcc00';
    ctx.font = 'bold 20px Arial, sans-serif';
    ctx.fillText('CONTROLS', cx, 478);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px Arial, sans-serif';
    ctx.fillText('WASD or Arrow Keys - Move     SPACE - Dash', cx, 514);
    ctx.fillStyle = '#ffb070';
    ctx.fillText('1v1: P1 WASD + SPACE, P2 ARROWS + CTRL', cx, 546);
    ctx.fillStyle = '#8d93a5';
    ctx.font = '12px Arial, sans-serif';
    ctx.fillText('Rebind keys in Main Menu > Controls', cx, 576);
    ctx.restore();
}

function drawGameOverOverlay() {
    const cx = CANVAS_W / 2;
    ctx.save();
    fillScreen('rgba(0, 0, 0, 0.82)');
    ctx.translate(0, UI_OY);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 58px Arial, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.shadowColor = lastRun.mode === '1v1' && lastRun.winner === 2 ? '#ff9f43' : lastRun.mode === '1v1' && lastRun.winner === 1 ? '#4da6ff' : '#ff0000';
    ctx.shadowBlur = 22;
    if (lastRun.mode === '1v1') ctx.fillText(lastRun.winner ? `PLAYER ${lastRun.winner} WINS` : 'DRAW', cx, 230);
    else ctx.fillText('GAME OVER', cx, 230);
    ctx.shadowBlur = 0;
    ctx.font = '20px Arial, sans-serif';
    ctx.fillText(lastRun.mode === '1v1' ? '1 vs 1' : `${lastRun.mode === 'hitless' ? 'Hitless' : 'Normal'} mode`, cx, 296);
    ctx.fillText(lastRun.mode === '1v1' ? `Match length: ${lastRun.time} seconds` : `Survived: ${lastRun.time} seconds`, cx, 330);
    if (lastRun.mode !== '1v1') {
        ctx.fillStyle = '#ffcc00';
        ctx.fillText(`Best: ${lastRun.best} seconds`, cx, 362);
    }
    ctx.restore();
    overButtons().forEach(drawButton);
    hudText('Enter: continue     Esc: menu', cx, 490 + UI_OY, '#8d93a5', 13, 'center');
}

// A black screen with a circular hole of radius r at the centre of the canvas
function drawIrisMask(r, ringColor) {
    const cx = CANVAS_W / 2;
    const cy = CANVAS_H / 2;
    const sr = screenRect();
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.rect(sr.x, sr.y, sr.w, sr.h);
    if (r > 0) ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill('evenodd');
    if (ringColor && r > 0) {
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, TAU);
        ctx.stroke();
    }
    ctx.restore();
}

// Radius (logical units) that reaches the corners of the whole window
function irisMaxRadius() {
    const sr = screenRect();
    return Math.hypot(sr.w, sr.h) / 2;
}

// Hold-to-select countdown for Normal / Hitless: the circle closes around the
// centre of the screen and finishes exactly when the 4 seconds are up
function drawIrisHold() {
    if (gameState !== 'menu' || !hub) return;
    let best = 0;
    let color = '#ffffff';
    hub.pads.forEach(p => {
        if (!p.iris) return;
        const pr = (menu.progress[p.id] || 0) / p.dwell;
        if (pr > best) {
            best = pr;
            color = p.color;
        }
    });
    if (best <= 0) return;
    drawIrisMask(irisMaxRadius() * (1 - Math.min(1, best)), color);
}

function drawTransition() {
    if (!transition.active) return;
    if (transition.iris) {
        const maxR = irisMaxRadius();
        const t = transition.phase === 'out' ? 0 : transition.timer / transition.inTicks;
        drawIrisMask(transition.phase === 'out' ? 0 : maxR * (1 - Math.pow(1 - t, 2)), null);
        return;
    }
    const a = transition.phase === 'out'
        ? transition.timer / transition.outTicks
        : 1 - transition.timer / transition.inTicks;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, a));
    fillScreen('#000');
    ctx.restore();
}

/* ---------- Pattern icons (also used as lesson / custom practice art) ---------- */

function drawPatternIcon(type, cx, cy, s, color, t) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    switch (type) {
        case 'circle':
            for (let i = 0; i < 8; i++) dot(cx + Math.cos((i * TAU) / 8) * s * 0.85, cy + Math.sin((i * TAU) / 8) * s * 0.85, 3.2);
            break;
        case 'spread':
            for (let k = 0; k < 5; k++) {
                const a = (k - 2) * 0.28;
                [0.5, 0.95, 1.4].forEach(r => dot(cx - s * 0.9 + Math.cos(a) * s * r, cy + Math.sin(a) * s * r, 2.6));
            }
            dot(cx - s * 0.9, cy, 4);
            break;
        case 'spiral':
            for (let i = 0; i < 16; i++) {
                const a = i * 0.55 + t * 0.02;
                const r = s * (i / 16) * 1.05;
                dot(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2.5);
            }
            break;
        case 'doubleSpiral':
            for (let i = 0; i < 12; i++) {
                const a = i * 0.6 + t * 0.02;
                const r = s * (i / 12) * 1.05;
                dot(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2.5, color);
                dot(cx + Math.cos(a + Math.PI) * r, cy + Math.sin(a + Math.PI) * r, 2.5, '#ff6bb0');
            }
            break;
        case 'laser':
            ctx.translate(cx, cy);
            ctx.rotate(-0.45);
            ctx.shadowColor = color;
            ctx.shadowBlur = 10;
            ctx.fillRect(-s * 1.1, -s * 0.14, s * 2.2, s * 0.28);
            break;
        case 'ratio': {
            const maxR = 3 * Math.pow(PHI, 7.5);
            for (let k = 0; k < 16; k++) {
                const r = (3 * Math.pow(PHI, k / 2) / maxR) * s * 1.1;
                const a = (k * Math.PI) / 4 + t * 0.01;
                dot(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2.4 + k * 0.08);
            }
            break;
        }
        case 'shotgun':
            for (let i = 0; i < 9; i++) {
                const a = Math.sin(i * 12.9898) * 0.35;
                const r = s * (0.6 + ((i * 37) % 10) / 9) * 1.1;
                dot(cx - s * 0.9 + Math.cos(a) * r, cy + Math.sin(a) * r, 2.6);
            }
            dot(cx - s * 0.9, cy, 4);
            break;
        case 'cross':
            dot(cx, cy, 3);
            [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => dot(cx + dx * s * 0.85, cy + dy * s * 0.85, 3.4));
            ctx.globalAlpha = 0.4;
            ctx.beginPath();
            ctx.moveTo(cx - s * 0.85, cy);
            ctx.lineTo(cx + s * 0.85, cy);
            ctx.moveTo(cx, cy - s * 0.85);
            ctx.lineTo(cx, cy + s * 0.85);
            ctx.stroke();
            break;
        case 'bigbullet':
            ctx.shadowColor = color;
            ctx.shadowBlur = 14;
            dot(cx, cy, s * 0.7);
            break;
        case 'rotating':
            dot(cx, cy, 3.5);
            ctx.globalAlpha = 0.45;
            for (let i = 0; i < 6; i++) dot(cx + Math.cos(t * 0.03 + (i * TAU) / 6) * s * 0.85, cy + Math.sin(t * 0.03 + (i * TAU) / 6) * s * 0.85, 3);
            break;
        case 'wave':
            for (let i = 0; i < 12; i++) dot(cx - s + (i * s * 2) / 11, cy + Math.sin(i * 0.9 + t * 0.08) * s * 0.45, 2.8);
            break;
        case 'sniper':
            ctx.globalAlpha = 0.5;
            ctx.beginPath();
            ctx.moveTo(cx - s, cy);
            ctx.lineTo(cx + s, cy);
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.fillRect(cx + s * 0.1, cy - 2.5, 16, 5);
            ctx.beginPath();
            ctx.arc(cx - s * 0.6, cy, 7, 0, TAU);
            ctx.stroke();
            break;
        case 'homing':
            for (let i = 0; i < 10; i++) dot(cx - s + i * s * 0.2, cy + s * 0.7 * Math.sin(i * 0.35 + 0.3), 2.2 + i * 0.12);
            break;
        case 'bomb':
            dot(cx, cy + 3, s * 0.55, '#ff3b3b');
            ctx.strokeStyle = '#fff';
            ctx.beginPath();
            ctx.moveTo(cx + 3, cy - s * 0.45);
            ctx.lineTo(cx + 9, cy - s * 0.8);
            ctx.stroke();
            dot(cx + 9, cy - s * 0.8, 2.5, '#ffd24d');
            break;
        case 'pulse':
            for (let i = 0; i < 6; i++) {
                const a = (i * TAU) / 6;
                dot(cx + Math.cos(a) * s * 0.8, cy + Math.sin(a) * s * 0.8, 2 + (Math.sin(t * 0.1 + i * Math.PI) + 1) * 3);
            }
            break;
        default:
            dot(cx, cy, 5);
            break;
    }
    ctx.restore();
}

/* ---------- Pad illustrations ---------- */

function drawPadIllustration(pad, cx, cy, s) {
    const img = PAD_IMAGES[pad.id];
    if (img && img.complete && img.naturalWidth) {
        ctx.drawImage(img, cx - s * 1.4, cy - s, s * 2.8, s * 2);
        return;
    }
    const t = menu.t;
    ctx.save();
    switch (pad.icon) {
        case 'normal':
            for (let i = 0; i < 10; i++) {
                const a = t * 0.02 + (i * TAU) / 10;
                dot(cx + Math.cos(a) * s * 0.95, cy + Math.sin(a) * s * 0.95, 4, `hsl(${190 + i * 14}, 100%, 62%)`);
            }
            ctx.fillStyle = 'rgba(0, 110, 255, 0.95)';
            ctx.beginPath();
            ctx.moveTo(cx + 15, cy);
            ctx.lineTo(cx - 11, cy - 12);
            ctx.lineTo(cx - 11, cy + 12);
            ctx.closePath();
            ctx.fill();
            break;
        case 'hitless': {
            const h = s * 0.85;
            ctx.setLineDash([6, 6]);
            ctx.lineDashOffset = -t * 0.3;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(cx, cy, s * 1.05, 0, TAU);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.shadowColor = '#ff3b4d';
            ctx.shadowBlur = 14;
            ctx.fillStyle = '#ff3b4d';
            ctx.beginPath();
            ctx.moveTo(cx, cy + h * 0.55);
            ctx.bezierCurveTo(cx + h * 1.0, cy - h * 0.1, cx + h * 0.45, cy - h * 0.9, cx, cy - h * 0.3);
            ctx.bezierCurveTo(cx - h * 0.45, cy - h * 0.9, cx - h * 1.0, cy - h * 0.1, cx, cy + h * 0.55);
            ctx.fill();
            ctx.shadowBlur = 0;
            hudText('1', cx, cy - 2, '#fff', 22, 'center');
            break;
        }
        case 'practice': {
            [[s * 1.0, '#ff6b6b'], [s * 0.7, '#ffffff'], [s * 0.42, '#ff6b6b'], [s * 0.18, '#ffffff']].forEach(([r, c]) => dot(cx, cy, r, c));
            ctx.strokeStyle = '#ffd24d';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(cx + s * 1.3, cy - s * 1.0);
            ctx.lineTo(cx + 4, cy - 4);
            ctx.stroke();
            break;
        }
        case 'tutorial':
            ctx.strokeStyle = pad.color;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(cx, cy, s, 0, TAU);
            ctx.stroke();
            hudText('?', cx, cy + 2, '#ffffff', 64, 'center');
            break;
        case 'library':
            for (let k = 0; k < 3; k++) {
                const x = cx - s * 0.9 + k * s * 0.4;
                const y = cy - s * 0.75 + k * s * 0.22;
                roundRectPath(x, y, s * 1.2, s * 1.2, 6);
                ctx.fillStyle = '#12151c';
                ctx.fill();
                ctx.strokeStyle = pad.color;
                ctx.lineWidth = 2;
                ctx.stroke();
            }
            drawPatternIcon('circle', cx - s * 0.9 + 0.8 * s + s * 0.2, cy - s * 0.75 + 0.44 * s + s * 0.6, s * 0.3, pad.color, t);
            break;
        case 'custom':
            for (let r = 0; r < 3; r++) {
                const y = cy - s * 0.7 + r * s * 0.7;
                const on = (r + Math.floor(t / 70)) % 2 === 0;
                roundRectPath(cx - s * 0.7, y - s * 0.17, s * 1.4, s * 0.34, s * 0.17);
                ctx.fillStyle = on ? 'rgba(93, 255, 143, 0.35)' : 'rgba(255, 255, 255, 0.1)';
                ctx.fill();
                ctx.strokeStyle = on ? '#5dff8f' : '#8d93a5';
                ctx.stroke();
                dot(cx + (on ? s * 0.45 : -s * 0.45), y, s * 0.13, on ? '#5dff8f' : '#8d93a5');
            }
            break;
        case 'speed':
            ctx.strokeStyle = '#ffb347';
            ctx.lineWidth = 3;
            for (let k = 0; k < 2; k++) {
                ctx.beginPath();
                ctx.moveTo(cx - s * 0.7 + k * s * 0.8, cy - s * 0.7);
                ctx.lineTo(cx - s * 0.1 + k * s * 0.8, cy);
                ctx.lineTo(cx - s * 0.7 + k * s * 0.8, cy + s * 0.7);
                ctx.stroke();
            }
            break;
        case 'duel':
            // two ships facing each other
            ctx.fillStyle = 'rgba(0, 110, 255, 0.95)';
            ctx.beginPath();
            ctx.moveTo(cx - s * 0.2, cy);
            ctx.lineTo(cx - s * 1.0, cy - s * 0.45);
            ctx.lineTo(cx - s * 1.0, cy + s * 0.45);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = 'rgba(255, 140, 40, 0.95)';
            ctx.beginPath();
            ctx.moveTo(cx + s * 0.2, cy);
            ctx.lineTo(cx + s * 1.0, cy - s * 0.45);
            ctx.lineTo(cx + s * 1.0, cy + s * 0.45);
            ctx.closePath();
            ctx.fill();
            hudText('VS', cx, cy - s * 0.95, '#ffffff', 16, 'center');
            break;
        case 'controls':
            ctx.strokeStyle = '#cfd3dc';
            ctx.lineWidth = 2;
            roundRectPath(cx - s * 0.8, cy - s * 0.6, s * 1.6, s * 1.2, 4);
            ctx.stroke();
            hudText('W A S D', cx, cy, '#cfd3dc', Math.max(8, s * 0.6), 'center');
            break;
        case 'start':
            ctx.fillStyle = '#5dff8f';
            ctx.beginPath();
            ctx.moveTo(cx - s * 0.5, cy - s * 0.7);
            ctx.lineTo(cx + s * 0.8, cy);
            ctx.lineTo(cx - s * 0.5, cy + s * 0.7);
            ctx.closePath();
            ctx.fill();
            break;
        case 'back':
            ctx.strokeStyle = '#cfd3dc';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(cx + s * 0.8, cy);
            ctx.lineTo(cx - s * 0.8, cy);
            ctx.moveTo(cx - s * 0.2, cy - s * 0.6);
            ctx.lineTo(cx - s * 0.8, cy);
            ctx.lineTo(cx - s * 0.2, cy + s * 0.6);
            ctx.stroke();
            break;
        case 'pattern':
            drawPatternIcon(pad.pattern, cx, cy, s, pad.color, t);
            break;
        default:
            break;
    }
    ctx.restore();
}

function drawPad(pad) {
    const prog = Math.min(1, (menu.progress[pad.id] || 0) / pad.dwell);
    const on = !!pad.toggle && customSel.has(pad.id);
    const hot = pad.inside || pad.near;
    const layout = pad.layout || (pad.h >= 200 ? 'big' : 'card');
    const pulse = 0.5 + 0.5 * Math.sin(menu.t * 0.08);
    const cx = pad.x + pad.w / 2;
    const label = pad.labelFn ? pad.labelFn() : pad.label;
    const sub = pad.subFn ? pad.subFn() : pad.sub;

    // body + hold-progress fill (iris pads show their progress as the wipe instead)
    ctx.save();
    ctx.globalAlpha = 0.1 + (hot ? 0.08 : 0) + (on ? 0.1 : 0);
    ctx.fillStyle = on ? '#5dff8f' : pad.color;
    ctx.fillRect(pad.x, pad.y, pad.w, pad.h);
    if (!pad.iris) {
        ctx.globalAlpha = 0.38;
        ctx.fillStyle = pad.color;
        ctx.fillRect(pad.x, pad.y + pad.h * (1 - prog), pad.w, pad.h * prog);
    }
    ctx.restore();

    // illustration
    if (layout === 'key') {
        // text only
    } else if (layout === 'big') drawPadIllustration(pad, cx, pad.y + pad.h * 0.36, 56);
    else if (layout === 'card') drawPadIllustration(pad, cx, pad.y + pad.h * 0.34, pad.h > 90 ? 28 : 20);
    else drawPadIllustration(pad, pad.x + 30, pad.y + pad.h / 2, 15);

    // border: glows when the player is near / on it
    ctx.save();
    ctx.globalAlpha = hot ? 1 : 0.55 + 0.2 * pulse;
    ctx.strokeStyle = on ? '#5dff8f' : pad.color;
    ctx.lineWidth = hot ? 3 : 2;
    if (hot) {
        ctx.shadowColor = pad.color;
        ctx.shadowBlur = 18;
    }
    ctx.strokeRect(pad.x, pad.y, pad.w, pad.h);
    ctx.restore();

    // text (every layout has fixed, non-overlapping slots)
    if (layout === 'big') {
        hudText(label, cx, pad.y + pad.h - 68, '#ffffff', label.length > 11 ? 17 : 22, 'center');
        ctx.font = '11px monospace';
        wrapText(sub || '', pad.w - 24).slice(0, 3).forEach((ln, i) => hudText(ln, cx, pad.y + pad.h - 44 + i * 14, '#aab0c0', 11, 'center'));
        // best time sits UNDER the selection, outside the pad
        if (pad.extra) hudText(pad.extra(), cx, pad.y + pad.h + 20, '#ffcc00', 13, 'center');
        if (hot && prog === 0) {
            ctx.save();
            ctx.globalAlpha = 0.5 + 0.5 * pulse;
            hudText('HOLD TO SELECT', cx, pad.y - 12, pad.color, 12, 'center');
            ctx.restore();
        }
    } else if (layout === 'key') {
        const listening = sub === 'PRESS A KEY...';
        hudText(label, cx, pad.y + 15, '#aab0c0', 11, 'center');
        hudText(sub || '', cx, pad.y + pad.h / 2 + 9, listening ? '#ffd24d' : '#ffffff', 20, 'center');
    } else if (layout === 'card') {
        hudText(label, cx, pad.y + pad.h - (sub ? 27 : 14), '#ffffff', 12, 'center');
        if (sub) hudText(sub, cx, pad.y + pad.h - 11, '#aab0c0', 10, 'center');
    } else {
        hudText(label, pad.x + 58, pad.y + pad.h / 2 - (sub ? 8 : 0), '#e6e9f2', 14);
        if (sub) hudText(sub, pad.x + 58, pad.y + pad.h / 2 + 11, '#8d93a5', 10);
    }
    if (pad.toggle) hudText(on ? 'ON' : 'OFF', pad.x + pad.w - 8, pad.y + 12, on ? '#5dff8f' : '#8d93a5', 11, 'right');
}

function drawHub() {
    if (!hub) return;
    ctx.save();
    ctx.translate(HUB_OX, HUB_OY);
    hudText(hub.title, HUB_W / 2, 56, '#ffffff', 34, 'center');
    hudText(hub.hint, HUB_W / 2, 92, '#8d93a5', 13, 'center');
    if (hub.draw) hub.draw();
    hub.pads.forEach(drawPad);
    if (menu.msgTimer > 0) hudText(menu.msg, HUB_W / 2, 114, '#ff8a8a', 14, 'center');
    ctx.restore();
}

function drawMenuHud() {
    hudStrip();
    const back = hub && hub.parent ? '      ESC: BACK' : '';
    hudText(`WASD / ARROWS: MOVE      SPACE: DASH${back}`, CANVAS_W / 2, HUD_H / 2, '#8d93a5', 13, 'center');
}

/* ---------- Lesson / tutorial panels ---------- */

function drawInfoPanel(heading, lines, color, footer) {
    const x = 12;
    const y = 10;
    const w = PLAY_W - 24;
    ctx.save();
    ctx.font = '13px monospace';
    const wrapped = [];
    lines.forEach(line => wrapText(line, w - 28).forEach(ln => wrapped.push(ln)));
    const h = 16 + 22 + wrapped.length * 16 + (footer ? 20 : 6);
    ctx.fillStyle = 'rgba(8, 8, 14, 0.8)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
    hudText(heading, x + 14, y + 20, color, 14);
    wrapped.forEach((ln, i) => hudText(ln, x + 14, y + 44 + i * 16, '#dfe3ee', 13));
    if (footer) hudText(footer, x + 14, y + h - 12, '#8d93a5', 11);
}

function demoCaption(data) {
    if (data.caption) return data.caption;
    const dash = data.demo.some(ev => ev.dash);
    const move = data.demo.some(ev => !ev.dash && ev.keys && ev.keys.length && (ev.dur || 1) > 1);
    if (dash && move) return 'reposition, then dash through it';
    if (dash) return 'dash at the right moment (dashing makes you invulnerable)';
    if (move) return 'sidestep out of its path';
    return 'stay put - the safe spot is already here';
}

function drawLessonPanel() {
    const data = LESSONS[lesson.index];
    const demo = lesson.phase === 'demo';
    const color = patternById(data.pattern).color;
    const lines = demo
        ? [`WHAT IT DOES: ${data.does}`, `WHY IT IS DANGEROUS: ${data.danger}`, `BEST RESPONSE: ${data.response}`, `WHY IT WORKS: ${data.why}`]
        : [`BEST RESPONSE: ${data.response}`, `WHY IT WORKS: ${data.why}`];
    drawInfoPanel(
        `${data.name.toUpperCase()}  (${lesson.index + 1}/${LESSONS.length})   ${demo ? `DEMO: ${demoCaption(data)}` : 'YOUR TURN: try it yourself'}`,
        lines,
        color,
        demo ? 'Watch the player: this is the real game engine, not a recording.' : 'Same attack, random positions. Build a clean streak.'
    );
}

function drawTutorialPanel() {
    const st = TUTORIAL_STEPS[tutorial.step];
    drawInfoPanel(
        `TUTORIAL  ${tutorial.step + 1}/${TUTORIAL_STEPS.length}: ${st.title}`,
        [st.text].concat(tutorial.msgTimer > 0 ? [tutorial.msg] : []),
        '#7dd87d',
        st.enter ? 'ENTER: continue     N: skip     ESC: leave' : 'N: skip step     ESC: leave'
    );
}

function drawLessonHud() {
    hudStrip();
    hudText(`HITS ${practice.hits}`, GUTTER, 18, '#ff8a8a', 14);
    if (lesson.phase === 'try') hudText(`CLEAN STREAK ${lesson.streak}   ATTEMPTS ${lesson.cycles}`, GUTTER, 42, '#7dd87d', 12);
    else hudText('DEMO RUNNING', GUTTER, 42, '#ffd24d', 12);
    hudText('R: replay demo     N: next     P: previous     ESC: back', CANVAS_W - GUTTER, HUD_H / 2, '#8d93a5', 12, 'right');
}

/* ==========================================================================
   RENDER
   ========================================================================== */

function modeLabel() {
    if (gameState === 'practice') return 'PRACTICE';
    if (gameState === 'tutorial') return 'TUTORIAL';
    if (gameState === 'lesson') return 'LESSON';
    return gameMode.toUpperCase();
}

function render() {
    if (!ctx) return;
    const now = bulletHell.gameTime;

    // Whole window first (same dark field everywhere), then the fixed-size game on top
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.fillStyle = gameState === 'title' ? '#050505' : '#111';
    ctx.fillRect(0, 0, view.w, view.h);
    ctx.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);
    if (gameState !== 'title') drawSideDecor();

    if (gameState === 'title') {
        drawTitle();
        drawTransition();
        return;
    }

    ctx.save();
    ctx.translate(GUTTER, PLAY_OY);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, PLAY_W - 1, PLAY_H - 1);

    if (gameState === 'menu') {
        drawHub();
        drawPlayer();
    } else {
        drawGhosts();
        drawWallPressure();
        drawLasers();
        drawSniperWarnings();
        drawSparks();
        drawProjectiles();
        drawPlayer();
        if (twoPlayer) drawPlayer(player2);
        drawEntryMarkers(now);
        drawImpactFrame();
        if (gameState === 'lesson') drawLessonPanel();
        if (gameState === 'tutorial') drawTutorialPanel();
        if (gameState === 'practice') hudText('ESC: leave practice', PLAY_W - 10, PLAY_H - 12, '#8d93a5', 11, 'right');
    }

    ctx.restore();

    drawIrisHold(); // closes over the arena, but the HUD below stays visible

    if (gameState === 'menu') drawMenuHud();
    else if (gameState === 'lesson') drawLessonHud();
    else drawHud();

    if (gameState === 'over') drawGameOverOverlay();
    drawTransition();
}


/* ==========================================================================
   LESSON DATA (Pattern Library)
   Each demo is a short script that drives the REAL player in the REAL engine
   against the real pattern (with a fixed random seed so it is repeatable).
   Events: { t, dur, keys: [...], dash } with t in ticks since the lesson began.
   ========================================================================== */

const LESSON_LEAD = 60; // ticks between the lesson starting and the pattern firing

const LESSONS = [
    { id: 'circle', pattern: 'circle', name: 'Circle',
      does: 'Bursts 8 bullets outward in a ring from one point; they accelerate as they travel.',
      danger: 'The speed ramps up, so waiting until they reach you leaves no time to react.',
      response: 'Pick the gap between two bullets early and stand still in it; a small sidestep is enough.',
      why: 'Every bullet flies in a straight line and the lines fan apart, so the gaps get wider the farther the ring travels.',
      plan: { edge: 3, x: -20, y: PLAY_H / 2 }, start: {x: 610, y: 420}, demo: [{t: 0, dur: 12, keys: ["ArrowUp"]}] },
    { id: 'spread', pattern: 'spread', name: 'Spread',
      does: 'Fires a narrow fan of 5 fast bullets aimed at the middle of the arena.',
      danger: 'The fan sweeps a wide lane and the bullets are quick, so there is little time once it is close.',
      response: 'Slip sideways into the space between two bullets, or leave the lane completely, before the fan arrives.',
      why: 'Each bullet follows a fixed straight line, so the gaps between them stay clear for the whole flight.',
      plan: { edge: 3, x: -20, y: PLAY_H / 2 }, start: {x: 610, y: 420}, demo: [{t: 0, dur: 12, keys: ["ArrowUp"]}] },
    { id: 'spiral', pattern: 'spiral', name: 'Spiral',
      does: 'Sends out 4 curving arms of bullets. The slower bullets at the back of each arm bend sideways, so the arms look like they spin.',
      danger: 'The tail bullets curve into the space beside their arm, so a wedge that looks empty slowly closes.',
      response: 'Stand in the wedge between two arms, drift gently with the spin as the tails bend in, and dash out through an arm if one catches you.',
      why: 'Every arm starts as a straight line and only bends a little at a time, so small moves with the spin keep you clear. The dash covers an arm passing through you.',
      plan: { x: PLAY_W / 2, y: PLAY_H / 2 }, start: {x: 627, y: 498}, demo: [{t: 0, dur: 20, keys: ["ArrowUp"]}] },
    { id: 'laser', pattern: 'laser', name: 'Laser',
      does: 'Draws a red outline for 1 second, then fires a beam for half a second and leaves a fading trail. (Laser x2 draws two bars.)',
      danger: 'The beam covers a very long strip, so running along it does not get you out.',
      response: 'Leave the outlined strip before it fires, or dash across it while the beam is lit.',
      why: 'Only the bright beam hurts; the outline and the trail never do. The dash makes you invulnerable while you cross.',
      plan: {}, start: {x: 460, y: 420}, demo: [{t: 0, dur: 12, keys: ["ArrowUp"]}] },
    { id: 'ratio', pattern: 'ratio', name: 'Ratio',
      does: 'Three golden-ratio spiral arms unfold from the centre and slide outward along their curves.',
      danger: 'The curved arms sweep through a lot of space, so running in a straight line often crosses one.',
      response: 'Step into the wide lane between two arms and follow its curve outward.',
      why: 'The lane between the arms keeps its width as it expands, so moving with the curve keeps you inside the lane.',
      plan: { x: PLAY_W / 2, y: PLAY_H / 2 }, start: {x: 627, y: 498}, demo: [{t: 0, dur: 45, keys: ["ArrowUp"]}] },
    { id: 'shotgun', pattern: 'shotgun', name: 'Shotgun',
      does: 'Fires a burst of pellets with random spread and speed, aimed at where you stood when it fired.',
      danger: 'The cone is wide and the pellets arrive at different times, so one small sidestep is often not enough.',
      response: 'Dash into the cloud just as the front pellets reach you, or cross the line of fire early and keep moving.',
      why: 'A dash makes you invulnerable for about a quarter of a second, which is enough to pass through the thick front of the cone.',
      plan: { edge: 3, x: -20, y: PLAY_H / 2 }, start: {x: 610, y: 420}, demo: [{t: 176, dur: 1, keys: ["ArrowLeft"], dash: true}] },
    { id: 'doubleSpiral', pattern: 'doubleSpiral', name: 'Double Spiral',
      does: 'Two interleaved spirals (cyan and pink) leave the centre in opposite rotation, forming a dense wall of bullets.',
      danger: 'There are so many bullets that a gap is only open for a moment.',
      response: 'Find the gap early, or dash straight through the wall where it is thinnest.',
      why: 'The two arms rotate away from each other, so gaps open and close in a rhythm. The dash invulnerability covers the crossing.',
      plan: { x: PLAY_W / 2, y: PLAY_H / 2 }, start: {x: 659, y: 420}, demo: [{t: 0, dur: 70, keys: ["ArrowUp"]}] },
    { id: 'cross', pattern: 'cross', name: 'Cross',
      does: 'Three crosses appear at once at different spots, each firing four bullets with one arm aimed at you.',
      danger: 'There is no warning, and twelve bullets come from three directions.',
      response: 'Step onto a diagonal between the arms of the nearest cross, then keep moving away from the other two.',
      why: 'Each cross aims exactly one arm at you; the diagonals between arms are empty, so a short shift takes you out of the line.',
      plan: {}, start: {x: 560, y: 420}, demo: [{t: 6, dur: 70, keys: ["ArrowUp"]}] },
    { id: 'bigbullet', pattern: 'bigbullet', name: 'Big Bullet',
      does: 'One huge orb drifts toward you and crushes any small bullets in its path.',
      danger: 'It is very wide, and dashing into it does NOT protect you.',
      response: 'Sidestep early, well before it gets close, and let it pass.',
      why: 'It is aimed when it spawns, so a small early move takes you out of its path; dash invulnerability does not apply to it.',
      plan: { edge: 3, x: -20, y: PLAY_H / 2 }, start: {x: 610, y: 420}, demo: [{t: 18, dur: 70, keys: ["ArrowUp"]}] },
    { id: 'rotating', pattern: 'rotating', name: 'Distract',
      does: 'Faint dots fly in and orbit around you for up to 7 seconds.',
      danger: 'They never hurt you, but they hide the real attacks around you.',
      response: 'Run to the edge of the arena so the ring of dots is pushed into the wall.',
      why: 'The orbit follows you, and a dot that crosses the arena boundary is deleted. At the edge most of the ring is cut off and your view clears quickly.',
      plan: null, caption: 'run to the arena edge so the wall deletes the orbiting dots', start: {x: 549, y: 420}, demo: [{t: 190, dur: 140, keys: ["ArrowLeft"]}] },
    { id: 'wave', pattern: 'wave', name: 'Sine',
      does: 'Large bullets that swerve hard and unpredictably while bending toward your position.',
      danger: 'Their curves converge around you, so dashing straight into the swarm runs into the closing paths.',
      response: 'Keep your distance so the swings overshoot, then cross the swarm only where the paths leave a gap.',
      why: 'They bend toward you only gradually, so open space buys time, and their wide swings keep leaving gaps to cross.',
      plan: { edge: 3, x: -20, y: PLAY_H / 2 }, start: {x: 510, y: 420}, demo: [{t: 0, dur: 30, keys: ["ArrowUp"]}] },
    { id: 'sniper', pattern: 'sniper', name: 'Sniper',
      does: 'A red line tracks you, then locks and flashes. An extremely fast shot follows along that locked line.',
      danger: 'The shot is almost instant and the aim leads your movement, so walking sideways at the last second fails.',
      response: 'Watch for the line to lock, then change direction or dash across the line while it flashes.',
      why: 'The aim is fixed a split second before firing, and the dash makes you invulnerable while the shot passes.',
      plan: { edge: 3, x: -20, y: PLAY_H / 2 }, start: {x: 610, y: 420}, demo: [{t: 131, dur: 1, keys: ["ArrowUp"], dash: true}] },
    { id: 'homing', pattern: 'homing', name: 'Homing',
      does: 'Four orange bullets curve toward you and speed up as they fly.',
      danger: 'They follow you and accelerate, so you cannot outrun them.',
      response: 'Kite them in a wide arc, then dash through them as they close in.',
      why: 'Their turning is limited, so wide arcs make them overshoot, and the dash covers the moment they pass through you.',
      plan: { edge: 3, x: -20, y: PLAY_H / 2 }, start: {x: 610, y: 420}, demo: [{t: 257, dur: 1, keys: ["ArrowUp"], dash: true}] },
    { id: 'bomb', pattern: 'bomb', name: 'Bomb',
      does: 'Two flashing bombs drift in from two edges. After 2 seconds each bursts into 8 bullets in the 8 compass directions plus 4 curving Sine bullets.',
      danger: 'The ring speeds up, and the Sine bullets curve in behind it and wall you off.',
      response: 'Stay well away from the bombs, slip between two of the 8 compass lines, then keep moving so the Sine bullets overshoot.',
      why: 'The ring only travels along 8 fixed lines, so the space between them stays empty. The Sine bullets bend toward you slowly, so open space buys time.',
      plan: { spawns: [{ edge: 3, x: -20, y: PLAY_H / 2 - 100 }, { edge: 1, x: PLAY_W + 20, y: PLAY_H / 2 + 100 }] }, seed: 1, start: {x: 490, y: 380}, demo: [{t: 0, dur: 30, keys: ["ArrowUp"]}] },
    { id: 'pulse', pattern: 'pulse', name: 'Pulse',
      does: 'A ring of bullets that breathe: cyan is small, red is large, and neighbours take turns.',
      danger: 'A gap can close the moment you reach it.',
      response: 'Aim for a gap where both neighbours are small (cyan) and cross as the big ones shrink.',
      why: 'Neighbours swell in opposition, so gaps open on a rhythm of about 1.2 seconds. Timing your crossing to a shrinking gap works.',
      plan: { edge: 3, x: -20, y: PLAY_H / 2 }, seed: 1, start: {x: 610, y: 420}, demo: [{t: 0, dur: 12, keys: ["ArrowUp"]}] }
];

/* ==========================================================================
   TUTORIAL DATA
   ========================================================================== */

const TUTORIAL_STEPS = [
    { title: 'MOVING', text: 'Use WASD or the arrow keys to move around the arena. Travel across the screen to continue.',
      ok: () => tutorial.moved >= 450 },
    { title: 'DASHING', text: 'Press SPACE to dash. You are invulnerable while dashing and for a split second after it ends. Dash twice to continue.',
      ok: () => tutorial.dashes >= 2 },
    { title: 'FIND THE GAP', text: 'A Circle will burst from the arrow on the left edge. Its bullets fly in straight lines, so the gaps between them are safe. Stand in a gap, or sidestep early.',
      attack: [{ id: 'circle', delay: 80, plan: { edge: 3, x: -20, y: PLAY_H / 2 } }], clean: true },
    { title: 'DASH THROUGH', text: 'A Shotgun aims at you. As the pellets are about to reach you, press SPACE and dash through them.',
      attack: [{ id: 'shotgun', delay: 90, plan: { edge: 3, x: -20, y: PLAY_H / 2 } }], clean: true },
    { title: 'HITS AND HEALING', text: 'Normal mode gives you 8 hits. Stay hit-free for 12 seconds to heal one back; any hit resets that timer. Press ENTER to continue.',
      enter: true },
    { title: 'WATCH THE EDGES', text: 'Attacks that start off-screen show an arrow in the margin where they will appear. Cross and Sniper give no marker - the Sniper has its own red tracking line instead. Survive this batch.',
      attack: [{ id: 'circle', delay: 80 }, { id: 'spread', delay: 130 }, { id: 'bomb', delay: 180 }] },
    { title: 'YOU ARE READY', text: 'That covers the basics. Study each attack in the Pattern Library, or head into a run. Press ENTER to return to the practice menu.',
      enter: true }
];

/* ==========================================================================
   TRANSITIONS, INPUT HELPERS
   ========================================================================== */

function transitionTo(action, opts = {}) {
    if (transition.active) return;
    transition.active = true;
    transition.phase = 'out';
    transition.timer = 0;
    transition.action = action;
    transition.iris = !!opts.iris; // iris: the closing part was already drawn by the hold-to-select wipe
    transition.outTicks = transition.iris ? 0 : 16;
    transition.inTicks = transition.iris ? 30 : 24;
}

function updateTransition() {
    if (!transition.active) return;
    transition.timer++;
    if (transition.phase === 'out') {
        if (transition.timer >= transition.outTicks) {
            const action = transition.action;
            transition.action = null;
            transition.phase = 'in';
            transition.timer = 0;
            if (action) action();
        }
    } else if (transition.timer >= transition.inTicks) {
        transition.active = false;
    }
}



function isTrainingState() {
    return gameState === 'practice' || gameState === 'lesson' || gameState === 'tutorial';
}

function canControl() {
    return gameState === 'menu' || gameState === 'playing' || isTrainingState();
}

function fieldClear() {
    return projectiles.length === 0 &&
        bulletHell.lasers.length === 0 &&
        bulletHell.sniperWarnings.length === 0;
}

function queueEntry(def, plan, delay) {
    const entry = {
        def, id: def.id, label: def.label, color: def.color, slots: def.slots,
        plan, plans: [plan], fireAt: bulletHell.gameTime + delay, fired: false
    };
    loader.batch.push(entry);
    return entry;
}

function patternById(id) {
    return bulletHell.patterns.find(d => d.id === id);
}

/* ==========================================================================
   HUBS (physical arena menus)
   ========================================================================== */

function buildHub(screen) {
    const back = (parent) => ({
        id: 'back', label: 'BACK', icon: 'back', color: '#8d93a5',
        layout: 'strip', x: 30, y: 515, w: 120, h: 65, dwell: MENU_DWELL.back, action: () => goHub(parent)
    });

    switch (screen) {
        case 'practice':
            return {
                title: 'PRACTICE', hint: 'Move onto an option and hold to select', spawn: { x: 400, y: 500 }, parent: 'main',
                pads: [
                    { id: 'tutorial', label: 'TUTORIAL', sub: 'Learn moving, dashing and reading attacks', icon: 'tutorial', color: '#7dd87d', x: 70, y: 150, w: 200, h: 250, dwell: MENU_DWELL.sub, action: () => startTutorial() },
                    { id: 'library', label: 'PATTERN LIBRARY', sub: 'Study each attack: watch a demo, then try it', icon: 'library', color: '#b388ff', x: 300, y: 150, w: 200, h: 250, dwell: MENU_DWELL.sub, action: () => goHub('library') },
                    { id: 'custom', label: 'CUSTOM PRACTICE', sub: 'Pick the attacks and train freely', icon: 'custom', color: '#ffb347', x: 530, y: 150, w: 200, h: 250, dwell: MENU_DWELL.sub, action: () => goHub('custom') },
                    back('main')
                ]
            };
        case 'library':
            return {
                title: 'PATTERN LIBRARY', hint: 'Hold on an attack to see how it works and practise it', spawn: { x: 400, y: 545 }, parent: 'practice',
                pads: LESSONS.map((l, i) => ({
                    id: l.id, label: l.name, icon: 'pattern', pattern: l.pattern, color: patternById(l.pattern).color,
                    x: 45 + (i % 5) * 145, y: 150 + Math.floor(i / 5) * 120, w: 130, h: 105,
                    dwell: MENU_DWELL.sub, action: () => startLesson(l.id)
                })).concat([back('practice')])
            };
        case 'custom':
            return {
                title: 'CUSTOM PRACTICE', hint: 'Hold on an attack to toggle it, then step onto START', spawn: { x: 400, y: 545 }, parent: 'practice',
                pads: bulletHell.patterns.map((d, i) => ({
                    id: d.id, label: d.label, sub: `${d.slots} slot${d.slots > 1 ? 's' : ''}`, icon: 'pattern', pattern: d.type, color: d.color, toggle: true,
                    x: 119 + (i % 4) * 144, y: 135 + Math.floor(i / 4) * 94, w: 130, h: 80,
                    dwell: MENU_DWELL.toggle, action: () => toggleCustom(d.id)
                })).concat([
                    { id: 'speed', icon: 'speed', layout: 'strip', color: '#ffb347', keepLocked: true,
                      labelFn: () => `SPEED +${Math.round(practiceSpeedRate * 100)}%/MIN`, subFn: () => 'hold to change ramp',
                      x: 300, y: 515, w: 250, h: 65, dwell: MENU_DWELL.toggle, action: () => cyclePracticeSpeed() },
                    { id: 'start', label: 'START', icon: 'start', layout: 'strip', color: '#5dff8f', keepLocked: true, x: 600, y: 515, w: 170, h: 65, dwell: MENU_DWELL.sub, action: () => startPractice() },
                    back('practice')
                ])
            };
        case 'controls': {
            const pads = [];
            const rows = [['up', 'MOVE UP'], ['down', 'MOVE DOWN'], ['left', 'MOVE LEFT'], ['right', 'MOVE RIGHT'], ['dash', 'DASH']];
            [['p1', 60], ['p2', 440]].forEach(([who, x0]) => rows.forEach(([act, label], i) => pads.push({
                id: `${who}_${act}`, label, layout: 'key', color: who === 'p1' ? '#4da6ff' : '#ff9f43', keepLocked: true,
                subFn: () => (rebind.active && rebind.who === who && rebind.action === act ? 'PRESS A KEY...' : keyLabel(bindings[who][act])),
                x: x0, y: 150 + i * 66, w: 300, h: 56, dwell: MENU_DWELL.toggle,
                action: () => { rebind.active = true; rebind.who = who; rebind.action = act; held.clear(); }
            })));
            pads.push({ id: 'reset', label: 'RESET DEFAULTS', layout: 'strip', color: '#ff8a8a', keepLocked: true, x: 300, y: 530, w: 260, h: 60, dwell: MENU_DWELL.sub, action: () => resetBindings() });
            pads.push(back('main'));
            return {
                title: 'CONTROLS', hint: 'Hold on a key, then press the new key (Esc cancels). Used keys swap.', spawn: { x: 400, y: 492 }, parent: 'main',
                draw: () => {
                    hudText('PLAYER 1', 210, 130, '#4da6ff', 16, 'center');
                    hudText('PLAYER 2', 590, 130, '#ff9f43', 16, 'center');
                },
                pads
            };
        }
        default:
            return {
                title: 'LIGHT SHUTTLE', hint: 'Move onto a mode and hold to select', spawn: { x: 400, y: 495 }, parent: null,
                pads: [
                    { id: 'normal', label: 'NORMAL', sub: '8 hits, rising difficulty, heal by dodging', icon: 'normal', iris: true, color: '#4dd2ff', x: 30, y: 150, w: 170, h: 250, dwell: MENU_DWELL.mode, extra: () => `BEST ${highScores.normal}s`, action: () => transitionTo(() => initGame('normal'), { iris: true }) },
                    { id: 'hitless', label: 'HITLESS', sub: 'One hit ends the run. 4 slots, all attacks', icon: 'hitless', iris: true, color: '#ff6b6b', x: 220, y: 150, w: 170, h: 250, dwell: MENU_DWELL.mode, extra: () => `BEST ${highScores.hitless}s`, action: () => transitionTo(() => initGame('hitless'), { iris: true }) },
                    { id: 'duel', label: '1 VS 1', sub: 'Two players, one screen. Dash into your rival to hurt them', icon: 'duel', iris: true, color: '#ff9f43', x: 410, y: 150, w: 170, h: 250, dwell: MENU_DWELL.mode, extra: () => 'P1 WASD  P2 ARROWS', action: () => transitionTo(() => initGame('1v1'), { iris: true }) },
                    { id: 'practice', label: 'PRACTICE', sub: 'Tutorial, pattern library and custom practice', icon: 'practice', color: '#ffd24d', x: 600, y: 150, w: 170, h: 250, dwell: MENU_DWELL.gateway, action: () => goHub('practice') },
                    { id: 'controls', label: 'CONTROLS', sub: 'change keybinds', icon: 'controls', layout: 'strip', color: '#8d93a5', keepLocked: true, x: 300, y: 530, w: 200, h: 60, dwell: MENU_DWELL.sub, action: () => goHub('controls') }
                ]
            };
    }
}

function toggleCustom(id) {
    if (customSel.has(id)) customSel.delete(id);
    else customSel.add(id);
    try {
        localStorage.setItem('customPractice', JSON.stringify([...customSel]));
    } catch (e) {
        // storage unavailable, ignore
    }
}

function distToRect(px, py, r) {
    const dx = Math.max(r.x - px, 0, px - (r.x + r.w));
    const dy = Math.max(r.y - py, 0, py - (r.y + r.h));
    return Math.hypot(dx, dy);
}

function updateMenu() {
    if (!hub) return;
    if (menu.msgTimer > 0) menu.msgTimer--;
    const cx = player.x + player.width / 2 - HUB_OX;
    const cy = player.y + player.height / 2 - HUB_OY;

    for (const pad of hub.pads) {
        const d = distToRect(cx, cy, pad);
        pad.near = d < 70; // visual hint only
        pad.inside = d <= 6; // generous hitbox: on the pad or just at its edge
        const id = pad.id;
        if (transition.active) continue;

        if (menu.locked[id]) {
            menu.progress[id] = 0;
            if (!pad.inside) menu.locked[id] = false; // must step off before it can fire again
            continue;
        }
        if (pad.inside) menu.progress[id] = (menu.progress[id] || 0) + 1;
        else menu.progress[id] = Math.max(0, (menu.progress[id] || 0) - 4);

        if (menu.progress[id] >= pad.dwell) {
            menu.progress[id] = 0;
            if (pad.toggle || pad.keepLocked) menu.locked[id] = true;
            playSound('heal', 0.5, 1.1);
            pad.action();
            break;
        }
    }
}

/* ==========================================================================
   LESSONS
   ========================================================================== */

function startLesson(id) {
    transitionTo(() => startLessonNow(id));
}

function restartLesson() {
    startLesson(LESSONS[lesson.index].id);
}

function nextLesson(dir) {
    const i = (lesson.index + dir + LESSONS.length) % LESSONS.length;
    startLesson(LESSONS[i].id);
}

function startLessonNow(id) {
    const index = LESSONS.findIndex(l => l.id === id);
    const data = LESSONS[index];
    lesson.index = index;
    gameState = 'lesson';
    gameRunning = false;
    gameMode = 'normal';
    twoPlayer = false;
    seedRandom(data.seed || 1234); // the demo is repeatable

    resetPlayer(8);
    player.x = data.start.x;
    player.y = data.start.y;
    clearBullets();
    resetLoader();
    bulletHell.gameTime = 0;
    bulletHell.difficulty = 1;
    resetPatternRuntime();
    practice.hits = 0;

    lesson.phase = 'demo';
    lesson.t = 0;
    lesson.endTimer = 0;
    lesson.demoHits = 0;
    lesson.streak = 0;
    lesson.cycles = 0;
    lesson.cycleActive = false;
    lesson.cooldown = 0;
    lesson.demoKeys = emptyKeys();
    lesson.scriptedDash = false;

    const def = patternById(data.pattern);
    lesson.entry = queueEntry(def, data.plan || planPattern(def), LESSON_LEAD);
}

function runDemoScript(data) {
    const pressed = emptyKeys();
    for (const ev of data.demo) {
        if (lesson.t >= ev.t && lesson.t < ev.t + (ev.dur || 1)) {
            (ev.keys || []).forEach(k => { pressed[k] = true; });
        }
        if (ev.dash && lesson.t === ev.t) lesson.scriptedDash = true;
    }
    lesson.demoKeys = pressed;
}

function startLessonCycle(data) {
    loader.batch = loader.batch.filter(e => !e.fired);
    const def = patternById(data.pattern);
    lesson.entry = queueEntry(def, planPattern(def), LESSON_LEAD);
    lesson.cycleActive = true;
    lesson.cycleHits0 = practice.hits;
}

function updateLesson() {
    const data = LESSONS[lesson.index];
    lesson.t++;
    if (lesson.phase === 'demo') runDemoScript(data);

    updatePlayer();
    updateBulletHell();
    updateProjectiles();
    updateGhosts();

    if (lesson.phase === 'demo') {
        if (lesson.entry.fired && fieldClear() && lesson.t > LESSON_LEAD) lesson.endTimer++;
        else lesson.endTimer = 0;
        if (lesson.endTimer > 40 || lesson.t > 1200) {
            lesson.demoHits = practice.hits;
            lesson.phase = 'try'; // now it is the player's turn, with true randomness
            unseedRandom();
            practice.hits = 0;
            lesson.cooldown = 45;
            lesson.cycleActive = false;
        }
        return;
    }

    if (!lesson.cycleActive) {
        lesson.cooldown--;
        if (lesson.cooldown <= 0 && fieldClear()) startLessonCycle(data);
    } else if (lesson.entry.fired && fieldClear()) {
        lesson.cycleActive = false;
        lesson.cooldown = 75;
        lesson.cycles++;
        if (practice.hits === lesson.cycleHits0) lesson.streak++;
        else lesson.streak = 0;
    }
}

/* ==========================================================================
   TUTORIAL
   ========================================================================== */

function startTutorial() {
    transitionTo(() => {
        gameState = 'tutorial';
        gameRunning = false;
        gameMode = 'normal';
        twoPlayer = false;
        unseedRandom();
        resetPlayer(8);
        practice.hits = 0;
        tutorial.moved = 0;
        tutorial.dashes = 0;
        startTutorialStep(0);
    });
}

function startTutorialStep(i) {
    tutorial.step = i;
    tutorial.t = 0;
    tutorial.settle = 0;
    tutorial.hits0 = practice.hits;
    tutorial.lastX = player.x;
    tutorial.lastY = player.y;
    clearBullets();
    resetLoader();
    bulletHell.gameTime = 0;
    bulletHell.difficulty = 1;
    resetPatternRuntime();
    const step = TUTORIAL_STEPS[i];
    tutorial.entries = (step.attack || []).map(a => {
        const def = patternById(a.id);
        return queueEntry(def, a.plan || planPattern(def), a.delay);
    });
}

function advanceTutorial() {
    if (tutorial.step + 1 < TUTORIAL_STEPS.length) startTutorialStep(tutorial.step + 1);
    else goHub('practice');
}

function tutorialEnter() {
    if (TUTORIAL_STEPS[tutorial.step].enter) advanceTutorial();
}

function tutorialSkip() {
    advanceTutorial();
}

function updateTutorial() {
    tutorial.t++;
    if (tutorial.msgTimer > 0) tutorial.msgTimer--;
    updatePlayer();
    updateBulletHell();
    updateProjectiles();
    updateGhosts();

    tutorial.moved += Math.hypot(player.x - tutorial.lastX, player.y - tutorial.lastY);
    tutorial.lastX = player.x;
    tutorial.lastY = player.y;

    const step = TUTORIAL_STEPS[tutorial.step];
    if (step.attack) {
        if (tutorial.entries.every(e => e.fired) && fieldClear()) {
            tutorial.settle++;
            if (tutorial.settle > 45) {
                if (step.clean && practice.hits > tutorial.hits0) {
                    tutorial.msg = 'You were hit - try that one again!';
                    tutorial.msgTimer = 120;
                    startTutorialStep(tutorial.step);
                } else {
                    advanceTutorial();
                }
            }
        } else {
            tutorial.settle = 0;
        }
    } else if (step.ok) {
        if (step.ok()) {
            tutorial.settle++;
            if (tutorial.settle > 25) advanceTutorial();
        }
    }
}

/* ==========================================================================
   GAME LOOP (fixed timestep, independent of monitor size and refresh rate)
   ========================================================================== */

let rafId = 0;
let lastFrameTs = 0;
let accumulator = 0; // simulation clock
let uiAccumulator = 0; // UI clock
let loopActive = false;

/* ---------- Progressive game speed: ONE central multiplier ----------
   The whole simulation (player, bullets, pattern timing, cooldowns, timers) is
   advanced in fixed ticks; the multiplier only changes how many ticks run per
   real second. Nothing else scales, so nothing can drift out of step.
   Speed = (1 + rate) ^ minutes, i.e. multiplicative per minute.              */

const SPEED_RATE = { normal: 0.05, hitless: 0.01, '1v1': 0.05 }; // per minute
const SPEED_CAP = 4; // keeps very long runs playable
const PRACTICE_SPEED_OPTIONS = [0, 0.02, 0.05, 0.10];
let practiceSpeedRate = 0;
try {
    const saved = Number(localStorage.getItem('practiceSpeedRate'));
    if (PRACTICE_SPEED_OPTIONS.includes(saved)) practiceSpeedRate = saved;
} catch (e) {
    // storage unavailable, ignore
}
const run = { realMs: 0 }; // real time spent in the current run / practice session

function currentSpeedRate() {
    if (gameState === 'playing') return SPEED_RATE[gameMode] || 0;
    if (gameState === 'practice') return practiceSpeedRate; // 0 by default, never inherits Normal's
    return 0;
}

function simSpeed() {
    const rate = currentSpeedRate();
    if (!rate) return 1;
    return Math.min(SPEED_CAP, Math.pow(1 + rate, run.realMs / 60000));
}

function cyclePracticeSpeed() {
    const i = PRACTICE_SPEED_OPTIONS.indexOf(practiceSpeedRate);
    practiceSpeedRate = PRACTICE_SPEED_OPTIONS[(i + 1) % PRACTICE_SPEED_OPTIONS.length];
    try {
        localStorage.setItem('practiceSpeedRate', String(practiceSpeedRate));
    } catch (e) {
        // storage unavailable, ignore
    }
}

// UI clock: menus, fades and animations always run in real time
function updateUi() {
    menu.t++;
    updateTransition();
}

// Simulation tick (scaled by simSpeed() in the loop)
function updateGame() {
    switch (gameState) {
        case 'title':
        case 'over':
            break;
        case 'menu':
            // Bullet-free hub: only the player moves
            updatePlayer();
            updateMenu();
            break;
        case 'lesson':
            updateLesson();
            break;
        case 'tutorial':
            updateTutorial();
            break;
        default: // 'playing' and 'practice'
            activePlayers().forEach(pl => updatePlayer(pl));
            activePlayers().forEach(pl => updateCamping(pl));
            checkRam();
            updateBulletHell();
            updateProjectiles();
            updateMinions();
            updateGhosts();
            if (gameState === 'practice') practice.t++;
            // Score is simulation time, so it is not affected by tab throttling
            // (simulation time is read directly from bulletHell.gameTime)
            break;
    }
}

function gameLoop(ts) {
    if (!loopActive) {
        rafId = 0;
        return;
    }
    rafId = requestAnimationFrame(gameLoop);

    if (!lastFrameTs) lastFrameTs = ts;
    const dt = Math.min(ts - lastFrameTs, 250); // clamp long pauses (hidden tab)
    lastFrameTs = ts;

    // UI clock (real time, never accelerated)
    uiAccumulator += dt;
    let uiSteps = 0;
    while (uiAccumulator >= TICK_MS && uiSteps < MAX_CATCHUP_STEPS) {
        updateUi();
        uiAccumulator -= TICK_MS;
        uiSteps++;
    }
    if (uiSteps === MAX_CATCHUP_STEPS) uiAccumulator = 0;

    // Simulation clock: the single speed multiplier is applied exactly once, here
    if (gameState === 'playing' || gameState === 'practice') run.realMs += dt;
    accumulator += dt * simSpeed();
    let steps = 0;
    while (accumulator >= TICK_MS && steps < MAX_CATCHUP_STEPS && loopActive) {
        updateGame();
        accumulator -= TICK_MS;
        steps++;
    }
    if (steps === MAX_CATCHUP_STEPS) accumulator = 0; // drop the backlog instead of spiralling

    render();
}

function ensureLoop() {
    // Exactly one loop: never start a second one on top of a running loop
    if (!rafId) {
        lastFrameTs = 0;
        accumulator = 0;
        uiAccumulator = 0;
        rafId = requestAnimationFrame(gameLoop);
    }
}

/* ==========================================================================
   GAME LIFECYCLE
   ========================================================================== */

function initAudio() {
    try {
        const ac = getAudioContext();
        if (ac.state === 'suspended') {
            ac.resume();
        }
        if (Object.keys(sounds).length === 0) {
            initSounds();
            playSound('background', 0.3);
        }
    } catch (e) {
        console.warn('Error initializing game:', e);
    }
}

// Reset player properties (0.75 of original size)
function resetPlayer(maxHits, pl = player) {
    pl.x = PLAY_W / 2 - 11;
    pl.y = PLAY_H / 2 - 11;
    pl.width = 22.5 * ENTITY_SCALE;
    pl.height = 22.5 * ENTITY_SCALE;
    pl.speed = 5;
    pl.isDashing = false;
    pl.ramDone = false;
    pl.dashCooldown = 0;
    pl.dashDuration = 10;
    pl.dashTimer = 0;
    pl.dashGrace = 0;
    pl.dashSpeed = 15;
    pl.isImmune = false;
    pl.immunityTimer = 0;
    pl.isVisible = true;
    pl.maxHits = maxHits;
    pl.hitsRemaining = maxHits;
    pl.direction = { x: 0, y: 0 };
    pl.dashDirection = { x: 1, y: 0 };
    pl.facing = 0;
    pl.vx = 0;
    pl.vy = 0;
    pl.healTimer = 0;
    pl.noHitTimer = 0;
    pl.camp = 0;
    pl.campStrikes = 0;
}

function clearBullets() {
    projectiles = [];
    bulletHell.sparks.length = 0;
    ghosts.length = 0;
    pops.length = 0;
    bulletHell.impact = null;
    bulletHell.lasers = [];
    bulletHell.sniperWarnings = [];
}

function startFromTitle() {
    initAudio();
    transitionTo(() => enterHub('main'));
}

function goHub(screen) {
    transitionTo(() => enterHub(screen));
}

function enterHub(screen) {
    gameState = 'menu';
    gameRunning = false;
    twoPlayer = false;
    unseedRandom();
    menu.screen = screen;
    hub = buildHub(screen);
    menu.progress = {};
    menu.locked = {};
    menu.msg = '';
    menu.msgTimer = 0;
    resetPlayer(8);
    player.x = hub.spawn.x + HUB_OX - player.width / 2;
    player.y = hub.spawn.y + HUB_OY;
    clearBullets();
    resetLoader();
}

// Start a scored run in the given mode
function initGame(mode = 'normal') {
    // Never start a run on top of a running one
    if (gameState === 'playing') return;
    gameState = 'playing';
    gameRunning = true;
    gameMode = mode === 'hitless' ? 'hitless' : mode === '1v1' ? '1v1' : 'normal';
    twoPlayer = gameMode === '1v1';
    unseedRandom();

    initAudio();
    resetPlayer(gameMode === 'hitless' ? 1 : 8); // hitless: one hit ends the run
    if (twoPlayer) {
        // Player 1 starts on the left, Player 2 on the right, facing each other
        resetPlayer(8, player2);
        player.x = PLAY_W * 0.25 - player.width / 2;
        player2.x = PLAY_W * 0.75 - player2.width / 2;
        player.y = player2.y = PLAY_H / 2 - 11;
        player.facing = 0;
        player2.facing = Math.PI;
        player2.dashDirection = { x: -1, y: 0 };
        ramCooldown = 0;
    }

    run.realMs = 0;
    gameStartTime = performance.now();
    clearBullets();
    bulletHell.gameTime = 0;
    bulletHell.difficulty = 1;
    bulletHell.lastPatternTime = 0;
    resetPatternRuntime();
    resetLoader();
    loadBatch(0); // first batch is announced right away
}

function retryRun() {
    transitionTo(() => initGame(gameMode));
}

// Custom Practice: the same loader, restricted to the chosen patterns
function startPractice() {
    if (customSel.size === 0) {
        menu.msg = 'Switch on at least one attack first';
        menu.msgTimer = 150;
        return;
    }
    transitionTo(() => {
        gameState = 'practice';
        gameRunning = false;
        gameMode = 'normal';
        twoPlayer = false;
        unseedRandom();
        resetPlayer(8);
        clearBullets();
        resetLoader();
        bulletHell.gameTime = 0;
        bulletHell.difficulty = 1;
        resetPatternRuntime();
        practice.hits = 0;
        practice.t = 0;
        run.realMs = 0;
        loadPracticeBatch(0); // random selector, no cooldowns
    });
}

// Show game over screen
function showGameOver() {
    gameRunning = false;
    gameState = 'over';
    survivalTime = Math.floor(run.realMs / 1000); // real seconds survived

    if (DEBUG) {
        console.log('[debug] wall clock seconds', Math.floor((performance.now() - gameStartTime) / 1000),
            'sim seconds', Math.floor(bulletHell.gameTime / TICK_RATE));
    }

    if (gameMode === '1v1') {
        const p1Dead = player.hitsRemaining <= 0;
        const p2Dead = player2.hitsRemaining <= 0;
        lastRun = { mode: '1v1', time: survivalTime, best: 0, winner: p1Dead && p2Dead ? 0 : p1Dead ? 2 : 1 };
        return;
    }

    if (survivalTime > highScores[gameMode]) {
        highScores[gameMode] = survivalTime;
        try {
            localStorage.setItem(gameMode === 'hitless' ? 'highScoreHitless' : 'highScore', highScores[gameMode]);
        } catch (e) {
            // storage unavailable, ignore
        }
    }
    lastRun = { mode: gameMode, time: survivalTime, best: highScores[gameMode] };
}

// Check game over
function checkGameOver() {
    if (!gameRunning || gameState !== 'playing') return;
    if (activePlayers().some(pl => pl.hitsRemaining <= 0)) {
        showGameOver();
    }
}

/* ==========================================================================
   INPUT (keyboard + mouse)
   ========================================================================== */

// Returns true when the key was a menu / screen command
function handleUiKey(e, key) {
    switch (gameState) {
        case 'title':
            if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'].includes(e.key)) return false;
            startFromTitle();
            return true;
        case 'over':
            if (e.key === 'Enter' || key === 'r') { retryRun(); return true; }
            if (e.key === 'Escape' || key === 'm') { goHub('main'); return true; }
            return false;
        case 'menu':
            if ((e.key === 'Escape' || e.key === 'Backspace') && hub && hub.parent) { goHub(hub.parent); return true; }
            return false;
        case 'practice':
            if (e.key === 'Escape') { goHub('custom'); return true; }
            return false;
        case 'lesson':
            if (key === 'r') { restartLesson(); return true; }
            if (key === 'n') { nextLesson(1); return true; }
            if (key === 'p') { nextLesson(-1); return true; }
            if (e.key === 'Escape' || e.key === 'Backspace' || key === 'b') { goHub('library'); return true; }
            return false;
        case 'tutorial':
            if (e.key === 'Escape' || e.key === 'Backspace') { goHub('practice'); return true; }
            if (e.key === 'Enter') { tutorialEnter(); return true; }
            if (key === 'n') { tutorialSkip(); return true; }
            return false;
        default:
            return false;
    }
}

function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    const px = ((e.clientX - r.left) * canvas.width) / r.width;
    const py = ((e.clientY - r.top) * canvas.height) / r.height;
    return { x: (px - view.ox) / view.scale, y: (py - view.oy) / view.scale };
}

function onCanvasClick(e) {
    const p = canvasPoint(e);
    for (const b of currentButtons()) {
        if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
            b.action();
            break;
        }
    }
}

function onCanvasMove(e) {
    const p = canvasPoint(e);
    pointer.x = p.x;
    pointer.y = p.y;
}

// Boot: runs once React has rendered the canvas
function bootLightShuttle() {
    canvas = document.getElementById('game-canvas');
    if (!canvas) return undefined;
    ctx = canvas.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    canvas.addEventListener('click', onCanvasClick);
    canvas.addEventListener('mousemove', onCanvasMove);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onWindowBlur);

    gameState = 'title';
    gameRunning = false;
    hub = null;
    transition.active = false;
    loopActive = true;
    render();
    ensureLoop();

    // Cleanup (also keeps React StrictMode's double-mount from duplicating loops)
    return () => {
        loopActive = false;
        cancelAnimationFrame(rafId);
        rafId = 0;
        canvas.removeEventListener('click', onCanvasClick);
        canvas.removeEventListener('mousemove', onCanvasMove);
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('blur', onWindowBlur);
        window.removeEventListener('resize', resizeCanvas);
    };
}

/* ==========================================================================
   REACT SHELL
   ========================================================================== */

function App() {
    useEffect(() => bootLightShuttle(), []);

    return (
        <div id="game-container">
            <canvas id="game-canvas" width={CANVAS_W} height={CANVAS_H} />
        </div>
    );
}

export default App;
