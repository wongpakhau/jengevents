export type StagePhase = "charge" | "spinning" | "settling" | "winner";
export type ReelFrame = {
  phase: StagePhase;
  positions: [number, number, number];
  locked: [boolean, boolean, boolean];
  progress: number;
};

export const STAGE_DURATION_MS = 7_000;
const REEL_STOP_TIMES = [5_400, 6_200, 7_000] as const;
const REEL_TURNS = [50, 60, 70] as const;

/** One-way rotation, one stop per reel. No reversal, false stop or replay branch. */
export function getReelFrame(
  elapsedMs: number,
  targetTicket = "018"
): ReelFrame {
  if (typeof targetTicket !== "string" || !/^[0-9]{3}$/.test(targetTicket)) {
    throw new TypeError("targetTicket must be exactly three ASCII digits");
  }
  if (typeof elapsedMs !== "number" || Number.isNaN(elapsedMs)) {
    throw new TypeError("elapsedMs must be a number and must not be NaN");
  }
  const elapsed = Math.min(STAGE_DURATION_MS, Math.max(0, elapsedMs));
  const digits = targetTicket.split("").map(Number);
  const positions = REEL_STOP_TIMES.map((stopTime, i) => {
    const destination = REEL_TURNS[i] + digits[i];
    const progress = Math.min(1, elapsed / stopTime);
    return progress === 1
      ? destination
      : (destination * (1 - Math.cos(Math.PI * progress))) / 2;
  }) as [number, number, number];
  return {
    phase:
      elapsed >= STAGE_DURATION_MS
        ? "winner"
        : elapsed < 800
          ? "charge"
          : elapsed < 4_200
            ? "spinning"
            : "settling",
    positions,
    locked: REEL_STOP_TIMES.map(stopTime => elapsed >= stopTime) as [
      boolean,
      boolean,
      boolean,
    ],
    progress: elapsed / STAGE_DURATION_MS,
  };
}
