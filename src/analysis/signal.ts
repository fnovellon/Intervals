import { msg, type Msg } from "../i18n";
import { noiseSigma, otsu, pelt } from "./changepoints";
import type { DetectOptions, SegmentSpec } from "./model";
import { clamp, median, quantile, type Series } from "./timeseries";

export interface SignalDetection {
  specs: SegmentSpec[];
  /** Work/rest threshold used (same unit as the signal, m/s). */
  threshold?: number;
  separation?: number;
  found: boolean;
  notes: Msg[];
}

interface Run {
  start: number;
  end: number;
  cls: 0 | 1; // 1 = hard effort
}

const MIN_PELT_SEGMENT = 3;
/** Cut index -> time offset, see detectSignal. */
export const HALF_SAMPLE = 0.5;
/** Segments shorter than this do not take part in the threshold decision (ramps, glitches). */
const CORE_MIN_LEN = 8;

/**
 * Detect work / rest / warm-up / cool-down purely from the speed signal.
 *
 * 1. Piecewise-constant segmentation (exact PELT) with a penalty derived from
 *    the measured noise and a minimum meaningful speed step.
 * 2. Work/rest threshold: Otsu on the moving segments only, so stopped time
 *    (standing rests) cannot pull the threshold down into the warm-up pace.
 * 3. Clean-up: runs shorter than the minimum rep / rest are absorbed.
 * 4. Every boundary is re-fitted as a least-squares two-level step on the raw
 *    signal, which places it at the 50 % point of the acceleration ramp.
 */
export function detectSignal(series: Series, signal: Float64Array, opts: DetectOptions): SignalDetection {
  const n = series.n;
  const notes: Msg[] = [];
  const whole: SegmentSpec[] = [{ start: 0, end: n - 1, kind: "other", source: "signal" }];
  if (n < 60) return { specs: whole, found: false, notes: [msg("sig.short")] };

  const sens = clamp(opts.sensitivity, 0.25, 4);
  const sigma = noiseSigma(signal);
  const p90 = quantile(signal, 0.9);
  const level = Math.max(p90, 1);
  const minStep = clamp(0.1 * level, 0.3, 1.2);
  const penalty = Math.max(2 * sigma * sigma * Math.log(n), 0.25 * 12 * minStep * minStep) / (sens * sens);

  const bounds = pelt(signal, penalty, MIN_PELT_SEGMENT);
  const segs = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const a = bounds[k];
    const b = bounds[k + 1];
    let s = 0;
    for (let i = a; i < b; i++) s += signal[i];
    segs.push({ start: a, end: b, len: b - a, mean: s / (b - a) });
  }

  // ---- work / rest threshold ------------------------------------------------------
  const vMoving = Math.max(0.5, 0.35 * p90);
  let threshold = opts.thresholdSpeed;
  let separation: number | undefined;
  if (threshold === undefined) {
    const core = segs.filter((s) => s.len >= CORE_MIN_LEN && s.mean >= vMoving);
    const split = core.length >= 2 ? otsu(core.map((s) => s.mean), core.map((s) => Math.sqrt(s.len))) : null;
    if (!split) return { specs: whole, found: false, notes: [msg("sig.steady")] };
    separation = split.separation;
    const contrast = split.hi - split.lo;
    if (contrast < 1.2 * minStep / Math.sqrt(sens) || contrast / split.lo < 0.08) {
      return {
        specs: whole,
        found: false,
        separation,
        threshold: split.threshold,
        notes: [msg("sig.lowContrast")],
      };
    }
    threshold = split.threshold;
  }

  // ---- runs ------------------------------------------------------------------------
  let runs: Run[] = [];
  for (const s of segs) {
    const cls: 0 | 1 = s.mean > threshold && s.mean >= vMoving ? 1 : 0;
    const prev = runs[runs.length - 1];
    if (prev && prev.cls === cls) prev.end = s.end;
    else runs.push({ start: s.start, end: s.end, cls });
  }
  runs = absorbShortRuns(runs, opts.minWorkSec, opts.minRestSec);

  // ---- boundary refinement -----------------------------------------------------------
  for (let k = 1; k < runs.length; k++) {
    const t = refineBoundary(signal, runs[k].start, runs[k - 1].start, runs[k].end);
    runs[k - 1].end = t;
    runs[k].start = t;
  }

  const firstWork = runs.findIndex((r) => r.cls === 1);
  let lastWork = -1;
  runs.forEach((r, i) => {
    if (r.cls === 1) lastWork = i;
  });
  if (firstWork < 0) {
    return { specs: whole, found: false, threshold, separation, notes: [msg("sig.noWork")] };
  }

  const specs: SegmentSpec[] = runs.map((r, i) => ({
    start: i === 0 ? 0 : r.start,
    end: i === runs.length - 1 ? n - 1 : r.end,
    kind: r.cls === 1 ? "work" : i < firstWork ? "warmup" : i > lastWork ? "cooldown" : "rest",
    source: "signal",
  }));
  const reps = specs.filter((s) => s.kind === "work").length;
  if (reps < 2) notes.push(msg("sig.oneEffort"));
  return { specs, threshold, separation, found: reps >= 2, notes };
}

/**
 * Repeatedly flip the run that is shortest relative to its minimum length until
 * every run is long enough. Flipping merges it with its neighbours.
 */
export function absorbShortRuns(input: Run[], minWork: number, minRest: number): Run[] {
  let runs = input.map((r) => ({ ...r }));
  for (;;) {
    let worst = -1;
    let worstRatio = 1;
    runs.forEach((r, i) => {
      const ratio = (r.end - r.start) / (r.cls === 1 ? minWork : minRest);
      if (ratio < worstRatio) {
        worstRatio = ratio;
        worst = i;
      }
    });
    if (worst < 0 || runs.length === 1) return runs;
    const r = runs[worst];
    const prev = runs[worst - 1];
    const next = runs[worst + 1];
    if (prev && next) {
      // prev and next share a class (runs alternate); merge all three.
      prev.end = next.end;
      runs.splice(worst, 2);
    } else if (prev) {
      prev.end = r.end;
      runs.splice(worst, 1);
    } else {
      next.start = r.start;
      runs.splice(worst, 1);
    }
    runs = mergeSameClass(runs);
  }
}

function mergeSameClass(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    if (prev && prev.cls === r.cls) prev.end = r.end;
    else out.push({ ...r });
  }
  return out;
}

/**
 * Locate a transition between two runs to sub-second precision.
 *
 * Two levels (robust medians away from the transition) define the step. The
 * boundary is the cut that minimises the squared error of that two-level model,
 * i.e. the half-way (50 %) point of the acceleration ramp, refined below one
 * sample by a parabola through the three errors around the minimum.
 *
 * A cut "before sample t" means the crossing happened between samples t-1 and
 * t, so the unbiased time is t - 1/2 (HALF_SAMPLE).
 *
 * Returns a time in seconds (fractional). `b` is the approximate cut index,
 * `leftStart` / `rightEnd` bound the two neighbouring runs.
 *
 * Note: the 50 % point is deliberately used instead of the transition's
 * centroid. For the usual fast-attack / slow-tail response the centroid sits
 * ~0.3 time-constants later and biases every boundary the same way.
 */
export function refineBoundary(
  x: ArrayLike<number>,
  b: number,
  leftStart: number,
  rightEnd: number,
  window = 10,
  margin = 3,
): number {
  const ls = Math.ceil(leftStart);
  const re = Math.floor(rightEnd);
  const fallback = b - HALF_SAMPLE;
  const lo = Math.max(ls + margin, Math.round(b) - window);
  const hi = Math.min(re - margin, Math.round(b) + window);
  if (hi <= lo) return fallback;

  const gap = Math.ceil(window / 2) + 1;
  const levelOf = (a: number, c: number, fa: number, fc: number) => {
    const seg: number[] = [];
    for (let i = Math.max(0, Math.floor(a)); i < c; i++) seg.push(x[i]);
    if (seg.length >= 3) return median(seg);
    const fb: number[] = [];
    for (let i = Math.max(0, Math.floor(fa)); i < fc; i++) fb.push(x[i]);
    return median(fb);
  };
  const bi = Math.round(b);
  const muL = levelOf(Math.max(ls, bi - 40), bi - gap, ls, bi);
  const muR = levelOf(bi + gap, Math.min(re, bi + 40), bi, re);
  if (!Number.isFinite(muL) || !Number.isFinite(muR) || Math.abs(muR - muL) < 1e-6) return fallback;

  // Least-squares cut: error of the two-level model for every candidate cut.
  const e0 = Math.max(ls, lo - 6);
  const e1 = Math.min(re, hi + 6);
  const errs = new Map<number, number>();
  let right = 0;
  for (let i = e0; i < e1; i++) right += (x[i] - muR) ** 2;
  let left = 0;
  let cut = bi;
  let bestErr = Infinity;
  for (let t = e0; t <= hi; t++) {
    if (t >= lo - 1) errs.set(t, left + right);
    if (t >= lo) {
      const err = left + right;
      if (err < bestErr - 1e-12 || (Math.abs(err - bestErr) <= 1e-12 && Math.abs(t - bi) < Math.abs(cut - bi))) {
        bestErr = err;
        cut = t;
      }
    }
    if (t < e1) {
      left += (x[t] - muL) ** 2;
      right -= (x[t] - muR) ** 2;
    }
  }

  // Sub-sample position: vertex of the parabola through the three errors around the minimum.
  let frac = 0;
  const em = errs.get(cut - 1);
  const ep = errs.get(cut + 1);
  if (em !== undefined && ep !== undefined) {
    const denom = em - 2 * bestErr + ep;
    if (denom > 1e-12) frac = clamp(0.5 * (em - ep) / denom, -0.5, 0.5);
  }
  return cut + frac - HALF_SAMPLE;
}
