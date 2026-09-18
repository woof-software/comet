// The market rail — now the only way state gets into the bench.
//
// Every row is a snapshot read from a chain through the SDK: no invented states,
// no hand-saved presets. Selecting a row loads it into the state fields and
// prints where it came from; ↻ re-reads it in place; × drops it from the file.

import { $, applyValues } from "./fields.mjs";
import { esc, ago, isStale } from "./format.mjs";
import { fetchCatalog, fetchMarketPresets, addMarket, refreshMarket, removeMarket } from "../store/markets.mjs";

let catalog = [];        // [{ chainId, chain, markets: [{address, symbol}] }]
let presets = [];        // stored market snapshots
let active = null;       // the one whose state is in the form
let onChange = () => {};

const msg = (t) => { $("marketMsg").textContent = t; };

function paintProvenance() {
  const p = active;
  $("provenance").innerHTML = p
    ? `On-chain state of <code>${esc(p.market)}</code> (${esc(p.chain)}), block ${esc(p.source.block)}, `
      + `read ${esc(ago(p.source.refreshedAt))} via ${esc(p.source.rpc)}. `
      + `<code>lastAccrualTime</code> = ${esc(p.source.lastAccrualTime)}, i.e. at the snapshot height `
      + `${esc(pendingSecs(p))} s are not accrued — the bench settles that at t₀. `
      + `The curve and the state come from the contract, this is not a reconstruction. The state drifts every block — press ↻ to re-read it.`
    : "No market selected: the state fields hold zeros, not a real market.";
}

export function paintMarkets() {
  $("marketPresets").innerHTML = presets.map(p => {
    const stale = isStale(p.source?.refreshedAt);
    return `
      <div class="saved-row">
        <button class="preset" data-market="${esc(p.id)}" aria-pressed="${p.id === active?.id}">
          <strong>${esc(p.name)}</strong>
          <span class="${stale ? "stale" : ""}">updated ${esc(ago(p.source?.refreshedAt))} · block ${esc(p.source?.block ?? "—")}</span>
        </button>
        <button class="del" data-refresh="${esc(p.id)}" title="Re-read the state from the network" aria-label="Refresh ${esc(p.name)}">↻</button>
        <button class="del" data-drop="${esc(p.id)}" title="Remove from the repository" aria-label="Delete ${esc(p.name)}">×</button>
      </div>`;
  }).join("");

  const list = $("marketPresets");
  list.querySelectorAll("button[data-market]").forEach(b => b.addEventListener("click", () => {
    const p = presets.find(x => x.id === b.dataset.market);
    if (p) select(p);
  }));
  list.querySelectorAll("button[data-refresh]").forEach(b => b.addEventListener("click", () => refresh(b)));
  list.querySelectorAll("button[data-drop]").forEach(b => b.addEventListener("click", () => drop(b)));
  paintProvenance();
}

// Snapshots read before the fetcher recorded blockTime carry no pendingSecs, and
// a missing gap would silently render as "nothing owed" — the one wrong answer.
// The read's wall clock is within a block of the header, which is close enough
// to keep an old preset honest until the next ↻ replaces it with the real thing.
function pendingSecs(p) {
  if (p.values?.pendingSecs !== undefined) return p.values.pendingSecs;
  const last = Number(p.source?.lastAccrualTime ?? 0);
  const read = Math.round(Date.parse(p.source?.refreshedAt ?? "") / 1000);
  if (!last || !Number.isFinite(read)) return "0";
  return String(Math.max(0, read - last));
}

/** Load a snapshot into the form. The action fields are the viewer's, so they stay. */
function select(preset) {
  active = preset;
  applyValues({ ...preset.values, pendingSecs: pendingSecs(preset) });
  paintMarkets();
  onChange();
}

async function refresh(button) {
  const id = button.dataset.refresh;
  button.disabled = true;
  msg("Reading state from the network…");
  try {
    const fresh = await refreshMarket(id);
    presets = presets.map(p => (p.id === fresh.id ? fresh : p));
    msg(`${fresh.name}: state at block ${fresh.source.block}.`);
    if (active?.id === fresh.id) select(fresh); else paintMarkets();
  } catch (e) {
    button.disabled = false;
    msg("Could not refresh: " + e.message);
  }
}

async function drop(button) {
  const id = button.dataset.drop;
  button.disabled = true;
  try {
    await removeMarket(id);
    presets = presets.filter(p => p.id !== id);
    if (active?.id === id) active = null;
    paintMarkets();
    msg("Removed from data/market-presets.json.");
  } catch (e) {
    button.disabled = false;
    msg("Could not delete: " + e.message);
  }
}

function paintChains() {
  $("marketChain").innerHTML = catalog
    .map(c => `<option value="${c.chainId}">${esc(c.chain)}</option>`).join("");
  paintMarketOptions();
}

function paintMarketOptions() {
  const chainId = Number($("marketChain").value);
  const chain = catalog.find(c => c.chainId === chainId);
  $("marketPick").innerHTML = (chain?.markets ?? [])
    .map(m => `<option value="${esc(m.address)}">${esc(m.symbol)}</option>`).join("");
}

async function add() {
  const chainId = Number($("marketChain").value);
  const market = $("marketPick").value;
  if (!market) return;
  $("marketAddBtn").disabled = true;
  msg("Reading state from the network…");
  try {
    const preset = await addMarket(chainId, market);
    const at = presets.findIndex(p => p.id === preset.id);
    if (at === -1) presets.push(preset); else presets[at] = preset;
    select(preset);
    msg(`${preset.name}: state at block ${preset.source.block}.`);
  } catch (e) {
    msg("Could not read the market: " + e.message);
  } finally {
    $("marketAddBtn").disabled = false;
  }
}

export async function initMarkets({ onChange: cb }) {
  onChange = cb;
  $("marketChain").addEventListener("change", paintMarketOptions);
  $("marketAddBtn").addEventListener("click", add);

  try {
    presets = await fetchMarketPresets();
  } catch {
    // No server behind the page: there is nothing to select and nothing to read,
    // so say it plainly instead of leaving an empty rail.
    $("marketAdd").hidden = true;
    msg("The bench server is not responding — run `node scripts/market-bench/serve.mjs`. Without it there is nowhere to get markets from.");
    paintMarkets();
    return;
  }

  // Land on a real market rather than on zeros: the first stored snapshot.
  if (presets.length) select(presets[0]); else paintMarkets();
  msg(presets.length
    ? "Market state drifts every block — check when the snapshot was last read."
    : "Add a market to pull its state from the network.");

  try {
    catalog = await fetchCatalog();
    paintChains();
  } catch (e) {
    $("marketAdd").hidden = true;
    msg("The market list is unavailable: " + e.message + ". Stored snapshots still work.");
  }
}
