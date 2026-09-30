import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync, inflateSync } from "node:zlib";
import { detectFile } from "../core/import/file-detector.js";
import { ImportSession } from "../core/import/import-session.js";
import { importLevel } from "../core/import/handlers/level-importer.js";

globalThis.pako = { ungzip: bytes => gunzipSync(bytes), inflate: bytes => inflateSync(bytes) };
const levelString = "k1,Sample Level,k2,456,k3,A description,k8,0;1,1,2,30,3,15,unknownField,preserved;";
const compressed = gzipSync(levelString).toString("base64");
const file = (name, text) => ({ name, size: text.length, text: async () => text, slice: () => ({ text: async () => text.slice(0, 256) }) });

test("detects the supported level file types", async () => {
  assert.deepEqual(await detectFile(file("level.gmd", "<data/>")), { kind: "level", confidence: 0.99, handler: "level" });
  assert.equal((await detectFile(file("level.txt", compressed))).kind, "level");
  assert.equal((await detectFile(file("photo.png", "image"))).kind, "unknown");
});

test("groups same-stem GMD and TXT candidates into one import item", async () => {
  const session = await ImportSession.inspect([file("my-level.gmd", "gmd"), file("my-level.txt", compressed)]);
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].kind, "level");
  assert.equal(session.items[0].files.length, 2);
});

test("imports compressed TXT while preserving the raw source and unknown object keys", async () => {
  const document = await importLevel(file("sample.txt", compressed));
  assert.equal(document.type, "level");
  assert.equal(document.metadata.name, "Sample Level");
  assert.equal(document.metadata.levelId, 456);
  assert.equal(document.content.raw, compressed);
  assert.equal(document.content.parsed.objects[0].raw.unknownField, "preserved");
  assert.equal(document.source.type, "txt");
  assert.equal(document.source.origin, "local-file");
  assert.equal(document.source.filename, "sample.txt");
  assert.equal(document.source.fileSize, compressed.length);
  assert.equal(document.source.contentHash.length, 64);
  assert.match(document.id, /^level_456_/);
});

test("imports NUL-padded real-world TXT payloads but keeps the original padded source", async () => {
  const padded = `${compressed}\0\0`;
  const document = await importLevel(file("padded.txt", padded));
  assert.equal(document.content.raw, compressed);
  assert.equal(document.content.parsed.objects.length, 1);
  assert.equal(document.source.originalPayload, padded);
});

test("unwraps a GMD k4 level string and deduplicates its matching TXT payload", async () => {
  const gmdText = `<d><k>k1</k><i>789</i><k>k2</k><s>Wrapped Level</s><k>k3</k><s>V3JhcHBlZCBkZXNjcmlwdGlvbg==</s><k>k4</k><s>${compressed}</s><k>k45</k><i>12345</i></d>`;
  const [gmdDocument, txtDocument] = await Promise.all([
    importLevel(file("wrapped.gmd", gmdText)),
    importLevel(file("wrapped.txt", compressed))
  ]);
  assert.equal(gmdDocument.metadata.name, "Wrapped Level");
  assert.equal(gmdDocument.metadata.description, "Wrapped description");
  assert.equal(gmdDocument.content.raw, compressed);
  assert.equal(gmdDocument.metadata.song.type, "custom");
  assert.equal(gmdDocument.metadata.song.fileId, "12345");
  assert.equal(gmdDocument.source.originalPayload, gmdText);
  assert.equal(gmdDocument.id, txtDocument.id);
});

test("rejects malformed level payloads rather than creating empty documents", async () => {
  await assert.rejects(() => importLevel(file("broken.txt", "this is not a level")), /Could not decode/);
});
