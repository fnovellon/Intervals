import { msg, type Msg } from "../i18n";
import { noiseSigma, otsu, pelt } from "./changepoints";
import type { DetectOptions, EdgeStrategy, SegmentSpec, StartFrom } from "./model";
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
    // An effort that follows a jog grows from the jog's pace, not from the pace of the whole recovery.
    const base = runs[k].cls === 1 ? levelBeforeStart(segs, signal, runs[k].start, runs[k].end, runs[k - 1].start, opts.startFrom ?? "auto") : undefined;
    const t = refineBoundary(signal, runs[k].start, runs[k - 1].start, runs[k].end, 10, 3, opts, base);
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

/** A steady stretch this long is a pace the athlete held (a jog), not a bit of the acceleration. */
const MIN_JOG_PLATEAU_S = 6;
/** Shortest steady stretch that can serve as "the pace before" when the athlete said they start jogging. */
const MIN_PLATEAU_S = 3;

/**
 * The stretch of signal that tells where an effort grows from: the last steady pace before the cut, or
 * undefined to use the whole recovery before it (what a start from standstill means).
 *
 * Without this, a recovery that was first standing and then jogging has a median of "standing", the jog
 * counts as 20 % - 60 % of the effort, and the effort is wrongly said to start with the jog.
 */
export function levelBeforeStart(
  segs: ReadonlyArray<{ start: number; end: number; len: number; mean: number }>,
  x: ArrayLike<number>,
  cut: number,
  effortEnd: number,
  floor: number,
  from: StartFrom,
): [number, number] | undefined {
  if (from === "standing") return undefined;
  const need = from === "jogging" ? MIN_PLATEAU_S : MIN_JOG_PLATEAU_S;
  let j = segs.findIndex((s) => s.end === cut);
  // skip the short fragments of the acceleration itself
  while (j >= 0 && segs[j].len < need && segs[j].start > floor) j--;
  if (j < 0 || segs[j].len < need || segs[j].start < floor) return undefined;
  const seg = segs[j];
  const trim = seg.len >= 8 ? 2 : seg.len >= 5 ? 1 : 0;
  const base: [number, number] = [seg.start, seg.end - trim];
  if (from === "jogging") return base;

  // Auto: only a real jog counts. (1) The athlete was stopped or crawling before it: if the recovery held
  // the same pace throughout, the median already is the right starting level and nothing is wrong.
  // (2) It is a steady stretch with a clear step up to it and another up to the effort. A slow build-up that
  // the segmentation cut into pieces looks steady piece by piece, but each piece still drifts about as much
  // as the step to its neighbour; a held pace barely drifts.
  let slow = 0;
  const lead0 = Math.max(Math.ceil(floor), Math.floor(cut) - 40);
  const lead1 = Math.floor(seg.start);
  for (let i = lead0; i < lead1; i++) if (x[i] < 0.5 * seg.mean) slow++;
  if (lead1 <= lead0 || slow < JOG_AFTER_SLOW * (lead1 - lead0)) return undefined;
  const third = Math.max(2, Math.floor((base[1] - base[0]) / 3));
  const level = (a: number, b: number) => median(Array.from({ length: Math.max(0, b - a) }, (_, i) => x[a + i]));
  // (the first third is skipped: that is the athlete settling into the jog)
  const drift = Math.abs(level(base[1] - third, base[1]) - level(base[0] + third, base[0] + 2 * third));
  const effort = level(Math.ceil(cut) + 6, Math.min(Math.floor(effortEnd), Math.ceil(cut) + 40));
  const stepOut = Math.abs(effort - seg.mean);
  // the step up to the jog is measured from the previous steady level, not from a fragment of the climb to it
  let i = j - 1;
  while (i >= 0 && segs[i].len < MIN_PLATEAU_S && segs[i].start > floor) i--;
  const stepIn = i >= 0 && segs[i].start >= floor ? Math.abs(seg.mean - segs[i].mean) : Infinity;
  if (!Number.isFinite(effort) || stepOut <= 0 || drift > JOG_DRIFT * Math.min(stepIn, stepOut)) return undefined;
  return base;
}

/** Share of the recovery before the jog that must have been much slower than the jog for it to matter. */
const JOG_AFTER_SLOW = 0.2;

/** How much a held pace may drift, as a share of the smaller of its two neighbouring steps. */
const JOG_DRIFT = 0.35;

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
  edge: EdgeStrategy = DEFAULT_EDGES,
  /** Samples [from, to) that hold the pace before an effort, when it is not simply the run before it. */
  base?: [number, number],
): number {
  const t = locateEdge(x, b, leftStart, rightEnd, window, margin, edge, base);
  // The pace only changes after the beep: move the edge back by the reaction time (never past a neighbour).
  const lead = clamp(edge.reactionSec, 0, 5);
  return lead > 0 ? Math.max(Math.ceil(leftStart) + margin, t - lead) : t;
}

const DEFAULT_EDGES: EdgeStrategy = { startEffort: 0.5, endEffort: 0.5, reactionSec: 0 };

function locateEdge(
  x: ArrayLike<number>,
  b: number,
  leftStart: number,
  rightEnd: number,
  window: number,
  margin: number,
  edge: EdgeStrategy,
  base?: [number, number],
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
  let muL = levelOf(Math.max(ls, bi - 40), bi - gap, ls, bi);
  if (base && base[1] - base[0] >= 3) {
    const seg: number[] = [];
    for (let i = Math.max(0, Math.floor(base[0])); i < base[1]; i++) seg.push(x[i]);
    muL = median(seg);
  }
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
  const t50 = cut + frac - HALF_SAMPLE;
  // A rising edge (easy -> hard) is an interval start, a falling one an end.
  const q = clamp(muR > muL ? edge.startEffort : edge.endEffort, 0.05, 0.95);
  if (Math.abs(q - 0.5) < 0.005) return t50;

  // ---- other fractions of the change -------------------------------------------------------------
  // Progress runs 0 -> 1 from the left level to the right level. An interval's "effort fraction" is
  // progress when the right side is the hard one (a start) and 1 - progress when it is the left (an end),
  // so a lower q always means "more inclusive": earlier starts, later ends.
  const target = muR > muL ? q : 1 - q;
  const from = Math.round(t50);
  const reach = EDGE_SCAN_S;
  const a = Math.max(ls + 1, from - reach);
  const z = Math.min(re - 1, from + reach);
  if (z - a < 6) return t50;
  const prog: number[] = [];
  for (let i = a; i <= z; i++) prog.push((x[i] - muL) / (muR - muL));
  const smooth = prog.map((_, i) => median(prog.slice(Math.max(0, i - 2), Math.min(prog.length, i + 3))));
  const m = from - a;

  /** Time at which the smoothed progress crosses `level`, scanning away from the mid-point. */
  const crossing = (level: number): number | null => {
    if (smooth[m] >= level) {
      for (let i = m - 1; i >= 0; i--) {
        if (smooth[i] < level && (i === 0 || smooth[i - 1] < level)) {
          const d = smooth[i + 1] - smooth[i];
          return a + i + (d > 1e-9 ? (level - smooth[i]) / d : 0);
        }
      }
    } else {
      for (let i = m + 1; i < smooth.length; i++) {
        if (smooth[i] >= level && (i === smooth.length - 1 || smooth[i + 1] >= level)) {
          const d = smooth[i] - smooth[i - 1];
          return a + i - 1 + (d > 1e-9 ? (level - smooth[i - 1]) / d : 1);
        }
      }
    }
    return null;
  };
  const tq = crossing(target);
  const th = crossing(0.5);
  if (tq === null || th === null) return t50;
  // Measure against the same scan at 0.5 so the default stays exactly the least-squares half-way point.
  return clamp(t50 + (tq - th), ls + margin, re - margin);
}

/** How far (s) either side of the half-way point to look for other fractions of a change of pace. */
const EDGE_SCAN_S = 25;
