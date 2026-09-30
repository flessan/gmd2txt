import { openLibraryDatabase } from "./database.js";

const STORE = "saveSnapshots";
function complete(tx) {
  return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
}
function requestResult(request) {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

export async function createSaveSnapshot(document) {
  const db = await openLibraryDatabase();
  const existing = await requestResult(db.transaction(STORE, "readonly").objectStore(STORE).get(document.id));
  const record = {
    id: document.id,
    document,
    sourceFilenames: document.source?.filenames || [],
    metadata: document.metadata || {},
    importedAt: Date.now(),
    createdAt: existing?.createdAt || Date.now()
  };
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(record);
  await complete(tx);
  return { ...record, duplicate: !!existing };
}

export async function getSaveSnapshot(id) {
  const db = await openLibraryDatabase();
  return requestResult(db.transaction(STORE, "readonly").objectStore(STORE).get(id));
}

export async function getSaveSnapshots() {
  const db = await openLibraryDatabase();
  const records = await requestResult(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
  return records.sort((a, b) => b.importedAt - a.importedAt);
}

export async function deleteSaveSnapshot(id) {
  const db = await openLibraryDatabase();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  await complete(tx);
}
