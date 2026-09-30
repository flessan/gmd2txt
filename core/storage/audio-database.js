import { openLibraryDatabase } from "./database.js";
import { createAudioAsset, updateAudioAssetMetadata } from "../audio/audio-asset.js";

const STORE = "audioAssets";
const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error("Audio library request failed."));
});
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("Audio library update failed."));
    tx.onabort = () => reject(tx.error || new Error("Audio library update was cancelled."));
  });
}

export async function createAudioAssetRecord(file, metadata = {}) {
  const asset = createAudioAsset(file, metadata);
  const db = await openLibraryDatabase();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).add(asset);
  await transactionDone(tx);
  return asset;
}
export async function getAudioAsset(id) {
  const db = await openLibraryDatabase();
  return requestResult(db.transaction(STORE, "readonly").objectStore(STORE).get(id));
}
export async function getAudioAssets() {
  const db = await openLibraryDatabase();
  const assets = await requestResult(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
  return assets.sort((a, b) => b.importedAt - a.importedAt);
}
export async function saveAudioAssetMetadata(id, patch) {
  const current = await getAudioAsset(id);
  if (!current) throw new Error("This local audio asset is no longer available.");
  const updated = updateAudioAssetMetadata(current, patch);
  const db = await openLibraryDatabase();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(updated);
  await transactionDone(tx);
  return updated;
}
export async function deleteAudioAsset(id) {
  const db = await openLibraryDatabase();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  await transactionDone(tx);
}
