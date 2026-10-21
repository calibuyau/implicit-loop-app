// The four games (ports of App/Sources/Games). Each reads only the hidden actuator through
// `hooks` (lucky(), interval(), juice()) and reports reward opportunities via hooks.outcome().
// Optional hooks.sound() → false mutes a game's sound effects.
// mountGame(kind, element, hooks) → { destroy() }.

import { sfx, unlockAudio } from './sound.js';

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));   // inclusive
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = randInt(0, i); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/// Canvas that tracks its CSS size at device-pixel resolution.
function hiDPI(canvas, draw) {
  const ro = new ResizeObserver(() => {
    const r = canvas.getBoundingClientRect(), d = devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(r.width * d));
    canvas.height = Math.max(1, Math.round(r.height * d));
    canvas.getContext('2d').setTransform(d, 0, 0, d, 0, 0);
    draw();
  });
  ro.observe(canvas);
  return ro;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/// Keyboard listener that is removed when the game unmounts.
function keys(map) {
  const f = e => {
    const a = map[e.key];
    if (!a) return;
    e.preventDefault();
    unlockAudio();
    a(e);
  };
  addEventListener('keydown', f);
  return () => removeEventListener('keydown', f);
}

// MARK: Candy look (shared by Blocks and Gems)

/// Candy palette: [highlight, body, rim] for red, orange, green, blue, purple.
const CANDY = [
  ['#ffb3b3', '#f2283a', '#8a0716'],
  ['#ffe08a', '#ff9500', '#a84300'],
  ['#b6ff9e', '#33cc3d', '#11701a'],
  ['#b8e2ff', '#2f86ff', '#0a3a9e'],
  ['#f3c4ff', '#b444ff', '#560ea0'],
];
const GOLD = ['#fff6b0', '#ffc61a', '#c76a00'];
const GRAVITY = 70;   // cells/s² for falling candies
const ease = t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeOutBack = t => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
const CANDY_FONT = '"Arial Rounded MT Bold", ui-rounded, system-ui, sans-serif';

/// Glossy candy pre-rendered at `px` device pixels per cell (plus padding for the shadow).
/// `path(ctx)` builds the outline in unit coordinates (cell = 1, centred on the origin);
/// `decorate(ctx, colors)` adds details on top.
function glossySprite(px, colors, path, { decorate = null, reach = 0.46, rimWidth = 0.025 } = {}) {
  const cv = document.createElement('canvas'), pad = Math.ceil(px * 0.15);
  cv.width = cv.height = px + 2 * pad;
  const ctx = cv.getContext('2d'), [hi, body, rim] = colors;
  ctx.translate(cv.width / 2, cv.height / 2);
  ctx.scale(px, px);
  ctx.lineJoin = 'round';
  ctx.save();
  ctx.shadowColor = 'rgba(40, 0, 70, 0.45)'; ctx.shadowBlur = px * 0.07; ctx.shadowOffsetY = px * 0.045;
  path(ctx); ctx.fillStyle = rim; ctx.fill();
  ctx.restore();
  path(ctx);
  const g = ctx.createRadialGradient(-0.12, -0.15, 0.02, 0, 0.02, reach);
  g.addColorStop(0, hi); g.addColorStop(0.45, body); g.addColorStop(1, rim);
  ctx.fillStyle = g; ctx.fill();
  ctx.lineWidth = rimWidth; ctx.strokeStyle = rim; ctx.stroke();
  ctx.save();
  ctx.clip();
  const bounce = ctx.createRadialGradient(0.06, 0.32, 0, 0.06, 0.32, 0.24);   // light bouncing up from below
  bounce.addColorStop(0, hi + '99'); bounce.addColorStop(1, hi + '00');
  ctx.fillStyle = bounce; ctx.fillRect(-0.5, -0.5, 1, 1);
  const gloss = ctx.createLinearGradient(0, -0.4, 0, 0.02);
  gloss.addColorStop(0, 'rgba(255,255,255,0.85)'); gloss.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gloss;
  ctx.beginPath(); ctx.ellipse(-0.04, -0.17, 0.24, 0.13, -0.25, 0, 2 * Math.PI); ctx.fill();
  ctx.restore();
  decorate?.(ctx, colors);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.beginPath(); ctx.arc(-0.15, -0.2, 0.035, 0, 2 * Math.PI); ctx.fill();
  return cv;
}

/// Four-point twinkle of radius r at the origin.
function twinkle(ctx, r) {
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.quadraticCurveTo(0, 0, r, 0); ctx.quadraticCurveTo(0, 0, 0, r);
  ctx.quadraticCurveTo(0, 0, -r, 0); ctx.quadraticCurveTo(0, 0, 0, -r);
  ctx.fill();
}

function lollipop(ctx, x, y, r, color) {
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(x - r * 0.06, y, r * 0.12, r * 2.4);
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = r * 0.12;
  ctx.beginPath();
  for (let a = 0; a < 6 * Math.PI; a += 0.2) ctx.lineTo(x + Math.cos(a) * r * a / (6 * Math.PI), y + Math.sin(a) * r * a / (6 * Math.PI));
  ctx.stroke();
}

function candyBackdrop(ctx, W, H) {
  const g = ctx.createLinearGradient(0, 0, 0, H), m = Math.min(W, H);
  g.addColorStop(0, '#ffc8e6'); g.addColorStop(0.55, '#d9c2ff'); g.addColorStop(1, '#ffe7a8');
  ctx.fillStyle = g;
  roundRect(ctx, 0, 0, W, H, 14); ctx.fill();
  ctx.save(); ctx.clip();
  for (const [fx, fy, fr, col] of [[0.06, 0.12, 0.2, 'rgba(255,255,255,0.4)'], [0.95, 0.35, 0.24, 'rgba(255,150,210,0.3)'],
    [0.1, 0.9, 0.26, 'rgba(180,140,255,0.3)'], [0.9, 0.92, 0.17, 'rgba(255,255,255,0.35)']]) {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(fx * W, fy * H, fr * m, 0, 2 * Math.PI); ctx.fill();
  }
  lollipop(ctx, W * 0.1, H * 0.3, m * 0.12, 'rgba(255,120,190,0.45)');
  lollipop(ctx, W * 0.9, H * 0.62, m * 0.1, 'rgba(150,120,255,0.4)');
  ctx.restore();
}

/// Translucent board tray with a faint checker, `cols` × `rows` cells of size s at (ox, oy).
function candyTray(ctx, ox, oy, cols, rows, s) {
  const pad = s * 0.12;
  ctx.fillStyle = 'rgba(38, 44, 120, 0.55)';
  roundRect(ctx, ox - pad, oy - pad, cols * s + 2 * pad, rows * s + 2 * pad, s * 0.3); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2; ctx.stroke();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    ctx.fillStyle = (r + c) % 2 ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.06)';
    roundRect(ctx, ox + c * s + 1.5, oy + r * s + 1.5, s - 3, s - 3, s * 0.14); ctx.fill();
  }
}

/// Glowing horizontal beams across `rows` (cell units) at progress p ∈ [0, 1].
function candyBeams(ctx, rows, p, ox, oy, width, s) {
  const a = Math.sin(p * Math.PI), bw = width * Math.min(1, p * 3), bh = s * (0.35 + 0.4 * p), cx = ox + width / 2;
  for (const r of rows) {
    const cy = oy + (r + 0.5) * s, g = ctx.createLinearGradient(0, cy - bh / 2, 0, cy + bh / 2);
    g.addColorStop(0, 'rgba(255,240,150,0)'); g.addColorStop(0.5, `rgba(255,255,255,${a})`); g.addColorStop(1, 'rgba(255,240,150,0)');
    ctx.fillStyle = g; ctx.fillRect(cx - bw / 2, cy - bh / 2, bw, bh);
  }
}

/// Particles, floating score numbers and celebration words, positioned in cell units.
function candyFx() {
  const parts = [], popups = [], words = [];
  const add = p => parts.push({ vx: 0, vy: 0, g: 0, t: 0, rot: 0, vr: 0, color: '#fff', ...p });
  return {
    /// A candy bursting at (x, y): shards in its colours, a few sparks and a ring.
    shatter(x, y, colors, shards = 7) {
      for (let i = 0; i < shards; i++) {
        const a = rand(0, 2 * Math.PI), sp = rand(1.5, 4);
        add({ kind: 'shard', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.5, g: 12, life: rand(0.45, 0.75),
          size: rand(0.09, 0.17), rot: rand(0, 6), vr: rand(-10, 10), color: colors[i % 3 === 0 ? 0 : 1] });
      }
      for (let i = 0; i < 3; i++) add({ kind: 'spark', x: x + rand(-0.3, 0.3), y: y + rand(-0.3, 0.3), vx: rand(-0.5, 0.5), vy: rand(-1.2, -0.2), life: rand(0.35, 0.6), size: rand(0.12, 0.22) });
      add({ kind: 'ring', x, y, life: 0.32, size: 0.75 });
    },
    confetti(x, y, n) {
      for (let i = 0; i < n; i++) {
        const a = rand(-Math.PI * 0.9, -Math.PI * 0.1), sp = rand(5, 10);
        add({ kind: 'confetti', x: x + rand(-0.6, 0.6), y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 11,
          life: rand(0.9, 1.5), size: rand(0.13, 0.2), rot: rand(0, 6), vr: rand(-12, 12), color: CANDY[i % CANDY.length][1] });
      }
    },
    glint(x, y) { add({ kind: 'spark', x, y, life: 0.5, size: 0.16 }); },
    /// Floating score number; `size` = font size in cells.
    popup(x, y, text, color, size = 0.42) { popups.push({ x, y, text, color, size, t: 0 }); },
    /// Big centred word; `size` in cells.
    word(text, size) { words.push({ text, size, t: 0 }); },
    update(dt) {
      for (const p of parts) { p.t += dt; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt; }
      for (const p of popups) p.t += dt;
      for (const w of words) w.t += dt;
      for (const [list, life] of [[parts, null], [popups, 0.9], [words, 1.2]]) {
        for (let i = list.length - 1; i >= 0; i--) if (list[i].t > (life ?? list[i].life)) list.splice(i, 1);
      }
    },
    /// Particles and score numbers on a board whose cells are s px from (ox, oy).
    draw(ctx, ox, oy, s) {
      for (const p of parts) {
        const q = p.t / p.life;
        ctx.save();
        ctx.translate(ox + p.x * s, oy + p.y * s);
        ctx.fillStyle = p.color;
        if (p.kind === 'ring') {
          ctx.strokeStyle = `rgba(255,255,255,${1 - q})`; ctx.lineWidth = s * 0.08 * (1 - q);
          ctx.beginPath(); ctx.arc(0, 0, p.size * s * (0.3 + 0.7 * q), 0, 2 * Math.PI); ctx.stroke();
        } else if (p.kind === 'spark') {
          ctx.globalAlpha = 0.95; twinkle(ctx, p.size * s * Math.sin(q * Math.PI));
        } else {
          ctx.globalAlpha = q < 0.7 ? 1 : (1 - q) / 0.3;
          ctx.rotate(p.rot);
          if (p.kind === 'confetti') ctx.scale(Math.cos(p.rot * 1.7), 1);
          const z = p.size * s;
          ctx.beginPath(); ctx.roundRect(-z / 2, -z * 0.35, z, z * 0.7, z * 0.25); ctx.fill();
        }
        ctx.restore();
      }
      ctx.lineJoin = 'round'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const p of popups) {
        const q = p.t / 0.9, z = q < 0.2 ? easeOutBack(q / 0.2) : 1;
        ctx.save();
        ctx.globalAlpha = q < 0.7 ? 1 : (1 - q) / 0.3;
        ctx.translate(ox + p.x * s, oy + (p.y - 0.7 * q) * s);
        ctx.scale(z, z);
        const fs = s * p.size;
        ctx.font = `800 ${fs}px ${CANDY_FONT}`;
        ctx.strokeStyle = '#4a1070'; ctx.lineWidth = fs * 0.4; ctx.strokeText(p.text, 0, 0);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = fs * 0.2; ctx.strokeText(p.text, 0, 0);
        ctx.fillStyle = p.color; ctx.fillText(p.text, 0, 0);
        ctx.restore();
      }
    },
    /// Celebration words centred on (cx, cy); `s` = cell size in px.
    drawWords(ctx, cx, cy, s) {
      ctx.lineJoin = 'round'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const w of words) {
        const q = w.t / 1.2, z = q < 0.25 ? easeOutBack(q / 0.25) : 1, fs = s * w.size;
        ctx.save();
        ctx.globalAlpha = q < 0.7 ? 1 : (1 - q) / 0.3;
        ctx.translate(cx, cy);
        ctx.scale(z, z);
        ctx.font = `900 ${fs}px ${CANDY_FONT}`;
        ctx.strokeStyle = '#4a1070'; ctx.lineWidth = fs * 0.18; ctx.strokeText(w.text, 0, 0);
        const g = ctx.createLinearGradient(0, -fs / 2, 0, fs / 2);
        g.addColorStop(0, '#fff3a0'); g.addColorStop(0.5, '#ff8fd0'); g.addColorStop(1, '#c04bff');
        ctx.fillStyle = g; ctx.fillText(w.text, 0, 0);
        ctx.restore();
      }
    },
  };
}

/// requestAnimationFrame loop calling frame(dt, now); returns a stop function.
function animate(frame) {
  let raf = 0, last = performance.now();
  const tick = now => {
    frame(Math.min(0.05, Math.max(0, now - last) / 1000), now);
    last = now;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

// MARK: Blocks

const COLS = 10, ROWS = 18;
const SHAPES = [
  [[0, 1], [1, 1], [2, 1], [3, 1]],   // I
  [[0, 0], [1, 0], [0, 1], [1, 1]],   // O
  [[0, 1], [1, 1], [2, 1], [1, 0]],   // T
  [[0, 1], [1, 1], [2, 1], [2, 0]],   // L
  [[0, 1], [1, 1], [2, 1], [0, 0]],   // J
  [[1, 0], [2, 0], [0, 1], [1, 1]],   // S
  [[0, 0], [1, 0], [1, 1], [2, 1]],   // Z
];
/// Candy colours per piece (I, O, T, L, J, S, Z).
const BLOCK_CANDY = [['#c2f7ff', '#1ec8ea', '#05708c'], ['#fff4ad', '#ffd21f', '#a37400'], CANDY[4], CANDY[1], CANDY[3], CANDY[2], CANDY[0]];

/// Jelly cube sprites for all seven pieces at `px` device pixels per cell (cached).
const blockSprites = (() => {
  const cache = new Map();
  return px => {
    if (!cache.has(px)) {
      cache.set(px, BLOCK_CANDY.map(colors => glossySprite(px, colors, ctx => { ctx.beginPath(); ctx.roundRect(-0.45, -0.45, 0.9, 0.9, 0.2); }, {
        reach: 0.6,
        decorate(ctx) {
          ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.04;
          ctx.beginPath(); ctx.roundRect(-0.32, -0.32, 0.64, 0.64, 0.12); ctx.stroke();
        },
      })));
    }
    return cache.get(px);
  };
})();

/// Tetris-like. Covert lever: next-piece bias — a favourable draw gives an easy piece
/// (I/O/T/L/J), otherwise an awkward S/Z. Gravity scales with the tuned reward interval.
/// Presentation (sliding, beams, particles, sounds) never depends on which kind of draw it was;
/// the line-clear celebration scales with juice, like the flash.
function blocks(el, h) {
  el.innerHTML = `
    <div class="game blocks">
      <div class="game-top"><span class="score">0</span><canvas class="next"></canvas></div>
      <div class="board-wrap"><canvas class="board"></canvas></div>
      <div class="pad">
        <button data-a="left" aria-label="Left">←</button><button data-a="rot" aria-label="Rotate">⟳</button>
        <button data-a="drop" aria-label="Drop">⤓</button><button data-a="right" aria-label="Right">→</button>
      </div>
      <p class="hint">Arrow keys move · ↑ rotates · Space drops</p>
    </div>`;
  const canvas = el.querySelector('.board'), nextC = el.querySelector('.next'), scoreEl = el.querySelector('.score');
  const sound = (name, ...a) => { if (h.sound?.() !== false) sfx[name](...a); };
  let board = [...Array(ROWS)].map(() => Array(COLS).fill(null));
  let piece = null, next = 0, score = 0, flash = 0, acc = 0;
  // Presentation state.
  const fx = candyFx();
  let visX = 0, visY = 0, shownScore = 0, rotPulse = 0, trail = null, landed = null, rowFall = null, beams = null, wipe = null;

  const drawKind = () => { const good = h.lucky(); h.outcome(good, false); return good ? randInt(0, 4) : randInt(5, 6); };
  const fits = p => p.cells.every(([cx, cy]) => {
    const x = p.x + cx, y = p.y + cy;
    return x >= 0 && x < COLS && y < ROWS && (y < 0 || board[y][x] == null);
  });
  function spawn() {
    piece = { kind: next, cells: SHAPES[next].map(c => [...c]), x: 3, y: 0 };
    next = drawKind();
    if (!fits(piece)) {   // gentle restart
      wipe = { board, t: 0 };
      sound('restart');
      board = board.map(r => r.map(() => null)); score = 0; shownScore = 0;
    }
    visX = piece.x; visY = piece.y;
  }
  function move(dx, dy, lock = false) {
    if (!piece) return;
    const p = { ...piece, x: piece.x + dx, y: piece.y + dy };
    if (fits(p)) { piece = p; if (dx) sound('move'); } else if (dy > 0 && lock) settle();
  }
  function rotate() {
    if (!piece || piece.kind === 1) return;
    const cells = piece.cells.map(([x, y]) => [2 - y, x]);
    for (const kick of [0, -1, 1, -2, 2]) {
      const q = { ...piece, cells, x: piece.x + kick };
      if (fits(q)) { piece = q; rotPulse = 1; sound('rotate'); break; }
    }
  }
  function drop() {
    if (!piece) return;
    const y0 = piece.y;
    while (fits({ ...piece, y: piece.y + 1 })) piece = { ...piece, y: piece.y + 1 };
    if (piece.y > y0) trail = { piece, y0, t: 0 };
    sound('drop');
    settle(true);
  }
  function settle(hard = false) {
    for (const [cx, cy] of piece.cells) if (piece.y + cy >= 0) board[piece.y + cy][piece.x + cx] = piece.kind;
    landed = { cells: new Set(piece.cells.map(([cx, cy]) => (piece.y + cy) * COLS + piece.x + cx)), t: 0 };
    const fullRows = board.flatMap((r, i) => (r.every(v => v != null) ? [i] : []));
    const full = fullRows.length;
    if (full) {
      const cleared = fullRows.map(i => board[i]);
      board = board.filter(r => !r.every(v => v != null));
      while (board.length < ROWS) board.unshift(Array(COLS).fill(null));
      const points = [0, 100, 300, 500, 800][Math.min(4, full)];
      score += points;
      flash = Math.min(1.5, 0.6 * h.juice() * full);
      lineClear(fullRows, cleared, points, h.juice());
    } else if (!hard) sound('lock');
    spawn();
  }
  function lineClear(rows, cleared, points, juice) {
    rows.forEach((r, i) => cleared[i].forEach((k, c) => fx.shatter(c + 0.5, r + 0.5, BLOCK_CANDY[k], 4)));
    // Each surviving row drops by the number of cleared rows below it; new index = old + that count.
    const drop = Array(ROWS).fill(0);
    for (let old = 0; old < ROWS; old++) {
      if (rows.includes(old)) continue;
      const below = rows.filter(r => r > old).length;
      drop[old + below] = below;
    }
    rowFall = { drop, t: 0 };
    landed = null;
    beams = { rows, t: 0 };
    const mid = rows.reduce((a, b) => a + b, 0) / rows.length + 0.5;
    fx.popup(COLS / 2, mid, String(points), GOLD[1], 1);
    fx.confetti(COLS / 2, mid, Math.round(6 * juice * rows.length));
    if (rows.length >= 2) fx.word(rows.length >= 3 ? 'Superb!' : 'Nice!', 1.1 + 0.3 * (juice - 1));
    sound('lines', rows.length);
    if (rows.length >= 2) sound('celebrate', juice, rows.length >= 3, 0.12);
  }

  function update(dt) {
    fx.update(dt);
    rotPulse = Math.max(0, rotPulse - dt * 8);
    if (piece) { const k = Math.min(1, dt * 28); visX += (piece.x - visX) * k; visY += (piece.y - visY) * k; }
    for (const a of [trail, landed, rowFall, beams, wipe]) if (a) a.t += dt;
    if (trail?.t > 0.2) trail = null;
    if (landed?.t > 0.14) landed = null;
    if (rowFall?.t > 0.6) rowFall = null;
    if (beams?.t > 0.35) beams = null;
    if (wipe?.t > 0.8) wipe = null;
    shownScore = Math.abs(score - shownScore) < 1 ? score : shownScore + (score - shownScore) * Math.min(1, dt * 10);
  }

  function geom() {
    const W = canvas.clientWidth, H = canvas.clientHeight, s = Math.min(W / (COLS + 0.4), H / (ROWS + 0.4));
    return { W, H, s, ox: (W - s * COLS) / 2, oy: (H - s * ROWS) / 2 };
  }
  function draw(now) {
    const ctx = canvas.getContext('2d'), { W, H, s, ox, oy } = geom();
    if (!(s > 0)) return;
    const d = devicePixelRatio || 1, ims = blockSprites(Math.max(6, Math.round(s * d))), bw = s * COLS, bh = s * ROWS;
    const blit = (k, x, y, sx = 1, sy = 1, alpha = 1) => {
      const im = ims[k], w = im.width / d;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(ox + (x + 0.5) * s, oy + (y + 0.5) * s);
      ctx.scale(sx, sy);
      ctx.drawImage(im, -w / 2, -w / 2, w, w);
      ctx.restore();
    };
    ctx.clearRect(0, 0, W, H);
    candyBackdrop(ctx, W, H);
    candyTray(ctx, ox, oy, COLS, ROWS, s);
    ctx.save();
    roundRect(ctx, ox, oy, bw, bh, s * 0.16); ctx.clip();
    if (wipe) {   // the previous board falls away after a restart
      const t = wipe.t;
      wipe.board.forEach((row, r) => row.forEach((k, c) => { if (k != null) blit(k, c, r + 0.5 * 30 * t * t * (1 + (c % 3) * 0.15), 1, 1, Math.max(0, 1 - t / 0.8)); }));
    }
    board.forEach((row, r) => row.forEach((k, c) => {
      if (k == null) return;
      let y = r, sx = 1, sy = 1;
      const d2 = rowFall?.drop[r] ?? 0;
      if (d2 > 0) {
        const T = Math.sqrt(2 * d2 / GRAVITY), t = rowFall.t;
        if (t < T) y = r - d2 + 0.5 * GRAVITY * t * t;
      }
      if (landed?.cells.has(r * COLS + c)) {
        const w = Math.sin(landed.t / 0.14 * Math.PI);
        sy = 1 - 0.12 * w; sx = 1 + 0.08 * w; y += 0.06 * w;
      }
      blit(k, c, y, sx, sy);
    }));
    if (trail) {   // hard-drop streak above each column of the piece
      const a = 1 - trail.t / 0.2, p = trail.piece, col = BLOCK_CANDY[p.kind][1];
      const tops = new Map();
      for (const [cx, cy] of p.cells) tops.set(cx, Math.min(tops.get(cx) ?? 9, cy));
      for (const [cx, cy] of tops) {
        const x = ox + (p.x + cx + 0.15) * s, y1 = oy + (p.y + cy) * s, y0 = oy + (trail.y0 + cy) * s;
        const g = ctx.createLinearGradient(0, y0, 0, y1);
        g.addColorStop(0, col + '00'); g.addColorStop(1, col);
        ctx.globalAlpha = 0.6 * a; ctx.fillStyle = g; ctx.fillRect(x, y0, s * 0.7, y1 - y0);
      }
      ctx.globalAlpha = 1;
    }
    if (piece) {
      const k = 1 + 0.08 * rotPulse;
      for (const [cx, cy] of piece.cells) if (visY + cy > -1) blit(piece.kind, visX + cx, visY + cy, k, k);
    }
    ctx.restore();
    if (beams) candyBeams(ctx, beams.rows, beams.t / 0.35, ox, oy, bw, s);
    fx.draw(ctx, ox, oy, s);
    if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${flash * 0.35})`; roundRect(ctx, ox, oy, bw, bh, s * 0.16); ctx.fill(); }
    fx.drawWords(ctx, W / 2, oy + bh * 0.4, s);
    const shown = String(Math.round(shownScore));
    if (scoreEl.textContent !== shown) scoreEl.textContent = shown;
    drawNext();
  }
  let nextDrawn = '';
  function drawNext() {
    const d = devicePixelRatio || 1, key = `${next}@${d}`;
    if (key === nextDrawn) return;
    nextDrawn = key;
    nextC.width = 52 * d; nextC.height = 26 * d;
    const n = nextC.getContext('2d'), u = 12 * d, ims = blockSprites(Math.round(u));
    n.clearRect(0, 0, nextC.width, nextC.height);
    const xs = SHAPES[next].map(([x]) => x), ys = SHAPES[next].map(([, y]) => y);
    const offX = (nextC.width - (Math.max(...xs) + 1) * u) / 2, offY = (nextC.height - (Math.max(...ys) + 1) * u) / 2;
    for (const [cx, cy] of SHAPES[next]) {
      const im = ims[next];
      n.drawImage(im, offX + (cx + 0.5) * u - im.width / 2, offY + (cy + 0.5) * u - im.height / 2);
    }
  }

  const actions = { left: () => move(-1, 0), right: () => move(1, 0), rot: rotate, drop };
  el.querySelector('.pad').addEventListener('click', e => { unlockAudio(); actions[e.target.closest('button')?.dataset.a]?.(); });
  // Swipe on the board: horizontal = move, down = drop; tap = rotate.
  let p0 = null;
  canvas.addEventListener('pointerdown', e => { unlockAudio(); p0 = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', e => {
    if (!p0) return;
    const dx = e.clientX - p0[0], dy = e.clientY - p0[1];
    p0 = null;
    if (Math.hypot(dx, dy) < 20) rotate();
    else if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 1 : -1, 0);
    else if (dy > 0) drop();
  });
  const unkey = keys({ ArrowLeft: actions.left, ArrowRight: actions.right, ArrowUp: rotate, ArrowDown: () => move(0, 1), ' ': drop });

  next = drawKind();
  spawn();
  const stop = animate((dt, now) => { update(dt); draw(now); });
  const ro = hiDPI(canvas, () => draw(performance.now()));
  const timer = setInterval(() => {
    flash = Math.max(0, flash - 0.05);
    acc += 0.05;
    const gravity = Math.min(0.6, Math.max(0.15, h.interval() / 7));
    if (acc >= gravity) { acc = 0; move(0, 1, true); }
  }, 50);
  return { destroy() { clearInterval(timer); stop(); ro.disconnect(); unkey(); } };
}

// MARK: Gems

const N = 7, KINDS = 5, STAR = 99;
const candyColors = v => (v === STAR ? GOLD : CANDY[v]);

/// Candy outline in unit coordinates (cell = 1, centred on the origin).
function candyPath(ctx, kind) {
  ctx.beginPath();
  if (kind === 0) {                       // jelly bean: bent capsule, tilted
    ctx.save(); ctx.rotate(-0.55);
    ctx.moveTo(-0.21, -0.17);
    ctx.bezierCurveTo(-0.05, -0.1, 0.05, -0.1, 0.21, -0.17);
    ctx.arc(0.21, 0, 0.17, -Math.PI / 2, Math.PI / 2);
    ctx.bezierCurveTo(0.05, 0.22, -0.05, 0.22, -0.21, 0.17);
    ctx.arc(-0.21, 0, 0.17, Math.PI / 2, 3 * Math.PI / 2);
    ctx.restore();
  } else if (kind === 1) {                // orange lozenge
    ctx.ellipse(0, 0, 0.28, 0.37, 0, 0, 2 * Math.PI);
  } else if (kind === 2) {                // green cube
    ctx.roundRect(-0.34, -0.31, 0.68, 0.62, 0.15);
  } else if (kind === 3) {                // blue ball
    ctx.arc(0, 0, 0.35, 0, 2 * Math.PI);
  } else if (kind === 4) {                // purple flower: six lobes round a centre
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3 - Math.PI / 2, x = Math.cos(a) * 0.2, y = Math.sin(a) * 0.2;
      ctx.moveTo(x + 0.16, y);
      ctx.arc(x, y, 0.16, 0, 2 * Math.PI);
    }
    ctx.moveTo(0.22, 0);
    ctx.arc(0, 0, 0.22, 0, 2 * Math.PI);
  } else {                                // star
    for (let i = 0; i < 10; i++) {
      const a = i * Math.PI / 5 - Math.PI / 2, rr = i % 2 ? 0.19 : 0.42;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
  }
  ctx.closePath();
}

/// Glossy candy for `kind` at `px` device pixels per cell.
function candySprite(kind, px) {
  return glossySprite(px, candyColors(kind), ctx => candyPath(ctx, kind), {
    rimWidth: kind === STAR ? 0.05 : 0.025,
    decorate(ctx, [hi]) {
      ctx.lineWidth = 0.035;
      if (kind === 2) {                       // bevel on the cube
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath(); ctx.roundRect(-0.25, -0.22, 0.5, 0.44, 0.1); ctx.stroke();
      } else if (kind === 3) {                // swirl on the ball
        ctx.strokeStyle = hi + 'aa'; ctx.lineWidth = 0.05;
        ctx.beginPath(); ctx.arc(0.02, 0.03, 0.2, 0.15 * Math.PI, 1.05 * Math.PI); ctx.stroke();
      } else if (kind === 4) {                // a glint on each lobe
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        for (let i = 0; i < 6; i++) {
          const a = i * Math.PI / 3 - Math.PI / 2;
          ctx.beginPath(); ctx.arc(Math.cos(a) * 0.24 - 0.03, Math.sin(a) * 0.24 - 0.03, 0.03, 0, 2 * Math.PI); ctx.fill();
        }
      }
    },
  });
}

/// Match-3. Covert lever: refill seeding. On a favourable draw, refilled gems copy a
/// neighbour's colour (raising cascade chance); otherwise they are uniformly random.
/// Every reward interval a favourable draw also plants a star gem that clears its row.
/// The game logic resolves each move at once; the steps it records are then animated, and
/// input waits until they finish. Reward feedback (celebration, confetti, fanfare) scales with juice.
function gems(el, h) {
  el.innerHTML = `
    <div class="game gems">
      <div class="game-top"><span class="score">0</span></div>
      <div class="board-wrap"><canvas class="board"></canvas></div>
      <p class="hint">Click two neighbouring gems to swap them</p>
    </div>`;
  const canvas = el.querySelector('.board'), scoreEl = el.querySelector('.score');
  const sound = (name, ...a) => { if (h.sound?.() !== false) sfx[name](...a); };
  let grid = [], selected = null, score = 0, burst = 0, lastStar = performance.now();
  // Animation state: `view` is the board as currently drawn; steps update it as they play.
  let view = [], pending = [], queue = [], step = null, stepT = 0, shownScore = 0, targetScore = 0;
  const fx = candyFx();

  const swap = (a, b, c, d) => { const t = grid[a][b]; grid[a][b] = grid[c][d]; grid[c][d] = t; };
  const snap = () => grid.map(r => [...r]);
  function matches() {
    const set = new Set();
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const v = grid[r][c];
      if (v < 0 || v === STAR) continue;
      if (c + 2 < N && grid[r][c + 1] === v && grid[r][c + 2] === v) for (const k of [0, 1, 2]) set.add(r * N + c + k);
      if (r + 2 < N && grid[r + 1][c] === v && grid[r + 2][c] === v) for (const k of [0, 1, 2]) set.add((r + k) * N + c);
    }
    return [...set].map(i => [Math.floor(i / N), i % N]);
  }
  function hasMove() {
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      if (grid[r][c] === STAR) return true;
      for (const [dr, dc] of [[0, 1], [1, 0]]) {
        if (r + dr >= N || c + dc >= N) continue;
        swap(r, c, r + dr, c + dc);
        const ok = matches().length > 0;
        swap(r, c, r + dr, c + dc);
        if (ok) return true;
      }
    }
    return false;
  }
  /// Gravity + biased refill. Returns the row each cell's gem fell from (negative = new, from above).
  function collapse() {
    const starDue = (performance.now() - lastStar) / 1000 > h.interval();
    const src = [...Array(N)].map(() => Array(N).fill(0));
    let placedStar = false;
    for (let c = 0; c < N; c++) {
      const rows = [...Array(N).keys()].filter(r => grid[r][c] >= 0), col = rows.map(r => grid[r][c]);
      const missing = N - col.length, fresh = [];
      for (let i = 0; i < missing; i++) {
        if (starDue && !placedStar && h.lucky()) { fresh.push(STAR); placedStar = true; continue; }
        const below = i === missing - 1 ? col[0] : fresh.at(-1);
        if (below != null && below !== STAR && h.lucky() && Math.random() < 0.5) fresh.push(below);
        else fresh.push(randInt(0, KINDS - 1));
      }
      const full = [...fresh, ...col];
      for (let r = 0; r < N; r++) { grid[r][c] = full[r]; src[r][c] = r < missing ? r - missing : rows[r - missing]; }
    }
    if (placedStar || starDue) lastStar = performance.now();
    return src;
  }
  function clearStars() {
    const rows = [];
    for (let r = 0; r < N; r++) if (grid[r].includes(STAR)) { rows.push(r); grid[r] = grid[r].map(() => -1); score += 70; }
    pending.push(clearStep(rows.flatMap(r => [...Array(N).keys()].map(c => [r, c])), 0, 70 * rows.length, rows));
    pending.push(fallStep(collapse()));
  }
  /// Clear → gravity → biased refill, repeatedly; report the move's outcome once.
  function resolve() {
    let cascades = 0, cleared = 0;
    const clears = [];
    for (;;) {
      const m = matches();
      if (!m.length) break;
      cascades += 1;
      cleared += m.length;
      for (const [r, c] of m) grid[r][c] = -1;
      const st = clearStep(m, cascades);
      clears.push(st);
      pending.push(st, fallStep(collapse()));
    }
    score += cleared * 10 * Math.max(1, cascades);
    for (const st of clears) st.points = st.cells.length * 10 * Math.max(1, cascades);
    const success = cascades >= 2 || cleared >= 4;
    h.outcome(success, cleared === 3);
    if (success) {
      const juice = h.juice();
      pending.push(celebrateStep(cascades >= 3 ? 'Superb!' : 'Nice!', Math.min(1.5, 0.5 * juice * cascades), juice, cascades));
    }
    if (!hasMove()) reshuffle();
  }
  function reshuffle() {
    do { grid = shuffle(grid.map(r => shuffle([...r]))); } while (matches().length || !hasMove());
    pending.push(shuffleStep());
  }
  function tap(r, c) {
    if (!selected) { selected = [r, c]; sound('select'); return; }
    const [sr, sc] = selected;
    selected = null;
    if (Math.abs(sr - r) + Math.abs(sc - c) !== 1) { selected = [r, c]; sound('select'); return; }
    swap(sr, sc, r, c);
    const hitStar = grid[r][c] === STAR || grid[sr][sc] === STAR;
    if (!matches().length && !hitStar) { swap(sr, sc, r, c); pending.push(swapStep([sr, sc], [r, c], true)); return; }
    pending.push(swapStep([sr, sc], [r, c], false));
    if (hitStar) clearStars();
    resolve();
  }

  // MARK: animation steps

  function swapStep(a, b, back) {
    return {
      type: 'swap', a, b, back, dur: back ? 0.32 : 0.17,
      start() { sound('swap'); if (back) sound('nope', 0.14); },
      end() { if (!back) { const t = view[a[0]][a[1]]; view[a[0]][a[1]] = view[b[0]][b[1]]; view[b[0]][b[1]] = t; } },
    };
  }
  /// `cascade` 0 = star clear, 1 = the move's own match, 2+ = cascades. Points are filled in once the move is scored.
  function clearStep(cells, cascade, points = 0, beams = []) {
    return {
      type: 'clear', cells, points, beams, set: new Set(cells.map(([r, c]) => r * N + c)), dur: beams.length ? 0.42 : 0.3,
      start() {
        for (const [r, c] of cells) if (view[r][c] >= 0) fx.shatter(c + 0.5, r + 0.5, candyColors(view[r][c]));
        if (beams.length) sound('beam');
        sound('clear', Math.max(0, cascade - 1), cells.length);
        const cr = cells.reduce((s, [r]) => s + r, 0) / cells.length, cc = cells.reduce((s, [, c]) => s + c, 0) / cells.length;
        const [r0, c0] = cells[0];
        fx.popup(cc + 0.5, cr + 0.5, String(this.points), candyColors(beams.length ? STAR : view[r0][c0])[1]);
        targetScore += this.points;
      },
      end() { for (const [r, c] of cells) view[r][c] = -1; },
    };
  }
  function fallStep(src) {
    const after = snap();
    let longest = 0;
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const d = r - src[r][c];
      if (d > 0) longest = Math.max(longest, Math.sqrt(2 * d / GRAVITY));
    }
    return {
      type: 'fall', src, dur: longest + 0.12,
      start() { view = after; if (longest) sound('land', longest); },
    };
  }
  function celebrateStep(word, amount, juice, cascades) {
    return {
      type: 'celebrate', dur: 0,
      start() {
        burst = amount;
        fx.word(word, 0.95 + 0.25 * (juice - 1));
        fx.confetti(N / 2, N / 2, Math.round(12 * juice * Math.min(3, cascades)));
        sound('celebrate', juice, cascades >= 3);
      },
    };
  }
  function shuffleStep() {
    const after = snap();
    return {
      type: 'shuffle', dur: 0.6,
      start() { sound('shuffle'); fx.word('Shuffle', 0.7); },
      half() { view = after; },
    };
  }
  function update(dt) {
    if (!step && queue.length) { step = queue.shift(); stepT = 0; step.start?.(); }
    if (step) {
      stepT += dt;
      if (step.half && !step.halfDone && stepT >= step.dur / 2) { step.halfDone = true; step.half(); }
      if (stepT >= step.dur) { step.end?.(); step = null; }
    }
    burst = Math.max(0, burst - 0.8 * dt);
    shownScore = Math.abs(targetScore - shownScore) < 1 ? targetScore : shownScore + (targetScore - shownScore) * Math.min(1, dt * 10);
    fx.update(dt);
    if (!step && Math.random() < dt * 1.2) {   // idle glint on a random candy
      const r = randInt(0, N - 1), c = randInt(0, N - 1);
      if (view[r]?.[c] >= 0) fx.glint(c + 0.35, r + 0.3);
    }
  }

  // MARK: drawing

  let sprites = null, spriteKey = '';
  function spritesFor(s) {
    const d = devicePixelRatio || 1, key = `${s}@${d}`;
    if (key !== spriteKey) {
      const px = Math.max(8, Math.round(s * d * 0.96));
      sprites = { d, ims: [...[...Array(KINDS).keys()].map(k => candySprite(k, px)), candySprite(STAR, px)] };
      spriteKey = key;
    }
    return sprites;
  }
  function geom() {
    const W = canvas.clientWidth, H = canvas.clientHeight, size = Math.min(W, H) * 0.94;
    return { s: size / N, ox: (W - size) / 2, oy: (H - size) / 2, W, H, size };
  }
  /// Where and how the candy at (r, c) is drawn during the current step.
  function pose(r, c) {
    let y = r, x = c, sx = 1, sy = 1, alpha = 1;
    const t = stepT, p = step ? Math.min(1, t / (step.dur || 1)) : 0;
    if (step?.type === 'swap') {
      const { a, b } = step, q = step.back ? Math.sin(p * Math.PI) : ease(p);
      if (r === a[0] && c === a[1]) { y += (b[0] - a[0]) * q; x += (b[1] - a[1]) * q; }
      else if (r === b[0] && c === b[1]) { y += (a[0] - b[0]) * q; x += (a[1] - b[1]) * q; }
    } else if (step?.type === 'clear' && step.set.has(r * N + c)) {
      const k = p < 0.25 ? 1 + p : 1.25 * (1 - (p - 0.25) / 0.75);
      sx = sy = k; alpha = Math.min(1, 1.6 * (1 - p));
    } else if (step?.type === 'fall') {
      const d = r - step.src[r][c];
      if (d > 0) {
        const T = Math.sqrt(2 * d / GRAVITY);
        if (t < T) y = r - d + 0.5 * GRAVITY * t * t;
        else if (t < T + 0.12) {
          const w = Math.sin((t - T) / 0.12 * Math.PI);
          sy = 1 - 0.14 * w; sx = 1 + 0.1 * w; y += 0.07 * w;
        }
      }
    } else if (step?.type === 'shuffle') {
      sx = sy = p < 0.5 ? 1 - ease(p * 2) : ease((p - 0.5) * 2);
    }
    return { x, y, sx, sy, alpha };
  }
  function draw(now) {
    const ctx = canvas.getContext('2d'), { s, ox, oy, W, H, size } = geom();
    if (!(s > 0)) return;
    const { d, ims } = spritesFor(s);
    ctx.clearRect(0, 0, W, H);
    candyBackdrop(ctx, W, H);
    ctx.save();
    const k = 1 + burst * 0.03;
    ctx.translate(W / 2, H / 2); ctx.scale(k, k); ctx.translate(-W / 2, -H / 2);
    candyTray(ctx, ox, oy, N, N, s);
    if (selected) {
      const [r, c] = selected, a = 0.55 + 0.25 * Math.sin(now / 150);
      const g = ctx.createRadialGradient(ox + (c + 0.5) * s, oy + (r + 0.5) * s, 0, ox + (c + 0.5) * s, oy + (r + 0.5) * s, s * 0.7);
      g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(ox + c * s - s * 0.2, oy + r * s - s * 0.2, s * 1.4, s * 1.4);
      ctx.strokeStyle = `rgba(255,255,255,${a + 0.2})`; ctx.lineWidth = 3;
      roundRect(ctx, ox + c * s + 2, oy + r * s + 2, s - 4, s - 4, s * 0.16); ctx.stroke();
    }
    ctx.save();
    roundRect(ctx, ox, oy, size, size, s * 0.16); ctx.clip();   // new candies slide in from the top edge
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const v = view[r][c];
      if (v < 0) continue;
      const { x, y, sx, sy, alpha } = pose(r, c), im = ims[v === STAR ? KINDS : v], w = im.width / d;
      const cx = ox + (x + 0.5) * s, cy = oy + (y + 0.5) * s;
      let k2 = 1;
      if (selected && selected[0] === r && selected[1] === c) k2 = 1.08 + 0.04 * Math.sin(now / 120);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, cy);
      if (v === STAR) {
        const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 0.6);
        glow.addColorStop(0, `rgba(255,230,120,${0.55 + 0.25 * Math.sin(now / 200)})`); glow.addColorStop(1, 'rgba(255,230,120,0)');
        ctx.fillStyle = glow; ctx.fillRect(-s * 0.6, -s * 0.6, s * 1.2, s * 1.2);
        ctx.rotate(now / 1000 * 0.9);
      }
      ctx.scale(sx * k2, sy * k2);
      ctx.drawImage(im, -w / 2, -w / 2, w, w);
      ctx.restore();
    }
    ctx.restore();
    if (step?.type === 'clear' && step.beams.length) candyBeams(ctx, step.beams, stepT / step.dur, ox - s * 0.12, oy, size + s * 0.24, s);
    fx.draw(ctx, ox, oy, s);
    ctx.restore();
    fx.drawWords(ctx, W / 2, H / 2, s);
    const shown = String(Math.round(shownScore));
    if (scoreEl.textContent !== shown) scoreEl.textContent = shown;
  }

  canvas.addEventListener('pointerdown', e => {
    unlockAudio();
    if (step || queue.length) return;   // wait for the previous move to finish animating
    const b = canvas.getBoundingClientRect(), { s, ox, oy } = geom();
    const c = Math.floor((e.clientX - b.left - ox) / s), r = Math.floor((e.clientY - b.top - oy) / s);
    if (r >= 0 && r < N && c >= 0 && c < N) { tap(r, c); queue.push(...pending); pending = []; }
  });

  do { grid = [...Array(N)].map(() => [...Array(N)].map(() => randInt(0, KINDS - 1))); } while (matches().length || !hasMove());
  view = snap();
  const stop = animate((dt, now) => { update(dt); draw(now); });
  const ro = hiDPI(canvas, () => draw(performance.now()));
  return { destroy() { stop(); ro.disconnect(); } };
}

// MARK: Glide

/// Pixel-art palette for Glide (classic flappy-style look, original art).
const PIX = {
  sky: '#4ec0ca', cloud: '#e8f9da', cloudEdge: '#c6ebbd', city: '#d4f1de', cityEdge: '#9fd5bb', window: '#b3e2cd',
  bush: '#5fd56a', bushEdge: '#3da64d', line: '#4a3043', stripeA: '#9ae35a', stripeB: '#73c22e', grass: '#5a9a2a', sand: '#ded895',
  pipeHi: '#e2fb8f', pipeLight: '#a8e45e', pipeMid: '#78c232', pipeDark: '#55862a',
  coin: '#f8c030', coinHi: '#fff3a0', coinEdge: '#8a5a10',
};
/// 5×7 pixel digits.
const PIX_DIGITS = ['01110100011000110001100011000101110', '00100011000010000100001000010001110', '01110100010000100110010001000011111',
  '11110000010000101110000010000111110', '00010001100101010010111110001000010', '11111100001111000001000011000101110',
  '00110010001000011110100011000101110', '11111000010001000100010000100001000', '01110100011000101110100011000101110',
  '01110100011000101111000010001001100'];

/// Filled ellipse from 1-px scanlines, so edges stay hard when scaled up.
function pixDisc(ctx, cx, cy, rx, ry = rx) {
  for (let y = -ry; y <= ry; y++) {
    const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (ry * ry || 1))));
    ctx.fillRect(Math.round(cx - w), Math.round(cy + y), 2 * w + 1, 1);
  }
}
function pixCanvas(w, h, paint) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  paint(c.getContext('2d'));
  return c;
}
/// Repeating strip of bumps (clouds, bushes): outline colour first, fill one pixel inside.
function pixBumps(w, h, rMin, rMax, step, edge, fill, seed) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const bumps = [];
  for (let x = 0; x < w; x += step) bumps.push([x + rnd() * step * 0.5, rMin + rnd() * (rMax - rMin)]);
  return pixCanvas(w, h, ctx => {
    for (const [col, grow] of [[edge, 1], [fill, 0]]) {
      ctx.fillStyle = col;
      for (const [x, r] of bumps) for (const dx of [-w, 0, w]) pixDisc(ctx, x + dx, h - r * 0.4, Math.round(r + grow), Math.round(r * 0.8 + grow));
      ctx.fillRect(0, h - Math.round(rMin * 0.4) + grow, w, h);
    }
  });
}
function pixCity(w, h, seed) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return pixCanvas(w, h, ctx => {
    for (let x = 0; x < w;) {
      const bw = Math.min(w - x, 8 + Math.floor(rnd() * 9)), bh = 10 + Math.floor(rnd() * (h - 10));
      ctx.fillStyle = PIX.cityEdge; ctx.fillRect(x, h - bh, bw, bh);
      ctx.fillStyle = PIX.city; ctx.fillRect(x + 1, h - bh + 1, bw - 2, bh - 1);
      ctx.fillStyle = PIX.window;
      for (let wy = h - bh + 3; wy < h - 2; wy += 4) for (let wx = x + 2; wx < x + bw - 3; wx += 4) ctx.fillRect(wx, wy, 2, 2);
      x += bw + (rnd() < 0.3 ? 1 : 0);
    }
  });
}
/// Bird frame (24×20) with the wing up (-1), level (0) or down (1).
function pixBird(wing) {
  return pixCanvas(24, 20, ctx => {
    ctx.fillStyle = PIX.line; pixDisc(ctx, 11, 10, 9, 7);
    ctx.fillStyle = '#f7d23a'; pixDisc(ctx, 11, 10, 8, 6);
    ctx.fillStyle = '#fbeaa0'; pixDisc(ctx, 10, 13, 5, 2);
    ctx.fillStyle = '#e9a42a'; ctx.fillRect(6, 15, 9, 1);
    ctx.fillStyle = PIX.line; ctx.fillRect(14, 10, 9, 6);   // beak
    ctx.fillStyle = '#f4672b'; ctx.fillRect(15, 11, 7, 2);
    ctx.fillStyle = '#e04a24'; ctx.fillRect(15, 14, 6, 1);
    ctx.fillStyle = PIX.line; pixDisc(ctx, 15, 6, 4, 4);   // eye
    ctx.fillStyle = '#fff'; pixDisc(ctx, 15, 6, 3, 3);
    ctx.fillStyle = '#222'; ctx.fillRect(16, 5, 2, 3);
    const wy = 10 + wing * 3;
    ctx.fillStyle = PIX.line; pixDisc(ctx, 5, wy, 5, 3);
    ctx.fillStyle = '#fff7da'; pixDisc(ctx, 5, wy, 4, 2);
  });
}
/// Pipe column colours across its width (outline, highlight, body, shade, outline).
const pipeCols = w => [...Array(w)].map((_, i) => {
  const f = i / (w - 1);
  return i === 0 || i === w - 1 ? PIX.line : f < 0.1 ? PIX.pipeLight : f < 0.2 ? PIX.pipeHi : f < 0.3 ? PIX.pipeLight : f < 0.72 ? PIX.pipeMid : PIX.pipeDark;
});
const PIPE_BODY = pipeCols(26), PIPE_CAP = pipeCols(30);

/// Calm, slow flyer with no game over. Hold to rise, release to drift down. Gates arrive every
/// tuned reward interval. Covert lever: a favourable draw makes a wide gap close to the
/// previous one with a glowing orb in it; otherwise a narrower, offset gap.
/// Drawn as pixel art at ~256 rows and scaled up by a whole number of device pixels.
/// The coin chime, sparkle and glow are the reward cues and scale with juice. Hitting a pipe
/// costs a coin (never below zero), the same size whatever the juice. The flight speeds up 4 %
/// per coin held (up to double), so losing a coin also slows it down.
function glide(el, h) {
  el.innerHTML = `
    <div class="game glide">
      <canvas class="sky"></canvas>
      <p class="hint">${matchMedia('(pointer: coarse)').matches ? 'Hold your finger on the screen to rise' : 'Hold the mouse button or Space to rise'}</p>
    </div>`;
  const canvas = el.querySelector('.sky');
  const sound = (name, ...a) => { if (h.sound?.() !== false) sfx[name](...a); };
  const baseSpeed = 0.16, flyerX = 0.25;   // screen widths per second, deliberately slow
  let speed = baseSpeed;
  let y = 0.5, vy = 0, gates = [], orbs = 0, glow = 0, bump = 0, sinceGate = 0, holding = false;
  // Presentation state.
  let clock = 0, scroll = 0, flapT = 0, wingT = 0, scorePop = 0, scoreDrop = 0;
  const sparks = [], dropped = [];

  function step(dt) {
    const target = baseSpeed * Math.min(2, 1 + 0.04 * orbs);
    speed += (target - speed) * Math.min(1, dt * 3);   // ease over about a second
    vy += (holding ? -0.9 : 0.6) * dt;
    vy = Math.max(-0.35, Math.min(0.35, vy * 0.98));
    y = Math.max(0.04, Math.min(0.96, y + vy * dt));
    glow = Math.max(0, glow - dt);
    bump = Math.max(0, bump - dt * 2);
    sinceGate += dt;
    if (sinceGate >= h.interval()) {
      sinceGate = 0;
      const good = h.lucky(), prev = gates.at(-1)?.gapY ?? 0.5;
      const gapY = good ? Math.max(0.25, Math.min(0.75, prev + rand(-0.12, 0.12)))
                        : Math.max(0.2, Math.min(0.8, prev + (Math.random() < 0.5 ? 1 : -1) * rand(0.18, 0.3)));
      gates.push({ x: 1.1, gapY, gap: good ? 0.36 : 0.24, orb: good, scored: false });
    }
    for (const g of gates) {
      g.x -= speed * dt;
      if (!g.scored && g.x < flyerX) {
        g.scored = true;
        if (Math.abs(y - g.gapY) < g.gap / 2) {
          if (g.orb) { orbs += 1; glow = 0.8 * h.juice(); collect(g); }
          h.outcome(g.orb, !g.orb);
        } else {
          bump = 1;
          sound('hit');
          if (orbs > 0) loseCoin();
          h.outcome(false, false);
        }
      }
    }
    gates = gates.filter(g => g.x >= -0.2);
  }
  function collect(g) {
    const juice = h.juice();
    scorePop = 1;
    sound('point', juice);
    for (let i = 0, n = Math.round(8 * juice); i < n; i++) {
      const a = rand(0, 2 * Math.PI), sp = rand(30, 70);
      sparks.push({ gx: g.x, gy: g.gapY, dx: 0, dy: 0, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, life: rand(0.3, 0.5), c: i % 2 ? PIX.coinHi : '#fff' });
    }
  }
  /// A coin pops up off the bird and tumbles away behind the ground.
  function loseCoin() {
    orbs -= 1;
    scoreDrop = 1;
    sound('drop');
    dropped.push({ x: flyerX, y, vx: -speed * 0.5, vy: -0.45, t: 0 });
  }
  function present(dt) {
    clock += dt;
    scroll += speed * dt;
    scorePop = Math.max(0, scorePop - dt * 4);
    scoreDrop = Math.max(0, scoreDrop - dt * 2);
    for (const c of dropped) { c.t += dt; c.vy += 1.4 * dt; c.x += c.vx * dt; c.y += c.vy * dt; }
    for (let i = dropped.length - 1; i >= 0; i--) if (dropped[i].y > 1.2) dropped.splice(i, 1);
    wingT += dt * (holding ? 12 : 3);
    if (holding) { flapT -= dt; if (flapT <= 0) { flapT = 0.24; sound('flap'); } } else flapT = 0;
    for (const p of sparks) { p.t += dt; p.dx += p.vx * dt; p.dy += p.vy * dt; }
    for (let i = sparks.length - 1; i >= 0; i--) if (sparks[i].t > sparks[i].life) sparks.splice(i, 1);
  }

  // MARK: pixel rendering
  const off = document.createElement('canvas'), octx = off.getContext('2d');
  const birds = [-1, 0, 1, 0].map(pixBird);
  let layers = null;
  function draw() {
    const ctx = canvas.getContext('2d'), DW = canvas.width, DH = canvas.height;
    if (DW < 2 || DH < 2) return;
    const k = Math.max(1, Math.round(DH / 256)), vw = Math.ceil(DW / k), V = Math.ceil(DH / k);
    if (off.width !== vw || off.height !== V) { off.width = vw; off.height = V; }
    if (!layers) layers = { clouds: pixBumps(160, 40, 9, 17, 15, PIX.cloudEdge, PIX.cloud, 7), city: pixCity(150, 30, 11), bushes: pixBumps(120, 20, 6, 10, 11, PIX.bushEdge, PIX.bush, 3) };
    const o = octx, groundH = Math.round(V * 0.16), playH = V - groundH, sx = scroll * vw;
    o.imageSmoothingEnabled = false;
    o.fillStyle = PIX.sky; o.fillRect(0, 0, vw, V);
    const tile = (im, factor, top) => {
      const x0 = -Math.floor((sx * factor) % im.width);
      for (let x = x0; x < vw; x += im.width) o.drawImage(im, x, top);
    };
    tile(layers.clouds, 0.1, playH - 62);
    o.fillStyle = PIX.cloud; o.fillRect(0, playH - 22, vw, 22);
    tile(layers.city, 0.15, playH - 44);
    tile(layers.bushes, 0.3, playH - 20);
    for (const g of gates) {   // pipes
      const cx = Math.round(g.x * vw), top = Math.round((g.gapY - g.gap / 2) * playH), bot = Math.round((g.gapY + g.gap / 2) * playH);
      const column = (cols, y0, y1) => cols.forEach((c, i) => { o.fillStyle = c; o.fillRect(cx - (cols.length >> 1) + i, y0, 1, y1 - y0); });
      const cap = y0 => { column(PIPE_CAP, y0, y0 + 12); o.fillStyle = PIX.line; o.fillRect(cx - 15, y0, 30, 1); o.fillRect(cx - 15, y0 + 11, 30, 1); };
      if (top > 0) { column(PIPE_BODY, 0, top - 12); cap(top - 12); }
      if (bot < playH) { column(PIPE_BODY, bot + 12, playH); cap(bot); }
      if (g.orb && !g.scored) {   // spinning coin
        const cy = Math.round(g.gapY * playH), rx = Math.max(1, Math.round(5 * Math.abs(Math.cos(clock * 3))));
        o.fillStyle = PIX.coinEdge; pixDisc(o, cx, cy, rx + 1, 6);
        o.fillStyle = PIX.coin; pixDisc(o, cx, cy, rx, 5);
        if (rx > 2) { o.fillStyle = PIX.coinHi; o.fillRect(cx - 1, cy - 3, 1, 5); }
      }
    }
    for (const c of dropped) {   // lost coins, spinning fast as they fall
      const cx = Math.round(c.x * vw), cy = Math.round(c.y * playH), rx = Math.max(1, Math.round(5 * Math.abs(Math.cos(c.t * 14))));
      o.fillStyle = PIX.coinEdge; pixDisc(o, cx, cy, rx + 1, 6);
      o.fillStyle = PIX.coin; pixDisc(o, cx, cy, rx, 5);
    }
    for (const p of sparks) { o.fillStyle = p.c; o.fillRect(Math.round(p.gx * vw + p.dx) - 1, Math.round(p.gy * playH + p.dy) - 1, 2, 2); }
    o.fillStyle = PIX.line; o.fillRect(0, playH, vw, 1);   // ground
    o.fillStyle = PIX.stripeA; o.fillRect(0, playH + 1, vw, 7);
    o.fillStyle = PIX.stripeB;
    const gx = Math.floor(sx) % 12;
    for (let r = 0; r < 7; r++) for (let x = -12 - gx; x < vw + 12; x += 12) o.fillRect(x + 6 - r, playH + 1 + r, 6, 1);   // diagonal stripes
    o.fillStyle = PIX.grass; o.fillRect(0, playH + 8, vw, 2);
    o.fillStyle = PIX.sand; o.fillRect(0, playH + 10, vw, V);
    const bird = birds[Math.floor(wingT) % 4], angle = vy / 0.35 * 0.45 + bump * 0.6;   // tilt with velocity; tumble on a bump
    o.save();
    o.translate(Math.round(flyerX * vw), Math.round(y * playH));
    o.rotate(angle);
    o.drawImage(bird, -11, -10);
    o.restore();
    if (glow > 0) { o.fillStyle = `rgba(255,220,0,${glow * 0.15})`; o.fillRect(0, 0, vw, V); }
    if (bump > 0.6) { o.fillStyle = `rgba(255,255,255,${(bump - 0.6) * 1.5})`; o.fillRect(0, 0, vw, V); }
    const digits = String(orbs), ps = scorePop > 0.5 ? 3 : 2, dw = 6 * ps;   // score: white pixel digits, dark outline
    let x0 = Math.round(vw / 2 - (digits.length * dw) / 2);
    const y0 = Math.round(V * 0.08);
    for (const ch of digits) {
      const bits = PIX_DIGITS[+ch];
      for (const [col, grow] of [[PIX.line, 1], [scoreDrop > 0 && Math.floor(scoreDrop * 6) % 2 ? '#ff5a4a' : '#fff', 0]]) {   // blinks red after a loss
        o.fillStyle = col;
        for (let i = 0; i < 35; i++) if (bits[i] === '1') o.fillRect(x0 + (i % 5) * ps - grow, y0 + Math.floor(i / 5) * ps - grow, ps + 2 * grow, ps + 2 * grow);
      }
      x0 += dw;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, vw * k, V * k);
    ctx.restore();
  }

  const press = () => { unlockAudio(); holding = true; }, release = () => { holding = false; };
  canvas.addEventListener('pointerdown', press);
  addEventListener('pointerup', release);
  canvas.addEventListener('pointerleave', release);
  addEventListener('pointercancel', release);   // e.g. iOS takes the touch for a system gesture
  const down = e => { if (e.code === 'Space') { e.preventDefault(); unlockAudio(); holding = true; } };
  const up = e => { if (e.code === 'Space') holding = false; };
  addEventListener('keydown', down);
  addEventListener('keyup', up);

  const ro = hiDPI(canvas, draw);
  const stop = animate(dt => { step(dt); present(dt); draw(); });
  return {
    destroy() {
      stop(); ro.disconnect();
      removeEventListener('pointerup', release); removeEventListener('pointercancel', release); removeEventListener('keydown', down); removeEventListener('keyup', up);
    },
  };
}

// MARK: Solitaire

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];
const isRed = c => c.suit === 1 || c.suit === 2;

// Classic desktop-solitaire look: original vector cards (250 × 350 SVG), white on green felt.
const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
const SUIT_PATH = [   // in a 100 × 100 box, order of SUITS
  'M50 0C50 0 0 38 0 60C0 75 12 85 26 85C36 85 43 80 47 74C46 86 41 94 33 100H67C59 94 54 86 53 74C57 80 64 85 74 85C88 85 100 75 100 60C100 38 50 0 50 0Z',
  'M50 96C22 70 0 50 0 28C0 12 12 0 27 0C38 0 46 7 50 17C54 7 62 0 73 0C88 0 100 12 100 28C100 50 78 70 50 96Z',
  'M50 0L88 50L50 100L12 50Z',
  circle(50, 26, 23) + circle(24, 58, 23) + circle(76, 58, 23) + circle(50, 52, 14) + 'M46 58C45 80 41 92 32 100H68C59 92 55 80 54 58Z',
];
const pipAt = (s, cx, cy, size, flip = false) =>
  `<path d="${SUIT_PATH[s]}" transform="translate(${cx} ${cy})${flip ? ' rotate(180)' : ''} translate(${-size / 2} ${-size / 2}) scale(${size / 100})"/>`;
const PL = 74, PM = 125, PR = 176, PT = 78, PB = 272;
const PIPS = {
  2: [[PM, PT], [PM, PB]],
  3: [[PM, PT], [PM, 175], [PM, PB]],
  4: [[PL, PT], [PR, PT], [PL, PB], [PR, PB]],
  5: [[PL, PT], [PR, PT], [PM, 175], [PL, PB], [PR, PB]],
  6: [[PL, PT], [PR, PT], [PL, 175], [PR, 175], [PL, PB], [PR, PB]],
  7: [[PL, PT], [PR, PT], [PM, 126], [PL, 175], [PR, 175], [PL, PB], [PR, PB]],
  8: [[PL, PT], [PR, PT], [PM, 126], [PL, 175], [PR, 175], [PM, 224], [PL, PB], [PR, PB]],
  9: [[PL, PT], [PR, PT], [PL, 143], [PR, 143], [PM, 175], [PL, 207], [PR, 207], [PL, PB], [PR, PB]],
  10: [[PL, PT], [PR, PT], [PM, 110], [PL, 143], [PR, 143], [PL, 207], [PR, 207], [PM, 240], [PL, PB], [PR, PB]],
};
const CARD_RED = '#d40000', ROBE = { 11: '#1d44b8', 12: '#d40000', 13: '#d40000' }, TRIM = '#f4c20d', SKIN = '#fbe0b8';

/// Upper half of a double-ended court figure (drawn again rotated 180°).
function courtHalf(c) {
  const robe = ROBE[c.rank], alt = robe === '#1d44b8' ? '#d40000' : '#1d44b8', ink = 'stroke="#000" stroke-width="2.5"';
  const hat = {
    11: `<path d="M100 82Q104 52 130 54Q150 56 152 80Z" fill="${alt}" ${ink}/><path d="M146 62Q166 44 172 60Q160 58 150 70Z" fill="${TRIM}" ${ink}/>`,
    12: `<path d="M98 112Q92 70 125 62Q158 70 152 112L146 112Q148 84 125 80Q102 84 104 112Z" fill="${TRIM}" ${ink}/><path d="M106 74L112 58L119 70L125 54L131 70L138 58L144 74Z" fill="${TRIM}" ${ink}/>`,
    13: `<path d="M102 78L102 50L113 64L125 46L137 64L148 50L148 78Z" fill="${TRIM}" ${ink}/><circle cx="125" cy="58" r="4" fill="${alt}"/>`,
  }[c.rank];
  const beard = c.rank === 13 ? `<path d="M107 98Q125 132 143 98Q138 116 125 118Q112 116 107 98Z" fill="#fff" ${ink}/>` : '';
  const held = {
    11: `<path d="M178 175L178 96M171 104L185 104" ${ink} fill="none"/>`,
    12: `<path d="M74 175L74 118" ${ink}/><circle cx="74" cy="112" r="8" fill="${alt}" ${ink}/>`,
    13: `<path d="M74 175L74 70M66 82L82 82" stroke="#000" stroke-width="4"/>`,
  }[c.rank];
  return `<path d="M64 175L78 126Q125 108 172 126L186 175Z" fill="${robe}" ${ink}/>` +
    `<path d="M112 118L138 118L142 175L108 175Z" fill="${TRIM}" ${ink}/>` +
    [128, 142, 156, 170].map(y => `<circle cx="125" cy="${y - 4}" r="3.5" fill="${alt}"/>`).join('') +
    `<path d="M86 150L102 140M164 150L148 140" stroke="${TRIM}" stroke-width="6"/>` +
    `<circle cx="125" cy="92" r="20" fill="${SKIN}" ${ink}/><circle cx="118" cy="90" r="2.5"/><circle cx="132" cy="90" r="2.5"/>` +
    `<path d="M119 102Q125 106 131 102" stroke="#000" stroke-width="2" fill="none"/>` + beard + hat + held +
    `<g fill="${isRed(c) ? CARD_RED : '#000'}">${pipAt(c.suit, 68, 62, 26)}</g>`;
}

function cardSVG(c) {
  const r = RANKS[c.rank - 1];
  const index = `<text x="26" y="50" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700"` +
    ` font-size="${r === '10' ? 38 : 46}"${r === '10' ? ' letter-spacing="-3"' : ''}>${r}</text>` + pipAt(c.suit, 26, 74, 26);
  let body;
  if (c.rank === 1) body = pipAt(c.suit, 125, 175, c.suit === 0 ? 130 : 96);
  else if (c.rank <= 10) body = PIPS[c.rank].map(([x, y]) => pipAt(c.suit, x, y, 50, y > 175)).join('');
  else body = `<rect x="52" y="40" width="146" height="270" fill="#fff" stroke="#000" stroke-width="2.5"/>` +
    `<svg x="52" y="40" width="146" height="270" viewBox="52 40 146 270"><g>${courtHalf(c)}</g><g transform="rotate(180 125 175)">${courtHalf(c)}</g></svg>` +
    `<path d="M52 175H198" stroke="#000" stroke-width="2"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350">` +
    `<rect x="2" y="2" width="246" height="346" rx="14" fill="#fff" stroke="#000" stroke-width="3"/>` +
    `<g fill="${isRed(c) ? CARD_RED : '#000'}">${index}<g transform="rotate(180 125 175)">${index}</g>${body}</g></svg>`;
}

/// Large-print face for phone-width cards: a big rank and suit across the top (the part left showing
/// in a fanned column) over one large pip, or the court figure.
function compactCardSVG(c) {
  const r = RANKS[c.rank - 1];
  const index = `<text x="14" y="108" font-family="Arial, Helvetica, sans-serif" font-weight="700"` +
    ` font-size="${r === '10' ? 104 : 118}"${r === '10' ? ' letter-spacing="-8"' : ''}>${r}</text>` + pipAt(c.suit, 192, 64, 84);
  const body = c.rank <= 10 ? pipAt(c.suit, 125, 238, 150) :
    `<rect x="66" y="132" width="118" height="200" fill="#fff" stroke="#000" stroke-width="3"/>` +
    `<svg x="66" y="132" width="118" height="200" viewBox="52 40 146 270" preserveAspectRatio="none"><g>${courtHalf(c)}</g>` +
    `<g transform="rotate(180 125 175)">${courtHalf(c)}</g><path d="M52 175H198" stroke="#000" stroke-width="2"/></svg>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350">` +
    `<rect x="2" y="2" width="246" height="346" rx="14" fill="#fff" stroke="#000" stroke-width="3"/>` +
    `<g fill="${isRed(c) ? CARD_RED : '#000'}">${index}${body}</g></svg>`;
}

const BACK_SVG =`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350">` +
  `<defs><pattern id="w" width="22" height="22" patternUnits="userSpaceOnUse" x="15" y="15">` +
  `<path d="M0 11L11 0L22 11L11 22Z" fill="none" stroke="#6f9cff" stroke-width="2.5"/><circle cx="11" cy="11" r="3" fill="#bcd2ff"/></pattern></defs>` +
  `<rect x="2" y="2" width="246" height="346" rx="14" fill="#fff" stroke="#000" stroke-width="3"/>` +
  `<rect x="16" y="16" width="218" height="318" fill="#173c9e"/><rect x="16" y="16" width="218" height="318" fill="url(#w)"/>` +
  `<rect x="24" y="24" width="202" height="302" fill="none" stroke="#bcd2ff" stroke-width="2"/></svg>`;

const cardURLs = new Map();
/// Object URL for a card face (or the back when `c` is null), created once per page.
/// `compact` picks the large-print face used when cards are phone-sized.
function cardURL(c, compact = false) {
  const key = c ? `${c.rank}-${c.suit}${compact ? 'c' : ''}` : 'back';
  if (!cardURLs.has(key)) cardURLs.set(key, URL.createObjectURL(new Blob([c ? (compact ? compactCardSVG(c) : cardSVG(c)) : BACK_SVG], { type: 'image/svg+xml' })));
  return cardURLs.get(key);
}

/// Klondike, draw-1, click-to-move. Covert levers: the deal (favourable → the friendliest of
/// several shuffles, otherwise the least friendly) and stock luck (favourable → a playable
/// card is surfaced next, at most once per tuned reward interval).
function solitaire(el, h) {
  el.innerHTML = `<div class="game solitaire"><div class="felt"></div><button class="deal">New deal</button></div>`;
  const felt = el.querySelector('.felt'), dealBtn = el.querySelector('.deal'), root = el.querySelector('.solitaire');
  let stock = [], waste = [], found = [[], [], [], []], tab = [], won = false, sparkle = 0, lastFavour = -Infinity;
  let size = { w: 0, hgt: 0 }, stopCascade = null;

  // A web page can't lock the orientation on iPhone, so on an upright phone the table is drawn
  // turned 90° clockwise to be played with the phone on its side.
  const upright = matchMedia('(orientation: portrait) and (pointer: coarse)');
  const turned = () => root.classList.contains('turned');
  function orient() {
    const t = upright.matches;
    root.classList.toggle('turned', t);
    root.style.width = t ? `${el.clientHeight}px` : '';
    root.style.height = t ? `${el.clientWidth}px` : '';
  }
  /// A screen-space offset in the table's own coordinates.
  const toTable = (dx, dy) => turned() ? [dy, -dx] : [dx, dy];

  function layout(d) {
    const t = [];
    for (let i = 0; i < 7; i++) {
      const col = d.splice(0, i + 1);
      col[i].up = true;
      t.push(col);
    }
    return { stock: d, tab: t };
  }
  /// Accessible openers: low cards face up + immediately legal tableau moves.
  function friendliness(t) {
    const tops = t.map(c => c.at(-1));
    const low = tops.filter(c => c.rank <= 2).length * 2;
    const moves = tops.filter(a => tops.some(b => b.rank === a.rank + 1 && isRed(b) !== isRed(a))).length;
    return low + moves;
  }
  function deal() {
    stopCascade?.();
    const deck = [];
    for (let r = 1; r <= 13; r++) for (let s = 0; s < 4; s++) deck.push({ rank: r, suit: s, up: false });
    const candidates = [...Array(6)].map(() => layout(shuffle(deck.map(c => ({ ...c })))));
    candidates.sort((a, b) => friendliness(a.tab) - friendliness(b.tab));
    ({ stock, tab } = h.lucky() ? candidates.at(-1) : candidates[0]);
    waste = []; found = [[], [], [], []]; won = false;
    render('deal');
  }

  const canFound = c => (found[c.suit].at(-1)?.rank ?? 0) === c.rank - 1;
  const canStack = (c, col) => { const top = col.at(-1); return top ? top.up && isRed(top) !== isRed(c) && top.rank === c.rank + 1 : c.rank === 13; };
  const playable = c => canFound(c) || tab.some(col => canStack(c, col));

  function tapStock() {
    if (!stock.length) { stock = waste.reverse().map(c => ({ ...c, up: false })); waste = []; return; }
    const due = (performance.now() / 1000 - lastFavour) >= h.interval();
    if (due && h.lucky()) {
      const i = stock.findLastIndex(playable);
      if (i >= 0) { stock.push(stock.splice(i, 1)[0]); lastFavour = performance.now() / 1000; }
    }
    const c = { ...stock.pop(), up: true };
    waste.push(c);
    const good = playable(c);
    h.outcome(good, false);
    if (good) sparkle = 0.6 * h.juice();
  }
  function tapWaste() {
    const c = waste.at(-1);
    if (!c) return;
    if (canFound(c)) { found[c.suit].push(waste.pop()); afterMove(); return; }
    const d = tab.findIndex(col => canStack(c, col));
    if (d >= 0) { tab[d].push(waste.pop()); afterMove(); }
  }
  function tapTableau(col, i) {
    if (!tab[col][i]?.up) return;
    const run = tab[col].slice(i);
    if (run.length === 1 && canFound(run[0])) { found[run[0].suit].push(tab[col].pop()); afterMove(col); return; }
    // Prefer a non-empty destination; kings go to an empty column.
    const dests = tab.map((_, d) => d).filter(d => d !== col && canStack(run[0], tab[d]));
    const d = dests.find(x => tab[x].length) ?? (i > 0 ? dests[0] : undefined);
    if (d == null) return;
    tab[d].push(...run);
    tab[col].splice(i);
    afterMove(col);
  }
  function afterMove(col) {
    const last = col != null ? tab[col].at(-1) : null;
    if (last && !last.up) last.up = true;
    if (found.every(f => f.length === 13)) { won = true; sparkle = 1.5; }
  }

  // MARK: drawing

  /// Re-render the table. `anim`: 'move' slides cards from where they were (FLIP) and flips newly
  /// turned cards; 'deal' flies the tableau out of the stock one card at a time; none = instant.
  function render(anim) {
    const before = new Map();
    if (anim === 'move') for (const n of felt.querySelectorAll('[data-id]')) before.set(n.dataset.id, { r: n.getBoundingClientRect(), up: n.dataset.up });
    // Wide tables (a phone on its side) put stock + waste in a column on the left and the
    // foundations in a 2 × 2 block on the right, so the tableau gets the full height.
    const W = felt.clientWidth, H = felt.clientHeight, wide = W > H * 1.5, gap = Math.max(3, W * 0.012);
    const w = wide ? Math.min((W - 12 * gap) / 10, (H - gap) / 2 / 1.4) : (W - 6 * gap) / 7, hgt = w * 1.4;
    const compact = wide || w < 60;
    size = { w, hgt, compact };
    // Fan offsets: face-up cards show at least their index, and spread further (up to half a card)
    // to fill the table's height; the felt scrolls when even the minimum doesn't fit.
    const topH = wide ? 0 : hgt + 14, down = hgt * 0.1, minUp = hgt * (compact ? 0.34 : 0.24);
    const upFit = Math.min(...tab.map(col => {
      const ups = col.slice(0, -1).filter(c => c.up).length, downs = col.length - 1 - ups;
      return ups ? (H - topH - hgt - downs * down - 4) / ups : Infinity;
    }));
    const up = Math.max(minUp, Math.min(hgt * 0.5, upFit));
    const url = c => cardURL(c.up ? c : null, compact);
    const img = (c, extra = '') => `<img class="card" draggable="false" alt="" src="${url(c)}"
        data-id="${c.rank}-${c.suit}" data-up="${c.up ? 1 : 0}" style="width:${w}px;height:${hgt}px${extra}">`;
    const slot = (inner = '') => `<div class="slot" style="width:${w}px;height:${hgt}px">${inner}</div>`;
    // A pile shows its top card over up to two offset cards, like the stock's thickness on the desktop game.
    const pile = cards => {
      if (!cards.length) return '';
      const depth = Math.min(2, Math.floor((cards.length - 1) / 8));
      let s = '';
      for (let i = 0; i <= depth; i++) {
        const c = cards[cards.length - 1 - depth + i], off = `;position:absolute;left:${(i - depth) * 2}px;top:${(i - depth) * 1.5}px`;
        s += i === depth ? img(c, off) : `<img class="card" draggable="false" alt="" src="${url(c)}" style="width:${w}px;height:${hgt}px${off}">`;
      }
      return s;
    };
    let founds = '';
    for (let s = 0; s < 4; s++) founds += `<div class="pile" data-f="${s}">${slot()}${found[s].length ? img(found[s].at(-1), ';position:absolute;left:0;top:0') : ''}</div>`;
    const wastePile = `<div class="pile" data-k="waste">${slot()}${pile(waste)}</div>`;
    const stockPile = `<div class="pile" data-k="stock">${slot(stock.length ? '' : '<span class="redeal"></span>')}${pile(stock)}</div>`;
    let tabs = '';
    tab.forEach((col, ci) => {
      let y = 0, cards = '';
      col.forEach((c, i) => {
        cards += `<div data-k="tab" data-c="${ci}" data-i="${i}" style="position:absolute;top:${y}px">${img(c)}</div>`;
        y += c.up ? up : down;
      });
      tabs += `<div class="col" style="width:${w}px;height:${y - (col.length ? (col.at(-1).up ? up : down) : 0) + hgt}px">${slot()}${cards}</div>`;
    });
    felt.innerHTML = wide
      ? `<div class="wide-table" style="gap:${2 * gap}px"><div class="side" style="gap:${gap}px">${stockPile}${wastePile}</div>` +
        `<div class="tab-row" style="gap:${gap}px">${tabs}</div>` +
        `<div class="side founds" style="gap:${gap}px;grid-template-columns:${w}px ${w}px">${founds}</div></div>`
      : `<div class="top-row" style="gap:${gap}px">${founds}<div style="flex:1"></div>${wastePile}${stockPile}</div>` +
        `<div class="tab-row" style="gap:${gap}px">${tabs}</div>`;
    dealBtn.textContent = won ? 'Deal again' : 'New deal';
    dealBtn.classList.toggle('prominent', won);

    if (anim === 'deal') {
      const from = felt.querySelector('[data-k="stock"]').getBoundingClientRect();
      const order = [];
      tab.forEach((col, ci) => col.forEach((c, i) => order.push({ n: felt.querySelector(`[data-c="${ci}"][data-i="${i}"] img`), k: i * 7 + ci })));
      order.sort((a, b) => a.k - b.k).forEach(({ n }, k) => slide(n, from, k * 22, false));
    } else if (anim === 'move') {
      for (const n of felt.querySelectorAll('[data-id]')) {
        const b = before.get(n.dataset.id);
        if (b) slide(n, b.r, 0, b.up === '0' && n.dataset.up === '1');
      }
    }
    if (won && anim === 'move') cascade();
  }

  function slide(n, from, delay, flip) {
    const to = n.getBoundingClientRect(), [dx, dy] = toTable(from.left - to.left, from.top - to.top);
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && !flip) return;
    n.style.zIndex = 5;
    n.animate([{ transform: `translate(${dx}px, ${dy}px) scaleX(${flip ? 0 : 1})` }, { transform: 'none' }],
      { duration: flip && !dx && !dy ? 140 : 190, delay, easing: 'ease-out', fill: 'backwards' })
      .finished.then(() => { n.style.zIndex = ''; }, () => {});
  }

  /// The famous win: cards leave the foundations one by one, bouncing off the floor and leaving trails.
  function cascade() {
    const cv = document.createElement('canvas');
    cv.className = 'cascade';
    root.append(cv);
    const box = root.getBoundingClientRect(), d = devicePixelRatio || 1, W = root.clientWidth, H = root.clientHeight;
    cv.width = W * d; cv.height = H * d;
    const ctx = cv.getContext('2d');
    ctx.scale(d, d);
    const { w, hgt, compact } = size;
    const starts = [0, 1, 2, 3].map(s => { const r = felt.querySelector(`[data-f="${s}"]`).getBoundingClientRect(); return turned() ? [r.top - box.top, box.right - r.right] : [r.left - box.left, r.top - box.top]; });
    const piles = found.map(f => f.map(c => { const i = new Image(); i.src = cardURL(c, compact); return i; }));
    const g = hgt * 40, TICK = 1 / 50;
    let p = 0, card = null, acc = 0, last = performance.now(), raf = 0;
    const frame = now => {
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      for (; acc >= TICK; acc -= TICK) {
        if (!card) {
          let tries = 0;
          while (!piles[p].length && tries++ < 4) p = (p + 1) % 4;
          if (!piles[p].length) return;   // all gone; the trails stay until the next deal
          const dir = Math.random() < 0.5 ? -1 : 1;
          card = { img: piles[p].pop(), x: starts[p][0], y: starts[p][1], vx: dir * rand(5, 10) * w, vy: -rand(0, 5) * hgt };
          p = (p + 1) % 4;
        }
        card.vy += g * TICK;
        card.x += card.vx * TICK;
        card.y += card.vy * TICK;
        if (card.y + hgt > H) { card.y = H - hgt; card.vy *= -0.8; }
        ctx.drawImage(card.img, card.x, card.y, w, hgt);
        if (card.x > W || card.x + w < 0) card = null;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    stopCascade = () => { cancelAnimationFrame(raf); cv.remove(); stopCascade = null; };
    cv.addEventListener('click', () => stopCascade?.());
  }

  felt.addEventListener('click', e => {
    const t = e.target.closest('[data-k]');
    if (!t) return;
    if (t.dataset.k === 'stock') tapStock();
    else if (t.dataset.k === 'waste') tapWaste();
    else tapTableau(+t.dataset.c, +t.dataset.i);
    render('move');
  });
  dealBtn.addEventListener('click', deal);
  const ro = new ResizeObserver(() => { orient(); render(); });
  ro.observe(el);
  ro.observe(felt);
  orient();
  const timer = setInterval(() => {
    sparkle = Math.max(0, sparkle - 0.05);
    root.style.setProperty('--sparkle', sparkle * 0.12);
  }, 50);
  deal();
  return { destroy() { clearInterval(timer); ro.disconnect(); stopCascade?.(); } };
}

const GAME_IMPLS = { blocks, match3: gems, flyer: glide, solitaire };
export const mountGame = (kind, el, hooks) => GAME_IMPLS[kind](el, hooks);
