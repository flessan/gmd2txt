import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync, inflateSync } from "node:zlib";
import {
  buildGmdText,
  buildLevelDocument,
  convertLevelText,
  decodeCompressedLevelString,
  encodeCompressedLevelString,
  extractGmdLevelString,
  looksLikeLevelText,
  parseLevelHeader,
  resolveSong,
  sanitizeFileName,
  scanLevelObjects,
  uniqueFileName
} from "../core/convert/level-file.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sampleLevelString = "k1,456,k2,Sample Level,k3,A description,k8,0;1,1,2,30,3,15,unknownField,preserved;";
const compressedSample = gzipSync(sampleLevelString).toString("base64");

/* ------------------------------------------------------------------ *
 * Reading real files that ship with the runtime
 * ------------------------------------------------------------------ */

test("converts a real bundled level export into a .gmd and reports what is inside", async () => {
  const text = await readFile(path.join(root, "app/play/assets/levels/1.txt"), "utf8");
  const conversion = await convertLevelText({ text, filename: "1.txt", size: text.length });

  assert.equal(conversion.ok, true);
  assert.equal(conversion.sourceKind, "txt");
  assert.equal(conversion.targetKind, "gmd");
  assert.equal(conversion.compressed, true);
  assert.equal(conversion.scan.objectCount, 2291);
  assert.ok(conversion.scan.uniqueObjectTypes > 10);
  assert.equal(conversion.displayName, "1", "a file with no internal name falls back to its file name");
  assert.equal(conversion.metadata.song.type, "unknown");

  const gmd = conversion.output.text;
  assert.match(gmd, /<k>k4<\/k><s>[A-Za-z0-9+/=_-]+<\/s>/);
  const reloaded = extractGmdLevelString(gmd);
  assert.ok(reloaded, "the generated .gmd can be read back");
  assert.equal(reloaded.levelString, text.trim(), "the level payload survives a round trip byte for byte");

  const back = await convertLevelText({ text: gmd, filename: "1.gmd" });
  assert.equal(back.ok, true);
  assert.equal(back.output.extension, ".txt");
  assert.equal(back.output.text, text.trim());
});

/* ------------------------------------------------------------------ *
 * .gmd → .txt
 * ------------------------------------------------------------------ */

test("unwraps a .gmd export, unescapes XML entities, and reads its metadata", async () => {
  const gmd = buildGmdText({
    levelString: compressedSample,
    name: "Comet & <Crash>",
    author: "Rocky \"R\" Top",
    description: "Line one\nLine two",
    levelId: 998877,
    customSongId: 123456
  });
  const conversion = await convertLevelText({ text: gmd, filename: "comet.gmd" });

  assert.equal(conversion.ok, true);
  assert.equal(conversion.sourceKind, "gmd");
  assert.equal(conversion.metadata.name, "Comet & <Crash>");
  assert.equal(conversion.metadata.author, "Rocky \"R\" Top");
  assert.equal(conversion.metadata.description, "Line one\nLine two");
  assert.equal(conversion.metadata.levelId, 998877);
  assert.equal(conversion.song.type, "custom");
  assert.equal(conversion.song.id, 123456);
  assert.equal(conversion.output.text, compressedSample, "the .txt is the exact level string from the .gmd");
  assert.equal(conversion.decodedText, sampleLevelString, "the readable level text is available separately");
  assert.equal(conversion.output.filename, "Comet & Crash.txt", "file names are sanitised for every platform");
});

test("reads .gmd files written with standard plist tags", async () => {
  const gmd = `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>k2</key><string>Plister</string>
    <key>k5</key><string>Someone</string>
    <key>k4</key><string>${compressedSample}</string>
  </dict></plist>`;
  const conversion = await convertLevelText({ text: gmd, filename: "plister.gmd" });
  assert.equal(conversion.ok, true);
  assert.equal(conversion.metadata.name, "Plister");
  assert.equal(conversion.metadata.author, "Someone");
  assert.equal(conversion.output.text, compressedSample);
});

/* ------------------------------------------------------------------ *
 * .txt → .gmd
 * ------------------------------------------------------------------ */

test("wraps a readable level string into a .gmd and compresses it the way the game expects", async () => {
  const conversion = await convertLevelText({ text: sampleLevelString, filename: "sample level.txt" });

  assert.equal(conversion.ok, true);
  assert.equal(conversion.sourceKind, "txt");
  assert.equal(conversion.compressed, false);
  assert.equal(conversion.metadata.name, "Sample Level");
  assert.equal(conversion.metadata.levelId, 456);
  assert.match(conversion.output.text, /<k>k4<\/k><s>H4sI/);

  const payload = extractGmdLevelString(conversion.output.text).levelString;
  assert.equal(gunzipSync(Buffer.from(payload, "base64")).toString("utf8"), sampleLevelString);
  assert.equal(conversion.readableText, sampleLevelString);
  assert.equal(conversion.decodedText, null, "no separate readable download when the input was already readable");
  assert.equal(conversion.output.filename, "Sample Level.gmd");
});

test("keeps a compressed level string that already is a .txt payload", async () => {
  const conversion = await convertLevelText({ text: compressedSample, filename: "level.txt", officialSongs: [[null, "Stereo Madness", "level_1", ["RobTop", "Forever Bound"]]] });
  assert.equal(conversion.ok, true);
  assert.equal(conversion.compressed, true);
  assert.equal(conversion.scan.objectCount, 1);
  const payload = extractGmdLevelString(conversion.output.text).levelString;
  assert.equal(payload, compressedSample, "already-compressed text is embedded as-is");
  assert.equal(conversion.song.name, "Stereo Madness");
  assert.equal(conversion.song.artist, "Forever Bound");
});

test("accepts URL-safe base64, a byte-order mark, and terminal NUL padding", async () => {
  const urlSafe = compressedSample.replace(/\+/g, "-").replace(/\//g, "_");
  const conversion = await convertLevelText({ text: `\uFEFF  ${urlSafe}\0\0\0`, filename: "padded.txt" });
  assert.equal(conversion.ok, true);
  assert.equal(conversion.decodedText, sampleLevelString);
  assert.equal(conversion.levelString, urlSafe.trim(), "the payload is kept exactly as supplied");
});

test("a .gmd round trip keeps the payload identical across both directions", async () => {
  const first = await convertLevelText({ text: compressedSample, filename: "round.txt" });
  const second = await convertLevelText({ text: first.output.text, filename: "round.gmd" });
  const third = await convertLevelText({ text: second.output.text, filename: "round.txt" });
  assert.equal(second.output.text, compressedSample, "the .gmd carries the payload unchanged");
  assert.equal(third.output.text, first.output.text, "re-wrapping the payload rebuilds the same .gmd");
});

/* ------------------------------------------------------------------ *
 * Friendly failures
 * ------------------------------------------------------------------ */

test("explains what went wrong instead of throwing", async () => {
  const empty = await convertLevelText({ text: "   ", filename: "nothing.txt" });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, "empty");

  const random = await convertLevelText({ text: "hello world, this is a note; not a level", filename: "notes.txt" });
  assert.equal(random.ok, false);
  assert.equal(random.code, "unknown");
  assert.match(random.message, /could not read/i);
  assert.ok(random.hint.length > 0);

  const save = await convertLevelText({ text: "<plist><dict><k>GS_value</k><s>x</s></dict></plist>", filename: "CCGameManager.dat" });
  assert.equal(save.ok, false);
  assert.equal(save.code, "save-file");
  assert.match(save.hint, /advanced workshop/i);

  const truncated = await convertLevelText({ text: "H4sIAAAAAAAAA" + "A".repeat(60), filename: "broken.txt" });
  assert.equal(truncated.ok, false);
  assert.equal(truncated.code, "corrupt");

  const emptyGmd = await convertLevelText({ text: '<?xml version="1.0"?><plist><dict><k>k2</k><s>Nothing</s></dict></plist>', filename: "empty.gmd" });
  assert.equal(emptyGmd.ok, false);
  assert.equal(emptyGmd.code, "no-level-string");

  const tooLarge = await convertLevelText({ text: "x", filename: "huge.gmd", size: 200 * 1024 * 1024 });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.code, "too-large");
});

test("level text detection does not claim ordinary prose", () => {
  assert.equal(looksLikeLevelText(sampleLevelString), true);
  assert.equal(looksLikeLevelText("Just a normal sentence; with a semicolon, and a comma."), false);
  assert.equal(looksLikeLevelText("k2,A;"), false, "no objects means no level");
  assert.equal(looksLikeLevelText('<plist version="1.0"><dict></dict></plist>'), false);
});

/* ------------------------------------------------------------------ *
 * Level scanning and metadata
 * ------------------------------------------------------------------ */

test("scans objects, portals, game modes, triggers, and start positions in one pass", () => {
  const level = [
    "k1,777,k2,Scanner,k8,3",
    "1,1,2,30,3,15",            // block
    "1,1,2,60,3,15",            // block again
    "1,13,2,90,3,15",           // ship portal
    "1,12,2,120,3,15",          // cube portal
    "1,1006,2,150,3,15",        // pulse trigger (known trigger id)
    "1,31,2,300,3,450",         // start position
    "1,4000,2,999,3,15"          // object id outside the known maps
  ].join(";");

  const scan = scanLevelObjects(level);
  assert.equal(scan.objectCount, 7);
  assert.equal(scan.uniqueObjectTypes, 6);
  assert.equal(scan.portalCount, 2);
  assert.equal(scan.triggerCount, 1, "start positions are not counted as triggers");
  assert.deepEqual(scan.gameModes, ["Ship", "Cube"]);
  assert.equal(scan.hasStartPosition, true);
  assert.deepEqual(scan.startPositions, [{ x: 300, y: 450 }]);
  assert.equal(scan.topObjectTypes[0].id, 1);
  assert.equal(scan.topObjectTypes[0].count, 2);

  assert.deepEqual(parseLevelHeader(level), { k1: "777", k2: "Scanner", k8: "3" });
});

test("resolves official and custom songs without guessing", () => {
  const officialSongs = [[null, "Stereo Madness", "level_1", ["RobTop", "Forever Bound"]]];
  assert.deepEqual(resolveSong({ officialSongIndex: 0 }, {}, officialSongs), { type: "official", id: 0, name: "Stereo Madness", artist: "Forever Bound" });
  assert.equal(resolveSong({ officialSongIndex: 7 }, {}, officialSongs).name, "Official song #8");
  assert.equal(resolveSong({ customSongId: 4242 }, {}).name, "Custom song #4242");
  assert.equal(resolveSong({ customSongId: 4242 }, { k45: "9" }).id, 4242, "wrapper metadata wins over the level header");
  assert.equal(resolveSong({}, {}, null).type, "unknown");
  assert.equal(resolveSong({}, { k45: "555" }).id, 555, "the header supplies the song when the wrapper is silent");
});

/* ------------------------------------------------------------------ *
 * File naming and Library documents
 * ------------------------------------------------------------------ */

test("suggests safe, non-colliding file names", () => {
  assert.equal(sanitizeFileName("My/Cool:Level?"), "My Cool Level");
  assert.equal(sanitizeFileName("   "), "level");
  const used = new Set();
  assert.equal(uniqueFileName("Level.txt", used), "Level.txt");
  assert.equal(uniqueFileName("Level.txt", used), "Level (2).txt");
  assert.equal(uniqueFileName("Level.txt", used), "Level (3).txt");
});

test("stores converted levels in the same shape the Library already uses", async () => {
  const conversion = await convertLevelText({ text: compressedSample, filename: "sample.txt" });
  const document = await buildLevelDocument(conversion, { filename: "sample.txt", size: 123, mimeType: "text/plain" });

  assert.match(document.id, /^level_456_[0-9a-f]{64}$/);
  assert.equal(document.metadata.name, "Sample Level");
  assert.equal(document.content.raw, compressedSample);
  assert.equal(document.content.parsed.objectCount, 1);
  assert.equal(document.source.origin, "local-file");
  assert.equal(document.source.contentHash.length, 64);

  const again = await buildLevelDocument(conversion, { filename: "sample.txt" });
  assert.equal(again.id, document.id, "the same level always produces the same Library id");
  assert.equal(again.source.originalPayload, undefined, "no duplicate payload is stored when the file already is the payload");
});

test("keeps the original .gmd text alongside the payload for provenance", async () => {
  const gmd = buildGmdText({ levelString: compressedSample, name: "Original", author: "Someone" });
  const conversion = await convertLevelText({ text: gmd, filename: "original.gmd" });
  const document = await buildLevelDocument(conversion, { filename: "original.gmd" });
  assert.equal(document.source.originalPayload, gmd);
  assert.equal(document.source.type, "gmd");
  assert.equal(document.content.raw, compressedSample);
});

/* ------------------------------------------------------------------ *
 * Compression helpers and the pako fallback
 * ------------------------------------------------------------------ */

test("compression helpers round trip", async () => {
  const encoded = await encodeCompressedLevelString(sampleLevelString);
  assert.match(encoded, /^H4sI/);
  assert.equal(await decodeCompressedLevelString(encoded), sampleLevelString);
  assert.equal(await decodeCompressedLevelString("not compressed at all"), null);
});

test("falls back to pako when the browser has no CompressionStream", async () => {
  const originalDecompression = globalThis.DecompressionStream;
  const originalCompression = globalThis.CompressionStream;
  globalThis.DecompressionStream = undefined;
  globalThis.CompressionStream = undefined;
  globalThis.pako = {
    gzip: bytes => gzipSync(Buffer.from(bytes)),
    ungzip: bytes => gunzipSync(Buffer.from(bytes)),
    inflate: bytes => inflateSync(Buffer.from(bytes))
  };
  try {
    const conversion = await convertLevelText({ text: sampleLevelString, filename: "legacy.txt" });
    assert.equal(conversion.ok, true);
    assert.match(conversion.output.text, /<k>k4<\/k><s>H4sI/);
    const payload = extractGmdLevelString(conversion.output.text).levelString;
    assert.equal(await decodeCompressedLevelString(payload), sampleLevelString);
  } finally {
    globalThis.DecompressionStream = originalDecompression;
    globalThis.CompressionStream = originalCompression;
    delete globalThis.pako;
  }
});
