// Numbers for people: grouping, scientific notation, durations, APR.

import { SPY, FACTOR } from "../model/constants.mjs";

const NBSP = " ";
export function grp(b) {
  const neg = b < 0n; const s = (neg ? -b : b).toString();
  return (neg ? "-" : "") + s.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}
// 1888000035500000000000000000 -> "1.888e27"
export function sci(b, digits = 3) {
  if (b === 0n) return "0";
  const neg = b < 0n; const s = (neg ? -b : b).toString();
  if (s.length <= digits + 1) return (neg ? "-" : "") + s;
  const head = s[0] + "." + s.slice(1, 1 + digits);
  return (neg ? "-" : "") + head + "e" + (s.length - 1);
}
// scaled BigInt -> human decimal string
export function scaled(b, scale, dp = 4) {
  const neg = b < 0n; let v = neg ? -b : b;
  const int = v / scale; let frac = (v % scale).toString().padStart(scale.toString().length - 1, "0");
  frac = frac.slice(0, dp).replace(/0+$/, "");
  return (neg ? "-" : "") + grp(int) + (frac ? "." + frac : "");
}
// A signed base-unit amount. The sign is the actions panel's whole input
// convention — plus deposits, minus withdraws — so it is printed, never dropped,
// and the typographic minus is the one the fields are documented with.
export const signed = (v, scale, dp = 4) =>
  (v > 0n ? "+" : v < 0n ? "−" : "") + scaled(v < 0n ? -v : v, scale, dp);

// A FACTOR-scaled ratio as a percentage: utilization 3464300000000000000 -> "346.43 %".
// Exact — the ratio stays a BigInt until the last division — and adaptive: a
// market at 0.0004 % utilization is as real as one at 346 %, and two decimals
// would print both as "0 %".
export function pct(u, dp = 2) {
  if (u === 0n) return "0 %";
  const neg = u < 0n;
  const whole = (neg ? -u : u) * 100n / FACTOR;
  if (whole >= 1000000000n) return (neg ? "-" : "") + sci(whole) + " %";
  const out = scaled(u * 100n, FACTOR, whole >= 1n ? dp : 6);
  // Dust rounds to "0 %", which reads as an empty market rather than a tiny one.
  return out === "0" ? (neg ? "> -0.000001 %" : "< 0.000001 %") : out + " %";
}
export function secs(n) {
  n = Number(n);
  if (n < 90) return n + " s";
  if (n < 5400) return (n / 60).toFixed(n < 600 ? 1 : 0) + " min";
  if (n < 172800) return (n / 3600).toFixed(n < 36000 ? 1 : 0) + " h";
  if (n < 63072000) return (n / 86400).toFixed(n < 864000 ? 1 : 0) + " d";
  return (n / 31536000).toFixed(1) + " y";
}
// per-second rate (1e18) -> APR as a plain number of per cent. The charts plot
// this; apr() below is the same value dressed for a reader.
export const aprNum = (rate) => Number(rate * SPY) / 1e18 * 100;

// per-second rate (1e18) -> APR percent string
export function apr(rate) {
  const p = aprNum(rate);
  if (!isFinite(p)) return "∞";
  if (p >= 1e9) return sci(BigInt(Math.round(p))) + " %";
  if (p >= 1000) return p.toFixed(0) + " %";
  return p.toFixed(p < 10 ? 2 : 1) + " %";
}
export function ratio(a, b) { // a/b as a readable multiple
  if (b === 0n) return "—";
  const r = Number(a) / Number(b);
  if (!isFinite(r)) return "∞";
  if (r === 0) return "0";
  if (r >= 1000 || r < 0.001) return r.toExponential(2).replace("e+", "e");
  return r.toFixed(r < 10 ? 3 : 1);
}

// Numeral agreement: 1 lender, 2 lenders.
export function plural(n, [one, many]) {
  return Math.abs(Math.trunc(Number(n))) === 1 ? one : many;
}
export const lenders = (n) => `${n} ${plural(n, ["lender", "lenders"])}`;

export const esc = (s) => String(s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// How long ago an on-chain preset was read. Market state drifts every block, so
// the age of a snapshot is part of reading it.
export const STALE_AFTER_S = 24 * 3600;

export function ago(iso) {
  const then = Date.parse(iso);
  if (!isFinite(then)) return "unknown when";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 90) return Math.round(s) + " s ago";
  if (s < 5400) return Math.round(s / 60) + " min ago";
  if (s < 172800) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}

export const isStale = (iso) => {
  const then = Date.parse(iso);
  return !isFinite(then) || (Date.now() - then) / 1000 > STALE_AFTER_S;
};
