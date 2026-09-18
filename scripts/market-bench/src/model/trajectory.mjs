// Repeated accrual over a window, plus the search for a halt beyond it.
//
// Pure — state in, state out, no DOM — so a CLI or a differential test against
// the Foundry fixture can call it.

import { accrue, utilization } from "./accrual.mjs";

// How far past the visible window to keep looking for a halt before giving up.
export const HALT_SEARCH_STEPS = 20000;

/**
 * Walk `total` seconds at cadence `dt`, landing exactly on the end.
 *
 * Used for the wait before a simulated action lands. The cadence is the window's
 * own — `freq` means "how often somebody touches this market", which is a fact
 * about the world and not about which side of the action a second falls on —
 * and the leftover is its own shorter accrual, because a transaction at an
 * arbitrary moment accrues the time since the last touch, not a whole tick.
 *
 * On a revert it stops at the last live state WITHOUT recording the halt: the
 * caller keeps walking from there and reproduces the same revert one step later,
 * so the halt is reported once, by whoever owns the window.
 */
export function accrueOver(cfg, st, opt, total, dt) {
  if (total <= 0n || dt <= 0n) return { st, rows: [], halted: null, steps: 0 };

  const head = accrue(cfg, st, total < dt ? total : dt, opt);
  const rows = [{ t: st.t, u: head.uTrue, sr: head.sr.v, br: head.br.v, bsi: st.bsi, bbi: st.bbi, state: "start" }];

  let cur = st, left = total, halted = null, steps = 0;
  while (left > 0n) {
    const step = left < dt ? left : dt;
    const r = accrue(cfg, cur, step, opt);
    if (r.halted) { halted = { t: cur.t + step, sites: r.sites.filter(s => s.trip) }; break; }
    cur = r.next;
    left -= step;
    steps++;
    rows.push({ t: cur.t, u: utilization(cur), sr: r.sr.v, br: r.br.v, bsi: cur.bsi, bbi: cur.bbi, state: "ok" });
  }
  return { st: cur, rows, halted, steps };
}

export function runTrajectory(cfg, st, dt, opt, steps) {
  const first = accrue(cfg, st, dt, opt);
  // The clock is absolute — zero is the snapshot height — so a run that starts
  // after a wait opens where the wait left off, not at zero again.
  const traj = [{ t: st.t, u: first.uTrue, sr: first.sr.v, br: first.br.v, bsi: st.bsi, bbi: st.bbi, state: "start" }];

  let cur = st, haltAt = null, satFrom = null;
  for (let i = 0; i < steps; i++) {
    const r = accrue(cfg, cur, dt, opt);
    if (r.halted) { haltAt = cur.t + dt; traj.push({ t: cur.t + dt, u: r.uTrue, sr: r.sr.v, br: r.br.v, bsi: cur.bsi, bbi: cur.bbi, state: "halt" }); break; }
    if (r.saturated && satFrom === null) satFrom = cur.t + dt;
    cur = r.next;
    traj.push({ t: cur.t, u: utilization(cur), sr: r.sr.v, br: r.br.v, bsi: cur.bsi, bbi: cur.bbi, state: r.saturated ? "sat" : "ok" });
  }

  // Nothing halted inside the window: keep stepping, capped, to say how far off it is.
  let timeToHalt = haltAt, probe = cur, guard = 0;
  if (timeToHalt === null && !opt.saturate) {
    while (guard++ < HALT_SEARCH_STEPS) {
      const r = accrue(cfg, probe, dt, opt);
      if (r.halted) { timeToHalt = probe.t + dt; break; }
      probe = r.next;
    }
  }

  // `last` is the state the window ends on — the state before the halting accrual
  // when one happened. The caller re-accrues it to ask which site is closest.
  return { first, traj, last: cur, haltAt, satFrom, timeToHalt, searchExhausted: guard >= HALT_SEARCH_STEPS };
}
