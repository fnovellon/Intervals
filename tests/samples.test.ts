/**
 * Writes the simulated sample sessions to samples/*.fit.
 *   npm run samples
 * Skipped during normal test runs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { encodeFit, synthesize, WORKOUTS, type LapMode, type SynthOptions, type WorkoutName } from "../src/sample/synth";

const FILES: Array<[string, WorkoutName, LapMode, Partial<SynthOptions>]> = [
  ["6x800-structured-workout", "6x800", "workout", { autoPause: true, subSport: "track" }],
  ["8x400-lap-button", "8x400", "manual", {}],
  ["pyramid-no-laps", "pyramid", "none", {}],
  ["fartlek-8x2min", "fartlek", "none", {}],
  ["hill-repeats", "hills", "none", { truthAt: "command" }],
  ["12x200", "12x200", "none", {}],
];

describe.skipIf(!process.env.GENERATE_SAMPLES)("sample files", () => {
  it("writes them", () => {
    mkdirSync("samples", { recursive: true });
    for (const [name, workout, lapMode, extra] of FILES) {
      const { activity } = synthesize({ steps: WORKOUTS[workout](), seed: 21, lapMode, ...extra });
      writeFileSync(`samples/${name}.fit`, encodeFit(activity));
    }
  });
});
