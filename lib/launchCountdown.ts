/**
 * The GLOA launch countdown, as arithmetic (Frontend Phase 1).
 *
 * Pure and leaf: no relative imports, no React, no DOM, no timer and NO
 * CLOCK OF ITS OWN - every function takes `now` as an argument. That is
 * what lets the boundary cases be tested to the millisecond instead of
 * being hoped for, and it is the same shape lib/orderStatus.ts uses for
 * order state.
 *
 * ── THE ONE FACT THIS FILE INTRODUCES ─────────────────────────
 *
 * The launch instant, and nothing else. No price, no stock, no promise
 * about what happens at launch and no claim about the product.
 */

/**
 * 1 October 2026, midnight in Berlin.
 *
 * Written with the explicit +02:00 offset rather than as a local-time
 * string: Berlin is on CEST at the start of October, and a bare
 * "2026-10-01T00:00:00" would mean midnight in whatever timezone the
 * VIEWER happens to be in - so a customer in New York would see the
 * countdown end six hours late. The offset makes it one instant in time
 * for everybody.
 */
export const GLOA_LAUNCH_ISO = "2026-10-01T00:00:00+02:00";

/** The same instant in epoch milliseconds. Parsed once, never re-derived. */
export const GLOA_LAUNCH_MS = Date.parse(GLOA_LAUNCH_ISO);

/** The date as the page prints it. Display only. */
export const GLOA_LAUNCH_LABEL = "01.10.2026";

export type LaunchCountdown = {
  /** True once the launch instant has been reached or passed. */
  launched: boolean;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Two digits, so a ticking value never changes the layout's width. */
export function padCountdownUnit(value: number): string {
  return String(Math.max(0, Math.trunc(value))).padStart(2, "0");
}

/**
 * How long is left, from a given instant.
 *
 * ── IT NEVER GOES NEGATIVE ────────────────────────────────────
 *
 * At and after the launch instant every unit is zero and `launched` is
 * true. A countdown that renders "-1 DAYS" is worse than no countdown,
 * and a timer that keeps running past its own target is a bug the
 * customer sees. The clamp is here, in one place, rather than in the
 * component.
 *
 * An unusable `now` - NaN, an unparsable date - is treated as NOT
 * launched with zeroes rather than as launched: announcing a launch that
 * has not happened is the worse direction to guess in.
 */
export function launchCountdown(now: Date | number, launchMs: number = GLOA_LAUNCH_MS): LaunchCountdown {
  const nowMs = now instanceof Date ? now.getTime() : now;

  if (!Number.isFinite(nowMs) || !Number.isFinite(launchMs)) {
    return { launched: false, days: 0, hours: 0, minutes: 0, seconds: 0 };
  }

  const remaining = launchMs - nowMs;
  if (remaining <= 0) {
    return { launched: true, days: 0, hours: 0, minutes: 0, seconds: 0 };
  }

  return {
    launched: false,
    days: Math.floor(remaining / DAY),
    hours: Math.floor((remaining % DAY) / HOUR),
    minutes: Math.floor((remaining % HOUR) / MINUTE),
    seconds: Math.floor((remaining % MINUTE) / SECOND),
  };
}
