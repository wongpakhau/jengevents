import { describe, expect, it } from "vitest";
import {
  getReelFrame,
  STAGE_DURATION_MS,
} from "../client/src/lib/stage-sequence";
const digit = (position: number) => ((Math.round(position) % 10) + 10) % 10;

describe("plain three-reel sequence", () => {
  it("has only startup, rotation, slowing and result phases", () => {
    expect(getReelFrame(0).phase).toBe("charge");
    expect(getReelFrame(800).phase).toBe("spinning");
    expect(getReelFrame(4200).phase).toBe("settling");
    expect(getReelFrame(STAGE_DURATION_MS).phase).toBe("winner");
    expect(STAGE_DURATION_MS).toBe(7000);
  });
  it("moves only forward and never unlocks or restarts after a stop", () => {
    let previous = getReelFrame(0, "018");
    for (let time = 1; time <= STAGE_DURATION_MS; time += 1) {
      const frame = getReelFrame(time, "018");
      frame.positions.forEach((position, i) => {
        expect(position).toBeGreaterThanOrEqual(previous.positions[i]);
        if (previous.locked[i]) {
          expect(frame.locked[i]).toBe(true);
          expect(position).toBe(previous.positions[i]);
        }
      });
      previous = frame;
    }
  });
  it("stops once in order directly on each target digit", () => {
    expect(getReelFrame(5399, "407").locked).toEqual([false, false, false]);
    expect(getReelFrame(5400, "407").locked).toEqual([true, false, false]);
    expect(getReelFrame(6200, "407").locked).toEqual([true, true, false]);
    const final = getReelFrame(7000, "407");
    expect(final.locked).toEqual([true, true, true]);
    expect(final.positions.map(digit)).toEqual([4, 0, 7]);
  });
  it("keeps positions continuous at phase and stop boundaries", () => {
    for (const boundary of [800, 4200, 5400, 6200, 7000]) {
      const before = getReelFrame(boundary - 0.01, "290"),
        after = getReelFrame(boundary + 0.01, "290");
      before.positions.forEach((position, i) =>
        expect(Math.abs(position - after.positions[i])).toBeLessThan(0.001)
      );
    }
  });
  it("skips or completes on exactly the same final ticket, including zeroes and nines", () => {
    for (const target of ["000", "018", "999", "505"]) {
      const final = getReelFrame(STAGE_DURATION_MS, target);
      expect(final.positions.map(digit)).toEqual(target.split("").map(Number));
      expect(getReelFrame(Infinity, target)).toEqual(final);
      expect(getReelFrame(90000, target)).toEqual(final);
    }
  });
  it("clamps negative time and keeps progress in range", () => {
    expect(getReelFrame(-1)).toEqual(getReelFrame(0));
    expect(getReelFrame(-Infinity).progress).toBe(0);
    expect(getReelFrame(Infinity).progress).toBe(1);
  });
  it("rejects malformed targets and NaN elapsed time", () => {
    for (const target of ["", "12", "1234", "a18", "１２３", "018 "])
      expect(() => getReelFrame(0, target)).toThrow("targetTicket");
    expect(() => getReelFrame(NaN)).toThrow("NaN");
  });
});
