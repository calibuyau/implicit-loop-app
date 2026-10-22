// Browser app: heart source → LoopSession (1 Hz) → ActuatorState → game.
// Port of App/Sources (AppModel, Store and the SwiftUI views).
import {
  CSV, DIMS, GAMES, GAME_KINDS, JSONX, LoopSession, NEUTRAL_ACTUATOR, UserProfile, defaultSessionConfig,
  sessionTotalS, summarize,
} from './core.js';
import { PolarH10, SimulatedHeart, now } from './sources.js';
import { mountGame } from './games.js';
import { barChart, legend, lineChart } from './charts.js';

// MARK: storage (localStorage stands in for the app's Documents folder)

const KEYS = { profiles: 'il.profiles', config: 'il.config', archive: 'il.archive', ui: 'il.ui', upload: 'il.upload' };
const Store = {
  load(key, fallback) {
    try { const s = localStorage.getItem(key); return s ? JSONX.parse(s) : fallback; } catch { return fallback; }
  },
  save(key, v) {
    try { localStorage.setItem(key, JSONX.stringify(v)); return true; } catch { return false; }
  },
  /// Every session keeps its full log; if storage fills up, the oldest logs are dropped first
  /// (block results stay in the profile either way).
  archive(entry) {
    const all = Store.load(KEYS.archive, []);
    all.push(entry);
    while (!Store.save(KEYS.archive, all)) {
      const i = all.findIndex(e => e.log);
      if (i < 0 || i === all.length - 1) { all.at(-1).log = null; Store.save(KEYS.archive, all); break; }
      all[i].log = null;
    }
  },
  updateEntry(id, fields) {
    const all = Store.load(KEYS.archive, []);
    for (const e of all) if (e.id === id) Object.assign(e, fields);
    Store.save(KEYS.archive, all);
  },
  markUploaded(id) { Store.updateEntry(id, { uploaded: true }); },
};

// MARK: upload (each finished session → one JSON file in a private GitHub repo)

function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/// The token has its own storage key, so "Export everything" never includes it.
const Upload = {
  settings: { repo: '', token: '', ...Store.load(KEYS.upload, {}) },
  status: '',
  busy: false,
  save() { Store.save(KEYS.upload, this.settings); },
  get ready() { return /^[\w.-]+\/[\w.-]+$/.test(this.settings.repo) && !!this.settings.token; },
  waiting: () => Store.load(KEYS.archive, []).filter(e => !e.uploaded && !e.demo && !e.surveyPending && e.share !== false),   // answers go in the same file; share false = participant said no
  api(path, init = {}) {
    return fetch(`https://api.github.com/repos/${this.settings.repo}${path}`, {
      ...init, headers: { Authorization: `Bearer ${this.settings.token}`, Accept: 'application/vnd.github+json' },
    });
  },
  path: e => `sessions/${e.profileName.replace(/\W+/g, '_')}/${stamp(e.date)}_${e.source ?? 'unknown'}.json`,
  async put(e) {
    const file = JSONX.stringify({ schema: 1, app: 'web', participant: e.profileName, participantID: e.profileID, date: e.date,
      source: e.source ?? 'unknown', config: e.config, survey: e.survey ?? null, blocks: e.blocks, log: e.log ?? null });
    const r = await this.api(`/contents/${this.path(e)}`, {
      method: 'PUT', body: JSON.stringify({ message: `Session: ${e.profileName} ${e.date}`, content: base64(file) }),
    });
    if (!r.ok && r.status !== 422) throw new Error(`GitHub answered ${r.status}`);   // 422: the file is already there
  },
  async test() {
    if (!this.ready) return this.note('Fill in the repo (owner/name) and the token first.');
    this.note('Checking…');
    try {
      const r = await this.api('');
      this.note(r.ok ? 'Connected. The repo is reachable with this token.' : `GitHub answered ${r.status}: check the repo name and the token.`);
    } catch (err) { this.note(`No connection: ${err.message}`); }
  },
  /// Uploads every finished session not uploaded yet, oldest first.
  async pending() {
    if (this.busy || !this.ready) return;
    this.busy = true;
    const todo = this.waiting();
    let done = 0;
    try {
      for (const e of todo) {
        this.note(`Uploading ${done + 1} of ${todo.length}…`);
        await this.put(e);
        Store.markUploaded(e.id);
        done += 1;
      }
      this.note(todo.length ? `Uploaded ${done} session${done === 1 ? '' : 's'} to GitHub.` : 'Everything is uploaded.');
    } catch (err) {
      this.note(`Upload stopped after ${done} of ${todo.length} (${err.message}). The rest stay in this browser; retry from Researcher.`);
    } finally {
      this.busy = false;
      if (model.ui.tab === 'researcher' && !model.session) render();
    }
  },
  note(s) {
    this.status = s;
    document.querySelectorAll('.upload-status').forEach(n => { n.textContent = s; });
  },
};

function download(name, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = x => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${((Math.exp(x) - 1) * 100).toFixed(1)}%` : '–');
const num = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const sig = x => (Number.isFinite(x) ? String(+x.toPrecision(3)) : '–');
const stamp = iso => iso.replace(/[-:]/g, '').replace('T', '_').slice(0, 15);

// MARK: model

const params = new URLSearchParams(location.search);
const demoGame = params.get('demo');

const model = {
  profiles: (Store.load(KEYS.profiles, []) ?? []).map(UserProfile.fromJSON),
  config: { ...defaultSessionConfig(), ...Store.load(KEYS.config, {}) },
  ui: { tab: 'play', source: 'simulated', profileID: null, ...Store.load(KEYS.ui, {}) },
  session: null,
  lastTick: null,
  lastBlock: null,
  beatsSeen: 0,
  overlay: false,
  justSaved: null,
  polar: new PolarH10(),
  sim: null,
  timer: null,
  wakeLock: null,
  demo: !!demoGame,

  get profile() { return this.profiles.find(p => p.id === this.ui.profileID) ?? this.profiles[0]; },
  get actuator() { return this.session?.actuator ?? NEUTRAL_ACTUATOR; },

  persist() {
    Store.save(KEYS.profiles, this.profiles);
    if (!this.demo) { Store.save(KEYS.config, this.config); Store.save(KEYS.ui, this.ui); }   // demo timings are never saved
  },

  addProfile(name) {
    const p = new UserProfile(name);
    this.profiles.push(p);
    this.ui.profileID = p.id;
    this.persist();
  },

  /// `randomGoal`: a fair coin picks increase or decrease for this session only. Nothing on screen
  /// shows the result, so participant and researcher both stay blind until the questions are done.
  start({ randomGoal = false } = {}) {
    const profile = this.profile;
    if (!profile || !this.config.games.length) return;
    this.persist();
    const cfg = structuredClone(this.config);
    cfg.goalAssignment = randomGoal ? 'random' : 'manual';
    if (randomGoal) cfg.goal = crypto.getRandomValues(new Uint8Array(1))[0] < 128 ? 'increase' : 'decrease';
    const s = new LoopSession(cfg, profile);
    s.onBlockFinished = b => {
      this.lastBlock = b;
      Store.save(KEYS.profiles, this.profiles);   // persist learning after every block
    };
    this.session = s;
    this.beatsSeen = 0;
    this.lastTick = null;
    this.lastBlock = null;
    this.justSaved = null;
    let src;
    if (this.ui.source === 'polar') src = this.polar;
    else {
      src = this.sim = new SimulatedHeart();
      src.actuator = () => this.actuator;
    }
    src.onBeat = (rr, t) => { this.session?.addBeat(rr, t); this.beatsSeen += 1; };
    src.start();
    this.timer = setInterval(() => this.tick(), 1000);
    navigator.wakeLock?.request('screen').then(l => { this.wakeLock = l; }, () => {});
    render();
  },

  tick() {
    const s = this.session;
    if (!s) return;
    this.lastTick = s.tick(now());
    if (s.phase === 'done') this.stop();
    else updateSession();
  },

  stop() {
    clearInterval(this.timer); this.timer = null;
    this.sim?.stop(); this.sim = null;
    this.polar.onBeat = null;
    this.wakeLock?.release().catch(() => {}); this.wakeLock = null;
    const s = this.session;
    if (!s) return;
    const summary = s.finish();
    const profile = this.profile;
    Store.archive({ id: summary.date, profileID: profile.id, profileName: profile.name, date: summary.date,
                    source: this.ui.source, demo: this.demo || undefined, surveyPending: !this.demo || undefined,
                    config: s.config, blocks: s.blocks, log: s.log });
    this.justSaved = summary.date;
    this.persist();
    this.session = null;
    unmountGame();
    if (this.demo) this.ui.tab = 'results';
    else this.survey = { id: summary.date, answers: {} };
    render();
  },

  /// End-of-session questions answered (or skipped): store them with the session, then reveal the goal.
  finishSurvey(answers) {
    const id = this.survey.id;
    Store.updateEntry(id, { surveyPending: false, survey: { ...answers, at: new Date().toISOString() } });
    this.survey = null;
    this.reveal = { id, answers };
    render();
  },
  /// The participant's choice on the reveal screen; a session left without a choice can still be sent from Researcher.
  shareSession(send) {
    Store.updateEntry(this.reveal.id, { share: send });
    this.reveal = null;
    this.sentLast = send;
    render();
    if (send) Upload.pending();
  },

  /// Games call this for every reward opportunity (success / near miss / nothing).
  outcome(success, nearMiss = false) {
    this.sim?.reward(success ? this.actuator.juice : nearMiss ? 0.3 : 0);
  },
  /// Draw a covertly biased coin: true = favourable outcome for the player.
  luckyDraw() { return Math.random() < this.actuator.pSuccess; },
};
if (!model.profiles.length) model.profiles.push(new UserProfile('Participant 1'));
model.polar.addEventListener('change', () => { if (!model.session && model.ui.tab === 'play') renderPolarStatus(); });

// MARK: views

const app = document.getElementById('app');

function render() {
  if (model.session) { renderSession(); return; }
  if (model.survey) { renderSurvey(); return; }
  if (model.reveal) { renderReveal(); return; }
  const tabs = [['play', 'Play'], ['results', 'Results'], ['researcher', 'Researcher']];
  app.innerHTML = `
    <header class="appbar">
      <h1>Implicit Loop</h1>
      <nav>${tabs.map(([k, l]) => `<button data-tab="${k}" class="${model.ui.tab === k ? 'on' : ''}">${l}</button>`).join('')}</nav>
    </header>
    <main class="page">${{ play: playView, results: resultsView, researcher: researcherView }[model.ui.tab]()}</main>`;
  app.querySelector('nav').onclick = e => {
    const t = e.target.dataset.tab;
    if (t) { model.ui.tab = t; model.persist(); render(); }
  };
  ({ play: bindPlay, results: bindResults, researcher: bindResearcher })[model.ui.tab]();
}

// Play

function playView() {
  const c = model.config, p = model.profile;
  const len = `≈ ${Math.floor(sessionTotalS(c) / 60)} min: ${c.baselineS}s baseline + ${c.maxBlocks} blocks of ${c.blockS}s`;
  return `
    <section class="group"><h2>Participant</h2>
      <select id="profile" aria-label="Profile">${model.profiles.map(q => `<option value="${q.id}" ${q.id === p.id ? 'selected' : ''}>${esc(q.name)}</option>`).join('')}</select>
      <form id="add" class="row"><input id="newName" placeholder="New participant" autocomplete="off"><button>Add</button></form>
    </section>
    <section class="group"><h2>Goal</h2>
      <div class="seg" id="goal">
        <button data-v="increase" class="${c.goal === 'increase' ? 'on' : ''}">Increase HRV</button>
        <button data-v="decrease" class="${c.goal === 'decrease' ? 'on' : ''}">Decrease HRV</button>
      </div>
    </section>
    <section class="group"><h2>Games</h2>
      <div id="games">${GAME_KINDS.map(g => `<label class="toggle"><span>${GAMES[g].title}</span><input type="checkbox" value="${g}" ${c.games.includes(g) ? 'checked' : ''}></label>`).join('')}</div>
      <p class="foot">With several games selected, blocks are shared out by which game works best for this person.</p>
    </section>
    <section class="group"><h2>Heart signal</h2>
      <div class="seg" id="source">
        <button data-v="polar" class="${model.ui.source === 'polar' ? 'on' : ''}">Polar H10</button>
        <button data-v="simulated" class="${model.ui.source === 'simulated' ? 'on' : ''}">Simulated</button>
      </div>
      <div id="polar"></div>
    </section>
    <section class="group">
      <button id="start" class="primary">▶ Start session</button>
      <button id="startRandom">🎲 Start with a random goal</button>
      <p class="foot">The random goal ignores the Goal setting above, is drawn by a fair coin per session, and is shown after the end-of-session questions.</p>
      <p class="foot" id="startNote">${len}</p>
      ${model.justSaved ? `<p class="foot">Last session saved in this browser. Download its CSVs from Results ▸ Data.</p>` : ''}
      ${model.justSaved && model.sentLast ? `<p class="foot upload-status">${esc(Upload.status)}</p>` : ''}
    </section>`;
}

function renderPolarStatus() {
  const el = document.getElementById('polar');
  if (!el) return;
  const s = model.polar.state;
  const txt = {
    unsupported: 'This browser has no Web Bluetooth. Use Chrome or Edge.',
    idle: 'Not connected',
    scanning: 'Choose your strap in the browser dialog…',
    connecting: `Connecting ${esc(s.name ?? '')}…`,
    streaming: `<span class="heart">♥</span> ${esc(s.name ?? '')} · ${model.polar.heartRate} bpm`,
    failed: esc(s.error ?? 'connection failed'),
  }[s.kind];
  el.hidden = model.ui.source !== 'polar';
  el.innerHTML = `<div class="row status ${s.kind}"><span>${txt}</span>
    ${s.kind === 'unsupported' ? '' : s.kind === 'streaming'
      ? '<button id="polarOff">Disconnect</button>' : '<button id="polarOn">Connect</button>'}</div>`;
  el.querySelector('#polarOn')?.addEventListener('click', () => model.polar.connect());
  el.querySelector('#polarOff')?.addEventListener('click', () => model.polar.disconnect());
  const start = document.getElementById('start');
  if (start) {
    const needStrap = model.ui.source === 'polar' && !model.polar.connected;
    start.disabled = !model.config.games.length || needStrap;
    start.title = needStrap ? 'Connect the strap first' : '';
  }
}

function bindPlay() {
  const $ = id => document.getElementById(id);
  $('profile').onchange = e => { model.ui.profileID = e.target.value; model.persist(); };
  $('add').onsubmit = e => {
    e.preventDefault();
    const n = $('newName').value.trim();
    if (n) { model.addProfile(n); render(); }
  };
  $('goal').onclick = e => { const v = e.target.dataset.v; if (v) { model.config.goal = v; model.persist(); render(); } };
  $('games').onchange = () => {
    model.config.games = [...document.querySelectorAll('#games input:checked')].map(i => i.value);
    model.persist();
    renderPolarStatus();
  };
  $('source').onclick = e => { const v = e.target.dataset.v; if (v) { model.ui.source = v; model.persist(); render(); } };
  $('start').onclick = () => model.start();
  $('startRandom').onclick = () => model.start({ randomGoal: true });
  renderPolarStatus();
}

// End-of-session questions

/// Felt state, felt change and a goal guess, to compare with the measured HRV in the analysis.
/// Wording never names the goal; the guess maps "calm me down" → increase, "wind me up" → decrease.
const SURVEY = [
  { key: 'relaxed', text: 'How relaxed did you feel while playing?', lo: 'Very tense', hi: 'Very relaxed' },
  { key: 'calmer', text: 'How does your body feel now compared with before you started?', lo: 'Much more wound up', mid: 'No different', hi: 'Much calmer' },
  { key: 'guess', text: 'If the game was nudging you one way, which was it?',
    options: [['increase', 'Calm me down'], ['decrease', 'Wind me up'], ['unsure', "Couldn't tell"]] },
];

function renderSurvey() {
  const a = model.survey.answers, done = SURVEY.every(q => a[q.key] != null);
  app.innerHTML = `<main class="page survey">
    <h1>A few quick questions</h1>
    ${SURVEY.map((q, i) => `<section class="group" data-q="${q.key}"><h2>${i + 1} of ${SURVEY.length}</h2><p class="q">${q.text}</p>
      ${q.options
        ? `<div class="seg choice">${q.options.map(([v, l]) => `<button data-v="${v}" class="${a[q.key] === v ? 'on' : ''}">${l}</button>`).join('')}</div>`
        : `<div class="seg scale">${[1, 2, 3, 4, 5, 6, 7].map(v => `<button data-v="${v}" class="${a[q.key] === v ? 'on' : ''}">${v}</button>`).join('')}</div>
           <div class="ends"><span>${q.lo}</span>${q.mid ? `<span>${q.mid}</span>` : ''}<span>${q.hi}</span></div>`}
    </section>`).join('')}
    <button id="surveyDone" class="primary" ${done ? '' : 'disabled'}>Done</button>
    <p class="foot center"><button id="surveySkip" class="link">Skip the questions</button></p>
  </main>`;
  app.querySelectorAll('[data-q]').forEach(sec => {
    sec.onclick = e => {
      const v = e.target.closest('button')?.dataset.v;
      if (v == null) return;
      a[sec.dataset.q] = /^\d$/.test(v) ? +v : v;
      renderSurvey();
    };
  });
  document.getElementById('surveyDone').onclick = () => model.finishSurvey(a);
  document.getElementById('surveySkip').onclick = () => model.finishSurvey({ ...a, skipped: true });
}

/// After the questions: which way the session was pushing, then send or keep the data.
function renderReveal() {
  const { id, answers } = model.reveal;
  const e = Store.load(KEYS.archive, []).find(x => x.id === id);
  const goal = e?.config.goal, up = goal === 'increase';
  const guess = answers.skipped ? null : answers.guess;
  const verdict = !guess ? '' : guess === 'unsure' ? "You said you couldn't tell."
    : guess === goal ? 'You guessed right.' : `You guessed ${guess === 'increase' ? 'calm me down' : 'wind me up'}.`;
  app.innerHTML = `<main class="page survey reveal">
    <h1>This session</h1>
    <section class="group center">
      <p class="goal-label">The game was trying to</p>
      <p class="goal ${up ? 'up' : 'down'}">${up ? '▲ Increase HRV' : '▼ Decrease HRV'}</p>
      <p class="muted">${up ? 'Calm you down' : 'Wind you up'} · ${e?.config.goalAssignment === 'random' ? 'picked by a coin flip' : 'set in the Goal setting'}</p>
      ${verdict ? `<p class="q">${verdict}</p>` : ''}
    </section>
    <section class="group">
      <h2>Your data</h2>
      <p class="q">Send this session's data to the study?</p>
      <p class="foot">Heart rhythm (RR intervals), game events and your answers, under the participant name${Upload.ready ? '' : '. Uploading isn\'t set up in this browser yet, so it will be sent once a researcher sets it up'}.</p>
      <button id="shareYes" class="primary">Send data</button>
      <button id="shareNo">Don't send</button>
    </section>
  </main>`;
  document.getElementById('shareYes').onclick = () => model.shareSession(true);
  document.getElementById('shareNo').onclick = () => model.shareSession(false);
}

// Session

let mounted = null;   // { kind, game }

function unmountGame() { mounted?.game.destroy(); mounted = null; }

function renderSession() {
  app.innerHTML = `
    <div class="session">
      <header class="bar">
        <button id="end" class="icon" aria-label="End session">✕</button>
        <div id="progress" class="progress" title=""><div></div></div>
        <span id="round" class="round"></span>
      </header>
      <div class="stage"><div id="gameHost" class="game-host"></div><pre id="overlay" class="overlay" hidden></pre></div>
    </div>`;
  document.getElementById('end').onclick = () => { if (confirm('End the session? It will be saved.')) model.stop(); };
  // Long-press (or double-click) the progress bar to show/hide the researcher overlay.
  const bar = document.getElementById('progress');
  let pressTimer = 0;
  bar.onpointerdown = () => { pressTimer = setTimeout(toggleOverlay, 600); };
  bar.onpointerup = bar.onpointerleave = () => clearTimeout(pressTimer);
  bar.ondblclick = toggleOverlay;
  mounted = null;
  updateSession();
}

function toggleOverlay() { model.overlay = !model.overlay; updateSession(); }

function updateSession() {
  const s = model.session;
  if (!s) return;
  if (mounted?.kind !== s.game) {
    unmountGame();
    const host = document.getElementById('gameHost');
    mounted = {
      kind: s.game,
      game: mountGame(s.game, host, {
        lucky: () => model.luckyDraw(),
        interval: () => model.actuator.interval,
        juice: () => model.actuator.juice,
        outcome: (ok, near) => model.outcome(ok, near),
        sound: () => model.config.gameSound !== false,
      }),
    };
  }
  document.querySelector('#progress div').style.width = `${Math.min(1, s.elapsed / sessionTotalS(s.config)) * 100}%`;
  document.getElementById('round').textContent = s.phase === 'baseline' ? 'Warm-up' : `Round ${Math.max(1, s.blockNumber)}`;
  const ov = document.getElementById('overlay');
  ov.hidden = !model.overlay;
  if (model.overlay) {
    const t = model.lastTick ?? {}, a = model.actuator, p = s.params, b = model.lastBlock;
    const f = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : 'nan');
    const sgn = (x, d) => (x >= 0 ? '+' : '') + f(x, d);
    ov.textContent = [
      `${s.phase.toUpperCase()}  block ${s.blockNumber}  ${Math.floor(s.phaseElapsed)}/${s.phaseDuration}s  · ${GAMES[s.game].title}`,
      `RMSSD ${f(t.rmssd, 1)} (eval ${f(t.rmssdEval, 1)}) → target ${f(t.target, 1)} ms  HR ${f(t.hr, 0)}`,
      `u ${sgn(t.u ?? 0, 2)}  p ${f(a.pSuccess, 2)}  interval ${f(a.interval, 1)}s  juice ${f(a.juice, 2)}  beats ${model.beatsSeen}`,
      `window ${f(p.windowS, 0)}s  kp ${f(p.kp, 3)}  ki ${f(p.ki, 4)}  span ${f(p.rewardSpan, 2)}  bias ${sgn(p.rewardBias, 2)}  step ${f(p.setpointStep, 2)}`,
      b ? `last block ${b.index} (${b.phase}): score ${sgn(b.score, 3)}  obj ${sgn(b.objective, 3)}  ${b.valid ? 'valid' : 'INVALID'}` : '',
    ].filter(Boolean).join('\n');
  }
}

// Results

const GAME_COLORS = { solitaire: 'var(--c1)', blocks: 'var(--c2)', match3: 'var(--c3)', flyer: 'var(--c4)' };

function archiveFor(profile) { return Store.load(KEYS.archive, []).filter(e => e.profileID === profile.id); }

function timeline(log) {
  const spans = [];
  for (const r of log) {
    if (r.phase !== 'active' && r.phase !== 'sham') continue;
    const last = spans.at(-1);
    if (last && last.block === r.block) last.x1 = r.t / 60;
    else spans.push({ block: r.block, x0: r.t / 60, x1: r.t / 60, phase: r.phase });
  }
  const bands = spans.map(s => ({ ...s, color: s.phase === 'active' ? 'var(--band-active)' : 'var(--band-sham)' }));
  const xDomain = [0, (log.at(-1)?.t ?? 1) / 60];
  return `
    <p class="cap">RMSSD (ms) and target</p>
    ${lineChart({ height: 200, bands, xDomain, xLabel: 'min', label: 'RMSSD over the session', series: [
      { points: log.map(r => [r.t / 60, r.rmssdEval]), color: 'var(--c1)', gap: 0.05 },
      { points: log.map(r => [r.t / 60, r.target]), color: 'var(--c5)', kind: 'dot', r: 1.4 },
    ] })}
    <p class="cap">Hidden control u</p>
    ${lineChart({ height: 90, bands, xDomain, yDomain: [-1, 1], label: 'control signal', series: [
      { points: log.map(r => [r.t / 60, r.u]), color: 'var(--c3)' },
    ] })}
    ${legend([{ label: 'eval RMSSD', color: 'var(--c1)' }, { label: 'target', color: 'var(--c5)' },
              { label: 'active block', color: 'var(--band-active-solid)' }, { label: 'sham block', color: 'var(--band-sham-solid)' }])}`;
}

function blockChart(blocks) {
  const used = [...new Set(blocks.filter(b => b.phase !== 'sham').map(b => b.game))];
  return `
    <p class="cap">Block scores (HRV change toward goal, %)</p>
    ${barChart({ label: 'block scores', bars: blocks.map(b => ({
      label: b.index + 1, value: (Math.exp(b.score) - 1) * 100, faded: !b.valid,
      color: b.phase === 'sham' ? 'var(--sham)' : GAME_COLORS[b.game],
      title: `${b.phase} · ${GAMES[b.game].title} · ${pct(b.score)}${b.valid ? '' : ' (invalid)'}`,
    })) })}
    ${legend([...used.map(g => ({ label: GAMES[g].title, color: GAME_COLORS[g] })), { label: 'sham', color: 'var(--sham)' }])}`;
}

function learningChart(sessions) {
  const pts = sessions.map((s, i) => [i + 1, summarize(s)]);
  return `
    ${lineChart({ height: 180, xLabel: 'session', label: 'learning across sessions', series: [
      { points: pts.map(([i, m]) => [i, (Math.exp(m.meanActive) - 1) * 100]), color: 'var(--c1)', markers: true },
      { points: pts.map(([i, m]) => [i, (Math.exp(m.meanSham) - 1) * 100]), color: 'var(--sham)', markers: true, dash: true },
    ] })}
    ${legend([{ label: 'active', color: 'var(--c1)' }, { label: 'sham', color: 'var(--sham)' }])}`;
}

function tunerDetail(key, tuner) {
  const obs = tuner.observations, best = tuner.incumbent();
  const model_ = obs.length >= 2 ? obs.map((o, i) => [i + 1, tuner.predict(o.params)?.mean]) : [];
  return `<details class="tuner"><summary>${key} <span class="muted">${obs.length} evaluations</span></summary>
    ${obs.length ? lineChart({ height: 160, xLabel: 'block', label: `${key} evaluations`, series: [
      { points: obs.map((o, i) => [i + 1, o.objective]), color: 'var(--c1)', kind: 'dot', r: 3.5 },
      { points: model_, color: 'var(--c5)' },
    ] }) : ''}
    <p class="foot">Dots: measured objective per block. Line: the tuner's current estimate for those settings.</p>
    <table class="kv">${tuner.space && DIMS.map(d => `<tr><td>${d.name}${tuner.space.locked.includes(d.name) ? ' 🔒' : ''}</td><td>${sig(best[d.name])}</td></tr>`).join('')}</table>
  </details>`;
}

function resultsView() {
  const p = model.profile, last = p.sessions.at(-1), arch = archiveFor(p);
  let html = '';
  if (last) {
    const m = summarize(last), log = arch.find(e => e.date === last.date)?.log;
    html += `<section class="group"><h2>Last session · ${new Date(last.date).toLocaleString()} · ${last.goal} HRV</h2>
      <table class="summary">
        <tr><td>Active blocks</td><td>${pct(m.meanActive)}</td><td class="muted">n=${m.active.length}</td></tr>
        <tr><td>Sham blocks</td><td>${pct(m.meanSham)}</td><td class="muted">n=${m.sham.length}</td></tr>
        <tr class="strong"><td>Loop effect</td><td>${pct(m.effect)}</td><td class="muted">${Number.isFinite(m.cohensD) ? `d=${m.cohensD.toFixed(2)}` : ''}</td></tr>
      </table>
      <p class="foot">HRV change toward the goal within a block (second half vs. the 30 s before it). Loop effect = active − sham.</p>
      ${log?.length ? timeline(log) : ''}
      ${blockChart(last.blocks)}
    </section>`;
  } else {
    html += `<section class="group"><p class="muted">No sessions yet for ${esc(p.name)}.</p></section>`;
  }
  if (p.sessions.length > 1) html += `<section class="group"><h2>Across sessions</h2>${learningChart(p.sessions)}</section>`;
  const keys = Object.keys(p.tuners).sort();
  if (keys.length) html += `<section class="group"><h2>Tuner (per game × goal)</h2>${keys.map(k => tunerDetail(k, p.tuners[k])).join('')}</section>`;
  html += `<section class="group"><h2>Data</h2>
    ${arch.length ? `<table class="files">${arch.slice().reverse().map(e => `<tr><td>${new Date(e.date).toLocaleString()}</td><td>
      ${e.log ? `<button data-dl="ticks" data-id="${e.id}">ticks.csv</button>` : ''}
      <button data-dl="blocks" data-id="${e.id}">blocks.csv</button>
      <button data-dl="summary" data-id="${e.id}">summary.json</button>${e.uploaded ? ' <span class="muted" title="Uploaded to GitHub">☁︎</span>' : e.share === false ? ' <span class="muted" title="Participant chose not to send">not sent</span>' : ''}</td></tr>`).join('')}</table>` : '<p class="muted">Nothing saved yet.</p>'}
    <div class="row"><button id="exportAll">Export everything (JSON)</button></div>
    <p class="foot">Sessions are stored in this browser only. Download them to keep a copy. Clearing site data deletes them.</p>
  </section>`;
  return html;
}

function bindResults() {
  const p = model.profile;
  app.querySelector('.files')?.addEventListener('click', e => {
    const b = e.target.closest('[data-dl]');
    if (!b) return;
    const entry = archiveFor(p).find(x => x.id === b.dataset.id);
    const base = `${stamp(entry.date)}_${entry.profileName.replace(/\W+/g, '_')}`;
    if (b.dataset.dl === 'ticks') download(`${base}_ticks.csv`, CSV.ticks(entry.log));
    if (b.dataset.dl === 'blocks') download(`${base}_blocks.csv`, CSV.blocks(entry.blocks));
    if (b.dataset.dl === 'summary') {
      download(`${base}_summary.json`, JSONX.stringify({ date: entry.date, goal: entry.config.goal, survey: entry.survey ?? null, blocks: entry.blocks,
        config: entry.config }, 2), 'application/json');
    }
  });
  document.getElementById('exportAll').onclick = () => download(`implicit-loop_export_${stamp(new Date().toISOString())}.json`,
    JSONX.stringify({ profiles: model.profiles, config: model.config, archive: Store.load(KEYS.archive, []) }), 'application/json');
}

// Researcher

function researcherView() {
  const c = model.config;
  const stepper = (label, key, lo, hi, step, unit = '') =>
    `<label class="field"><span>${label}</span><span class="num"><input type="number" data-k="${key}" min="${lo}" max="${hi}" step="${step}" value="${c[key]}"><i>${unit}</i></span></label>`;
  return `
    <section class="group">
      <label class="toggle"><span>Auto-tune parameters</span><input type="checkbox" id="tuning" ${c.tuning ? 'checked' : ''}></label>
      <label class="toggle"><span>Game sounds</span><input type="checkbox" id="gameSound" ${c.gameSound !== false ? 'checked' : ''}></label>
      <label class="field"><span>Tuner maximises</span><select id="objective">
        <option value="outcome" ${c.objective === 'outcome' ? 'selected' : ''}>HRV change (practical)</option>
        <option value="contingency" ${c.objective === 'contingency' ? 'selected' : ''}>Active − sham (research)</option>
      </select></label>
      <p class="foot">“Active − sham” pairs every block with a yoked sham, so the tuner only rewards the part of the change caused by linking the game to physiology. It needs twice as many blocks.</p>
    </section>
    <section class="group"><h2>Timing</h2>
      ${stepper('Baseline', 'baselineS', 30, 300, 30, 's')}
      ${stepper('Block', 'blockS', 60, 600, 30, 's')}
      ${stepper('Washout', 'washoutS', 0, 120, 10, 's')}
      ${stepper('Blocks per session', 'maxBlocks', 2, 30, 1)}
      <label class="field ${c.objective === 'contingency' ? 'disabled' : ''}"><span>Sham every N blocks (0 = none)</span>
        <span class="num"><input type="number" data-k="shamEvery" min="0" max="10" step="1" value="${c.shamEvery}" ${c.objective === 'contingency' ? 'disabled' : ''}><i></i></span></label>
    </section>
    <section class="group"><h2>Tuned parameters</h2>
      <div id="dims">${DIMS.map(d => {
        const locked = c.space.locked.includes(d.name), v = c.space.fixed[d.name];
        return `<div class="dim">
          <label class="toggle"><span>${d.name}<small>${sig(d.lo)} – ${sig(d.hi)}</small></span>
            <input type="checkbox" data-dim="${d.name}" ${locked ? '' : 'checked'}></label>
          ${locked ? `<input type="range" data-fix="${d.name}" min="${d.lo}" max="${d.hi}" step="${(d.hi - d.lo) / 200}" value="${v}">
            <small class="muted" id="fx-${d.name}">fixed at ${sig(v)}</small>` : ''}</div>`;
      }).join('')}</div>
      <p class="foot">On = optimised per person. Off = held at the value set below it. Fewer free parameters means the tuner converges in fewer blocks.</p>
    </section>
    <section class="group"><h2>Upload to GitHub</h2>
      <label class="field"><span>Data repo</span><input id="upRepo" placeholder="owner/name" value="${esc(Upload.settings.repo)}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <label class="field"><span>Access token</span><input id="upToken" type="password" placeholder="github_pat_…" value="${esc(Upload.settings.token)}" autocomplete="off"></label>
      <div class="row"><button id="upTest">Test connection</button><button id="upNow" ${Upload.waiting().length ? '' : 'disabled'}>Upload ${Upload.waiting().length} waiting</button></div>
      <p class="foot upload-status">${esc(Upload.status)}</p>
      <p class="foot">After each session the participant chooses whether to send it. Each sent session goes to <code>sessions/&lt;participant&gt;/</code> in the repo as one JSON file, and the repo's analysis runs on it. The token stays in this browser and is never exported. Use a fine-grained token that can only write this one repo, and coded participant names.</p>
    </section>
    <section class="group">
      <div class="row"><button id="resetTuner" class="danger">Reset tuner for ${esc(model.profile.name)}</button></div>
      <p class="foot">Settings save automatically.</p>
    </section>`;
}

function bindResearcher() {
  const c = model.config, save = () => model.persist();
  document.getElementById('tuning').onchange = e => { c.tuning = e.target.checked; save(); };
  document.getElementById('gameSound').onchange = e => { c.gameSound = e.target.checked; save(); };
  document.getElementById('objective').onchange = e => { c.objective = e.target.value; save(); render(); };
  app.querySelectorAll('input[data-k]').forEach(i => {
    i.onchange = () => {
      const v = Math.min(+i.max, Math.max(+i.min, Math.round(+i.value / +i.step) * +i.step));
      if (Number.isFinite(v)) c[i.dataset.k] = v;
      i.value = c[i.dataset.k];
      save();
    };
  });
  document.getElementById('dims').onchange = e => {
    const d = e.target.dataset.dim;
    if (!d) return;
    c.space.locked = e.target.checked ? c.space.locked.filter(n => n !== d) : [...c.space.locked, d];
    save(); render();
  };
  document.getElementById('dims').oninput = e => {
    const d = e.target.dataset.fix;
    if (!d) return;
    c.space.fixed[d] = +e.target.value;
    document.getElementById(`fx-${d}`).textContent = `fixed at ${sig(+e.target.value)}`;
    save();
  };
  const up = Upload.settings;
  document.getElementById('upRepo').onchange = e => { up.repo = e.target.value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, ''); e.target.value = up.repo; Upload.save(); };
  document.getElementById('upToken').onchange = e => { up.token = e.target.value.trim(); Upload.save(); };
  document.getElementById('upTest').onclick = () => Upload.test();
  document.getElementById('upNow').onclick = () => Upload.pending();
  document.getElementById('resetTuner').onclick = () => {
    if (!confirm(`Forget everything the tuner has learned for ${model.profile.name}?`)) return;
    model.profile.tuners = {};
    save();
  };
}

// MARK: launch

model.ui.profileID ??= model.profiles[0].id;
// A page closed on the question screen: record the questions as missed so the session can still upload.
for (const e of Store.load(KEYS.archive, []).filter(x => x.surveyPending)) {
  Store.updateEntry(e.id, { surveyPending: false, survey: { missed: true } });
}
if (demoGame) {
  // ?demo=<game>: short simulated session that starts by itself (smoke tests; settings not saved).
  Object.assign(model.config, {
    games: [GAMES[demoGame] ? demoGame : 'blocks'], baselineS: 20, blockS: 30, washoutS: 5, maxBlocks: 4, shamEvery: 4, evalWindowS: 20,
  });
  model.ui.source = 'simulated';
  model.overlay = true;
  model.start();
} else {
  render();
}
addEventListener('beforeunload', e => { if (model.session) { e.preventDefault(); e.returnValue = ''; } });
