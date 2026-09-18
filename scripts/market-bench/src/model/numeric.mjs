// BigInt parsing and measurement. No DOM, no formatting for humans —
// that lives in ui/format.mjs.

// Accepts 1000, 1_000, 20000e6, 0.04e18, 2e18
export function toBig(raw) {
  if (raw == null) return 0n;
  let s = String(raw).trim().replace(/[_\s ]/g, "");
  if (s === "" || s === "-") return 0n;
  let neg = false;
  if (s[0] === "-") { neg = true; s = s.slice(1); }
  let exp = 0n;
  const e = s.search(/[eE]/);
  if (e !== -1) { exp = BigInt(s.slice(e + 1) || "0"); s = s.slice(0, e); }
  const dot = s.indexOf(".");
  if (dot !== -1) { exp -= BigInt(s.length - dot - 1); s = s.slice(0, dot) + s.slice(dot + 1); }
  if (!/^\d*$/.test(s)) return 0n;
  let v = BigInt(s === "" ? "0" : s);
  if (exp > 0n) v *= 10n ** exp;
  else if (exp < 0n) v /= 10n ** (-exp);
  return neg ? -v : v;
}

export const log10 = (b) => { // log10 of a positive BigInt, as a float
  if (b <= 0n) return 0;
  const s = b.toString();
  return (s.length - 1) + Math.log10(Number(s.slice(0, 16)) / 10 ** (Math.min(s.length, 16) - 1));
};
