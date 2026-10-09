import type { Seconds } from "../fit/types";

export type SegmentKind = "warmup" | "work" | "rest" | "cooldown" | "other";
export type SegmentSource = "signal" | "lap" | "manual";
export type DetectMode = "auto" | "signal" | "laps";
export type SignalKind = "auto" | "speed" | "gap";

export interface Segment {
  id: number;
  kind: SegmentKind;
  source: SegmentSource;
  /** Seconds since activity start (wall clock). */
  start: Seconds;
  end: Seconds;

  /** Wall-clock length (end - start). */
  duration: Seconds;
  /** Seconds the timer was stopped inside the segment. */
  paused: Seconds;
  /** duration - paused. */
  movingTime: Seconds;
  /** Metres, from the cumulative distance curve at the exact boundaries. */
  distance: number;
  /** distance / movingTime, m/s. */
  avgSpeed: number;
  /** Mean grade-adjusted speed, m/s. */
  avgGapSpeed: number;
  /** Best 5 s average speed inside the segment, m/s. */
  maxSpeed: number;

  avgHr?: number;
  maxHr?: number;
  /** Mean HR over the first / last 5 s. */
  hrStart?: number;
  hrEnd?: number;
  avgCadence?: number;
  avgPower?: number;

  elevGain?: number;
  elevLoss?: number;
  /** Average grade in %. */
  avgGrade?: number;

  /** (first-half speed - second-half speed) / first-half speed, in %. Positive = slowed down. */
  fadePct?: number;
  /** Speed variability (CV, %) over the central 80 % of the segment. */
  speedCvPct?: number;

  /** Structured-workout target (m/s), when the file carries one. */
  targetSpeedLow?: number;
  targetSpeedHigh?: number;
  lapIndex?: number;
  /** Seconds the boundary moved when a lap boundary was snapped to the signal (start boundary). */
  snapShift?: number;
}

export interface SegmentSpec {
  start: Seconds;
  end: Seconds;
  kind: SegmentKind;
  source: SegmentSource;
  lapIndex?: number;
  targetSpeedLow?: number;
  targetSpeedHigh?: number;
  snapShift?: number;
}

export interface DetectOptions {
  mode: DetectMode;
  /**
   * Which speed channel to segment on. "gap" (grade-adjusted) removes the effect
   * of hills; "auto" picks it when the route is hilly.
   */
  signal: SignalKind;
  /** 0.5 = conservative .. 2 = aggressive. 1 is a good default. */
  sensitivity: number;
  /** Shortest effort that counts as a rep. */
  minWorkSec: number;
  /** Shortest recovery that separates two reps. */
  minRestSec: number;
  /**
   * Move lap boundaries that were placed by hand (lap button) to the nearest
   * real pace change. Laps of a structured workout are never moved: the watch
   * ended those steps exactly.
   */
  snapLaps: boolean;
  /** Override the work/rest speed threshold (m/s). Auto when undefined. */
  thresholdSpeed?: number;
}

export const DEFAULT_OPTIONS: DetectOptions = {
  mode: "auto",
  signal: "auto",
  sensitivity: 1,
  minWorkSec: 10,
  minRestSec: 6,
  snapLaps: true,
};

export interface RepSet {
  /** Indices into Detection.reps. */
  repIndices: number[];
  /** e.g. "6 × 800 m" */
  label: string;
}

export interface Summary {
  repCount: number;
  totalWorkTime: Seconds;
  totalWorkDistance: number;
  totalRestTime: Seconds;
  /** Distance-weighted mean speed over all work reps, m/s. */
  avgWorkSpeed: number;
  /** Indices (into Detection.reps) of the largest group of similar reps; consistency metrics use it. */
  mainSet: number[];
  fastestRep?: number;
  slowestRep?: number;
  /** (slowest - fastest) pace in seconds per km. */
  paceSpreadSecPerKm: number;
  /** Coefficient of variation of rep speeds, %. */
  paceCvPct: number;
  /** Change in speed from first to last rep, %. Negative = slowing down. */
  firstToLastPct: number;
  /** Pace slope across reps, seconds/km per rep (positive = slowing). */
  paceTrendSecPerKmPerRep: number;
  avgRestTime: number;
  /** Median rest between reps (seconds). */
  medianRestTime: number;
  workRestRatio: number;
  avgWorkHr?: number;
  peakHr?: number;
  /** HR at the end of the last rep minus HR at the end of the first, bpm. */
  hrDrift?: number;
  /** Mean HR drop during recoveries (end of rep -> end of rest), bpm. */
  avgHrRecovery?: number;
  structure: string;
  sets: RepSet[];
}

export interface Detection {
  modeUsed: "signal" | "laps";
  modeReason: string;
  /** Speed channel the segmentation actually ran on. */
  signalUsed: "speed" | "gap";
  segments: Segment[];
  /** Work segments, in order. */
  reps: Segment[];
  summary: Summary | null;
  /** False when no alternation of hard/easy efforts was found. */
  intervalsFound: boolean;
  /** Work/rest threshold actually used, m/s (signal mode / lap classification). */
  threshold?: number;
  /** Share of speed variance explained by the work/rest split (0..1). */
  separation?: number;
  notes: string[];
  options: DetectOptions;
}
