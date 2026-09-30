import { readZip, writeZipBlob, checksumContent, validateArchivePath } from "../textures/zip.js";
import { openLibraryDatabase, getLevel } from "../storage/database.js";
import { getProject } from "../storage/project-database.js";
import { getAudioAsset } from "../storage/audio-database.js";
import { getTextureWorkspace } from "../storage/texture-database.js";
import { getSaveSnapshot } from "../storage/save-database.js";
import { createProject, normalizeProject, PROJECT_RESOURCE_TYPES } from "./project-model.js";

export const PROJECT_BACKUP_FORMAT = "gmdplayer-project";
export const PROJECT_BACKUP_VERSION = 1;
export const PROJECT_BACKUP_EXTENSION = ".gmdproject";
export const PROJECT_BACKUP_MAX_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const STORE_BY_TYPE = Object.freeze({ levels: "levels", audioAssets: "audioAssets", textureWorkspaces: "textureWorkspaces", saveSnapshots: "saveSnapshots" });
const GETTER_BY_TYPE = Object.freeze({ levels: getLevel, audioAssets: getAudioAsset, textureWorkspaces: getTextureWorkspace, saveSnapshots: getSaveSnapshot });
const TYPE_PREFIX = Object.freeze({ levels: "level", audioAssets: "audio", textureWorkspaces: "texture", saveSnapshots: "save" });
const requestResult = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error || new Error("Project resource lookup failed.")); });

function abortError() { return new DOMException("Operation cancelled.", "AbortError"); }
function jsonBytes(value) { return encoder.encode(JSON.stringify(value)); }
function safeObject(value) { return value && typeof value === "object" && !Array.isArray(value); }
function yieldToUi() { return new Promise(resolve => setTimeout(resolve, 0)); }
function provenanceSummary(source = {}) {
  const keys = ["type", "origin", "filename", "mimeType", "fileSize", "contentHash", "filenames", "sourceType", "sourceFiles"];
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}
function sourceDetails(type, record) {
  if (type === "levels") return { filename: record?.document?.source?.filename || null, provenance: provenanceSummary(record?.document?.source) };
  if (type === "audioAssets") return { filename: record?.filename || null, provenance: { source: record?.source || "local-file" } };
  if (type === "textureWorkspaces") return { filename: record?.sourceFiles?.map(item => item.name).join(" + ") || null, provenance: provenanceSummary({ sourceType: record?.sourceType, sourceFiles: record?.sourceFiles || [] }) };
  return { filename: record?.sourceFilenames?.join(" + ") || null, provenance: provenanceSummary(record?.document?.source) };
}

async function externalize(value, files, binaryIndex, stack, binaryRefs) {
  if (value instanceof Blob) {
    const existing = binaryRefs.get(value); if (existing) return existing;
    const path = `blobs/${String(++binaryIndex.value).padStart(6, "0")}.bin`;
    files.set(path, value);
    const ref = { $gmdBinary: "blob", path, mimeType: value.type || "", size: value.size };
    binaryRefs.set(value, ref); return ref;
  }
  if (value instanceof ArrayBuffer) {
    const existing = binaryRefs.get(value); if (existing) return existing;
    const path = `blobs/${String(++binaryIndex.value).padStart(6, "0")}.bin`;
    files.set(path, new Uint8Array(value));
    const ref = { $gmdBinary: "arraybuffer", path, size: value.byteLength };
    binaryRefs.set(value, ref); return ref;
  }
  if (ArrayBuffer.isView(value)) {
    const existing = binaryRefs.get(value); if (existing) return { ...existing, $gmdBinary: value.constructor.name };
    const path = `blobs/${String(++binaryIndex.value).padStart(6, "0")}.bin`;
    files.set(path, new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    const ref = { $gmdBinary: value.constructor.name, path, size: value.byteLength };
    binaryRefs.set(value, ref); return ref;
  }
  if (!value || typeof value !== "object") return value;
  if (stack.has(value)) throw new Error("A resource contains a circular reference and cannot be backed up safely.");
  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    result = [];
    for (let i = 0; i < value.length; i++) {
      result.push(await externalize(value[i], files, binaryIndex, stack, binaryRefs));
      if (i && i % 2000 === 0) await yieldToUi();
    }
  } else {
    result = Object.create(null);
    for (const key of Object.keys(value)) result[key] = await externalize(value[key], files, binaryIndex, stack, binaryRefs);
  }
  stack.delete(value);
  return result;
}

async function hydrate(value, archive, binaryPaths) {
  if (!value || typeof value !== "object") return value;
  if (value.$gmdBinary) {
    const path = value.path;
    if (!validateArchivePath(path) || !binaryPaths.has(path)) throw new Error(`Backup resource references a missing binary file: ${path}`);
    const bytes = archive.get(path);
    if (!bytes || bytes.byteLength !== value.size) throw new Error(`Backup binary size mismatch: ${path}`);
    if (value.$gmdBinary === "blob") return new Blob([bytes], { type: value.mimeType || "application/octet-stream" });
    if (value.$gmdBinary === "arraybuffer") return bytes.slice().buffer;
    const constructors = { Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, BigInt64Array: globalThis.BigInt64Array, BigUint64Array: globalThis.BigUint64Array };
    const Constructor = constructors[value.$gmdBinary];
    if (!Constructor || bytes.byteLength % Constructor.BYTES_PER_ELEMENT) throw new Error(`Unsupported typed binary data in backup: ${value.$gmdBinary}`);
    if (bytes.byteOffset % Constructor.BYTES_PER_ELEMENT === 0) return new Constructor(bytes.buffer, bytes.byteOffset, bytes.byteLength / Constructor.BYTES_PER_ELEMENT);
    return new Constructor(bytes.slice().buffer);
  }
  if (Array.isArray(value)) return Promise.all(value.map(item => hydrate(item, archive, binaryPaths)));
  const result = Object.create(null);
  for (const [key, item] of Object.entries(value)) result[key] = await hydrate(item, archive, binaryPaths);
  return result;
}

async function collectProjectResources(project, options = {}) {
  const db = await openLibraryDatabase(), allCount = PROJECT_RESOURCE_TYPES.reduce((sum, type) => sum + project.resources[type].length, 0);
  const result = Object.create(null); let collected = 0;
  for (const type of PROJECT_RESOURCE_TYPES) {
    const ids = project.resources[type], records = [];
    for (let offset = 0; offset < ids.length; offset += 64) {
      if (options.signal?.aborted) throw abortError();
      const tx = db.transaction(STORE_BY_TYPE[type], "readonly"), store = tx.objectStore(STORE_BY_TYPE[type]);
      const chunk = await Promise.all(ids.slice(offset, offset + 64).map(id => requestResult(store.get(id))));
      records.push(...chunk);
      collected += chunk.length;
      options.onProgress?.({ stage: "collect", current: collected, total: allCount, label: type });
      await yieldToUi();
    }
    result[type] = records;
  }
  return result;
}

export async function exportProjectBackup(projectId, options = {}) {
  const project = await getProject(projectId);
  if (!project) throw new Error("This project is no longer available.");
  const recordsByType = await collectProjectResources(project, options);
  const files = new Map(), binaryIndex = { value: 0 }, resources = [], missingReferences = [];
  files.set("project/project.json", jsonBytes(normalizeProject(project)));
  const memberTotal = PROJECT_RESOURCE_TYPES.reduce((sum, type) => sum + project.resources[type].length, 0);
  let processed = 0, resourceIndex = 0;
  for (const type of PROJECT_RESOURCE_TYPES) {
    for (const [memberIndex, originalId] of project.resources[type].entries()) {
      if (options.signal?.aborted) throw abortError();
      const record = recordsByType[type][memberIndex];
      if (!record) {
        missingReferences.push({ type, originalId, missing: true });
        options.onProgress?.({ stage: "prepare", current: ++processed, total: memberTotal, label: `Missing ${type} reference` });
        continue;
      }
      const recordPath = `resources/${String(++resourceIndex).padStart(6, "0")}.json`;
      const portable = await externalize(record, files, binaryIndex, new WeakSet(), new WeakMap());
      files.set(recordPath, jsonBytes(portable));
      const details = sourceDetails(type, record);
      resources.push({ type, originalId, recordPath, filename: details.filename, provenance: details.provenance, missing: false });
      options.onProgress?.({ stage: "prepare", current: ++processed, total: memberTotal, label: details.filename || type });
      if (processed % 4 === 0) await yieldToUi();
    }
  }
  if (options.signal?.aborted) throw abortError();
  const fileEntries = [], crcByPath = new Map(); let totalBytes = 0;
  for (const [path, content] of files) {
    const checksum = await checksumContent(content, { signal: options.signal });
    totalBytes += checksum.size;
    if (checksum.size > MAX_ENTRY_BYTES || totalBytes > PROJECT_BACKUP_MAX_BYTES - 16 * 1024 * 1024) throw new Error("This project is larger than the 1 GiB portable backup limit. Remove some large assets or export smaller projects.");
    crcByPath.set(path, checksum.crc32);
    fileEntries.push({ path, size: checksum.size, checksum: { algorithm: "crc32", value: checksum.crc32.toString(16).padStart(8, "0") } });
    options.onProgress?.({ stage: "checksums", current: fileEntries.length, total: files.size, label: path });
  }
  fileEntries.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    format: PROJECT_BACKUP_FORMAT,
    version: PROJECT_BACKUP_VERSION,
    createdAt: Date.now(),
    ...(options.createdWith && typeof options.createdWith.name === "string" && typeof options.createdWith.version === "string" ? { createdWith: { name: options.createdWith.name.slice(0,80), version: options.createdWith.version.slice(0,40) } } : {}),
    project: { id: project.id, name: project.name, description: project.description, createdAt: project.createdAt, updatedAt: project.updatedAt },
    membership: normalizeProject(project).resources,
    resources: resources.sort((a, b) => a.type.localeCompare(b.type) || a.originalId.localeCompare(b.originalId)),
    missingReferences: missingReferences.sort((a, b) => a.type.localeCompare(b.type) || a.originalId.localeCompare(b.originalId)),
    files: fileEntries,
    totalBytes
  };
  files.set("manifest.json", jsonBytes(manifest));
  return writeZipBlob(files, {
    maxEntries: MAX_ENTRIES, maxTotalBytes: PROJECT_BACKUP_MAX_BYTES,
    checksums: crcByPath, signal: options.signal,
    onProgress: progress => options.onProgress?.({ stage: "archive", ...progress })
  });
}

export function migrateBackupManifest(manifest) {
  if (manifest.version === PROJECT_BACKUP_VERSION) return manifest;
  if (manifest.version > PROJECT_BACKUP_VERSION) throw new Error("This backup was created by a newer GMDPlayer version and cannot be restored safely.");
  throw new Error(`No migration is available for project backup version ${manifest.version}.`);
}

async function parseBackup(input, options = {}) {
  let archive;
  try {
    archive = await readZip(input, { maxEntries: MAX_ENTRIES, maxEntryBytes: MAX_ENTRY_BYTES, maxTotalBytes: PROJECT_BACKUP_MAX_BYTES, maxArchiveBytes: PROJECT_BACKUP_MAX_BYTES + 32 * 1024 * 1024, signal: options.signal });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error(`The project archive could not be read safely: ${error.message}`);
  }
  const manifestBytes = archive.get("manifest.json");
  if (manifestBytes?.byteLength > MAX_MANIFEST_BYTES) throw new Error("The project backup manifest is larger than the supported limit.");
  if (!manifestBytes) throw new Error("This file is missing manifest.json and is not a GMDPlayer project backup.");
  let manifest;
  try { manifest = JSON.parse(decoder.decode(manifestBytes)); } catch (_) { throw new Error("The project backup manifest is malformed."); }
  if (manifest?.format !== PROJECT_BACKUP_FORMAT || !Number.isInteger(manifest.version)) throw new Error("This file is not a supported GMDPlayer project backup.");
  if (manifest.version > PROJECT_BACKUP_VERSION) throw new Error("This backup was created by a newer GMDPlayer version and cannot be restored safely.");
  manifest = migrateBackupManifest(manifest);
  if (!safeObject(manifest.project) || !Array.isArray(manifest.files) || !Array.isArray(manifest.resources) || !safeObject(manifest.membership)) throw new Error("The project backup manifest is missing required fields.");
  if (manifest.files.length > MAX_ENTRIES || manifest.resources.length > MAX_ENTRIES || archive.size > MAX_ENTRIES + 1) throw new Error("The project archive contains too many files or resources.");
  const declared = new Map(); let totalBytes = 0;
  for (const item of manifest.files) {
    if (!item || typeof item.path !== "string" || !validateArchivePath(item.path) || item.path === "manifest.json" || declared.has(item.path)) throw new Error("The backup manifest contains an unsafe or duplicate file path.");
    if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_ENTRY_BYTES || !safeObject(item.checksum)) throw new Error(`The backup manifest has invalid file metadata: ${item.path}`);
    declared.set(item.path, item); totalBytes += item.size;
    if (totalBytes > PROJECT_BACKUP_MAX_BYTES) throw new Error("The backup exceeds the 1 GiB restore limit.");
  }
  if (archive.size !== declared.size + 1 || [...archive.keys()].some(path => path !== "manifest.json" && !declared.has(path))) throw new Error("The archive contains unlisted or missing files.");
  if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes !== totalBytes) throw new Error("The backup manifest total size does not match its files.");
  for (let i = 0; i < manifest.files.length; i++) {
    if (options.signal?.aborted) throw abortError();
    const item = manifest.files[i], bytes = archive.get(item.path);
    if (!bytes || bytes.byteLength !== item.size) throw new Error(`Backup file is missing or has the wrong size: ${item.path}`);
    const checksum = await checksumContent(bytes, { signal: options.signal });
    if (item.checksum.algorithm !== "crc32" || item.checksum.value !== checksum.crc32.toString(16).padStart(8, "0")) throw new Error(`Backup checksum mismatch: ${item.path}`);
    options.onProgress?.({ stage: "validate", current: i + 1, total: manifest.files.length, label: item.path });
  }
  const projectBytes = archive.get("project/project.json");
  if (!projectBytes) throw new Error("The project backup has no project/project.json record.");
  let project;
  try { project = normalizeProject(JSON.parse(decoder.decode(projectBytes))); } catch (_) { throw new Error("The project metadata file is malformed."); }
  if (project.id !== manifest.project.id) throw new Error("Project ID does not match the manifest.");
  if (project.name !== manifest.project.name || project.description !== manifest.project.description || project.createdAt !== manifest.project.createdAt || project.updatedAt !== manifest.project.updatedAt) throw new Error("Project metadata does not match the backup manifest.");
  for (const type of PROJECT_RESOURCE_TYPES) if (JSON.stringify(project.resources[type]) !== JSON.stringify(normalizeProject({ resources: manifest.membership }).resources[type])) throw new Error(`Project membership does not match the manifest for ${type}.`);

  const allowedTypes = new Set(PROJECT_RESOURCE_TYPES), seenResourceIds = new Set(), resourceFiles = new Set();
  const references = new Set();
  for (const type of PROJECT_RESOURCE_TYPES) {
    const ids = manifest.membership[type];
    if (!Array.isArray(ids)) throw new Error(`Backup project membership is invalid for ${type}.`);
    for (const id of ids) references.add(`${type}:${id}`);
  }
  for (const item of manifest.resources) {
    if (!allowedTypes.has(item.type) || !item.originalId || !validateArchivePath(item.recordPath) || !declared.has(item.recordPath)) throw new Error("The backup contains an invalid resource entry.");
    const key = `${item.type}:${item.originalId}`;
    if (seenResourceIds.has(key)) throw new Error(`Duplicate resource ID in backup: ${item.originalId}`);
    if (!references.has(key)) throw new Error(`Resource is not referenced by the project: ${item.originalId}`);
    seenResourceIds.add(key); resourceFiles.add(item.recordPath);
    let record;
    try { record = JSON.parse(decoder.decode(archive.get(item.recordPath))); } catch (_) { throw new Error(`A resource record is malformed: ${item.recordPath}`); }
    if (!safeObject(record) || String(record.id) !== String(item.originalId)) throw new Error(`Resource ID does not match its manifest entry: ${item.recordPath}`);
  }
  const missingKeys = new Set();
  for (const item of manifest.missingReferences || []) {
    if (!item || !allowedTypes.has(item.type) || !item.originalId || !references.has(`${item.type}:${item.originalId}`) || !item.missing) throw new Error("Backup missing-reference metadata is invalid.");
    missingKeys.add(`${item.type}:${item.originalId}`);
  }
  for (const key of references) if (!seenResourceIds.has(key) && !missingKeys.has(key)) throw new Error(`Project membership reference is not accounted for: ${key}`);

  const binaryPaths = new Set(manifest.files.filter(item => item.path.startsWith("blobs/")).map(item => item.path));
  const referencedBinaries = new Set(), decodedRecords = [];
  const allowedPaths = new Set(["project/project.json", ...resourceFiles, ...binaryPaths]);
  const hydrateKeys = options.hydrate && options.resourceKeys ? new Set(options.resourceKeys) : null;
  function scanRefs(value) {
    if (!value || typeof value !== "object") return;
    if (value.$gmdBinary) {
      if (!binaryPaths.has(value.path)) throw new Error(`Resource references a missing binary file: ${value.path}`);
      referencedBinaries.add(value.path); return;
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) scanRefs(child);
  }
  for (const item of manifest.resources) {
    if (options.signal?.aborted) throw abortError();
    const data = JSON.parse(decoder.decode(archive.get(item.recordPath)));
    scanRefs(data);
    if (options.hydrate && (!hydrateKeys || hydrateKeys.has(`${item.type}:${item.originalId}`))) decodedRecords.push({ descriptor: item, record: await hydrate(data, archive, binaryPaths) });
  }
  if ([...binaryPaths].some(path => !referencedBinaries.has(path))) throw new Error("The archive contains unreferenced binary data.");
  if ([...declared.keys()].some(path => !allowedPaths.has(path)) || [...allowedPaths].some(path => !declared.has(path))) throw new Error("The archive contains files that are not part of its declared project resources.");
  return { manifest, project, decodedRecords, totalBytes };
}

export async function inspectProjectBackup(input, options = {}) {
  const parsed = await parseBackup(input, options);
  const counts = Object.fromEntries(PROJECT_RESOURCE_TYPES.map(type => [type, parsed.manifest.resources.filter(item => item.type === type).length]));
  return { manifest: parsed.manifest, project: parsed.project, counts, totalBytes: parsed.totalBytes, missingReferences: parsed.manifest.missingReferences || [] };
}

function makeId(type) { return `${TYPE_PREFIX[type]}_restored_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`; }

export async function restoreProjectBackup(input, options = {}) {
  const selected = options.resourceKeys ? new Set(options.resourceKeys) : null;
  const parsed = await parseBackup(input, { ...options, hydrate: true, resourceKeys: selected ? [...selected] : undefined });
  const selectedResources = parsed.decodedRecords.filter(item => !selected || selected.has(`${item.descriptor.type}:${item.descriptor.originalId}`));
  const idMaps = Object.fromEntries(PROJECT_RESOURCE_TYPES.map(type => [type, new Map()]));
  for (const { descriptor } of selectedResources) idMaps[descriptor.type].set(descriptor.originalId, makeId(descriptor.type));
  const restoredAt = Date.now(), importId = globalThis.crypto?.randomUUID?.() || `${restoredAt}`;
  const prepared = [], projectResources = Object.fromEntries(PROJECT_RESOURCE_TYPES.map(type => [type, []]));
  for (const { descriptor, record: sourceRecord } of selectedResources) {
    if (options.signal?.aborted) throw abortError();
    const type = descriptor.type, record = sourceRecord, newResourceId = idMaps[type].get(descriptor.originalId);
    record.id = newResourceId;
    record.projectProvenance = { originalLocalId: descriptor.originalId, sourceProjectId: parsed.project.id, sourceProjectName: parsed.project.name, restoredAt, importId };
    if (type === "levels") {
      record.document.id = newResourceId;
      record.document.source = { ...record.document.source, backupProvenance: record.projectProvenance };
      const app = record.applicationMetadata || {};
      if (app.audioOverride?.assetId) app.audioOverride.assetId = idMaps.audioAssets.get(app.audioOverride.assetId) || `missing-import-audio-${importId}-${app.audioOverride.assetId}`;
      if (app.textureWorkspaceId) app.textureWorkspaceId = idMaps.textureWorkspaces.get(app.textureWorkspaceId) || `missing-import-texture-${importId}-${app.textureWorkspaceId}`;
    } else if (type === "audioAssets") {
      record.provenance = { ...(record.provenance || {}), backupImport: record.projectProvenance };
    } else if (type === "textureWorkspaces") {
      record.backupProvenance = record.projectProvenance;
    } else if (type === "saveSnapshots") {
      if (record.document) record.document.id = newResourceId;
      record.backupProvenance = record.projectProvenance;
    }
    projectResources[type].push(newResourceId);
    prepared.push({ type, record });
    options.onProgress?.({ stage: "prepare", current: prepared.length, total: selectedResources.length, label: descriptor.filename || type });
  }
  const unavailableReferences = [];
  for (const item of parsed.manifest.missingReferences || []) {
    const placeholder = `missing-import-${importId}-${item.type}-${encodeURIComponent(item.originalId)}`;
    projectResources[item.type].push(placeholder);
    unavailableReferences.push({ type: item.type, importedReferenceId: placeholder, originalId: item.originalId });
  }
  const restoredProject = createProject({
    name: options.projectName || `${parsed.project.name} (restored)`, description: parsed.project.description, resources: projectResources,
    metadata: { ...parsed.project.metadata, missingProjectReferences: unavailableReferences, restoredFrom: { projectId: parsed.project.id, projectName: parsed.project.name, backupCreatedAt: parsed.manifest.createdAt, restoredAt, importId } }
  });
  if (options.signal?.aborted) throw abortError();
  options.onProgress?.({ stage: "commit", current: 0, total: 1, label: "Database transaction" });
  const db = await openLibraryDatabase();
  if (options.signal?.aborted) throw abortError();
  const stores = [...new Set(["projects", "projectPreferences", ...prepared.map(item => STORE_BY_TYPE[item.type])])];
  const tx = db.transaction(stores, "readwrite");
  for (const item of prepared) tx.objectStore(STORE_BY_TYPE[item.type]).add(item.record);
  tx.objectStore("projects").add(restoredProject);
  tx.objectStore("projectPreferences").put({ key: "activeProjectId", value: restoredProject.id });
  try {
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error || new Error("Restore transaction failed.")); tx.onabort = () => reject(tx.error || new Error("Restore transaction was cancelled.")); });
  } catch (error) { throw new Error("The restore could not be committed. Existing data was not changed.", { cause: error }); }
  const importedCounts = Object.fromEntries(PROJECT_RESOURCE_TYPES.map(type => [type, prepared.filter(item => item.type === type).length]));
  const skippedCounts = Object.fromEntries(PROJECT_RESOURCE_TYPES.map(type => [type, parsed.manifest.resources.filter(item => item.type === type).length - importedCounts[type]]));
  return { project: restoredProject, importedCounts, skippedCounts, missingReferences: parsed.manifest.missingReferences || [] };
}
