// Client side of the market API. Thin on purpose: the reading of chain state
// happens on the server, where the SDK and the RPC keys live.

const base = () => new URL("api/", document.baseURI);

async function call(path, init) {
  let res;
  try { res = await fetch(new URL(path, base()), init); }
  catch { throw new Error("bench server is not responding"); }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error((body && body.error) || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Every market the SDK knows about, grouped by chain. */
export const fetchCatalog = () => call("markets").then(b => b.chains ?? []);

/** Market presets currently stored in data/market-presets.json. */
export const fetchMarketPresets = () => call("market-presets").then(b => b.presets ?? []);

/** Read a market from chain and store it. */
export const addMarket = (chainId, market) =>
  call("market-presets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId, market }),
  }).then(b => b.preset);

/** Re-read a stored market: same row, new state, new refreshedAt. */
export const refreshMarket = (id) =>
  call(`market-presets/${encodeURIComponent(id)}`, { method: "POST" }).then(b => b.preset);

export const removeMarket = (id) =>
  call(`market-presets/${encodeURIComponent(id)}`, { method: "DELETE" });
