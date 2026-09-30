import { openLibraryDatabase } from "./database.js";
import { normalizeTags } from "../documents/tags.js";
const STORE = "textureWorkspaces";
const requestResult = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error || new Error("Texture workspace request failed.")); });
function transactionDone(tx) { return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error || new Error("Texture workspace could not be saved.")); tx.onabort = () => reject(tx.error || new Error("Texture workspace save was cancelled.")); }); }
export async function saveTextureWorkspace(document) {
  const db = await openLibraryDatabase(), now = Date.now();
  const record = { ...document, tags: normalizeTags(document.tags), favorite: document.favorite === true, updatedAt: now };
  const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).put(record); await transactionDone(tx); return record;
}
export async function getTextureWorkspace(id) {
  const db = await openLibraryDatabase(); return requestResult(db.transaction(STORE, "readonly").objectStore(STORE).get(id));
}
export async function getTextureWorkspaces() {
  const db = await openLibraryDatabase(); const result = await requestResult(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Build a lightweight catalog without retaining large atlas PNG/PLIST arrays in the shell. */
export async function getTextureWorkspaceSummaries() {
  const db=await openLibraryDatabase(),store=db.transaction(STORE,"readonly").objectStore(STORE),items=[];
  await new Promise((resolve,reject)=>{
    const request=store.openCursor();
    request.onerror=()=>reject(request.error||new Error("Texture catalog cursor failed."));
    request.onsuccess=()=>{
      const cursor=request.result;if(!cursor){resolve();return;}
      const record=cursor.value||{},sheets=record.sheets&&typeof record.sheets==="object"?Object.values(record.sheets):[];
      const sourceBytes=Object.values(record.archiveEntries&&typeof record.archiveEntries==="object"?record.archiveEntries:{}).reduce((total,value)=>total+(value?.byteLength||value?.length||0),0);
      items.push({id:String(record.id||""),name:String(record.name||"Texture workspace"),sourceType:String(record.sourceType||"local import"),sourceFiles:Array.isArray(record.sourceFiles)?record.sourceFiles.map(file=>({name:String(file?.name||""),size:Number(file?.size)||0,type:String(file?.type||""),contentHash:String(file?.contentHash||"")})):[],tags:Array.isArray(record.tags)?record.tags.filter(tag=>typeof tag==="string").slice(0,100):[],favorite:record.favorite===true,createdAt:Number(record.createdAt)||0,updatedAt:Number(record.updatedAt)||0,sheetCount:sheets.length,spriteCount:sheets.reduce((count,sheet)=>count+Object.keys(sheet?.parsed?.frames||{}).length,0),sourceBytes});
      cursor.continue();
    };
  });
  return items.sort((a,b)=>b.updatedAt-a.updatedAt);
}
export async function deleteTextureWorkspace(id) {
  const db = await openLibraryDatabase(), tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).delete(id); await transactionDone(tx);
}
