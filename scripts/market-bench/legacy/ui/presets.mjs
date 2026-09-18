// Preset rail: the built-in set from data/presets.json, plus whatever the
// viewer saved. Everything the store touches goes through initPresets, so the
// store stays swappable — localStorage today, a file or a service later.

import { $, collectValues, applyValues } from "./fields.mjs";
import { esc, ago } from "./format.mjs";
import { clearMarketSelection } from "./markets.mjs";
import { storageWorks, localStore, STORE_KEY } from "../store/local.mjs";
import { openRepoStore } from "../store/repo.mjs";

let BUILT_IN = [];              // data/presets.json, loaded by main.mjs
let onChange = () => {};        // render, injected — this module never imports it
let activePreset = "probe";
let savedPresets = [], activeSaved = null, store = null;
let activeMarket = null;        // an on-chain preset, kept for the provenance line

function fmtWhen(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
}



function paintPresets() {
  $("presets").innerHTML = BUILT_IN.map(p =>
    `<button class="preset" data-key="${p.key}" aria-pressed="${p.key === activePreset}">
       <strong>${esc(p.name)}</strong><span>${esc(p.sub)}</span></button>`).join("");
  $("presets").querySelectorAll("button").forEach(b => {
    b.addEventListener("click", () => {
      const p = BUILT_IN.find(x => x.key === b.dataset.key);
      activePreset = p.key; activeSaved = null; activeMarket = null;
      clearMarketSelection();
      applyValues(p.v);
      paintPresets(); paintSaved(); onChange();
    });
  });
  const built = BUILT_IN.find(p => p.key === activePreset);
  $("provenance").textContent = built ? built.prov
    : activeMarket
      ? `On-chain state of ${activeMarket.market} (${activeMarket.chain}), block ${activeMarket.source.block}, `
        + `read ${ago(activeMarket.source.refreshedAt)} via ${activeMarket.source.rpc}. `
        + `lastAccrualTime = ${activeMarket.source.lastAccrualTime}. The curve and the state come from the contract, this is not a reconstruction. `
        + `The state drifts every block — press ↻ to re-read it.`
    : activeSaved
      ? `Custom preset "${activeSaved.name}", saved ${fmtWhen(activeSaved.createdAt)}. Its provenance is whatever the person who saved it decided — the bench does not verify it.`
      : "The parameters were edited by hand — no preset is active.";
}

function paintSaved() {
  const list = $("savedPresets");
  $("savedWrap").hidden = savedPresets.length === 0;
  list.innerHTML = savedPresets.map(p => `
    <div class="saved-row">
      <button class="preset" data-id="${esc(p.id)}" aria-pressed="${!!(activeSaved && activeSaved.id === p.id)}">
        <strong>${esc(p.name || "untitled")}</strong><span>${esc(fmtWhen(p.createdAt))}</span>
      </button>
      <button class="del" data-del="${esc(p.id)}" aria-label="Delete preset ${esc(p.name || "")}">×</button>
    </div>`).join("");
  list.querySelectorAll("button[data-id]").forEach(b => b.addEventListener("click", () => {
    const p = savedPresets.find(x => x.id === b.dataset.id); if (!p) return;
    activeSaved = p; activePreset = null; activeMarket = null;
    clearMarketSelection();
    applyValues(p.values);
    paintPresets(); paintSaved(); onChange();
  }));
  list.querySelectorAll("button[data-del]").forEach(b => b.addEventListener("click", async () => {
    if (!store) return;
    b.disabled = true;
    try { await store.collection("presets").doc(b.dataset.del).delete(); }
    catch (e) { b.disabled = false; msg("Could not delete: " + dbMsg(e)); }
  }));
}

/* ---- saved presets live in localStorage, so they survive reloads on this
       machine; git and other people never see them ---- */
const msg = (t) => { $("saveMsg").textContent = t; };
function dbMsg(e) {
  switch (e && e.code) {
    case "not_found":          return "the preset is gone — the file was changed elsewhere";
    case "unavailable":        return "the bench server is not responding";
    case "quota_exceeded":     return "the storage is full, delete some old presets";
    case "resource_exhausted": return "too many requests, try again in a moment";
    case "invalid_argument":   return "the preset is too large or the name is invalid";
    case "revoked":
    case "not_granted":        return "access to the storage was revoked";
    default:                   return "the storage is temporarily unavailable";
  }
}
function closeSaveForm() { $("saveForm").hidden = true; $("saveOpen").hidden = false; }
async function saveNow() {
  if (!store) return;
  const name = $("saveName").value.trim();
  if (!name) { msg("Give the preset a name."); $("saveName").focus(); return; }
  $("saveDo").disabled = true; msg("Saving…");
  try {
    await store.collection("presets").add({ name, values: collectValues(), createdAt: new Date().toISOString() });
    closeSaveForm(); msg("Saved: " + name);
  } catch (e) { msg("Could not save: " + dbMsg(e)); }
  finally { $("saveDo").disabled = false; }
}

// Called from initPresets, not at import time: importing a module must not
// reach for the DOM, or the model can no longer be loaded outside a browser.
function wireSaveForm() {
  $("saveOpen").addEventListener("click", () => {
    $("saveOpen").hidden = true; $("saveForm").hidden = false;
    $("saveName").value = ""; $("saveName").focus();
  });
  $("saveCancel").addEventListener("click", closeSaveForm);
  $("saveDo").addEventListener("click", saveNow);
  $("saveName").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") saveNow();
    if (ev.key === "Escape") closeSaveForm();
  });
}

export async function initPresets({ presets, onChange: cb }) {
  BUILT_IN = presets;
  onChange = cb;
  wireSaveForm();
  paintPresets();

  // The repository is the intended home. localStorage stands in only when the
  // page is open without the bench server behind it — and says so.
  let note;
  try {
    store = await openRepoStore();
    note = "Presets are written to data/user-presets.json — they survive a restart, travel with a clone, and show up in the diff.";
  } catch (e) {
    if (!storageWorks()) {
      msg("Neither the bench server nor localStorage — saving is disabled. The built-in presets still work.");
      return;
    }
    store = localStore(STORE_KEY);
    note = "The bench server is unavailable: presets go into this browser's localStorage and will NOT reach the repository.";
  }
  $("saveArea").hidden = false;
  msg(note);
  store.collection("presets").orderBy("createdAt", "desc").limit(100).onSnapshot(
    (snap) => {
      savedPresets = snap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
      if (activeSaved && !savedPresets.some(p => p.id === activeSaved.id)) { activeSaved = null; paintPresets(); }
      paintSaved();
    },
    (e) => { msg("The preset list was cut off: " + dbMsg(e) + ". Reload the page."); }
  );
}

/**
 * An on-chain preset was picked in the market rail. Kept here rather than in
 * markets.mjs so that one selection, and one provenance line, cover all three
 * kinds of preset.
 */
export function pickMarket(preset) {
  activePreset = null;
  activeSaved = null;
  activeMarket = preset;
  applyValues(preset.values);
  paintPresets();
  paintSaved();
  onChange();
}
