import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyseActivity, rebuild } from "../src/analysis/detect";
import { measureCooper } from "../src/analysis/cooper";
import { buildSeries, distanceAt } from "../src/analysis/timeseries";
import { parseFit } from "../src/fit/parse";
import { synthesize, WORKOUTS, type StepSpec, type SynthOptions } from "../src/sample/synth";

const TAU = 1.8; // the simulator's default athlete response
const W = (pace: number, duration = 360): StepSpec => ({ kind: "work", duration, pace });
const warm: StepSpec = { kind: "warmup", duration: 600, pace: 345 };
const cool: StepSpec = { kind: "cooldown", duration: 600, pace: 380 };
const jog = (duration: number): StepSpec => ({ kind: "rest", duration, pace: 420 });

/** Warm-up, a pause, six minutes flat out, cool-down. */
const test = (pace: number, extra: StepSpec[] = [], duration = 360): StepSpec[] => [warm, ...extra, jog(120), W(pace, duration), cool];

/** `which` picks the test among the session's hard steps (default: the last one). */
function analyse(steps: StepSpec[], o: Partial<SynthOptions> = {}, seed = 3, which = -1) {
  const { activity, truth } = synthesize({ steps, seed, lapMode: "none", ...o });
  const { series, detection } = analyseActivity(activity, { mode: "auto" });
  // the six minutes start when the athlete is told to go, i.e. a little before his speed crosses half-way
  const work = truth.filter((t) => t.kind === "work");
  const T = work.at(which)!.start - TAU * Math.LN2;
  return { activity, series, detection, T, trueDistance: distanceAt(series, T + 360) - distanceAt(series, T) };
}

describe("half-Cooper test detection", () => {
  it.each([
    ["3:30/km", 210],
    ["4:00/km", 240],
    ["5:00/km", 300],
  ])("finds a test run at %s and estimates the VMA from the distance", (_label, pace) => {
    const { detection, T, trueDistance } = analyse(test(pace));
    const c = detection.cooper;
    expect(c, "test found").toBeDefined();
    expect(Math.abs(c!.start - T)).toBeLessThan(2);
    expect(Math.abs(c!.distance - trueDistance) / trueDistance).toBeLessThan(0.005);
    expect(c!.vma).toBeCloseTo(c!.distance / 100, 9);
    expect(c!.vma).toBeCloseTo(3.6 / (pace / 1000), 0);
    expect(c!.vo2max).toBeCloseTo(3.5 * c!.vma, 9);
    expect(c!.vmaPace).toBeCloseTo(3600 / c!.vma, 6);
    expect(c!.splits).toHaveLength(6);
    expect(c!.splits.reduce((a, b) => a + b, 0)).toBeCloseTo(c!.distance, 6);
  });

  it("shows the session as warm-up / test / cool-down, not as intervals", () => {
    const { detection } = analyse(test(250));
    expect(detection.segments.map((s) => s.kind)).toEqual(["warmup", "work", "cooldown"]);
    expect(detection.reps).toHaveLength(1);
    expect(detection.intervalsFound).toBe(false);
    expect(detection.reps[0].duration).toBeCloseTo(360, 6);
    expect(detection.reps[0].distance).toBeCloseTo(detection.cooper!.distance, 6);
  });

  it("copes with strides in the warm-up, GPS noise, device smoothing and a slow athlete", () => {
    const strides: StepSpec[] = [0, 1, 2, 3].flatMap((): StepSpec[] => [W(230, 20), { kind: "rest", duration: 40, pace: 380 }]);
    for (const [label, steps, o] of [
      ["strides", test(250, strides), {}],
      ["noisy GPS", test(250), { gpsNoise: 0.3, spikeRate: 0.01 }],
      ["smoothing", test(250), { deviceSmoothing: 3.5 }],
      ["slow athlete", test(250), { athleteTau: 4 }],
    ] as Array<[string, StepSpec[], Partial<SynthOptions>]>) {
      for (const seed of [1, 2, 3]) {
        const { detection, trueDistance } = analyse(steps, o, seed);
        const c = detection.cooper;
        expect(c, `${label}, seed ${seed}`).toBeDefined();
        expect(Math.abs(c!.distance - trueDistance) / trueDistance, `${label}, seed ${seed}`).toBeLessThan(0.01);
      }
    }
  });

  it("is not thrown by standing then jogging before the start, even with auto-pause", () => {
    const steps: StepSpec[] = [warm, { kind: "rest", duration: 60, pace: 0 }, { kind: "rest", duration: 10, pace: 400 }, W(250), cool];
    for (const autoPause of [false, true]) {
      const { detection, T, trueDistance } = analyse(steps, { autoPause });
      expect(detection.cooper, `autoPause ${autoPause}`).toBeDefined();
      expect(Math.abs(detection.cooper!.start - T)).toBeLessThan(3);
      expect(Math.abs(detection.cooper!.distance - trueDistance) / trueDistance).toBeLessThan(0.01);
    }
  });

  it("works when the recording stops soon after the test", () => {
    for (const after of [10, 40]) {
      const { detection, trueDistance } = analyse([warm, jog(90), W(250), { kind: "cooldown", duration: after, pace: 380 }]);
      expect(detection.cooper, `${after} s after`).toBeDefined();
      expect(Math.abs(detection.cooper!.distance - trueDistance) / trueDistance).toBeLessThan(0.01);
    }
  });

  it("accepts a fast start that fades, and reports it", () => {
    const { detection } = analyse([warm, jog(90), W(232, 120), W(258, 240), cool], {}, 3, 0);
    expect(detection.cooper).toBeDefined();
    expect(detection.cooper!.fadePct).toBeGreaterThan(5);
  });

  it("takes the start from a 6:00 lap recorded by the watch", () => {
    const { activity } = synthesize({ steps: test(250), seed: 3, lapMode: "workout" });
    const { detection } = analyseActivity(activity, { mode: "auto" });
    const lap = activity.laps.find((l) => Math.abs(l.end - l.start - 360) <= 1)!;
    expect(lap).toBeDefined();
    expect(detection.cooper!.fromLap).toBe(true);
    expect(detection.cooper!.start).toBeCloseTo(lap.start, 6);
  });

  it("is a half-Cooper only: no other duration, no interval session, no steady run, no other sport", () => {
    const none = (label: string, steps: StepSpec[], o: Partial<SynthOptions> = {}) =>
      expect(analyse(steps, o).detection.cooper, label).toBeUndefined();
    none("5 min effort", test(250, [], 300));
    none("8 min effort", test(250, [], 480));
    none("12 min effort", test(250, [], 720));
    none("4 x 6 min", [warm, ...[0, 1, 2, 3].flatMap((): StepSpec[] => [W(255), { kind: "rest", duration: 180, pace: 400 }]), cool]);
    none("2 x 6 min", [warm, ...[0, 1].flatMap((): StepSpec[] => [W(255), { kind: "rest", duration: 180, pace: 400 }]), cool]);
    none("6 x (1 min / 1 min)", [warm, ...[0, 1, 2].flatMap((): StepSpec[] => [W(230, 60), jog(60), W(230, 60), jog(60)]), cool]);
    none("steady tempo run", [{ ...warm, pace: 330 }, W(300, 1200), { ...cool, pace: 330 }]);
    none("no warm-up recorded", [W(250), cool]);
    for (const name of ["6x800", "8x400", "pyramid", "fartlek", "hills", "12x200"] as const) none(name, WORKOUTS[name]());
    const ride = synthesize({ steps: test(250), seed: 3, lapMode: "none", sport: "cycling" }).activity;
    expect(analyseActivity(ride).detection.cooper, "cycling").toBeUndefined();
  });

  it("follows the effort when its start is moved by hand", () => {
    const { series, detection } = analyse(test(250));
    const specs = detection.segments.map((s) => ({ start: s.start, end: s.end, kind: s.kind, source: s.source }));
    specs[0].end += 3;
    specs[1].start += 3;
    specs[1].end += 3;
    specs[2].start += 3;
    const moved = rebuild(series, specs, detection);
    expect(moved.cooper!.start).toBeCloseTo(detection.cooper!.start + 3, 6);
    expect(moved.cooper!.distance).not.toBeCloseTo(detection.cooper!.distance, 0);
    expect(moved.cooper!.vma).toBeCloseTo(moved.cooper!.distance / 100, 9);
    // turning the effort into something else ends the test
    specs[1].kind = "rest";
    expect(rebuild(series, specs, detection).cooper).toBeUndefined();
  });

  it("measures any six-minute window", () => {
    const { activity } = synthesize({ steps: test(240), seed: 3, lapMode: "none" });
    const series = buildSeries(activity);
    const c = measureCooper(series, 700);
    expect(c.end).toBe(1060);
    expect(c.distance).toBeCloseTo(distanceAt(series, 1060) - distanceAt(series, 700), 9);
    expect(c.vma).toBeCloseTo(c.distance / 100, 9);
  });

  it("finds the test in the shipped sample file", () => {
    const activity = parseFit(new Uint8Array(readFileSync(new URL("../samples/half-cooper-test.fit", import.meta.url))));
    const c = analyseActivity(activity).detection.cooper;
    expect(c).toBeDefined();
    expect(c!.vma).toBeGreaterThan(14.3);
    expect(c!.vma).toBeLessThan(14.5); // 4:10 per km is 14.4 km/h
  });
});
