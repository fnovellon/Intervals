import { otsu } from "./changepoints";
import type { DetectOptions, SegmentKind, SegmentSpec } from "./model";
import { refineBoundary } from "./signal";
import { clamp, distanceAt, pausedSeconds, quantile, type Series } from "./timeseries";
import type { LapIntensity, LapRecord, WorkoutStep } from "../fit/types";

export interface LapDetection {
  specs: SegmentSpec[];
  /** True when the laps carry real interval structure (not plain auto-splits). */
  informative: boolean;
  reason: string;
  threshold?: number;
  separation?: number;
  notes: string[];
}

const STRUCTURE_INTENSITIES = new Set<LapIntensity>(["rest", "recovery", "warmup", "cooldown", "interval"]);

function kindFromIntensity(i: LapIntensity | undefined): SegmentKind {
  switch (i) {
    case "warmup":
      return "warmup";
    case "cooldown":
      return "cooldown";
    case "rest":
    case "recovery":
      return "rest";
    case "active":
    case "interval":
      return "work";
    default:
      return "other";
  }
}

/**
 * Turn the device's laps into segments. Laps are what the watch (structured
 * workout) or the athlete (lap button) decided, so they are used as ground
 * truth for boundaries; optionally each boundary is snapped to the closest real
 * change of pace.
 */
export function detectLaps(
  laps: LapRecord[],
  steps: WorkoutStep[],
  series: Series,
  signal: Float64Array,
  opts: DetectOptions,
): LapDetection {
  const notes: string[] = [];
  const usable = laps.filter((l) => l.end - l.start >= 2 && l.start < series.n - 1);
  const none = (reason: string): LapDetection => ({ specs: [], informative: false, reason, notes });
  if (usable.length < 3) return none("The file has fewer than 3 laps.");

  // Contiguous boundaries: each lap ends where the next one starts.
  const bounds: number[] = [0];
  for (let i = 1; i < usable.length; i++) bounds.push(clamp(usable[i].start, bounds[bounds.length - 1], series.n - 1));
  bounds.push(series.n - 1);

  const lapStats = usable.map((_, i) => {
    const a = bounds[i];
    const b = bounds[i + 1];
    const moving = Math.max(0.001, b - a - pausedSeconds(series, a, b));
    return { len: b - a, speed: (distanceAt(series, b) - distanceAt(series, a)) / moving };
  });

  const structured =
    usable.some((l) => l.intensity && STRUCTURE_INTENSITIES.has(l.intensity)) &&
    usable.some((l) => l.intensity === "active" || l.intensity === "interval");

  let kinds: SegmentKind[];
  let threshold: number | undefined;
  let separation: number | undefined;
  let reason: string;

  if (structured) {
    kinds = usable.map((l) => kindFromIntensity(l.intensity));
    reason = "Laps carry workout intensities (warm-up / active / rest / cool-down) recorded by the watch.";
  } else {
    const body = usable.slice(0, -1);
    // Auto-laps (every km / every N minutes) are uniform by construction.
    const uniform = (trigger: string, measure: (l: LapRecord) => number) =>
      body.length >= 2 && body.every((l) => l.trigger === trigger) && coefficientOfVariation(body.map(measure)) < 0.03;
    if (uniform("distance", (l) => l.distance) || uniform("time", (l) => l.end - l.start)) {
      return none("Laps are automatic splits (every km / fixed time), not interval laps.");
    }

    // Classify manual laps by speed.
    const vMoving = Math.max(0.5, 0.35 * quantile(signal, 0.9));
    const idx = lapStats.map((_, i) => i).filter((i) => lapStats[i].len >= 5 && lapStats[i].speed >= vMoving);
    const split = idx.length >= 2 ? otsu(idx.map((i) => lapStats[i].speed), idx.map((i) => Math.sqrt(lapStats[i].len))) : null;
    const level = Math.max(quantile(signal, 0.9), 1);
    const minStep = clamp(0.1 * level, 0.3, 1.2);
    if (!split || split.hi - split.lo < 1.2 * minStep || (split.hi - split.lo) / split.lo < 0.08) {
      return none("Laps show no clear fast/slow alternation.");
    }
    threshold = opts.thresholdSpeed ?? split.threshold;
    separation = split.separation;
    const raw = lapStats.map((s) => (s.speed > threshold! ? "work" : "rest") as SegmentKind);
    const firstWork = raw.indexOf("work");
    const lastWork = raw.lastIndexOf("work");
    kinds = raw.map((k, i) => (k === "work" ? k : i < firstWork ? "warmup" : i > lastWork ? "cooldown" : "rest"));
    reason = "Laps were placed by the athlete (lap button) and classified by pace.";
  }

  if (kinds.filter((k) => k === "work").length < 2) return none("Fewer than two work laps.");

  // Optional snapping of boundaries to the signal.
  const shift = new Array<number>(usable.length).fill(0);
  // Structured-workout steps end exactly where the watch decided; only lap-button laps are snapped.
  if (opts.snapLaps && !structured) {
    const level = Math.max(quantile(signal, 0.9), 1);
    const minStep = clamp(0.1 * level, 0.3, 1.2);
    for (let i = 1; i < usable.length; i++) {
      const hardBefore = kinds[i - 1] === "work";
      const hardAfter = kinds[i] === "work";
      if (hardBefore === hardAfter) continue;
      if (Math.abs(lapStats[i].speed - lapStats[i - 1].speed) < minStep) continue;
      const t = refineBoundary(signal, bounds[i], bounds[i - 1], bounds[i + 1]);
      shift[i] = t - bounds[i];
      bounds[i] = t;
    }
  }

  const specs: SegmentSpec[] = usable.map((l, i) => {
    const spec: SegmentSpec = {
      start: bounds[i],
      end: bounds[i + 1],
      kind: kinds[i],
      source: "lap",
      lapIndex: l.index,
    };
    if (shift[i] !== 0) spec.snapShift = shift[i];
    const step = l.stepIndex !== undefined ? steps.find((s) => s.index === l.stepIndex) : undefined;
    if (step?.targetSpeedLow !== undefined && step.targetSpeedHigh !== undefined) {
      spec.targetSpeedLow = step.targetSpeedLow;
      spec.targetSpeedHigh = step.targetSpeedHigh;
    }
    return spec;
  });
  return { specs, informative: true, reason, threshold, separation, notes };
}

function coefficientOfVariation(v: number[]): number {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  if (m === 0) return Infinity;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) / m;
}
