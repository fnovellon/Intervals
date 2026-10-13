import type { LapRecord } from "../fit/types";
import type { DetectOptions } from "./model";
import { refineBoundary } from "./signal";
import { clamp, distanceAt, median, pausedSeconds, type Series } from "./timeseries";

/** The half-Cooper test: run as far as possible in six minutes. */
export const COOPER_S = 360;

export interface CooperTest {
  /** The six minutes, in seconds since the start of the recording. */
  start: number;
  end: number;
  /** Metres covered in exactly those six minutes. */
  distance: number;
  /** Mean speed over the test, m/s. */
  speed: number;
  /** Estimated maximal aerobic speed, km/h: the distance in metres divided by 100. */
  vma: number;
  /** Pace at that speed, seconds per km. */
  vmaPace: number;
  /** Rough VO2max, ml/kg/min (3.5 x VMA). */
  vo2max: number;
  /** Metres run in each of the six minutes. */
  splits: number[];
  /** First-half speed minus second-half speed, as a share of the first (positive = slowed down). */
  fadePct: number;
  avgHr?: number;
  maxHr?: number;
  /** Altitude at the end minus altitude at the start, metres (undefined without altitude). */
  netClimb?: number;
  /** The watch recorded a lap of 6:00 that fixes the start. */
  fromLap: boolean;
}

/** The test's numbers for a six-minute window that starts at `start`. */
export function measureCooper(series: Series, start: number, fromLap = false): CooperTest {
  const s = clamp(start, 0, Math.max(0, series.n - 1 - COOPER_S));
  const e = s + COOPER_S;
  const distance = distanceAt(series, e) - distanceAt(series, s);
  const splits = Array.from({ length: 6 }, (_, i) => distanceAt(series, s + 60 * (i + 1)) - distanceAt(series, s + 60 * i));
  const first = splits[0] + splits[1] + splits[2];
  const last = splits[3] + splits[4] + splits[5];
  const vma = distance / 100;
  const test: CooperTest = {
    start: s,
    end: e,
    distance,
    speed: distance / COOPER_S,
    vma,
    vmaPace: vma > 0 ? 3600 / vma : NaN,
    vo2max: 3.5 * vma,
    splits,
    fadePct: first > 0 ? ((first - last) / first) * 100 : 0,
    fromLap,
  };
  if (series.hasHr) {
    let sum = 0;
    let count = 0;
    let max = 0;
    for (let i = Math.ceil(s); i < Math.ceil(e) && i < series.n; i++) {
      const hr = series.hr[i];
      if (!Number.isFinite(hr)) continue;
      sum += hr;
      count++;
      max = Math.max(max, hr);
    }
    if (count) {
      test.avgHr = sum / count;
      test.maxHr = max;
    }
  }
  if (series.hasAltitude) {
    const a = series.altitude[Math.round(s)];
    const b = series.altitude[Math.min(series.n - 1, Math.round(e))];
    if (Number.isFinite(a) && Number.isFinite(b)) test.netClimb = b - a;
  }
  return test;
}

// ---- detection thresholds -------------------------------------------------------------------------------
/** The test must be this much faster than the warm-up and the cool-down around it. */
const JUMP = 1.2;
/** Slowest plausible test: 2.2 m/s is 7:34 per km. */
const MIN_SPEED = 2.2;
/** Seconds of data needed before the test (a warm-up) and after it for the end of the effort to be seen. */
const MIN_BEFORE_S = 60;
const MIN_AFTER_S = 30;
/** Just before the six minutes the athlete must still have been slow. */
const BEFORE_MAX = 0.8;
/** Each minute must stay within this band around the mean minute. */
const MINUTE_MIN = 0.72;
const MINUTE_MAX = 1.25;
/** First half against second half. */
const HALVES_MAX = 0.15;
/** Seconds the rest of the session may spend at the test's pace before it is an interval session, not a test. */
const OTHER_HARD_S = 90;
const OTHER_HARD_SHARE = 0.92;
/** A lap this close to six minutes is taken as the watch's own record of the test. */
const LAP_TOLERANCE_S = 5;
/** The hard effort, measured edge to edge, must last about six minutes. */
const EXTENT_MIN_S = 340;
const EXTENT_MAX_S = 400;
/** When the recording stops soon after the test, the start of the effort must sit at the start of the window. */
const START_MATCH_S = 25;

/**
 * Find a half-Cooper test (six minutes flat out) in a session.
 *
 * 1. The candidate is the fastest six-minute stretch of the recording that has no stop in it.
 * 2. It must stand out: clearly faster than the warm-up before it and the cool-down after it.
 * 3. Its end is located like the end of any interval (the pace drops when the watch beeps at 6:00) and the
 *    test is the six minutes before it. A lap of 6:00 recorded by the watch fixes the start instead.
 * 4. It must look like one continuous effort: slow just before, no minute far off the others, no collapse.
 * 5. It must be the only one: if the rest of the session spends much time at that pace, it is an interval
 *    session or a race, not a test.
 */
export function detectCooper(series: Series, laps: LapRecord[], opts: DetectOptions): CooperTest | null {
  const n = series.n;
  if (n < MIN_BEFORE_S + COOPER_S) return null;

  // 1. fastest six minutes without a stop
  let best = -1;
  let bestDistance = 0;
  for (let t = 0; t + COOPER_S < n; t++) {
    if (pausedSeconds(series, t, t + COOPER_S) > 5) continue;
    const d = series.dist[t + COOPER_S] - series.dist[t];
    if (d > bestDistance) {
      bestDistance = d;
      best = t;
    }
  }
  const speed = bestDistance / COOPER_S;
  if (best < MIN_BEFORE_S || speed < MIN_SPEED) return null;

  // 2. it stands out from what surrounds it
  const level = (a: number, b: number) => {
    const lo = Math.max(0, Math.round(a));
    const hi = Math.min(n, Math.round(b));
    return hi - lo >= 20 ? median(series.speed.subarray(lo, hi)) : NaN;
  };
  const before = level(best - 180, best - 15);
  const after = level(best + COOPER_S + 15, best + COOPER_S + 180);
  if (!Number.isFinite(before)) return null;
  const around = Math.max(before, Number.isFinite(after) ? after : 0);
  if (speed < JUMP * around) return null;

  // 3. where the six minutes are
  let start = best;
  let fromLap = false;
  const hasEnd = n - (best + COOPER_S) >= MIN_AFTER_S;
  if (hasEnd) {
    const end = refineBoundary(series.speed, best + COOPER_S, best + 150, best + COOPER_S + 150, 15, 3, opts);
    start = end - COOPER_S;
  }
  const lap = laps.find((l) => Math.abs(l.end - l.start - COOPER_S) <= LAP_TOLERANCE_S && Math.abs(l.start - start) <= 15);
  if (lap) {
    start = lap.start;
    fromLap = true;
  }
  if (start < 20 || start + COOPER_S > n - 1) return null;
  const end = start + COOPER_S;

  // 4. one continuous, even effort that lasts about six minutes and began when the six minutes began
  const mid = (around + speed) / 2;
  const pace5 = (i: number) => (series.dist[Math.min(n - 1, i + 3)] - series.dist[Math.max(0, i - 2)]) / 5;
  const centre = Math.round(best + COOPER_S / 2);
  let startEdge = centre;
  while (startEdge > 5 && pace5(startEdge) >= mid) startEdge--;
  let endEdge = centre;
  while (endEdge < n - 6 && pace5(endEdge) >= mid) endEdge++;
  if (endEdge < n - 6) {
    const extent = endEdge - startEdge;
    if (extent < EXTENT_MIN_S || extent > EXTENT_MAX_S) return null;
  } else if (Math.abs(startEdge - start) > START_MATCH_S) {
    return null;
  }
  if (pausedSeconds(series, start, end) > 5) return null;
  const test = measureCooper(series, start, fromLap);
  if (test.speed < MIN_SPEED || test.speed < JUMP * around * 0.97) return null;
  const mean = test.distance / 6;
  if (Math.min(...test.splits) < MINUTE_MIN * mean || Math.max(...test.splits) > MINUTE_MAX * mean) return null;
  if (Math.abs(test.fadePct) > HALVES_MAX * 100) return null;
  const lead = level(start - 30, start - 6);
  if (Number.isFinite(lead) && lead > BEFORE_MAX * test.speed) return null;

  // 5. nothing else in the session at that pace
  let other = 0;
  for (let i = 0; i + 30 < n; i++) {
    if (i + 30 > start - 30 && i < end + 30) continue;
    if ((series.dist[i + 30] - series.dist[i]) / 30 >= OTHER_HARD_SHARE * test.speed) other++;
  }
  if (other > OTHER_HARD_S) return null;

  return test;
}
