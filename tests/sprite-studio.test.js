import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { fitRect, SPRITE_FIT_MODES } from "../core/textures/sprites.js";
import { parseJsonAtlas } from "../core/textures/json-atlas-parser.js";
import { importTextureFiles, getSpriteEntries } from "../core/textures/texture-pack.js";

/* ------------------------------------------------------------------ helpers */

// A real, checksum-valid PNG — the texture importer validates every chunk.
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let value = n; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; table[n] = value >>> 0; }
  return table;
})();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw[y * (width * 4 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}
const fileLike = (name, bytes, type) => ({ name, type, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });

/* -------------------------------------------------- replacing a sprite image */

test("fitRect keeps the whole picture inside the slot (contain)", () => {
  // A wide 1024×256 picture dropped on a 46×46 sprite slot.
  const placed = fitRect({ width: 1024, height: 256 }, { width: 46, height: 46 }, "contain");
  assert.equal(placed.width, 46, "the long edge fills the slot");
  assert.equal(placed.height, 12, "the short edge scales with it");
  assert.equal(placed.x, 0);
  assert.equal(placed.y, 17, "centred vertically, 17px of transparent space above and below");
  assert.ok(placed.y * 2 + placed.height <= 46 + 1);
});

test("fitRect fills the slot and crops the overflow (cover)", () => {
  const placed = fitRect({ width: 1024, height: 256 }, { width: 46, height: 46 }, "cover");
  assert.equal(placed.height, 46);
  assert.equal(placed.width, 184);
  assert.equal(placed.y, 0);
  assert.ok(placed.x < 0, "the crop is centred, so the draw starts off-canvas");
  assert.ok(placed.x * 2 + placed.width <= 46 + 1);
});

test("fitRect stretches only when asked, and refuses unknown modes", () => {
  assert.deepEqual(fitRect({ width: 10, height: 200 }, { width: 40, height: 40 }, "stretch"), { x: 0, y: 0, width: 40, height: 40 });
  assert.deepEqual(fitRect({ width: 10, height: 200 }, { width: 40, height: 40 }, "fit"), { x: 0, y: 0, width: 40, height: 40 });
  assert.throws(() => fitRect({ width: 10, height: 10 }, { width: 40, height: 40 }, "squish"), /contain, cover, stretch or exact/);
  assert.deepEqual(SPRITE_FIT_MODES, ["contain", "cover", "stretch", "exact"]);
});

test("fitRect never divides by zero on odd metadata", () => {
  const placed = fitRect({ width: 0, height: 0 }, { width: 16, height: 16 }, "contain");
  assert.deepEqual(placed, { x: 0, y: 0, width: 16, height: 16 });
});

/* ---------------------------------------------------------- json atlas packs */

test("Phaser JSON atlases are read like XML plists (hash and array forms)", () => {
  const hash = parseJsonAtlas(JSON.stringify({
    frames: {
      "block_01.png": { frame: { x: 2, y: 4, w: 46, h: 46 }, rotated: false, trimmed: true, sourceSize: { w: 64, h: 64 } },
      "spike.png": { frame: { x: 60, y: 4, w: 30, h: 30 }, rotated: true, trimmed: false }
    },
    meta: { size: { w: 128, h: 128 }, image: "sheet.png" }
  }));
  assert.deepEqual(Object.keys(hash.frames), ["block_01.png", "spike.png"]);
  assert.deepEqual(hash.frames["block_01.png"].frame, { x: 2, y: 4, width: 46, height: 46 });
  assert.equal(hash.frames["block_01.png"].sourceSize.width, 64);
  assert.equal(hash.frames["block_01.png"].trimmed, true);
  assert.equal(hash.frames["spike.png"].rotated, true);
  assert.deepEqual(hash.meta.size, { width: 128, height: 128 });

  const list = parseJsonAtlas(JSON.stringify({ frames: [{ filename: "a.png", frame: { x: 0, y: 0, w: 8, h: 8 } }] }));
  assert.deepEqual(Object.keys(list.frames), ["a.png"]);
});

test("JSON files that are not atlases are rejected with a plain message", () => {
  assert.throws(() => parseJsonAtlas("{ not json"), /not valid JSON/);
  assert.throws(() => parseJsonAtlas(JSON.stringify({ hello: "world" })), /not a sprite atlas/);
  assert.throws(() => parseJsonAtlas(JSON.stringify({ frames: {} })), /no usable sprite frames/);
});

test("a PNG plus its atlas JSON imports as one sheet of individual sprites", async () => {
  const png = makePng(64, 64);
  const atlas = new TextEncoder().encode(JSON.stringify({
    frames: {
      "cube.png": { frame: { x: 0, y: 0, w: 32, h: 32 } },
      "spike.png": { frame: { x: 32, y: 0, w: 32, h: 32 }, rotated: true }
    },
    meta: { size: { w: 64, h: 64 } }
  }));
  const pack = await importTextureFiles([
    fileLike("GJ_Test.png", new Uint8Array(png), "image/png"),
    fileLike("GJ_Test.json", atlas, "application/json")
  ]);
  const sheets = Object.values(pack.sheets);
  assert.equal(sheets.length, 1, "the png and its json are paired");
  assert.deepEqual(sheets[0].errors, []);
  assert.equal(sheets[0].source.jsonPath, "GJ_Test.json");
  const sprites = getSpriteEntries(pack);
  assert.deepEqual(sprites.map(entry => entry.frame.name).sort(), ["cube.png", "spike.png"]);
  assert.equal(sprites.find(entry => entry.frame.name === "spike.png").frame.rotated, true);
});
