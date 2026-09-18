// The actions panel: what the two signed fields add up to, and what the
// protocol would have refused.
//
// The arithmetic is model/actions.mjs. This file only turns its structured
// notes into sentences — the model stays free of wording so it can be imported
// outside a browser.

import { $ } from "./fields.mjs";
import { scaled, signed, secs } from "./format.mjs";

// Why an amount came out smaller than it was typed. Every bound is the contract's.
const NOTE = {
  supplyOutOverSupply: (amt) =>
    `the liquidity withdrawal was clipped to <b>−${amt}</b> — the market simply has no more supply.`,
  supplyOutOverCash: (amt) =>
    `the liquidity withdrawal was clipped to <b>−${amt}</b> — that is all the cash the contract holds, the rest is with the borrowers.`,
  reservesOutOverReserves: (amt) =>
    `the reserves withdrawal was clipped to <b>−${amt}</b> — <code>withdrawReserves</code> reverts above <code>getReserves()</code> (:1471-1472).`,
  reservesOutOverCash: (amt) =>
    `the reserves withdrawal was clipped to <b>−${amt}</b> — that is all the base token balance holds, and <code>doTransferOut</code> pays out of exactly that.`,
  drainedWithBorrow: () =>
    `supply was drained to zero against live debt. Zero itself is safe (<code>:319</code>, <code>:365-366</code>), but it cannot be reached: every withdrawal accrues first, so the last lenders walk the market through the dust band and one of them reverts.`,
};

export function renderActions({ cfg, act, timing }) {
  const bs = cfg.baseScale;
  const { supply, reserves } = act.applied;

  const moved = [];
  if (supply !== 0n) moved.push(`${signed(supply, bs)} of liquidity`);
  if (reserves !== 0n) moved.push(`${signed(reserves, bs)} of reserves`);

  $("actionNet").textContent = moved.length === 0
    ? "no actions — below is the market's plain on-chain state"
    : moved.join(" · ");

  // When the actions land. The same clock as the window, counted from the height
  // the state was read at — so this line always says what it is measured against.
  const t = timing;
  $("actWhen").innerHTML = t.outside
    ? `<b style="color:var(--critical)">${secs(Number(t.delay))} is outside the range ` +
      `${secs(Number(t.horizonSecs))}.</b> The action was not executed: there is nothing to observe after it.`
    : t.haltedAt !== null
    ? `<b style="color:var(--critical)">The market breaks down in ${secs(Number(t.haltedAt))}</b> — ` +
      `sooner than the ${secs(Number(t.delay))} planned. The action was not executed: no transaction goes through any more.`
    : t.delay === 0n
    ? "in the same block the state was read at"
    : `${secs(Number(t.delay))} after the snapshot height · until then the market accrues on its own · ` +
      `${secs(Number(t.after))} left to observe after the action`;

  $("actionNotes").hidden = act.notes.length === 0;
  $("actionNotes").innerHTML = act.notes
    .map(n => `<div>${NOTE[n.code](n.cap === undefined ? "" : scaled(n.cap, bs, 4))}</div>`)
    .join("");
}
