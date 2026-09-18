// Presets kept in the repository, through the bench server's small API.
//
// Same surface as the localStorage store (collection/add/doc/delete/orderBy/
// limit/onSnapshot), so the preset UI does not know which one it is talking to.
// The difference that matters: the file is the source of truth, so a preset
// survives a restart, travels with a clone, and shows up in a diff for review.

// Resolved on call, not at import: touching the DOM while a module loads would
// make this file unloadable outside a browser, the way model/ must stay loadable.
const presetsUrl = () => new URL("api/presets", document.baseURI);

// map the server's HTTP answer onto the codes dbMsg() already speaks
function fail(status, payload) {
  const code = status === 400 ? "invalid_argument"
             : status === 507 ? "quota_exceeded"
             : status === 404 ? "not_found"
             : "unavailable";
  return Object.assign(new Error((payload && payload.error) || "HTTP " + status), { code });
}

async function request(url, init) {
  let res;
  try { res = await fetch(url, init); }
  catch (e) { throw Object.assign(new Error("server unreachable"), { code: "unavailable" }); }
  if (!res.ok) throw fail(res.status, await res.json().catch(() => null));
  return res.status === 204 ? null : res.json();
}

const load = async () => {
  const body = await request(presetsUrl(), { headers: { accept: "application/json" } });
  return Array.isArray(body.presets) ? body.presets : [];
};

// Throws when the API is not there — the caller then falls back to localStorage.
export async function openRepoStore() {
  let cache = await load();
  const listeners = [];
  const emit = () => { for (const l of listeners) l(); };

  const coll = {
    add: async (doc) => {
      // id and createdAt belong to the server: it owns the file
      const { preset } = await request(presetsUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: doc.name, values: doc.values }),
      });
      cache = cache.concat([preset]);
      emit();
      return { id: preset.id };
    },
    doc: (id) => ({
      delete: async () => {
        await request(`${presetsUrl()}/${encodeURIComponent(id)}`, { method: "DELETE" });
        cache = cache.filter(p => p.id !== id);
        emit();
      },
    }),
    orderBy: (field, dir) => ({
      limit: (n) => ({
        onSnapshot: (onNext, onError) => {
          const deliver = () => {
            const rows = cache.slice()
              .sort((a, b) => String(a[field] ?? "").localeCompare(String(b[field] ?? "")) * (dir === "desc" ? -1 : 1))
              .slice(0, n);
            onNext({ docs: rows.map(r => ({ id: r.id, data: () => r })) });
          };
          listeners.push(deliver);
          deliver();

          // The file can change behind the page's back — another tab, a hand
          // edit, a git checkout. Re-read whenever the tab comes back into focus.
          const refresh = async () => {
            try { cache = await load(); emit(); }
            catch (e) { onError && onError(e); }
          };
          window.addEventListener("focus", refresh);

          return () => {
            window.removeEventListener("focus", refresh);
            const i = listeners.indexOf(deliver);
            if (i !== -1) listeners.splice(i, 1);
          };
        },
      }),
    }),
  };
  return { collection: () => coll };
}
