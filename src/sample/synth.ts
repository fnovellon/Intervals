/**
 * Synthetic interval workouts with known ground truth.
 *
 * Used by the unit tests, the precision benchmark and the in-app demo. The
 * simulation runs at 10 Hz (athlete + physics) and is then "recorded" at 1 Hz
 * the way a watch would: smoothed device speed, correlated GPS noise, rare
 * spikes, auto-pause at standing rests, lagged heart rate, barometric altitude.
 */
import { Encoder, Profile, type Mesg } from "@garmin/fitsdk";
import type { Activity, LapIntensity, LapRecord, RecordPoint, TimeRange } from "../fit/types";

export interface StepSpec {
  kind: "warmup" | "work" | "rest" | "cooldown";
  /** Step ends after this many metres run (work / warm-up / cool-down). */
  distance?: number;
  /** ...or after this many seconds (use for rests). */
  duration?: number;
  /** Target pace in seconds per km. 0 = stand still. */
  pace: number;
  /** Road grade as a fraction (0.06 = 6 %). */
  grade?: number;
}

export type LapMode = "workout" | "manual" | "auto-km" | "none";

export interface SynthOptions {
  steps: StepSpec[];
  seed?: number;
  lapMode?: LapMode;
  /** Std-dev of the GPS speed noise in m/s. */
  gpsNoise?: number;
  /** Time constant (s) of the device's speed smoothing. */
  deviceSmoothing?: number;
  /** Time constant (s) with which the athlete changes speed. */
  athleteTau?: number;
  /** Seconds between the beep (the step changes) and the athlete reacting to it. */
  reaction?: number;
  /** Probability per second of a GPS speed spike. */
  spikeRate?: number;
  /** Stop the timer while standing still (auto-pause). */
  autoPause?: boolean;
  /** Std-dev (s) of the lap-button press error in "manual" mode. */
  lapJitter?: number;
  /**
   * Where the ground-truth boundary sits. "crossing": the athlete's speed passes
   * half-way (right for flat efforts). "command": the instant the step switches
   * (right for hills, where the terrain, not the athlete, defines the boundary).
   */
  truthAt?: "crossing" | "command";
  /** Start time of the recording (epoch ms). */
  startMs?: number;
  sport?: string;
  subSport?: string;
}

export interface TruthSegment {
  kind: StepSpec["kind"];
  /** Time the step begins (seconds); see SynthOptions.truthAt. */
  start: number;
  end: number;
  /** Distance covered between start and end (metres, from the simulation). */
  distance: number;
}

export interface Synthetic {
  activity: Activity;
  truth: TruthSegment[];
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INTENSITY: Record<StepSpec["kind"], LapIntensity> = {
  warmup: "warmup",
  work: "active",
  rest: "recovery",
  cooldown: "cooldown",
};

export function synthesize(opts: SynthOptions): Synthetic {
  const rand = mulberry32(opts.seed ?? 1);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const gpsNoise = opts.gpsNoise ?? 0.12;
  const devTau = opts.deviceSmoothing ?? 1.5;
  const tau = opts.athleteTau ?? 1.8;
  const reaction = opts.reaction ?? 0;
  const spikeRate = opts.spikeRate ?? 0.002;
  const lapMode = opts.lapMode ?? "workout";
  const dt = 0.1;

  // ---- 10 Hz physics ----------------------------------------------------------
  const speed10: number[] = [];
  const dist10: number[] = [];
  const grade10: number[] = [];
  const stepOf10: number[] = [];
  const switchTimes: number[] = []; // time step k (k >= 1) began
  let v = 0;
  let d = 0;
  let stepIdx = 0;
  let stepT0 = 0;
  let stepD0 = 0;
  const alpha = 1 - Math.exp(-dt / tau);
  const switchLog: Array<[number, number]> = []; // [time the beep sounded, step index it started]
  for (let k = 0; stepIdx < opts.steps.length; k++) {
    const t = k * dt;
    const step = opts.steps[stepIdx];
    // The athlete follows the step that was in force `reaction` seconds ago.
    let seen = 0;
    for (const [when, idx] of switchLog) if (when <= t - reaction) seen = idx;
    const target = opts.steps[seen].pace > 0 ? 1000 / opts.steps[seen].pace : 0;
    if (k === 0) v = target; // start already at the first step's speed
    v += (target - v) * alpha;
    d += v * dt;
    speed10.push(v);
    dist10.push(d);
    grade10.push(step.grade ?? 0);
    stepOf10.push(stepIdx);
    const done =
      (step.distance !== undefined && d - stepD0 >= step.distance) ||
      (step.duration !== undefined && t + dt - stepT0 >= step.duration);
    if (done) {
      stepIdx++;
      stepT0 = t + dt;
      stepD0 = d;
      if (stepIdx < opts.steps.length) {
        switchTimes.push(t + dt);
        switchLog.push([t + dt, stepIdx]);
      }
    }
    if (k > 20 * 3600 * 10) throw new Error("synthesize: runaway simulation");
  }
  const totalT = (speed10.length - 1) * dt;

  // ---- ground truth: half-way crossings -------------------------------------------
  const lagToCrossing = opts.truthAt === "command" ? 0 : reaction + tau * Math.LN2;
  const crossing: number[] = [0, ...switchTimes.map((T) => T + lagToCrossing), totalT];
  const at10 = (t: number) => Math.min(dist10.length - 1, Math.max(0, Math.round(t / dt)));
  const truth: TruthSegment[] = opts.steps.map((s, i) => ({
    kind: s.kind,
    start: crossing[i],
    end: crossing[i + 1],
    distance: dist10[at10(crossing[i + 1])] - dist10[at10(crossing[i])],
  }));

  // ---- 1 Hz recording -------------------------------------------------------------
  const records: RecordPoint[] = [];
  const pauses: TimeRange[] = [];
  const nSec = Math.floor(totalT);
  const devAlpha = 1 - Math.exp(-1 / devTau);
  let reported = speed10[0];
  let noise = 0;
  let hr = 95;
  let alt = 120;
  let pausedSince: number | undefined;
  let standing = 0;
  let hasStarted = false;
  for (let i = 0; i <= nSec; i++) {
    const k = i * 10;
    const vTrue = speed10[k];
    noise = 0.6 * noise + Math.sqrt(1 - 0.36) * gpsNoise * gauss();
    let measured = Math.max(0, vTrue + noise);
    if (rand() < spikeRate) measured += (rand() < 0.5 ? -1 : 1) * (2.5 + rand() * 2);
    reported += (Math.max(0, measured) - reported) * devAlpha;

    const hrTarget = vTrue < 0.5 ? 95 : 105 + 17 * vTrue;
    hr += (hrTarget - hr) * (1 - Math.exp(-1 / 22));
    alt += grade10[k] * vTrue;

    if (opts.autoPause) {
      standing = vTrue < 0.5 ? standing + 1 : 0;
      if (pausedSince === undefined && hasStarted && standing >= 3) pausedSince = i;
      else if (pausedSince !== undefined && vTrue > 1.0) {
        pauses.push({ start: pausedSince, end: i });
        pausedSince = undefined;
        standing = 0;
      }
      if (pausedSince !== undefined) continue; // no records while the timer is stopped
    }
    if (vTrue > 1) hasStarted = true;

    const spm = 150 + 12 * Math.min(vTrue, 6) + 1.5 * gauss();
    records.push({
      t: i,
      distance: Math.round(dist10[k] * 100) / 100,
      speed: Math.round(Math.max(0, reported) * 1000) / 1000,
      heartRate: Math.round(hr + gauss()),
      cadence: vTrue < 0.5 ? 0 : Math.round(spm),
      altitude: Math.round((alt + 0.15 * gauss()) * 5) / 5,
    });
  }
  const totalDistance = dist10[dist10.length - 1];

  // ---- laps ---------------------------------------------------------------------------
  const laps: LapRecord[] = [];
  const addLap = (start: number, end: number, extra: Partial<LapRecord>) => {
    const s = Math.max(0, Math.round(start));
    const e = Math.max(s + 1, Math.round(end));
    const inside = records.filter((r) => r.t >= s && r.t < e);
    const d0 = nearestDistance(records, s);
    const d1 = nearestDistance(records, e);
    const hrs = inside.map((r) => r.heartRate!).filter(Boolean);
    laps.push({
      index: laps.length,
      start: s,
      end: e,
      timerTime: e - s,
      distance: d1 - d0,
      avgSpeed: e > s ? (d1 - d0) / (e - s) : 0,
      avgHeartRate: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : undefined,
      maxHeartRate: hrs.length ? Math.max(...hrs) : undefined,
      ...extra,
    });
  };
  const lastT = records[records.length - 1].t;
  if (lapMode === "workout") {
    const edges = [0, ...switchTimes, lastT];
    opts.steps.forEach((s, i) => addLap(edges[i], edges[i + 1], { intensity: INTENSITY[s.kind], trigger: "manual", stepIndex: i }));
  } else if (lapMode === "manual") {
    const sd = opts.lapJitter ?? 1.5;
    const edges = [0, ...switchTimes.map((T) => T + tau * Math.LN2 + sd * gauss()), lastT];
    for (let i = 0; i + 1 < edges.length; i++) addLap(edges[i], edges[i + 1], { intensity: "active", trigger: "manual" });
  } else if (lapMode === "auto-km") {
    let start = 0;
    let next = 1000;
    for (const r of records) {
      if ((r.distance ?? 0) >= next) {
        addLap(start, r.t, { intensity: "active", trigger: "distance" });
        start = r.t;
        next += 1000;
      }
    }
    addLap(start, lastT, { intensity: "active", trigger: "sessionEnd" });
  }

  const activity: Activity = {
    startTimeMs: opts.startMs ?? Date.UTC(2026, 4, 12, 17, 30, 0),
    sport: opts.sport ?? "running",
    subSport: opts.subSport ?? "generic",
    records,
    laps,
    pauses,
    steps: [],
    totalElapsed: lastT,
    totalTimer: lastT - pauses.reduce((s, p) => s + p.end - p.start, 0),
    totalDistance,
    device: "synthetic",
    warnings: [],
  };
  return { activity, truth };
}

function nearestDistance(records: RecordPoint[], t: number): number {
  let best = records[0];
  for (const r of records) if (Math.abs(r.t - t) < Math.abs(best.t - t)) best = r;
  return best.distance ?? 0;
}

// ---------------------------------------------------------------------------
// FIT encoding
// ---------------------------------------------------------------------------

/** Encode an Activity as a real FIT file (activity type). */
export function encodeFit(activity: Activity): Uint8Array {
  const enc = new Encoder();
  const send = (mesgNum: number, msg: Record<string, unknown>) => enc.onMesg(mesgNum, msg as Mesg);
  const ts = (t: number) => new Date(activity.startTimeMs + t * 1000);
  const foot = activity.sport === "running";

  send(Profile.MesgNum.FILE_ID, {
    type: "activity",
    manufacturer: "garmin",
    product: 3589,
    timeCreated: ts(0),
    serialNumber: 1234567,
  });
  send(Profile.MesgNum.EVENT, { timestamp: ts(0), event: "timer", eventType: "start", eventGroup: 0 });

  for (const r of activity.records) {
    const msg: Record<string, unknown> = { timestamp: ts(r.t) };
    if (r.distance !== undefined) msg.distance = r.distance;
    if (r.speed !== undefined) {
      msg.speed = r.speed;
      msg.enhancedSpeed = r.speed;
    }
    if (r.heartRate !== undefined) msg.heartRate = r.heartRate;
    if (r.cadence !== undefined) msg.cadence = foot ? Math.floor(r.cadence / 2) : r.cadence;
    if (r.altitude !== undefined) {
      msg.altitude = r.altitude;
      msg.enhancedAltitude = r.altitude;
    }
    if (r.power !== undefined) msg.power = r.power;
    send(Profile.MesgNum.RECORD, msg);
  }

  for (const p of activity.pauses) {
    send(Profile.MesgNum.EVENT, { timestamp: ts(p.start), event: "timer", eventType: "stopAll", eventGroup: 0 });
    send(Profile.MesgNum.EVENT, { timestamp: ts(p.end), event: "timer", eventType: "start", eventGroup: 0 });
  }

  for (const l of activity.laps) {
    const msg: Record<string, unknown> = {
      messageIndex: l.index,
      timestamp: ts(l.end),
      startTime: ts(l.start),
      totalElapsedTime: l.end - l.start,
      totalTimerTime: l.timerTime,
      totalDistance: l.distance,
      sport: activity.sport,
      lapTrigger: l.trigger ?? "manual",
    };
    if (l.avgSpeed !== undefined) {
      msg.avgSpeed = l.avgSpeed;
      msg.enhancedAvgSpeed = l.avgSpeed;
    }
    if (l.avgHeartRate !== undefined) msg.avgHeartRate = l.avgHeartRate;
    if (l.maxHeartRate !== undefined) msg.maxHeartRate = l.maxHeartRate;
    if (l.intensity) msg.intensity = l.intensity;
    if (l.stepIndex !== undefined) msg.wktStepIndex = l.stepIndex;
    send(Profile.MesgNum.LAP, msg);
  }

  const end = activity.totalElapsed;
  send(Profile.MesgNum.EVENT, { timestamp: ts(end), event: "timer", eventType: "stopAll", eventGroup: 0 });
  send(Profile.MesgNum.SESSION, {
    messageIndex: 0,
    timestamp: ts(end),
    startTime: ts(0),
    totalElapsedTime: end,
    totalTimerTime: activity.totalTimer,
    totalDistance: activity.totalDistance,
    sport: activity.sport,
    subSport: activity.subSport,
    firstLapIndex: 0,
    numLaps: activity.laps.length,
    event: "session",
    eventType: "stop",
  });
  send(Profile.MesgNum.ACTIVITY, {
    timestamp: ts(end),
    totalTimerTime: activity.totalTimer,
    numSessions: 1,
    type: "manual",
    event: "activity",
    eventType: "stop",
  });
  return enc.close();
}

// ---------------------------------------------------------------------------
// Ready-made workouts
// ---------------------------------------------------------------------------

const rep = (n: number, ...block: StepSpec[]): StepSpec[] => Array.from({ length: n }, () => block).flat();

export const WORKOUTS = {
  /** Classic track session: 6 x 800 m @ 3:20/km, 90 s standing rest. */
  "6x800": (): StepSpec[] => [
    { kind: "warmup", distance: 2000, pace: 345 },
    ...rep(6, { kind: "work", distance: 800, pace: 200 }, { kind: "rest", duration: 90, pace: 0 }).slice(0, -1),
    { kind: "cooldown", distance: 1500, pace: 360 },
  ],
  /** 8 x 400 m with a 200 m jog recovery. */
  "8x400": (): StepSpec[] => [
    { kind: "warmup", distance: 2500, pace: 340 },
    ...rep(8, { kind: "work", distance: 400, pace: 190 }, { kind: "rest", duration: 75, pace: 330 }).slice(0, -1),
    { kind: "cooldown", distance: 2000, pace: 350 },
  ],
  /** Pyramid: 400-800-1200-800-400 m with 2 min jog. */
  pyramid: (): StepSpec[] => [
    { kind: "warmup", distance: 2000, pace: 350 },
    ...[400, 800, 1200, 800, 400].flatMap((d, i, a) => [
      { kind: "work", distance: d, pace: 205 } as StepSpec,
      ...(i < a.length - 1 ? [{ kind: "rest", duration: 120, pace: 340 } as StepSpec] : []),
    ]),
    { kind: "cooldown", distance: 1500, pace: 360 },
  ],
  /** Time-based fartlek: 8 x 2 min hard / 1 min easy. */
  fartlek: (): StepSpec[] => [
    { kind: "warmup", duration: 600, pace: 350 },
    ...rep(8, { kind: "work", duration: 120, pace: 225 }, { kind: "rest", duration: 60, pace: 345 }).slice(0, -1),
    { kind: "cooldown", duration: 480, pace: 360 },
  ],
  /**
   * Hill repeats: 6 x 90 s up an 8 % hill, jog back down. The climb is *slower*
   * than the jog in raw pace, so only grade-adjusted pace separates them.
   */
  hills: (): StepSpec[] => [
    { kind: "warmup", duration: 720, pace: 350 },
    ...rep(
      6,
      { kind: "work", duration: 90, pace: 320, grade: 0.08 },
      { kind: "rest", duration: 100, pace: 300, grade: -0.08 },
    ).slice(0, -1),
    { kind: "cooldown", duration: 600, pace: 365 },
  ],
  /** Short, hard 200s with brief rests. */
  "12x200": (): StepSpec[] => [
    { kind: "warmup", distance: 2000, pace: 345 },
    ...rep(12, { kind: "work", distance: 200, pace: 170 }, { kind: "rest", duration: 45, pace: 360 }).slice(0, -1),
    { kind: "cooldown", distance: 1200, pace: 360 },
  ],
} satisfies Record<string, () => StepSpec[]>;

export type WorkoutName = keyof typeof WORKOUTS;
