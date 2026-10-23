/* Tiny IndexedDB key-value store. Every call fails soft: private windows or
 * blocked storage just mean nothing is remembered between visits. */
(function () {
  const DB = "wandrer-route-builder", STORE = "kv";

  function open() {
    return new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) { reject(e); }
    });
  }

  async function tx(mode, fn) {
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = () => reject(t.error);
      });
    } catch (e) {
      console.warn("Storage unavailable:", e);
      return undefined;
    }
  }

  window.Store = {
    get: key => tx("readonly", s => s.get(key)),
    set: (key, value) => tx("readwrite", s => s.put(value, key)),
    del: key => tx("readwrite", s => s.delete(key)),
  };
})();
