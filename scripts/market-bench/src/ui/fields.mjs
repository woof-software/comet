// The form: element lookup, and the translation between DOM values and the
// records the model runs on.

import { buildParams } from "../model/params.mjs";

export const $ = (id) => document.getElementById(id);

// What the chain says. These are filled from a market snapshot and are read-only
// until the viewer asks for the pencil — a typo in baseBorrowIndex silently turns
// a real market into a fictional one, and the whole point of the bench is that it
// is not showing a fiction.
export const STATE_IDS = [
  "decimals", "totalSupplyBase", "totalBorrowBase", "bsi", "bbi", "reserves", "pendingSecs",
  "supplyKink", "sBaseY", "sLowY", "sHighY",
  "borrowKink", "bBaseY", "bLowY", "bHighY",
  "tsi", "tbi", "baseMinForRewards", "trackSupplySpeed", "trackBorrowSpeed",
];

// What the viewer is simulating. Always editable: this is the input the bench
// exists for. One signed field per lever — minus withdraws, plain deposits.
export const ACTION_IDS = ["actSupply", "actReserves", "actDelayValue"];

export const WINDOW_IDS = ["rangeValue"];
export const IDS = [...STATE_IDS, ...ACTION_IDS, ...WINDOW_IDS];
export const SELECTS = ["rangeUnit", "freq", "actDelayUnit"];

// The form is the live page's parameter record; the model is built from a plain
// record, so a snapshot or a test can build the same one without a browser.
export const readModel = () => buildParams(collectValues());

export function collectValues() {
  const v = {};
  IDS.forEach(id => { v[id] = $(id).value; });
  SELECTS.forEach(id => { v[id] = $(id).value; });
  return v;
}

/** Fill whatever fields a record names; keys with no field on the page are ignored. */
export function applyValues(v) {
  for (const [k, val] of Object.entries(v || {})) {
    const el = $(k); if (!el) continue;
    if (el.type === "checkbox") el.checked = !!val; else el.value = val;
  }
}

// Empty, not "0": a zero sitting in the box has to be deleted before anything
// can be typed, and `toBig("")` is 0n anyway. The placeholder carries the
// default, so nothing about the form's meaning is lost.
export const clearActions = () => ACTION_IDS.forEach(id => { $(id).value = ""; });


export function setStateEditable(on) {
  STATE_IDS.forEach(id => {
    const el = $(id);
    el.readOnly = !on;
    el.classList.toggle("locked", !on);
  });
}
