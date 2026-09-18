// Composition root: wire the market rail and the form to render, go.

import { $, IDS, SELECTS, clearActions, setStateEditable } from "./ui/fields.mjs";
import { render } from "./ui/render.mjs";
import { initMarkets } from "./ui/markets.mjs";

// A long window is thousands of BigInt accruals, and a held-down key fires
// `input` far faster than that. Coalescing to one run per frame keeps typing
// responsive without making the model asynchronous.
let queued = false;
const schedule = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; render(); });
};

setStateEditable(false);
await initMarkets({ onChange: render });

IDS.forEach(id => $(id).addEventListener("input", schedule));
SELECTS.forEach(id => $(id).addEventListener("change", schedule));

$("editState").addEventListener("change", (e) => {
  setStateEditable(e.currentTarget.checked);
  $("editStateNote").hidden = !e.currentTarget.checked;
});
$("actionsReset").addEventListener("click", () => { clearActions(); render(); });

render();
