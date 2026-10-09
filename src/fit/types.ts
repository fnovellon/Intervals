import type { Msg } from "../i18n";

/** Normalised, SDK-independent representation of a Garmin activity. */

/** Seconds since the first record of the activity (wall-clock, pauses included). */
export type Seconds = number;

export interface RecordPoint {
  t: Seconds;
  /** Cumulative distance in metres. */
  distance?: number;
  /** Instantaneous speed in m/s (device-smoothed). */
  speed?: number;
  heartRate?: number;
  /** Steps/min for running-type sports, rpm otherwise. */
  cadence?: number;
  power?: number;
  altitude?: number;
  lat?: number;
  lon?: number;
}

export type LapIntensity =
  | "active"
  | "rest"
  | "warmup"
  | "cooldown"
  | "recovery"
  | "interval"
  | "other";

export interface LapRecord {
  index: number;
  start: Seconds;
  end: Seconds;
  timerTime: Seconds;
  distance: number;
  avgSpeed?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  intensity?: LapIntensity;
  /** manual | time | distance | positionLap | sessionEnd | ... */
  trigger?: string;
  /** Index of the structured-workout step this lap belongs to, if any. */
  stepIndex?: number;
}

export interface WorkoutStep {
  index: number;
  name?: string;
  intensity?: LapIntensity;
  durationType?: string;
  /** Seconds when durationType is "time", metres when "distance". */
  durationValue?: number;
  targetType?: string;
  /** m/s, only when targetType is "speed". */
  targetSpeedLow?: number;
  targetSpeedHigh?: number;
}

export interface TimeRange {
  start: Seconds;
  end: Seconds;
}

export interface Activity {
  /** Epoch milliseconds of t = 0. */
  startTimeMs: number;
  sport: string;
  subSport: string;
  records: RecordPoint[];
  laps: LapRecord[];
  /** Spans during which the timer was stopped (auto-pause, manual pause). */
  pauses: TimeRange[];
  steps: WorkoutStep[];
  totalElapsed: Seconds;
  totalTimer: Seconds;
  totalDistance: number;
  device?: string;
  warnings: Msg[];
}

export const RUNNING_SPORTS = new Set(["running", "walking", "hiking", "trail"]);

export function isFootSport(sport: string): boolean {
  return RUNNING_SPORTS.has(sport) || sport === "generic" || sport === "training";
}
