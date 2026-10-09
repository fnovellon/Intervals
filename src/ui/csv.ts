import type { Detection } from "../analysis/model";
import type { Series } from "../analysis/timeseries";
import { isFootSport } from "../fit/types";

/** Raw (unit-converted-free, SI-based) export of every segment. */
export function segmentsToCsv(d: Detection, series: Series, sport: string): string {
  const foot = isFootSport(sport);
  const cols = [
    "segment",
    "rep",
    "type",
    "source",
    "start_s",
    "end_s",
    "duration_s",
    "moving_s",
    "paused_s",
    "distance_m",
    "avg_speed_mps",
    foot ? "avg_pace_s_per_km" : "avg_speed_kmh",
    "avg_gap_pace_s_per_km",
    "best_5s_speed_mps",
    "avg_hr",
    "max_hr",
    "hr_start",
    "hr_end",
    "avg_cadence",
    "avg_power",
    "elev_gain_m",
    "elev_loss_m",
    "avg_grade_pct",
    "fade_pct",
    "speed_cv_pct",
  ];
  const fmt = (v: number | undefined, digits = 2) => (v === undefined || !Number.isFinite(v) ? "" : v.toFixed(digits));
  const rows = d.segments.map((s) => {
    const rep = s.kind === "work" ? d.reps.findIndex((r) => r.id === s.id) + 1 : "";
    return [
      s.id + 1,
      rep,
      s.kind,
      s.source,
      fmt(s.start, 1),
      fmt(s.end, 1),
      fmt(s.duration, 1),
      fmt(s.movingTime, 1),
      fmt(s.paused, 1),
      fmt(s.distance, 1),
      fmt(s.avgSpeed, 3),
      foot ? fmt(s.avgSpeed > 0.3 ? 1000 / s.avgSpeed : undefined, 1) : fmt(s.avgSpeed * 3.6, 2),
      fmt(s.avgGapSpeed > 0.3 && series.hasAltitude ? 1000 / s.avgGapSpeed : undefined, 1),
      fmt(s.maxSpeed, 3),
      fmt(s.avgHr, 1),
      fmt(s.maxHr, 0),
      fmt(s.hrStart, 1),
      fmt(s.hrEnd, 1),
      fmt(s.avgCadence, 1),
      fmt(s.avgPower, 0),
      fmt(s.elevGain, 1),
      fmt(s.elevLoss, 1),
      fmt(s.avgGrade, 2),
      fmt(s.fadePct, 2),
      fmt(s.speedCvPct, 2),
    ].join(",");
  });
  return [cols.join(","), ...rows].join("\n") + "\n";
}
