// Turns a raw parameter record — plain strings, exactly what the form holds —
// into the records the model runs on: the market state, the user's actions and
// the observation window.
//
// No DOM here on purpose: the same record can come from data/market-presets.json,
// from a CLI flag, or from a test, and produce the same run as the page.

import { SPY } from "./constants.mjs";
import { toBig } from "./numeric.mjs";
import { pv } from "./accrual.mjs";

// The shipped contract, and the only configuration the bench models: rates and
// indices are uint64, accrueInternal reverts rather than saturating, and
// getSupplyRate sees the true utilization. The remediation variants that used to
// be switchable live in legacy/ — they model code that is not in the tree.
export const CONTRACT_OPT = Object.freeze({
  rateWidth: 64, idxWidth: 64, clampOn: false, clampAt: 0n, saturate: false,
});

// A window is a range and a cadence, not a step count — but the trajectory is
// stepped, and a year of 12-second blocks is 2.6 million of them. Past this the
// window is truncated and the page says so, rather than freezing the tab.
export const MAX_STEPS = 10_000;

export function buildParams(v) {
  const decimals = Number(toBig(v.decimals)) || 0;
  const baseScale = 10n ** BigInt(Math.max(0, Math.min(36, decimals)));
  const perSec = (y) => y / SPY;              // exactly what the constructor does
  const cfg = {
    baseScale, decimals,
    supplyKink: toBig(v.supplyKink),
    sBase: perSec(toBig(v.sBaseY)),
    sLow:  perSec(toBig(v.sLowY)),
    sHigh: perSec(toBig(v.sHighY)),
    borrowKink: toBig(v.borrowKink),
    bBase: perSec(toBig(v.bBaseY)),
    bLow:  perSec(toBig(v.bLowY)),
    bHigh: perSec(toBig(v.bHighY)),
    baseMinForRewards: toBig(v.baseMinForRewards),
    trackSupplySpeed: toBig(v.trackSupplySpeed),
    trackBorrowSpeed: toBig(v.trackBorrowSpeed),
  };
  const supplyP = toBig(v.totalSupplyBase);
  const borrowP = toBig(v.totalBorrowBase);
  const bsi = toBig(v.bsi) || 1n;
  const bbi = toBig(v.bbi) || 1n;
  const reserves = toBig(v.reserves);
  // Reserves are the input, but the contract stores a token BALANCE: cash stays put
  // while S and B accrue, so R is what drifts. Pin cash at t0 from the identity
  // getReserves() = balance - S + B (:396-404) and let the run move R.
  //
  // Seconds the chain already owes this snapshot: blockTime − lastAccrualTime.
  // A property of the reading, not of the viewer — it ships inside the preset.
  const pendingSecs = (() => { const p = toBig(v.pendingSecs); return p > 0n ? p : 0n; })();
  const st = {
    supplyP, borrowP, bsi, bbi,
    tsi: toBig(v.tsi),
    tbi: toBig(v.tbi),
    cash: reserves + pv(bsi, supplyP) - pv(bbi, borrowP),
    t: 0n,
  };

  // The simulated user actions, written in human base units — 125000 means
  // 125 000 USDC, not 125 000 wei. Present value, applied at t₀, and SIGNED:
  // a leading minus is a withdrawal, anything else is a deposit. toBig already
  // carries the sign, so the form needs no direction control of its own.
  const human = (raw) => toBig(raw) * baseScale;

  // When the actions land, counted from the snapshot height. Zero — the default
  // — means the same block the state was read at. Anything else is a wait the
  // market spends accruing before the transaction arrives, which is why it is
  // measured on the same clock as the window and not on one of its own.
  const wait = toBig(v.actDelayValue) * (toBig(v.actDelayUnit) || 1n);
  const delay = wait > 0n ? wait : 0n;
  const w = buildWindow(v);
  const actions = {
    supply: human(v.actSupply), reserves: human(v.actReserves), delay,
    // Past the end of the range there is nothing left to observe, so the action
    // cannot be shown happening. Refusing it beats silently stretching a range
    // the viewer typed on purpose.
    outside: delay > w.window.horizonSecs,
  };

  return { cfg, st, opt: CONTRACT_OPT, actions, pendingSecs, ...w };
}

/** Range × cadence → the step count the trajectory actually walks. */
export function buildWindow(v) {
  const dt = toBig(v.freq) || 3600n;
  const unit = toBig(v.rangeUnit) || 86400n;
  const amount = toBig(v.rangeValue);
  const requestedSecs = amount > 0n ? amount * unit : unit;

  const wanted = (requestedSecs + dt - 1n) / dt;                       // ceil
  const requestedSteps = wanted < 1n ? 1 : Number(wanted < 10n ** 12n ? wanted : 10n ** 12n);
  const steps = Math.min(MAX_STEPS, requestedSteps);

  return {
    dt, steps,
    window: {
      requestedSecs, requestedSteps, unit, amount,
      truncated: steps < requestedSteps,
      horizonSecs: dt * BigInt(steps),
    },
  };
}
