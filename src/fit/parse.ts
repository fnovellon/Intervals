import { Decoder, Stream } from "@garmin/fitsdk";
import type {
  Activity,
  LapIntensity,
  LapRecord,
  RecordPoint,
  TimeRange,
  WorkoutStep,
} from "./types";

type Mesg = Record<string, unknown>;

const FIT_EPOCH_OFFSET_S = 631_065_600;
const SEMICIRCLE_TO_DEG = 180 / 2 ** 31;
const FOOT_SPORTS = new Set(["running", "walking", "hiking"]);
const INTENSITIES = new Set<string>([
  "active",
  "rest",
  "warmup",
  "cooldown",
  "recovery",
  "interval",
  "other",
]);

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** FIT timestamps arrive as Date objects (or raw FIT-epoch seconds if conversion was off). */
function toMs(v: unknown): number | undefined {
  if (v instanceof Date) {
    const ms = v.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  const n = num(v);
  return n === undefined ? undefined : (n + FIT_EPOCH_OFFSET_S) * 1000;
}

function intensityOf(v: unknown): LapIntensity | undefined {
  const s = str(v);
  return s && INTENSITIES.has(s) ? (s as LapIntensity) : undefined;
}

/**
 * Decode a .fit file into a normalised Activity. Throws a readable Error when
 * the bytes are not a FIT activity with usable records.
 */
export function parseFit(input: ArrayBuffer | Uint8Array): Activity {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const stream = Stream.fromByteArray(Array.from(bytes));
  if (!Decoder.isFIT(stream)) {
    throw new Error("This does not look like a FIT file (missing .FIT header).");
  }

  const warnings: string[] = [];
  const decoder = new Decoder(stream);
  if (!decoder.checkIntegrity()) {
    warnings.push("FIT integrity check failed (truncated or corrupted file); using what could be decoded.");
  }

  let decoded: { messages: Record<string, Mesg[] | undefined>; errors: unknown[] };
  try {
    decoded = decoder.read({
      applyScaleAndOffset: true,
      expandSubFields: true,
      expandComponents: true,
      convertTypesToStrings: true,
      convertDateTimesToDates: true,
      includeUnknownData: false,
      mergeHeartRates: true,
    }) as unknown as typeof decoded;
  } catch (e) {
    throw new Error(`Could not decode FIT file: ${(e as Error).message}`);
  }
  const { messages, errors } = decoded;
  if (errors?.length) {
    warnings.push(`FIT decoder reported ${errors.length} issue(s); the file may be partially corrupt.`);
  }

  const rawRecords = (messages.recordMesgs ?? []).filter((m) => toMs(m.timestamp) !== undefined);
  if (rawRecords.length < 10) {
    throw new Error("No usable record data found. Is this an activity file (not a workout/course/settings file)?");
  }

  // --- pick the session (multisport files hold several) ------------------
  const sessions = messages.sessionMesgs ?? [];
  let session: Mesg | undefined = sessions[0];
  if (sessions.length > 1) {
    session =
      sessions.find((s) => str(s.sport) === "running") ??
      [...sessions].sort((a, b) => (num(b.totalDistance) ?? 0) - (num(a.totalDistance) ?? 0))[0];
    warnings.push(`File contains ${sessions.length} sessions; analysing the ${str(session?.sport) ?? "first"} one.`);
  }
  const sport = str(session?.sport) ?? "generic";
  const subSport = str(session?.subSport) ?? "generic";

  let sessionFromMs: number | undefined;
  let sessionToMs: number | undefined;
  if (sessions.length > 1 && session) {
    sessionFromMs = toMs(session.startTime);
    const el = num(session.totalElapsedTime);
    if (sessionFromMs !== undefined && el !== undefined) sessionToMs = sessionFromMs + (el + 2) * 1000;
  }
  const inSession = (ms: number | undefined) =>
    ms === undefined ||
    ((sessionFromMs === undefined || ms >= sessionFromMs - 1000) &&
      (sessionToMs === undefined || ms <= sessionToMs));

  const sessionRecords = rawRecords.filter((m) => inSession(toMs(m.timestamp)));
  const t0Ms = toMs(sessionRecords[0].timestamp)!;
  const rel = (ms: number) => (ms - t0Ms) / 1000;

  // --- records -------------------------------------------------------------
  const footLike = FOOT_SPORTS.has(sport);
  const records: RecordPoint[] = [];
  for (const m of sessionRecords) {
    const p: RecordPoint = { t: rel(toMs(m.timestamp)!) };
    const speed = num(m.enhancedSpeed) ?? num(m.speed);
    const alt = num(m.enhancedAltitude) ?? num(m.altitude);
    const cad = num(m.cadence);
    if (num(m.distance) !== undefined) p.distance = m.distance as number;
    if (speed !== undefined) p.speed = speed;
    if (num(m.heartRate) !== undefined && (m.heartRate as number) > 0) p.heartRate = m.heartRate as number;
    if (cad !== undefined) p.cadence = footLike ? (cad + (num(m.fractionalCadence) ?? 0)) * 2 : cad;
    if (num(m.power) !== undefined) p.power = m.power as number;
    if (alt !== undefined) p.altitude = alt;
    const lat = num(m.positionLat);
    const lon = num(m.positionLong);
    if (lat !== undefined && lon !== undefined && !(lat === 0 && lon === 0)) {
      p.lat = lat * SEMICIRCLE_TO_DEG;
      p.lon = lon * SEMICIRCLE_TO_DEG;
    }
    records.push(p);
  }
  records.sort((a, b) => a.t - b.t);
  // Drop duplicate timestamps (keep the last, it usually carries more fields).
  const dedup: RecordPoint[] = [];
  for (const r of records) {
    if (dedup.length && r.t - dedup[dedup.length - 1].t < 1e-6) dedup[dedup.length - 1] = r;
    else dedup.push(r);
  }

  // --- laps ----------------------------------------------------------------
  const laps: LapRecord[] = [];
  for (const m of messages.lapMesgs ?? []) {
    const startMs = toMs(m.startTime);
    if (startMs === undefined || !inSession(startMs)) continue;
    const elapsed = num(m.totalElapsedTime) ?? num(m.totalTimerTime);
    if (elapsed === undefined) continue;
    const start = Math.max(0, rel(startMs));
    const lap: LapRecord = {
      index: laps.length,
      start,
      end: start + elapsed,
      timerTime: num(m.totalTimerTime) ?? elapsed,
      distance: num(m.totalDistance) ?? 0,
    };
    const avgSpeed = num(m.enhancedAvgSpeed) ?? num(m.avgSpeed);
    if (avgSpeed !== undefined) lap.avgSpeed = avgSpeed;
    if (num(m.avgHeartRate) !== undefined) lap.avgHeartRate = m.avgHeartRate as number;
    if (num(m.maxHeartRate) !== undefined) lap.maxHeartRate = m.maxHeartRate as number;
    const intensity = intensityOf(m.intensity);
    if (intensity) lap.intensity = intensity;
    if (str(m.lapTrigger)) lap.trigger = str(m.lapTrigger);
    if (num(m.wktStepIndex) !== undefined) lap.stepIndex = m.wktStepIndex as number;
    laps.push(lap);
  }
  laps.sort((a, b) => a.start - b.start);
  laps.forEach((l, i) => (l.index = i));

  // --- timer stop/start events => pauses -------------------------------------
  const pauses: TimeRange[] = [];
  const events = [...(messages.eventMesgs ?? [])]
    .filter((m) => str(m.event) === "timer" && toMs(m.timestamp) !== undefined)
    .sort((a, b) => toMs(a.timestamp)! - toMs(b.timestamp)!);
  let openStop: number | undefined;
  for (const ev of events) {
    const type = str(ev.eventType);
    const t = rel(toMs(ev.timestamp)!);
    if (type === "start") {
      if (openStop !== undefined && t > openStop) pauses.push({ start: openStop, end: t });
      openStop = undefined;
    } else if (type && type.startsWith("stop")) {
      if (openStop === undefined) openStop = t;
    }
  }

  // --- structured workout steps -----------------------------------------------
  const steps: WorkoutStep[] = [];
  for (const m of messages.workoutStepMesgs ?? []) {
    const index = num(m.messageIndex) ?? steps.length;
    const step: WorkoutStep = { index };
    if (str(m.wktStepName)) step.name = str(m.wktStepName);
    const intensity = intensityOf(m.intensity);
    if (intensity) step.intensity = intensity;
    if (str(m.durationType)) step.durationType = str(m.durationType);
    const dur = step.durationType === "time" ? num(m.durationTime) : num(m.durationDistance);
    if (dur !== undefined) step.durationValue = dur;
    if (str(m.targetType)) step.targetType = str(m.targetType);
    if (step.targetType === "speed") {
      const lo = num(m.customTargetSpeedLow);
      const hi = num(m.customTargetSpeedHigh);
      if (lo !== undefined && hi !== undefined && lo > 0 && hi > 0) {
        step.targetSpeedLow = Math.min(lo, hi);
        step.targetSpeedHigh = Math.max(lo, hi);
      }
    }
    steps.push(step);
  }

  // --- totals ----------------------------------------------------------------
  const last = dedup[dedup.length - 1];
  const lastDistance = [...dedup].reverse().find((r) => r.distance !== undefined)?.distance;
  const totalElapsed = last.t;
  const totalTimer = num(session?.totalTimerTime) ?? totalElapsed;
  const totalDistance = num(session?.totalDistance) ?? lastDistance ?? 0;

  const fileId = (messages.fileIdMesgs ?? [])[0];
  const device = fileId
    ? [str(fileId.manufacturer), str(fileId.garminProduct) ?? (num(fileId.product) !== undefined ? String(fileId.product) : undefined)]
        .filter(Boolean)
        .join(" ") || undefined
    : undefined;

  if (!dedup.some((r) => r.speed !== undefined) && !dedup.some((r) => r.distance !== undefined)) {
    warnings.push("No speed or distance data in this file; pace-based detection is not possible.");
  }

  return {
    startTimeMs: t0Ms,
    sport,
    subSport,
    records: dedup,
    laps,
    pauses,
    steps,
    totalElapsed,
    totalTimer,
    totalDistance,
    device,
    warnings,
  };
}
