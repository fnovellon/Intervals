import type { Activity } from "../fit/types";
import { msg } from "../i18n";
import { detectLaps } from "./laps";
import { measureAll } from "./measure";
import { DEFAULT_OPTIONS, type DetectOptions, type Detection, type SegmentSpec } from "./model";
import { detectSignal } from "./signal";
import { summarize } from "./summary";
import { buildSeries, hillShare, type Series } from "./timeseries";

/** Share of moving time on slopes >= 4 % above which grade-adjusted pace is used in "auto". */
const HILLY_SHARE = 0.08;

export interface Analysis {
  series: Series;
  detection: Detection;
}

/** Decode-to-result in one call: build the 1 Hz series and detect intervals. */
export function analyseActivity(activity: Activity, options: Partial<DetectOptions> = {}): Analysis {
  const series = buildSeries(activity);
  return { series, detection: detect(activity, series, options) };
}

/** Re-run detection with new options on an existing series (cheap). */
export function detect(activity: Activity, series: Series, partial: Partial<DetectOptions> = {}): Detection {
  const options: DetectOptions = { ...DEFAULT_OPTIONS, ...partial };
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
  const segments = measureAll(series, specs);
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
  return assemble(series, specs, {
    modeUsed: previous.modeUsed,
    signalUsed: previous.signalUsed,
    modeReason: previous.modeReason,
    threshold: previous.threshold,
    separation: previous.separation,
    notes: previous.notes,
    options: previous.options,
  });
}
