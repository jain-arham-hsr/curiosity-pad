// IndexedDB, wrapped just enough to use with async/await.
//
// Stores:
//   trails  { id, title, created, updated }
//   nodes   { id, trailId, parentId, pos, kind, body, caption, mediaId, mime,
//             duration, source, created, edited, sync }      index: trailId
//   media   { id, blob, mime }
//   outbox  every change, in order, for the sync step to send  (autoIncrement)
//   meta    key/value: deviceId, activeTrailId, backupDir, lastBackup

const NAME = 'curiosity-pad';
const VERSION = 2;

let opening;

export function open() {
  return (opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 1) {
        db.createObjectStore('trails', { keyPath: 'id' });
        db.createObjectStore('nodes', { keyPath: 'id' }).createIndex('trailId', 'trailId');
        db.createObjectStore('media', { keyPath: 'id' });
        db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
        db.createObjectStore('meta');
      }
      if (e.oldVersion < 2) {
        // node.op = id of the node's latest content op; receipts map to nodes through it
        req.transaction.objectStore('nodes').createIndex('op', 'op');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export const wait = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

// Runs `work(stores)` in one transaction and resolves once it has committed.
// Inside `work`, only await IndexedDB requests; awaiting anything else lets
// the transaction close early.
export async function transact(names, mode, work) {
  const db = await open();
  const tx = db.transaction(names, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
  const stores = Object.fromEntries(names.map((n) => [n, tx.objectStore(n)]));
  let result;
  try {
    result = await work(stores);
  } catch (err) {
    try { tx.abort(); } catch { /* already finished */ }
    await done.catch(() => {});
    throw err;
  }
  await done;
  return result;
}

export const getMeta = (key) => transact(['meta'], 'readonly', ({ meta }) => wait(meta.get(key)));
export const setMeta = (key, value) => transact(['meta'], 'readwrite', ({ meta }) => wait(meta.put(value, key)));
