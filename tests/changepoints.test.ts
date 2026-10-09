import { describe, expect, it } from "vitest";
import { noiseSigma, otsu, pelt } from "../src/analysis/changepoints";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** O(n^2) reference: optimal partition with a minimum segment length. */
function bruteForceCost(x: number[], penalty: number, minSize: number): number {
  const n = x.length;
  const S1 = [0];
  const S2 = [0];
  x.forEach((v, i) => {
    S1.push(S1[i] + v);
    S2.push(S2[i] + v * v);
  });
  const c = (s: number, t: number) => S2[t] - S2[s] - (S1[t] - S1[s]) ** 2 / (t - s);
  const F = new Array(n + 1).fill(Infinity);
  F[0] = -penalty;
  for (let t = minSize; t <= n; t++) {
    for (let s = 0; s <= t - minSize; s++) {
      if (Number.isFinite(F[s])) F[t] = Math.min(F[t], F[s] + c(s, t) + penalty);
    }
  }
  return F[n];
}

function costOf(x: number[], bounds: number[], penalty: number): number {
  let total = -penalty;
  for (let k = 0; k + 1 < bounds.length; k++) {
    const seg = x.slice(bounds[k], bounds[k + 1]);
    const m = seg.reduce((a, b) => a + b, 0) / seg.length;
    total += seg.reduce((a, b) => a + (b - m) ** 2, 0) + penalty;
  }
  return total;
}

describe("pelt", () => {
  it("is exactly optimal vs brute force (random signals, penalties, min sizes)", () => {
    const rand = mulberry32(42);
    for (let trial = 0; trial < 150; trial++) {
      const n = 20 + Math.floor(rand() * 180);
      const minSize = 1 + Math.floor(rand() * 8);
      const penalty = 0.05 + rand() * 20;
      const x: number[] = [];
      let level = rand() * 4;
      for (let i = 0; i < n; i++) {
        if (rand() < 0.04) level = rand() * 5;
        x.push(level + (rand() - 0.5) * 1.2);
      }
      const bounds = pelt(x, penalty, minSize);
      expect(bounds[0]).toBe(0);
      expect(bounds[bounds.length - 1]).toBe(n);
      for (let k = 0; k + 1 < bounds.length; k++) {
        expect(bounds[k + 1] - bounds[k]).toBeGreaterThanOrEqual(minSize);
      }
      expect(costOf(x, bounds, penalty)).toBeCloseTo(bruteForceCost(x, penalty, minSize), 6);
    }
  });

  it("finds the edges of a clean rectangular pulse", () => {
    const x = [...Array(50).fill(2), ...Array(30).fill(4), ...Array(50).fill(2)];
    expect(pelt(x, 1, 3)).toEqual([0, 50, 80, 130]);
  });

  it("does not split pure noise with a BIC-sized penalty", () => {
    const rand = mulberry32(7);
    const x = Array.from({ length: 600 }, () => 3 + (rand() - 0.5) * 0.4);
    const sigma = noiseSigma(x);
    expect(pelt(x, 2 * sigma * sigma * Math.log(600), 3)).toEqual([0, 600]);
  });
});

describe("noiseSigma", () => {
  it("ignores steps and measures texture", () => {
    const rand = mulberry32(3);
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    const x = Array.from({ length: 2000 }, (_, i) => (Math.floor(i / 100) % 2 ? 4 : 2.5) + 0.2 * gauss());
    expect(noiseSigma(x)).toBeGreaterThan(0.14);
    expect(noiseSigma(x)).toBeLessThan(0.26);
  });
});

describe("otsu", () => {
  it("splits two clusters and reports separation", () => {
    const r = otsu([2.9, 3.0, 3.1, 4.0, 4.1], [1, 1, 1, 1, 1])!;
    expect(r.threshold).toBeGreaterThan(3.1);
    expect(r.threshold).toBeLessThan(4.0);
    expect(r.separation).toBeGreaterThan(0.9);
  });
});
