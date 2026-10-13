import { isFootSport, type Activity } from "../fit/types";
import { msg } from "../i18n";
import { detectCooper, measureCooper } from "./cooper";
import { detectLaps } from "./laps";
import { measureAll } from "./measure";
import { DEFAULT_OPTIONS, type DetectOptions, type Detection, type SegmentSpec } from "./model";
import { detectSignal } from "./signal";
import { summarize } from "./summary";
import { buildSeries, hillShare, type Series, type SeriesOptions } from "./timeseries";

/** Share of moving time on slopes >= 4 % above which grade-adjusted pace is used in "auto". */
const HILLY_SHARE = 0.08;

export interface Analysis {
  series: Series;
  detection: Detection;
}

/** Decode-to-result in one call: build the 1 Hz series and detect intervals. */
export function analyseActivity(activity: Activity, options: Partial<DetectOptions> = {}, seriesOptions: SeriesOptions = {}): Analysis {
  const series = buildSeries(activity, seriesOptions);
  return { series, detection: detect(activity, series, options) };
}

/** Re-run detection with new options on an existing series (cheap). */
export function detect(activity: Activity, series: Series, partial: Partial<DetectOptions> = {}): Detection {
  const options: DetectOptions = { ...DEFAULT_OPTIONS, ...partial };
  const detection = detectIntervals(activity, series, options);

  // A session that is one six-minute effort between a warm-up and a cool-down is a half-Cooper test, not intervals.
  const cooper = isFootSport(activity.sport) ? detectCooper(series, activity.laps, options) : null;
  if (!cooper) return detection;
  const specs: SegmentSpec[] = [
    { start: 0, end: cooper.start, kind: "warmup", source: "signal" },
    { start: cooper.start, end: cooper.end, kind: "work", source: "signal" },
    { start: cooper.end, end: series.n - 1, kind: "cooldown", source: "signal" },
  ];
  return {
    ...assemble(series, specs, {
      modeUsed: "signal",
      signalUsed: detection.signalUsed,
      modeReason: msg("cooper.reason"),
      // what the interval search said about this session no longer applies
      notes: detection.notes.filter((n) => !n.key.startsWith("sig.") && !n.key.startsWith("lap.") && n.key !== "note.lapsNotUsed" && n.key !== "note.lapUnavailable"),
      options,
    }),
    cooper,
  };
}

function detectIntervals(activity: Activity, series: Series, options: DetectOptions): Detection {
  const notes = [...series.notes];

  let useGap = options.signal === "gap";
  if (options.signal === "auto" && hillShare(series) >= HILLY_SHARE) {
    useGap = true;
    notes.push(msg("note.hilly"));
  }
  if (useGap && !series.hasAltitude) {
    notes.push(msg("note.noAltitude"));
    useGap = false;
  }
  const signalUsed = useGap ? "gap" : "speed";
  const signal = useGap ? series.gapSpeed : series.speed;

  if (options.mode !== "signal") {
    const lap = detectLaps(activity.laps, activity.steps, series, signal, options);
    if (lap.informative) {
      return assemble(series, lap.specs, {
        modeUsed: "laps",
        signalUsed,
        modeReason: lap.reason,
        threshold: lap.threshold,
        separation: lap.separation,
        notes: [...notes, ...lap.notes],
        options,
      });
    }
    notes.push(msg(options.mode === "laps" ? "note.lapUnavailable" : "note.lapsNotUsed", { reason: lap.reason }));
  }

  const sig = detectSignal(series, signal, options);
  return assemble(series, sig.specs, {
    modeUsed: "signal",
    signalUsed,
    modeReason: msg("sig.reason"),
    threshold: sig.threshold,
    separation: sig.separation,
    notes: [...notes, ...sig.notes],
    options,
  });
}

/**
 * Recompute metrics, reps and summary from a list of segment specs. Used by
 * the detectors and by manual edits (moving a boundary, changing a type).
 */
export function assemble(
  series: Series,
  specs: SegmentSpec[],
  meta: Pick<Detection, "modeUsed" | "signalUsed" | "modeReason" | "notes" | "options"> &
    Partial<Pick<Detection, "threshold" | "separation">>,
): Detection {
  const segments = measureAll(series, specs, meta.options.paceBasis);
  const reps = segments.filter((s) => s.kind === "work");
  return {
    ...meta,
    segments,
    reps,
    summary: summarize(segments),
    intervalsFound: reps.length >= 2,
  };
}

/** Rebuild a detection after the user edited segment specs. */
export function rebuild(series: Series, specs: SegmentSpec[], previous: Detection): Detection {
  const d = assemble(series, specs, {
    modeUsed: previous.modeUsed,
    signalUsed: previous.signalUsed,
    modeReason: previous.modeReason,
    threshold: previous.threshold,
    separation: previous.separation,
    notes: previous.notes,
    options: previous.options,
  });
  // The test follows the effort it was found in: moving its start recomputes the six minutes.
  if (previous.cooper) {
    const was = previous.cooper;
    let effort: (typeof d.segments)[number] | undefined;
    let overlap = 0;
    for (const s of d.reps) {
      const o = Math.min(s.end, was.end) - Math.max(s.start, was.start);
      if (o > overlap) {
        overlap = o;
        effort = s;
      }
    }
    if (effort) d.cooper = measureCooper(series, effort.start, was.fromLap && Math.abs(effort.start - was.start) < 0.01);
  }
  return d;
}
