import { clamp, distanceAt, pausedSeconds, type Series } from "./timeseries";
import type { PaceBasis, Segment, SegmentSpec } from "./model";

/** Mean of finite values in arr[lo, hi). NaN when there are none. */
export function meanOf(arr: ArrayLike<number>, lo: number, hi: number): number {
  let s = 0;
  let c = 0;
  for (let i = Math.max(0, lo); i < Math.min(arr.length, hi); i++) {
    const v = arr[i];
    if (Number.isFinite(v)) {
      s += v;
      c++;
    }
  }
  return c ? s / c : NaN;
}

function maxOf(arr: ArrayLike<number>, lo: number, hi: number): number {
  let m = NaN;
  for (let i = Math.max(0, lo); i < Math.min(arr.length, hi); i++) {
    const v = arr[i];
    if (Number.isFinite(v) && (Number.isNaN(m) || v > m)) m = v;
  }
  return m;
}

/** Sample range [lo, hi) covered by a (possibly fractional) time span. */
export function sampleRange(start: number, end: number): [number, number] {
  return [Math.ceil(start - 1e-9), Math.ceil(end - 1e-9)];
}

/** Integral of the piecewise-linear recorded speed over [a, b] seconds: the distance the speed channel implies. */
export function integrateSpeed(speed: ArrayLike<number>, a: number, b: number): number {
  const last = speed.length - 1;
  const at = (t: number) => {
    const i = Math.min(last - 1, Math.max(0, Math.floor(t)));
    return speed[i] + (t - i) * (speed[i + 1] - speed[i]);
  };
  a = clamp(a, 0, last);
  b = clamp(b, a, last);
  if (b - a < 1e-9) return 0;
  const ia = Math.floor(a) + 1;
  const ib = Math.floor(b);
  if (ia > ib) return ((at(a) + at(b)) / 2) * (b - a);
  let sum = ((at(a) + speed[ia]) / 2) * (ia - a);
  for (let i = ia; i < ib; i++) sum += (speed[i] + speed[i + 1]) / 2;
  sum += ((speed[ib] + at(b)) / 2) * (b - ib);
  return sum;
}

/** Compute all metrics for one segment from the 1 Hz series. */
export function measureSegment(series: Series, spec: SegmentSpec, id: number, basis: PaceBasis = "distance"): Segment {
  const start = clamp(spec.start, 0, series.n - 1);
  const end = clamp(spec.end, start, series.n - 1);
  const [lo, hi] = sampleRange(start, end);

  const duration = end - start;
  const paused = pausedSeconds(series, start, end);
  const movingTime = Math.max(0, duration - paused);
  const distance = distanceAt(series, end) - distanceAt(series, start);
  // A standing rest has almost no moving time; dividing by it would give a
  // meaningless pace, so fall back to wall-clock time when mostly stopped.
  const timeBasis = paused > 0.5 * duration ? duration : movingTime;
  const distSpeed = timeBasis > 0 ? distance / timeBasis : 0;
  // Same division with the distance the recorded speed adds up to (paused seconds carry speed 0).
  const deviceSpeed = series.speedFromDevice && timeBasis > 0 ? integrateSpeed(series.speed, start, end) / timeBasis : distSpeed;
  const avgSpeed = basis === "device" ? deviceSpeed : distSpeed;

  // Grade-adjusted speed = the segment's own speed (distance / time) times the average effect of the
  // slope, weighted by distance covered. Built this way it equals the plain speed exactly on flat
  // ground; averaging the per-second device speeds instead would differ from distance / time by
  // 1-2 s/km even with no slope at all (smoothed speed, whole-sample edges).
  let gs = 0;
  let vs = 0;
  for (let i = lo; i < hi && i < series.n; i++) {
    if (!series.paused[i]) {
      gs += series.gapSpeed[i];
      vs += series.speed[i];
    }
  }
  const slopeFactor = vs > 0 ? gs / vs : 1;

  // Best 5 s average speed: from the distance curve (not smoothed twice), or from the recorded speed.
  let maxSpeed = 0;
  const useDevice = basis === "device" && series.speedFromDevice;
  for (let i = lo; i + 5 <= hi && i + 5 < series.n; i++) {
    if (useDevice) {
      let m = 0;
      for (let k = i; k < i + 5; k++) m += series.speed[k];
      maxSpeed = Math.max(maxSpeed, m / 5);
    } else {
      maxSpeed = Math.max(maxSpeed, (series.dist[i + 5] - series.dist[i]) / 5);
    }
  }
  if (maxSpeed === 0) maxSpeed = avgSpeed;

  const seg: Segment = {
    id,
    kind: spec.kind,
    source: spec.source,
    start,
    end,
    duration,
    paused,
    movingTime,
    distance,
    avgSpeed,
    distSpeed,
    deviceSpeed,
    avgGapSpeed: avgSpeed * slopeFactor,
    maxSpeed,
  };

  if (series.hasHr) {
    const avg = meanOf(series.hr, lo, hi);
    if (Number.isFinite(avg)) {
      seg.avgHr = avg;
      seg.maxHr = maxOf(series.hr, lo, hi);
      const edge = Math.min(5, Math.max(1, hi - lo));
      seg.hrStart = meanOf(series.hr, lo, lo + edge);
      seg.hrEnd = meanOf(series.hr, hi - edge, hi);
    }
  }
  if (series.hasCadence) {
    // Exclude stopped seconds so standing rests do not drag the average to zero.
    let s = 0;
    let c = 0;
    for (let i = lo; i < hi && i < series.n; i++) {
      const v = series.cadence[i];
      if (Number.isFinite(v) && !series.paused[i] && v > 0) {
        s += v;
        c++;
      }
    }
    if (c) seg.avgCadence = s / c;
  }
  if (series.hasPower) {
    const p = meanOf(series.power, lo, hi);
    if (Number.isFinite(p)) seg.avgPower = p;
  }
  if (series.hasAltitude && hi - lo >= 2) {
    let gain = 0;
    let loss = 0;
    for (let i = lo + 1; i < hi && i < series.n; i++) {
      const d = series.altitude[i] - series.altitude[i - 1];
      if (d > 0) gain += d;
      else loss -= d;
    }
    seg.elevGain = gain;
    seg.elevLoss = loss;
    if (distance > 20) seg.avgGrade = ((series.altitude[Math.min(series.n - 1, hi - 1)] - series.altitude[lo]) / distance) * 100;
  }

  if (duration >= 20 && movingTime > 0) {
    const mid = (start + end) / 2;
    const v1 = (distanceAt(series, mid) - distanceAt(series, start)) / (mid - start);
    const v2 = (distanceAt(series, end) - distanceAt(series, mid)) / (end - mid);
    if (v1 > 0.3) seg.fadePct = ((v1 - v2) / v1) * 100;

    const trim = Math.floor((hi - lo) * 0.1);
    let s1 = 0;
    let s2 = 0;
    let c = 0;
    for (let i = lo + trim; i < hi - trim && i < series.n; i++) {
      const v = series.speed[i];
      s1 += v;
      s2 += v * v;
      c++;
    }
    if (c > 5) {
      const m = s1 / c;
      const variance = Math.max(0, s2 / c - m * m);
      if (m > 0.3) seg.speedCvPct = (Math.sqrt(variance) / m) * 100;
    }
  }

  if (spec.lapIndex !== undefined) seg.lapIndex = spec.lapIndex;
  if (spec.targetSpeedLow !== undefined) seg.targetSpeedLow = spec.targetSpeedLow;
  if (spec.targetSpeedHigh !== undefined) seg.targetSpeedHigh = spec.targetSpeedHigh;
  if (spec.snapShift !== undefined) seg.snapShift = spec.snapShift;
  return seg;
}

export function measureAll(series: Series, specs: SegmentSpec[], basis: PaceBasis = "distance"): Segment[] {
  return specs.map((spec, i) => measureSegment(series, spec, i, basis));
}
