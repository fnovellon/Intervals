import { clamp, distanceAt, pausedSeconds, type Series } from "./timeseries";
import type { Segment, SegmentSpec } from "./model";

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

/** Compute all metrics for one segment from the 1 Hz series. */
export function measureSegment(series: Series, spec: SegmentSpec, id: number): Segment {
  const start = clamp(spec.start, 0, series.n - 1);
  const end = clamp(spec.end, start, series.n - 1);
  const [lo, hi] = sampleRange(start, end);

  const duration = end - start;
  const paused = pausedSeconds(series, start, end);
  const movingTime = Math.max(0, duration - paused);
  const distance = distanceAt(series, end) - distanceAt(series, start);
  const avgSpeed = movingTime > 0 ? distance / movingTime : 0;

  // Mean grade-adjusted speed over moving samples only.
  let gs = 0;
  let gc = 0;
  for (let i = lo; i < hi && i < series.n; i++) {
    if (!series.paused[i]) {
      gs += series.gapSpeed[i];
      gc++;
    }
  }

  // Best 5 s average speed (from the distance curve, so it is not smoothed twice).
  let maxSpeed = 0;
  for (let i = lo; i + 5 <= hi && i + 5 < series.n; i++) {
    maxSpeed = Math.max(maxSpeed, (series.dist[i + 5] - series.dist[i]) / 5);
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
    avgGapSpeed: gc ? gs / gc : avgSpeed,
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

export function measureAll(series: Series, specs: SegmentSpec[]): Segment[] {
  return specs.map((spec, i) => measureSegment(series, spec, i));
}
