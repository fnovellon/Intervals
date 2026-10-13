import type { RecordPoint } from "../fit/types";
import { median } from "./timeseries";

/**
 * Running on a track.
 *
 * A Garmin in track mode counts every lap of the track as exactly 400 m (it snaps the distance to the lap), whatever the
 * real length of the track: on a 333 m track every distance and pace is 20 % too high. The signature is unmistakable:
 * lap after lap, the recorded distance is the same to a metre or two, which real GPS never does.
 *
 * The laps are counted from the GPS positions (how many times the athlete went round the middle of the infield), so the
 * recorded distance can be compared with, and rescaled to, the real length of a lap.
 */

/** What the app knows about the track in a file. */
export interface TrackInfo {
  /** Complete laps counted. */
  laps: number;
  /** Metres the watch counted per lap (its assumed track length). */
  recordedLap: number;
  /** Metres per lap that the recorded speed adds up to (the speed channel does not take the watch's 400 m for granted). */
  speedLap?: number;
  /** The real length of a lap, when the distance was rescaled to it. */
  appliedLength?: number;
}

export interface TrackFit {
  laps: Array<{ t0: number; t1: number; recorded: number }>;
  /** The watch's own lap length: the median of the laps that agree. */
  recordedLap: number;
  /** 1 for each second the athlete was on the track. */
  onTrack: Uint8Array;
}

/** Everything within this distance of the middle of the infield counts as "on the track". */
const REGION_M = 110;
/** Closer than this to the middle the angle is meaningless. */
const CORE_M = 12;
const CELL_M = 30;
const MIN_SAMPLES = 240;
const MAX_GAP_S = 15;
const MIN_LAP_S = 25;
const MAX_LAP_S = 600;
const MIN_LAPS = 3;
/** Laps agree when they are within this of the median (metres, or 2.5 %, whichever is larger). */
const AGREE_M = 3;
const AGREE_SHARE = 0.025;
/** Half-width (radians) of the stretch of track over which the moment of a full turn is fitted. */
const FIT_ARC = 0.3;
/** At least this share of the laps must agree. */
const AGREE_MIN = 0.7;
/** The assumed lap lengths a watch in track mode uses: 400 m, up to the outer lanes. */
const LAP_RANGE: [number, number] = [380, 460];
/** The speed channel "disagrees clearly" when its lap is shorter than this share of the recorded one... */
export const SPEED_SHORT = 0.94;
/** ...or, once the distance is rescaled, longer than this share of the real lap (running in an outer lane). */
export const SPEED_LONG = 1.03;

export function findTrack(recs: RecordPoint[], dist: Float64Array, n: number): TrackFit | null {
  const pts = recs.filter((r) => r.lat !== undefined && r.lon !== undefined);
  if (pts.length < MIN_SAMPLES) return null;
  const lat0 = pts.reduce((a, p) => a + p.lat!, 0) / pts.length;
  const lon0 = pts.reduce((a, p) => a + p.lon!, 0) / pts.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110574;
  const P = pts.map((p) => ({ t: p.t, x: (p.lon! - lon0) * kx, y: (p.lat! - lat0) * ky }));

  // The middle of the track: where the athlete spent the most time.
  const cells = new Map<string, number>();
  for (const p of P) {
    const key = `${Math.floor(p.x / CELL_M)},${Math.floor(p.y / CELL_M)}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  let bestKey = "";
  let bestCount = 0;
  for (const [k, c] of cells) {
    if (c > bestCount) {
      bestCount = c;
      bestKey = k;
    }
  }
  const [ci, cj] = bestKey.split(",").map(Number);
  let cx = (ci + 0.5) * CELL_M;
  let cy = (cj + 0.5) * CELL_M;
  for (let iter = 0; iter < 4; iter++) {
    let sx = 0;
    let sy = 0;
    let c = 0;
    for (const p of P) {
      if (Math.hypot(p.x - cx, p.y - cy) <= REGION_M) {
        sx += p.x;
        sy += p.y;
        c++;
      }
    }
    if (c < MIN_SAMPLES) return null;
    cx = sx / c;
    cy = sy / c;
  }

  const onTrack = new Uint8Array(n);
  let last = 0;
  const flagAt = new Map<number, number>();
  for (const p of P) flagAt.set(Math.round(p.t), Math.hypot(p.x - cx, p.y - cy) <= REGION_M ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const f = flagAt.get(i);
    if (f !== undefined) last = f;
    onTrack[i] = last;
  }

  // Laps: unwrap the angle round the middle while the athlete stays on the track, and note when each full turn is done.
  const distAt = (t: number) => {
    const i = Math.max(0, Math.min(n - 2, Math.floor(t)));
    return dist[i] + (t - i) * (dist[i + 1] - dist[i]);
  };
  const laps: TrackFit["laps"] = [];
  const flush = (seg: Array<{ t: number; a: number }>) => {
    if (seg.length < 2) return;
    const dir = Math.sign(seg[seg.length - 1].a) || 1;
    // the furthest the athlete got round: a wobble across the same angle counts once
    let reached = 0;
    for (const p of seg) reached = Math.max(reached, dir * p.a);
    const turns = Math.floor(reached / (2 * Math.PI));
    // When did the athlete pass each multiple of a full turn? A straight line through the positions around that angle,
    // so that GPS noise on one point does not move the moment.
    const passed = (k: number): number => {
      const target = k * 2 * Math.PI;
      const near = seg.filter((p) => Math.abs(dir * p.a - target) <= FIT_ARC);
      if (near.length >= 4) {
        const ma = near.reduce((s, p) => s + dir * p.a, 0) / near.length;
        const mt = near.reduce((s, p) => s + p.t, 0) / near.length;
        let sxy = 0;
        let sxx = 0;
        for (const p of near) {
          sxy += (dir * p.a - ma) * (p.t - mt);
          sxx += (dir * p.a - ma) ** 2;
        }
        if (sxx > 1e-9 && sxy > 0) return mt + (sxy / sxx) * (target - ma);
      }
      const after = seg.findIndex((p) => dir * p.a >= target);
      if (after <= 0) return seg[Math.max(0, after)].t;
      const f = (target - dir * seg[after - 1].a) / (dir * seg[after].a - dir * seg[after - 1].a);
      return seg[after - 1].t + f * (seg[after].t - seg[after - 1].t);
    };
    const events = Array.from({ length: turns + 1 }, (_, k) => passed(k));
    for (let j = 0; j + 1 < events.length; j++) {
      const dt = events[j + 1] - events[j];
      if (dt < MIN_LAP_S || dt > MAX_LAP_S) continue;
      laps.push({ t0: events[j], t1: events[j + 1], recorded: distAt(events[j + 1]) - distAt(events[j]) });
    }
  };
  let seg: Array<{ t: number; a: number }> = [];
  let prevA = 0;
  let prevT = -Infinity;
  let total = 0;
  for (const p of P) {
    const r = Math.hypot(p.x - cx, p.y - cy);
    if (r > REGION_M || r < CORE_M || p.t - prevT > MAX_GAP_S) {
      flush(seg);
      seg = [];
      total = 0;
    }
    prevT = p.t;
    if (r > REGION_M || r < CORE_M) continue;
    const a = Math.atan2(p.y - cy, p.x - cx);
    if (seg.length === 0) {
      total = 0;
    } else {
      let da = a - prevA;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      total += da;
    }
    prevA = a;
    seg.push({ t: p.t, a: total });
  }
  flush(seg);
  if (laps.length < MIN_LAPS) return null;

  // The signature: laps that agree to a metre or two, at a lap length a watch in track mode uses.
  const med = median(laps.map((l) => l.recorded));
  const tol = Math.max(AGREE_M, AGREE_SHARE * med);
  const agreeing = laps.filter((l) => Math.abs(l.recorded - med) <= tol);
  if (agreeing.length < MIN_LAPS || agreeing.length < AGREE_MIN * laps.length) return null;
  const recordedLap = median(agreeing.map((l) => l.recorded));
  if (recordedLap < LAP_RANGE[0] || recordedLap > LAP_RANGE[1]) return null;
  return { laps: agreeing, recordedLap, onTrack };
}

/** Rescale the distance recorded on the track, in place: every metre counted there becomes `factor` metres. */
export function rescaleOnTrack(dist: Float64Array, fit: TrackFit, factor: number): void {
  let before = dist[0];
  for (let i = 1; i < dist.length; i++) {
    const now = dist[i];
    const step = now - before;
    before = now;
    dist[i] = dist[i - 1] + step * (fit.onTrack[i] ? factor : 1);
  }
}

/** Metres per lap that the recorded speed adds up to (median over the laps). */
export function speedLapLength(fit: TrackFit, speed: Float64Array): number {
  return median(
    fit.laps.map((l) => {
      let sum = 0;
      for (let i = Math.ceil(l.t0); i < Math.ceil(l.t1) && i < speed.length; i++) sum += speed[i];
      return sum;
    }),
  );
}
