import { describe, expect, it } from "vitest";
import { analyseActivity } from "../src/analysis/detect";
import { findTrack } from "../src/analysis/track";
import { buildSeries, distanceAt } from "../src/analysis/timeseries";
import { synthesize, WORKOUTS, ovalPoint, type StepSpec, type SynthOptions } from "../src/sample/synth";

const W = (pace: number, duration = 360): StepSpec => ({ kind: "work", duration, pace });
const jog = (duration: number, pace = 420): StepSpec => ({ kind: "rest", duration, pace });
const cooperSession: StepSpec[] = [{ kind: "warmup", duration: 600, pace: 345 }, jog(120), W(250), { kind: "cooldown", duration: 600, pace: 380 }];

/** A session on a 333 m track whose watch counts 400 m a lap. */
const onTrack = (steps: StepSpec[], o: Partial<SynthOptions> = {}, track: SynthOptions["track"] = { length: 333, recordedLap: 400 }, seed = 3) =>
  synthesize({ steps, seed, lapMode: "none", track, ...o });
const keys = (d: { notes: { key: string }[] }) => d.notes.map((n) => n.key);

describe("running track", () => {
  it("the simulated oval is one lap long", () => {
    for (const length of [333, 400]) {
      let total = 0;
      let prev = ovalPoint(0, length);
      for (let d = 0.5; d <= length + 0.01; d += 0.5) {
        const p = ovalPoint(d, length);
        total += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
        prev = p;
      }
      expect(total / length).toBeGreaterThan(0.995);
      expect(total / length).toBeLessThan(1.005);
    }
  });

  it("recognises the watch's 400 m laps and says the track is probably shorter, by the recorded speed", () => {
    const { activity } = onTrack(WORKOUTS["6x800"]());
    const { series, detection } = analyseActivity(activity);
    expect(series.track).toBeDefined();
    expect(series.track!.recordedLap).toBeGreaterThan(398);
    expect(series.track!.recordedLap).toBeLessThan(402);
    expect(series.track!.laps).toBeGreaterThanOrEqual(5);
    expect(series.track!.appliedLength).toBeUndefined();
    expect(series.track!.speedLap!).toBeGreaterThan(325);
    expect(series.track!.speedLap!).toBeLessThan(341);
    const note = detection.notes.find((n) => n.key === "note.trackSuspect");
    expect(note, "a warning").toBeDefined();
    expect(Math.abs(Number(note!.params!.est) - 333)).toBeLessThan(8);
    // the general speed/distance note is replaced by this one
    expect(keys(detection).some((k) => k === "note.speedLower")).toBe(false);
  });

  it("rescales distance and pace to the length entered", () => {
    const { activity, truth } = onTrack(WORKOUTS["6x800"]());
    const raw = analyseActivity(activity, { mode: "signal" });
    const fixed = analyseActivity(activity, { mode: "signal" }, { trackLength: 333 });
    const total = truth.reduce((s, t) => s + t.distance, 0);
    expect(raw.series.dist[raw.series.n - 1] / total).toBeGreaterThan(1.18);
    expect(Math.abs(fixed.series.dist[fixed.series.n - 1] / total - 1)).toBeLessThan(0.01);
    expect(fixed.series.track!.appliedLength).toBe(333);
    expect(keys(fixed.detection)).toContain("note.trackApplied");
    expect(keys(fixed.detection)).not.toContain("note.trackSuspect");
    // 6 x 800 m again, not 6 x 960 m
    expect(fixed.detection.reps).toHaveLength(6);
    fixed.detection.reps.forEach((r) => expect(Math.abs(r.distance - 800) / 800).toBeLessThan(0.03));
    expect(fixed.detection.summary!.structure).toBe("6 × 800 m / 90 s rest");
    expect(raw.detection.reps[0].distance).toBeGreaterThan(900);
    // and the speed channel and the distance now agree
    expect(Math.abs(fixed.series.speedRatio - 1)).toBeLessThan(0.03);
  });

  it("gives the half-Cooper VMA from the real track, not from the watch's 400 m laps", () => {
    const { activity, truth } = onTrack(cooperSession);
    const raw = analyseActivity(activity).detection.cooper!;
    const fixed = analyseActivity(activity, {}, { trackLength: 333 });
    const T = truth.filter((t) => t.kind === "work")[0].start - 1.8 * Math.LN2;
    const exact = buildSeries(synthesize({ steps: cooperSession, seed: 3, lapMode: "none" }).activity); // the same run, honest distance
    const trueD = distanceAt(exact, T + 360) - distanceAt(exact, T);
    expect(raw.vma).toBeGreaterThan(1.15 * (trueD / 100));
    expect(Math.abs(fixed.detection.cooper!.vma - trueD / 100) / (trueD / 100)).toBeLessThan(0.02);
  });

  it("leaves a real 400 m track alone, with or without the length", () => {
    const { activity } = onTrack(WORKOUTS["6x800"](), {}, { length: 400, recordedLap: 400 });
    const plain = analyseActivity(activity);
    expect(plain.series.track).toBeDefined();
    expect(keys(plain.detection)).not.toContain("note.trackSuspect");
    const same = analyseActivity(activity, {}, { trackLength: 400 });
    expect(same.series.track!.appliedLength).toBeUndefined();
    expect(same.series.dist[same.series.n - 1]).toBeCloseTo(plain.series.dist[plain.series.n - 1], 6);
  });

  it("says when the athlete ran in an outer lane (speed adds up to longer laps than the track)", () => {
    // the athlete covers 355 m a lap although the track is 333 m: lane 3 or so
    const { activity } = onTrack(WORKOUTS["6x800"](), {}, { length: 355, recordedLap: 400 });
    const { series, detection } = analyseActivity(activity, {}, { trackLength: 333 });
    expect(series.track!.appliedLength).toBe(333);
    expect(keys(detection)).toContain("note.trackLane");
  });

  it("does not take a run without positions, a road run or an exact-distance track for a watch in track mode", () => {
    const flat = synthesize({ steps: WORKOUTS["6x800"](), seed: 3, lapMode: "none" }).activity;
    expect(buildSeries(flat, { trackLength: 333 }).track).toBeUndefined();
    // exact distance on a 333 m track: laps of 333 m, not a track-mode lap length
    const exact = onTrack(WORKOUTS["6x800"](), {}, { length: 333 }).activity;
    const s = buildSeries(exact, { trackLength: 333 });
    expect(s.track).toBeUndefined();
    expect(s.dist[s.n - 1]).toBeCloseTo(buildSeries(exact).dist[s.n - 1], 6);
  });

  it("copes with poor GPS and a slow, smoothed speed channel", () => {
    for (const [label, o, gps] of [["noisy", { deviceSmoothing: 3 }, 4], ["noisy, other run", { gpsNoise: 0.2 }, 4]] as Array<[string, Partial<SynthOptions>, number]>) {
      const { activity, truth } = onTrack(WORKOUTS["6x800"](), o, { length: 333, recordedLap: 400, gpsNoise: gps }, label === "noisy" ? 3 : 8);
      const total = truth.reduce((s, t) => s + t.distance, 0);
      const fixed = analyseActivity(activity, { mode: "signal" }, { trackLength: 333 });
      expect(fixed.series.track, label).toBeDefined();
      expect(Math.abs(fixed.series.dist[fixed.series.n - 1] / total - 1), label).toBeLessThan(0.02);
    }
  });

  it("finds nothing on a short or position-less recording", () => {
    expect(findTrack([], new Float64Array(10), 10)).toBeNull();
  });
});
