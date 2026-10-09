import { isFootSport } from "../fit/types";

export type Units = "metric" | "imperial";

const KM_PER_MILE = 1.609344;

export interface SpeedDisplay {
  /** "Pace" for foot sports (min/km), "Speed" otherwise (km/h). */
  label: string;
  unit: string;
  isPace: boolean;
  /** Short value, e.g. "3:20" or "18.4". */
  format(speedMs: number): string;
  /** Value with unit, e.g. "3:20 /km". */
  formatWithUnit(speedMs: number): string;
  /** Pace in seconds per unit distance, or speed in km/h or mph (for plotting). */
  toAxis(speedMs: number): number;
  formatAxis(v: number): string;
}

export function speedDisplay(sport: string, units: Units): SpeedDisplay {
  const perUnit = units === "metric" ? 1000 : 1000 * KM_PER_MILE;
  if (isFootSport(sport)) {
    const unit = units === "metric" ? "/km" : "/mi";
    const fmt = (v: number) => (v > 0.3 ? mmss(perUnit / v) : "–");
    return {
      label: "Pace",
      unit,
      isPace: true,
      format: fmt,
      formatWithUnit: (v) => (v > 0.3 ? `${fmt(v)} ${unit}` : "–"),
      toAxis: (v) => perUnit / Math.max(v, 0.05),
      formatAxis: (p) => mmss(p),
    };
  }
  const unit = units === "metric" ? "km/h" : "mph";
  const k = units === "metric" ? 3.6 : 3.6 / KM_PER_MILE;
  return {
    label: "Speed",
    unit,
    isPace: false,
    format: (v) => (v * k).toFixed(1),
    formatWithUnit: (v) => `${(v * k).toFixed(1)} ${unit}`,
    toAxis: (v) => v * k,
    formatAxis: (x) => String(Math.round(x)),
  };
}

/** 205 -> "3:25". Rounds to the nearest second. */
export function mmss(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) return "–";
  const s = Math.round(totalSeconds);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** 3725 -> "1:02:05", 205 -> "3:25". */
export function duration(totalSeconds: number, decimals = 0): string {
  if (!Number.isFinite(totalSeconds)) return "–";
  const t = Math.max(0, totalSeconds);
  const whole = Math.floor(t);
  const frac = decimals ? (t - whole).toFixed(decimals).slice(1) : "";
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const sec = whole % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}${frac}`;
}

export function distance(metres: number, units: Units): string {
  if (!Number.isFinite(metres)) return "–";
  if (units === "imperial") {
    const mi = metres / (1000 * KM_PER_MILE);
    return mi >= 0.1 ? `${mi.toFixed(2)} mi` : `${Math.round(metres * 3.28084)} ft`;
  }
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(2)} km`;
}

/** Distance as a bare number for tables: metres below 10 km in metric. */
export function distanceShort(metres: number, units: Units): string {
  if (units === "imperial") return (metres / (1000 * KM_PER_MILE)).toFixed(2);
  return metres < 10_000 ? String(Math.round(metres)) : (metres / 1000).toFixed(2);
}

export function distanceUnitShort(metres: number, units: Units): string {
  if (units === "imperial") return "mi";
  return metres < 10_000 ? "m" : "km";
}

export const bpm = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? "–" : String(Math.round(v)));
export const num = (v: number | undefined, d = 0) => (v === undefined || !Number.isFinite(v) ? "–" : v.toFixed(d));

export function signed(v: number, d = 1): string {
  const s = v.toFixed(d);
  return v > 0 ? `+${s}` : s;
}

export function dateLabel(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const KIND_LABEL: Record<string, string> = {
  warmup: "Warm-up",
  work: "Work",
  rest: "Rest",
  cooldown: "Cool-down",
  other: "Other",
};
