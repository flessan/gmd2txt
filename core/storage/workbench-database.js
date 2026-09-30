import { openLibraryDatabase } from "./database.js";
const STORE = "workbenchData";
const requestResult = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error || new Error("Workspace preference lookup failed.")); });
const txDone = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error || new Error("Workspace preference could not be saved.")); tx.onabort = () => reject(tx.error || new Error("Workspace preference update was cancelled.")); });
export async function getWorkbenchValue(key, fallback = null) { const db = await openLibraryDatabase(); const value = await requestResult(db.transaction(STORE, "readonly").objectStore(STORE).get(String(key))); return value?.value ?? fallback; }
export async function setWorkbenchValue(key, value) { const db = await openLibraryDatabase(), tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).put({ key: String(key), value, updatedAt: Date.now() }); await txDone(tx); return value; }
export async function getViewPreferences(scope) { return getWorkbenchValue(`view:${scope}`, {}); }
export async function saveViewPreferences(scope, patch) { const current = await getViewPreferences(scope); return setWorkbenchValue(`view:${scope}`, { ...current, ...patch, updatedAt: Date.now() }); }
export async function listSavedSearches() { return (await getWorkbenchValue("savedSearches", [])).sort((a,b) => b.updatedAt - a.updatedAt); }
export async function saveSavedSearch(search) { const all = await listSavedSearches(), next = all.filter(item => item.id !== search.id); next.push(search); await setWorkbenchValue("savedSearches", next); return search; }
export async function deleteSavedSearch(id) { await setWorkbenchValue("savedSearches", (await listSavedSearches()).filter(item => item.id !== id)); }
export async function getRecentActivity(limit = 50) { return (await getWorkbenchValue("recentActivity", [])).slice(0, Math.max(1, Math.min(100, limit))); }
export async function recordActivity(item) {
  const history = await getRecentActivity(100), entry = { id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, at: Date.now(), ...item };
  const deduped = history.filter(old => !(old.kind === entry.kind && old.resourceId === entry.resourceId && old.action === entry.action));
  await setWorkbenchValue("recentActivity", [entry, ...deduped].slice(0, 100)); return entry;
}
