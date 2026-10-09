/**
 * Precision benchmark: many random sessions with known ground truth.
 * Prints a table (run with `npm run bench`) and asserts regression limits.
 */
import { describe, expect, it } from "vitest";
import { analyseActivity } from "../src/analysis/detect";
import { EDGE_PRESETS } from "../src/analysis/model";
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
  // the athlete takes ~30 s to get up to speed (time constant 10 s instead of ~2 s)
  { name: "slow acceleration", workout: "8x400", synth: { athleteTau: 10 }, maxP95: 3.5 },
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
        // the truth in this table is the physical half-way point of each change of pace
        const { detection } = analyseActivity(activity, { mode: "signal", signal: sc.signal ?? "speed", ...EDGE_PRESETS.half });
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


/**
 * The default strategy (beep to beep) against the real beep: a simulated athlete who reacts 0.6 s after
 * the beep, with the truth being the beep itself. Compared with the half-way strategy.
 */
describe("beep-to-beep strategy vs the real beep", () => {
  const CASES: Array<{ name: string; workout: WorkoutName; synth: Partial<SynthOptions>; maxP95: number }> = [
    { name: "typical", workout: "8x400", synth: {}, maxP95: 1.2 },
    { name: "noisy GPS + spikes", workout: "8x400", synth: { gpsNoise: 0.3, spikeRate: 0.01 }, maxP95: 3 },
    { name: "heavy smoothing", workout: "6x800", synth: { deviceSmoothing: 3.5 }, maxP95: 1.6 },
    { name: "slow acceleration", workout: "8x400", synth: { athleteTau: 6 }, maxP95: 2.6 },
    { name: "short reps 200", workout: "12x200", synth: {}, maxP95: 1 },
    { name: "fartlek", workout: "fartlek", synth: { gpsNoise: 0.2 }, maxP95: 3 },
  ];

  it("finds the beeps closer than half-way does, and never loses a rep", () => {
    const rows: string[] = ["case                       beep-to-beep |err| mean / p95   half-way mean   dist err % mean"];
    for (const c of CASES) {
      const err = { beep: [] as number[], half: [] as number[] };
      const dist: number[] = [];
      for (let seed = 1; seed <= 12; seed++) {
        const sy = synthesize({ steps: WORKOUTS[c.workout](), seed, lapMode: "none", truthAt: "command", reaction: 0.6, ...c.synth });
        for (const which of ["beep", "half"] as const) {
          const { detection } = analyseActivity(sy.activity, { mode: "signal", ...(which === "half" ? EDGE_PRESETS.half : {}) });
          const s = score(sy.truth, detection);
          expect(s.exactCount, `${c.name} ${which} seed ${seed}`).toBe(true);
          for (const m of s.matched) {
            err[which].push(Math.abs(m.startErr), Math.abs(m.endErr));
            if (which === "beep") dist.push(Math.abs(m.distErrPct));
          }
        }
      }
      const mean = (v: number[]) => v.reduce((a, x) => a + x, 0) / v.length;
      rows.push(`${c.name.padEnd(26)} ${mean(err.beep).toFixed(2).padStart(6)} / ${pct(err.beep, 0.95).toFixed(2).padStart(5)}${mean(err.half).toFixed(2).padStart(20)}${mean(dist).toFixed(2).padStart(18)}`);
      expect(pct(err.beep, 0.95), `${c.name}: p95`).toBeLessThan(c.maxP95);
      expect(mean(err.beep), `${c.name}: better than half-way`).toBeLessThan(mean(err.half));
    }
    console.log("\n" + rows.join("\n"));
  });
});
