import { createLevelApplicationMetadata, mergeLevelApplicationMetadata } from "../documents/application-metadata.js";

const DB_NAME = "gmdplayer-library";
export const DATABASE_SCHEMA_VERSION = 6;
const DB_VERSION = DATABASE_SCHEMA_VERSION;
const STORE = "levels";
const SAVE_STORE = "saveSnapshots";
const TEXTURE_STORE = "textureWorkspaces";
const AUDIO_STORE = "audioAssets";
const PROJECT_STORE = "projects";
const PROJECT_PREFERENCES_STORE = "projectPreferences";
const WORKBENCH_DATA_STORE = "workbenchData";
let databasePromise;

export function openLibraryDatabase() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("IndexedDB is unavailable in this browser."));
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
        store.createIndex("contentHash", "document.source.contentHash");
      }
      if (!db.objectStoreNames.contains(SAVE_STORE)) {
        const saves = db.createObjectStore(SAVE_STORE, { keyPath: "id" });
        saves.createIndex("importedAt", "importedAt");
      }
      if (!db.objectStoreNames.contains(TEXTURE_STORE)) {
        const textures = db.createObjectStore(TEXTURE_STORE, { keyPath: "id" });
        textures.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        const audio = db.createObjectStore(AUDIO_STORE, { keyPath: "id" });
        audio.createIndex("importedAt", "importedAt");
        audio.createIndex("displayName", "displayName");
        audio.createIndex("mimeType", "mimeType");
      }
      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        const projects = db.createObjectStore(PROJECT_STORE, { keyPath: "id" });
        projects.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains(PROJECT_PREFERENCES_STORE)) db.createObjectStore(PROJECT_PREFERENCES_STORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains(WORKBENCH_DATA_STORE)) db.createObjectStore(WORKBENCH_DATA_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => { if (settled) { request.result.close(); return; } settled = true; const db = request.result; db.onversionchange = () => { db.close(); databasePromise = null; }; resolve(db); };
    request.onerror = () => { if (settled) return; settled = true; databasePromise = null; reject(request.error || new Error("Could not open the Library database.")); };
    request.onblocked = () => { if (settled) return; settled = true; databasePromise = null; reject(new Error("The local database upgrade is blocked by another open tab. Close other GMDPlayer tabs and retry.")); };
  });
  return databasePromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Library database request failed."));
  });
}

export async function createLevel(document, { duplicateMode = "update" } = {}) {
  const db = await openLibraryDatabase();
  const record = { id: document.id, document, applicationMetadata: createLevelApplicationMetadata(), createdAt: Date.now(), updatedAt: Date.now() };
  const lookup = db.transaction(STORE, "readonly").objectStore(STORE);
  const [byId, byHash] = await Promise.all([
    requestResult(lookup.get(document.id)),
    document.source?.contentHash ? requestResult(lookup.index("contentHash").get(document.source.contentHash)) : Promise.resolve(null)
  ]);
  const existing = byId || byHash;
  if (existing && duplicateMode === "skip") return { ...existing, duplicate: true, skipped: true };
  if (existing && duplicateMode === "copy") {
    const copyId = `level_copy_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
    record.id = copyId; record.document = { ...document, id: copyId };
  } else if (existing) {
    record.id = existing.id;
    record.createdAt = existing.createdAt;
    record.applicationMetadata = createLevelApplicationMetadata(existing.applicationMetadata);
    record.document = { ...document, id: existing.id, progress: existing.document.progress, timestamps: { ...document.timestamps, ...existing.document.timestamps, updatedAt: Date.now() } };
  }
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(record);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  return { ...record, duplicate: !!existing };
}

export async function getLevel(id) {
  const db = await openLibraryDatabase();
  return requestResult(db.transaction(STORE, "readonly").objectStore(STORE).get(id));
}

export async function getLevelApplicationMetadata(id) {
  const record = await getLevel(id);
  if (!record) return null;
  return createLevelApplicationMetadata(record.applicationMetadata);
}

export async function updateLevelApplicationMetadata(id, patch) {
  const current = await getLevel(id);
  if (!current) throw new Error("This level is no longer in the Library.");
  const record = {
    ...current,
    applicationMetadata: mergeLevelApplicationMetadata(current.applicationMetadata, patch),
    updatedAt: Date.now()
  };
  const db = await openLibraryDatabase();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(record);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error || new Error("Level application metadata could not be saved.")); tx.onabort = () => reject(tx.error || new Error("Level application metadata save was cancelled.")); });
  return record;
}

export async function getLevels() {
  const db = await openLibraryDatabase();
  const entries = await requestResult(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
  return entries.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Read level summaries one cursor record at a time; large source strings and parsed object arrays are not retained in shell state. */
export async function getLibrarySummaries() {
  const db=await openLibraryDatabase(),store=db.transaction(STORE,"readonly").objectStore(STORE),items=[];
  await new Promise((resolve,reject)=>{
    const request=store.openCursor();
    request.onerror=()=>reject(request.error||new Error("Library summary cursor failed."));
    request.onsuccess=()=>{
      const cursor=request.result;if(!cursor){resolve();return;}
      const record=cursor.value,doc=record?.document||{},metadata=doc.metadata&&typeof doc.metadata==="object"?doc.metadata:{};
      items.push({id:String(record?.id||doc.id||""),document:{id:String(doc.id||record?.id||""),metadata,source:{filename:doc.source?.filename||"",type:doc.source?.type||"",origin:doc.source?.origin||"",fileSize:Number(doc.source?.fileSize)||0,contentHash:doc.source?.contentHash||""},timestamps:doc.timestamps&&typeof doc.timestamps==="object"?doc.timestamps:{},progress:doc.progress&&typeof doc.progress==="object"?doc.progress:{},content:{parsed:{objectCount:Array.isArray(doc.content?.parsed?.objects)?doc.content.parsed.objects.length:Number(doc.content?.parsed?.objectCount)||0}}},applicationMetadata:createLevelApplicationMetadata(record?.applicationMetadata),createdAt:Number(record?.createdAt)||0,updatedAt:Number(record?.updatedAt)||0});
      cursor.continue();
    };
  });
  return items.sort((a,b)=>b.updatedAt-a.updatedAt);
}

export async function updateLevel(id, document) {
  const current = await getLevel(id);
  if (!current) throw new Error("This level is no longer in the Library.");
  const db = await openLibraryDatabase();
  const record = { ...current, document: { ...document, id, timestamps: { ...document.timestamps, updatedAt: Date.now() } }, updatedAt: Date.now() };
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(record);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  return record;
}

export async function deleteLevel(id) {
  const db = await openLibraryDatabase();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
}
