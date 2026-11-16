// Phase 0 — measurement primitives. Throwaway.
import fs from "node:fs";
import path from "node:path";

export const now = () => performance.now();

/** Linear-interpolated percentile over a sorted numeric array. */
export function pct(sorted, p) {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export function summarize(name, samples, extra = {}) {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return {
    name,
    n: s.length,
    min: s[0] ?? null,
    p50: pct(s, 50),
    p90: pct(s, 90),
    p95: pct(s, 95),
    p99: pct(s, 99),
    max: s.at(-1) ?? null,
    mean,
    ...extra,
  };
}

/** Peak RSS of this process, MB. Child-process peak is not portable; see report. */
export function rssMB() {
  return process.memoryUsage().rss / 1024 / 1024;
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
  return file;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Tiny deterministic PRNG (xorshift32). */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

export function fmt(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toFixed(digits);
}

export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
