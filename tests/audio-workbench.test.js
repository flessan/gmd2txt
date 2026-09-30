import test from "node:test";
import assert from "node:assert/strict";
import { createAudioAsset, updateAudioAssetMetadata } from "../core/audio/audio-asset.js";
import { SongResolver } from "../core/audio/song-resolver.js";
import { createLevelApplicationMetadata, mergeLevelApplicationMetadata } from "../core/documents/application-metadata.js";
import { inspectLevelDocument } from "../core/inspector/level-inspector.js";
import { searchAudioAssets, searchLevelRecords } from "../core/search/local-search.js";
import { installLegacyIndexedDB } from "./fake-indexeddb.js";
import { ImportSession } from "../core/import/import-session.js";

const makeAudioFile = (name = "theme.mp3", bytes = [1, 2, 3]) => Object.assign(new Blob([new Uint8Array(bytes)], { type: name.endsWith(".ogg") ? "audio/ogg" : name.endsWith(".webm") ? "audio/webm" : "audio/mpeg" }), { name });

test("ImportSession classifies local audio without treating it as a level or downloading it", async () => {
  const file = makeAudioFile("preview.webm"),backup=Object.assign(new Blob(["zip"]),{name:"workspace.gmdproject"}),unknown=Object.assign(new Blob(["text"]),{name:"notes.md"});
  const session = await ImportSession.inspect([file,backup,unknown]);
  assert.equal(session.items.length, 2);
  assert.ok(session.items.some(item=>item.kind==="audio"&&item.files[0]===file));
  assert.ok(session.items.some(item=>item.kind==="project-backup"&&item.files[0]===backup));
  assert.equal(session.ignored[0].file,unknown);
});

test("audio workbench models, resolves relationships, migrates IndexedDB, and retains metadata after deletion", async () => {
  const { getLevel, getLevels, createLevel, updateLevelApplicationMetadata } = await import("../core/storage/database.js");
  const { createAudioAssetRecord, getAudioAsset, getAudioAssets, saveAudioAssetMetadata, deleteAudioAsset } = await import("../core/storage/audio-database.js");
  const oldDocument = {
    type: "level", id: "level-old", metadata: { name: "Old Level", author: "Creator", levelId: 44, song: { type: "official", id: 2, name: "Official track" } },
    content: { format: "gd-level-string", raw: "k1,Old Level,k2,44;1,0,0,0;901,10,20;1006,30,40;12,50,60;31,70,80;", parsed: { settings: { k1: "Old Level", k2: "44" }, objects: [{ id: 1, x: 0, y: 0, raw: { "1": "1" } }, { id: 901, x: 10, y: 20, raw: { "1": "901" } }, { id: 1006, x: 30, y: 40, raw: { "1": "1006" } }, { id: 12, x: 50, y: 60, raw: { "1": "12" } }, { id: 31, x: 70, y: 80, raw: { "1": "31" } }] } },
    source: { type: "txt", filename: "old.txt", contentHash: "legacyhash", fileSize: 200 }, timestamps: { importedAt: 10 }
  };
  const seededRecord = { id: oldDocument.id, document: oldDocument, createdAt: 1, updatedAt: 2 };
  const db = installLegacyIndexedDB([seededRecord]);
  const old = await getLevel("level-old");
  assert.equal(old.document.content.raw, oldDocument.content.raw);
  assert.ok(db.stores.has("audioAssets"), "legacy database upgrade retains the Phase 4 audio store");
  assert.ok(db.stores.has("textureWorkspaces"), "existing texture workspace store remains");

  const model = createAudioAsset(makeAudioFile("mix.ogg"), { displayName: "Opening mix", artist: "Local artist", gdSongId: 42 });
  assert.equal(model.schemaVersion, 2);
  assert.equal(model.filename, "mix.ogg");
  assert.equal(model.displayName, "Opening mix");
  assert.equal(model.mimeType, "audio/ogg");
  assert.equal(model.source, "local-file");
  assert.equal(model.gdSongId, "42");
  assert.equal(model.duration, null);
  assert.throws(() => createAudioAsset({ name: "unknown.bin", size: 2, type: "application/octet-stream" }), /Choose an audio file/);

  const saved = await createAudioAssetRecord(makeAudioFile("theme.mp3"), { displayName: "Theme" });
  assert.equal((await getAudioAsset(saved.id)).displayName, "Theme");
  assert.equal((await getAudioAssets()).length, 1);
  const renamed = await saveAudioAssetMetadata(saved.id, { displayName: "Menu Theme", artist: "Local creator", duration: 92.4 });
  assert.equal(renamed.filename, "theme.mp3");
  assert.equal(renamed.displayName, "Menu Theme");
  assert.equal(renamed.duration, 92.4);
  assert.equal(updateAudioAssetMetadata(renamed, { mimeType: "audio/evil" }).mimeType, "audio/mpeg", "immutable file metadata cannot be overwritten by a metadata patch");

  await updateLevelApplicationMetadata(oldDocument.id, { audioOverride: { source: "local", assetId: saved.id }, textureWorkspaceId: "texture-one", tags: ["Boss", "favorite"], notes: "Local notes" });
  const linked = await getLevel(oldDocument.id);
  assert.equal(linked.document.content.raw, oldDocument.content.raw, "linking never mutates the original level string");
  assert.equal(linked.applicationMetadata.audioOverride.assetId, saved.id);
  assert.deepEqual(linked.applicationMetadata.tags, ["Boss", "favorite"]);
  assert.equal(linked.applicationMetadata.textureWorkspaceId, "texture-one");
  assert.equal(linked.applicationMetadata.schemaVersion, 2);

  const duplicate = await createLevel(oldDocument);
  assert.equal(duplicate.applicationMetadata.audioOverride.assetId, saved.id, "re-import retains GMDPlayer relationships");
  assert.equal((await getLevels()).length, 1);
  const copy=await createLevel(oldDocument,{duplicateMode:"copy"});
  assert.notEqual(copy.id,oldDocument.id);assert.equal(copy.document.content.raw,oldDocument.content.raw);assert.equal((await getLevels()).length,2,"explicit duplicate-as-copy leaves the original record in place");
  const resolver = new SongResolver({ getAudioAsset });
  assert.equal((await resolver.resolve(linked)).type, "local");
  assert.equal((await resolver.resolve({ document: oldDocument })).type, "runtime", "without a local relationship, the original official/custom song path remains selected");
  assert.deepEqual(searchAudioAssets(await getAudioAssets(), "local creator").map(asset => asset.id), [saved.id]);
  assert.deepEqual(searchLevelRecords([linked], "boss", await getAudioAssets()).map(record => record.id), [oldDocument.id]);

  await deleteAudioAsset(saved.id);
  const dangling = await getLevel(oldDocument.id);
  assert.equal(dangling.applicationMetadata.audioOverride.assetId, saved.id, "deleting an asset does not corrupt its level");
  const missing = await resolver.resolve(dangling);
  assert.equal(missing.type, "missing-local");
  assert.equal(missing.fallbackSong.id, 2);
  assert.equal((await getAudioAssets()).length, 0, "deletion persists");

  const next = createLevelApplicationMetadata(mergeLevelApplicationMetadata(dangling.applicationMetadata, { audioOverride: null }));
  assert.equal(next.audioOverride, null);
  assert.equal(dangling.document.content.raw, oldDocument.content.raw);
});

test("level inspector counts IDs, known trigger/portal subsets, and start positions", () => {
  const document = {
    id: "stats-fixture", metadata: { name: "Fixture" }, source: { contentHash: "stats", filename: "fixture.txt" },
    content: { raw: "k1,Fixture;1,0,0;1,10,20;901,30,40;1006,50,60;12,70,80;31,90,100;", parsed: {
      settings: { k1: "Fixture", kA4: "1" }, objects: [
        { id: 1, x: 0, y: 0, raw: { "1": "1" } }, { id: 1, x: 10, y: 20, raw: { "1": "1" } },
        { id: 901, x: 30, y: 40, raw: { "1": "901" } }, { id: 1006, x: 50, y: 60, raw: { "1": "1006" } },
        { id: 12, x: 70, y: 80, raw: { "1": "12" } }, { id: 31, x: 90, y: 100, raw: { "1": "31" } }
      ]
    } }
  };
  const stats = inspectLevelDocument(document);
  assert.equal(stats.objectCount, 6);
  assert.equal(stats.uniqueObjectIds, 5);
  assert.equal(stats.objectFrequency.find(row => row.id === "1").count, 2);
  assert.equal(stats.recognizedTriggerCount, 2);
  assert.deepEqual(stats.triggerFrequency.map(row => row.name), ["Move", "Pulse"]);
  assert.equal(stats.portalCount, 1);
  assert.equal(stats.startPosition[0].x, 90);
  assert.ok(stats.settings.some(item => item.key === "kA4"));
});

test("application metadata remains versioned and independent from source fields", () => {
  const source = { raw: "source-level", settings: { k1: "name" } };
  const appMeta = mergeLevelApplicationMetadata(null, { notes: "private", tags: ["one", "one", "two"], audioOverride: { source: "local", assetId: "song-1" } });
  assert.equal(appMeta.schemaVersion, 2);
  assert.equal(appMeta.notes, "private");
  assert.deepEqual(appMeta.tags, ["one", "two"]);
  assert.equal(appMeta.audioOverride.assetId, "song-1");
  assert.deepEqual(source, { raw: "source-level", settings: { k1: "name" } });
});
