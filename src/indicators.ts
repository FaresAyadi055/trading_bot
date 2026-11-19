// Pure indicator helpers. All arrays are index-aligned with the input; NaN = not available.
// Every function mirrors the pandas/numpy behaviour named in BOT_SPEC.md §4 / §15 (parity-tested).
const nanArr = (n: number) => new Array<number>(n).fill(NaN)

/** pandas ewm(alpha, adjust=False, min_periods): E_0 = x_0, then recurse. */
export function ewm(x: number[], alpha: number, minPeriods: number): number[] {
  const out = nanArr(x.length)
  let prev = NaN
  for (let i = 0; i < x.length; i++) {
    prev = i === 0 || !Number.isFinite(prev) ? x[i]! : alpha * x[i]! + (1 - alpha) * prev
    if (i >= minPeriods - 1) out[i] = prev
  }
  return out
}
export const ema = (x: number[], n: number) => ewm(x, 2 / (n + 1), n)

/** Wilder ATR: RMA(true range, n), seeded at the first TR (first bar uses H-L). */
export function atr(h: number[], l: number[], c: number[], n: number): number[] {
  const tr = h.map((hi, i) => (i === 0 ? hi - l[i]! : Math.max(hi - l[i]!, Math.abs(hi - c[i - 1]!), Math.abs(l[i]! - c[i - 1]!))))
  return ewm(tr, 1 / n, n)
}

/** max(high[i-n..i-1]); current bar excluded. */
export function donchian(h: number[], n: number): number[] {
  const out = nanArr(h.length)
  for (let i = n; i < h.length; i++) {
    let m = -Infinity
    for (let j = i - n; j < i; j++) if (h[j]! > m) m = h[j]!
    out[i] = m
  }
  return out
}

/** Rolling mean over the window ending at i (inclusive). */
export function sma(x: number[], n: number): number[] {
  const out = nanArr(x.length)
  for (let i = n - 1; i < x.length; i++) {
    let s = 0
    for (let j = i - n + 1; j <= i; j++) s += x[j]!
    out[i] = s / n
  }
  return out
}

/** Rolling POPULATION std (ddof=0) — the Bollinger width in the spec uses ddof=0. */
export function rollingStd0(x: number[], n: number): number[] {
  const out = nanArr(x.length)
  for (let i = n - 1; i < x.length; i++) {
    let m = 0
    for (let j = i - n + 1; j <= i; j++) m += x[j]!
    m /= n
    let v = 0
    for (let j = i - n + 1; j <= i; j++) v += (x[j]! - m) ** 2
    out[i] = Math.sqrt(v / n)
  }
  return out
}

/** Linear-interpolated quantile of `w` (pandas default). */
export function quantile(w: number[], q: number): number {
  const s = [...w].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo)
}

/** Rolling quantile over the window ending at i (inclusive); NaN unless the full window is finite. */
export function rollingQuantile(x: number[], n: number, q: number): number[] {
  const out = nanArr(x.length)
  for (let i = n - 1; i < x.length; i++) {
    const w = x.slice(i - n + 1, i + 1)
    if (w.every(Number.isFinite)) out[i] = quantile(w, q)
  }
  return out
}

/** Rolling median over the window ending at i (inclusive); NaN unless the full window is finite. */
export function rollingMedian(x: number[], n: number): number[] {
  return rollingQuantile(x, n, 0.5)
}

export const shift = (x: number[], k: number): number[] => x.map((_, i) => (i - k >= 0 ? x[i - k]! : NaN))

/** Kaufman efficiency ratio over `n` bars: |net move| / sum|bar moves|. NaN if incomplete or the denominator is 0. */
export function efficiencyRatio(c: number[], n: number): number[] {
  const out = nanArr(c.length)
  for (let i = n; i < c.length; i++) {
    let path = 0
    let ok = true
    for (let j = i - n + 1; j <= i; j++) {
      const d = Math.abs(c[j]! - c[j - 1]!)
      if (!Number.isFinite(d)) { ok = false; break }
      path += d
    }
    const net = Math.abs(c[i]! - c[i - n]!)
    if (ok && Number.isFinite(net) && path > 0) out[i] = net / path
  }
  return out
}

/**
 * Share of the prior `n` finite values (i-n..i-1) that are <= x[i]. Starts at index n+1 (reference
 * `range(window+1, len)`), so 301 bars are needed for n=300.
 */
export function priorRank(x: number[], n: number): number[] {
  const out = nanArr(x.length)
  for (let i = n + 1; i < x.length; i++) {
    if (!Number.isFinite(x[i]!)) continue
    let cnt = 0
    let fin = 0
    for (let j = i - n; j < i; j++) {
      const v = x[j]!
      if (!Number.isFinite(v)) continue
      fin++
      if (v <= x[i]!) cnt++
    }
    if (fin > 0) out[i] = cnt / fin
  }
  return out
}
