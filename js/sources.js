// Heart sources: anything that produces RR intervals (ms) with beat timestamps on `now()`'s clock.
import { NEUTRAL_ACTUATOR, SimParticipant, parseHeartRate } from './core.js';

export const now = () => performance.now() / 1000;

/// Polar H10 (or any standard BLE heart-rate strap) over Web Bluetooth (Chrome/Edge).
/// RR intervals arrive on characteristic 0x2A37 in 1/1024 s units, several per notification.
export class PolarH10 extends EventTarget {
  constructor() {
    super();
    this.name = 'Polar H10';
    this.onBeat = null;
    this.state = navigator.bluetooth ? { kind: 'idle' } : { kind: 'unsupported' };
    this.heartRate = 0;
    this.device = null;
    this.beatClock = null;
    this.wanted = false;
    this.handle = e => this.notified(e.target.value);
  }

  get connected() { return this.state.kind === 'streaming'; }

  setState(s) { this.state = s; this.dispatchEvent(new Event('change')); }

  /// Must be called from a user gesture (the browser shows its device chooser).
  async connect() {
    if (!navigator.bluetooth) return;
    this.wanted = true;
    try {
      if (!this.device) {
        this.setState({ kind: 'scanning' });
        this.device = await navigator.bluetooth.requestDevice({
          filters: [{ services: ['heart_rate'] }, { namePrefix: 'Polar' }],
          optionalServices: ['heart_rate'],
        });
        this.device.addEventListener('gattserverdisconnected', () => this.disconnected());
      }
      await this.open();
    } catch (e) {
      this.device = null;
      this.setState(e.name === 'NotFoundError' ? { kind: 'idle' } : { kind: 'failed', error: e.message });
    }
  }

  async open() {
    const name = this.device.name ?? 'HR strap';
    this.setState({ kind: 'connecting', name });
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService('heart_rate');
    const ch = await service.getCharacteristic('heart_rate_measurement');
    ch.removeEventListener('characteristicvaluechanged', this.handle);
    ch.addEventListener('characteristicvaluechanged', this.handle);
    await ch.startNotifications();
    this.setState({ kind: 'streaming', name });
  }

  disconnected() {
    this.beatClock = null;
    if (!this.wanted) { this.setState({ kind: 'idle' }); return; }
    // Auto-reconnect (no user gesture needed for an already chosen device).
    this.setState({ kind: 'connecting', name: this.device?.name ?? 'HR strap' });
    setTimeout(() => this.open().catch(() => this.disconnected()), 1000);
  }

  disconnect() {
    this.wanted = false;
    this.device?.gatt?.disconnect();
    this.beatClock = null;
    this.setState({ kind: 'idle' });
  }

  notified(view) {
    const { bpm, rr } = parseHeartRate(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    this.heartRate = bpm;
    const t0 = now();
    for (const x of rr) {
      // Beat times are reconstructed by accumulating RR; resync if they drift from wall time.
      let t = (this.beatClock ?? t0 - x / 1000) + x / 1000;
      if (Math.abs(t - t0) > 2.5) t = t0;
      this.beatClock = t;
      this.onBeat?.(x, t);
    }
    this.dispatchEvent(new Event('change'));
  }

  // HeartSource interface: the strap stays connected between sessions.
  start() {}
  stop() {}
}

/// Demo source: a simulated person who responds to the game's rewards, so the whole loop,
/// including the auto-tuner, can be tried without a strap.
export class SimulatedHeart {
  constructor(seed = Math.floor(Math.random() * 1e6)) {
    this.name = 'Simulated person';
    this.onBeat = null;
    this.person = SimParticipant.random(seed);
    this.pending = [];
    this.actuator = () => NEUTRAL_ACTUATOR;
    this.timer = null;
  }

  /// Games report outcomes; the simulated person "feels" them.
  reward(magnitude) { this.pending.push(magnitude); }

  start() {
    this.t0 = now() - this.person.t;
    this.lastStep = now();
    this.timer = setInterval(() => this.step(), 250);
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  step() {
    this.person.receive(this.pending, this.actuator());
    this.pending = [];
    // Advance by real elapsed time so beat timestamps never fall behind the wall clock.
    const t = now(), dt = t - this.lastStep;
    this.lastStep = t;
    for (const [bt, rr] of this.person.advance(dt)) this.onBeat?.(rr, this.t0 + bt);
  }
}
