import { openLibraryDatabase } from "./database.js";
import { createProject, normalizeProject, setProjectResource, updateProjectModel, PROJECT_RESOURCE_TYPES } from "../projects/project-model.js";

const PROJECTS = "projects";
const PREFERENCES = "projectPreferences";
const STORE_FOR_TYPE = Object.freeze({ levels: "levels", audioAssets: "audioAssets", textureWorkspaces: "textureWorkspaces", saveSnapshots: "saveSnapshots" });
const requestResult = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error || new Error("Project database request failed.")); });
const transactionDone = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error || new Error("Project update failed.")); tx.onabort = () => reject(tx.error || new Error("Project update was cancelled.")); });
const newId = prefix => `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
const clone = value => structuredClone(value);
const idMap = () => new Map();

export async function createProjectRecord(input = {}) {
  const project = createProject(input), db = await openLibraryDatabase();
  const tx = db.transaction(PROJECTS, "readwrite"); tx.objectStore(PROJECTS).add(project); await transactionDone(tx); return project;
}
export async function getProject(id) {
  const db = await openLibraryDatabase(), record = await requestResult(db.transaction(PROJECTS, "readonly").objectStore(PROJECTS).get(id));
  return record ? normalizeProject(record) : record;
}
export async function getProjects() {
  const db = await openLibraryDatabase(); const projects = await requestResult(db.transaction(PROJECTS, "readonly").objectStore(PROJECTS).getAll());
  return projects.map(normalizeProject).sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function updateProjectRecord(id, patch = {}) {
  const current = await getProject(id); if (!current) throw new Error("This project is no longer available.");
  const updated = updateProjectModel(current, patch), db = await openLibraryDatabase();
  const tx = db.transaction(PROJECTS, "readwrite"); tx.objectStore(PROJECTS).put(updated); await transactionDone(tx); return updated;
}
export async function addProjectResource(projectId, type, resourceId) {
  if (!PROJECT_RESOURCE_TYPES.includes(type) || !resourceId) throw new TypeError("A valid project resource is required.");
  const current = await getProject(projectId); if (!current) throw new Error("This project is no longer available.");
  const updated = setProjectResource(current, type, resourceId, true), db = await openLibraryDatabase();
  const tx = db.transaction(PROJECTS, "readwrite"); tx.objectStore(PROJECTS).put(updated); await transactionDone(tx); return updated;
}
export async function removeProjectResource(projectId, type, resourceId) {
  if (!PROJECT_RESOURCE_TYPES.includes(type)) throw new TypeError(`Unknown project resource type: ${type}`);
  const current = await getProject(projectId); if (!current) throw new Error("This project is no longer available.");
  const updated = setProjectResource(current, type, resourceId, false), db = await openLibraryDatabase();
  const tx = db.transaction(PROJECTS, "readwrite"); tx.objectStore(PROJECTS).put(updated); await transactionDone(tx); return updated;
}
export async function deleteProjectRecord(id) {
  const db = await openLibraryDatabase(), tx = db.transaction([PROJECTS, PREFERENCES], "readwrite");
  tx.objectStore(PROJECTS).delete(id);
  const prefStore = tx.objectStore(PREFERENCES);
  const active = await requestResult(prefStore.get("activeProjectId"));
  if (active?.value === id) prefStore.put({ key: "activeProjectId", value: null });
  await transactionDone(tx);
}
export async function getActiveProjectId() {
  const db = await openLibraryDatabase(), record = await requestResult(db.transaction(PREFERENCES, "readonly").objectStore(PREFERENCES).get("activeProjectId"));
  return record?.value || null;
}
export async function setActiveProjectId(id) {
  if (id) {
    const project = await getProject(id);
    if (!project) throw new Error("That project no longer exists.");
    if (project.archivedAt) throw new Error("Archived projects cannot be opened. Restore the project first.");
  }
  const db = await openLibraryDatabase(), tx = db.transaction(PREFERENCES, "readwrite");
  tx.objectStore(PREFERENCES).put({ key: "activeProjectId", value: id || null }); await transactionDone(tx); return id || null;
}

export async function duplicateProjectRecord(id) {
  const db = await openLibraryDatabase(), source = await getProject(id);
  if (!source) throw new Error("This project is no longer available.");
  const stores = [PROJECTS, ...Object.values(STORE_FOR_TYPE)];
  const snapshots = {};
  for (const type of PROJECT_RESOURCE_TYPES) {
    const storeName = STORE_FOR_TYPE[type], store = db.transaction(storeName, "readonly").objectStore(storeName);
    const ids = source.resources?.[type] || [], records = await Promise.all(ids.map(resourceId => requestResult(store.get(resourceId))));
    snapshots[type] = new Map(ids.map((resourceId, index) => [resourceId, records[index]]));
  }
  const maps = Object.fromEntries(PROJECT_RESOURCE_TYPES.map(type => [type, idMap()]));
  const members = Object.fromEntries(PROJECT_RESOURCE_TYPES.map(type => [type, []]));
  for (const type of PROJECT_RESOURCE_TYPES) {
    for (const oldId of source.resources?.[type] || []) {
      const record = snapshots[type].get(oldId);
      if (!record) { members[type].push(`missing-duplicate-${type}-${encodeURIComponent(oldId)}`); continue; }
      const prefix = type === "levels" ? "level" : type === "audioAssets" ? "audio" : type === "textureWorkspaces" ? "texture" : "save";
      maps[type].set(oldId, newId(prefix)); members[type].push(maps[type].get(oldId));
    }
  }
  const inserts = [];
  for (const type of PROJECT_RESOURCE_TYPES) {
    for (const [oldId, newResourceId] of maps[type]) {
      const record = clone(snapshots[type].get(oldId)); record.id = newResourceId;
      record.projectProvenance = { sourceProjectId: source.id, sourceResourceId: oldId, duplicatedAt: Date.now() };
      if (type === "levels") {
        record.document.id = newResourceId;
        const app = record.applicationMetadata || {};
        if (app.audioOverride?.assetId) app.audioOverride.assetId = maps.audioAssets.get(app.audioOverride.assetId) || `missing-duplicate-audio-${newId("ref")}`;
        if (app.textureWorkspaceId) app.textureWorkspaceId = maps.textureWorkspaces.get(app.textureWorkspaceId) || `missing-duplicate-texture-${newId("ref")}`;
      } else if (type === "saveSnapshots" && record.document) record.document.id = newResourceId;
      inserts.push([STORE_FOR_TYPE[type], record]);
    }
  }
  const duplicate = createProject({
    name: `${source.name} copy`, description: source.description,
    resources: members,
    metadata: { ...source.metadata, duplicatedFrom: source.id },
    createdAt: Date.now()
  });
  const tx = db.transaction(stores, "readwrite");
  for (const [storeName, record] of inserts) tx.objectStore(storeName).add(record);
  tx.objectStore(PROJECTS).add(duplicate);
  await transactionDone(tx);
  return duplicate;
}
