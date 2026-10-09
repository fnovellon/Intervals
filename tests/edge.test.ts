import { describe, expect, it } from "vitest";
import { detect } from "../src/analysis/detect";
import { EDGE_PRESETS } from "../src/analysis/model";
import { buildSeries } from "../src/analysis/timeseries";
import { synthesize, WORKOUTS } from "../src/sample/synth";

/**
 * Slow, first-order acceleration (time constant 8 s, ~25 s to get up to speed). For such a ramp the time
 * at which the effort has reached a share q is known exactly:
 *   a start (effort rising)  : command + tau * -ln(1 - q)
 *   an end  (effort falling) : command + tau *  ln(1 / q)
 */
const TAU = 8;
const sim = () => synthesize({ steps: WORKOUTS["8x400"](), seed: 3, lapMode: "none", athleteTau: TAU, gpsNoise: 0.05, deviceSmoothing: 0.8 });

describe("interval edges (startEffort / endEffort / reactionSec)", () => {
  const { activity, truth } = sim();
  const series = buildSeries(activity);
  const reps = truth.filter((t) => t.kind === "work");
  const command = (t: number) => t - TAU * Math.LN2; // the simulator's truth sits at q = 0.5
  const run = (o: { startEffort?: number; endEffort?: number; reactionSec?: number } = {}) =>
    detect(activity, series, { mode: "signal", ...EDGE_PRESETS.half, ...o }).reps;

  it("a higher start level starts later; a higher end level ends EARLIER (it is where the pace drops to)", () => {
    const lowStart = run({ startEffort: 0.25 });
    const mid = run();
    const highStart = run({ startEffort: 0.75 });
    const lowEnd = run({ endEffort: 0.25 });
    const highEnd = run({ endEffort: 0.75 });
    expect(mid).toHaveLength(8);
    for (let i = 0; i < 8; i++) {
      expect(lowStart[i].start).toBeLessThan(mid[i].start - 1);
      expect(highStart[i].start).toBeGreaterThan(mid[i].start + 1);
      expect(lowEnd[i].end).toBeGreaterThan(mid[i].end + 1);
      expect(highEnd[i].end).toBeLessThan(mid[i].end - 1);
    }
  });

  it("start and end can be set independently", () => {
    const base = run();
    const moved = run({ startEffort: 0.2 });
    for (let i = 0; i < 8; i++) expect(Math.abs(moved[i].end - base[i].end), `end of rep ${i + 1}`).toBeLessThan(0.5);
    const movedEnd = run({ endEffort: 0.8 });
    for (let i = 0; i < 8; i++) expect(Math.abs(movedEnd[i].start - base[i].start), `start of rep ${i + 1}`).toBeLessThan(0.5);
  });

  it.each([0.25, 0.75])("starts and ends land on the analytic crossing time for q = %s", (q) => {
    // Ends at a low q sit ~11 s into an exponential tail where pace changes by only a few % per second, so
    // they are the least certain edges: measured worst case 2.4 s on a ramp that takes ~25 s.
    const found = run({ startEffort: q, endEffort: q });
    const errs: number[] = [];
    reps.forEach((t, i) => {
      errs.push(found[i].start - (command(t.start) + TAU * -Math.log(1 - q)));
      errs.push(found[i].end - (command(t.end) + TAU * Math.log(1 / q)));
    });
    expect(Math.max(...errs.map(Math.abs)), `errors ${errs.map((e) => e.toFixed(1)).join(" ")}`).toBeLessThan(3);
  });

  it("the reaction time moves both edges earlier by exactly that much", () => {
    const base = run();
    const lead = run({ reactionSec: 1 });
    for (let i = 0; i < 8; i++) {
      expect(base[i].start - lead[i].start).toBeCloseTo(1, 1);
      expect(base[i].end - lead[i].end).toBeCloseTo(1, 1);
      expect(lead[i].duration).toBeCloseTo(base[i].duration, 1);
    }
  });

  it("is clamped into a sane range", () => {
    expect(run({ startEffort: 0.01, endEffort: 0.99 })).toHaveLength(8);
    expect(run({ startEffort: 0.99, endEffort: 0.01, reactionSec: 99 })).toHaveLength(8);
  });

  it("the default is the beep-to-beep strategy", () => {
    const d = detect(activity, series, { mode: "signal" }).reps;
    const explicit = detect(activity, series, { mode: "signal", ...EDGE_PRESETS.beep }).reps;
    expect(d.map((r) => [r.start, r.end])).toEqual(explicit.map((r) => [r.start, r.end]));
    expect(EDGE_PRESETS.beep).toEqual({ startEffort: 0.2, endEffort: 0.8, reactionSec: 0.5 });
  });
});
