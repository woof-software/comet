// Paints every readout from one pass of the model. Called on any input change.
//
// One run, two states: the snapshot as the chain holds it, and the state the
// viewer's actions produce. The trajectory, the sites and the charts all run on
// the second one — the first is kept only so every tile can say what changed.

import { FACTOR, MAXES } from "../model/constants.mjs";
import { log10 } from "../model/numeric.mjs";
import { accrue, pv, settle, utilization } from "../model/accrual.mjs";
import { checkInvariants } from "../model/invariants.mjs";
import { runTrajectory, accrueOver, HALT_SEARCH_STEPS } from "../model/trajectory.mjs";
import { applyActions, anyActions, ZERO_ACTIONS } from "../model/actions.mjs";
import { curvePosition } from "../model/curve.mjs";
import { $, readModel } from "./fields.mjs";
import { grp, sci, scaled, secs, apr, ratio, pct, plural } from "./format.mjs";
import { lineChart } from "./chart.mjs";
import { renderActions } from "./actions.mjs";
import { renderCurves } from "./curve.mjs";

const tile = (lab, val, sub, was) =>
  `<div class="tile"><span class="t-lab">${lab}</span><span class="t-val">${val}</span>` +
  `<span class="t-sub">${sub}</span>${was ? `<span class="t-was">${was}</span>` : ""}</div>`;

export function render() {
  const { cfg, st: stored, opt, actions, pendingSecs, dt, steps, window: win } = readModel();

  // --- the chain's own catch-up, before anything else
  //     Storage is stale by (blockTime − lastAccrualTime); every read the market
  //     answers already includes this accrual, and so does the next transaction.
  //     Skipping it would show the market as it was last touched, not as it is.
  const settled = settle(cfg, stored, opt, pendingSecs);
  const atBlock = settled.st;

  // --- the wait before the actions land
  //     One clock for the whole page: zero is the snapshot height, the wait is
  //     walked at the window's own cadence, and the action is an event inside
  //     the range rather than a second origin. An action past the end of the
  //     range is refused, not accommodated — the range is the viewer's input.
  const wait = actions.outside ? 0n : actions.delay;
  const pre = accrueOver(cfg, atBlock, opt, wait, dt);
  const snapshot = pre.st;
  // The market can die during the wait. Then the action never lands — every
  // entry point accrues first (:950, :1471) — and the run that follows walks
  // into the same revert one step later and reports it there.
  const reached = pre.halted === null && !actions.outside;

  // --- the viewer's actions, applied at the moment they land
  const act = applyActions(snapshot, reached ? actions : ZERO_ACTIONS);
  const st = act.st;
  const changed = anyActions(act.applied);
  // An empty market accrues fine (:319, :365-366) — but the path there runs
  // through the dust band, so reporting it as LIVE would be the one lie the
  // bench must not tell.
  const bricked = act.notes.some(n => n.code === "drainedWithBorrow");
  renderActions({ cfg, act, timing: {
    delay: actions.delay, outside: actions.outside, reached,
    planned: anyActions(actions), horizonSecs: win.horizonSecs,
    haltedAt: pre.halted?.t ?? null, after: win.horizonSecs - actions.delay,
  } });

  // --- states the contract could never hold: say so before showing any number
  const problems = checkInvariants({ cfg, st, opt });
  $("invariantsPanel").hidden = problems.length === 0;
  $("invariants").innerHTML = problems
    .map(p => `<div><b>${p.field}</b> — ${p.message}</div>`).join("");

  // --- derived labels on the rail. These annotate the state INPUTS — the raw
  //     storage slots typed into the fields above them — so they read the STORED
  //     state, before the catch-up accrual and before the actions.
  const bs = cfg.baseScale;
  $("dSupply").textContent = "PV ≈ " + scaled(pv(stored.bsi, stored.supplyP), bs, 6) + " base units";
  $("dBorrow").textContent = "PV ≈ " + scaled(pv(stored.bbi, stored.borrowP), bs, 6) + " base units";
  // A token balance can never be negative, so R < B - S is a state no chain can reach.
  // That bound is the whole profile argument: u <= B/(B-R), unbounded once B <= R.
  const cashNeg = stored.cash < 0n;
  $("dCash").textContent = cashNeg
    ? "unreachable state: cash = R + S − B = " + scaled(stored.cash, bs, 2) + " < 0, violates S ≥ B − R"
    : "cash = R + S − B = " + scaled(stored.cash, bs, 2) + " base units";
  $("dPending").textContent = pendingSecs === 0n
    ? "0 — the stored indices are already current at the snapshot height"
    : secs(Number(pendingSecs)) + " — that long without an accrueInternal call before the snapshot height";
  $("dCash").style.color = cashNeg ? "var(--critical)" : "";
  $("dSBase").textContent  = "= " + grp(cfg.sBase) + " /s";
  $("dSLow").textContent   = "= " + grp(cfg.sLow) + " /s";
  $("dSHigh").textContent  = "= " + grp(cfg.sHigh) + " /s";
  $("dBBase").textContent  = "= " + grp(cfg.bBase) + " /s";
  $("dBLow").textContent   = "= " + grp(cfg.bLow) + " /s";
  $("dBHigh").textContent  = "= " + grp(cfg.bHigh) + " /s";

  $("horizon").innerHTML = win.truncated
    ? `${grp(BigInt(steps))} × ${grp(dt)} s = ${secs(Number(win.horizonSecs))} — <b class="warn">range truncated</b>: `
      + `${grp(BigInt(win.requestedSteps))} steps over ${secs(Number(win.requestedSecs))} cannot be computed, pick a coarser cadence`
    : `${grp(BigInt(steps))} ${steps === 1 ? "step" : "steps"} × ${grp(dt)} s = ${secs(Number(win.horizonSecs))}`;

  // --- the run itself
  const rest = Math.max(0, steps - pre.steps);
  const run = runTrajectory(cfg, st, dt, opt, rest);
  const { first, last, haltAt, timeToHalt: ttl, searchExhausted } = run;
  // The wait and the run are one timeline. Where they meet, both states are
  // kept: the last row before the action and the first after it are the same
  // instant, and the gap between them IS the action.
  const traj = [...pre.rows, ...run.traj];
  const before = accrue(cfg, snapshot, dt, opt);
  const idxMax = MAXES[opt.idxWidth];
  const end = traj[traj.length - 1];

  // --- t₀ tiles: the market after the actions, with what it was before
  const wasU = changed && before.uTrue !== first.uTrue;
  const uSub = (u) => (u === 0n ? "empty supply → u = 0" : "= " + pct(u));
  const same = (a, b) => !changed || a === b;
  $("tiles").innerHTML = [
    ["utilization", first.uTrue === 0n ? "0" : sci(first.uTrue), uSub(first.uTrue),
      wasU ? `was ${sci(before.uTrue)}` : ""],
    ["totalSupply PV", scaled(act.after.S, bs, 4), grp(st.supplyP) + " principal",
      same(act.after.S, act.before.S) ? "" : `was ${scaled(act.before.S, bs, 4)}`],
    ["totalBorrow PV", scaled(act.after.B, bs, 4), grp(st.borrowP) + " principal", ""],
    ["reserves", scaled(act.after.R, bs, 2),
      act.after.R >= act.after.B ? "R ≥ B — no ceiling on u"
        : "R/B = " + (act.after.B === 0n ? "—" : (Number(act.after.R) / Number(act.after.B) * 100).toFixed(2) + " %"),
      same(act.after.R, act.before.R) ? "" : `was ${scaled(act.before.R, bs, 2)}`],
    ["cash · token balance", scaled(act.after.cash, bs, 2), "this much the market can pay out",
      same(act.after.cash, act.before.cash) ? "" : `was ${scaled(act.before.cash, bs, 2)}`],
    ["supply rate /s", first.sr.early ? "0" : grp(first.sr.v), first.sr.early || ("APR " + apr(first.sr.v)),
      same(first.sr.v, before.sr.v) ? "" : `was APR ${apr(before.sr.v)}`],
    ["borrow rate /s", first.br.early ? "0" : grp(first.br.v), first.br.early || ("APR " + apr(first.br.v)),
      same(first.br.v, before.br.v) ? "" : `was APR ${apr(before.br.v)}`],
  ].map(a => tile(...a)).join("");
  $("t0hint").textContent = [
    // the state's own clock, not the planned one: a wait cut short by a revert
    // leaves t₀ where the market actually stopped
    snapshot.t === 0n ? "snapshot height" : `snapshot height + ${secs(Number(snapshot.t))}`,
    settled.applied ? "settled" : settled.halted ? "accrueInternal reverts" : null,
    changed ? "after the actions" : null,
    "before the next accrual",
  ].filter(Boolean).join(" · ");

  // --- what the catch-up did, said once under the tiles
  const uWas = pv(stored.bbi, stored.borrowP) === 0n || pv(stored.bsi, stored.supplyP) === 0n
    ? null : utilization(stored);
  const settleNote = settled.halted
    ? `<b style="color:var(--critical)">The market is already halted at this height.</b> ` +
      `<b>${secs(Number(settled.elapsed))}</b> have passed since <code>lastAccrualTime</code>, and accrueInternal ` +
      `reverts over that interval: ${settled.sites.map(s => `${s.id} · ${s.name}`).join(", ")}. ` +
      `No transaction goes through on such a market — not even <code>supply</code> or ` +
      `<code>withdrawReserves</code>, because both accrue first (:950, :1471). ` +
      `The tiles below show the <b>stored</b> state, because no settled one exists.`
    : settled.applied
    ? `<b>The tiles show the state with accrueInternal already applied.</b> <code>TotalsBasic</code> in storage ` +
      `is current only as of <code>lastAccrualTime</code>; the snapshot was read ` +
      `<b>${secs(Number(settled.elapsed))}</b> later, and those seconds are already accrued here — exactly as ` +
      `the next transaction will do it, and as <code>getUtilization</code> and ` +
      `<code>getReserves</code> already do (:397). The stored indices are shown on the rail to the left; ` +
      `here <code>baseBorrowIndex</code> ${sci(stored.bbi)} → <b>${sci(snapshot.bbi)}</b>` +
      (uWas === null ? "" : `, utilization ${pct(uWas)} → <b>${pct(utilization(snapshot))}</b>`) + `.`
    : `<b>Accrual is current.</b> The "not accrued" field = 0, so <code>TotalsBasic</code> ` +
      `in storage matches the state at the snapshot height and there is nothing to settle.`;

  // The wait is a second hop on the same clock, so it is explained in the same
  // note — and when it swallows the action, that is the headline, not a footnote.
  const waitNote = actions.outside
    ? `<br><br><b style="color:var(--critical)">The action falls outside the range — it was not executed.</b> ` +
      `The delay <b>${secs(Number(actions.delay))}</b> is longer than the window ` +
      `<b>${secs(Number(win.horizonSecs))}</b>, so there is nothing to observe after it. The tiles show ` +
      `a market nobody touched: either widen the range in the "Time" panel, or shorten the delay.`
    : pre.halted
    ? `<br><br><b style="color:var(--critical)">The action does not make it: the market breaks down in ` +
      `${secs(Number(pre.halted.t))}</b>, that is, before the planned ` +
      `${secs(Number(actions.delay))}. Reverting at ${pre.halted.sites.map(x => `${x.id} · ${x.name}`).join(", ")}. ` +
      `After that no transaction goes through, so the action was not applied.`
    : wait === 0n
    ? ""
    : `<br><br><b>The actions land ${secs(Number(wait))} after the snapshot height.</b> The market lived ` +
      `through that time on its own — ${grp(BigInt(pre.steps))} ${plural(pre.steps, ["step", "steps"])} × ` +
      `${grp(dt)} s, at the same cadence as the window. The tiles show the state right after the actions, "was" is the moment ` +
      `before them, so the difference in the tiles is the action, not drift. That leaves ` +
      `<b>${secs(Number(win.horizonSecs - actions.delay))}</b> of the ${secs(Number(win.horizonSecs))} range to observe after the action.`;

  $("t0note").innerHTML = settleNote + waitNote;

  // --- where that state sits on the two rate curves
  //     The same u and the same state the accrual above used, so the leg shown
  //     is the leg that priced the tiles — not a second reading of the market.
  renderCurves({
    cfg,
    pos: curvePosition(cfg, st, first.u, act.after.S, act.after.B),
    traj, horizonSecs: win.horizonSecs,
  });

  // --- forecast tiles: where the window leaves the market
  //     One more accrual off the last state names the site that is closest to its
  //     type — when the run halted, that is the accrual that did it.
  const endProbe = accrue(cfg, last, dt, opt);
  const tight = endProbe.sites.reduce((a, b) =>
    (Number(b.value) / Number(b.limit) > Number(a.value) / Number(a.limit) ? b : a));
  $("forecast").innerHTML = [
    ["time to breakdown",
      bricked ? "bricking under way" : ttl === null ? "not reached" : secs(Number(ttl)),
      bricked ? "S = 0 with live debt — the end state is safe, the path to it is not"
        : ttl === null ? (searchExhausted ? "> " + secs(Number(dt) * HALT_SEARCH_STEPS) + " without a breakdown" : "breakdown unreachable")
        : haltAt !== null ? "inside the window" : "beyond the window"],
    ["utilization at the end", end.u === 0n ? "0" : sci(end.u), uSub(end.u)],
    ["borrow APR at the end", apr(end.br), "supply APR " + apr(end.sr)],
    ["baseBorrowIndex at the end", sci(end.bbi), ratio(end.bbi, idxMax) + " × of uint64.max"],
    ["tightest site", "#" + tight.id, tight.name + " · " + ratio(tight.value, tight.limit) + " × of the limit"],
  ].map(a => tile(...a)).join("");
  $("forecastHint").textContent =
    `state at the end of the window · ${secs(Number(win.horizonSecs))} · accrue every ${grp(dt)} s`;

  // "At the end" is the end of the chosen range, not the end of the market's life —
  // and the tiles say it in three places, so the disclaimer is said once, here,
  // with the actual window in it rather than as a word.
  $("forecastNote").innerHTML =
    `<b>"At the end" means the end of the chosen time range</b>, not the end of the market's life: ` +
    `the window <b>${secs(Number(win.horizonSecs))}</b> — ${grp(BigInt(steps))} ` +
    `${plural(steps, ["step", "steps"])} × ${grp(dt)} s from the "Time" panel. ` +
    `The tiles above describe the state at the last step of that window; change the range and they change too. ` +
    `<br><br><b>"Time to breakdown" is searched beyond the window too.</b> If the market survived ` +
    `inside the range, the bench additionally runs up to ${grp(BigInt(HALT_SEARCH_STEPS))} steps at the same cadence, ` +
    `to say how far away the wall is — rather than just "fine so far".`;

  // --- revert sites at t₀
  $("sites").innerHTML = first.sites.map(s => {
    const chip = s.trip
      ? `<span class="chip chip-trip">REVERT</span>`
      : (s.value === 0n ? `<span class="chip chip-idle">IDLE</span>` : `<span class="chip chip-ok">OK</span>`);
    return `<tr class="${s.trip ? "tripped" : ""}">
      <td><span class="site-name">${s.name}</span><br><span class="site-loc">${s.loc}</span></td>
      <td class="num mono">${grp(s.value)}<br><span class="site-loc">${sci(s.value)}</span></td>
      <td class="num mono">${sci(s.limit)}<br><span class="site-loc">uint64</span></td>
      <td class="num mono">${ratio(s.value, s.limit)}</td>
      <td>${chip}</td></tr>`;
  }).join("");

  // --- lamps
  $("lamps").innerHTML = first.sites.map(s =>
    `<div class="lamp ${s.trip ? "trip" : (s.value === 0n ? "off" : "")}" title="${s.name}"><i></i><b>${s.id}</b></div>`).join("");

  // --- verdict
  const vb = $("verdict");
  if (bricked) {
    vb.className = "verdict-badge v-sat";
    vb.innerHTML = `<span class="vb-state">BRICKING UNDER WAY</span><span class="vb-note mono">supply = 0 with live debt</span>`;
  } else if (haltAt !== null) {
    vb.className = "verdict-badge v-halt";
    vb.innerHTML = `<span class="vb-state">HALTED</span><span class="vb-note mono">revert at t = ${secs(Number(haltAt))}</span>`;
  } else if (ttl !== null) {
    vb.className = "verdict-badge v-halt";
    vb.innerHTML = `<span class="vb-state">BREAKDOWN AHEAD</span><span class="vb-note mono">beyond the window: t ≈ ${secs(Number(ttl))}</span>`;
  } else {
    vb.className = "verdict-badge v-live";
    vb.innerHTML = `<span class="vb-state">LIVE</span><span class="vb-note mono">${searchExhausted ? "> " + secs(Number(dt) * HALT_SEARCH_STEPS) + " without a breakdown" : "breakdown unreachable"}</span>`;
  }

  // --- charts
  const xMax = traj[traj.length - 1].t;
  lineChart($("chartIdx"), $("tipIdx"), $("wrapIdx"), {
    height: 290, xMax,
    ceiling: log10(idxMax), ceilingLabel: "uint64.max",
    yLabelFmt: (p) => "1e" + p,
    series: [
      { name: "baseSupplyIndex", color: "var(--series-1)", values: traj.map(r => log10(r.bsi)), raw: traj.map(r => sci(r.bsi)), endLabel: sci(end.bsi) },
      { name: "baseBorrowIndex", color: "var(--series-2)", values: traj.map(r => log10(r.bbi)), raw: traj.map(r => sci(r.bbi)), endLabel: sci(end.bbi) },
    ]
  });
  lineChart($("chartU"), $("tipU"), $("wrapU"), {
    height: 230, xMax,
    ceiling: log10(FACTOR * 2n), ceilingLabel: "2e18 · ceiling",
    yLabelFmt: (p) => "1e" + p,
    series: [
      { name: "utilization", color: "var(--series-1)", values: traj.map(r => log10(r.u > 0n ? r.u : 1n)), raw: traj.map(r => sci(r.u)), endLabel: sci(end.u) },
    ]
  });

  // --- step table (sampled, always keeping first and last)
  const keep = [];
  const maxRows = 14;
  const stride = Math.max(1, Math.ceil(traj.length / maxRows));
  for (let i = 0; i < traj.length; i += stride) keep.push(i);
  if (keep[keep.length - 1] !== traj.length - 1) keep.push(traj.length - 1);
  $("stepRows").innerHTML = keep.map(i => {
    const r = traj[i];
    const chip = r.state === "halt" ? `<span class="chip chip-trip">REVERT</span>` : `<span class="chip chip-ok">OK</span>`;
    return `<tr class="${r.state === "halt" ? "tripped" : ""}">
      <td class="num mono">${i}</td>
      <td class="num mono">${secs(Number(r.t))}</td>
      <td class="num mono">${sci(r.u)}</td>
      <td class="num mono">${apr(r.sr)}</td>
      <td class="num mono">${apr(r.br)}</td>
      <td class="num mono">${sci(r.bsi)}</td>
      <td class="num mono">${sci(r.bbi)}</td>
      <td>${chip}</td></tr>`;
  }).join("");
  $("stepHint").textContent = `${traj.length - 1} steps computed · ${keep.length} shown`;
}
