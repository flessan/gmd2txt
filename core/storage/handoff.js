/**
 * A tiny drop box between pages of the workspace.
 *
 * The landing page accepts dropped files and pasted text so nobody has to hunt
 * for the right tool first: the files are parked here and the page navigates to
 * the converter, which reads them out once and clears the box. Everything stays
 * in this browser's IndexedDB; nothing is uploaded.
 *
 * The database helper is injectable so the rules can be tested in Node.
 */
const DATABASE = "gmd2txt-handoff";
const STORE = "files";
const VERSION = 1;
export const HANDOFF_MAX_FILES = 24;
export const HANDOFF_MAX_BYTES = 32 * 1024 * 1024;

let databasePromise = null;

function openDatabase(indexedDB) {
  if (!indexedDB?.open) return Promise.reject(new Error("This browser cannot park files for the converter."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("The file hand-off store could not be opened."));
  });
}

function runTransaction(db, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let result;
    try {
      result = run(tx.objectStore(STORE));
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error("The file hand-off store failed."));
    tx.onabort = () => reject(tx.error || new Error("The file hand-off was cancelled."));
  });
}

/** The real backend: a small object store in this browser's IndexedDB. */
function indexedDbBackend(indexedDB) {
  return {
    async put(records) {
      if (!databasePromise) databasePromise = openDatabase(indexedDB ?? globalThis.indexedDB ?? null);
      const db = await databasePromise;
      await runTransaction(db, "readwrite", store => { for (const record of records) store.add(record); });
    },
    async drain() {
      if (!databasePromise) databasePromise = openDatabase(indexedDB ?? globalThis.indexedDB ?? null);
      const db = await databasePromise;
      return runTransaction(db, "readwrite", store => new Promise((resolve, reject) => {
        const found = [];
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) { resolve(found); return; }
          found.push(item.value);
          store.delete(item.primaryKey);
          item.continue();
        };
        cursor.onerror = () => reject(cursor.error || new Error("The parked files could not be read."));
      }));
    },
    async count() {
      if (!databasePromise) databasePromise = openDatabase(indexedDB ?? globalThis.indexedDB ?? null);
      const db = await databasePromise;
      return runTransaction(db, "readonly", store => new Promise((resolve, reject) => {
        const request = store.count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }));
    }
  };
}

function backendFor(options = {}) {
  // Tests (and any future non-browser host) can supply their own tiny store.
  return options.backend || indexedDbBackend(options.indexedDB);
}

function toRecord(file, index) {
  const name = String(file?.name || `file-${index + 1}`).replace(/[\\/]/g, "_").slice(0, 180);
  const type = String(file?.type || "application/octet-stream");
  const data = file?.data ?? file?.bytes ?? null;
  if (!data) return null;
  return { name, type, size: Number(file?.size) || data.byteLength || data.length || 0, data };
}

/**
 * Parks dropped files (or pasted text, wrapped by the caller) for the converter.
 * Returns the number of files parked; throws only when nothing could be stored.
 */
export async function putHandoffFiles(files, options = {}) {
  const records = Array.from(files || []).slice(0, HANDOFF_MAX_FILES).map(toRecord).filter(Boolean);
  if (!records.length) return 0;
  let total = 0;
  for (const record of records) {
    total += record.size || 0;
    if (total > (options.maxBytes ?? HANDOFF_MAX_BYTES)) {
      throw new Error("That is too much to hand over at once. Open the converter and drop the files there.");
    }
  }
  await backendFor(options).put(records);
  return records.length;
}

/** Reads and clears the parked files, oldest first. */
export async function takeHandoffFiles(options = {}) {
  const records = await backendFor(options).drain();
  return (records || []).map(record => ({
    name: record.name,
    type: record.type,
    size: record.size,
    data: record.data
  }));
}

/** Number of files waiting without consuming them (used for a hint in the UI). */
export async function peekHandoffCount(options = {}) {
  try {
    const count = await backendFor(options).count();
    return Number(count) || 0;
  } catch (_) {
    return 0;
  }
}

/** Test helper: drops the cached connection so a fresh database can be opened. */
export function resetHandoffConnection() {
  databasePromise = null;
}
