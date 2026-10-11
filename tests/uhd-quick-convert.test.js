import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one-click UHD sprite feature: a UHD PNG + PLIST pair becomes HD (½ size)
 * and Original (¼ size) PNG + PLIST pairs in a single action. The contract is
 * pinned at the source level (the same style as the release-readiness suite),
 * because building the ZIP needs a browser canvas: the pure PLIST scaling half
 * is covered by texture-resolution.test.js.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFile(path.join(root, file), "utf8");

test("the sprite studio converts a UHD pair into HD + Original with one click", async () => {
  const page = await read("app/index.html");
  assert.match(page, /id="uhd-convert"/, "the studio bar keeps a one-click button for an open UHD sheet");
  assert.match(page, /id="uhd-quick-choose"/, "the empty state offers the same one-click conversion");
  assert.match(page, /id="uhd-input"[^>]*multiple/, "the picker takes the PNG + PLIST pair in one selection");

  const studio = await read("app/views/textures.js");
  assert.match(studio, /buildResolutionArchive\(png, plist, \["original", "hd"\]/, "only the derived Original and HD outputs are built");
  assert.match(studio, /async function quickConvertFromPack\b/, "an open UHD sheet converts without any dialog");
  assert.match(studio, /async function quickConvertFromFiles\b/, "a picked PNG + PLIST pair converts immediately");
  assert.match(studio, /downloadGeneratedBlob\(result\.blob/, "the ZIP downloads as part of the same click");
  assert.match(studio, /normalizeAtlasStem\(/, "output filenames drop the -uhd suffix");
  assert.match(studio, /function pickUhdSheet\b/, "the current or -uhd-named sheet is chosen automatically");
});

test("the derived pairs stay usable offline and report their warnings", async () => {
  const sw = await read("sw.js");
  assert.match(sw, /resolution-converter\.js/, "the conversion engine is part of the offline shell");
  const studio = await read("app/views/textures.js");
  assert.match(studio, /warnings\.length/, "notes from the conversion are surfaced to the person converting");
});
