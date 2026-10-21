// Synthesised game sound effects (Web Audio, no sample files). One shared context, created on the
// first user gesture as browsers require; every effect is a silent no-op until then.

let ac = null, out = null, noiseBuf = null;

/// Route effects into `ctx` (an AudioContext, or an OfflineAudioContext when rendering for tests).
export function attachAudio(ctx, dest = ctx.destination) {
  ac = ctx;
  out = ac.createGain();   // no compressor: Chrome's squashes these short transients to about a quarter
  out.gain.value = 0.9;
  out.connect(dest);
  noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

/// Call from a pointer/key handler: creates or resumes the context.
export function unlockAudio() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    attachAudio(new AC());
  }
  if (ac.state !== 'running') ac.resume?.();   // 'suspended', or iOS 'interrupted' after a call or the lock screen
}

if (typeof window !== 'undefined') {
  // iPhone: play even with the ring/silent switch on silent (iOS 16.4+; ignored elsewhere).
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  // iOS only lets audio start on some gestures (a tap or a finger lifting, not a finger landing), so try
  // on every kind anywhere in the app; the Start button's tap then unlocks sound before any game runs.
  for (const t of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
    addEventListener(t, unlockAudio, { capture: true, passive: true });
  }
}

const ready = () => ac && (ac.state === 'running' || (typeof OfflineAudioContext !== 'undefined' && ac instanceof OfflineAudioContext));

function env(g, t, peak, dur, attack = 0.004) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}

function tone(f, { at = 0, dur = 0.2, vol = 0.2, type = 'sine', to = null } = {}) {
  const t = ac.currentTime + at, o = ac.createOscillator(), g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  env(g, t, vol, dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise({ at = 0, dur = 0.1, vol = 0.2, type = 'bandpass', f = 1000, to = null, q = 1 } = {}) {
  const t = ac.currentTime + at, s = ac.createBufferSource(), fl = ac.createBiquadFilter(), g = ac.createGain();
  s.buffer = noiseBuf;
  fl.type = type;
  fl.frequency.setValueAtTime(f, t);
  if (to) fl.frequency.exponentialRampToValueAtTime(to, t + dur);
  fl.Q.value = q;
  env(g, t, vol, dur);
  s.connect(fl).connect(g).connect(out);
  s.start(t, Math.random() * 0.5);
  s.stop(t + dur + 0.02);
}

/// Struck-bell timbre: fundamental plus two quickly decaying inharmonic partials.
function bell(f, at, vol, dur = 0.45) {
  tone(f, { at, vol, dur });
  tone(f * 2.01, { at, vol: vol * 0.35, dur: dur * 0.5 });
  tone(f * 3.98, { at, vol: vol * 0.12, dur: dur * 0.3 });
}

/// Glittery cluster of very short high blips.
function sparkle(n, at, vol) {
  for (let i = 0; i < n; i++) tone(2600 + Math.random() * 3400, { at: at + Math.random() * 0.15, vol, dur: 0.05 + Math.random() * 0.06 });
}

// Major pentatonic from E5: each step of a cascade climbs one note.
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
const note = i => 659.25 * 2 ** (SCALE[Math.min(i, SCALE.length - 1)] / 12);

const effects = {
  select() {
    tone(1320, { dur: 0.07, vol: 0.08 });
    tone(2640, { dur: 0.04, vol: 0.03 });
  },
  swap() {
    noise({ dur: 0.16, vol: 0.12, f: 600, to: 3200, q: 1.4 });
    tone(420, { to: 900, dur: 0.12, vol: 0.05, type: 'triangle' });
  },
  nope(at = 0) {
    tone(330, { at, dur: 0.1, vol: 0.1, type: 'triangle' });
    tone(247, { at: at + 0.1, dur: 0.14, vol: 0.1, type: 'triangle' });
  },
  /// `step` = 0 for the first match of a move, 1 for the first cascade, …; `n` = candies cleared.
  clear(step, n) {
    noise({ dur: 0.06, vol: 0.18, type: 'lowpass', f: 2200 });
    const f = note(step);
    bell(f, 0.01, 0.11);
    if (n >= 4) bell(f * 1.5, 0.07, 0.07);
    sparkle(3 + Math.min(n, 6), 0.02, 0.018);
  },
  land(at = 0) {
    tone(150, { at, to: 90, dur: 0.08, vol: 0.08 });
    noise({ at, dur: 0.04, vol: 0.04, type: 'lowpass', f: 500 });
  },
  beam() {
    tone(180, { to: 2400, dur: 0.32, vol: 0.06, type: 'triangle' });
    noise({ dur: 0.35, vol: 0.1, f: 800, to: 6000, q: 2 });
  },
  /// Reward fanfare; `juice` (1–2) is the hidden actuator's feedback intensity.
  celebrate(juice, big, at = 0) {
    const v = 0.11 * juice;
    [0, 4, 7, 12].forEach((s, i) => bell(523.25 * 2 ** (s / 12), at + 0.05 + i * 0.07, v));
    if (big) bell(523.25 * 4, at + 0.05 + 4 * 0.07, v, 0.7);
    sparkle(Math.round(6 * juice), at + 0.1, 0.02 * juice);
  },
  // Blocks
  move() { tone(900, { dur: 0.035, vol: 0.05, type: 'triangle' }); },
  rotate() {
    tone(700, { to: 1100, dur: 0.06, vol: 0.06 });
    tone(2200, { at: 0.02, dur: 0.03, vol: 0.02 });
  },
  lock() {
    tone(160, { to: 100, dur: 0.07, vol: 0.08 });
    noise({ dur: 0.03, vol: 0.04, type: 'lowpass', f: 600 });
  },
  drop() {
    noise({ dur: 0.12, vol: 0.12, f: 3000, to: 400, q: 1.2 });
    tone(130, { at: 0.06, to: 70, dur: 0.14, vol: 0.14 });
    noise({ at: 0.06, dur: 0.05, vol: 0.08, type: 'lowpass', f: 700 });
  },
  /// `n` rows cleared: one rising bell per row over a bright sweep.
  lines(n) {
    noise({ dur: 0.3, vol: 0.08, f: 800, to: 6000, q: 2 });
    for (let i = 0; i < n; i++) bell(note(2 * i), 0.02 + i * 0.06, 0.1);
    sparkle(4 + 2 * n, 0.03, 0.018);
  },
  restart() {
    tone(600, { to: 150, dur: 0.5, vol: 0.08, type: 'triangle' });
    noise({ dur: 0.4, vol: 0.05, type: 'lowpass', f: 1500, to: 300 });
  },
  // Glide (8-bit style)
  flap() {
    noise({ dur: 0.09, vol: 0.2, f: 900, to: 450, q: 1.5 });
  },
  /// Coin collected: two square-wave beeps, louder with juice.
  point(juice = 1) {
    tone(1760, { dur: 0.07, vol: 0.09 * juice, type: 'square' });
    tone(2349, { at: 0.07, dur: 0.3, vol: 0.09 * juice, type: 'square' });
  },
  hit() {
    noise({ dur: 0.08, vol: 0.14, type: 'lowpass', f: 3000 });
    tone(160, { to: 60, dur: 0.12, vol: 0.06, type: 'square' });
    tone(900, { at: 0.1, to: 350, dur: 0.3, vol: 0.05, type: 'triangle' });
  },
  drop() {   // coin lost: two falling notes after the hit
    tone(988, { at: 0.12, dur: 0.07, vol: 0.05, type: 'square' });
    tone(659, { at: 0.2, to: 300, dur: 0.28, vol: 0.05, type: 'square' });
  },
  shuffle() {
    for (let i = 0; i < 3; i++) noise({ at: i * 0.09, dur: 0.1, vol: 0.15, f: 1200 + i * 600, q: 2 });
  },
};

/// sfx.clear(0, 3) etc. Silent when no context is running.
export const sfx = Object.fromEntries(Object.entries(effects).map(([k, f]) => [k, (...a) => {
  if (ready()) f(...a);
  else if (ac?.state === 'suspended') ac.resume().then(() => f(...a), () => {});   // first click: context still starting
}]));
