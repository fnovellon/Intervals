import { t, type Locale } from "../i18n";
import type { RepSet, RepSpec, Segment, Summary } from "./model";

const NICE_DISTANCES = [
  50, 100, 150, 200, 250, 300, 400, 500, 600, 800, 1000, 1200, 1500, 1600, 2000, 2400, 3000, 3200, 4000, 5000, 6000,
  8000, 10000,
];
const MILE = 1609.344;
const MILE_DISTANCES = [MILE / 4, MILE / 2, MILE, 2 * MILE, 3 * MILE];

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const cv = (v: number[]) => (v.length > 1 && mean(v) > 0 ? Math.sqrt(mean(v.map((x) => (x - mean(v)) ** 2))) / mean(v) : 0);

/**
 * Round a distance to the number an athlete would have written in the workout.
 * Metric track distances win over mile fractions (400 m vs 1/4 mi are 0.6 % apart)
 * unless the mile value is clearly the closer one.
 */
export function niceDistance(m: number): { value: number; label: string; relError: number } {
  const r = niceDistanceValue(m);
  return { ...r, label: distanceLabel(r.value, "en") };
}

function niceDistanceValue(m: number): { value: number; relError: number } {
  const nearest = (list: number[]) => list.reduce((best, c) => (Math.abs(c - m) < Math.abs(best - m) ? c : best), list[0]);
  const metric = nearest(NICE_DISTANCES);
  const mile = nearest(MILE_DISTANCES);
  const errMetric = Math.abs(metric - m) / m;
  const errMile = Math.abs(mile - m) / m;
  if (errMile < 0.5 * errMetric && errMile < 0.015) return { value: mile, relError: errMile };
  if (errMetric > 0.04) {
    // Not a standard distance: just print what was run.
    const value = m < 1000 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50;
    return { value, relError: errMetric };
  }
  return { value: metric, relError: errMetric };
}

/** "800 m", "1.2 km" / "1,2 km", "¼ mi". */
export function distanceLabel(value: number, loc: Locale): string {
  const mile = MILE_DISTANCES.find((d) => Math.abs(d - value) < 0.5);
  if (mile !== undefined) {
    const mi = mile / MILE;
    return `${mi === 0.25 ? "¼" : mi === 0.5 ? "½" : String(mi)} mi`;
  }
  if (value >= 1000) return `${trimZeros(value / 1000, loc)} km`;
  return `${Math.round(value)} m`;
}

/** "45 s", "2 min", "2:30". */
export function durationLabel(value: number): string {
  if (value < 120) return `${value} s`;
  const min = Math.floor(value / 60);
  const sec = value % 60;
  return sec === 0 ? `${min} min` : `${min}:${String(sec).padStart(2, "0")}`;
}

/**
 * Round a duration to a number of seconds somebody would put in a workout.
 * `fine` uses 5 s steps up to 2 min (recoveries are often 75, 100, 105 s);
 * the default is the coarser set of "round" rep durations (30 s, 45 s, 2 min, ...).
 */
export function niceDuration(s: number, fine = false): { value: number; label: string; relError: number } {
  const step = s < 60 ? 5 : s < 120 && fine ? 5 : s <= 300 ? 15 : 30;
  const v = Math.max(step, Math.round(s / step) * step);
  return { value: v, label: durationLabel(v), relError: Math.abs(v - s) / s };
}

function trimZeros(x: number, loc: Locale): string {
  const s = x.toFixed(2).replace(/\.?0+$/, "");
  return loc === "fr" ? s.replace(".", ",") : s;
}

/** Group consecutive reps that look like the same prescription. */
export function groupReps(reps: Segment[]): number[][] {
  const groups: number[][] = [];
  for (let i = 0; i < reps.length; i++) {
    const g = groups[groups.length - 1];
    if (g) {
      const medD = median(g.map((k) => reps[k].distance));
      const medT = median(g.map((k) => reps[k].duration));
      const near = (a: number, b: number) => b > 0 && Math.abs(a - b) / b <= 0.2;
      if (near(reps[i].distance, medD) && near(reps[i].duration, medT)) {
        g.push(i);
        continue;
      }
    }
    groups.push([i]);
  }
  return groups;
}

function describeGroup(reps: Segment[], idx: number[]): RepSpec {
  const dist = idx.map((i) => reps[i].distance);
  const dur = idx.map((i) => reps[i].duration);
  const d = niceDistance(median(dist));
  const t = niceDuration(median(dur));
  // Which quantity did the athlete prescribe? Whichever stays constant across
  // the reps; failing that, the rounder number, with a bias towards standard
  // track distances (200 m, 400 m, ...) over times that merely happen to round.
  let timeBased: boolean;
  const cvD = cv(dist);
  const cvT = cv(dur);
  if (idx.length >= 3 && cvT < 0.6 * cvD) timeBased = true;
  else if (idx.length >= 3 && cvD < 0.6 * cvT) timeBased = false;
  else timeBased = (d.relError > 0.03 && t.relError < d.relError) || (d.relError > 0.01 && t.relError < d.relError / 3);
  return timeBased ? { basis: "time", value: t.value } : { basis: "distance", value: d.value };
}

const specLabel = (s: RepSpec, loc: Locale) => (s.basis === "time" ? durationLabel(s.value) : distanceLabel(s.value, loc));

/** A piece of the session description, with the reps it stands for (indices into Detection.reps). */
export interface StructurePart {
  text: string;
  reps?: number[];
}

/** The session description in pieces, so the page can tie each piece to the reps it describes. */
export function structureParts(sum: Pick<Summary, "sets" | "sequence" | "restValue">, loc: Locale): StructurePart[] {
  const parts: StructurePart[] = [];
  if (sum.sequence) {
    sum.sequence.forEach((s, i) => {
      if (i) parts.push({ text: " · " });
      parts.push({ text: specLabel(s, loc), reps: [i] });
    });
  } else {
    sum.sets.forEach((s, i) => {
      if (i) parts.push({ text: " + " });
      parts.push({ text: s.count === 1 ? specLabel(s, loc) : `${s.count} × ${specLabel(s, loc)}`, reps: s.repIndices });
    });
  }
  if (sum.restValue !== undefined) parts.push({ text: ` / ${durationLabel(sum.restValue)} ${t("struct.rest", undefined, loc)}` });
  return parts;
}

/** "6 × 800 m / 90 s rest", "400 m · 800 m · 1.2 km · 800 m · 400 m / 2 min rest" in the given language. */
export function structureText(sum: Pick<Summary, "sets" | "sequence" | "restValue">, loc: Locale): string {
  return structureParts(sum, loc)
    .map((p) => p.text)
    .join("");
}

export function summarize(segments: Segment[]): Summary | null {
  const reps = segments.filter((s) => s.kind === "work");
  if (reps.length === 0) return null;

  const groups = groupReps(reps);
  const sets: RepSet[] = groups.map((g) => {
    const spec = describeGroup(reps, g);
    return { repIndices: g, count: g.length, ...spec, label: "" };
  });
  const sequence: RepSpec[] | null = groups.length <= 4 ? null : reps.map((_, i) => describeGroup(reps, [i]));
  const main = [...groups].sort(
    (a, b) => b.length - a.length || sum(b.map((i) => reps[i].distance)) - sum(a.map((i) => reps[i].distance)),
  )[0];

  const totalWorkTime = sum(reps.map((r) => r.duration));
  const totalWorkDistance = sum(reps.map((r) => r.distance));
  const workMoving = sum(reps.map((r) => r.movingTime));
  const rests = segments.filter((s) => s.kind === "rest");
  const totalRestTime = sum(rests.map((r) => r.duration));

  // Consistency metrics are computed on the main set so a pyramid or a stride
  // block does not distort them.
  const speeds = main.map((i) => reps[i].avgSpeed);
  let fastestRep = main[0];
  let slowestRep = main[0];
  for (const i of main) {
    if (reps[i].avgSpeed > reps[fastestRep].avgSpeed) fastestRep = i;
    if (reps[i].avgSpeed < reps[slowestRep].avgSpeed) slowestRep = i;
  }
  const pace = (v: number) => (v > 0 ? 1000 / v : NaN);
  const first = reps[main[0]];
  const last = reps[main[main.length - 1]];

  // Least-squares slope of pace against rep number.
  let slope = 0;
  if (main.length >= 3) {
    const xs = main.map((_, k) => k);
    const ys = main.map((i) => pace(reps[i].avgSpeed));
    const mx = mean(xs);
    const my = mean(ys);
    const den = sum(xs.map((x) => (x - mx) ** 2));
    slope = den > 0 ? sum(xs.map((x, k) => (x - mx) * (ys[k] - my))) / den : 0;
  }

  const hrReps = reps.filter((r) => r.avgHr !== undefined);
  const avgWorkHr = hrReps.length ? sum(hrReps.map((r) => r.avgHr! * r.duration)) / sum(hrReps.map((r) => r.duration)) : undefined;
  const peakHr = hrReps.length ? Math.max(...hrReps.map((r) => r.maxHr ?? 0)) : undefined;
  const hrDrift =
    main.length >= 2 && first.hrEnd !== undefined && last.hrEnd !== undefined ? last.hrEnd - first.hrEnd : undefined;

  // Recovery: HR at the end of a rep minus HR at the end of the rest that follows.
  const drops: number[] = [];
  for (let k = 1; k + 1 < segments.length; k++) {
    const s = segments[k];
    if (s.kind === "rest" && segments[k - 1].kind === "work" && segments[k + 1].kind === "work") {
      const before = segments[k - 1].hrEnd;
      if (before !== undefined && s.hrEnd !== undefined) drops.push(before - s.hrEnd);
    }
  }

  const between = rests.filter((r, _i) => {
    const k = segments.indexOf(r);
    return segments[k - 1]?.kind === "work" && segments[k + 1]?.kind === "work";
  });
  const restTimes = (between.length ? between : rests).map((r) => r.duration);

  const restValue = restTimes.length ? niceDuration(median(restTimes), true).value : undefined;
  for (const s of sets) s.label = s.count === 1 ? specLabel(s, "en") : `${s.count} × ${specLabel(s, "en")}`;
  const structure = structureText({ sets, sequence, restValue }, "en");

  return {
    repCount: reps.length,
    totalWorkTime,
    totalWorkDistance,
    totalRestTime,
    avgWorkSpeed: workMoving > 0 ? totalWorkDistance / workMoving : 0,
    fastestRep,
    slowestRep,
    mainSet: main,
    paceSpreadSecPerKm: pace(reps[slowestRep].avgSpeed) - pace(reps[fastestRep].avgSpeed),
    paceCvPct: cv(speeds) * 100,
    firstToLastPct: main.length >= 2 ? ((last.avgSpeed - first.avgSpeed) / first.avgSpeed) * 100 : 0,
    paceTrendSecPerKmPerRep: slope,
    avgRestTime: restTimes.length ? mean(restTimes) : 0,
    medianRestTime: restTimes.length ? median(restTimes) : 0,
    workRestRatio: totalRestTime > 0 ? totalWorkTime / totalRestTime : Infinity,
    avgWorkHr,
    peakHr,
    hrDrift,
    avgHrRecovery: drops.length ? mean(drops) : undefined,
    structure,
    sets,
    sequence,
    restValue,
  };
}

function sum(v: number[]): number {
  return v.reduce((a, b) => a + b, 0);
}
