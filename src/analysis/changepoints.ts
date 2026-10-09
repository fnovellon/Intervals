/**
 * Optimal piecewise-constant segmentation (least-squares cost) by PELT
 * (Killick, Fearnhead & Eckley 2012), with a minimum segment length.
 *
 * Minimises   sum over segments of SSE(segment) + penalty * (#segments - 1).
 *
 * The usual PELT pruning is only valid for a candidate `s` at end-points
 * t' >= t + minSize (the alternative path through t needs a segment of at least
 * minSize). Pruned candidates are therefore kept alive for minSize more steps,
 * which keeps the result exactly optimal (verified against brute force in tests).
 */
export function pelt(x: ArrayLike<number>, penalty: number, minSize = 2): number[] {
  const n = x.length;
  if (n < 2 * minSize) return [0, n];

  const S1 = new Float64Array(n + 1);
  const S2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    S1[i + 1] = S1[i] + x[i];
    S2[i + 1] = S2[i] + x[i] * x[i];
  }
  const cost = (s: number, t: number) => {
    const sum = S1[t] - S1[s];
    return S2[t] - S2[s] - (sum * sum) / (t - s);
  };

  const F = new Float64Array(n + 1).fill(Infinity);
  const last = new Int32Array(n + 1).fill(-1);
  F[0] = -penalty;

  // Parallel arrays: candidate start and the step at which it stops being usable.
  let candS: number[] = [];
  let candExpire: number[] = [];

  for (let t = minSize; t <= n; t++) {
    const entering = t - minSize;
    if (entering === 0 || Number.isFinite(F[entering])) {
      candS.push(entering);
      candExpire.push(Infinity);
    }

    let best = Infinity;
    let bestS = -1;
    for (let k = 0; k < candS.length; k++) {
      const s = candS[k];
      const v = F[s] + cost(s, t);
      if (v < best) {
        best = v;
        bestS = s;
      }
    }
    F[t] = best + penalty;
    last[t] = bestS;

    // Prune.
    const nextS: number[] = [];
    const nextE: number[] = [];
    for (let k = 0; k < candS.length; k++) {
      const s = candS[k];
      let expire = candExpire[k];
      if (expire === Infinity && F[s] + cost(s, t) > F[t]) expire = t + minSize;
      if (t + 1 < expire) {
        nextS.push(s);
        nextE.push(expire);
      }
    }
    candS = nextS;
    candExpire = nextE;
  }

  const bounds: number[] = [n];
  for (let t = n; t > 0; ) {
    t = last[t];
    bounds.push(t);
  }
  return bounds.reverse();
}

/**
 * Robust standard deviation of the noise: residual of a short median filter,
 * scaled MAD. Piecewise-constant structure (the intervals themselves) is
 * removed by the median filter, so only the texture is measured.
 */
export function noiseSigma(x: ArrayLike<number>, window = 9): number {
  const n = x.length;
  const half = window >> 1;
  const resid: number[] = [];
  const buf: number[] = [];
  for (let i = 0; i < n; i++) {
    buf.length = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) buf.push(x[k]);
    buf.sort((a, b) => a - b);
    resid.push(Math.abs(x[i] - buf[buf.length >> 1]));
  }
  resid.sort((a, b) => a - b);
  return 1.4826 * resid[resid.length >> 1];
}

/**
 * Two-class threshold (Otsu) on weighted values. Returns the threshold, the two
 * class means and the share of variance explained by the split (0..1).
 */
export function otsu(
  values: number[],
  weights: number[],
): { threshold: number; lo: number; hi: number; separation: number } | null {
  const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const total = idx.reduce((s, i) => s + weights[i], 0);
  if (idx.length < 2 || total <= 0) return null;
  const mean = idx.reduce((s, i) => s + weights[i] * values[i], 0) / total;
  const totalVar = idx.reduce((s, i) => s + weights[i] * (values[i] - mean) ** 2, 0) / total;

  let bestScore = -1;
  let best: { threshold: number; lo: number; hi: number } | null = null;
  let w1 = 0;
  let m1 = 0;
  for (let k = 0; k < idx.length - 1; k++) {
    w1 += weights[idx[k]];
    m1 += weights[idx[k]] * values[idx[k]];
    const a = values[idx[k]];
    const b = values[idx[k + 1]];
    if (b - a < 1e-9) continue;
    const w2 = total - w1;
    const mu1 = m1 / w1;
    const mu2 = (mean * total - m1) / w2;
    const score = (w1 * w2 * (mu1 - mu2) ** 2) / (total * total);
    if (score > bestScore) {
      bestScore = score;
      best = { threshold: (a + b) / 2, lo: mu1, hi: mu2 };
    }
  }
  if (!best) return null;
  return { ...best, separation: totalVar > 0 ? bestScore / totalVar : 0 };
}
