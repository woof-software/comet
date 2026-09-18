# legacy/ — panels from before the bench rework

The bench was reworked around one question: **a real market + user actions →
how it will behave from here**. Everything that does not serve that question
sits here instead of being deleted — so it can be brought back step by step,
when it is needed.

| File | What it was |
|---|---|
| `data/presets.json` | built-in synthetic presets (state + curve + provenance) |
| `data/user-presets.json` | presets saved with the button on the page |
| `data/exit-profiles.json` | distributions of lender balances for the exit simulation |
| `ui/presets.mjs` | the preset rail and the save form |
| `ui/floor.mjs`, `model/minsupply.mjs` | the "minimum supply" panel (S_min, B − R, the window ladder) |
| `ui/dose.mjs`, `model/dose.mjs` | the "intervention dose" panel — replaced by the action fields |
| `ui/exit.mjs`, `model/exit.mjs` | the "lender exit block by block" panel |
| `model/thresholds.mjs` | u_crit / S_crit analytically |
| `store/repo.mjs`, `store/local.mjs` | preset stores: a repository file and localStorage |

**Relative imports do not resolve here.** The files used to live in `src/`, so
`../model/accrual.mjs` and `./constants.mjs` point into the old tree. To bring a
panel back, move the file into the matching `src/` directory and supply what is
missing: `render.mjs` no longer calls any of these renderers, and `index.html`
does not hold their markup.

What will not come back in the same shape: `opt` is now always `uint64` with no
clamping and no saturation (`src/model/params.mjs`), because the remediation
panel is gone too. Functions that took `opt` will still work — they will simply
always follow the current contract.
