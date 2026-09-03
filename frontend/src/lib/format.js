// Reusable formatting helpers — single source of truth for pluralization & numeric precision.
export const plural = (n, word, pluralWord) => `${n} ${n === 1 ? word : pluralWord || word + "s"}`;
export const fmtScore = (v) => (v == null || isNaN(v) ? "—" : Number(v).toFixed(1));
export const fmtPts = (v) => {
  const a = Math.abs(Number(v));
  return `${a.toFixed(1)} ${a.toFixed(1) === "1.0" ? "point" : "points"}`;
};
export const fmtPct = (v) => (v == null || isNaN(v) ? "—" : `${Number(v).toFixed(1)}%`);
export const naIfNull = (v) => (v == null ? "N/A" : v);
