type Cue = "start" | "lock" | "winner";

/** Short, locally synthesized UI cues. No recording, media download or autoplay. */
export class StageSound {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices = new Set<OscillatorNode>();
  private enabled = false;
  private activation = 0;

  async enable(): Promise<boolean> {
    const activation = ++this.activation;
    const Audio =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Audio) throw new Error("這個瀏覽器不支援音效。");
    if (!this.context || this.context.state === "closed") {
      this.context = new Audio();
      this.master = this.context.createGain();
      this.master.gain.value = 0;
      this.master.connect(this.context.destination);
    }
    const context = this.context;
    await context.resume();
    // A later mute, enable or disposal owns the current intent.
    if (activation !== this.activation || context !== this.context)
      return false;
    if (context.state !== "running")
      throw new Error("瀏覽器暫未允許播放音效；可繼續靜音預覽。");
    this.enabled = true;
    this.master!.gain.setValueAtTime(0.16, context.currentTime);
    return true;
  }

  mute(): void {
    this.activation += 1;
    this.enabled = false;
    this.stop();
    if (this.context && this.master)
      this.master.gain.setValueAtTime(0, this.context.currentTime);
  }

  private tone(
    frequency: number,
    length: number,
    delay = 0,
    volume = 0.3,
    type: OscillatorType = "sine"
  ): void {
    if (
      !this.enabled ||
      !this.context ||
      !this.master ||
      this.context.state !== "running"
    )
      return;
    const ctx = this.context;
    const start = ctx.currentTime + delay;
    const voice = ctx.createOscillator();
    const envelope = ctx.createGain();
    voice.type = type;
    voice.frequency.value = frequency;
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(volume, 0.001),
      start + 0.006
    );
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + length);
    voice.connect(envelope);
    envelope.connect(this.master);
    this.voices.add(voice);
    voice.onended = () => {
      this.voices.delete(voice);
      voice.disconnect();
      envelope.disconnect();
    };
    voice.start(start);
    voice.stop(start + length + 0.02);
  }

  tick(): void {
    this.tone(850, 0.023, 0, 0.12, "triangle");
  }
  cue(kind: Cue): void {
    if (kind === "start") {
      this.tone(220, 0.14, 0, 0.2);
      this.tone(440, 0.16, 0.09, 0.2);
    }
    if (kind === "lock") {
      this.tone(620, 0.085, 0, 0.3, "triangle");
      this.tone(930, 0.13, 0.035, 0.2);
    }
    if (kind === "winner")
      [523.25, 659.25, 783.99, 1046.5].forEach((note, i) =>
        this.tone(note, 0.4, i * 0.11, 0.22)
      );
  }

  stop(): void {
    for (const voice of this.voices) {
      try {
        voice.stop();
      } catch {
        /* Already ended. */
      }
    }
    this.voices.clear();
  }

  dispose(): void {
    this.mute();
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.master = null;
  }
}
