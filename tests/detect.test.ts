import { describe, expect, it } from "vitest";
import { parseFit } from "../src/fit/parse";
import { analyseActivity, detect } from "../src/analysis/detect";
import { buildSeries } from "../src/analysis/timeseries";
import { encodeFit, synthesize, WORKOUTS } from "../src/sample/synth";
import { noteText, score } from "./helpers";

describe("FIT round trip", () => {
  it("encodes a synthetic session and parses it back with the real decoder", () => {
    const { activity } = synthesize({ steps: WORKOUTS["6x800"](), seed: 3, autoPause: true });
    const bytes = encodeFit(activity);
    const parsed = parseFit(bytes);

    expect(parsed.sport).toBe("running");
    expect(parsed.records.length).toBe(activity.records.length);
    expect(parsed.laps.length).toBe(activity.laps.length);
    expect(parsed.laps[1].intensity).toBe("active");
    expect(parsed.laps[2].intensity).toBe("recovery");
    expect(parsed.laps[0].intensity).toBe("warmup");
    expect(parsed.pauses.length).toBe(activity.pauses.length);
    expect(parsed.totalDistance).toBeCloseTo(activity.totalDistance, 0);
    expect(parsed.records[100].distance).toBeCloseTo(activity.records[100].distance!, 1);
    expect(parsed.records[100].cadence).toBeGreaterThan(100); // spm, not rpm
  });

  it("rejects non-FIT data with a readable error", () => {
    expect(() => parseFit(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]))).toThrow(/FIT/);
  });

  it("detects intervals end-to-end from file bytes", () => {
    const { activity, truth } = synthesize({ steps: WORKOUTS["8x400"](), seed: 11, lapMode: "none" });
    const { detection } = analyseActivity(parseFit(encodeFit(activity)), { mode: "signal" });
    const s = score(truth, detection);
    expect(s.exactCount).toBe(true);
    expect(detection.summary?.structure).toMatch(/^8 × /);
  });
});

describe("signal detection", () => {
  it("finds every rep, with warm-up, rests and cool-down labelled", () => {
    const { activity } = synthesize({ steps: WORKOUTS["6x800"](), seed: 2, lapMode: "none" });
    const { detection } = analyseActivity(activity, { mode: "signal" });
    expect(detection.modeUsed).toBe("signal");
    const kinds = detection.segments.map((s) => s.kind);
    expect(kinds[0]).toBe("warmup");
    expect(kinds[kinds.length - 1]).toBe("cooldown");
    expect(kinds.filter((k) => k === "work")).toHaveLength(6);
    expect(kinds.filter((k) => k === "rest")).toHaveLength(5);
    // alternate strictly in the middle
    const middle = kinds.slice(1, -1);
    middle.forEach((k, i) => expect(k).toBe(i % 2 === 0 ? "work" : "rest"));
  });

  it("measures rep distance within 1 % and pace within 1 s/km on a clean session", () => {
    const { activity, truth } = synthesize({ steps: WORKOUTS["6x800"](), seed: 4, lapMode: "none", gpsNoise: 0.06 });
    const { detection } = analyseActivity(activity, { mode: "signal" });
    const reps = detection.reps;
    expect(reps).toHaveLength(6);
    reps.forEach((r) => {
      expect(Math.abs(r.distance - 800) / 800).toBeLessThan(0.01);
      expect(Math.abs(1000 / r.avgSpeed - 200)).toBeLessThan(3);
    });
    expect(score(truth, detection).exactCount).toBe(true);
  });

  it("treats auto-paused standing rests as rest segments with their full duration", () => {
    const { activity } = synthesize({ steps: WORKOUTS["6x800"](), seed: 6, lapMode: "none", autoPause: true });
    expect(activity.pauses.length).toBeGreaterThanOrEqual(5);
    const { detection } = analyseActivity(activity, { mode: "signal" });
    const rests = detection.segments.filter((s) => s.kind === "rest");
    expect(rests).toHaveLength(5);
    for (const r of rests) {
      expect(r.duration).toBeGreaterThan(80);
      expect(r.duration).toBeLessThan(100); // 90 s planned
      expect(r.paused).toBeGreaterThan(60);
      expect(r.distance).toBeLessThan(40);
    }
  });

  it("is not fooled by a variable-distance pyramid", () => {
    const { activity } = synthesize({ steps: WORKOUTS.pyramid(), seed: 8, lapMode: "none" });
    const { detection } = analyseActivity(activity, { mode: "signal" });
    expect(detection.reps.map((r) => Math.round(r.distance / 100) * 100)).toEqual([400, 800, 1200, 800, 400]);
    expect(detection.summary!.sets).toHaveLength(5);
  });

  it("finds time-based fartlek reps", () => {
    const { activity } = synthesize({ steps: WORKOUTS.fartlek(), seed: 9, lapMode: "none" });
    const { detection } = analyseActivity(activity, { mode: "signal" });
    expect(detection.reps).toHaveLength(8);
    detection.reps.forEach((r) => expect(Math.abs(r.duration - 120)).toBeLessThan(3));
    expect(detection.summary!.structure).toBe("8 × 2 min / 60 s rest");
  });

  it("separates hill reps from the jog down only with grade-adjusted pace", () => {
    const { activity } = synthesize({ steps: WORKOUTS.hills(), seed: 1, lapMode: "none" });
    const gap = analyseActivity(activity, { mode: "signal", signal: "gap" }).detection;
    expect(gap.reps).toHaveLength(6);
    gap.reps.forEach((r) => expect(Math.abs(r.duration - 90)).toBeLessThan(6));
    expect(gap.reps[0].avgGrade!).toBeGreaterThan(5);
    // Plain pace gets it backwards: the jog down is faster than the climb.
    const plain = analyseActivity(activity, { mode: "signal", signal: "speed" }).detection;
    const plainMatchesTruth = plain.reps.length === 6 && plain.reps.every((r) => Math.abs(r.duration - 90) < 6);
    expect(plainMatchesTruth).toBe(false);
  });

  it("auto pace type switches to grade-adjusted pace on a hilly route only", () => {
    const hills = synthesize({ steps: WORKOUTS.hills(), seed: 1, lapMode: "none" }).activity;
    const auto = analyseActivity(hills, { mode: "signal" }).detection; // signal: "auto" is the default
    expect(auto.signalUsed).toBe("gap");
    expect(auto.reps).toHaveLength(6);
    expect(noteText(auto)).toMatch(/Hilly route/);

    const flat = synthesize({ steps: WORKOUTS["8x400"](), seed: 1, lapMode: "none" }).activity;
    expect(analyseActivity(flat, { mode: "signal" }).detection.signalUsed).toBe("speed");
  });

  it("reports no intervals for a steady run", () => {
    const { activity } = synthesize({
      steps: [{ kind: "warmup", distance: 8000, pace: 330 }],
      seed: 1,
      lapMode: "none",
    });
    const { detection } = analyseActivity(activity, { mode: "signal" });
    expect(detection.intervalsFound).toBe(false);
    expect(detection.reps).toHaveLength(0);
    expect(detection.summary).toBeNull();
    expect(detection.segments).toHaveLength(1);
  });

  it("reports no intervals for a progression run (slow drift, no alternation)", () => {
    const steps = Array.from({ length: 16 }, (_, i) => ({ kind: "warmup" as const, distance: 500, pace: 360 - i * 3 }));
    const { activity } = synthesize({ steps, seed: 2, lapMode: "none" });
    const { detection } = analyseActivity(activity, { mode: "signal" });
    expect(detection.intervalsFound).toBe(false);
  });

  it("sensitivity and minimum-length options change the outcome sensibly", () => {
    const { activity } = synthesize({ steps: WORKOUTS["12x200"](), seed: 5, lapMode: "none" });
    const series = buildSeries(activity);
    expect(detect(activity, series, { mode: "signal" }).reps).toHaveLength(12);
    // a 60 s minimum rep length rejects all 200 m reps (~35 s)
    expect(detect(activity, series, { mode: "signal", minWorkSec: 60 }).reps).toHaveLength(0);
  });

  it("honours a manual work/rest threshold", () => {
    const { activity } = synthesize({ steps: WORKOUTS["8x400"](), seed: 5, lapMode: "none" });
    const series = buildSeries(activity);
    // threshold above every speed: no work at all
    expect(detect(activity, series, { mode: "signal", thresholdSpeed: 9 }).reps).toHaveLength(0);
    // threshold between warm-up (2.9 m/s) and reps (5.2 m/s): same as automatic
    expect(detect(activity, series, { mode: "signal", thresholdSpeed: 4 }).reps).toHaveLength(8);
  });
});

describe("lap detection", () => {
  it("uses structured-workout laps (intensity) as ground truth", () => {
    const { activity } = synthesize({ steps: WORKOUTS["6x800"](), seed: 2, lapMode: "workout" });
    const { detection } = analyseActivity(activity, { mode: "auto" });
    expect(detection.modeUsed).toBe("laps");
    expect(detection.reps).toHaveLength(6);
    expect(detection.segments.map((s) => s.kind)[0]).toBe("warmup");
    detection.reps.forEach((r) => expect(r.source).toBe("lap"));
    // The watch ended each step at 800 m
    detection.reps.forEach((r) => expect(Math.abs(r.distance - 800)).toBeLessThan(12));
  });

  it("classifies manual lap-button laps by pace", () => {
    const { activity } = synthesize({ steps: WORKOUTS["8x400"](), seed: 3, lapMode: "manual" });
    const { detection } = analyseActivity(activity, { mode: "auto" });
    expect(detection.modeUsed).toBe("laps");
    expect(detection.reps).toHaveLength(8);
    expect(detection.segments.filter((s) => s.kind === "rest")).toHaveLength(7);
    expect(detection.threshold).toBeGreaterThan(3);
  });

  it("snaps jittery manual laps onto the real pace changes", () => {
    const sy = synthesize({ steps: WORKOUTS["8x400"](), seed: 3, lapMode: "manual", lapJitter: 4 });
    const series = buildSeries(sy.activity);
    const raw = detect(sy.activity, series, { mode: "laps", snapLaps: false });
    const snapped = detect(sy.activity, series, { mode: "laps", snapLaps: true });
    const err = (d: typeof raw) => {
      const s = score(sy.truth, d);
      return s.matched.reduce((a, m) => a + Math.abs(m.startErr) + Math.abs(m.endErr), 0) / (2 * s.matched.length);
    };
    expect(err(snapped)).toBeLessThan(err(raw));
    expect(err(snapped)).toBeLessThan(1.2);
  });

  it("snaps hand-pressed laps by default but never moves structured-workout laps", () => {
    const manual = synthesize({ steps: WORKOUTS["8x400"](), seed: 3, lapMode: "manual", lapJitter: 3 });
    const d = analyseActivity(manual.activity, { mode: "laps" }).detection; // snapLaps defaults to true
    expect(d.segments.some((sg) => sg.snapShift !== undefined)).toBe(true);
    const structured = synthesize({ steps: WORKOUTS["6x800"](), seed: 3, lapMode: "workout" });
    const s = analyseActivity(structured.activity, { mode: "laps" }).detection;
    expect(s.segments.every((sg) => sg.snapShift === undefined)).toBe(true);
  });

  it("ignores automatic per-km laps and falls back to the pace signal", () => {
    const { activity } = synthesize({ steps: WORKOUTS["8x400"](), seed: 3, lapMode: "auto-km" });
    const { detection } = analyseActivity(activity, { mode: "auto" });
    expect(detection.modeUsed).toBe("signal");
    expect(detection.reps).toHaveLength(8);
    expect(noteText(detection)).toMatch(/automatic splits/);
  });

  it("falls back to the signal when laps are requested but absent", () => {
    const { activity } = synthesize({ steps: WORKOUTS["8x400"](), seed: 3, lapMode: "none" });
    const { detection } = analyseActivity(activity, { mode: "laps" });
    expect(detection.modeUsed).toBe("signal");
    expect(noteText(detection)).toMatch(/Lap mode unavailable/);
  });
});

describe("summary", () => {
  it("describes the prescription and computes consistency metrics", () => {
    const steps = WORKOUTS["6x800"]().map((s, i, a) => {
      // rep 5 and 6 are slower: the athlete fades
      const repNo = a.slice(0, i + 1).filter((x) => x.kind === "work").length;
      return s.kind === "work" && repNo >= 5 ? { ...s, pace: 212 } : s;
    });
    const { activity } = synthesize({ steps, seed: 7, lapMode: "none", gpsNoise: 0.08 });
    const sum = analyseActivity(activity, { mode: "signal" }).detection.summary!;
    expect(sum.repCount).toBe(6);
    expect(sum.structure).toContain("6 × ");
    expect(sum.structure).toBe("6 × 800 m / 90 s rest");
    expect(sum.slowestRep).toBeGreaterThanOrEqual(4);
    expect(sum.fastestRep).toBeLessThan(4);
    expect(sum.paceSpreadSecPerKm).toBeGreaterThan(8);
    expect(sum.firstToLastPct).toBeLessThan(-3);
    expect(sum.paceTrendSecPerKmPerRep).toBeGreaterThan(0);
    expect(sum.avgRestTime).toBeGreaterThan(80);
    expect(sum.workRestRatio).toBeGreaterThan(0.5);
    expect(sum.avgWorkHr).toBeGreaterThan(150);
    expect(sum.avgHrRecovery).toBeGreaterThan(5);
  });
});

describe("grade-adjusted pace", () => {
  const worst = (flat: boolean, altitudeNoise = 0) => {
    let max = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const { activity } = synthesize({ steps: WORKOUTS["6x800"](), seed, lapMode: "none" });
      let rng = seed * 7919;
      const rnd = () => ((rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 2;
      activity.records.forEach((r) => {
        if (flat && r.altitude !== undefined) r.altitude = 120 + altitudeNoise * rnd();
      });
      for (const sg of analyseActivity(activity, { mode: "signal" }).detection.segments) {
        if (sg.avgSpeed < 0.5) continue;
        max = Math.max(max, Math.abs(1000 / sg.avgGapSpeed - 1000 / sg.avgSpeed));
      }
    }
    return max;
  };

  it("equals the pace on a perfectly flat route", () => {
    expect(worst(true, 0)).toBeLessThan(0.05); // s/km
  });

  it("stays within a second per km of the pace when the altimeter is noisy but the route is flat", () => {
    expect(worst(true, 0.4)).toBeLessThan(1);
  });

  it("differs clearly from the pace on a real hill", () => {
    const { activity } = synthesize({ steps: WORKOUTS.hills(), seed: 1, lapMode: "none" });
    const rep = analyseActivity(activity, { mode: "signal" }).detection.reps[0];
    expect(1000 / rep.avgSpeed - 1000 / rep.avgGapSpeed).toBeGreaterThan(60); // climbing: GAP much faster
  });
});

describe("workout description", () => {
  const describeOf = (workout: keyof typeof WORKOUTS, seed = 1) =>
    analyseActivity(synthesize({ steps: WORKOUTS[workout](), seed, lapMode: "none" }).activity, { mode: "signal" }).detection.summary!
      .structure;

  it("prefers metric track distances over mile fractions", () => {
    expect(describeOf("8x400")).toBe("8 × 400 m / 75 s rest");
    expect(describeOf("12x200")).toBe("12 × 200 m / 45 s rest");
  });

  it("describes time-based sessions by time", () => {
    expect(describeOf("fartlek")).toBe("8 × 2 min / 60 s rest");
    // hill boundaries are good to ~1.4 s, so a 100 s rest may be reported as 100 or 105 s
    expect(describeOf("hills")).toMatch(/^6 × 90 s \/ 10[05] s rest$/);
  });

  it("writes pyramids as the sequence of distances", () => {
    expect(describeOf("pyramid")).toBe("400 m · 800 m · 1.2 km · 800 m · 400 m / 2 min rest");
  });
});

describe("robustness", () => {
  it("copes with smart-recording gaps (records every 1-4 s)", () => {
    const { activity, truth } = synthesize({ steps: WORKOUTS["8x400"](), seed: 12, lapMode: "none" });
    const thinned = activity.records.filter((r, i) => i === 0 || i % 3 === 0 || (r.t % 7 === 0));
    activity.records = thinned;
    const { detection } = analyseActivity(activity, { mode: "signal" });
    const s = score(truth, detection);
    expect(s.matched.length).toBe(8);
    s.matched.forEach((m) => expect(Math.abs(m.distErrPct)).toBeLessThan(3));
  });

  it("works without device speed (derived from distance)", () => {
    const { activity, truth } = synthesize({ steps: WORKOUTS["8x400"](), seed: 13, lapMode: "none" });
    activity.records.forEach((r) => delete r.speed);
    const { series, detection } = analyseActivity(activity, { mode: "signal" });
    expect(series.speedFromDevice).toBe(false);
    expect(score(truth, detection).matched.length).toBe(8);
  });

  it("works without heart rate, cadence or altitude", () => {
    const { activity } = synthesize({ steps: WORKOUTS["8x400"](), seed: 14, lapMode: "none" });
    activity.records.forEach((r) => {
      delete r.heartRate;
      delete r.cadence;
      delete r.altitude;
    });
    const { detection } = analyseActivity(activity, { mode: "signal", signal: "gap" });
    expect(detection.reps).toHaveLength(8);
    expect(detection.reps[0].avgHr).toBeUndefined();
    expect(noteText(detection)).toMatch(/No altitude/);
  });
});
