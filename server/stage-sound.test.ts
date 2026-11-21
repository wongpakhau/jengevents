import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StageSound } from "../client/src/lib/stage-sound";

function fakeGain() {
  return {
    gain: {
      value: 0,
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static deferred = false;
  state: "suspended" | "running" | "closed" = "suspended";
  currentTime = 1;
  destination = {};
  gains: ReturnType<typeof fakeGain>[] = [];
  oscillators: Array<{
    type: string;
    frequency: { value: number };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
  }> = [];
  resumes: Array<() => void> = [];
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createGain() {
    const gain = fakeGain();
    this.gains.push(gain);
    return gain;
  }
  createOscillator() {
    const oscillator = {
      type: "sine",
      frequency: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    };
    this.oscillators.push(oscillator);
    return oscillator;
  }
  resume = vi.fn(() => {
    if (FakeAudioContext.deferred)
      return new Promise<void>(resolve =>
        this.resumes.push(() => {
          if (this.state !== "closed") this.state = "running";
          resolve();
        })
      );
    this.state = "running";
    return Promise.resolve();
  });
  close = vi.fn(() => {
    this.state = "closed";
    return Promise.resolve();
  });
}

beforeEach(() => {
  FakeAudioContext.instances = [];
  FakeAudioContext.deferred = false;
  vi.stubGlobal("window", { AudioContext: FakeAudioContext });
});
afterEach(() => vi.unstubAllGlobals());

describe("StageSound", () => {
  it("does not construct audio or play cues before manual enable", () => {
    const sound = new StageSound();
    sound.tick();
    sound.cue("winner");
    expect(FakeAudioContext.instances).toHaveLength(0);
  });
  it("manual enable starts no cues automatically and explicit cues use bounded envelopes", async () => {
    const sound = new StageSound();
    expect(await sound.enable()).toBe(true);
    const context = FakeAudioContext.instances[0];
    expect(context.oscillators).toHaveLength(0);
    sound.tick();
    expect(context.oscillators).toHaveLength(1);
    expect(context.oscillators[0].start).toHaveBeenCalledWith(1);
    expect(context.oscillators[0].stop).toHaveBeenCalledWith(1.043);
    sound.dispose();
  });
  it("mute immediately cancels active and scheduled voices and blocks new cues", async () => {
    const sound = new StageSound();
    await sound.enable();
    sound.cue("winner");
    const context = FakeAudioContext.instances[0];
    expect(context.oscillators).toHaveLength(4);
    sound.mute();
    expect(context.gains[0].gain.setValueAtTime).toHaveBeenLastCalledWith(0, 1);
    for (const oscillator of context.oscillators)
      expect(oscillator.stop).toHaveBeenLastCalledWith();
    sound.cue("start");
    expect(context.oscillators).toHaveLength(4);
    sound.dispose();
  });
  it("a delayed enable cannot undo a newer mute", async () => {
    FakeAudioContext.deferred = true;
    const sound = new StageSound();
    const pending = sound.enable();
    const context = FakeAudioContext.instances[0];
    sound.mute();
    context.resumes[0]();
    expect(await pending).toBe(false);
    sound.tick();
    expect(context.oscillators).toHaveLength(0);
    sound.dispose();
  });
  it("a superseded enable does not cancel a later successful enable", async () => {
    FakeAudioContext.deferred = true;
    const sound = new StageSound();
    const first = sound.enable();
    const context = FakeAudioContext.instances[0];
    sound.mute();
    const second = sound.enable();
    context.resumes[1]();
    expect(await second).toBe(true);
    context.resumes[0]();
    expect(await first).toBe(false);
    sound.tick();
    expect(context.oscillators).toHaveLength(1);
    sound.dispose();
  });
  it("dispose cancels delayed enable, closes the context and leaves no voices", async () => {
    FakeAudioContext.deferred = true;
    const sound = new StageSound();
    const pending = sound.enable();
    const context = FakeAudioContext.instances[0];
    sound.dispose();
    context.resumes[0]();
    expect(await pending).toBe(false);
    expect(context.close).toHaveBeenCalledOnce();
    sound.cue("winner");
    expect(context.oscillators).toHaveLength(0);
  });
  it("reports unavailable audio without making it a requirement to view the stage", async () => {
    vi.stubGlobal("window", {});
    await expect(new StageSound().enable()).rejects.toThrow(
      "這個瀏覽器不支援音效。"
    );
  });
});
