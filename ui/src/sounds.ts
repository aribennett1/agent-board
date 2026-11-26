// Sound alerts for the board, all in the browser. Each bot gets a short synthesized motif (pure Web Audio, in the
// style of Eric's bubby-sounds.js: envelope, tone and noise helpers, every node passed through `track` so stop() can
// silence it) and then its name spoken with speechSynthesis. Motif plus name never run past TOTAL_MS.
import { BOARD_BOTS, type BoardBot } from "./raisedBy";

export const MUTE_KEY = "action-board:sound-muted";
export const MOTIF_MS = 700; // the motif is over by now; the name starts here
export const TOTAL_MS = 2000; // hard cap on motif plus spoken name
export const BOT_GAP_MS = 3000; // at most one sound per bot in this window

type Track = (...nodes: unknown[]) => void;
// The slice of Web Audio the synth touches, so tests can pass a mock.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Ctx = any;
export type Voice = (ctx: Ctx, out: Ctx, track: Track) => void;

const noiseBuffers = new WeakMap<object, unknown>();
function noiseBuffer(ctx: Ctx) {
  if (!noiseBuffers.has(ctx)) {
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, buffer);
  }
  return noiseBuffers.get(ctx);
}

function envelope(ctx: Ctx, out: Ctx, start: number, duration: number, peak: number, attack = 0.008) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  gain.connect(out);
  return gain;
}

type ToneOpts = { type?: string; freq: number; to?: number; start?: number; duration?: number; peak?: number; attack?: number; vibrato?: number; filter?: number };
function tone(ctx: Ctx, out: Ctx, track: Track, { type = "sine", freq, to, start = 0, duration = 0.3, peak = 0.1, attack, vibrato = 0, filter }: ToneOpts) {
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const gain = envelope(ctx, out, t, duration, peak, attack);
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + duration);
  let tail = gain;
  if (filter) {
    const biquad = ctx.createBiquadFilter();
    biquad.type = "lowpass";
    biquad.frequency.value = filter;
    biquad.connect(gain);
    tail = biquad;
  }
  osc.connect(tail);
  const extra: unknown[] = [gain];
  if (tail !== gain) extra.push(tail);
  if (vibrato) {
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = 14;
    depth.gain.value = freq * vibrato;
    lfo.connect(depth);
    depth.connect(osc.frequency);
    lfo.start(t);
    lfo.stop(t + duration + 0.05);
    track(lfo, depth);
  }
  osc.start(t);
  osc.stop(t + duration + 0.05);
  track(osc, ...extra);
}

type NoiseOpts = { start?: number; duration?: number; peak?: number; type?: string; freq?: number; to?: number; q?: number };
function noise(ctx: Ctx, out: Ctx, track: Track, { start = 0, duration = 0.3, peak = 0.2, type = "lowpass", freq = 1000, to, q = 1 }: NoiseOpts) {
  const t = ctx.currentTime + start;
  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const gain = envelope(ctx, out, t, duration, peak, 0.004);
  source.buffer = noiseBuffer(ctx);
  source.loop = true;
  filter.type = type;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(freq, t);
  if (to) filter.frequency.exponentialRampToValueAtTime(to, t + duration);
  source.connect(filter);
  filter.connect(gain);
  source.start(t);
  source.stop(t + duration + 0.05);
  track(source, filter, gain);
}

// D freygish, as in the kitchen: D Eb F# G A Bb C D.
const N = { D4: 293.66, Fs4: 369.99, A4: 440, C5: 523.25, D5: 587.33 };

// Every motif ends well inside MOTIF_MS.
export const MOTIFS: Record<BoardBot, Voice> = {
  // A quick, bright "good" double chime.
  QA: (ctx, out, track) => {
    for (const [start, freq] of [[0, 880], [0.13, 1318.5]] as const) {
      tone(ctx, out, track, { freq, start, duration: 0.3, peak: 0.1 });
      tone(ctx, out, track, { freq: freq * 2, start, duration: 0.16, peak: 0.025 });
    }
  },
  // Two wooden knocks and a metal clank.
  Engineer: (ctx, out, track) => {
    for (const start of [0, 0.12]) {
      tone(ctx, out, track, { type: "triangle", freq: 190, to: 80, start, duration: 0.1, peak: 0.3 });
      noise(ctx, out, track, { start, duration: 0.05, peak: 0.12, freq: 900 });
    }
    noise(ctx, out, track, { type: "bandpass", start: 0.26, duration: 0.3, peak: 0.1, freq: 2600, q: 6 });
    tone(ctx, out, track, { type: "square", freq: 640, start: 0.26, duration: 0.3, peak: 0.03, filter: 2000 });
  },
  // A rising arpeggio through the freygish mode.
  Planner: (ctx, out, track) => {
    [N.D4, N.Fs4, N.A4, N.C5, N.D5].forEach((freq, i) => tone(ctx, out, track, { type: "triangle", freq, start: i * 0.085, duration: 0.2, peak: 0.1 }));
  },
  // Three bubbly pops with a wobble.
  "dr eggbot": (ctx, out, track) => {
    [[0, 320, 900], [0.1, 420, 1200], [0.2, 260, 1500]].forEach(([start, freq, to]) => tone(ctx, out, track, { freq, to, start, duration: 0.09, peak: 0.12, vibrato: 0.06 }));
    tone(ctx, out, track, { freq: 1800, to: 700, start: 0.34, duration: 0.14, peak: 0.07 });
  },
  // One clear ding.
  "Grok Bot": (ctx, out, track) => {
    tone(ctx, out, track, { freq: 1568, duration: 0.6, peak: 0.1 });
    tone(ctx, out, track, { freq: 3136, duration: 0.3, peak: 0.03 });
  },
};

// How each bot's name sounds: a different pitch and rate each.
export const VOICES: Record<BoardBot, { say: string; pitch: number; rate: number }> = {
  QA: { say: "QA", pitch: 1.5, rate: 1.2 },
  Engineer: { say: "Engineer", pitch: 0.5, rate: 1.15 },
  Planner: { say: "Planner", pitch: 1.1, rate: 1.4 },
  "dr eggbot": { say: "Doctor Eggbot", pitch: 1.9, rate: 1.3 },
  "Grok Bot": { say: "Grok Bot", pitch: 0.85, rate: 1.4 },
};

export type SpeechLike = { speak: (u: any) => void; cancel: () => void };
export type PlayerDeps = {
  createContext?: () => Ctx | null;
  speech?: SpeechLike | null;
  makeUtterance?: (text: string) => any;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
};

export type SoundPlayer = ReturnType<typeof createSoundPlayer>;

export function createSoundPlayer(deps: PlayerDeps = {}) {
  const hasWin = typeof window !== "undefined";
  const createContext = deps.createContext ?? (() => {
    const C = hasWin ? ((window as any).AudioContext ?? (window as any).webkitAudioContext) : undefined;
    return C ? new C() : null;
  });
  const speech = deps.speech !== undefined ? deps.speech : hasWin && "speechSynthesis" in window ? (window.speechSynthesis as SpeechLike) : null;
  const makeUtterance = deps.makeUtterance ?? ((text: string) => new (window as any).SpeechSynthesisUtterance(text));
  const storage = deps.storage !== undefined ? deps.storage : hasWin ? window.localStorage : null;

  let ctx: Ctx | null = null;
  let master: Ctx | null = null;
  let muted = false;
  try { muted = storage?.getItem(MUTE_KEY) === "1"; } catch { /* storage blocked: stay unmuted */ }
  const listeners = new Set<() => void>();
  const lastAt = new Map<string, number>();
  const queue: BoardBot[] = [];
  const live = new Set<any>();
  let playing = false;
  let timers: ReturnType<typeof setTimeout>[] = [];
  let finishCurrent: (() => void) | null = null;
  let unlocked = false;

  const emit = () => { for (const fn of listeners) fn(); };
  const track: Track = (...nodes) => { for (const n of nodes) live.add(n); };

  function stopAudio() {
    for (const n of live) {
      try { n.stop?.(); } catch { /* already stopped */ }
      try { n.disconnect?.(); } catch { /* already gone */ }
    }
    live.clear();
  }
  function ensureCtx(): Ctx | null {
    if (!ctx) {
      try { ctx = createContext(); } catch { ctx = null; }
      if (ctx) {
        master = ctx.createGain();
        master.gain.value = 0.8;
        master.connect(ctx.destination);
      }
    }
    return ctx;
  }

  // Browsers block audio and speech until a user gesture, so the first click, tap or key unlocks both.
  function unlock() {
    const c = ensureCtx();
    try { void c?.resume?.(); } catch { /* ignore */ }
    if (!unlocked && speech) {
      try {
        const u = makeUtterance("");
        u.volume = 0;
        speech.speak(u);
      } catch { /* speech unavailable */ }
    }
    unlocked = true;
    emit();
  }

  function stopAll() {
    for (const t of timers) clearTimeout(t);
    timers = [];
    stopAudio();
    try { speech?.cancel(); } catch { /* ignore */ }
    finishCurrent = null;
    playing = false;
  }

  async function run(bot: BoardBot) {
    const c = ensureCtx();
    if (c && c.state === "suspended") {
      try { await c.resume(); } catch { /* still blocked */ }
    }
    if (!c || c.state !== "running") { playing = false; pump(); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      timers = [];
      stopAudio();
      try { speech?.cancel(); } catch { /* ignore */ }
      finishCurrent = null;
      playing = false;
      pump();
    };
    finishCurrent = finish;
    try { MOTIFS[bot](c, master, track); } catch { /* a broken motif still lets the name play */ }
    const voice = VOICES[bot];
    timers.push(setTimeout(() => {
      if (!speech) return finish();
      try {
        const u = makeUtterance(voice.say);
        u.pitch = voice.pitch;
        u.rate = voice.rate;
        u.onend = () => finish();
        u.onerror = () => finish();
        speech.speak(u);
      } catch { finish(); }
    }, MOTIF_MS));
    timers.push(setTimeout(finish, TOTAL_MS));
  }

  function pump() {
    if (playing) return;
    const bot = queue.shift();
    if (!bot) return;
    playing = true;
    void run(bot);
  }

  return {
    isMuted: () => muted,
    isUnlocked: () => unlocked,
    setMuted(next: boolean) {
      muted = next;
      try { storage?.setItem(MUTE_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      if (next) { queue.length = 0; stopAll(); }
      emit();
    },
    toggleMuted() { this.setMuted(!muted); },
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    unlock,
    /** Queue one bot's sound. Returns false when muted or when that bot already sounded in the last 3 seconds. */
    play(bot: BoardBot | undefined, opts: { force?: boolean } = {}): boolean {
      if (muted && !opts.force) return false;
      const who: BoardBot = bot && BOARD_BOTS.includes(bot) ? bot : "Grok Bot";
      const t = Date.now();
      const prev = lastAt.get(who);
      if (!opts.force && prev !== undefined && t - prev < BOT_GAP_MS) return false;
      lastAt.set(who, t);
      queue.push(who);
      pump();
      return true;
    },
    /** Every bot's sound, one after another, even when muted. Called from a click. */
    test() {
      unlock();
      for (const b of BOARD_BOTS) this.play(b, { force: true });
    },
    stop() { queue.length = 0; stopAll(); },
    /** Test hook. */
    _finish() { finishCurrent?.(); },
  };
}

let shared: SoundPlayer | null = null;
export function soundPlayer(): SoundPlayer {
  if (!shared) shared = createSoundPlayer();
  return shared;
}
/** Test hook: forget the shared player. */
export function resetSoundPlayer() { shared?.stop(); shared = null; }

export type TurnItem = { key: string; bot?: BoardBot };

/** Items in `now` whose key is not in `seen`. Pure: callers add them to `seen`. */
export function newTurnItems(seen: ReadonlySet<string>, now: TurnItem[]): TurnItem[] {
  const out: TurnItem[] = [];
  const dup = new Set<string>();
  for (const i of now) {
    if (seen.has(i.key) || dup.has(i.key)) continue;
    dup.add(i.key);
    out.push(i);
  }
  return out;
}
