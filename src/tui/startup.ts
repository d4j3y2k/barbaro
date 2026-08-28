import { HORSE_FRAME_COUNT } from "./horse.js";

/** One complete riderless stride, beginning with F01 painted at time zero. */
export const STARTUP_STRIDE_TICKS = HORSE_FRAME_COUNT;

/** Resolve the shared hero/compact plate for a non-negative startup tick. */
export function startupFrameAtTick(tick: number): number {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new TypeError("tick must be a non-negative integer");
  }
  return tick % HORSE_FRAME_COUNT;
}

/** The title may hand off only after every plate has had one full beat. */
export function startupStrideComplete(ticksElapsed: number): boolean {
  if (!Number.isSafeInteger(ticksElapsed) || ticksElapsed < 0) {
    throw new TypeError("ticksElapsed must be a non-negative integer");
  }
  return ticksElapsed >= STARTUP_STRIDE_TICKS;
}
