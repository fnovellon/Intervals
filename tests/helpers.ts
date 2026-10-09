import type { Detection } from "../src/analysis/model";
import { renderMsg } from "../src/i18n";
import type { TruthSegment } from "../src/sample/synth";

export interface RepScore {
  truthIndex: number;
  startErr: number;
  endErr: number;
  distErrPct: number;
  durErr: number;
}

export interface Score {
  truthReps: number;
  detectedReps: number;
  matched: RepScore[];
  /** True when every truth rep got a counterpart and nothing extra was found. */
  exactCount: boolean;
}

/** Match detected work reps to true work reps by best overlap and report errors. */
export function score(truth: TruthSegment[], det: Detection): Score {
  const tReps = truth.filter((t) => t.kind === "work");
  const matched: RepScore[] = [];
  const used = new Set<number>();
  tReps.forEach((t, ti) => {
    let best = -1;
    let bestOverlap = 0;
    det.reps.forEach((r, ri) => {
      if (used.has(ri)) return;
      const ov = Math.min(r.end, t.end) - Math.max(r.start, t.start);
      if (ov > bestOverlap) {
        bestOverlap = ov;
        best = ri;
      }
    });
    if (best < 0 || bestOverlap < 0.5 * (t.end - t.start)) return;
    used.add(best);
    const r = det.reps[best];
    matched.push({
      truthIndex: ti,
      startErr: r.start - t.start,
      endErr: r.end - t.end,
      distErrPct: ((r.distance - t.distance) / t.distance) * 100,
      durErr: r.duration - (t.end - t.start),
    });
  });
  return {
    truthReps: tReps.length,
    detectedReps: det.reps.length,
    matched,
    exactCount: matched.length === tReps.length && det.reps.length === tReps.length,
  };
}

export const pct = (v: number[], q: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};

/** All engine notes of a detection as one English string (for readable assertions). */
export const noteText = (d: Detection) => d.notes.map((n) => renderMsg(n, "en")).join(" ");
