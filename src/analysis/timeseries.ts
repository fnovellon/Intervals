import type { Activity, RecordPoint, TimeRange } from "../fit/types";
import { AppError, msg, type Msg } from "../i18n";
import type { PaceBasis } from "./model";

/**
 * Uniform 1 Hz view of an activity. Index i corresponds to t = i seconds on the
 * wall-clock axis, so pauses stay visible as zero-speed stretches (a standing
 * rest with auto-pause becomes a genuine rest segment instead of a time jump).
 */
export interface Series {
  n: number;
  /** Cumulative distance in metres. */
  dist: Float64Array;
  /** Cleaned speed in m/s. */
  speed: Float64Array;
  /** Grade-adjusted ("flat equivalent") speed in m/s. Equals speed without altitude. */
  gapSpeed: Float64Array;
  /**
   * Speed implied by the distance curve (5 s window), m/s. Needs no lag compensation: the distance
   * curve is the reference the device speed is aligned to. Equals `speed` when the file has no speed.
   */
  distSpeed: Float64Array;
  /** Smoothed grade as a fraction (0.05 = 5 %). */
  grade: Float64Array;
  /** Smoothed altitude in metres (NaN when unavailable). */
  altitude: Float64Array;
  hr: Float64Array;
  cadence: Float64Array;
  power: Float64Array;
  /** 1 where the timer was stopped. */
  paused: Uint8Array;
  /** Prefix sum of `paused`, length n + 1. */
  pausedCum: Float64Array;
  hasHr: boolean;
  hasCadence: boolean;
  hasPower: boolean;
  hasAltitude: boolean;
  /** True when speed came from the device, false when derived from distance. */
  speedFromDevice: boolean;
  /** Seconds the device speed lags the distance curve (already compensated in `speed`). */
  speedLag: number;
  /**
   * Device speed divided by the speed implied by the distance curve, over moving samples.
   * 1 means the two agree; 0.9 means the watch's speed reads 10 % lower than its own distance.
   */
  speedRatio: number;
  notes: Msg[];
}

/** Gaps longer than this with no timer event are treated as pauses; shorter ones are smart-recording gaps. */
const IMPLICIT_PAUSE_GAP_S = 30;
/** Gap above which we start asking whether it overlaps an explicit timer pause. */
const GAP_CHECK_S = 2.5;

/** Altitude / grade smoothing: enough to tame a 0.2 m barometer, short enough not to blur the start of a hill. */
const GRADE_ALT_SMOOTH_S = 7;
const GRADE_HALF_SPAN_S = 6;
const GRADE_SMOOTH_S = 5;
const MIN_GRADE_SPAN_M = 15;

const MAX_SPEED: Record<string, number> = { running: 11, walking: 4, hiking: 5, cycling: 30 };

export function buildSeries(activity: Activity): Series {
  const notes: Msg[] = [];
  const recs = activity.records;
  const n = Math.max(2, Math.floor(recs[recs.length - 1].t) + 1);
  const grid = (): Float64Array => new Float64Array(n).fill(NaN);

  // ---- pause detection ------------------------------------------------------
  const paused = new Uint8Array(n);
  const holdDistance: Array<[number, number]> = [];
  const gaps: Array<[number, number]> = []; // [first record index, second record index]
  for (let k = 1; k < recs.length; k++) {
    const dt = recs[k].t - recs[k - 1].t;
    if (dt > GAP_CHECK_S) gaps.push([k - 1, k]);
  }
  for (const [ia, ib] of gaps) {
    const a = recs[ia].t;
    const b = recs[ib].t;
    const overlap = activity.pauses.reduce((s, p) => s + Math.max(0, Math.min(b, p.end) - Math.max(a, p.start)), 0);
    const isPause = overlap >= 0.5 * (b - a) || b - a > IMPLICIT_PAUSE_GAP_S;
    if (!isPause) continue;
    for (let i = Math.floor(a) + 1; i < b && i < n; i++) paused[i] = 1;
    holdDistance.push([ia, ib]);
  }

  // ---- channel interpolation ------------------------------------------------
  const interpChannel = (pick: (r: RecordPoint) => number | undefined, maxExtend = 10): Float64Array => {
    const ts: number[] = [];
    const vs: number[] = [];
    for (const r of recs) {
      const v = pick(r);
      if (v !== undefined && Number.isFinite(v)) {
        ts.push(r.t);
        vs.push(v);
      }
    }
    const out = grid();
    if (ts.length === 0) return out;
    let j = 0;
    for (let i = 0; i < n; i++) {
      while (j + 1 < ts.length && ts[j + 1] <= i) j++;
      if (i < ts[0]) {
        if (ts[0] - i <= maxExtend) out[i] = vs[0];
      } else if (j + 1 >= ts.length) {
        if (i - ts[j] <= maxExtend) out[i] = vs[j];
      } else {
        const f = (i - ts[j]) / (ts[j + 1] - ts[j]);
        out[i] = vs[j] + f * (vs[j + 1] - vs[j]);
      }
    }
    return out;
  };

  let dist = interpChannel((r) => r.distance);
  let speedRaw = interpChannel((r) => r.speed);
  const hr = interpChannel((r) => r.heartRate);
  const cadence = interpChannel((r) => r.cadence);
  const power = interpChannel((r) => r.power);
  const altRaw = interpChannel((r) => r.altitude);

  // Distance fallbacks: integrate speed, or walk the GPS track.
  if (!dist.some(Number.isFinite)) {
    if (speedRaw.some(Number.isFinite)) {
      dist = new Float64Array(n);
      for (let i = 1; i < n; i++) {
        const v = Number.isFinite(speedRaw[i]) ? speedRaw[i] : 0;
        dist[i] = dist[i - 1] + (paused[i] ? 0 : v);
      }
      notes.push(msg("note.distFromSpeed"));
    } else {
      const hav = haversineDistance(recs);
      if (hav) {
        dist = interpChannel((_r) => undefined);
        const ts = hav.map((p) => p[0]);
        const ds = hav.map((p) => p[1]);
        let j = 0;
        for (let i = 0; i < n; i++) {
          while (j + 1 < ts.length && ts[j + 1] <= i) j++;
          dist[i] = j + 1 < ts.length ? ds[j] + ((i - ts[j]) / (ts[j + 1] - ts[j])) * (ds[j + 1] - ds[j]) : ds[j];
        }
        notes.push(msg("note.distFromGps"));
      } else {
        throw new AppError(msg("err.noPaceData"));
      }
    }
  }
  fillNaNs(dist);
  // Held distance during pauses, then enforce monotonicity.
  for (const [ia, ib] of holdDistance) {
    const a = recs[ia].t;
    const b = recs[ib].t;
    const dHold = dist[Math.min(n - 1, Math.max(0, Math.floor(a)))];
    for (let i = Math.floor(a) + 1; i < b && i < n; i++) dist[i] = dHold;
  }
  for (let i = 1; i < n; i++) if (dist[i] < dist[i - 1]) dist[i] = dist[i - 1];

  // ---- speed ------------------------------------------------------------------
  const speedFromDevice = speedRaw.filter(Number.isFinite).length >= 0.5 * n;
  if (!speedFromDevice) {
    speedRaw = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      speedRaw[i] = (dist[b] - dist[a]) / (b - a);
    }
    notes.push(msg("note.speedFromDist"));
  } else {
    fillNaNs(speedRaw);
  }
  const vmax = MAX_SPEED[activity.sport] ?? 25;
  let speed = cleanSpeed(speedRaw, paused, vmax);
  // Device speed is smoothed, so it trails the real change of pace. The distance
  // curve is the better clock: line the speed up with it (no-op if there is no lag).
  let speedLag = 0;
  if (speedFromDevice) {
    speedLag = estimateSpeedLag(speed, dist);
    if (speedLag >= MIN_LAG_TO_APPLY_S) {
      speed = shiftEarlier(speed, speedLag);
      for (let i = 0; i < n; i++) if (paused[i]) speed[i] = 0;
      notes.push(msg("note.lag", { lag: Math.round(speedLag * 10) / 10 }));
    } else {
      speedLag = 0;
    }
  }

  // How well do the watch's speed and its distance agree? (Different sensors can feed each: GPS speed
  // against an accelerometer or foot-pod distance, for instance.) The tables use distance / time, the
  // chart plots the speed, so a gap here is exactly the gap a reader would see between them.
  let speedRatio = 1;
  if (speedFromDevice) {
    let sv = 0;
    let sdist = 0;
    for (let i = 1; i < n - 1; i++) {
      const implied = (dist[i + 1] - dist[i - 1]) / 2;
      if (paused[i] || speed[i] < 1.5 || implied < 1.5) continue;
      sv += speed[i];
      sdist += implied;
    }
    if (sdist > 0) speedRatio = sv / sdist;
    if (Math.abs(speedRatio - 1) >= SPEED_MISMATCH) {
      notes.push(msg(speedRatio < 1 ? "note.speedLower" : "note.speedHigher", { pct: Math.round(Math.abs(speedRatio - 1) * 1000) / 10 }));
    }
  }

  // Speed implied by the distance curve itself: the "distance ÷ time" pace, second by second.
  const distSpeed = speedFromDevice ? distanceSpeed(dist, paused, vmax) : speed;

  // ---- altitude, grade, GAP -------------------------------------------------------
  const hasAltitude = altRaw.filter(Number.isFinite).length >= 0.5 * n;
  const altitude = grid();
  const grade = new Float64Array(n);
  const gapSpeed = Float64Array.from(speed);
  if (hasAltitude) {
    fillNaNs(altRaw);
    const alt = movingAverage(medianFilter(altRaw, 5), GRADE_ALT_SMOOTH_S);
    altitude.set(alt);
    const h = GRADE_HALF_SPAN_S;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - h);
      const b = Math.min(n - 1, i + h);
      const dd = dist[b] - dist[a];
      grade[i] = dd >= MIN_GRADE_SPAN_M ? clamp((alt[b] - alt[a]) / dd, -0.3, 0.3) : 0;
    }
    const gradeSmooth = movingAverage(grade, GRADE_SMOOTH_S);
    grade.set(gradeSmooth);
    for (let i = 0; i < n; i++) gapSpeed[i] = speed[i] * gradeCostFactor(grade[i]);
  }

  const pausedCum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pausedCum[i + 1] = pausedCum[i] + paused[i];

  return {
    n,
    dist,
    speed,
    distSpeed,
    gapSpeed,
    grade,
    altitude,
    hr,
    cadence,
    power,
    paused,
    pausedCum,
    hasHr: hr.some(Number.isFinite),
    hasCadence: cadence.some(Number.isFinite),
    hasPower: power.some(Number.isFinite),
    hasAltitude,
    speedFromDevice,
    speedLag,
    speedRatio,
    notes,
  };
}

/**
 * Minetti et al. (2002) metabolic cost of running vs. grade, normalised by the
 * flat cost. Multiplying speed by this factor gives the flat-equivalent speed.
 */
export function gradeCostFactor(g: number): number {
  const x = clamp(g, -0.3, 0.3);
  const cost = 155.4 * x ** 5 - 30.4 * x ** 4 - 43.3 * x ** 3 + 46.3 * x ** 2 + 19.5 * x + 3.6;
  return cost / 3.6;
}

/**
 * Share of moving time spent on a noticeable slope (|grade| >= 4 %). Hill
 * repeats put a large share there; a flat road run with a few bridges does not.
 */
export function hillShare(s: Series): number {
  if (!s.hasAltitude) return 0;
  let moving = 0;
  let steep = 0;
  for (let i = 0; i < s.n; i++) {
    if (s.speed[i] < 1.5) continue;
    moving++;
    if (Math.abs(s.grade[i]) >= 0.04) steep++;
  }
  return moving > 0 ? steep / moving : 0;
}

/** Cumulative distance at an arbitrary (fractional) time, linearly interpolated. */
export function distanceAt(s: Series, t: number): number {
  if (t <= 0) return s.dist[0];
  if (t >= s.n - 1) return s.dist[s.n - 1];
  const i = Math.floor(t);
  return s.dist[i] + (t - i) * (s.dist[i + 1] - s.dist[i]);
}

/** Seconds of stopped timer inside [a, b] (fractional bounds allowed). */
export function pausedSeconds(s: Series, a: number, b: number): number {
  const at = (t: number) => {
    const c = clamp(t, 0, s.n);
    const i = Math.min(Math.floor(c), s.n - 1);
    return s.pausedCum[i] + (c - i) * (s.paused[i] ?? 0);
  };
  return at(b) - at(a);
}

// ---------------------------------------------------------------------------
// small numeric helpers (also used by the detector)
// ---------------------------------------------------------------------------

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

export function fillNaNs(a: Float64Array): void {
  let first = a.findIndex(Number.isFinite);
  if (first < 0) {
    a.fill(0);
    return;
  }
  for (let i = 0; i < first; i++) a[i] = a[first];
  let prev = first;
  for (let i = first + 1; i < a.length; i++) {
    if (Number.isFinite(a[i])) {
      if (i - prev > 1) {
        for (let k = prev + 1; k < i; k++) a[k] = a[prev] + ((k - prev) / (i - prev)) * (a[i] - a[prev]);
      }
      prev = i;
    }
  }
  for (let i = prev + 1; i < a.length; i++) a[i] = a[prev];
}

export function movingAverage(a: ArrayLike<number>, window: number): Float64Array {
  const n = a.length;
  const out = new Float64Array(n);
  const half = Math.floor(window / 2);
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + a[i];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    out[i] = (cum[hi] - cum[lo]) / (hi - lo);
  }
  return out;
}

export function medianFilter(a: ArrayLike<number>, window: number): Float64Array {
  const n = a.length;
  const out = new Float64Array(n);
  const half = Math.floor(window / 2);
  const buf: number[] = [];
  for (let i = 0; i < n; i++) {
    buf.length = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) buf.push(a[k]);
    buf.sort((x, y) => x - y);
    out[i] = buf[buf.length >> 1];
  }
  return out;
}

export function median(values: ArrayLike<number>): number {
  const v = Array.from(values).filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function quantile(values: ArrayLike<number>, q: number): number {
  const v = Array.from(values).filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return NaN;
  const pos = clamp(q, 0, 1) * (v.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (pos - lo) * (v[hi] - v[lo]);
}

/** Speed vs distance disagreement (fraction) above which the file gets a visible note. */
const SPEED_MISMATCH = 0.03;
const MIN_LAG_TO_APPLY_S = 0.5;
const MAX_LAG_S = 8;

/**
 * Seconds by which `speed` trails the central difference of `dist`, found by
 * least-squares alignment over the whole activity (thousands of samples, and
 * dominated by the real changes of pace, so noise averages out).
 */
export function estimateSpeedLag(speed: ArrayLike<number>, dist: ArrayLike<number>): number {
  const n = speed.length;
  if (n < 120) return 0;
  const dd = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    dd[i] = (dist[b] - dist[a]) / (b - a);
  }
  const at = (t: number) => {
    const i = Math.floor(t);
    return speed[i] + (t - i) * (speed[i + 1] - speed[i]);
  };
  let bestLag = 0;
  let bestErr = Infinity;
  let err0 = Infinity;
  for (let lag = 0; lag <= MAX_LAG_S + 1e-9; lag += 0.25) {
    let e = 0;
    const hi = n - 2 - Math.ceil(MAX_LAG_S);
    for (let i = 5; i < hi; i++) {
      const d = at(i + lag) - dd[i];
      e += d * d;
    }
    if (lag === 0) err0 = e;
    if (e < bestErr) {
      bestErr = e;
      bestLag = lag;
    }
  }
  // Only trust a lag that clearly beats "no lag".
  return bestErr < 0.9 * err0 ? bestLag : 0;
}

const DIST_SPEED_HALF_WINDOW_S = 2.5;

/** Speed from the slope of the cumulative distance over a short centred window (zero while paused). */
function distanceSpeed(dist: Float64Array, paused: Uint8Array, vmax: number): Float64Array {
  const n = dist.length;
  const at = (t: number) => {
    const i = Math.min(n - 2, Math.floor(t));
    return dist[i] + (t - i) * (dist[i + 1] - dist[i]);
  };
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (paused[i]) continue;
    const a = Math.max(0, i - DIST_SPEED_HALF_WINDOW_S);
    const b = Math.min(n - 1, i + DIST_SPEED_HALF_WINDOW_S);
    out[i] = b > a ? clamp((at(b) - at(a)) / (b - a), 0, vmax) : 0;
  }
  return out;
}

/** The speed series a pace basis refers to. */
export function paceSeries(series: Series, basis: PaceBasis): Float64Array {
  return basis === "device" ? series.speed : series.distSpeed;
}

/** out[i] = x(i + lag): moves a signal earlier in time by `lag` seconds. */
function shiftEarlier(x: ArrayLike<number>, lag: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = Math.min(n - 1, i + lag);
    const j = Math.min(n - 2, Math.floor(t));
    out[i] = x[j] + (t - j) * (x[j + 1] - x[j]);
  }
  return out;
}

/** Remove isolated GPS spikes, clip to plausible range, force zero while paused. */
function cleanSpeed(raw: Float64Array, paused: Uint8Array, vmax: number): Float64Array {
  const n = raw.length;
  const v = Float64Array.from(raw, (x) => clamp(x, 0, vmax));
  for (let i = 1; i < n - 1; i++) {
    const neighbours = (v[i - 1] + v[i + 1]) / 2;
    if (Math.abs(v[i - 1] - v[i + 1]) < 1 && Math.abs(v[i] - neighbours) > 2.5) v[i] = neighbours;
  }
  for (let i = 0; i < n; i++) if (paused[i]) v[i] = 0;
  return v;
}

function haversineDistance(recs: RecordPoint[]): Array<[number, number]> | null {
  const pts = recs.filter((r) => r.lat !== undefined && r.lon !== undefined);
  if (pts.length < 10) return null;
  const R = 6_371_000;
  const out: Array<[number, number]> = [[pts[0].t, 0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const [la1, lo1, la2, lo2] = [pts[i - 1].lat!, pts[i - 1].lon!, pts[i].lat!, pts[i].lon!].map((d) => (d * Math.PI) / 180);
    const a = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
    acc += 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    out.push([pts[i].t, acc]);
  }
  return out;
}

export type { TimeRange };
