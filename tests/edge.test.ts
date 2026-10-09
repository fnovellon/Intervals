import { describe, expect, it } from "vitest";
import { detect } from "../src/analysis/detect";
import { buildSeries } from "../src/analysis/timeseries";
import { synthesize, WORKOUTS } from "../src/sample/synth";

/**
 * Slow, first-order acceleration (time constant 8 s, ~25 s to get up to speed). For such a ramp the
 * time at which the effort has reached a fraction q is known exactly:
 *   a start (effort rising)  : command + tau * -ln(1 - q)
 *   an end  (effort falling) : command + tau *  ln(1 / q)
 */
const TAU = 8;
const sim = () => synthesize({ steps: WORKOUTS["8x400"](), seed: 3, lapMode: "none", athleteTau: TAU, gpsNoise: 0.05, deviceSmoothing: 0.8 });

describe("edge position (edgeFraction)", () => {
  const { activity, truth } = sim();
  const series = buildSeries(activity);
  const reps = truth.filter((t) => t.kind === "work");
  // the simulator's truth sits at q = 0.5, i.e. command + tau ln 2
  const command = (t: number) => t - TAU * Math.LN2;
  const run = (edgeFraction?: number) => detect(activity, series, { mode: "signal", ...(edgeFraction === undefined ? {} : { edgeFraction }) }).reps;

  it("the default is exactly the half-way point", () => {
    expect(run().map((r) => [r.start, r.end])).toEqual(run(0.5).map((r) => [r.start, r.end]));
  });

  it("a lower value starts intervals earlier and ends them later; a higher one the opposite", () => {
    const early = run(0.25);
    const mid = run(0.5);
    const late = run(0.75);
    expect(early).toHaveLength(8);
    expect(late).toHaveLength(8);
    for (let i = 0; i < 8; i++) {
      expect(early[i].start).toBeLessThan(mid[i].start - 1);
      expect(late[i].start).toBeGreaterThan(mid[i].start + 1);
      expect(early[i].end).toBeGreaterThan(mid[i].end + 1);
      expect(late[i].end).toBeLessThan(mid[i].end - 1);
      expect(early[i].duration).toBeGreaterThan(mid[i].duration);
      expect(mid[i].duration).toBeGreaterThan(late[i].duration);
    }
  });

  // Ends at a low q sit ~11 s into an exponential tail where pace changes by only a few % per second, so
  // they are the least certain edges: measured worst case 2.4 s on a ramp that takes ~25 s.
  it.each([0.25, 0.75])("lands on the analytic crossing time for q = %s (within 3 s)", (q) => {
    const found = run(q);
    const errs: number[] = [];
    reps.forEach((t, i) => {
      errs.push(found[i].start - (command(t.start) + TAU * -Math.log(1 - q)));
      errs.push(found[i].end - (command(t.end) + TAU * Math.log(1 / q)));
    });
    const worst = Math.max(...errs.map(Math.abs));
    expect(worst, `errors ${errs.map((e) => e.toFixed(1)).join(" ")}`).toBeLessThan(3);
  });

  it("is clamped into a sane range", () => {
    expect(run(0.01)).toHaveLength(8);
    expect(run(0.99)).toHaveLength(8);
  });
});
