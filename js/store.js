// Keeps trials on this device in IndexedDB: videos as blobs, one record per trial.

const DB_NAME = 'motionlab';
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('analyses', { keyPath: 'id' });
      db.createObjectStore('videos');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const result = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Saving was cancelled. The device may be out of storage.'));
  });
}

export async function listAnalyses() {
  const all = await run('analyses', 'readonly', (s) => s.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export const getAnalysis = (id) => run('analyses', 'readonly', (s) => s.get(id));
export const saveAnalysis = (a) => run('analyses', 'readwrite', (s) => s.put(a));
export const getVideo = (id) => run('videos', 'readonly', (s) => s.get(id));

export async function saveVideo(blob) {
  const id = 'v-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  try {
    await run('videos', 'readwrite', (s) => s.put(blob, id));
  } catch (error) {
    // Some older Safari versions can't store a File straight from the picker, but can store a copy of its bytes.
    if (!(blob instanceof File)) throw error;
    const copy = new Blob([await blob.arrayBuffer()], { type: blob.type });
    await run('videos', 'readwrite', (s) => s.put(copy, id));
  }
  return id;
}

export async function deleteAnalysis(a) {
  await run('analyses', 'readwrite', (s) => s.delete(a.id));
  await run('videos', 'readwrite', (s) => s.delete(a.videoId));
}

/** Asks the browser not to clear our data when space runs low. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* not supported */ }
}

export async function storageEstimate() {
  try {
    return await navigator.storage?.estimate?.();
  } catch {
    return null;
  }
}
