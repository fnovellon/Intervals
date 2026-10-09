import type { Seconds } from "../fit/types";
import type { Msg } from "../i18n";

export type SegmentKind = "warmup" | "work" | "rest" | "cooldown" | "other";
export type SegmentSource = "signal" | "lap" | "manual";
export type DetectMode = "auto" | "signal" | "laps";
export type SignalKind = "auto" | "speed" | "gap";
/**
 * Where a pace comes from. "distance": distance covered ÷ time (what the lap table in Garmin Connect
 * shows). "device": the speed the watch recorded second by second (what its screen shows while you run).
 * They agree unless the watch's speed and distance come from different sensors.
 */
export type PaceBasis = "distance" | "device";

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
  /** Average speed on the chosen pace basis (`DetectOptions.paceBasis`), m/s. */
  avgSpeed: number;
  /** distance / movingTime, m/s. */
  distSpeed: number;
  /** Mean of the speed the watch recorded, m/s (equals `distSpeed` when the file has no speed channel). */
  deviceSpeed: number;
  /** Mean grade-adjusted speed, m/s. */
  avgGapSpeed: number;
  /** Best 5 s average speed inside the segment (on the chosen basis), m/s. */
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

/** The part of DetectOptions that decides where an interval's edges are placed. */
export type EdgeStrategy = Pick<DetectOptions, "startEffort" | "endEffort" | "reactionSec">;

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
  /**
   * Interval edges, as a share of the full effort (the hard level above the easy one).
   * An interval STARTS when the effort has risen to `startEffort` and ENDS when it has
   * fallen to `endEffort`. 0.5 / 0.5 is half-way up and half-way down (the default).
   * A low start and a high end follow the beeps: from the first sign of acceleration
   * until just before the pace drops. A high start and end keep only the steady part.
   */
  startEffort: number;
  endEffort: number;
  /**
   * Seconds between the beep and the athlete's reaction. Both edges are moved this much
   * earlier, because the pace only changes after the beep.
   */
  reactionSec: number;
  /** Which speed the reported paces come from. Detection itself always uses the recorded speed. */
  paceBasis: PaceBasis;
  /** Override the work/rest speed threshold (m/s). Auto when undefined. */
  thresholdSpeed?: number;
}

/**
 * Where intervals start and end.
 * - beep: from the first clear sign of acceleration to the moment the pace begins to drop, moved back by a
 *   typical reaction time. On simulated sessions with a known beep it lands 0.3-1.1 s from the beep on
 *   average (2-4.7 s for "half"), robustly across GPS noise, device smoothing and slow ramps.
 * - half: the middle of each change of pace.
 * - plateau: only the steady part (cleanest pace, but reps come out ~5 s / 7 % short).
 */
export const EDGE_PRESETS = {
  beep: { startEffort: 0.2, endEffort: 0.8, reactionSec: 0.5 },
  half: { startEffort: 0.5, endEffort: 0.5, reactionSec: 0 },
  plateau: { startEffort: 0.9, endEffort: 0.9, reactionSec: 0 },
} as const satisfies Record<string, EdgeStrategy>;

export const DEFAULT_OPTIONS: DetectOptions = {
  mode: "auto",
  signal: "auto",
  sensitivity: 1,
  minWorkSec: 10,
  minRestSec: 6,
  snapLaps: true,
  paceBasis: "distance",
  ...EDGE_PRESETS.beep,
};

/** What a rep was prescribed as: a distance (metres) or a duration (seconds). */
export interface RepSpec {
  basis: "distance" | "time";
  value: number;
}

export interface RepSet extends RepSpec {
  /** Indices into Detection.reps. */
  repIndices: number[];
  count: number;
  /** English text, e.g. "6 × 800 m"; use structureText() for other languages. */
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
  /** English description, e.g. "6 × 800 m / 90 s rest". See structureText() for other languages. */
  structure: string;
  sets: RepSet[];
  /** One entry per rep when the session is too varied to group (pyramids, ladders); otherwise null. */
  sequence: RepSpec[] | null;
  /** Typical recovery between reps, rounded (seconds). */
  restValue?: number;
}

export interface Detection {
  modeUsed: "signal" | "laps";
  modeReason: Msg;
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
  notes: Msg[];
  options: DetectOptions;
}
