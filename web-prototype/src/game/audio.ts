// Synthesised audio (no asset files): a city ambience bed, traffic that follows what is on
// screen (engine rumble, tyre hiss, passing cars, the odd horn), level-crossing bells, train
// horns and rail clatter, plus small UI sounds.

/** What the game hears, sampled a few times a second. Levels are 0..1. */
export interface SoundScene {
  /** on the game screen (not the menu) */
  active: boolean;
  running: boolean;
  /** how close the camera is (1 = street level, ~0.15 = whole map) */
  closeness: number;
  /** vehicles on screen, and how many of those are moving */
  visible: number;
  moving: number;
  /** vehicles on screen that have been stuck for a while */
  stuck: number;
  /** loudness of the nearest ringing crossing bell (0 when none) */
  bell: number;
  /** loudness of the nearest train */
  train: number;
  /** loudness for a train horn, when a train has just started approaching a crossing */
  horn: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambience: GainNode | null = null;
  private rumble: GainNode | null = null;
  private rumbleFilter: BiquadFilterNode | null = null;
  private hiss: GainNode | null = null;
  private trainBed: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private bellLevel = 0;
  private nextStrike = 0;
  private trainLevel = 0;
  private nextClack = 0;
  private lastHorn = -99;
  private lastTrainHorn = -99;
  private lastWhoosh = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  volume = 0.6;
  muted = false;

  /** Audio can only start after a user gesture. */
  private ensure() {
    if (this.ctx) return this.ctx;
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return null;
      const ctx = new Ctx();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(ctx.destination);

      // shared noise buffers (looped beds start at different offsets so they don't correlate)
      const len = ctx.sampleRate * 4;
      const white = ctx.createBuffer(1, len, ctx.sampleRate);
      const w = white.getChannelData(0);
      for (let i = 0; i < len; i++) w[i] = Math.random() * 2 - 1;
      this.noise = white;
      const brown = ctx.createBuffer(1, len, ctx.sampleRate);
      const b = brown.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        b[i] = last * 3.5;
      }
      const loop = (buf: AudioBuffer, ...chain: AudioNode[]) => {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        let node: AudioNode = src;
        for (const n of chain) node = node.connect(n);
        node.connect(this.master!);
        src.start(0, Math.random() * 3);
      };
      const filter = (type: BiquadFilterType, freq: number, q = 0.7) => {
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.value = freq;
        f.Q.value = q;
        return f;
      };
      const gain = () => {
        const g = ctx.createGain();
        g.gain.value = 0;
        return g;
      };

      // distant city: a soft, wide hum that is always there
      this.ambience = gain();
      loop(brown, filter('lowpass', 900), filter('highpass', 60), this.ambience);
      // traffic: engine rumble (brown noise) and tyre hiss (band-passed white noise)
      this.rumbleFilter = filter('lowpass', 500);
      this.rumble = gain();
      loop(brown, this.rumbleFilter, this.rumble);
      this.hiss = gain();
      loop(white, filter('bandpass', 1400, 0.5), filter('lowpass', 3500), this.hiss);
      // trains: deep rolling rumble
      this.trainBed = gain();
      loop(brown, filter('lowpass', 220), this.trainBed);

      // a small scheduler for rhythmic sounds (crossing bell, rail clatter)
      this.timer = setInterval(() => this.schedule(), 50);
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  resume() {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = this.muted ? 0 : v;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  /** Update the soundscape from what is happening on screen. */
  scene(s: SoundScene) {
    const ctx = this.ctx;
    if (!ctx || !this.ambience || !this.rumble || !this.rumbleFilter || !this.hiss || !this.trainBed) return;
    const t = ctx.currentTime;
    const live = s.active && s.running;
    const density = Math.min(1, s.visible / 40);
    const flow = Math.min(1, s.moving / 30);
    const near = s.closeness;
    this.ambience.gain.setTargetAtTime(s.active ? (s.running ? 0.07 : 0.04) : 0, t, 0.8);
    this.rumble.gain.setTargetAtTime(live ? 0.05 + 0.4 * density * (0.4 + 0.6 * near) : 0, t, 0.4);
    this.rumbleFilter.frequency.setTargetAtTime(250 + 900 * near, t, 0.5);
    this.hiss.gain.setTargetAtTime(live ? 0.09 * flow * near : 0, t, 0.4);
    this.trainLevel = live ? s.train : 0;
    this.trainBed.gain.setTargetAtTime(this.trainLevel * 0.5, t, 0.3);
    this.bellLevel = s.active ? s.bell : 0;
    if (!live || this.muted) return;

    // a car swishing past, when close enough to hear individual vehicles
    if (near > 0.45 && s.moving > 0 && t - this.lastWhoosh > rand(0.6, 2.5) / Math.min(1, 0.2 + flow)) {
      this.lastWhoosh = t;
      this.whoosh(0.1 + 0.15 * near);
    }
    // an impatient driver, now and then, when traffic is stuck
    if (s.stuck > 0 && t - this.lastHorn > 5 && Math.random() < Math.min(0.25, 0.04 * s.stuck)) {
      this.lastHorn = t;
      this.carHorn(0.05 + 0.08 * near);
    }
    if (s.horn > 0.05 && t - this.lastTrainHorn > 8) {
      this.lastTrainHorn = t;
      this.trainHorn(s.horn);
    }
  }

  /** Rhythmic sounds, scheduled slightly ahead so the timing stays steady. */
  private schedule() {
    const ctx = this.ctx;
    if (!ctx || this.muted || ctx.state !== 'running') return;
    const ahead = ctx.currentTime + 0.15;
    if (this.bellLevel > 0.02) {
      if (this.nextStrike < ctx.currentTime) this.nextStrike = ctx.currentTime + 0.02;
      // an electronic crossing bell: about two and a half strikes per second
      while (this.nextStrike < ahead) {
        this.bellStrike(this.nextStrike, this.bellLevel);
        this.nextStrike += 0.4;
      }
    }
    if (this.trainLevel > 0.05) {
      if (this.nextClack < ctx.currentTime) this.nextClack = ctx.currentTime + 0.02;
      // wheels over rail joints: pairs of clicks (the two axles of a bogie)
      while (this.nextClack < ahead) {
        this.clack(this.nextClack, this.trainLevel);
        this.clack(this.nextClack + 0.11, this.trainLevel * 0.85);
        this.nextClack += rand(0.55, 0.75);
      }
    }
  }

  private bellStrike(at: number, level: number) {
    const ctx = this.ctx!;
    // metallic, inharmonic partials with a fast attack and a short ring
    const f0 = 820;
    for (const [mult, amp, decay] of [
      [1, 1, 0.35],
      [2.32, 0.5, 0.22],
      [3.86, 0.3, 0.14],
      [5.4, 0.18, 0.09],
    ]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f0 * mult;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.16 * level * amp, at + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      o.connect(g).connect(this.master!);
      o.start(at);
      o.stop(at + decay + 0.05);
    }
  }

  private clack(at: number, level: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900;
    f.Q.value = 1.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.35 * level, at + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    src.connect(f).connect(g).connect(this.master!);
    src.start(at, Math.random() * 3, 0.1);
  }

  private whoosh(level: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const dur = rand(0.9, 1.6);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 0.9;
    // pitch falls as the car goes by (a hint of Doppler)
    f.frequency.setValueAtTime(rand(700, 1100), t);
    f.frequency.exponentialRampToValueAtTime(rand(250, 400), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + dur * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const pan = ctx.createStereoPanner();
    const side = Math.random() < 0.5 ? -1 : 1;
    pan.pan.setValueAtTime(side * 0.7, t);
    pan.pan.linearRampToValueAtTime(-side * 0.7, t + dur);
    src.connect(f).connect(g).connect(pan).connect(this.master!);
    src.start(t, Math.random() * 2, dur + 0.1);
  }

  /** A car horn: two slightly dissonant tones, one or two short beeps. */
  private carHorn(level: number) {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const beeps = Math.random() < 0.5 ? 1 : 2;
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.6, 0.6);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 2200;
    f.connect(pan).connect(this.master!);
    const base = rand(380, 460);
    for (let k = 0; k < beeps; k++) {
      const at = t0 + k * 0.28;
      const dur = beeps === 1 ? rand(0.3, 0.5) : 0.18;
      for (const fr of [base, base * 1.26]) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'square';
        o.frequency.value = fr;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(level, at + 0.015);
        g.gain.setValueAtTime(level, at + dur - 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        o.connect(g).connect(f);
        o.start(at);
        o.stop(at + dur + 0.02);
      }
    }
  }

  /** A train horn at a crossing: long, long, short, long, on a five-note chime. */
  private trainHorn(level: number) {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1600;
    f.connect(this.master!);
    const chord = [277, 330, 370, 415, 494];
    const pattern: [number, number][] = [
      [0, 1.1],
      [1.4, 1.1],
      [2.8, 0.45],
      [3.5, 1.8],
    ];
    for (const [start, dur] of pattern) {
      const at = t0 + start;
      for (const fr of chord) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sawtooth';
        // the pitch drops a touch as the train goes by
        o.frequency.setValueAtTime(fr, at);
        o.frequency.linearRampToValueAtTime(fr * 0.985, at + dur);
        const v = (0.05 * level) / chord.length;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(v, at + 0.06);
        g.gain.setValueAtTime(v, at + dur - 0.1);
        g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        o.connect(g).connect(f);
        o.start(at);
        o.stop(at + dur + 0.05);
      }
    }
  }

  private blip(freq: number, dur: number, type: OscillatorType = 'sine', gain = 0.12, slide = 0) {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), ctx.currentTime + dur);
    g.gain.value = gain;
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(ctx.currentTime + dur + 0.02);
  }

  click() {
    this.blip(880, 0.06, 'triangle', 0.06);
  }
  build() {
    this.blip(220, 0.12, 'square', 0.05, 120);
    setTimeout(() => this.blip(330, 0.1, 'square', 0.04), 70);
  }
  bulldoze() {
    this.blip(160, 0.25, 'sawtooth', 0.05, -100);
  }
  error() {
    this.blip(180, 0.15, 'square', 0.05, -60);
  }
  win() {
    [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.blip(f, 0.25, 'triangle', 0.08), i * 120));
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.ctx?.close();
    this.ctx = null;
  }
}

export const audio = new Audio();
