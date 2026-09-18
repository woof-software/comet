// A line chart drawn as SVG source. No library: the whole surface is a path,
// a dashed ceiling and one hit rectangle for the crosshair.
//
// Two axes are in use. Time is the default — evenly spaced samples, labelled in
// seconds. A curve passes `xs`, the real x value of every sample, because a
// piecewise line has to break exactly on its kink and not wherever the nearest
// even sample happened to fall.

import { secs } from "./format.mjs";

// The largest round step that still fits in `raw`, from the 1/2/2.5/5 family.
// Six arbitrary divisions of a range read as noise; six round ones read as an axis.
const niceStep = (raw) => {
  const p = 10 ** Math.floor(Math.log10(raw));
  return [10, 5, 2.5, 2, 1].map(f => f * p).find(v => v <= raw) ?? p;
};

export function lineChart(svg, tip, wrap, opts) {
  const {
    series, ceiling, ceilingLabel, xMax, yLabelFmt, height,
    xs = null, xMin = 0, xFmt = secs, xName = "t", marks = [], dots = [],
  } = opts;
  const W = 900, H = height, m = { t: 16, r: 108, b: 32, l: 62 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;

  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (const v of s.values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (ceiling !== null) hi = Math.max(hi, ceiling);
  if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
  lo = Math.floor(lo) - 0.35; hi = Math.ceil(hi) + 0.35;
  if (hi - lo < 1.2) { hi = lo + 1.2; }

  const n = series[0].values.length;
  const span = Number(xMax) - Number(xMin);
  // Evenly spaced by index, unless the caller says where each sample really sits.
  const at = (frac) => m.l + Math.max(0, Math.min(1, frac)) * iw;
  const xOf = (i) => (xs ? (Number(xs[i]) - Number(xMin)) / (span || 1) : (n <= 1 ? 0 : i / (n - 1)));
  const X = (i) => at(xOf(i));
  const Y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
  const valueAt = (i) => (xs ? Number(xs[i]) : Number(xMin) + span * (n <= 1 ? 0 : i / (n - 1)));

  const parts = [];
  const mono = `font-size="10.5" font-family="IBM Plex Mono, monospace"`;
  // grid + y ticks
  const tickCount = 6;
  const stepPow = Math.max(1, Math.ceil((hi - lo) / tickCount));
  for (let p = Math.ceil(lo); p <= Math.floor(hi); p += stepPow) {
    const y = Y(p);
    parts.push(`<line x1="${m.l}" y1="${y.toFixed(1)}" x2="${m.l + iw}" y2="${y.toFixed(1)}" stroke="var(--line-soft)" stroke-width="1" fill="none"/>`);
    parts.push(`<text x="${m.l - 9}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" ${mono} fill="var(--muted)">${yLabelFmt(p)}</text>`);
  }
  // x ticks. Evenly spaced samples put a tick on every nth sample, which is what
  // a time axis wants. Uneven ones put it on a round value instead — otherwise
  // the labels land wherever the inserted kink shifted the indices to.
  const xtick = (x, v) =>
    parts.push(`<text x="${x.toFixed(1)}" y="${(m.t + ih + 18).toFixed(1)}" text-anchor="middle" ${mono} fill="var(--muted)">${xFmt(v)}</text>`);
  if (xs) {
    const step = niceStep(span / 5);
    for (let v = Math.ceil(Number(xMin) / step) * step; v <= Number(xMax); v += step) {
      xtick(at((v - Number(xMin)) / span), v);
    }
  } else {
    const xt = Math.max(1, Math.round((n - 1) / 5));
    for (let i = 0; i < n; i += xt) xtick(X(i), valueAt(i));
  }
  // ceiling
  if (ceiling !== null && ceiling >= lo && ceiling <= hi) {
    const y = Y(ceiling);
    parts.push(`<line x1="${m.l}" y1="${y.toFixed(1)}" x2="${m.l + iw}" y2="${y.toFixed(1)}" stroke="var(--critical)" stroke-width="1.5" stroke-dasharray="5 4" fill="none"/>`);
    parts.push(`<text x="${m.l + iw + 8}" y="${(y + 3.5).toFixed(1)}" ${mono} fill="var(--critical)">${ceilingLabel}</text>`);
  }
  // Vertical marks — a kink, or the market's own position, are facts about the x
  // axis, so they are drawn on it rather than as a point on a line. `align` puts
  // the labels on opposite edges: two marks a fraction of a point apart is the
  // normal case here, and their labels must not land on top of each other.
  marks.forEach((k) => {
    const x = at(k.frac), top = k.align !== "bottom";
    parts.push(`<line x1="${x.toFixed(1)}" y1="${m.t}" x2="${x.toFixed(1)}" y2="${m.t + ih}" stroke="${k.color}" stroke-width="1.5" stroke-dasharray="4 4" fill="none"/>`);
    if (k.label) {
      const flip = k.frac > 0.8;
      parts.push(`<text x="${(x + (flip ? -5 : 5)).toFixed(1)}" y="${(top ? m.t + 11 : m.t + ih - 6).toFixed(1)}" text-anchor="${flip ? "end" : "start"}" ${mono} fill="${k.color}">${k.label}</text>`);
    }
  });
  // axes
  parts.push(`<line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${m.t + ih}" stroke="var(--line)" stroke-width="1" fill="none"/>`);
  parts.push(`<line x1="${m.l}" y1="${m.t + ih}" x2="${m.l + iw}" y2="${m.t + ih}" stroke="var(--line)" stroke-width="1" fill="none"/>`);
  // series
  series.forEach((s) => {
    const d = s.values.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
    parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    const li = s.values.length - 1;
    parts.push(`<circle cx="${X(li).toFixed(1)}" cy="${Y(s.values[li]).toFixed(1)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`);
    parts.push(`<text x="${(X(li) + 9).toFixed(1)}" y="${(Y(s.values[li]) + 3.5).toFixed(1)}" ${mono} fill="${s.color}">${s.endLabel}</text>`);
  });
  // where the market actually is, on top of the curve it is priced by
  dots.forEach((p) => {
    const x = at(p.frac), y = Y(p.v);
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6.5" fill="none" stroke="${p.color}" stroke-width="1.5" opacity=".5"/>`);
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${p.color}" stroke="var(--surface)" stroke-width="1.5"/>`);
    if (p.label) {
      const flip = p.frac > 0.72;
      parts.push(`<text x="${(x + (flip ? -10 : 10)).toFixed(1)}" y="${(y - 9).toFixed(1)}" text-anchor="${flip ? "end" : "start"}" ${mono} fill="${p.color}">${p.label}</text>`);
    }
  });
  parts.push(`<g id="cross" style="opacity:0"><line y1="${m.t}" y2="${m.t + ih}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" fill="none"/></g>`);
  parts.push(`<rect x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent" style="cursor:crosshair"/>`);
  svg.innerHTML = parts.join("");

  const cross = svg.querySelector("#cross"), cline = cross.querySelector("line");
  const hit = svg.querySelector("rect");
  hit.addEventListener("mousemove", (ev) => {
    const r = svg.getBoundingClientRect(), sc = W / r.width;
    const px = (ev.clientX - r.left) * sc;
    const frac = (px - m.l) / iw;
    // With uneven samples the nearest one is a search, not a multiplication.
    let i;
    if (xs) {
      i = 0;
      for (let k = 1; k < n; k++) if (Math.abs(xOf(k) - frac) < Math.abs(xOf(i) - frac)) i = k;
    } else {
      i = Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
    }
    cross.style.opacity = "1";
    cline.setAttribute("x1", X(i)); cline.setAttribute("x2", X(i));
    tip.style.opacity = "1";
    tip.innerHTML = `<div class="tt-h">${xName} = ${xFmt(valueAt(i))}</div>` +
      series.map(s => `<div class="tt-r"><span><i style="background:${s.color}"></i>${s.name}</span><span>${s.raw[i]}</span></div>`).join("");
    const wr = wrap.getBoundingClientRect();
    const left = (X(i) / sc) + (r.left - wr.left);
    tip.style.left = Math.min(Math.max(6, left + 12), wr.width - tip.offsetWidth - 6) + "px";
    tip.style.top = "14px";
  });
  hit.addEventListener("mouseleave", () => { cross.style.opacity = "0"; tip.style.opacity = "0"; });
}
