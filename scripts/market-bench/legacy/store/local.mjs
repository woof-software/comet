// Hosted, this bench ran on window.claude.use("db") — one collection shared by
// everyone who opened it. In the repo there is no backend, so the same surface
// (collection/add/doc/delete/orderBy/limit/onSnapshot) is served out of
// localStorage. Presets stay in this browser; a save in another tab still
// reaches this one, because the storage event feeds the same listener.

export const STORE_KEY = "market-bench/presets";

export function storageWorks() {
  // file:// in Safari, and any browser with site data blocked, throws on access
  try {
    localStorage.setItem(STORE_KEY + "/probe", "1");
    localStorage.removeItem(STORE_KEY + "/probe");
    return true;
  } catch (e) { return false; }
}

export function localStore(key) {
  const listeners = [];
  const fail = (code) => Object.assign(new Error(code), { code });

  const read = () => {
    let rows;
    try { rows = JSON.parse(localStorage.getItem(key) || "[]"); }
    catch (e) { throw fail("unavailable"); }
    return Array.isArray(rows) ? rows : [];
  };
  const write = (rows) => {
    try { localStorage.setItem(key, JSON.stringify(rows)); }
    catch (e) { throw fail(e && e.name === "QuotaExceededError" ? "quota_exceeded" : "unavailable"); }
  };
  const emit = () => { for (const l of listeners) l(); };
  window.addEventListener("storage", (ev) => { if (ev.key === key) emit(); });

  const coll = {
    add: async (doc) => {
      const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      write(read().concat([{ id, ...doc }]));
      emit();
      return { id };
    },
    doc: (id) => ({
      delete: async () => { write(read().filter(r => r.id !== id)); emit(); },
    }),
    orderBy: (field, dir) => ({
      limit: (n) => ({
        onSnapshot: (onNext, onError) => {
          const deliver = () => {
            let rows;
            try { rows = read(); } catch (e) { onError && onError(e); return; }
            rows = rows.slice()
              .sort((a, b) => String(a[field] ?? "").localeCompare(String(b[field] ?? "")) * (dir === "desc" ? -1 : 1))
              .slice(0, n);
            onNext({ docs: rows.map(r => ({ id: r.id, data: () => r })) });
          };
          listeners.push(deliver);
          deliver();
          return () => { const i = listeners.indexOf(deliver); if (i !== -1) listeners.splice(i, 1); };
        },
      }),
    }),
  };
  return { collection: () => coll };
}
