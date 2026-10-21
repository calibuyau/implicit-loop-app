// LoopCore, ported from LoopCore/Sources/LoopCore (Swift) to plain JS.
// Behaviour follows the Swift package; see the Swift files for rationale behind each piece.

// MARK: random

const MASK = (1n << 64n) - 1n;
const GOLDEN = 0x9E3779B97F4A7C15n;

/// Seedable RNG (SplitMix64) so simulations and the tuner are reproducible.
export class SplitMix64 {
  constructor(seed = 0) { this.state = (BigInt.asUintN(64, BigInt(seed)) + GOLDEN) & MASK; }
  next() {
    this.state = (this.state + GOLDEN) & MASK;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK;
    return z ^ (z >> 31n);
  }
  /// Uniform in [0, 1).
  uniform() { return Number(this.next() >> 11n) * 2 ** -53; }
  /// Standard normal (Box–Muller).
  gaussian() {
    const u1 = Math.max(this.uniform(), 1e-12), u2 = this.uniform();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  toJSON() { return this.state.toString(); }
  static fromJSON(s) { const r = new SplitMix64(0); r.state = BigInt(s); return r; }
}

/// Unseeded RNG with the same interface (live play).
export const systemRng = {
  uniform: () => Math.random(),
  gaussian() {
    const u1 = Math.max(Math.random(), 1e-12), u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  },
};

export const clip = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const sum = xs => xs.reduce((a, b) => a + b, 0);
export const mean = xs => (xs.length ? sum(xs) / xs.length : NaN);
function variance(xs) {
  const m = mean(xs);
  return sum(xs.map(x => (x - m) * (x - m))) / Math.max(1, xs.length - 1);
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// MARK: heart-rate measurement (GATT 0x2A37)

/// Returns {bpm, rr: [ms]}. RR intervals are transmitted in 1/1024 s units.
export function parseHeartRate(b) {
  if (!b.length) return { bpm: 0, rr: [] };
  const flags = b[0];
  let i, hr;
  if (flags & 0x01) {
    if (b.length < 3) return { bpm: 0, rr: [] };
    hr = b[1] | (b[2] << 8); i = 3;
  } else {
    if (b.length < 2) return { bpm: 0, rr: [] };
    hr = b[1]; i = 2;
  }
  if (flags & 0x08) i += 2;          // energy expended present
  const rr = [];
  if (flags & 0x10) {
    while (i + 1 < b.length) { rr.push((b[i] | (b[i + 1] << 8)) * 1000 / 1024); i += 2; }
  }
  return { bpm: hr, rr };
}

// MARK: HRV engine

/// Sliding-window HRV over a stream of RR intervals (port of HRVEngine.swift).
export class HRVEngine {
  constructor({ windowS = 30, minBeats = 8, artThreshold = 0.30, artRefN = 7, maxGapS = 3,
                rrMinMs = 300, rrMaxMs = 2000 } = {}) {
    Object.assign(this, { windowS, minBeats, artThreshold, artRefN, maxGapS, rrMinMs, rrMaxMs });
    this.retentionS = 120;
    this.beats = [];
    this.recentAccepted = [];
  }

  addRR(rr, t) {
    const artifact = this.isArtifact(rr);
    if (!artifact) {
      this.recentAccepted.push(rr);
      if (this.recentAccepted.length > this.artRefN) this.recentAccepted.shift();
    }
    const beat = { t, rr, artifact };
    this.beats.push(beat);
    const keepFrom = t - Math.max(this.windowS, this.retentionS) - 5;
    const i = this.beats.findIndex(b => b.t >= keepFrom);
    if (i > 0) this.beats.splice(0, i);
    return beat;
  }

  isArtifact(rr) {
    if (rr < this.rrMinMs || rr > this.rrMaxMs) return true;
    if (this.recentAccepted.length < 3) return false;
    const ref = median(this.recentAccepted);
    return Math.abs(rr - ref) / ref > this.artThreshold;
  }

  validBeats(now, w = this.windowS) {
    const w0 = now - w;
    return this.beats.filter(b => b.t >= w0 && !b.artifact);
  }

  compute(now = this.beats.at(-1)?.t ?? 0, w = this.windowS) {
    const valid = this.validBeats(now, w), n = valid.length;
    if (n < 2) return { t: now, nBeats: n, coverage: 0, meanHR: NaN, meanRR: NaN, rmssd: NaN,
                        sdnn: NaN, pnn50: NaN, confidence: 'low', usable: false };
    const rr = valid.map(b => b.rr);
    const diffs = [];
    for (let i = 1; i < n; i++) if (valid[i].t - valid[i - 1].t <= this.maxGapS) diffs.push(valid[i].rr - valid[i - 1].rr);
    const meanRR = sum(rr) / n;
    const rmssd = diffs.length ? Math.sqrt(sum(diffs.map(d => d * d)) / diffs.length) : NaN;
    const sdnn = Math.sqrt(sum(rr.map(x => (x - meanRR) ** 2)) / (n - 1));
    const pnn50 = diffs.length ? diffs.filter(d => Math.abs(d) > 50).length / diffs.length : NaN;
    const coverage = Math.min(1, sum(rr) / (w * 1000));
    const confidence = coverage >= 0.8 && n >= this.minBeats ? 'ok' : 'low';
    return { t: now, nBeats: n, coverage, meanHR: 60000 / meanRR, meanRR, rmssd, sdnn, pnn50, confidence,
             usable: confidence === 'ok' && Number.isFinite(rmssd) };
  }
}

// MARK: controller

export const defaultControllerConfig = () => ({
  kp: 0.030, ki: 0.0035, deadbandMs: 1.0, slewPerS: 0.08, outMin: -1, outMax: 1, integLimit: 0.8, baselineTauS: 45,
});

/// Bidirectional PI setpoint controller; output u ∈ [-1, 1] is the covert "luck" signal.
export class SetpointController {
  constructor(cfg = defaultControllerConfig(), sham = false) {
    this.cfg = cfg; this.sham = sham;
    this.output = 0; this.baseline = null; this.lastError = NaN; this.target = null; this.integral = 0;
  }
  reset(output = 0) { this.integral = 0; this.output = output; }
  update(m, dt) {
    if (!m.usable) { this.lastError = NaN; return this.output; }
    const c = this.cfg, rmssd = m.rmssd;
    if (this.baseline == null) this.baseline = rmssd;
    this.baseline += (dt / (c.baselineTauS + dt)) * (rmssd - this.baseline);
    if (this.sham || this.target == null) return this.output;
    let error = this.target - rmssd;
    this.lastError = error;
    if (Math.abs(error) < c.deadbandMs) error = 0;
    this.integral += error * dt;
    const integTerm = clip(c.ki * this.integral, -c.integLimit, c.integLimit);
    if (c.ki > 0) this.integral = integTerm / c.ki;
    const raw = clip(c.kp * error + integTerm, c.outMin, c.outMax);
    const maxStep = c.slewPerS * dt;
    this.output = clip(this.output + clip(raw - this.output, -maxStep, maxStep), c.outMin, c.outMax);
    return this.output;
  }
}

// MARK: parameters

/// Every knob of the closed loop that the tuner may adjust for an individual.
export const defaultParams = () => ({
  windowS: 30, kp: 0.045, ki: 0.006, slewPerS: 0.08, rewardSpan: 0.40, rewardBias: 0,
  cadenceScale: 1, juice: 0.5, setpointStep: 0.20,
});

export const DIMS = [
  { name: 'windowS', lo: 10, hi: 60, log: true },
  { name: 'kp', lo: 0.01, hi: 0.12, log: true },
  { name: 'ki', lo: 0.0005, hi: 0.015, log: true },
  { name: 'slewPerS', lo: 0.02, hi: 0.20, log: true },
  { name: 'rewardSpan', lo: 0.10, hi: 0.45, log: false },
  { name: 'rewardBias', lo: -0.20, hi: 0.20, log: false },
  { name: 'cadenceScale', lo: 0.5, hi: 2.0, log: true },
  { name: 'juice', lo: 0, hi: 1, log: false },
  { name: 'setpointStep', lo: 0.05, hi: 0.40, log: false },
];
const dimDef = name => DIMS.find(d => d.name === name);
const toUnit = (d, v) => d.log ? (Math.log(v) - Math.log(d.lo)) / (Math.log(d.hi) - Math.log(d.lo)) : (v - d.lo) / (d.hi - d.lo);
function fromUnit(d, z) {
  z = clip(z, 0, 1);
  return d.log ? Math.exp(Math.log(d.lo) + z * (Math.log(d.hi) - Math.log(d.lo))) : d.lo + z * (d.hi - d.lo);
}

/// Search space: {locked: [names], fixed: params}. Locked dims keep the value of `fixed`.
export const defaultSpace = () => ({ locked: [], fixed: defaultParams() });
const freeDims = space => DIMS.filter(d => !space.locked.includes(d.name));
const encode = (space, p) => freeDims(space).map(d => toUnit(d, p[d.name]));
function decode(space, z) {
  const p = { ...space.fixed };
  freeDims(space).forEach((d, i) => { p[d.name] = fromUnit(d, z[i]); });
  return p;
}
const controllerConfig = p => ({ ...defaultControllerConfig(), kp: p.kp, ki: p.ki, slewPerS: p.slewPerS });

// MARK: games (platform-independent part)

export const GAMES = {
  solitaire: { title: 'Solitaire', lever: 'deal order / stock luck', baseInterval: 3.5, pMin: 0.15 },
  blocks: { title: 'Blocks', lever: 'next-piece bias (easy I/O/T vs awkward S/Z)', baseInterval: 1.5, pMin: 0.08 },
  match3: { title: 'Gems', lever: 'refill seeding → cascade chance', baseInterval: 6.0, pMin: 0.08 },
  flyer: { title: 'Glide', lever: 'spacing of gaps & collectibles', baseInterval: 2.5, pMin: 0.08 },
};
export const GAME_KINDS = Object.keys(GAMES);

export const NEUTRAL_ACTUATOR = { pSuccess: 0.5, interval: 3, juice: 1, uEff: 0 };

/// What the game needs each tick. Games read only this, never the physiology.
export function actuatorState(u, p, game) {
  return {
    pSuccess: clip(0.5 + p.rewardBias + p.rewardSpan * u, GAMES[game].pMin, 0.92),
    interval: GAMES[game].baseInterval * p.cadenceScale,
    juice: 1 + p.juice * Math.max(0, u),
    uEff: clip(u, -1, 1),
  };
}

/// Simulation stand-in for a game: turns ActuatorState into reward events.
export class SimGame {
  constructor() { this.accum = 0; this.nearMissProb = 0.3; }
  step(dt, s, rng) {
    const out = [];
    this.accum += dt;
    while (this.accum >= s.interval) {
      this.accum -= s.interval;
      if (rng.uniform() < s.pSuccess) out.push(s.juice);
      else if (rng.uniform() < this.nearMissProb) out.push(0.3);
      else out.push(0);
    }
    return out;
  }
}

// MARK: Gaussian process

function cholesky(A) {
  const n = A.length, L = A.map(() => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) { if (!(s > 0)) return null; L[i][i] = Math.sqrt(s); }
      else L[i][j] = s / L[j][j];
    }
  }
  return L;
}
function forwardSub(L, b) {
  const x = [...b];
  for (let i = 0; i < L.length; i++) {
    for (let k = 0; k < i; k++) x[i] -= L[i][k] * x[k];
    x[i] /= L[i][i];
  }
  return x;
}
function cholSolve(L, b) {
  const x = forwardSub(L, b);
  for (let i = L.length - 1; i >= 0; i--) {
    for (let k = i + 1; k < L.length; k++) x[i] -= L[k][i] * x[k];
    x[i] /= L[i][i];
  }
  return x;
}
const normPDF = z => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
function erfc(x) {   // Numerical Recipes erfcc, |error| < 1.2e-7
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
const normCDF = z => 0.5 * erfc(-z / Math.SQRT2);

/// Small exact GP regressor (RBF kernel, standardised targets); hyperparameters by grid search on the LML.
export class GaussianProcess {
  constructor(lengthScale = 0.3, noise = 0.2) {
    this.lengthScale = lengthScale; this.noise = noise;
    this.X = []; this.L = []; this.alpha = []; this.yMean = 0; this.yStd = 1;
  }
  fit(X, y, optimise = true) {
    this.X = X;
    if (!y.length) return;
    this.yMean = mean(y);
    const v = sum(y.map(t => (t - this.yMean) ** 2)) / Math.max(1, y.length - 1);
    this.yStd = v > 1e-12 ? Math.sqrt(v) : 1;
    const ys = y.map(t => (t - this.yMean) / this.yStd);
    const d = X[0]?.length ?? 1;
    let best = null;
    const lsGrid = optimise ? [0.1, 0.2, 0.35, 0.6, 1.0].map(s => s * Math.sqrt(d)) : [this.lengthScale];
    const nGrid = optimise ? [0.05, 0.15, 0.4, 0.8] : [this.noise];
    for (const ls of lsGrid) for (const nz of nGrid) {
      const lml = this.logMarginal(X, ys, ls, nz);
      if (lml != null && (best == null || lml > best[0])) best = [lml, ls, nz];
    }
    if (best) { this.lengthScale = best[1]; this.noise = best[2]; }
    this.L = cholesky(this.gram(X, this.lengthScale, this.noise));
    this.alpha = cholSolve(this.L, ys);
  }
  predict(x) {
    if (!this.X.length) return { mean: this.yMean, std: this.yStd };
    const k = this.X.map(a => this.kern(a, x, this.lengthScale));
    const mu = sum(k.map((ki, i) => ki * this.alpha[i]));
    const v = forwardSub(this.L, k);
    const var_ = Math.max(1e-12, 1 - sum(v.map(t => t * t)));
    return { mean: this.yMean + this.yStd * mu, std: this.yStd * Math.sqrt(var_) };
  }
  logMarginal(X, y, ls, nz) {
    const L = cholesky(this.gram(X, ls, nz));
    if (!L) return null;
    const a = cholSolve(L, y);
    const fit = -0.5 * sum(y.map((t, i) => t * a[i]));
    const logDet = sum(L.map((row, i) => Math.log(row[i])));
    return fit - logDet - 0.5 * y.length * Math.log(2 * Math.PI);
  }
  kern(a, b, ls) {
    let s = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
    return Math.exp(-0.5 * s / (ls * ls));
  }
  gram(X, ls, nz) {
    const n = X.length, K = X.map(() => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) { const k = this.kern(X[i], X[j], ls); K[i][j] = k; K[j][i] = k; }
      K[i][i] += nz * nz + 1e-8;
    }
    return K;
  }
}

// MARK: tuner

/// Per-individual Bayesian optimiser over loop parameters (Expected Improvement, trust region).
export class Tuner {
  constructor(space = defaultSpace(), seed = 1) {
    this.space = space;
    this.observations = [];   // {params, objective, date}
    this.initialDesign = 4;
    this.trustRadius = 0.35;
    this.rng = new SplitMix64(seed);
  }

  record(params, objective, date = new Date().toISOString()) {
    if (!Number.isFinite(objective)) return;
    this.observations.push({ params: { ...params }, objective, date });
  }

  model() {
    if (this.observations.length < 2 || !freeDims(this.space).length) return null;
    const gp = new GaussianProcess();
    gp.fit(this.observations.map(o => encode(this.space, o.params)), this.observations.map(o => o.objective));
    return gp;
  }

  /// Best parameters so far = highest posterior mean among evaluated points (robust to noise).
  incumbent() {
    const gp = this.model();
    if (!gp) {
      if (!this.observations.length) return { ...this.space.fixed };
      return this.observations.reduce((a, b) => (b.objective > a.objective ? b : a)).params;
    }
    return this.incumbentOf(gp).params;
  }
  incumbentOf(gp) {
    return this.observations.map(o => ({ params: o.params, mean: gp.predict(encode(this.space, o.params)).mean }))
      .reduce((a, b) => (b.mean > a.mean ? b : a));
  }
  predict(p) { return this.model()?.predict(encode(this.space, p)) ?? null; }

  /// Parameters for the next active block.
  suggest() {
    const d = freeDims(this.space).length;
    if (!d) return { ...this.space.fixed };
    const n = this.observations.length;
    if (n === 0) return { ...this.space.fixed };
    if (n < this.initialDesign) {
      // Space-filling around the defaults: stratified jitter in each dimension.
      const base = encode(this.space, this.space.fixed);
      return decode(this.space, base.map((b, i) => {
        const stratum = ((n + i) % this.initialDesign) / this.initialDesign;
        return clip(0.5 * b + 0.5 * (stratum + this.rng.uniform() / this.initialDesign), 0, 1);
      }));
    }
    const gp = this.model();
    if (!gp) return { ...this.space.fixed };
    const { params: incParams, mean: fBest } = this.incumbentOf(gp);
    const inc = encode(this.space, incParams);
    let best = inc, bestEI = -Infinity;
    for (let k = 0; k < 1500; k++) {
      const z = k < 1000
        ? inc.map(v => clip(v + (2 * this.rng.uniform() - 1) * this.trustRadius, 0, 1))
        : inc.map(v => clip(v + 0.08 * this.rng.gaussian(), 0, 1));
      const { mean: mu, std: sd } = gp.predict(z);
      const imp = mu - fBest - 0.005, zz = imp / sd;
      const ei = imp * normCDF(zz) + sd * normPDF(zz);
      if (ei > bestEI) { bestEI = ei; best = z; }
    }
    return decode(this.space, best);
  }

  toJSON() {
    return { space: this.space, observations: this.observations, initialDesign: this.initialDesign,
             trustRadius: this.trustRadius, rng: this.rng.toJSON() };
  }
  static fromJSON(o) {
    const t = new Tuner(o.space);
    Object.assign(t, { observations: o.observations, initialDesign: o.initialDesign, trustRadius: o.trustRadius });
    t.rng = SplitMix64.fromJSON(o.rng);
    return t;
  }
}

function djb2(s) {
  let h = 5381n;
  for (const b of new TextEncoder().encode(s)) h = ((h << 5n) + h + BigInt(b)) & MASK;
  return h;
}

/// All tuners of one person, keyed by game and goal (optimal settings differ by both).
export class UserProfile {
  constructor(name) {
    this.id = crypto.randomUUID();
    this.name = name;
    this.created = new Date().toISOString();
    this.tuners = {};
    this.sessions = [];   // {date, goal, blocks}
  }
  static key(game, goal) { return `${game}.${goal}`; }
  tuner(game, goal, space) {
    const k = UserProfile.key(game, goal);
    return (this.tuners[k] ??= new Tuner(space, djb2(k)));
  }
  toJSON() { return { ...this }; }
  static fromJSON(o) {
    const p = Object.assign(new UserProfile(o.name), o);
    p.tuners = Object.fromEntries(Object.entries(o.tuners ?? {}).map(([k, t]) => [k, Tuner.fromJSON(t)]));
    return p;
  }
}

// MARK: session

export const GOAL_SIGN = { increase: 1, decrease: -1 };

export const defaultSessionConfig = () => ({
  goal: 'increase',
  games: ['solitaire'],   // several → blocks allocated by a UCB bandit on block objectives
  baselineS: 120,
  blockS: 180,
  washoutS: 30,
  shamEvery: 4,           // every Nth block is a yoked sham; 0 = none
  evalWindowS: 60,        // fixed evaluation window, independent of the tuned control window
  maxBlocks: 8,
  tuning: true,
  objective: 'outcome',   // 'outcome' | 'contingency'
  space: defaultSpace(),
});

export const sessionTotalS = c => c.baselineS + c.maxBlocks * (c.washoutS + c.blockS);

/// Closed-loop session state machine: baseline → [washout → active|sham] × N.
/// Feed beats with addBeat, call tick once per second, read `actuator` for the game.
export class LoopSession {
  constructor(config, profile) {
    this.config = config;
    this.profile = profile;
    this.phase = 'baseline';
    this.game = config.games[0] ?? 'solitaire';
    this.params = { ...config.space.fixed };
    this.controller = new SetpointController(controllerConfig(this.params));
    this.actuator = actuatorState(0, this.params, this.game);
    this.engine = new HRVEngine({ windowS: 30 });
    this.engine.windowS = this.params.windowS;
    this.log = [];
    this.blocks = [];
    this.baselineRMSSD = null;
    this.target = NaN;
    this.onBlockFinished = null;
    this.t0 = null;
    this.phaseStart = 0;
    this.blockIndex = -1;
    this.refLn = NaN;
    this.yokedTrace = [];
    this.currentTrace = [];
    this.lastActiveParams = null;
    this.lastActiveGame = null;
    this.lastActiveObjective = null;
  }

  get elapsed() { return this.log.at(-1)?.t ?? 0; }
  get blockNumber() { return this.blockIndex + 1; }
  get phaseElapsed() { return this.elapsed - this.phaseStart; }
  get phaseDuration() {
    const c = this.config;
    return { baseline: c.baselineS, washout: c.washoutS, active: c.blockS, sham: c.blockS, done: 0 }[this.phase];
  }

  addBeat(rr, t) {
    if (this.t0 == null) this.t0 = t;
    this.engine.addRR(rr, t - this.t0);
  }

  /// Advance one control tick at wall time `now` (same clock as beats). Returns the log row.
  tick(now, dt = 1) {
    if (this.t0 == null) this.t0 = now;
    const t = now - this.t0;
    const m = this.engine.compute(t);
    const ev = this.engine.compute(t, this.config.evalWindowS);

    this.advancePhase(t);

    let u = 0;
    if (this.phase === 'active') {
      if (m.usable && this.baselineRMSSD != null) this.controller.target = this.target;
      u = this.controller.update(m, dt);
      this.currentTrace.push(u);
    } else if (this.phase === 'sham') {
      const i = Math.floor(t - this.phaseStart);
      u = this.yokedTrace.length ? this.yokedTrace[Math.min(i, this.yokedTrace.length - 1)] : 0;
      this.controller.update(m, dt);   // keeps baseline estimate, output unused
    } else {
      this.controller.update(m, dt);
    }
    this.actuator = actuatorState(u, this.params, this.game);

    const row = {
      t, phase: this.phase, block: this.blockIndex, game: this.game,
      rmssd: m.rmssd, rmssdEval: ev.rmssd, hr: m.meanHR, usable: ev.usable,
      target: this.phase === 'active' ? this.target : NaN,
      u, pSuccess: this.actuator.pSuccess, interval: this.actuator.interval,
    };
    this.log.push(row);
    return row;
  }

  advancePhase(t) {
    const c = this.config, inPhase = t - this.phaseStart;
    if (this.phase === 'baseline' && inPhase >= c.baselineS) {
      const v = this.lnEval(t - c.baselineS / 2, t);
      this.baselineRMSSD = Number.isFinite(v) ? Math.exp(v) : null;
      this.begin('washout', t);
    } else if (this.phase === 'washout' && inPhase >= c.washoutS) {
      this.startBlock(t);
    } else if ((this.phase === 'active' || this.phase === 'sham') && inPhase >= c.blockS) {
      this.finishBlock(t);
      this.begin(this.blocks.length >= c.maxBlocks ? 'done' : 'washout', t);
    }
  }

  begin(p, t) {
    this.phase = p;
    this.phaseStart = t;
    if (p === 'washout' || p === 'done') { this.controller.reset(); this.controller.target = null; }
  }

  startBlock(t) {
    const c = this.config;
    this.blockIndex += 1;
    this.refLn = this.lnEval(t - 30, t);
    if (!Number.isFinite(this.refLn) && this.baselineRMSSD != null) this.refLn = Math.log(this.baselineRMSSD);

    const every = c.objective === 'contingency' ? 2 : c.shamEvery;
    const isSham = every > 0 && (this.blockIndex + 1) % every === 0
      && this.yokedTrace.length > 0 && this.lastActiveParams != null;
    if (isSham) {
      this.params = this.lastActiveParams;
      this.game = this.lastActiveGame;
    } else {
      this.game = this.chooseGame();
      const tuner = this.profile.tuner(this.game, c.goal, c.space);
      tuner.space = c.space;
      this.params = c.tuning ? tuner.suggest() : tuner.incumbent();
    }
    this.engine.windowS = this.params.windowS;
    this.controller.cfg = controllerConfig(this.params);
    this.controller.reset();
    this.target = Number.isFinite(this.refLn) ? Math.exp(this.refLn) * (1 + GOAL_SIGN[c.goal] * this.params.setpointStep) : NaN;
    this.controller.target = Number.isFinite(this.target) ? this.target : null;
    this.currentTrace = [];
    this.begin(isSham ? 'sham' : 'active', t);
  }

  finishBlock(t) {
    const c = this.config, s = this.phaseStart, g = GAMES[this.game];
    const rows = this.log.filter(r => r.t > s && r.t <= t);
    const late = rows.filter(r => r.t >= s + c.blockS / 2 && r.usable && r.rmssdEval > 0);
    const lateLn = late.length ? mean(late.map(r => Math.log(r.rmssdEval))) : NaN;
    const usableFrac = rows.length ? rows.filter(r => r.usable).length / rows.length : 0;
    const sat = rows.length ? rows.filter(r => r.pSuccess <= g.pMin + 1e-9 || r.pSuccess >= 0.92 - 1e-9).length / rows.length : 0;
    const meanP = rows.length ? mean(rows.map(r => r.pSuccess)) : 0.5;
    const score = GOAL_SIGN[c.goal] * (lateLn - this.refLn);
    const valid = Number.isFinite(score) && usableFrac >= 0.6;
    // Covertness: outcomes pinned at the probability bounds read as rigged.
    const objective = score - 0.05 * sat - 0.1 * Math.max(0, Math.abs(meanP - 0.5) - 0.25);
    const r = {
      index: this.blockIndex, phase: this.phase, game: this.game, params: { ...this.params }, start: s, end: t,
      refLn: this.refLn, lateLn, score, objective, usableFrac, saturatedFrac: sat, meanP, valid,
    };
    this.blocks.push(r);
    const key = UserProfile.key(this.game, c.goal);
    if (this.phase === 'active') {
      this.yokedTrace = this.currentTrace;
      this.lastActiveParams = this.params;
      this.lastActiveGame = this.game;
      this.lastActiveObjective = valid ? objective : null;
      if (valid && c.objective === 'outcome') this.profile.tuners[key]?.record(this.params, objective);
    } else if (this.phase === 'sham' && c.objective === 'contingency' && valid && this.lastActiveObjective != null) {
      this.profile.tuners[key]?.record(this.params, this.lastActiveObjective - score);
    }
    this.onBlockFinished?.(r);
  }

  /// UCB1 over games on active-block objectives (only when several games are enabled).
  chooseGame() {
    const gs = this.config.games;
    if (gs.length <= 1) return gs[0] ?? 'solitaire';
    const active = this.blocks.filter(b => b.phase === 'active' && b.valid);
    const unplayed = gs.find(g => !active.some(b => b.game === g));
    if (unplayed) return unplayed;
    const n = active.length;
    const ucb = g => {
      const xs = active.filter(b => b.game === g).map(b => b.objective);
      return mean(xs) + 0.1 * Math.sqrt(2 * Math.log(n) / xs.length);
    };
    return gs.reduce((a, b) => (ucb(b) > ucb(a) ? b : a));
  }

  lnEval(a, b) {
    const xs = this.log.filter(r => r.t > a && r.t <= b && r.usable && r.rmssdEval > 0).map(r => Math.log(r.rmssdEval));
    return xs.length ? mean(xs) : NaN;
  }

  /// Close the session and fold its summary into the profile.
  finish(date = new Date().toISOString()) {
    const summary = { date, goal: this.config.goal, blocks: this.blocks };
    this.profile.sessions.push(summary);
    return summary;
  }
}

// MARK: summary

/// Closed-loop performance of one session: active vs yoked-sham contrast.
export function summarize(s) {
  const active = s.blocks.filter(b => b.phase === 'active' && b.valid).map(b => b.score);
  const sham = s.blocks.filter(b => b.phase === 'sham' && b.valid).map(b => b.score);
  const meanActive = mean(active), meanSham = mean(sham), effect = meanActive - meanSham;
  let cohensD = NaN;
  if (active.length > 1 && sham.length > 1) {
    const pooled = Math.sqrt(((active.length - 1) * variance(active) + (sham.length - 1) * variance(sham))
      / (active.length + sham.length - 2));
    if (pooled > 0) cohensD = effect / pooled;
  }
  return { active, sham, meanActive, meanSham, effect, cohensD };
}

const g4 = x => (Number.isFinite(x) ? String(Number(x.toPrecision(4))) : '');

export const CSV = {
  ticks(rows) {
    let s = 't,phase,block,game,rmssd,rmssd_eval,hr,usable,target,u,p_success,interval\n';
    for (const r of rows) {
      s += [g4(r.t), r.phase, r.block, r.game, g4(r.rmssd), g4(r.rmssdEval), g4(r.hr), r.usable ? 1 : 0,
            g4(r.target), g4(r.u), g4(r.pSuccess), g4(r.interval)].join(',') + '\n';
    }
    return s;
  },
  blocks(bs) {
    const names = DIMS.map(d => d.name);
    let s = 'block,phase,game,start,end,ref_ln,late_ln,score,objective,usable_frac,saturated_frac,mean_p,valid,'
      + names.join(',') + '\n';
    for (const b of bs) {
      s += [b.index, b.phase, b.game, g4(b.start), g4(b.end), g4(b.refLn), g4(b.lateLn), g4(b.score), g4(b.objective),
            g4(b.usableFrac), g4(b.saturatedFrac), g4(b.meanP), b.valid ? 1 : 0, ...names.map(n => g4(b.params[n]))]
        .join(',') + '\n';
    }
    return s;
  },
};

/// JSON that round-trips NaN/±Infinity (plain JSON turns them into null).
export const JSONX = {
  stringify: (v, space) => JSON.stringify(v, (k, x) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : x), space),
  parse: s => JSON.parse(s, (k, x) => (x === 'NaN' ? NaN : x === 'Infinity' ? Infinity : x === '-Infinity' ? -Infinity : x)),
};

// MARK: simulated participant

/// Simulated person: reward drives respiratory depth (RSA → RMSSD) with a lag, plus individual
/// hidden sensitivities so there is a person-specific optimum for the tuner to find.
export class SimParticipant {
  constructor(seed = 0, configure = () => {}) {
    Object.assign(this, {
      baseRSA: 40, rsaGain: 34, tauRSA: 10, preferredInterval: 3, juiceSensitivity: 0.5,
      suspicionThreshold: 0.25, driftSD: 0.3, respHz: 0.16, meanHR: 68, jitter: 5,
    });
    this.rewardLevel = 0.5; this.drift = 0; this.pEMA = 0.5; this.t = 0;
    this.rng = new SplitMix64(seed);
    configure(this);
    this.rsa = this.baseRSA;
    this.tBeat = 60 / this.meanHR;
  }

  static random(seed) {
    const g = new SplitMix64(BigInt.asUintN(64, BigInt(seed) * 7919n));
    return new SimParticipant(seed, p => {
      p.baseRSA = 25 + 30 * g.uniform();
      p.rsaGain = 20 + 30 * g.uniform();
      p.tauRSA = 6 + 14 * g.uniform();
      p.preferredInterval = Math.exp(Math.log(1.2) + g.uniform() * Math.log(8 / 1.2));
      p.juiceSensitivity = g.uniform();
      p.suspicionThreshold = 0.15 + 0.2 * g.uniform();
      p.meanHR = 58 + 20 * g.uniform();
    });
  }

  cadenceEfficacy(interval) {
    const z = Math.log(interval / this.preferredInterval) / 0.6;
    return Math.exp(-0.5 * z * z);
  }

  receive(events, s) {
    this.pEMA += 0.02 * (s.pSuccess - this.pEMA);
    const suspicion = Math.max(0, Math.abs(this.pEMA - 0.5) - this.suspicionThreshold) * 3;
    const eff = this.cadenceEfficacy(s.interval) * Math.max(0.1, 1 - suspicion);
    for (const mag of events) {
      const m = mag > 1 ? 1 + this.juiceSensitivity * (mag - 1) * 2 : mag;
      this.rewardLevel += 0.25 * eff * (m - this.rewardLevel);
    }
  }

  /// Advance dt seconds; returns [t, rr_ms] beats.
  advance(dt) {
    this.rewardLevel += (dt / 12) * (0.5 - this.rewardLevel) * 0.25;
    this.drift += this.driftSD * this.rng.gaussian() * Math.sqrt(dt) - 0.01 * this.drift * dt;
    const targetRSA = this.baseRSA + this.drift + this.rsaGain * 2 * (this.rewardLevel - 0.5);
    this.rsa = clip(this.rsa + (dt / this.tauRSA) * (targetRSA - this.rsa), 2, 120);
    const meanRR = 60000 / this.meanHR;
    this.t += dt;
    const out = [];
    while (this.tBeat <= this.t) {
      const rr = clip(meanRR + this.rsa * Math.sin(2 * Math.PI * this.respHz * this.tBeat) + this.jitter * this.rng.gaussian(), 300, 2000);
      out.push([this.tBeat, rr]);
      this.tBeat += rr / 1000;
    }
    return out;
  }
}

/// Run a whole session against a simulated participant (tests, CLI).
export function simulate(config, profile, participant, seed = 1) {
  const s = new LoopSession(config, profile);
  const game = new SimGame(), rng = new SplitMix64(seed);
  const total = sessionTotalS(config) + 2, start = participant.t;
  while (participant.t - start < total && s.phase !== 'done') {
    participant.receive(game.step(1, s.actuator, rng), s.actuator);
    for (const [bt, rr] of participant.advance(1)) s.addBeat(rr, bt);
    s.tick(participant.t);
  }
  return s;
}
