import test from "node:test";
import assert from "node:assert/strict";
import { installLegacyIndexedDB } from "./fake-indexeddb.js";
import { createProject, setProjectResource } from "../core/projects/project-model.js";
import { exportProjectBackup, inspectProjectBackup, restoreProjectBackup } from "../core/projects/project-backup.js";
import { readZip, writeZip } from "../core/textures/zip.js";

const levelRecord = {
  id: "level-source-1",
  document: { type: "level", id: "level-source-1", metadata: { name: "Restorable", author: "Tester", song: { type: "official", id: 2, name: "Official" } }, content: { format: "gd-level-string", raw: "k1,Restorable;1,0,0;", parsed: { settings: { k1: "Restorable" }, objects: [{ id: 1, x: 0, y: 0, raw: { "1": "1" } }] } }, source: { type: "txt", filename: "restorable.txt", origin: "local-file", fileSize: 20, contentHash: "abc123" }, timestamps: { importedAt: 10 } },
  applicationMetadata: { schemaVersion: 1, audioOverride: { source: "local", assetId: "song-source-1" }, textureWorkspaceId: "texture-source-1", tags: ["project"], notes: "kept separate" }, createdAt: 10, updatedAt: 20
};
const audioRecord = { schemaVersion: 1, id: "song-source-1", filename: "theme.ogg", displayName: "Theme", mimeType: "audio/ogg", fileSize: 4, duration: 1.2, importedAt: 11, source: "local-file", blob: new Blob([new Uint8Array([7, 8, 9, 10])], { type: "audio/ogg" }), gdSongId: null, artist: "Local", album: "", notes: "" };
const textureRecord = { id: "texture-source-1", name: "Pack", createdAt: 12, updatedAt: 13, sourceType: "files", sourceFiles: [{ name: "sheet.png", size: 3 }], archiveEntries: { "sheet.png": new Uint8Array([1, 2, 3]) }, sheets: { sheet: { id: "sheet", source: { png: new Uint8Array([1, 2, 3]), plist: "<plist/>" }, parsed: { frames: {} } } }, modifications: {}, history: [], historyIndex: 0 };
const saveRecord = { id: "save-source-1", sourceFilenames: ["CCLocalLevels.dat"], importedAt: 14, document: { type: "save", id: "save-source-1", source: { filenames: ["CCLocalLevels.dat"] }, files: { localLevels: new Blob([new Uint8Array([5, 6])]) }, normalized: { localLevels: [] } } };

async function seedV4() {
  const db = installLegacyIndexedDB([structuredClone(levelRecord)], { version: 4, audioRows: [audioRecord], textureRows: [textureRecord], saveRows: [saveRecord] });
  const { openLibraryDatabase } = await import("../core/storage/database.js");
  const opened = await openLibraryDatabase();
  return { db, opened };
}

test("v4-to-v6 migration preserves existing resources and adds project/workbench stores", async () => {
  const { db, opened } = await seedV4();
  assert.equal(opened.version, 6);
  assert.ok(db.stores.has("levels"));
  assert.ok(db.stores.has("audioAssets"));
  assert.ok(db.stores.has("textureWorkspaces"));
  assert.ok(db.stores.has("saveSnapshots"));
  assert.ok(db.stores.has("projects"));
  assert.ok(db.stores.has("projectPreferences"));
  assert.ok(db.stores.has("workbenchData"));
  const { getLevels, getLibrarySummaries } = await import("../core/storage/database.js");
  const { getAudioAssets } = await import("../core/storage/audio-database.js");
  const { getTextureWorkspaces, getTextureWorkspaceSummaries } = await import("../core/storage/texture-database.js");
  const { getSaveSnapshots } = await import("../core/storage/save-database.js");
  assert.equal((await getLevels())[0].document.content.raw, levelRecord.document.content.raw);
  const levelSummary=(await getLibrarySummaries())[0];assert.equal(levelSummary.document.content.raw,undefined);assert.equal(levelSummary.document.content.parsed.objectCount,1);assert.equal(levelSummary.document.metadata.name,"Restorable");
  assert.equal((await getAudioAssets())[0].id, audioRecord.id);
  assert.equal((await getTextureWorkspaces())[0].id, textureRecord.id);
  const textureSummary=(await getTextureWorkspaceSummaries())[0];assert.equal(textureSummary.id,textureRecord.id);assert.equal(textureSummary.sourceBytes,3);assert.equal(textureSummary.spriteCount,0);assert.equal(textureSummary.archiveEntries,undefined);assert.equal(textureSummary.sheets,undefined);
  assert.equal((await getSaveSnapshots())[0].id, saveRecord.id);
});

test("projects persist membership, duplicate independent records, and deletion leaves global assets", async () => {
  const { createProjectRecord, getProject, addProjectResource, removeProjectResource, duplicateProjectRecord, deleteProjectRecord, setActiveProjectId, getActiveProjectId } = await import("../core/storage/project-database.js");
  const project = await createProjectRecord({ name: "Platformer", description: "A local workbench" });
  await addProjectResource(project.id, "levels", levelRecord.id);
  await addProjectResource(project.id, "audioAssets", audioRecord.id);
  await addProjectResource(project.id, "textureWorkspaces", textureRecord.id);
  await addProjectResource(project.id, "saveSnapshots", saveRecord.id);
  assert.deepEqual((await getProject(project.id)).resources.levels, [levelRecord.id]);
  const { updateProjectRecord } = await import("../core/storage/project-database.js");
  await updateProjectRecord(project.id, { archivedAt: Date.now() });
  await assert.rejects(() => setActiveProjectId(project.id), /Archived projects cannot be opened/);
  await updateProjectRecord(project.id, { archivedAt: null });
  await setActiveProjectId(project.id);
  assert.equal(await getActiveProjectId(), project.id);
  const duplicate = await duplicateProjectRecord(project.id);
  assert.notEqual(duplicate.id, project.id);
  assert.notEqual(duplicate.resources.levels[0], levelRecord.id);
  assert.notEqual(duplicate.resources.audioAssets[0], audioRecord.id);
  const { getLevel } = await import("../core/storage/database.js");
  const duplicateLevel = await getLevel(duplicate.resources.levels[0]);
  assert.equal(duplicateLevel.document.content.raw, levelRecord.document.content.raw);
  assert.equal(duplicateLevel.applicationMetadata.audioOverride.assetId, duplicate.resources.audioAssets[0]);
  assert.equal(duplicateLevel.applicationMetadata.textureWorkspaceId, duplicate.resources.textureWorkspaces[0]);
  const { getAudioAsset } = await import("../core/storage/audio-database.js");
  assert.equal((await getAudioAsset(duplicate.resources.audioAssets[0])).blob.size, audioRecord.blob.size);
  const { getTextureWorkspace, saveTextureWorkspace } = await import("../core/storage/texture-database.js");
  const duplicateTexture = await getTextureWorkspace(duplicate.resources.textureWorkspaces[0]);
  duplicateTexture.sheets.sheet.source.png[0] = 99;
  await saveTextureWorkspace(duplicateTexture);
  assert.equal((await getTextureWorkspace(textureRecord.id)).sheets.sheet.source.png[0], 1, "duplicated texture workspaces have independent mutable arrays");
  await removeProjectResource(project.id, "levels", levelRecord.id);
  assert.deepEqual((await getProject(project.id)).resources.levels, []);
  await deleteProjectRecord(project.id);
  assert.equal(await getProject(project.id), undefined);
  assert.ok(await getLevel(levelRecord.id), "global level is still stored after project deletion");
  assert.ok(await getAudioAsset(audioRecord.id), "global audio is still stored after project deletion");
  assert.equal(await getActiveProjectId(), null);
});

test("portable project backup validates checksums and round-trips selected resources with new IDs", async () => {
  const { createProjectRecord, addProjectResource, getProject } = await import("../core/storage/project-database.js");
  const project = await createProjectRecord({ name: "Round Trip", description: "Portable test" });
  await addProjectResource(project.id, "levels", levelRecord.id);
  await addProjectResource(project.id, "audioAssets", audioRecord.id);
  await addProjectResource(project.id, "textureWorkspaces", textureRecord.id);
  await addProjectResource(project.id, "saveSnapshots", saveRecord.id);
  const archive = await exportProjectBackup(project.id,{createdWith:{name:"GMDPlayer",version:"1.0.0"}});
  assert.ok(archive instanceof Blob);
  assert.ok(archive.size > audioRecord.blob.size);
  const preview = await inspectProjectBackup(archive);
  assert.equal(preview.manifest.format, "gmdplayer-project");
  assert.equal(preview.manifest.version, 1);
  assert.deepEqual(preview.manifest.createdWith,{name:"GMDPlayer",version:"1.0.0"});
  assert.deepEqual(preview.counts, { levels: 1, audioAssets: 1, textureWorkspaces: 1, saveSnapshots: 1 });
  assert.ok(preview.manifest.files.some(file => file.checksum.algorithm === "crc32"));
  const legacyEntries=await readZip(archive),legacyManifest=JSON.parse(new TextDecoder().decode(legacyEntries.get("manifest.json")));delete legacyManifest.createdWith;legacyEntries.set("manifest.json",new TextEncoder().encode(JSON.stringify(legacyManifest)));
  const olderBackup=new Blob([writeZip(legacyEntries)],{type:"application/zip"}),olderPreview=await inspectProjectBackup(olderBackup);
  assert.equal(olderPreview.manifest.version,1);assert.equal(Object.hasOwn(olderPreview.manifest,"createdWith"),false,"older v1 backups remain valid without optional release metadata");

  const selection = ["levels:level-source-1", "audioAssets:song-source-1"];
  const restored = await restoreProjectBackup(archive, { resourceKeys: selection });
  assert.notEqual(restored.project.id, project.id);
  assert.equal(restored.importedCounts.levels, 1);
  assert.equal(restored.importedCounts.audioAssets, 1);
  assert.equal(restored.importedCounts.textureWorkspaces, 0);
  assert.equal(restored.importedCounts.saveSnapshots, 0);
  assert.equal(restored.project.resources.levels.length, 1);
  assert.equal(restored.project.resources.textureWorkspaces.length, 0);
  const { getActiveProjectId } = await import("../core/storage/project-database.js");
  assert.equal(await getActiveProjectId(), restored.project.id, "restore activates its new project in the same transaction");
  const { getLevel, getLevels } = await import("../core/storage/database.js");
  const restoredLevel = await getLevel(restored.project.resources.levels[0]);
  assert.notEqual(restoredLevel.id, levelRecord.id);
  assert.equal(restoredLevel.document.content.raw, levelRecord.document.content.raw);
  assert.equal(restoredLevel.document.source.backupProvenance.originalLocalId, levelRecord.id);
  assert.equal(restoredLevel.applicationMetadata.audioOverride.assetId, restored.project.resources.audioAssets[0]);
  assert.ok(restoredLevel.applicationMetadata.textureWorkspaceId.startsWith("missing-import-texture-"));
  assert.equal((await getLevels()).length, 3, "restore is additive and keeps original and duplicated records");
  const { getAudioAsset, getAudioAssets } = await import("../core/storage/audio-database.js");
  const restoredAudio = await getAudioAsset(restored.project.resources.audioAssets[0]);
  assert.equal(restoredAudio.blob.size, audioRecord.blob.size);
  assert.equal(restoredAudio.filename, audioRecord.filename);
  assert.equal((await getAudioAssets()).length, 3);
  assert.ok(await getProject(project.id), "original project remains unchanged");
  const fullRestore = await restoreProjectBackup(archive);
  assert.deepEqual(fullRestore.importedCounts, { levels: 1, audioAssets: 1, textureWorkspaces: 1, saveSnapshots: 1 });
  const { getTextureWorkspace } = await import("../core/storage/texture-database.js");
  const restoredTexture = await getTextureWorkspace(fullRestore.project.resources.textureWorkspaces[0]);
  assert.deepEqual([...restoredTexture.archiveEntries["sheet.png"]], [1, 2, 3]);
  const { getSaveSnapshot } = await import("../core/storage/save-database.js");
  const restoredSave = await getSaveSnapshot(fullRestore.project.resources.saveSnapshots[0]);
  assert.equal(restoredSave.document.files.localLevels.size, 2);
  const files = await readZip(archive);
  const binaryPath = [...files.keys()].find(path => path.startsWith("blobs/"));
  assert.ok(binaryPath, "audio and texture payloads are stored as archive binary entries");
  files.get(binaryPath)[0] ^= 0xff;
  const tampered = new Blob([writeZip(files)], { type: "application/zip" });
  await assert.rejects(() => inspectProjectBackup(tampered), /checksum mismatch/);
  const { getProjects } = await import("../core/storage/project-database.js");
  const projectCountBefore = (await getProjects()).length, levelCountBefore = (await getLevels()).length;
  await assert.rejects(() => restoreProjectBackup(tampered), /checksum mismatch/);
  assert.equal((await getProjects()).length, projectCountBefore, "invalid archives are rejected before creating project records");
  assert.equal((await getLevels()).length, levelCountBefore, "invalid archives do not mutate global level data");
});

test("missing global resources survive export and restore as unavailable membership references", async () => {
  const { createProjectRecord, addProjectResource, getProject } = await import("../core/storage/project-database.js");
  const project = await createProjectRecord({ name: "Broken links are recoverable" });
  await addProjectResource(project.id, "levels", "deleted-level-original");
  const archive = await exportProjectBackup(project.id);
  const preview = await inspectProjectBackup(archive);
  assert.deepEqual(preview.missingReferences, [{ type: "levels", originalId: "deleted-level-original", missing: true }]);
  const restored = await restoreProjectBackup(archive);
  assert.deepEqual(restored.importedCounts, { levels: 0, audioAssets: 0, textureWorkspaces: 0, saveSnapshots: 0 });
  assert.equal(restored.project.resources.levels.length, 1);
  assert.ok(restored.project.resources.levels[0].startsWith("missing-import-"));
  assert.equal((await getProject(restored.project.id)).metadata.missingProjectReferences[0].originalId, "deleted-level-original");
});

test("backup rejects malformed manifests and unsupported future versions before writes", async () => {
  const malformed = new Blob([writeZip(new Map([["manifest.json", new TextEncoder().encode("{bad json")]]))], { type: "application/zip" });
  await assert.rejects(() => inspectProjectBackup(malformed), /manifest is malformed/);
  const futureManifest = { format: "gmdplayer-project", version: 99, project: {}, resources: [], files: [], membership: {} };
  const future = new Blob([writeZip(new Map([["manifest.json", new TextEncoder().encode(JSON.stringify(futureManifest))]]))], { type: "application/zip" });
  await assert.rejects(() => restoreProjectBackup(future), /newer GMDPlayer version/);
});
