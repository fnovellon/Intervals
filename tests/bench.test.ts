/**
 * Precision benchmark: many random sessions with known ground truth.
 * Prints a table (run with `npm run bench`) and asserts regression limits.
 */
import { describe, expect, it } from "vitest";
import { analyseActivity } from "../src/analysis/detect";
import { synthesize, WORKOUTS, type SynthOptions, type WorkoutName } from "../src/sample/synth";
import { pct, score } from "./helpers";

interface Scenario {
  name: string;
  workout: WorkoutName;
  synth: Partial<SynthOptions>;
  signal?: "speed" | "gap";
  /** p95 limit on boundary error in seconds. */
  maxP95?: number;
}

const SCENARIOS: Scenario[] = [
  { name: "clean", workout: "6x800", synth: { gpsNoise: 0.05, deviceSmoothing: 1 } },
  { name: "typical", workout: "8x400", synth: {} },
  { name: "noisy GPS", workout: "8x400", synth: { gpsNoise: 0.3, spikeRate: 0.01 } },
  { name: "heavy smoothing", workout: "6x800", synth: { deviceSmoothing: 3.5 } },
  { name: "short reps 200", workout: "12x200", synth: {} },
  { name: "pyramid", workout: "pyramid", synth: {} },
  { name: "fartlek (time)", workout: "fartlek", synth: { gpsNoise: 0.2 } },
  { name: "hills (GAP)", workout: "hills", synth: { truthAt: "command" }, signal: "gap", maxP95: 4 },
  { name: "standing rest/auto-pause", workout: "6x800", synth: { autoPause: true } },
];

const SEEDS = 12;

describe("precision benchmark", () => {
  it("measures boundary and distance error over random sessions", () => {
    const rows: string[] = [];
    const header = `${"scenario".padEnd(26)} reps exact%  |bnd err| mean  p95   bias | dist err% p95  max`;
    rows.push(header);
    const summary: Record<string, { exact: number; p95: number; distP95: number }> = {};

    for (const sc of SCENARIOS) {
      let exact = 0;
      let total = 0;
      const bErr: number[] = [];
      const bSigned: number[] = [];
      const dErr: number[] = [];
      let nReps = 0;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const { activity, truth } = synthesize({ steps: WORKOUTS[sc.workout](), seed, lapMode: "none", ...sc.synth });
        const { detection } = analyseActivity(activity, { mode: "signal", signal: sc.signal ?? "speed" });
        const s = score(truth, detection);
        total++;
        if (s.exactCount) exact++;
        nReps = s.truthReps;
        for (const m of s.matched) {
          bErr.push(Math.abs(m.startErr), Math.abs(m.endErr));
          bSigned.push(m.startErr, m.endErr);
          dErr.push(Math.abs(m.distErrPct));
        }
      }
      const mean = bErr.reduce((a, b) => a + b, 0) / bErr.length;
      const bias = bSigned.reduce((a, b) => a + b, 0) / bSigned.length;
      const p95 = pct(bErr, 0.95);
      const dP95 = pct(dErr, 0.95);
      summary[sc.name] = { exact: (100 * exact) / total, p95, distP95: dP95 };
      rows.push(
        `${sc.name.padEnd(26)} ${String(nReps).padStart(4)} ${((100 * exact) / total).toFixed(0).padStart(6)}%  ` +
          `${mean.toFixed(2).padStart(15)} ${p95.toFixed(2).padStart(5)} ${bias.toFixed(2).padStart(6)} | ` +
          `${dP95.toFixed(2).padStart(13)} ${Math.max(...dErr).toFixed(2).padStart(5)}`,
      );
    }
    console.log("\n" + rows.join("\n"));

    for (const sc of SCENARIOS) {
      const r = summary[sc.name];
      expect(r.exact, `${sc.name}: rep count must be exact`).toBeGreaterThanOrEqual(90);
      expect(r.p95, `${sc.name}: boundary p95`).toBeLessThan(sc.maxP95 ?? 2.5);
    }
  });
});
