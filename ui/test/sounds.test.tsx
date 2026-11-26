// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_GAP_MS, MOTIFS, MOTIF_MS, MUTE_KEY, TOTAL_MS, VOICES, createSoundPlayer, newTurnItems } from "../src/sounds";
import { BOARD_BOTS } from "../src/raisedBy";
import { SoundControl } from "../src/SoundControl";
import { useTurnSounds } from "../src/useTurnSounds";

// A Web Audio mock that records every node and the furthest time anything is scheduled to end.
function makeCtx(state = "running") {
  const nodes: { kind: string; stopped: boolean; started: number[]; stopAt: number[] }[] = [];
  let end = 0;
  const node = (kind: string, extra: object = {}) => {
    const n: any = { kind, stopped: false, started: [], stopAt: [], connect: vi.fn(), disconnect: vi.fn(), ...extra };
    n.start = (t: number) => n.started.push(t);
    n.stop = (t?: number) => { if (t === undefined) n.stopped = true; else { n.stopAt.push(t); end = Math.max(end, t); } };
    nodes.push(n);
    return n;
  };
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
  const ctx: any = {
    state,
    currentTime: 0,
    sampleRate: 100,
    destination: {},
    resume: vi.fn(async () => { ctx.state = "running"; }),
    createGain: () => node("gain", { gain: param() }),
    createOscillator: () => node("osc", { frequency: param(), type: "" }),
    createBiquadFilter: () => node("filter", { frequency: param(), Q: param(), type: "" }),
    createBuffer: (_c: number, len: number) => ({ getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => node("source", { buffer: null, loop: false }),
  };
  return { ctx, nodes, motifEnd: () => end };
}

function makeSpeech() {
  const spoken: { text: string; pitch?: number; rate?: number; onend?: () => void }[] = [];
  return {
    spoken,
    speech: { speak: vi.fn((u: any) => spoken.push(u)), cancel: vi.fn() },
    makeUtterance: (text: string) => ({ text }),
  };
}

function setup(opts: { storage?: Storage | null; state?: string } = {}) {
  const a = makeCtx(opts.state);
  const s = makeSpeech();
  const storage = opts.storage === undefined ? window.localStorage : opts.storage;
  const player = createSoundPlayer({ createContext: () => a.ctx, speech: s.speech, makeUtterance: s.makeUtterance, storage });
  return { player, ...a, ...s };
}

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("motifs", () => {
  it("every bot has a motif that ends inside the motif window and a distinct voice", () => {
    for (const bot of BOARD_BOTS) {
      const a = makeCtx();
      const out = a.ctx.createGain();
      MOTIFS[bot](a.ctx, out, () => undefined);
      expect(a.motifEnd(), bot).toBeGreaterThan(0);
      expect(a.motifEnd() * 1000, bot).toBeLessThanOrEqual(MOTIF_MS);
    }
    const voices = BOARD_BOTS.map((b) => `${VOICES[b].pitch}/${VOICES[b].rate}`);
    expect(new Set(voices).size).toBe(BOARD_BOTS.length);
    expect(MOTIF_MS).toBeLessThan(TOTAL_MS);
  });
});

describe("mute", () => {
  it("defaults to unmuted, saves the choice and restores it in a new player", () => {
    const { player } = setup();
    expect(player.isMuted()).toBe(false);
    player.toggleMuted();
    expect(window.localStorage.getItem(MUTE_KEY)).toBe("1");
    expect(setup().player.isMuted()).toBe(true);
    player.toggleMuted();
    expect(setup().player.isMuted()).toBe(false);
  });

  it("makes no sound while muted, and muting cuts off a sound that is playing", async () => {
    const { player, nodes, speech } = setup();
    player.setMuted(true);
    expect(player.play("QA")).toBe(false);
    await flush();
    expect(nodes.some((n) => n.kind === "osc")).toBe(false);
    player.setMuted(false);
    expect(player.play("QA")).toBe(true);
    await flush();
    expect(nodes.some((n) => n.kind === "osc" && !n.stopped)).toBe(true);
    player.setMuted(true);
    expect(nodes.filter((n) => n.kind === "osc").every((n) => n.stopped)).toBe(true);
    expect(speech.cancel).toHaveBeenCalled();
  });

  it("works when localStorage is unavailable", () => {
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const { player } = setup({ storage: bad as unknown as Storage });
    expect(player.isMuted()).toBe(false);
    player.toggleMuted();
    expect(player.isMuted()).toBe(true);
  });

  it("the speaker button toggles mute, and Test sounds plays every bot even when muted", async () => {
    const { player, spoken } = setup();
    render(<SoundControl player={player} />);
    const btn = screen.getByRole("button", { name: "Mute sounds" });
    fireEvent.click(btn);
    expect(player.isMuted()).toBe(true);
    expect(screen.getByRole("button", { name: "Unmute sounds" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Test sounds" }));
    for (let i = 0; i < BOARD_BOTS.length; i++) await advance(TOTAL_MS);
    // "" is the silent utterance that unlocks speech on the click.
    expect(spoken.map((s) => s.text)).toEqual(["", ...BOARD_BOTS.map((b) => VOICES[b].say)]);
  });
});

describe("queue", () => {
  it("plays sounds one at a time with the name after the motif, each within 2 seconds", async () => {
    const { player, spoken, nodes } = setup();
    player.play("QA");
    player.play("Engineer");
    player.play("Planner");
    await flush();
    const oscs = () => nodes.filter((n) => n.kind === "osc").length;
    const first = oscs();
    expect(first).toBeGreaterThan(0);
    expect(spoken).toHaveLength(0);
    await advance(MOTIF_MS);
    expect(spoken.map((s) => s.text)).toEqual(["QA"]);
    expect(spoken[0].pitch).toBe(VOICES.QA.pitch);
    expect(spoken[0].rate).toBe(VOICES.QA.rate);
    expect(oscs()).toBe(first); // the second motif has not started yet
    // The name never ends on its own here: the 2 second cap cuts it and the next sound starts.
    await advance(TOTAL_MS - MOTIF_MS);
    expect(oscs()).toBeGreaterThan(first);
    await advance(MOTIF_MS);
    expect(spoken.map((s) => s.text)).toEqual(["QA", "Engineer"]);
    await advance(TOTAL_MS);
    expect(spoken.map((s) => s.text)).toEqual(["QA", "Engineer", "Planner"]);
  });

  it("starts the next sound as soon as the name finishes", async () => {
    const { player, spoken, nodes } = setup();
    player.play("QA");
    player.play("Grok Bot");
    await advance(MOTIF_MS);
    const before = nodes.filter((n) => n.kind === "osc").length;
    spoken[0].onend?.();
    await flush();
    expect(nodes.filter((n) => n.kind === "osc").length).toBeGreaterThan(before);
  });

  it("plays at most one sound per bot every 3 seconds", async () => {
    const { player, spoken } = setup();
    expect(player.play("QA")).toBe(true);
    expect(player.play("QA")).toBe(false);
    await advance(BOT_GAP_MS - 1);
    expect(player.play("QA")).toBe(false);
    await advance(2);
    expect(player.play("QA")).toBe(true);
    await advance(TOTAL_MS * 2);
    expect(spoken.map((s) => s.text)).toEqual(["QA", "QA"]);
  });

  it("drops the sound when the browser keeps audio blocked", async () => {
    const { player, ctx, spoken } = setup({ state: "suspended" });
    ctx.resume = vi.fn(async () => undefined);
    player.play("QA");
    await advance(TOTAL_MS);
    expect(spoken).toHaveLength(0);
  });

  it("unlock creates the audio context and resumes it", () => {
    const { player, ctx } = setup({ state: "suspended" });
    player.unlock();
    expect(ctx.resume).toHaveBeenCalled();
    expect(player.isUnlocked()).toBe(true);
  });

  it("still ends on time without speech", async () => {
    const a = makeCtx();
    const player = createSoundPlayer({ createContext: () => a.ctx, speech: null, storage: null });
    player.play("QA");
    player.play("Planner", { force: true });
    await advance(MOTIF_MS * 3);
    expect(a.nodes.filter((n) => n.kind === "osc").length).toBeGreaterThan(8);
  });
});

describe("newTurnItems", () => {
  it("returns only unseen keys, once each", () => {
    const seen = new Set(["a"]);
    const items = newTurnItems(seen, [{ key: "a", bot: "QA" }, { key: "b", bot: "QA" }, { key: "b" }]);
    expect(items.map((i) => i.key)).toEqual(["b"]);
  });
});

describe("useTurnSounds", () => {
  function Probe({ items, ready }: { items: { key: string; bot?: any }[]; ready: boolean }) {
    useTurnSounds(items, ready, probePlayer);
    return null;
  }
  let probePlayer: any;
  beforeEach(() => {
    probePlayer = { play: vi.fn(() => true), unlock: vi.fn() };
  });

  it("stays quiet until live data lands, then only for items that are new after that", () => {
    const { rerender } = render(<Probe items={[{ key: "x", bot: "QA" }]} ready={false} />);
    rerender(<Probe items={[{ key: "x", bot: "QA" }, { key: "y", bot: "Planner" }]} ready={false} />);
    expect(probePlayer.play).not.toHaveBeenCalled();
    // First live data: everything on it is the baseline, even if the bundled snapshot lacked it.
    rerender(<Probe items={[{ key: "x", bot: "QA" }, { key: "y", bot: "Planner" }, { key: "z", bot: "Engineer" }]} ready={true} />);
    expect(probePlayer.play).not.toHaveBeenCalled();
    rerender(<Probe items={[{ key: "x", bot: "QA" }, { key: "y", bot: "Planner" }, { key: "z", bot: "Engineer" }]} ready={true} />);
    expect(probePlayer.play).not.toHaveBeenCalled();
    // A new open question appears.
    const next = [{ key: "x", bot: "QA" }, { key: "w", bot: "dr eggbot" }];
    rerender(<Probe items={next} ready={true} />);
    expect(probePlayer.play).toHaveBeenCalledTimes(1);
    expect(probePlayer.play).toHaveBeenCalledWith("dr eggbot");
    // An answered item goes away and comes back: already seen, so no sound.
    rerender(<Probe items={[{ key: "x", bot: "QA" }]} ready={true} />);
    rerender(<Probe items={next} ready={true} />);
    expect(probePlayer.play).toHaveBeenCalledTimes(1);
  });

  it("plays one sound per new item when several land at once", () => {
    const { rerender } = render(<Probe items={[]} ready={true} />);
    rerender(<Probe items={[{ key: "a", bot: "QA" }, { key: "b", bot: "Engineer" }]} ready={true} />);
    expect(probePlayer.play.mock.calls.map((c: any[]) => c[0])).toEqual(["QA", "Engineer"]);
  });

  it("unlocks audio on the first click", () => {
    render(<Probe items={[]} ready={true} />);
    fireEvent.click(document.body);
    expect(probePlayer.unlock).toHaveBeenCalledTimes(1);
    fireEvent.click(document.body);
    expect(probePlayer.unlock).toHaveBeenCalledTimes(1);
  });
});
