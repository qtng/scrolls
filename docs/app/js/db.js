/*
The storage of Nôm Notes (app/): IndexedDB "nom-notes", store "docs" (key id). A document is { id, content, text, created, updated } (see core.js).
Taken over from Qatt.org Notes (notes-db.js).

  DocsDB.open()    Promise of a store; rejects with an Error when IndexedDB is missing or fails
  DocsDB.memory()  a store with the same interface that keeps the documents in memory only (when open() fails)
  store.all()       Promise of all documents, `updated` descending; store.get(id): one of them or null
  store.put(doc)   store.putMany(docs)   store.remove(id)
*/
const DocsDB = (() => {
  const byUpdated = (a, b) => b.updated - a.updated;
  const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error || new Error('IndexedDB request failed')); });
  const done = tx => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  });

  function open() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open('nom-notes', 1); } catch (e) { reject(e instanceof Error ? e : new Error('IndexedDB is not available')); return; }
      req.onupgradeneeded = () => req.result.createObjectStore('docs', { keyPath: 'id' });
      req.onerror = () => reject(req.error || new Error('IndexedDB failed'));
      req.onsuccess = () => {
        const db = req.result;
        const write = fn => { const tx = db.transaction('docs', 'readwrite'); fn(tx.objectStore('docs')); return done(tx); };
        resolve({
          all: async () => (await request(db.transaction('docs').objectStore('docs').getAll())).sort(byUpdated),
          get: async id => (await request(db.transaction('docs').objectStore('docs').get(id))) || null,
          put: doc => write(s => s.put(doc)),
          putMany: docs => write(s => docs.forEach(d => s.put(d))),
          remove: id => write(s => s.delete(id)),
        });
      };
    });
  }

  function memory() {
    const map = new Map();
    return {
      all: async () => Array.from(map.values(), d => ({ ...d })).sort(byUpdated),
      get: async id => (map.has(id) ? { ...map.get(id) } : null),
      put: async doc => { map.set(doc.id, { ...doc }); },
      putMany: async docs => { docs.forEach(d => map.set(d.id, { ...d })); },
      remove: async id => { map.delete(id); },
    };
  }

  return { open, memory };
})();
