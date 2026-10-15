/* =====================================================================
   Wedding Survivor — game.js
   Vanilla JavaScript + HTML5 Canvas. No build step, no dependencies.

   Sections
     1. Utilities
     2. Sound (Web Audio API: sound effects + a looping chiptune)
     3. World data (zones, doors, walls, furniture, spawns, events)
     4. Characters (player archetypes, NPC types, looks)
     5. Sprites (pixel-art drawing for people, items and furniture)
     6. Game state
     7. Input (keyboard + touch)
     8. Update (player, NPC AI, items, events)
     9. Render (venue, actors, overlays, minimap)
    10. HUD & screens
    11. Boot
   ===================================================================== */
'use strict';

(function () {
  // ===================================================================
  // 1. Utilities
  // ===================================================================
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const inRect = (p, r) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

  function angleDiff(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  /** Small deterministic PRNG so the static venue art looks the same every load. */
  function seeded(seed) {
    return function () {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Multiply a #rrggbb color's channels by f (f < 1 darkens, f > 1 lightens). */
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const r = clamp(Math.round(((n >> 16) & 255) * f), 0, 255);
    const g = clamp(Math.round(((n >> 8) & 255) * f), 0, 255);
    const b = clamp(Math.round((n & 255) * f), 0, 255);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ }
  }

  const reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const $ = (id) => document.getElementById(id);

  // ===================================================================
  // 2. Sound
  // ===================================================================
  const Sound = (function () {
    let ac = null, master = null, musicBus = null, sfxBus = null, noiseBuf = null;
    let muted = storageGet('ws-muted') === '1';
    let timer = null, step = 0, nextTime = 0, intensity = 1;

    // A freylekhs-style tune in D Phrygian dominant (the "Hava Nagila" scale).
    // Values are semitones above D4; null is a rest. 32 eighth-note steps.
    const MELODY = [0, 4, 7, 4, 5, 4, 1, 0, 5, 5, 8, 7, 5, 4, 1, null,
      10, 8, 7, 5, 4, 5, 7, 8, 7, 5, 4, 1, 0, null, 0, null];
    // Bass root per half bar (every 4 steps), in semitones above D2.
    const BASS = [0, 5, -2, 0, 0, 5, -2, 0];

    function init() {
      if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { ac = new AC(); } catch (e) { ac = null; return; }
      master = ac.createGain();
      master.gain.value = muted ? 0 : 0.55;
      master.connect(ac.destination);
      musicBus = ac.createGain(); musicBus.gain.value = 0.2; musicBus.connect(master);
      sfxBus = ac.createGain(); sfxBus.gain.value = 0.45; sfxBus.connect(master);
      noiseBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.6), ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }

    /** One oscillator note with a short attack and exponential decay. */
    function tone(freq, dur, opt) {
      if (!ac) return;
      const o = opt || {};
      const t = o.at != null ? o.at : ac.currentTime + (o.delay || 0);
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = o.type || 'square';
      osc.frequency.setValueAtTime(freq, t);
      if (o.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + o.slide), t + dur);
      const v = o.vol == null ? 0.3 : o.vol;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g); g.connect(o.bus || sfxBus);
      osc.start(t); osc.stop(t + dur + 0.03);
    }

    /** A filtered white-noise burst (hats, snares, camera flash, glass). */
    function noise(dur, opt) {
      if (!ac) return;
      const o = opt || {};
      const t = o.at != null ? o.at : ac.currentTime + (o.delay || 0);
      const src = ac.createBufferSource();
      src.buffer = noiseBuf;
      const f = ac.createBiquadFilter();
      f.type = o.filter || 'highpass';
      f.frequency.value = o.freq || 4000;
      const g = ac.createGain();
      const v = o.vol == null ? 0.2 : o.vol;
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f); f.connect(g); g.connect(o.bus || sfxBus);
      src.start(t); src.stop(t + dur + 0.02);
    }

    const SFX = {
      eat() { tone(520, 0.07, { vol: 0.25 }); tone(780, 0.09, { vol: 0.22, delay: 0.06 }); },
      drink() {
        tone(320, 0.12, { type: 'triangle', slide: -140, vol: 0.35 });
        tone(300, 0.12, { type: 'triangle', slide: -140, vol: 0.3, delay: 0.12 });
      },
      water() { tone(880, 0.1, { type: 'sine', vol: 0.25 }); tone(1320, 0.12, { type: 'sine', vol: 0.18, delay: 0.07 }); },
      hug() { tone(150, 0.35, { slide: -70, vol: 0.35 }); noise(0.2, { filter: 'lowpass', freq: 600, vol: 0.25 }); },
      blip() { tone(rand(280, 520), 0.05, { vol: 0.12 }); },
      escape() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.08, { vol: 0.2, delay: i * 0.05 })); },
      alert() { tone(880, 0.08, { vol: 0.22 }); tone(1175, 0.12, { vol: 0.22, delay: 0.08 }); },
      flash() { noise(0.35, { freq: 3000, vol: 0.4 }); tone(1800, 0.25, { type: 'sine', slide: -1200, vol: 0.2 }); },
      dodge() { tone(660, 0.07, { vol: 0.2 }); tone(990, 0.1, { vol: 0.2, delay: 0.06 }); },
      cheers() { [784, 988, 1175].forEach((f, i) => tone(f, 0.1, { type: 'triangle', vol: 0.25, delay: i * 0.06 })); },
      event() { [392, 523, 659, 784].forEach((f, i) => tone(f, 0.14, { type: 'triangle', vol: 0.3, delay: i * 0.11 })); },
      glass() {
        noise(0.5, { freq: 5000, vol: 0.45 });
        [2400, 3100, 2700].forEach((f, i) => tone(f, 0.25, { type: 'triangle', vol: 0.12, delay: i * 0.04 }));
      },
      win() { [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.18, { vol: 0.22, delay: i * 0.12 })); },
      lose() { [440, 392, 330, 262].forEach((f, i) => tone(f, 0.25, { type: 'triangle', vol: 0.3, delay: i * 0.18 })); },
      click() { tone(1200, 0.03, { vol: 0.12 }); },
    };

    function sfx(name) {
      if (!ac || muted) return;
      const fn = SFX[name];
      if (fn) fn();
    }

    /** Look-ahead scheduler: queues notes ~150 ms ahead so timing stays tight. */
    function schedule() {
      if (!ac) return;
      const bpm = intensity === 2 ? 140 : intensity === 0 ? 84 : 112;
      const sd = 60 / bpm / 2; // eighth note
      if (nextTime < ac.currentTime) nextTime = ac.currentTime + 0.02;
      while (nextTime < ac.currentTime + 0.15) {
        const s = step % 32;
        const m = MELODY[s];
        if (m !== null) {
          tone(293.66 * Math.pow(2, m / 12), sd * 0.85, {
            at: nextTime, type: intensity === 0 ? 'triangle' : 'square',
            vol: intensity === 0 ? 0.18 : 0.1, bus: musicBus,
          });
        }
        if (s % 4 === 0) {
          tone(73.42 * Math.pow(2, BASS[s / 4] / 12), sd * 3.5, { at: nextTime, type: 'triangle', vol: 0.4, bus: musicBus });
        }
        if (intensity >= 1 && s % 2 === 1) noise(0.03, { at: nextTime, freq: 7000, vol: 0.08, bus: musicBus });
        if (intensity === 2 && s % 4 === 0) tone(150, 0.16, { at: nextTime, type: 'sine', slide: -105, vol: 0.8, bus: musicBus });
        if (intensity === 2 && s % 8 === 4) noise(0.12, { at: nextTime, freq: 1800, vol: 0.22, bus: musicBus });
        nextTime += sd;
        step++;
      }
    }

    function startMusic() {
      if (!ac || timer) return;
      nextTime = ac.currentTime + 0.06;
      timer = setInterval(schedule, 30);
    }
    function stopMusic() {
      if (timer) { clearInterval(timer); timer = null; }
    }
    function setIntensity(n) { intensity = n; }
    function toggleMute() {
      muted = !muted;
      storageSet('ws-muted', muted ? '1' : '0');
      if (master) master.gain.value = muted ? 0 : 0.55;
      return muted;
    }

    return { init, sfx, startMusic, stopMusic, setIntensity, toggleMute, isMuted: () => muted };
  })();

  // ===================================================================
  // 3. World data
  // ===================================================================
  const WORLD_W = 2000;
  const WORLD_H = 1400;
  const WALL = 20;
  const NIGHT_SECONDS = 300;            // real seconds from 19:30 to 02:00
  const START_MIN = 19 * 60 + 30;
  const END_MIN = 26 * 60;              // 02:00 the next morning

  const ZONES = [
    { id: 'reception', name: 'Reception', he: 'קבלת פנים', x: 0, y: 0, w: 960, h: 620, map: '#c9b48f' },
    { id: 'chuppah', name: 'Chuppah', he: 'חופה', x: 960, y: 0, w: 1040, h: 620, map: '#5d9a55' },
    { id: 'bar', name: 'Bar & Restrooms', he: 'בר ושירותים', x: 0, y: 620, w: 2000, h: 180, map: '#7a5136' },
    { id: 'dining', name: 'Dining Hall', he: 'שולחנות', x: 0, y: 800, w: 1040, h: 600, map: '#6b1f35' },
    { id: 'dance', name: 'Dance Floor', he: 'רחבת ריקודים', x: 1040, y: 800, w: 960, h: 600, map: '#3a2a55' },
  ];
  const ZONE_BY_ID = {};
  ZONES.forEach((z) => { ZONE_BY_ID[z.id] = z; });

  function zoneAt(x, y) {
    for (const z of ZONES) {
      if (x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) return z;
    }
    return ZONES[0];
  }

  // Doorways between zones. (x, y) is the center of the gap in the wall.
  const DOORS = [
    { a: 'reception', b: 'chuppah', x: 960, y: 310, vertical: true },
    { a: 'reception', b: 'bar', x: 470, y: 620, vertical: false },
    { a: 'chuppah', b: 'bar', x: 1490, y: 620, vertical: false },
    { a: 'bar', b: 'dining', x: 510, y: 800, vertical: false },
    { a: 'bar', b: 'dance', x: 1540, y: 800, vertical: false },
    { a: 'dining', b: 'dance', x: 1040, y: 1100, vertical: true },
  ];

  /** A waypoint 44px in front of a door, on the given zone's side. */
  function doorSide(door, zoneId) {
    const z = ZONE_BY_ID[zoneId];
    const cx = z.x + z.w / 2, cy = z.y + z.h / 2;
    if (door.vertical) return { x: door.x + (cx < door.x ? -44 : 44), y: door.y };
    return { x: door.x, y: door.y + (cy < door.y ? -44 : 44) };
  }

  // NEXT[from][to] = the first door to walk through (breadth-first search on the zone graph).
  const NEXT = {};
  (function buildNav() {
    for (const s of ZONES) {
      NEXT[s.id] = {};
      const prev = {};
      prev[s.id] = null;
      const queue = [s.id];
      while (queue.length) {
        const z = queue.shift();
        for (const d of DOORS) {
          const other = d.a === z ? d.b : d.b === z ? d.a : null;
          if (other && !(other in prev)) { prev[other] = { z, d }; queue.push(other); }
        }
      }
      for (const t of ZONES) {
        if (t.id === s.id) continue;
        let cur = t.id, stepInfo = null;
        while (prev[cur]) {
          stepInfo = prev[cur];
          if (stepInfo.z === s.id) break;
          cur = stepInfo.z;
        }
        NEXT[s.id][t.id] = stepInfo ? stepInfo.d : null;
      }
    }
  })();

  // ---- Walls & furniture (everything solid lives in SOLIDS) ----
  const SOLIDS = [];
  const FURN = [];

  function addWallH(y, x0, x1, gaps) {
    let c = x0;
    for (const [a, b] of gaps) {
      if (a > c) SOLIDS.push({ x: c, y: y - WALL / 2, w: a - c, h: WALL, kind: 'wall' });
      c = b;
    }
    if (c < x1) SOLIDS.push({ x: c, y: y - WALL / 2, w: x1 - c, h: WALL, kind: 'wall' });
  }
  function addWallV(x, y0, y1, gaps) {
    let c = y0;
    for (const [a, b] of gaps) {
      if (a > c) SOLIDS.push({ x: x - WALL / 2, y: c, w: WALL, h: a - c, kind: 'wall' });
      c = b;
    }
    if (c < y1) SOLIDS.push({ x: x - WALL / 2, y: c, w: WALL, h: y1 - c, kind: 'wall' });
  }

  SOLIDS.push(
    { x: 0, y: 0, w: WORLD_W, h: WALL, kind: 'wall' },
    { x: 0, y: WORLD_H - WALL, w: WORLD_W, h: WALL, kind: 'wall' },
    { x: 0, y: 0, w: WALL, h: WORLD_H, kind: 'wall' },
    { x: WORLD_W - WALL, y: 0, w: WALL, h: WORLD_H, kind: 'wall' }
  );
  addWallH(620, 0, WORLD_W, [[380, 560], [1400, 1580]]);
  addWallH(800, 0, WORLD_W, [[420, 600], [1440, 1640]]);
  addWallV(960, 0, 620, [[240, 380]]);
  addWallV(1040, 800, WORLD_H, [[1030, 1170]]);

  function F(kind, x, y, w, h, extra) {
    const f = Object.assign({ kind, x, y, w, h, solid: true }, extra || {});
    FURN.push(f);
    if (f.solid) SOLIDS.push(f);
    return f;
  }
  function roundTable(kind, cx, cy, r) {
    return F(kind, cx - r * 0.8, cy - r * 0.8, r * 1.6, r * 1.6, { cx, cy, r });
  }

  // Reception
  F('station', 320, 36, 240, 34, { label: 'Finger food', he: 'פינגר פוד' });
  F('station', 34, 250, 34, 200, { vertical: true });
  [[180, 180], [600, 170], [760, 330], [250, 430], [560, 450]].forEach(([x, y]) => roundTable('cocktail', x, y, 20));
  F('gifts', 820, 520, 70, 44);
  // Chuppah
  F('post', 1400, 70, 10, 10); F('post', 1550, 70, 10, 10);
  F('post', 1400, 180, 10, 10); F('post', 1550, 180, 10, 10);
  [270, 340, 410, 480].forEach((y) => { F('bench', 1060, y, 320, 16, { side: 'L' }); F('bench', 1600, y, 320, 16, { side: 'R' }); });
  // Bar & restrooms corridor
  F('bar', 60, 634, 520, 28);
  F('cooler', 990, 636, 26, 24);
  F('sofa', 1740, 636, 180, 22);
  // Dining hall
  F('buffet', 110, 826, 290, 34, { label: 'Main course', he: 'מנה עיקרית' });
  F('dessert', 640, 826, 300, 34, { label: 'Desserts', he: 'קינוחים' });
  [1010, 1240].forEach((y) => [170, 400, 630, 860].forEach((x) => roundTable('table', x, y, 44)));
  // Dance hall
  const BOOTH = F('booth', 1850, 1020, 110, 130, { dynamic: true });
  F('speaker', 1870, 880, 40, 50);
  F('speaker', 1870, 1290, 40, 50);

  const DANCE_FLOOR = { x: 1150, y: 880, w: 640, h: 420 };
  const LOUNGE = { x: 1680, y: 632, w: 300, h: 156 };
  const CANOPY = { x: 1392, y: 60, w: 176, h: 132 };

  // Flower arrangements: stand still inside one to hide.
  const FLOWERS = [
    [120, 560], [880, 70], [470, 300],
    [1360, 110], [1600, 110], [1010, 570], [1950, 570],
    [800, 712], [1300, 712],
    [60, 1350], [990, 1350], [515, 1125],
    [1090, 1350], [1090, 860], [1960, 1360],
  ].map(([x, y], i) => ({ x, y, hue: i % 3 }));

  // ---- Food & drink ----
  const VARIANTS = {
    canape: [
      { n: 'Mini burger', he: 'מיני בורגר' }, { n: 'Sushi roll', he: 'סושי' },
      { n: 'Kebab skewer', he: 'שיפוד קבב' }, { n: 'Mushroom tart', he: 'טארט פטריות' },
    ],
    main: [
      { n: 'Schnitzel', he: 'שניצל' }, { n: 'Entrecôte', he: 'אנטריקוט' },
      { n: 'Grilled salmon', he: 'סלמון' }, { n: 'Stuffed peppers', he: 'פלפלים ממולאים' },
    ],
    dessert: [{ n: 'Malabi', he: 'מלבי' }, { n: 'Chocolate soufflé', he: 'סופלה' }, { n: 'Wedding cake', he: 'עוגת חתונה' }],
    drink: [{ n: 'Arak', he: 'ערק' }, { n: 'Red wine', he: 'יין אדום' }, { n: 'Chaser', he: "צ'ייסר" }, { n: 'Beer', he: 'בירה' }],
    water: [{ n: 'Cold water', he: 'מים קרים' }],
  };
  const RESPAWN = { canape: 10, main: 14, dessert: 16, drink: 9, water: 12 };

  const SPAWNS = [
    ...[345, 405, 465, 525].map((x) => ({ x, y: 88, kind: 'canape' })),
    ...[290, 350, 410].map((y) => ({ x: 88, y, kind: 'canape' })),
    ...[140, 200, 260, 320, 380].map((x) => ({ x, y: 878, kind: 'main' })),
    ...[670, 740, 810, 880].map((x) => ({ x, y: 878, kind: 'dessert' })),
    ...[100, 180, 260, 340, 420, 500].map((x) => ({ x, y: 682, kind: 'drink' })),
    { x: 990, y: 684, kind: 'water' }, { x: 1032, y: 684, kind: 'water' },
    { x: 1828, y: 1090, kind: 'drink' },
  ];

  // ---- The night's schedule ----
  const EVENTS = [
    { at: 19 * 60 + 30, id: 'arrival', title: 'Guests arriving', he: 'קבלת פנים', desc: 'Grab finger food in Reception. The buffet opens after the chuppah.' },
    { at: 20 * 60 + 30, id: 'ceremony', title: 'Chuppah ceremony', he: 'חופה', desc: 'Stand in the Chuppah area for points and calm. Relatives there sit quietly.' },
    { at: 21 * 60 + 5, id: 'dinner', title: 'Mazal tov! Dinner is served', he: 'ארוחת ערב', desc: 'The glass is broken. Main courses are out in the Dining Hall.' },
    { at: 22 * 60 + 15, id: 'dance1', title: 'First dance set', he: 'סט ראשון', desc: 'Dance-floor points x2. The crowd hides you. A second photographer arrives.' },
    { at: 23 * 60 + 45, id: 'shots', title: 'Chasers at the bar', he: "צ'ייסרים", desc: 'Drinks score double. Another uncle has found the arak.' },
    { at: 24 * 60 + 30, id: 'dance2', title: 'Mizrahi set', he: 'סט מזרחי', desc: 'Dance-floor points x2. Another aunt has questions.' },
    { at: 25 * 60 + 15, id: 'dessert', title: 'Desserts & last call', he: 'קינוחים', desc: 'Desserts refill fast. Hang on until 02:00.' },
  ];
  const EVENT_INDEX = {};
  EVENTS.forEach((e, i) => { EVENT_INDEX[e.id] = i; });

  // ===================================================================
  // 4. Characters
  // ===================================================================
  const ARCH = {
    dancer: { label: 'Young wild dancer', speed: 140, hungerDecay: 1.1, foodMul: 1, drainMul: 1, buzzDecay: 0.8, danceMul: 2, stats: { Speed: 1, Appetite: 0.45, Patience: 0.45 } },
    hungry: { label: 'Hungry relative', speed: 118, hungerDecay: 1.5, foodMul: 1.6, drainMul: 1, buzzDecay: 0.6, danceMul: 1, stats: { Speed: 0.55, Appetite: 1, Patience: 0.5 } },
    chill: { label: 'Chill guest', speed: 126, hungerDecay: 1.0, foodMul: 1, drainMul: 0.65, buzzDecay: 0.6, danceMul: 1, stats: { Speed: 0.75, Appetite: 0.5, Patience: 1 } },
  };

  const OUTFIT_COLORS = [
    { id: 'gold', hex: '#e2b04a', name: 'Champagne' },
    { id: 'rose', hex: '#e2557a', name: 'Rose' },
    { id: 'teal', hex: '#2f9e9a', name: 'Teal' },
    { id: 'navy', hex: '#33468f', name: 'Navy' },
    { id: 'lilac', hex: '#9b6fd6', name: 'Lilac' },
    { id: 'ivory', hex: '#efe9e1', name: 'Ivory' },
  ];
  const SKINS = ['#f3d2b8', '#e0ac80', '#b97d58', '#7a4e33'];
  const HAIRS = ['#2a1a12', '#5a2e1a', '#c9a227', '#1b1b1b', '#8a3b1e'];

  function buildLook(sel) {
    const c = (OUTFIT_COLORS.find((o) => o.id === sel.color) || OUTFIT_COLORS[0]).hex;
    const L = {
      skin: SKINS[sel.skin] || SKINS[1],
      hair: { woman: '#5a2e1a', man: '#2a1a12', nb: '#b0487a' }[sel.gender],
      hairStyle: { woman: 'long', man: 'short', nb: 'curly' }[sel.gender],
      top: c, bottom: shade(c, 0.55), dress: false, shirt: null, tie: null, acc: null,
    };
    if (sel.arch === 'hungry') { L.hair = '#bdb6ae'; L.acc = 'plate'; }
    if (sel.arch === 'dancer') L.acc = 'sparkle';
    if (sel.arch === 'chill') L.acc = 'sunglasses';
    if (sel.style === 'suit') {
      L.shirt = '#ffffff';
      L.tie = sel.color === 'rose' ? '#2a1a3a' : '#c23a5a';
      L.bottom = shade(c, 0.6);
    } else if (sel.style === 'dress') {
      L.dress = true;
    } else {
      L.bottom = '#3b4f86';
      L.stripe = shade(c, 1.25);
    }
    return L;
  }

  function randomGuestLook() {
    const c = pick(['#e2557a', '#2f9e9a', '#33468f', '#9b6fd6', '#e2b04a', '#4caf50', '#ff8a3d', '#1f1f24']);
    const dress = Math.random() < 0.5;
    return {
      skin: pick(SKINS), hair: pick(HAIRS), hairStyle: dress ? pick(['long', 'bun', 'curly']) : pick(['short', 'curly', 'bald']),
      top: c, bottom: dress ? c : shade(c, 0.5), dress, shirt: dress ? null : (Math.random() < 0.5 ? '#ffffff' : null),
      tie: null, acc: null,
    };
  }

  const NPC_TYPES = {
    uncle: {
      name: 'The Drunk Uncle', he: 'הדוד השיכור', detect: 'radius', range: 120, speed: 50, chase: 84, contact: 'hug',
      look: { skin: '#e0ac80', hair: '#3a2a20', hairStyle: 'bald', top: '#5b6e8c', bottom: '#2b2b33', shirt: '#ffffff', tie: '#b23a48', acc: 'kippah', belly: true },
      lines: ['Come here! Give your uncle a hug!', 'לחיים!', 'I changed your diapers, you know!', 'One more chaser, together!'],
      chaseLines: ['Heyyy! Where are you going?', 'בוא בוא בוא!', 'Wait for your uncle!'],
    },
    aunt: {
      name: 'The Nosy Aunt', he: 'הדודה החוקרת', detect: 'cone', range: 210, fov: 1.3, speed: 48, chase: 96, contact: 'talk', drain: 7,
      look: { skin: '#d9a07a', hair: '#7a2e2e', hairStyle: 'bun', top: '#9b4dca', dress: true, acc: 'necklace' },
      lines: ['So... when is YOUR turn?', 'בקרוב אצלך!', "My neighbor's son is single, he's a dentist.", 'How much do you earn, roughly?', 'You look tired. Are you sleeping?', 'Your cousin is already pregnant!'],
      chaseLines: ['Yoo-hoo! Sweetie!', 'מותק, רגע!'],
    },
    grandma: {
      name: 'Grandma Rivka', he: 'סבתא רבקה', detect: 'cone', range: 240, fov: 1.6, speed: 32, chase: 66, contact: 'talk', drain: 8,
      look: { skin: '#e8bfa0', hair: '#d8d4cf', hairStyle: 'bun', top: '#3f6b5a', dress: true, acc: 'glasses' },
      lines: ['Eat something, you are so thin!', 'בקרוב אצלך, חמודה', 'When I was your age I had four children.', 'Who are your parents again?', 'Let me tell you about my hip surgery...'],
      chaseLines: ['Come here, let me see you!', 'בוא לסבתא!'],
    },
    friend: {
      name: 'The Cringe Acquaintance', he: 'החבר הלא רצוי', detect: 'radius', range: 230, speed: 60, chase: 104, contact: 'talk', drain: 4.5, roams: true,
      look: { skin: '#c98d65', hair: '#c9a227', hairStyle: 'cap', cap: '#d6432f', top: '#e3e36a', bottom: '#4a5a8a', acc: null },
      lines: ['Bro! Remember me? From the army!', "So I'm starting a crypto podcast...", 'Selfie! One more! One more!', 'Did you hear about the seating chart drama?', "I'm basically family at this point."],
      chaseLines: ['BRO!', 'אחי! אחי!', 'Wait up!'],
    },
    photographer: {
      name: 'The Photographer', he: 'הצלם', detect: 'cone', range: 270, fov: 0.75, speed: 58, chase: 70, contact: 'flash',
      look: { skin: '#b97d58', hair: '#1b1b1b', hairStyle: 'short', top: '#1f1f24', bottom: '#1f1f24', acc: 'camera' },
      lines: ['Perfect!', 'Beautiful, one more!'],
      chaseLines: ['Smile!', 'Look here!', 'חיוך!'],
    },
  };

  const WAITER_LOOK = { skin: '#d9a07a', hair: '#1b1b1b', hairStyle: 'short', top: '#1d1d24', bottom: '#1d1d24', shirt: '#ffffff', tie: '#1d1d24', acc: 'tray' };

  // ===================================================================
  // 5. Sprites
  // ===================================================================
  const PX = 2; // one art pixel = 2 world pixels

  /**
   * Draw a person on an 8x15 art-pixel grid whose feet sit at (x, y).
   * o: { t, moving, faceRight, alpha, armsUp, trayColor }
   */
  function drawPerson(g, x, y, L, o) {
    const t = o.t || 0;
    const moving = !!o.moving;
    const faceRight = o.faceRight !== false;
    const frame = moving || o.armsUp ? Math.floor(t * (o.armsUp ? 5 : 8)) % 2 : 0;
    const bob = frame;
    const x0 = Math.round(x) - 4 * PX;
    const y0 = Math.round(y) - 15 * PX - bob;
    const R = (cx, cy, w, h, c) => { g.fillStyle = c; g.fillRect(x0 + cx * PX, y0 + cy * PX, w * PX, h * PX); };

    g.save();
    if (o.alpha != null) g.globalAlpha = o.alpha;

    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.beginPath(); g.ellipse(Math.round(x), Math.round(y), 8, 3, 0, 0, Math.PI * 2); g.fill();

    const shoe = L.shoe || '#1c1416';
    const a = moving && frame === 1 ? 1 : 0;
    if (L.dress) {
      R(1, 10, 6, 2, L.top); R(0, 11, 8, 1.5, shade(L.top, 0.85));
      R(2, 12.5, 1, 1.5 - a * 0.5, L.skin); R(5, 12.5, 1, 1 + a * 0.5, L.skin);
      R(2, 14 - a * 0.5, 2, 1, shoe); R(4, 13.5 + a * 0.5, 2, 1, shoe);
    } else {
      R(2, 10, 2, 4 - a, L.bottom); R(4, 10, 2, 3 + a, L.bottom);
      R(2, 14 - a, 2, 1, shoe); R(4, 13 + a, 2, 1, shoe);
    }

    // Torso
    R(1, 5, 6, 5, L.top);
    if (L.belly) R(0.5, 7, 7, 3, L.top);
    if (L.stripe) { R(1, 6, 6, 1, L.stripe); R(1, 8, 6, 1, L.stripe); }
    if (L.shirt) R(3, 5, 2, 2.5, L.shirt);
    if (L.tie) R(3.5, 5.5, 1, 3, L.tie);
    if (L.acc === 'necklace') R(2, 5, 4, 0.6, '#f5d76e');

    // Arms
    const sw = moving ? (frame ? 1 : -1) : 0;
    if (o.armsUp) {
      const up = frame ? 0 : 1;
      R(0, 2 + up, 1, 3, L.top); R(7, 3 - up, 1, 3, L.top);
      R(0, 1 + up, 1, 1, L.skin); R(7, 2 - up, 1, 1, L.skin);
    } else {
      R(0, 5 + Math.max(0, sw), 1, 3, L.top); R(0, 8 + Math.max(0, sw), 1, 1, L.skin);
      R(7, 5 + Math.max(0, -sw), 1, 3, L.top); R(7, 8 + Math.max(0, -sw), 1, 1, L.skin);
    }

    // Head
    R(1, 1, 6, 4, L.skin);
    switch (L.hairStyle) {
      case 'short': R(1, 0, 6, 2, L.hair); R(1, 2, 1, 1, L.hair); R(6, 2, 1, 1, L.hair); break;
      case 'long': R(1, 0, 6, 2, L.hair); R(0, 1, 1, 6, L.hair); R(7, 1, 1, 6, L.hair); R(1, 2, 1, 1, L.hair); R(6, 2, 1, 1, L.hair); break;
      case 'bun': R(1, 0, 6, 1.5, L.hair); R(2.5, -1.5, 3, 2, L.hair); R(1, 1.5, 1, 1, L.hair); R(6, 1.5, 1, 1, L.hair); break;
      case 'curly': R(0, -1, 8, 3, L.hair); R(0, 2, 1, 2, L.hair); R(7, 2, 1, 2, L.hair); break;
      case 'bald': R(1, 2, 1, 2, L.hair); R(6, 2, 1, 2, L.hair); break;
      case 'cap':
        R(1, 1.5, 1, 1.5, L.hair); R(6, 1.5, 1, 1.5, L.hair);
        R(1, -0.5, 6, 2, L.cap || '#d6432f'); R(faceRight ? 6 : -1, 1, 3, 0.8, L.cap || '#d6432f');
        break;
      default: break;
    }
    if (L.acc === 'kippah') R(2.5, 0, 3, 1, '#3a5fcf');

    // Face
    if (L.acc === 'sunglasses') {
      R(1.5, 2.6, 5, 1.2, '#111');
    } else if (L.acc === 'glasses') {
      R(1.5, 2.5, 2.2, 1.5, '#2a2a2a'); R(4.3, 2.5, 2.2, 1.5, '#2a2a2a');
      R(2, 3, 1.2, 0.6, '#cfe8ff'); R(4.8, 3, 1.2, 0.6, '#cfe8ff');
    } else {
      const ex = faceRight ? 3 : 2;
      R(ex, 3, 1, 1, '#1a1020'); R(ex + 2, 3, 1, 1, '#1a1020');
    }

    // Held items
    if (L.acc === 'camera') {
      const cx = faceRight ? 4 : 0;
      R(cx, 6, 4, 3, '#2b2b2b'); R(faceRight ? cx + 3 : cx - 0.5, 6.5, 1.5, 1.8, '#7fb7ff'); R(cx + 1, 5.5, 1, 0.5, '#eeeeee');
    }
    if (L.acc === 'plate') {
      const px = faceRight ? 7 : -2;
      R(px, 7.6, 3, 0.7, '#ffffff'); R(px + 0.5, 7, 2, 0.7, '#d99a3b');
    }
    if (L.acc === 'tray') {
      const px = faceRight ? 6 : -2;
      R(px, 4, 4, 0.6, '#d9d9d9');
      if (o.trayColor) { R(px + 0.5, 3, 1, 1, o.trayColor); R(px + 2.2, 3, 1, 1, o.trayColor); }
    }
    if (L.acc === 'sparkle' && (moving || o.armsUp)) {
      g.fillStyle = '#ffe9a8';
      for (let i = 0; i < 3; i++) {
        const ang = t * 4 + i * 2.1;
        g.fillRect(Math.round(x + Math.cos(ang) * 12), Math.round(y - 18 + Math.sin(ang) * 10), 2, 2);
      }
    }
    g.restore();
  }

  /** Food and drink icons, drawn centered on (x, y). */
  function drawItem(g, kind, v, x, y) {
    const R = (dx, dy, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x + dx), Math.round(y + dy), w, h); };
    switch (kind) {
      case 'canape':
        R(-6, 1, 12, 3, '#f4efe6');
        if (v === 0) { R(-4, -4, 8, 2, '#c9873e'); R(-4, -2, 8, 1, '#6bbf59'); R(-4, -1, 8, 2, '#5a3420'); R(-4, 1, 8, 1, '#c9873e'); }
        else if (v === 1) { R(-5, -3, 4, 4, '#1d1d1d'); R(-4, -2, 2, 2, '#ff8a65'); R(1, -3, 4, 4, '#1d1d1d'); R(2, -2, 2, 2, '#ffffff'); }
        else if (v === 2) { R(-6, -2, 12, 1, '#d9c39a'); R(-4, -4, 3, 4, '#8b4a2b'); R(1, -4, 3, 4, '#a85a33'); }
        else { R(-4, -3, 8, 4, '#d9a35c'); R(-2, -3, 4, 2, '#7a5a3a'); }
        break;
      case 'main':
        R(-8, 1, 16, 3, '#f4efe6'); R(-7, 0, 14, 1, '#e4ddd0');
        if (v === 0) { R(-6, -3, 10, 4, '#d99a3b'); R(4, -2, 3, 3, '#ffe066'); }
        else if (v === 1) { R(-6, -3, 11, 4, '#7a3b2a'); R(-4, -3, 1, 4, '#4a2318'); R(0, -3, 1, 4, '#4a2318'); R(5, -1, 2, 2, '#6bbf59'); }
        else if (v === 2) { R(-6, -3, 11, 4, '#ff9e7a'); R(-6, -1, 11, 1, '#ffd0bd'); }
        else { R(-6, -4, 5, 5, '#e63946'); R(0, -4, 5, 5, '#2a9d8f'); }
        break;
      case 'dessert':
        if (v === 0) { R(-4, -4, 8, 7, '#ffffff'); R(-4, -4, 8, 2, '#e03a5c'); R(-1, -5, 2, 1, '#9be7a0'); }
        else if (v === 1) { R(-5, 2, 10, 2, '#f4efe6'); R(-4, -4, 8, 6, '#5b3a29'); R(-3, -5, 6, 1, '#7a5040'); }
        else { R(-5, 2, 10, 2, '#f4efe6'); R(-4, -4, 8, 6, '#ffd1dc'); R(-4, -2, 8, 1, '#ff8fab'); R(-1, -6, 2, 2, '#e03a5c'); }
        break;
      case 'drink':
        if (v === 0) { R(-2, -7, 5, 10, '#e8f6ff'); R(-1, -6, 3, 8, '#ffffff'); R(-1, -4, 2, 2, '#bfe6ff'); }
        else if (v === 1) { R(-3, -7, 6, 5, '#8e1b3a'); R(-1, -2, 2, 4, '#e8f6ff'); R(-3, 2, 6, 1, '#e8f6ff'); }
        else if (v === 2) { R(-2, -3, 4, 6, '#ffd166'); R(-2, -3, 4, 1, '#fff2c2'); }
        else { R(-3, -7, 6, 10, '#f4a72c'); R(-3, -8, 6, 2, '#fffaf0'); R(3, -5, 2, 4, '#d4d4d4'); }
        break;
      case 'water':
        R(-3, -5, 6, 8, '#8fd3ff'); R(-3, -5, 6, 2, '#d6f1ff');
        break;
      default: break;
    }
  }

  // ===================================================================
  // 6. Game state
  // ===================================================================
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const mini = $('minimap');
  const mctx = mini.getContext('2d');
  const previewCanvas = $('preview');
  const pctx = previewCanvas.getContext('2d');

  const view = { cssW: 800, cssH: 600, dpr: 1, zoom: 1, vw: 800, vh: 600 };
  const cam = { x: 0, y: 0 };
  let staticLayer = null;

  const selection = { gender: 'woman', arch: 'dancer', style: 'suit', color: 'gold', skin: 1 };
  let playerLook = buildLook(selection);

  const game = {
    state: 'menu',  // 'menu' | 'play' | 'paused' | 'over'
    t: 0, elapsed: 0, score: 0,
    eventIdx: 0, event: EVENTS[0],
    npcs: [], waiters: [], dancers: [], items: [], floaters: [],
    zoneId: null, stats: null, won: false,
  };
  let player = null;

  function newStats() {
    return { canape: 0, main: 0, dessert: 0, drinks: 0, water: 0, convos: 0, escaped: 0, dodged: 0, hugs: 0, flashes: 0 };
  }

  function makePlayer(look, archId) {
    return {
      x: 470, y: 540, vx: 0, vy: 0, look, archId, arch: ARCH[archId],
      faceRight: true, moving: false,
      food: 80, buzz: 0, battery: 100,
      held: 0, slow: 0, stun: 0, boost: 0, grace: 1.5,
      hidden: false, talking: null, escape: 0, excuses: 1,
    };
  }

  function makeNpc(type, x, y, home) {
    const T = NPC_TYPES[type];
    return {
      role: 'enemy', type, T, x, y, home, faceRight: true, facing: Math.random() * Math.PI * 2,
      state: 'wander', timer: 0, target: null, wait: rand(0.5, 2), cross: null, lost: 0, cd: 0,
      say: null, sayT: 0, alert: 0, lineT: 0, stuck: 0, jitter: 0, jx: 0, jy: 0,
      t: Math.random() * 10, moving: false,
    };
  }

  function makeWaiter(x, y, tray) {
    const look = Object.assign({}, WAITER_LOOK, { skin: pick(SKINS), hair: pick(HAIRS) });
    return {
      role: 'waiter', x, y, look, tray, has: true, variant: Math.floor(Math.random() * VARIANTS[tray].length),
      refill: 0, faceRight: true, facing: 0, target: null, wait: rand(0, 2), cross: null, stuck: 0,
      jitter: 0, jx: 0, jy: 0, t: Math.random() * 10, moving: false, say: null, sayT: 0,
    };
  }

  function makeDancer() {
    return {
      x: rand(DANCE_FLOOR.x + 20, DANCE_FLOOR.x + DANCE_FLOOR.w - 20),
      y: rand(DANCE_FLOOR.y + 30, DANCE_FLOOR.y + DANCE_FLOOR.h - 10),
      look: randomGuestLook(), t: Math.random() * 10, tx: 0, ty: 0, retarget: 0, faceRight: Math.random() < 0.5,
    };
  }

  function newGame(look, archId) {
    player = makePlayer(look, archId);
    game.t = 0; game.elapsed = 0; game.score = 0;
    game.eventIdx = 0; game.event = EVENTS[0];
    game.floaters = []; game.stats = newStats(); game.won = false;
    game.zoneId = null;
    game.scoreAcc = 0; game.scoreFrac = 0;

    game.npcs = [
      makeNpc('aunt', 300, 300, 'reception'),
      makeNpc('uncle', 700, 720, 'bar'),
      makeNpc('grandma', 520, 1130, 'dining'),
      makeNpc('friend', 1200, 720, 'bar'),
      makeNpc('photographer', 1200, 200, 'chuppah'),
    ];
    game.waiters = [makeWaiter(300, 520, 'canape'), makeWaiter(1300, 1000, 'drink')];
    game.dancers = [];
    for (let i = 0; i < 10; i++) game.dancers.push(makeDancer());

    game.items = SPAWNS.map((s) => ({
      x: s.x, y: s.y, kind: s.kind, variant: Math.floor(Math.random() * VARIANTS[s.kind].length),
      active: s.kind !== 'main', timer: rand(0, 3), phase: Math.random() * 6,
    }));
  }

  // ===================================================================
  // 7. Input
  // ===================================================================
  const keys = new Set();
  const touchDirs = new Set();
  const MOVE_KEYS = {
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  };

  function dirHeld(dir) {
    if (touchDirs.has(dir)) return true;
    for (const code of keys) if (MOVE_KEYS[code] === dir) return true;
    return false;
  }

  window.addEventListener('keydown', (e) => {
    if (game.state === 'play') {
      if (MOVE_KEYS[e.code]) {
        keys.add(e.code);
        if (!e.repeat) mash(0.13);
        e.preventDefault();
      } else if (e.code === 'Space' || e.code === 'KeyE' || e.code === 'Enter') {
        if (!e.repeat) action();
        e.preventDefault();
      } else if (e.code === 'KeyP' || e.code === 'Escape') {
        pauseGame();
      } else if (e.code === 'KeyM') {
        toggleMute();
      }
    } else if (game.state === 'paused') {
      if (e.code === 'KeyP' || e.code === 'Escape') resumeGame();
      else if (e.code === 'KeyM') toggleMute();
    }
  });
  window.addEventListener('keyup', (e) => { keys.delete(e.code); });
  window.addEventListener('blur', () => {
    keys.clear(); touchDirs.clear();
    if (game.state === 'play') pauseGame();
  });

  function setupTouch() {
    const app = $('app');
    const showTouch = () => {
      app.classList.add('touching');
      if (game.state === 'play') $('touch').hidden = false;
    };
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) app.classList.add('touching');
    window.addEventListener('touchstart', showTouch, { passive: true, once: true });

    document.querySelectorAll('#touch [data-dir]').forEach((btn) => {
      const dir = btn.dataset.dir;
      const release = () => { touchDirs.delete(dir); btn.classList.remove('held'); };
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        touchDirs.add(dir); btn.classList.add('held');
        try { btn.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
        mash(0.13);
      });
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('lostpointercapture', release);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });
    $('btn-action').addEventListener('pointerdown', (e) => { e.preventDefault(); if (game.state === 'play') action(); });
    $('btn-pause').addEventListener('click', () => { if (game.state === 'play') pauseGame(); });
  }

  /** Rapid key presses during small talk fill the escape bar. */
  function mash(amount) {
    if (game.state !== 'play' || !player || !player.talking) return;
    player.escape = Math.min(1, player.escape + amount);
    if (player.escape >= 1) endTalk(player.talking, false);
  }

  /**
   * Raise a drink. In a conversation: spend it as an excuse to leave.
   * Otherwise: "L'chaim!" makes every chaser nearby lose interest.
   */
  function action() {
    if (!player) return;
    if (player.talking) {
      if (player.excuses > 0) {
        player.excuses--;
        endTalk(player.talking, true);
      } else {
        mash(0.2);
      }
      return;
    }
    const chasers = game.npcs.filter((n) => (n.state === 'chase' || n.state === 'aim') && dist(n, player) < 260);
    if (player.excuses > 0 && chasers.length) {
      player.excuses--;
      chasers.forEach((n) => loseTrack(n, true));
      addFloater(player.x, player.y - 40, "L'chaim!", '#7fc8ff');
      Sound.sfx('cheers');
    } else if (player.excuses === 0) {
      showToast('No drink in hand', 'Grab one at the bar or from a waiter first.', '', 1.6);
    }
  }

  // ===================================================================
  // 8. Update
  // ===================================================================

  function moveActor(a, dx, dy) {
    const hw = 7, hh = 5;
    if (dx) {
      a.x += dx;
      for (const s of SOLIDS) {
        if (a.x + hw > s.x && a.x - hw < s.x + s.w && a.y + hh > s.y && a.y - hh < s.y + s.h) {
          a.x = dx > 0 ? s.x - hw - 0.01 : s.x + s.w + hw + 0.01;
        }
      }
    }
    if (dy) {
      a.y += dy;
      for (const s of SOLIDS) {
        if (a.x + hw > s.x && a.x - hw < s.x + s.w && a.y + hh > s.y && a.y - hh < s.y + s.h) {
          a.y = dy > 0 ? s.y - hh - 0.01 : s.y + s.h + hh + 0.01;
        }
      }
    }
  }

  function pointBlocked(x, y, pad) {
    for (const s of SOLIDS) {
      if (x > s.x - pad && x < s.x + s.w + pad && y > s.y - pad && y < s.y + s.h + pad) return true;
    }
    return false;
  }

  function randomPointIn(rect, margin) {
    const m = margin == null ? 44 : margin;
    for (let i = 0; i < 24; i++) {
      const x = rand(rect.x + m, rect.x + rect.w - m);
      const y = rand(rect.y + m, rect.y + rect.h - m);
      if (!pointBlocked(x, y, 16)) return { x, y };
    }
    return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  }

  /** Next point to walk toward on the way to (tx, ty), routing through doors. */
  function navPoint(n, tx, ty) {
    if (n.cross) {
      if (Math.hypot(n.cross.x - n.x, n.cross.y - n.y) < 12) n.cross = null;
      else return n.cross;
    }
    const zn = zoneAt(n.x, n.y).id;
    const zt = zoneAt(tx, ty).id;
    if (zn === zt) return { x: tx, y: ty };
    const door = NEXT[zn][zt];
    if (!door) return { x: tx, y: ty };
    const from = doorSide(door, zn);
    const to = doorSide(door, door.a === zn ? door.b : door.a);
    if (Math.hypot(from.x - n.x, from.y - n.y) < 14) { n.cross = to; return to; }
    return from;
  }

  /** Walk an NPC toward a target. Returns true once it has arrived. */
  function npcMoveTo(n, tx, ty, speed, dt, wobble) {
    const p = navPoint(n, tx, ty);
    let dx = p.x - n.x, dy = p.y - n.y;
    if (n.jitter > 0) {
      n.jitter -= dt; dx = n.jx; dy = n.jy;
    } else if (Math.hypot(tx - n.x, ty - n.y) < 6) {
      n.moving = false;
      return true;
    }
    let ang = Math.atan2(dy, dx);
    if (wobble) ang += Math.sin(n.t * 3.1) * wobble;
    const step = speed * dt;
    const ox = n.x, oy = n.y;
    moveActor(n, Math.cos(ang) * step, Math.sin(ang) * step);
    n.facing = ang;
    if (Math.abs(Math.cos(ang)) > 0.2) n.faceRight = Math.cos(ang) > 0;
    n.moving = true;
    const moved = Math.hypot(n.x - ox, n.y - oy);
    if (moved < step * 0.3) {
      n.stuck += dt;
      if (n.stuck > 0.35) {
        n.stuck = 0;
        n.jitter = 0.45;
        const side = (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2 + rand(-0.4, 0.4));
        n.jx = Math.cos(Math.atan2(dy, dx) + side);
        n.jy = Math.sin(Math.atan2(dy, dx) + side);
        n.cross = null;
      }
    } else {
      n.stuck = Math.max(0, n.stuck - dt);
    }
    return false;
  }

  function playerOnDanceFloor() {
    return player && inRect(player, DANCE_FLOOR);
  }

  /** Can this NPC notice the player right now? Walls block sight (same zone only). */
  function canSee(n, chasing) {
    if (game.state !== 'play' || !player) return false;
    if (player.hidden || player.grace > 0) return false;
    const T = n.T;
    const d = dist(n, player);
    let range = T.range * (playerOnDanceFloor() ? 0.5 : 1);
    if (chasing) range *= 1.5;
    if (d > range) return false;
    const sameZone = zoneAt(n.x, n.y).id === zoneAt(player.x, player.y).id;
    if (!sameZone && !(T.roams && chasing)) return false;
    if (!T.roams && zoneAt(player.x, player.y).id !== n.home) return false;
    if (T.detect === 'cone' && !chasing && d > 40) {
      const toP = Math.atan2(player.y - n.y, player.x - n.x);
      if (Math.abs(angleDiff(n.facing, toP)) > T.fov / 2) return false;
    }
    return true;
  }

  function say(n, text, secs) {
    n.say = text;
    n.sayT = secs || 2;
  }

  function startChase(n) {
    n.alert = 0.8;
    say(n, pick(n.T.chaseLines), 1.8);
    Sound.sfx('alert');
    if (n.T.contact === 'flash') {
      n.state = 'aim';
      n.timer = 0.9;
    } else {
      n.state = 'chase';
      n.lost = 0;
    }
  }

  function loseTrack(n, byToast) {
    n.state = 'cooldown';
    n.cd = byToast ? 5 : 2.5;
    n.target = null;
    game.stats.dodged++;
    addScore(25, n.x, n.y - 40, 'Dodged +25', '#7ee0c3');
    if (!byToast) Sound.sfx('dodge');
  }

  function canEngage() {
    return game.state === 'play' && !player.talking && player.held <= 0 && player.grace <= 0 && !player.hidden;
  }

  function engage(n) {
    const T = n.T;
    if (T.contact === 'hug') {
      n.state = 'hug';
      n.timer = 1.5;
      player.held = 1.5;
      player.battery -= 8 * player.arch.drainMul;
      game.stats.hugs++;
      say(n, pick(T.lines), 1.5);
      addFloater(player.x, player.y - 40, 'Bear hug! -8', '#ff7a9c');
      Sound.sfx('hug');
    } else if (T.contact === 'talk') {
      n.state = 'talk';
      n.lineT = 0;
      player.talking = n;
      player.escape = 0;
      player.vx = 0; player.vy = 0;
      game.stats.convos++;
      $('convo-name').textContent = T.name;
      $('convo-he').textContent = T.he;
      $('convo').hidden = false;
    }
  }

  function endTalk(n, byExcuse) {
    n.state = 'cooldown';
    n.cd = 7;
    n.target = null;
    n.say = null;
    player.talking = null;
    player.escape = 0;
    player.grace = 1.6;
    const ang = Math.atan2(player.y - n.y, player.x - n.x);
    moveActor(player, Math.cos(ang) * 24, Math.sin(ang) * 24);
    game.stats.escaped++;
    addScore(20, player.x, player.y - 40, 'Escaped +20', '#7ee0c3');
    $('convo').hidden = true;
    if (byExcuse) {
      showToast('"Sorry, my drink is getting warm!"', 'You raised your glass and slipped away.', '', 1.8);
      Sound.sfx('cheers');
    } else {
      Sound.sfx('escape');
    }
  }

  function endHug(n) {
    n.state = 'cooldown';
    n.cd = 7;
    n.target = null;
    player.slow = 3;
  }

  function flashPlayer(n) {
    player.stun = 1.2;
    player.battery -= 6 * player.arch.drainMul;
    game.stats.flashes++;
    n.state = 'cooldown';
    n.cd = 6;
    say(n, pick(n.T.lines), 1.4);
    addFloater(player.x, player.y - 40, 'Flash! -6', '#fff4e4');
    Sound.sfx('flash');
    const f = $('flash');
    f.classList.remove('on');
    void f.offsetWidth; // restart the CSS animation
    f.classList.add('on');
  }

  function updateNpc(n, dt) {
    n.t += dt;
    if (n.sayT > 0) { n.sayT -= dt; if (n.sayT <= 0) n.say = null; }
    if (n.alert > 0) n.alert -= dt;
    const T = n.T;
    const seated = game.event.id === 'ceremony' && zoneAt(n.x, n.y).id === 'chuppah';
    const wobble = n.type === 'uncle' ? 0.7 : 0;

    switch (n.state) {
      case 'wander':
      case 'cooldown': {
        if (n.state === 'cooldown') { n.cd -= dt; if (n.cd <= 0) n.state = 'wander'; }
        if (seated) { n.moving = false; break; }
        if (n.wait > 0) {
          n.wait -= dt;
          n.moving = false;
          if (T.detect === 'cone') n.facing += Math.sin(n.t * 0.9) * dt * 1.2; // look around
        } else {
          if (!n.target) n.target = randomPointIn(T.roams ? pick(ZONES) : ZONE_BY_ID[n.home]);
          if (npcMoveTo(n, n.target.x, n.target.y, T.speed, dt, wobble)) {
            n.target = null;
            n.wait = rand(0.8, 2.6);
          }
        }
        if (n.state === 'wander' && canSee(n, false)) startChase(n);
        break;
      }
      case 'chase': {
        if (seated) { n.state = 'wander'; break; }
        if (canSee(n, true)) n.lost = 0; else n.lost += dt;
        if (n.lost > 1.0) { loseTrack(n, false); break; }
        npcMoveTo(n, player.x, player.y, T.chase, dt, wobble * 0.5);
        if (Math.random() < dt * 0.25) say(n, pick(T.chaseLines), 1.4);
        if (dist(n, player) < 16 && canEngage()) engage(n);
        break;
      }
      case 'aim': {
        n.timer -= dt;
        n.moving = false;
        n.facing = Math.atan2(player.y - n.y, player.x - n.x);
        n.faceRight = player.x >= n.x;
        if (n.timer <= 0) {
          if (canSee(n, true) && player.stun <= 0) flashPlayer(n);
          else loseTrack(n, false);
        }
        break;
      }
      case 'talk': {
        n.moving = false;
        n.faceRight = player.x >= n.x;
        n.lineT -= dt;
        if (n.lineT <= 0) {
          n.lineT = 2.6;
          const line = pick(T.lines);
          say(n, line, 2.6);
          $('convo-line').textContent = line;
          const hasRtl = /[֐-׿]/.test(line);
          $('convo-line').dir = hasRtl ? 'rtl' : 'ltr';
          [0, 0.08, 0.16].forEach((d) => setTimeout(() => Sound.sfx('blip'), d * 1000));
        }
        break;
      }
      case 'hug': {
        n.moving = false;
        n.timer -= dt;
        if (n.timer <= 0) endHug(n);
        break;
      }
      default: break;
    }
  }

  function updateWaiter(w, dt) {
    w.t += dt;
    if (w.sayT > 0) { w.sayT -= dt; if (w.sayT <= 0) w.say = null; }
    if (!w.has) {
      w.refill -= dt;
      if (w.refill <= 0) { w.has = true; w.variant = Math.floor(Math.random() * VARIANTS[w.tray].length); }
    }
    if (w.wait > 0) { w.wait -= dt; w.moving = false; return; }
    if (!w.target) w.target = randomPointIn(pick(ZONES));
    if (npcMoveTo(w, w.target.x, w.target.y, 55, dt, 0)) { w.target = null; w.wait = rand(1.5, 3.5); }
    if (w.has && player && game.state === 'play' && dist(w, player) < 90 && Math.random() < dt * 0.4) {
      say(w, w.tray === 'drink' ? 'Something to drink?' : 'Canapé?', 1.6);
    }
  }

  function updateDancers(dt) {
    const wanted = game.event.id === 'dance1' || game.event.id === 'dance2' ? 18 : game.event.id === 'dessert' ? 14 : 10;
    while (game.dancers.length < wanted) game.dancers.push(makeDancer());
    if (game.dancers.length > wanted) game.dancers.length = wanted;
    for (const d of game.dancers) {
      d.t += dt;
      d.retarget -= dt;
      if (d.retarget <= 0) {
        d.retarget = rand(1.5, 4);
        d.tx = clamp(d.x + rand(-40, 40), DANCE_FLOOR.x + 16, DANCE_FLOOR.x + DANCE_FLOOR.w - 16);
        d.ty = clamp(d.y + rand(-30, 30), DANCE_FLOOR.y + 30, DANCE_FLOOR.y + DANCE_FLOOR.h - 8);
      }
      const dx = d.tx - d.x, dy = d.ty - d.y;
      const len = Math.hypot(dx, dy);
      if (len > 2) {
        d.x += (dx / len) * 20 * dt;
        d.y += (dy / len) * 20 * dt;
        d.faceRight = dx > 0;
      }
    }
  }

  function updateItems(dt) {
    const ev = game.event.id;
    const dinnerServed = game.eventIdx >= EVENT_INDEX.dinner;
    for (const it of game.items) {
      it.phase += dt;
      if (it.active) continue;
      if (it.kind === 'main' && !dinnerServed) continue;
      let rate = 1;
      if (it.kind === 'main' && ev === 'dinner') rate = 2;
      if (it.kind === 'dessert' && ev === 'dessert') rate = 2.5;
      if (it.kind === 'drink' && ev === 'shots') rate = 1.6;
      it.timer -= dt * rate;
      if (it.timer <= 0) {
        it.active = true;
        it.variant = Math.floor(Math.random() * VARIANTS[it.kind].length);
      }
    }
  }

  /** Apply the effect of eating or drinking something. */
  function consume(kind, variant, x, y) {
    const p = player, A = p.arch;
    const v = VARIANTS[kind][variant] || VARIANTS[kind][0];
    const ev = game.event.id;
    let pts = 0;
    switch (kind) {
      case 'canape':
        p.food += 12 * A.foodMul; pts = Math.round(10 * A.foodMul); game.stats.canape++;
        Sound.sfx('eat'); break;
      case 'main':
        p.food += 28 * A.foodMul; pts = Math.round((ev === 'dinner' ? 45 : 30) * A.foodMul); game.stats.main++;
        Sound.sfx('eat'); break;
      case 'dessert':
        p.food += 10 * A.foodMul; p.battery += 4; pts = Math.round((ev === 'dessert' ? 40 : 20) * A.foodMul); game.stats.dessert++;
        Sound.sfx('eat'); break;
      case 'drink':
        p.buzz += 18; p.boost = 4; p.excuses = Math.min(3, p.excuses + 1);
        pts = ev === 'shots' ? 30 : 15; game.stats.drinks++;
        Sound.sfx('drink'); break;
      case 'water':
        p.buzz -= 25; p.battery += 6; pts = 5; game.stats.water++;
        Sound.sfx('water'); break;
      default: break;
    }
    p.food = clamp(p.food, 0, 100);
    p.buzz = clamp(p.buzz, 0, 100);
    p.battery = clamp(p.battery, 0, 100);
    addScore(pts, x, y - 24, v.n + ' +' + pts, kind === 'drink' || kind === 'water' ? '#7fc8ff' : '#f2c46d');
  }

  function updatePlayer(dt) {
    const p = player, A = p.arch;
    p.held = Math.max(0, p.held - dt);
    p.slow = Math.max(0, p.slow - dt);
    p.stun = Math.max(0, p.stun - dt);
    p.boost = Math.max(0, p.boost - dt);
    p.grace = Math.max(0, p.grace - dt);

    const zone = zoneAt(p.x, p.y);
    const onFloor = playerOnDanceFloor();
    const inLounge = inRect(p, LOUNGE);

    // Meters
    p.food = Math.max(0, p.food - A.hungerDecay * dt);
    p.buzz = Math.max(0, p.buzz - A.buzzDecay * dt);
    let drain = 0;
    if (p.talking) drain += p.talking.T.drain * A.drainMul;
    if (p.food <= 0) drain += 1.5;
    let regen = 0;
    if (p.hidden) regen += 2;
    if (inLounge) regen += 3;
    if (game.event.id === 'ceremony' && zone.id === 'chuppah') regen += 1.5;
    if (p.archId === 'dancer' && onFloor) regen += 0.8;
    p.battery = clamp(p.battery - drain * dt + (p.talking ? 0 : regen * dt), 0, 100);

    if (p.talking) {
      p.escape = Math.max(0, p.escape - 0.12 * dt);
    }

    // Movement
    let ix = 0, iy = 0;
    if (dirHeld('left')) ix -= 1;
    if (dirHeld('right')) ix += 1;
    if (dirHeld('up')) iy -= 1;
    if (dirHeld('down')) iy += 1;
    const canMove = !p.talking && p.held <= 0 && p.stun <= 0;
    if (!canMove) { ix = 0; iy = 0; }
    const ilen = Math.hypot(ix, iy);
    if (ilen > 0) { ix /= ilen; iy /= ilen; }

    // Too much buzz: inputs wobble and the floor gets slippery.
    const tipsy = clamp((p.buzz - 65) / 35, 0, 1);
    if (tipsy > 0 && ilen > 0) {
      const wob = Math.sin(game.t * 2.3) * 0.6 * tipsy;
      const c = Math.cos(wob), s = Math.sin(wob);
      const nx = ix * c - iy * s, ny = ix * s + iy * c;
      ix = nx; iy = ny;
    }
    let sp = A.speed;
    sp *= 1 + Math.min(p.buzz, 60) / 250;
    if (p.boost > 0) sp *= 1.2;
    if (p.slow > 0) sp *= 0.55;
    if (p.food <= 0) sp *= 0.75;
    const accel = 12 - 9.5 * tipsy;
    const k = Math.min(1, accel * dt);
    p.vx += (ix * sp - p.vx) * k;
    p.vy += (iy * sp - p.vy) * k;
    if (!canMove && tipsy === 0) { p.vx = 0; p.vy = 0; }
    if (p.held > 0 || p.talking || p.stun > 0) { p.vx *= 0.5; p.vy *= 0.5; }
    moveActor(p, p.vx * dt, p.vy * dt);
    p.x = clamp(p.x, WALL + 8, WORLD_W - WALL - 8);
    p.y = clamp(p.y, WALL + 8, WORLD_H - WALL - 8);
    const speed = Math.hypot(p.vx, p.vy);
    p.moving = speed > 12;
    if (Math.abs(p.vx) > 8) p.faceRight = p.vx > 0;

    // Hiding in flowers
    const inFlowers = FLOWERS.some((f) => Math.hypot(f.x - p.x, f.y - p.y) < 24);
    p.hidden = inFlowers && speed < 35 && !p.talking && p.held <= 0;

    // Pickups
    if (!p.talking && p.held <= 0) {
      for (const it of game.items) {
        if (it.active && Math.hypot(it.x - p.x, it.y - p.y) < 20) {
          it.active = false;
          it.timer = RESPAWN[it.kind] * rand(0.8, 1.2);
          consume(it.kind, it.variant, it.x, it.y);
        }
      }
      for (const w of game.waiters) {
        if (w.has && dist(w, p) < 20) {
          w.has = false;
          w.refill = 10;
          say(w, 'Enjoy!', 1.2);
          consume(w.tray, w.variant, w.x, w.y);
        }
      }
    }

    // Zone changes
    if (zone.id !== game.zoneId) {
      game.zoneId = zone.id;
      showZone(zone);
    }
    const party = zone.id === 'dance';
    const quiet = zone.id === 'chuppah' || inLounge;
    Sound.setIntensity(party ? 2 : quiet ? 0 : 1);

    // Passive scoring
    game.scoreAcc = (game.scoreAcc || 0) + dt;
    let rate = 1;
    if (onFloor && p.moving) {
      const setMul = game.event.id === 'dance1' || game.event.id === 'dance2' ? 2 : 1;
      rate += 3 * A.danceMul * setMul;
    }
    if (game.event.id === 'ceremony' && zone.id === 'chuppah') rate += 4;
    game.scoreFrac = (game.scoreFrac || 0) + rate * dt;
    if (game.scoreFrac >= 1) {
      const whole = Math.floor(game.scoreFrac);
      game.score += whole;
      game.scoreFrac -= whole;
    }
    if (onFloor && p.moving && game.scoreAcc > 1.2) {
      game.scoreAcc = 0;
      addFloater(p.x + rand(-10, 10), p.y - 40, 'Dancing!', '#ff7a9c');
    }
  }

  function updateEvents() {
    const m = clockMinutes();
    let idx = 0;
    for (let i = 0; i < EVENTS.length; i++) if (m >= EVENTS[i].at) idx = i;
    if (idx !== game.eventIdx) {
      game.eventIdx = idx;
      game.event = EVENTS[idx];
      onEvent(game.event);
    }
  }

  function onEvent(e) {
    showToast(e.title + ' · ' + e.he, e.desc, 'event', 3.5);
    Sound.sfx('event');
    switch (e.id) {
      case 'dinner':
        Sound.sfx('glass');
        game.items.forEach((it) => { if (it.kind === 'main') { it.active = true; it.variant = Math.floor(Math.random() * 4); } });
        break;
      case 'dance1':
        game.npcs.push(makeNpc('photographer', 1300, 1000, 'dance'));
        break;
      case 'shots':
        game.npcs.push(makeNpc('uncle', 1700, 1250, 'dance'));
        break;
      case 'dance2':
        game.npcs.push(makeNpc('aunt', 300, 1320, 'dining'));
        break;
      default: break;
    }
  }

  function clockMinutes() {
    return START_MIN + (game.elapsed / NIGHT_SECONDS) * (END_MIN - START_MIN);
  }

  function formatClock(m) {
    const h = Math.floor(m / 60) % 24;
    const mm = Math.floor(m % 60);
    return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  function addScore(pts, x, y, text, color) {
    game.score += pts;
    if (text) addFloater(x, y, text, color);
  }

  function addFloater(x, y, text, color) {
    game.floaters.push({ x, y, text, color: color || '#fff4e4', life: 1.3 });
    if (game.floaters.length > 30) game.floaters.shift();
  }

  /** Background simulation shared by the menu backdrop and the game. */
  function updateWorld(dt) {
    game.t += dt;
    for (const n of game.npcs) updateNpc(n, dt);
    for (const w of game.waiters) updateWaiter(w, dt);
    updateDancers(dt);
    updateItems(dt);
    for (const f of game.floaters) { f.life -= dt; f.y -= 18 * dt; }
    game.floaters = game.floaters.filter((f) => f.life > 0);
  }

  function update(dt) {
    game.elapsed += dt;
    updateEvents();
    updatePlayer(dt);
    updateWorld(dt);
    updateToast(dt);
    if (player.battery <= 0) { endGame(false); return; }
    if (game.elapsed >= NIGHT_SECONDS) endGame(true);
  }

  // ===================================================================
  // 9. Render
  // ===================================================================

  function buildStatic() {
    const c = document.createElement('canvas');
    c.width = WORLD_W; c.height = WORLD_H;
    const g = c.getContext('2d');
    const rnd = seeded(1987);

    // Reception: marble checkerboard
    const rz = ZONE_BY_ID.reception;
    for (let y = rz.y; y < rz.y + rz.h; y += 40) {
      for (let x = rz.x; x < rz.x + rz.w; x += 40) {
        g.fillStyle = ((x + y) / 40) % 2 === 0 ? '#efe4d2' : '#e2d3bb';
        g.fillRect(x, y, 40, 40);
      }
    }
    // Chuppah: lawn with a white aisle runner and petals
    const cz = ZONE_BY_ID.chuppah;
    for (let x = cz.x; x < cz.x + cz.w; x += 40) {
      g.fillStyle = (x / 40) % 2 === 0 ? '#5d9a55' : '#57924f';
      g.fillRect(x, cz.y, 40, cz.h);
    }
    g.fillStyle = '#f7f1ea'; g.fillRect(1400, 196, 160, 424);
    g.fillStyle = '#e9dfd3'; g.fillRect(1400, 196, 4, 424); g.fillRect(1556, 196, 4, 424);
    for (let i = 0; i < 70; i++) {
      g.fillStyle = rnd() < 0.5 ? '#f49ab0' : '#ffffff';
      g.fillRect(1404 + rnd() * 150, 200 + rnd() * 410, 3, 2);
    }
    // Corridor: wooden planks
    const bz = ZONE_BY_ID.bar;
    g.fillStyle = '#7a5136'; g.fillRect(bz.x, bz.y, bz.w, bz.h);
    g.fillStyle = '#6a452d';
    for (let y = bz.y; y < bz.y + bz.h; y += 20) {
      g.fillRect(bz.x, y, bz.w, 2);
      const off = ((y / 20) % 2) * 40;
      for (let x = bz.x + off; x < bz.x + bz.w; x += 80) g.fillRect(x, y, 2, 20);
    }
    // Restroom lounge: teal tiles
    for (let y = LOUNGE.y; y < LOUNGE.y + LOUNGE.h; y += 20) {
      for (let x = LOUNGE.x; x < LOUNGE.x + LOUNGE.w; x += 20) {
        g.fillStyle = ((x + y) / 20) % 2 === 0 ? '#2f6f73' : '#2a6266';
        g.fillRect(x, y, 20, 20);
      }
    }
    // Dining: burgundy carpet with a gold lattice
    const dz = ZONE_BY_ID.dining;
    g.fillStyle = '#6b1f35'; g.fillRect(dz.x, dz.y, dz.w, dz.h);
    g.fillStyle = '#7d2a42';
    for (let y = dz.y; y < dz.y + dz.h; y += 32) {
      for (let x = dz.x; x < dz.x + dz.w; x += 32) {
        g.fillRect(x + 15, y, 2, 32); g.fillRect(x, y + 15, 32, 2);
      }
    }
    g.fillStyle = '#b98a35';
    for (let y = dz.y; y < dz.y + dz.h; y += 32) {
      for (let x = dz.x; x < dz.x + dz.w; x += 32) g.fillRect(x + 14, y + 14, 4, 4);
    }
    // Dance hall base
    const nz = ZONE_BY_ID.dance;
    g.fillStyle = '#1e1529'; g.fillRect(nz.x, nz.y, nz.w, nz.h);

    // Furniture
    for (const f of FURN) {
      if (f.dynamic) continue;
      drawFurniture(g, f, rnd);
    }

    // Walls
    for (const s of SOLIDS) {
      if (s.kind !== 'wall') continue;
      g.fillStyle = '#3b2350'; g.fillRect(s.x, s.y, s.w, s.h);
      g.fillStyle = '#5b3a72'; g.fillRect(s.x, s.y, s.w, 3);
      g.fillStyle = '#26152f'; g.fillRect(s.x, s.y + s.h - 3, s.w, 3);
    }

    // Floor signs
    g.textAlign = 'center';
    g.font = '700 11px Rubik, system-ui, sans-serif';
    const sign = (text, x, y, color) => { g.fillStyle = color; g.fillText(text, x, y); };
    sign('BAR · בר', 320, 700 + 76, '#f2c46d');
    sign('WC · שירותים', LOUNGE.x + LOUNGE.w / 2, LOUNGE.y + LOUNGE.h - 10, '#d6f1ff');
    sign('Rest here to recharge', LOUNGE.x + LOUNGE.w / 2, LOUNGE.y + LOUNGE.h - 26, '#a9dcdc');
    sign('Water · מים', 1010, 720, '#d6f1ff');

    return c;
  }

  function drawFurniture(g, f, rnd) {
    switch (f.kind) {
      case 'station':
      case 'buffet':
      case 'dessert': {
        const cloth = f.kind === 'dessert' ? '#ffd8e2' : '#fffaf0';
        g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(f.x + 3, f.y + 4, f.w, f.h);
        g.fillStyle = cloth; g.fillRect(f.x, f.y, f.w, f.h);
        g.fillStyle = shade(cloth, 0.85);
        if (f.vertical) g.fillRect(f.x + f.w - 5, f.y, 5, f.h);
        else g.fillRect(f.x, f.y + f.h - 6, f.w, 6);
        g.fillStyle = '#d8b56a';
        if (f.vertical) g.fillRect(f.x + f.w - 6, f.y, 1, f.h);
        else g.fillRect(f.x, f.y + f.h - 7, f.w, 1);
        if (f.kind === 'buffet') {
          for (let x = f.x + 14; x < f.x + f.w - 20; x += 46) {
            g.fillStyle = '#9aa3ad'; g.fillRect(x, f.y + 6, 34, 16);
            g.fillStyle = '#c9d1d9'; g.fillRect(x + 2, f.y + 6, 30, 4);
          }
        } else if (f.kind === 'dessert') {
          for (let x = f.x + 12; x < f.x + f.w - 10; x += 22) {
            g.fillStyle = ['#ff8fab', '#5b3a29', '#ffffff', '#ffd166'][Math.floor(rnd() * 4)];
            g.fillRect(x, f.y + 8, 10, 8);
          }
          g.fillStyle = '#fff6ee'; g.fillRect(f.x + f.w / 2 - 12, f.y - 18, 24, 26);
          g.fillStyle = '#ffd1dc'; g.fillRect(f.x + f.w / 2 - 12, f.y - 10, 24, 3);
        } else if (f.vertical) {
          for (let y = f.y + 12; y < f.y + f.h - 10; y += 30) {
            g.fillStyle = '#c9d1d9'; g.fillRect(f.x + 6, y, 18, 12);
          }
        } else {
          for (let x = f.x + 12; x < f.x + f.w - 10; x += 30) {
            g.fillStyle = '#c9d1d9'; g.fillRect(x, f.y + 6, 18, 12);
          }
        }
        if (f.label) {
          g.fillStyle = '#5b3a72';
          g.font = '700 9px Rubik, system-ui, sans-serif';
          g.textAlign = 'center';
          g.fillText(f.label + ' · ' + f.he, f.x + f.w / 2, f.y + f.h - 8);
        }
        break;
      }
      case 'cocktail': {
        g.fillStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.arc(f.cx + 3, f.cy + 4, f.r, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fbf6ee'; g.beginPath(); g.arc(f.cx, f.cy, f.r, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#e7dccb'; g.beginPath(); g.arc(f.cx, f.cy, f.r - 5, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#ffb347'; g.fillRect(f.cx - 2, f.cy - 4, 4, 6);
        g.fillStyle = '#fff2b0'; g.fillRect(f.cx - 1, f.cy - 6, 2, 2);
        break;
      }
      case 'table': {
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          g.fillStyle = '#c9a24a';
          g.beginPath(); g.arc(f.cx + Math.cos(a) * (f.r + 9), f.cy + Math.sin(a) * (f.r + 9), 6, 0, Math.PI * 2); g.fill();
        }
        g.fillStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.arc(f.cx + 3, f.cy + 5, f.r, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fbf6ee'; g.beginPath(); g.arc(f.cx, f.cy, f.r, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#e4d6c0'; g.lineWidth = 2; g.beginPath(); g.arc(f.cx, f.cy, f.r - 6, 0, Math.PI * 2); g.stroke();
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          g.fillStyle = '#ffffff';
          g.fillRect(Math.round(f.cx + Math.cos(a) * (f.r - 10)) - 3, Math.round(f.cy + Math.sin(a) * (f.r - 10)) - 3, 6, 6);
        }
        g.fillStyle = '#4f8a4b'; g.beginPath(); g.arc(f.cx, f.cy, 9, 0, Math.PI * 2); g.fill();
        for (let i = 0; i < 6; i++) {
          g.fillStyle = i % 2 ? '#ffffff' : '#f49ab0';
          g.fillRect(f.cx - 6 + rnd() * 10, f.cy - 6 + rnd() * 10, 3, 3);
        }
        break;
      }
      case 'bench': {
        g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(f.x + 2, f.y + 4, f.w, f.h);
        g.fillStyle = '#8a5a3c'; g.fillRect(f.x, f.y, f.w, f.h);
        g.fillStyle = '#a8734f'; g.fillRect(f.x, f.y, f.w, 4);
        const bowX = f.side === 'L' ? f.x + f.w - 6 : f.x;
        g.fillStyle = '#ffffff'; g.fillRect(bowX, f.y - 3, 6, 8);
        g.fillStyle = '#f49ab0'; g.fillRect(bowX + 1, f.y - 1, 4, 3);
        break;
      }
      case 'post':
        g.fillStyle = '#d8b56a'; g.fillRect(f.x, f.y, f.w, f.h);
        break;
      case 'bar': {
        g.fillStyle = '#3a2418'; g.fillRect(f.x, f.y, f.w, f.h);
        g.fillStyle = '#5a3826'; g.fillRect(f.x, f.y, f.w, 8);
        g.fillStyle = '#d8b56a'; g.fillRect(f.x, f.y + f.h - 3, f.w, 2);
        const bottleColors = ['#2e7d32', '#8e1b3a', '#e8f6ff', '#f4a72c', '#4fc3ff'];
        for (let x = f.x + 8; x < f.x + f.w - 6; x += 12) {
          g.fillStyle = bottleColors[Math.floor(rnd() * bottleColors.length)];
          g.fillRect(x, f.y - 6, 5, 11);
          g.fillRect(x + 1, f.y - 9, 3, 3);
        }
        break;
      }
      case 'cooler':
        g.fillStyle = '#e8f6ff'; g.fillRect(f.x, f.y, f.w, f.h);
        g.fillStyle = '#4fc3ff'; g.fillRect(f.x + 4, f.y - 10, f.w - 8, 12);
        g.fillStyle = '#9aa3ad'; g.fillRect(f.x + 10, f.y + 10, 6, 4);
        break;
      case 'sofa':
        g.fillStyle = '#8a3b5c'; g.fillRect(f.x, f.y, f.w, f.h);
        g.fillStyle = '#a24c70'; g.fillRect(f.x + 4, f.y + 4, f.w - 8, f.h - 8);
        break;
      case 'gifts':
        g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(f.x + 3, f.y + 4, f.w, f.h);
        g.fillStyle = '#ffffff'; g.fillRect(f.x, f.y, f.w, f.h);
        g.fillStyle = '#d8b56a'; g.fillRect(f.x + f.w / 2 - 3, f.y, 6, f.h); g.fillRect(f.x, f.y + f.h / 2 - 3, f.w, 6);
        g.fillStyle = '#1e1529'; g.fillRect(f.x + 14, f.y + 8, 20, 3);
        g.fillStyle = '#5b3a72'; g.font = '700 10px Rubik, system-ui, sans-serif'; g.textAlign = 'center';
        g.fillText("צ'קים · Gifts", f.x + f.w / 2, f.y - 6);
        break;
      case 'speaker':
        g.fillStyle = '#111111'; g.fillRect(f.x, f.y, f.w, f.h);
        g.fillStyle = '#333333';
        g.beginPath(); g.arc(f.x + f.w / 2, f.y + 14, 9, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(f.x + f.w / 2, f.y + 35, 6, 0, Math.PI * 2); g.fill();
        break;
      default: break;
    }
  }

  function resize() {
    const r = $('app').getBoundingClientRect();
    view.cssW = Math.max(200, r.width);
    view.cssH = Math.max(200, r.height);
    view.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(view.cssW * view.dpr);
    canvas.height = Math.round(view.cssH * view.dpr);
    view.zoom = clamp(Math.min(view.cssW / 720, view.cssH / 480), 0.8, 2.6);
    view.vw = view.cssW / view.zoom;
    view.vh = view.cssH / view.zoom;
  }

  function updateCamera(dt) {
    let tx, ty;
    if (game.state === 'menu' || !player) {
      const s = game.t * 0.04;
      tx = (Math.sin(s) * 0.5 + 0.5) * (WORLD_W - view.vw);
      ty = (Math.cos(s * 0.7) * 0.5 + 0.5) * (WORLD_H - view.vh);
      cam.x += (tx - cam.x) * Math.min(1, dt * 2);
      cam.y += (ty - cam.y) * Math.min(1, dt * 2);
    } else {
      tx = player.x - view.vw / 2;
      ty = player.y - 20 - view.vh / 2;
      const k = 1 - Math.exp(-6 * dt);
      cam.x += (tx - cam.x) * k;
      cam.y += (ty - cam.y) * k;
    }
    cam.x = view.vw >= WORLD_W ? (WORLD_W - view.vw) / 2 : clamp(cam.x, 0, WORLD_W - view.vw);
    cam.y = view.vh >= WORLD_H ? (WORLD_H - view.vh) / 2 : clamp(cam.y, 0, WORLD_H - view.vh);
  }

  const DANCE_COLORS = ['#ff4f8b', '#4fc3ff', '#ffd24f', '#9b5bff'];

  function drawDanceFloor(g, t) {
    const F0 = DANCE_FLOOR;
    g.fillStyle = '#140d1c'; g.fillRect(F0.x - 6, F0.y - 6, F0.w + 12, F0.h + 12);
    const speed = reducedMotion ? 0.5 : 3;
    for (let j = 0; j < F0.h / 40; j++) {
      for (let i = 0; i < F0.w / 40; i++) {
        const idx = Math.floor(i * 3 + j * 5 + t * speed) % 4;
        g.fillStyle = DANCE_COLORS[idx];
        g.globalAlpha = 0.28 + 0.22 * (0.5 + 0.5 * Math.sin(t * speed + i + j * 2));
        g.fillRect(F0.x + i * 40 + 1, F0.y + j * 40 + 1, 38, 38);
      }
    }
    g.globalAlpha = 1;
    // Sweeping spotlights
    if (!reducedMotion) {
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (let k = 0; k < 3; k++) {
        const sx = F0.x + F0.w / 2 + Math.cos(t * 0.7 + k * 2.1) * F0.w * 0.38;
        const sy = F0.y + F0.h / 2 + Math.sin(t * 0.9 + k * 1.7) * F0.h * 0.36;
        const grad = g.createRadialGradient(sx, sy, 0, sx, sy, 80);
        grad.addColorStop(0, 'rgba(255,255,255,0.22)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.fillRect(sx - 80, sy - 80, 160, 160);
      }
      g.restore();
    }
  }

  function drawFlower(g, f) {
    const petals = [['#f49ab0', '#ffffff'], ['#ffffff', '#ffd166'], ['#c38fe0', '#f49ab0']][f.hue];
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath(); g.ellipse(f.x, f.y + 2, 20, 6, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#b98a35'; g.fillRect(f.x - 9, f.y - 8, 18, 10);
    g.fillStyle = '#3f7a3a';
    g.beginPath(); g.arc(f.x - 9, f.y - 16, 11, 0, Math.PI * 2); g.arc(f.x + 9, f.y - 16, 11, 0, Math.PI * 2); g.arc(f.x, f.y - 26, 12, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#4f9a48';
    g.beginPath(); g.arc(f.x - 4, f.y - 22, 7, 0, Math.PI * 2); g.fill();
    const spots = [[-12, -18], [-4, -30], [6, -24], [12, -14], [0, -16], [-8, -24], [9, -32]];
    spots.forEach(([dx, dy], i) => {
      g.fillStyle = petals[i % 2];
      g.fillRect(f.x + dx - 2, f.y + dy - 2, 4, 4);
    });
  }

  function drawBooth(g, t) {
    const f = BOOTH;
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(f.x + 4, f.y + 6, f.w, f.h);
    g.fillStyle = '#2b2236'; g.fillRect(f.x, f.y, f.w, f.h);
    g.fillStyle = '#3d3150'; g.fillRect(f.x + 4, f.y + 4, f.w - 8, 30);
    g.fillStyle = '#111'; g.beginPath(); g.arc(f.x + 26, f.y + 19, 10, 0, Math.PI * 2); g.arc(f.x + 84, f.y + 19, 10, 0, Math.PI * 2); g.fill();
    for (let i = 0; i < 8; i++) {
      const on = Math.floor(t * 6 + i * 1.7) % 3 === 0;
      g.fillStyle = on ? DANCE_COLORS[i % 4] : '#4a3d5c';
      g.fillRect(f.x + 10 + i * 12, f.y + 44, 8, 6);
    }
    g.fillStyle = '#f2c46d'; g.font = '700 10px Silkscreen, monospace'; g.textAlign = 'center';
    g.fillText('DJ', f.x + f.w / 2, f.y + 80);
  }

  function drawCanopy(g, t) {
    const c = CANOPY;
    g.save();
    g.globalAlpha = 0.78;
    g.fillStyle = '#fffaf2'; g.fillRect(c.x, c.y, c.w, c.h);
    g.fillStyle = '#efe4d6';
    for (let x = c.x + 10; x < c.x + c.w; x += 22) g.fillRect(x, c.y, 3, c.h);
    g.globalAlpha = 1;
    const sway = Math.sin(t * 1.5) * 1.5;
    for (let x = c.x; x <= c.x + c.w; x += 12) {
      g.fillStyle = (x / 12) % 2 ? '#f49ab0' : '#ffffff';
      g.fillRect(x - 3, c.y - 3 + sway, 6, 6);
      g.fillRect(x - 3, c.y + c.h - 3 - sway, 6, 6);
    }
    g.fillStyle = '#4f8a4b';
    for (let y = c.y; y <= c.y + c.h; y += 14) { g.fillRect(c.x - 3, y, 5, 8); g.fillRect(c.x + c.w - 2, y, 5, 8); }
    g.restore();
  }

  // String lights along the top of each room
  const BULBS = [];
  for (let x = 40; x < 940; x += 36) BULBS.push({ x, y: 26 });
  for (let x = 990; x < 1980; x += 36) BULBS.push({ x, y: 26 });
  for (let x = DANCE_FLOOR.x; x <= DANCE_FLOOR.x + DANCE_FLOOR.w; x += 32) { BULBS.push({ x, y: DANCE_FLOOR.y - 14 }); }
  for (let x = 40; x < 1020; x += 36) BULBS.push({ x, y: 818 });

  function drawLights(g, t) {
    for (let i = 0; i < BULBS.length; i++) {
      const b = BULBS[i];
      const tw = reducedMotion ? 0.8 : 0.55 + 0.45 * Math.sin(t * 2 + i * 1.3);
      g.globalAlpha = 0.18 * tw;
      g.fillStyle = i % 3 === 0 ? '#ff9ec0' : '#ffd98a';
      g.beginPath(); g.arc(b.x, b.y, 7, 0, Math.PI * 2); g.fill();
      g.globalAlpha = tw;
      g.fillRect(b.x - 1.5, b.y - 1.5, 3, 3);
    }
    g.globalAlpha = 1;
  }

  function drawCone(g, n) {
    const T = n.T;
    if (n.state === 'cooldown' || n.state === 'talk' || n.state === 'hug') return;
    if (game.event.id === 'ceremony' && zoneAt(n.x, n.y).id === 'chuppah') return;
    const z = zoneAt(n.x, n.y);
    g.save();
    g.beginPath(); g.rect(z.x, z.y, z.w, z.h); g.clip();
    const hot = n.state === 'chase' || n.state === 'aim';
    const rgb = T.contact === 'flash' ? '255,96,96' : '255,214,120';
    const range = T.range * (playerOnDanceFloor() ? 0.5 : 1);
    if (T.detect === 'cone') {
      g.fillStyle = 'rgba(' + rgb + ',' + (n.state === 'aim' ? 0.22 : hot ? 0.12 : 0.08) + ')';
      g.beginPath();
      g.moveTo(n.x, n.y - 8);
      g.arc(n.x, n.y - 8, range, n.facing - T.fov / 2, n.facing + T.fov / 2);
      g.closePath();
      g.fill();
    } else {
      g.strokeStyle = 'rgba(' + rgb + ',' + (hot ? 0.3 : 0.16) + ')';
      g.setLineDash([6, 6]);
      g.lineWidth = 2;
      g.beginPath(); g.arc(n.x, n.y - 4, range, 0, Math.PI * 2); g.stroke();
    }
    g.restore();
  }

  function drawBubble(g, text, x, y, accent) {
    g.font = '500 9px Rubik, system-ui, sans-serif';
    const w = Math.ceil(g.measureText(text).width) + 10;
    const h = 15;
    const bx = Math.round(x - w / 2), by = Math.round(y - h);
    g.fillStyle = '#fff4e4';
    g.fillRect(bx, by, w, h);
    g.fillRect(Math.round(x) - 2, by + h, 4, 3);
    g.fillStyle = accent || '#5b3a72';
    g.fillRect(bx, by + h - 2, w, 2);
    g.fillStyle = '#1d1026';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.direction = /[\u0590-\u05FF]/.test(text) ? 'rtl' : 'ltr';
    g.fillText(text, x, by + h / 2);
    g.direction = 'ltr';
    g.textBaseline = 'alphabetic';
  }

  function render() {
    const g = ctx;
    const t = game.t;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#120a18';
    g.fillRect(0, 0, canvas.width, canvas.height);
    const s = view.dpr * view.zoom;
    g.setTransform(s, 0, 0, s, -Math.round(cam.x * s), -Math.round(cam.y * s));
    g.imageSmoothingEnabled = false;

    if (staticLayer) g.drawImage(staticLayer, 0, 0);
    drawDanceFloor(g, t);

    // Items
    for (const it of game.items) {
      if (!it.active) {
        if (it.kind === 'main' && game.eventIdx < EVENT_INDEX.dinner && it.x === 140) {
          g.fillStyle = '#5b3a72'; g.font = '700 9px Rubik, system-ui, sans-serif'; g.textAlign = 'left';
          g.fillText('Opens after the chuppah', 120, 900);
        }
        continue;
      }
      const bob = Math.sin(it.phase * 3) * 1.5;
      g.fillStyle = 'rgba(0,0,0,0.2)';
      g.beginPath(); g.ellipse(it.x, it.y + 4, 7, 2.5, 0, 0, Math.PI * 2); g.fill();
      drawItem(g, it.kind, it.variant, it.x, it.y - 4 + bob);
      if (Math.sin(it.phase * 2.2) > 0.92) {
        g.fillStyle = '#fff6c8';
        g.fillRect(it.x + 6, it.y - 14 + bob, 2, 2);
      }
    }

    // Detection cones
    for (const n of game.npcs) drawCone(g, n);

    // Depth-sorted actors and tall props
    const list = [];
    for (const f of FLOWERS) list.push({ y: f.y + 14, draw: () => drawFlower(g, f) });
    list.push({ y: BOOTH.y + BOOTH.h, draw: () => drawBooth(g, t) });
    list.push({ y: BOOTH.y + 6, draw: () => drawPerson(g, BOOTH.x + 55, BOOTH.y + 6, { skin: '#b97d58', hair: '#1b1b1b', hairStyle: 'cap', cap: '#111', top: '#7a2ff0', bottom: '#111' }, { t, armsUp: true }) });
    for (const d of game.dancers) list.push({ y: d.y, draw: () => drawPerson(g, d.x, d.y, d.look, { t: d.t, armsUp: true, faceRight: d.faceRight }) });
    for (const w of game.waiters) {
      list.push({ y: w.y, draw: () => drawPerson(g, w.x, w.y, w.look, { t: w.t, moving: w.moving, faceRight: w.faceRight, trayColor: w.has ? (w.tray === 'drink' ? '#8e1b3a' : '#d99a3b') : null }) });
    }
    for (const n of game.npcs) {
      list.push({ y: n.y, draw: () => drawPerson(g, n.x, n.y, n.T.look, { t: n.t, moving: n.moving, faceRight: n.faceRight, alpha: n.state === 'cooldown' ? 0.75 : 1 }) });
    }
    if (player && game.state !== 'menu') {
      list.push({
        y: player.y,
        draw: () => {
          g.strokeStyle = player.hidden ? 'rgba(126,224,195,0.9)' : 'rgba(242,196,109,0.85)';
          g.lineWidth = 2;
          g.beginPath(); g.ellipse(player.x, player.y, 11, 5, 0, 0, Math.PI * 2); g.stroke();
          const flicker = player.grace > 0 && Math.floor(t * 12) % 2 === 0;
          drawPerson(g, player.x, player.y, player.look, {
            t, moving: player.moving, faceRight: player.faceRight,
            alpha: player.hidden ? 0.45 : flicker ? 0.6 : 1,
            armsUp: playerOnDanceFloor() && player.moving && player.archId === 'dancer',
          });
        },
      });
    }
    list.sort((a, b) => a.y - b.y);
    for (const r of list) r.draw();

    drawCanopy(g, t);
    drawLights(g, t);

    // Alert marks & speech bubbles
    for (const n of game.npcs) {
      if (n.alert > 0) {
        g.fillStyle = '#ffd24f'; g.fillRect(n.x - 4, n.y - 52, 8, 11);
        g.fillStyle = '#1d1026'; g.fillRect(n.x - 1, n.y - 50, 2, 5); g.fillRect(n.x - 1, n.y - 44, 2, 2);
      }
      if (n.say) drawBubble(g, n.say, n.x, n.y - (n.alert > 0 ? 56 : 38), n.T.contact === 'flash' ? '#ff5e6c' : '#ff7a9c');
    }
    for (const w of game.waiters) if (w.say) drawBubble(g, w.say, w.x, w.y - 38, '#7ee0c3');
    if (player && player.hidden && game.state !== 'menu') drawBubble(g, 'Hiding...', player.x, player.y - 46, '#7ee0c3');

    // Floating score text
    g.textAlign = 'center';
    g.font = '700 10px Silkscreen, monospace';
    for (const f of game.floaters) {
      g.globalAlpha = clamp(f.life, 0, 1);
      g.fillStyle = '#1d1026'; g.fillText(f.text, f.x + 1, f.y + 1);
      g.fillStyle = f.color; g.fillText(f.text, f.x, f.y);
    }
    g.globalAlpha = 1;

    // Tipsy vignette
    if (player && game.state !== 'menu' && player.buzz > 65) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      const a = clamp((player.buzz - 65) / 35, 0, 1) * 0.35;
      const grad = g.createRadialGradient(canvas.width / 2, canvas.height / 2, canvas.height * 0.3, canvas.width / 2, canvas.height / 2, canvas.height * 0.8);
      grad.addColorStop(0, 'rgba(255,122,156,0)');
      grad.addColorStop(1, 'rgba(255,122,156,' + a + ')');
      g.fillStyle = grad;
      g.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  function renderMinimap() {
    const g = mctx;
    const s = mini.width / WORLD_W;
    g.fillStyle = '#170d1f'; g.fillRect(0, 0, mini.width, mini.height);
    for (const z of ZONES) {
      g.fillStyle = z.map;
      g.globalAlpha = z.id === game.zoneId ? 0.95 : 0.55;
      g.fillRect(z.x * s + 1, z.y * s + 1, z.w * s - 2, z.h * s - 2);
    }
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(255,79,139,0.5)';
    g.fillRect(DANCE_FLOOR.x * s, DANCE_FLOOR.y * s, DANCE_FLOOR.w * s, DANCE_FLOOR.h * s);
    for (const n of game.npcs) {
      g.fillStyle = n.state === 'chase' || n.state === 'aim' ? '#ff5e6c' : '#ff9eb0';
      g.fillRect(Math.round(n.x * s) - 2, Math.round(n.y * s) - 2, 4, 4);
    }
    for (const w of game.waiters) {
      g.fillStyle = '#ffffff';
      g.fillRect(Math.round(w.x * s) - 1, Math.round(w.y * s) - 1, 3, 3);
    }
    if (player) {
      g.fillStyle = '#f2c46d';
      g.fillRect(Math.round(player.x * s) - 3, Math.round(player.y * s) - 3, 6, 6);
    }
  }

  // ===================================================================
  // 10. HUD & screens
  // ===================================================================
  const hud = {
    food: $('m-food'), buzz: $('m-buzz'), battery: $('m-battery'),
    foodFill: document.querySelector('#m-food .m-fill'),
    buzzFill: document.querySelector('#m-buzz .m-fill'),
    batteryFill: document.querySelector('#m-battery .m-fill'),
    clock: $('clock'), eventName: $('event-name'), score: $('score'), excuses: $('excuses'), chips: $('chips'),
    cache: {},
  };

  function setText(el, key, value) {
    if (hud.cache[key] !== value) { hud.cache[key] = value; el.textContent = value; }
  }
  function setHtml(el, key, value) {
    if (hud.cache[key] !== value) { hud.cache[key] = value; el.innerHTML = value; }
  }

  function updateHud() {
    const p = player;
    hud.foodFill.style.width = p.food.toFixed(1) + '%';
    hud.buzzFill.style.width = p.buzz.toFixed(1) + '%';
    hud.batteryFill.style.width = p.battery.toFixed(1) + '%';
    hud.food.classList.toggle('low', p.food < 20);
    hud.buzz.classList.toggle('high', p.buzz > 65);
    hud.battery.classList.toggle('low', p.battery < 25);
    setText(hud.clock, 'clock', formatClock(clockMinutes()));
    setText(hud.eventName, 'event', game.event.title);
    setText(hud.score, 'score', String(game.score));
    let ex = '';
    for (let i = 0; i < 3; i++) ex += '<span class="' + (i < p.excuses ? 'on' : '') + '"></span>';
    setHtml(hud.excuses, 'ex', ex);

    const chips = [];
    if (p.hidden) chips.push(['Hidden', 'good']);
    if (playerOnDanceFloor()) chips.push(['In the crowd', 'good']);
    if (inRect(p, LOUNGE)) chips.push(['Recharging', 'good']);
    if (p.boost > 0) chips.push(['Drink boost', '']);
    if (p.buzz > 65) chips.push(['Slippery', 'bad']);
    if (p.held > 0) chips.push(['Hugged', 'bad']);
    if (p.slow > 0 && p.held <= 0) chips.push(['Squished', 'bad']);
    if (p.stun > 0) chips.push(['Blinded', 'bad']);
    if (p.food <= 0) chips.push(['Starving', 'bad']);
    setHtml(hud.chips, 'chips', chips.map(([txt, cls]) => '<span class="chip-s ' + cls + '">' + txt + '</span>').join(''));

    if (p.talking) {
      $('convo-fill').style.width = (p.escape * 100).toFixed(0) + '%';
      setText($('convo-hint'), 'hint', p.excuses > 0
        ? 'Mash the arrow keys to wriggle free, or press E to use a drink as an excuse (' + p.excuses + ' left)'
        : 'Mash the arrow keys to wriggle free. No drinks left to excuse yourself with.');
    }
  }

  let toastTimer = 0;
  function showToast(title, sub, cls, secs) {
    const el = $('toast');
    $('toast-title').textContent = title;
    $('toast-sub').textContent = sub || '';
    el.className = cls || '';
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    toastTimer = secs || 2.5;
  }
  function updateToast(dt) {
    if (toastTimer > 0) {
      toastTimer -= dt;
      if (toastTimer <= 0) $('toast').hidden = true;
    }
  }

  let zoneTimer = null;
  function showZone(z) {
    const el = $('zone-label');
    el.innerHTML = '';
    el.append(document.createTextNode(z.name));
    const small = document.createElement('small');
    small.lang = 'he';
    small.textContent = z.he;
    el.append(small);
    el.classList.add('show');
    clearTimeout(zoneTimer);
    zoneTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function showScreen(id) {
    ['screen-menu', 'screen-pause', 'screen-summary'].forEach((s) => { $(s).hidden = s !== id; });
  }

  function startGame() {
    Sound.init();
    Sound.sfx('click');
    playerLook = buildLook(selection);
    newGame(playerLook, selection.arch);
    game.state = 'play';
    showScreen(null);
    $('hud').hidden = false;
    $('convo').hidden = true;
    $('touch').hidden = !$('app').classList.contains('touching');
    hud.cache = {};
    cam.x = player.x - view.vw / 2;
    cam.y = player.y - view.vh / 2;
    Sound.startMusic();
    showToast(EVENTS[0].title + ' · ' + EVENTS[0].he, EVENTS[0].desc, 'event', 4);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  function pauseGame() {
    if (game.state !== 'play') return;
    game.state = 'paused';
    keys.clear(); touchDirs.clear();
    Sound.stopMusic();
    $('btn-mute').textContent = Sound.isMuted() ? 'Unmute sound' : 'Mute sound';
    showScreen('screen-pause');
    $('btn-resume').focus();
  }

  function resumeGame() {
    if (game.state !== 'paused') return;
    game.state = 'play';
    showScreen(null);
    Sound.init();
    Sound.startMusic();
  }

  function toggleMute() {
    const m = Sound.toggleMute();
    $('btn-mute').textContent = m ? 'Unmute sound' : 'Mute sound';
    showToast(m ? 'Sound off' : 'Sound on', '', '', 1.2);
  }

  function quitToMenu() {
    game.state = 'menu';
    Sound.stopMusic();
    $('hud').hidden = true;
    $('convo').hidden = true;
    $('touch').hidden = true;
    $('toast').hidden = true;
    player = null;
    newGame(playerLook, selection.arch);
    player = null;
    showScreen('screen-menu');
  }

  function rankFor(score, won) {
    if (!won) return 'Sent home early. Uber is on the way.';
    if (score >= 3000) return 'Legend of the dance floor';
    if (score >= 2000) return 'Seasoned wedding pro';
    if (score >= 1200) return 'Respectable guest';
    return 'Survived, barely';
  }

  function endGame(won) {
    game.state = 'over';
    game.won = won;
    Sound.stopMusic();
    Sound.sfx(won ? 'win' : 'lose');
    $('hud').hidden = true;
    $('convo').hidden = true;
    $('touch').hidden = true;
    $('toast').hidden = true;
    if (player.talking) player.talking = null;

    const st = game.stats;
    const best = parseInt(storageGet('ws-best') || '0', 10) || 0;
    const isBest = game.score > best;
    if (isBest) storageSet('ws-best', String(game.score));

    $('sum-eyebrow').textContent = won ? '02:00 · The band is packing up' : formatClock(clockMinutes()) + ' · Social battery empty';
    $('sum-title').textContent = won ? 'You survived the night' : 'You had to leave early';
    $('sum-rank').textContent = rankFor(game.score, won);
    $('sum-score').textContent = String(game.score);
    $('sum-best').textContent = isBest ? 'New personal best' : best ? 'Personal best: ' + best : '';

    const rows = [
      ['Finger food', st.canape],
      ['Main courses', st.main],
      ['Desserts', st.dessert],
      ['Drinks', st.drinks],
      ['Glasses of water', st.water],
      ['Conversations escaped', st.escaped + ' of ' + st.convos],
      ['Relatives dodged', st.dodged],
      ['Uncle hugs survived', st.hugs],
      ['Camera flashes', st.flashes],
      ['Left the party at', formatClock(clockMinutes())],
    ];
    const dl = $('sum-stats');
    dl.innerHTML = '';
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = String(v);
      dl.append(dt, dd);
    }
    showScreen('screen-summary');
    $('btn-again').focus();
  }

  // ---- Character creator ----
  function buildSwatches() {
    const cs = $('color-swatches');
    OUTFIT_COLORS.forEach((c, i) => {
      const label = document.createElement('label');
      label.className = 'swatch';
      label.title = c.name;
      label.innerHTML = '<input type="radio" name="color" id="c-' + c.id + '" value="' + c.id + '"' + (i === 0 ? ' checked' : '') +
        ' aria-label="' + c.name + '"><span style="background:' + c.hex + '"></span>';
      cs.append(label);
    });
    const ss = $('skin-swatches');
    SKINS.forEach((hex, i) => {
      const label = document.createElement('label');
      label.className = 'swatch';
      label.title = 'Skin tone ' + (i + 1);
      label.innerHTML = '<input type="radio" name="skin" id="k-' + i + '" value="' + i + '"' + (i === 1 ? ' checked' : '') +
        ' aria-label="Skin tone ' + (i + 1) + '"><span style="background:' + hex + '"></span>';
      ss.append(label);
    });
  }

  function readSelection() {
    const form = $('creator');
    const val = (name) => { const el = form.querySelector('input[name="' + name + '"]:checked'); return el ? el.value : null; };
    selection.gender = val('gender') || 'woman';
    selection.arch = val('arch') || 'dancer';
    selection.style = val('style') || 'suit';
    selection.color = val('color') || 'gold';
    selection.skin = parseInt(val('skin') || '1', 10);
    playerLook = buildLook(selection);
    $('color-note').textContent = selection.color === 'ivory' ? '· wearing white to a wedding? Bold.' : '';
    const A = ARCH[selection.arch];
    $('arch-stats').innerHTML = Object.keys(A.stats).map((k) =>
      '<div class="stat"><span>' + k + '</span><i><b style="width:' + Math.round(A.stats[k] * 100) + '%"></b></i></div>').join('');
  }

  function renderPreview(t) {
    const g = pctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    g.fillStyle = '#2a1838';
    g.beginPath(); g.ellipse(80, 176, 56, 14, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#3b2350';
    g.beginPath(); g.ellipse(80, 172, 50, 11, 0, 0, Math.PI * 2); g.fill();
    g.setTransform(5, 0, 0, 5, 0, 0);
    g.imageSmoothingEnabled = false;
    const faceRight = Math.floor(t / 2) % 2 === 0;
    drawPerson(g, 16, 34.5, playerLook, { t, moving: true, faceRight });
  }

  // ===================================================================
  // 11. Boot
  // ===================================================================
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (game.state === 'play') {
      update(dt);
    } else if (game.state === 'menu') {
      updateWorld(dt);
    }
    if (game.state !== 'paused') updateCamera(dt);
    render();
    if (game.state === 'play' && player) {
      updateHud();
      renderMinimap();
    }
    if (!$('screen-menu').hidden) renderPreview(now / 1000);
    requestAnimationFrame(frame);
  }

  function boot() {
    buildSwatches();
    readSelection();
    $('creator').addEventListener('change', () => { readSelection(); Sound.init(); Sound.sfx('click'); });
    $('creator').addEventListener('submit', (e) => { e.preventDefault(); readSelection(); startGame(); });
    $('btn-resume').addEventListener('click', resumeGame);
    $('btn-mute').addEventListener('click', toggleMute);
    $('btn-quit').addEventListener('click', quitToMenu);
    $('btn-again').addEventListener('click', startGame);
    $('btn-change').addEventListener('click', quitToMenu);
    setupTouch();

    resize();
    window.addEventListener('resize', resize);
    staticLayer = buildStatic();
    // Re-draw the venue once web fonts arrive so floor signs use them.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { staticLayer = buildStatic(); }).catch(() => {});
    }

    newGame(playerLook, selection.arch);
    player = null; // no player on the menu backdrop
    showScreen('screen-menu');
    requestAnimationFrame(frame);
  }

  boot();
})();
