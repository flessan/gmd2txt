import test from "node:test";
import { deflateRawSync } from "node:zlib";
import assert from "node:assert/strict";
import { parsePlist } from "../core/textures/plist-parser.js";
import { patchPlist } from "../core/textures/plist-writer.js";
import { getPngDimensions, importTextureFiles, applySpriteModification, resetSprite, undoTexture, redoTexture } from "../core/textures/texture-pack.js";
import { readZip, writeZip, validateArchivePath } from "../core/textures/zip.js";
import { createSpriteReplacement } from "../core/textures/sprites.js";
import { detectFile } from "../core/import/file-detector.js";
import { ImportSession } from "../core/import/import-session.js";

const crcTable = (() => { const t = new Uint32Array(256); for (let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t; })();
function crc(data) { let c=0xffffffff; for(const b of data)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0; }
function validPng(width = 16, height = 16) {
  const chunks = [];
  const chunk = (type, data) => { const name = new TextEncoder().encode(type), body = new Uint8Array(name.length + data.length); body.set(name); body.set(data,name.length); const out=new Uint8Array(12+data.length),v=new DataView(out.buffer);v.setUint32(0,data.length);out.set(body,4);v.setUint32(8+data.length,crc(body));chunks.push(out); };
  const header=new Uint8Array(13),v=new DataView(header.buffer);v.setUint32(0,width);v.setUint32(4,height);header.set([8,6,0,0,0],8);chunk("IHDR",header);chunk("IDAT",new Uint8Array([0]));chunk("IEND",new Uint8Array());
  const total=8+chunks.reduce((s,x)=>s+x.length,0), out=new Uint8Array(total);out.set([137,80,78,71,13,10,26,10]);let p=8;for(const c of chunks){out.set(c,p);p+=c.length;}return out;
}
const plist = `<?xml version="1.0"?><plist version="1.0"><dict><key>metadata</key><dict><key>format</key><integer>3</integer><key>unknownGlobal</key><string>keep &amp; me</string></dict><key>frames</key><dict><key>hero.png</key><dict><key>frame</key><string>{{1,2},{5,6}}</string><key>rotated</key><false/><key>offset</key><string>{0,0}</string><key>sourceSize</key><string>{5,6}</string><key>mystery</key><integer>42</integer></dict></dict><key>tail</key><string>untouched</string></dict></plist>`;
const png = validPng();
const file = (name, data) => ({ name, size: data.length, type: "", arrayBuffer: async () => data.slice().buffer, slice: (start, end) => new Blob([data.slice(start, end)]) });
function deflatedZip(name, content) {
  const nameBytes=new TextEncoder().encode(name), data=new Uint8Array(content), compressed=deflateRawSync(data), checksum=crc(data);
  const local=new Uint8Array(30+nameBytes.length+compressed.length), lv=new DataView(local.buffer);
  lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(6,0x0800,true);lv.setUint16(8,8,true);lv.setUint32(14,checksum,true);lv.setUint32(18,compressed.length,true);lv.setUint32(22,data.length,true);lv.setUint16(26,nameBytes.length,true);local.set(nameBytes,30);local.set(compressed,30+nameBytes.length);
  const central=new Uint8Array(46+nameBytes.length),cv=new DataView(central.buffer);cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x0800,true);cv.setUint16(10,8,true);cv.setUint32(16,checksum,true);cv.setUint32(20,compressed.length,true);cv.setUint32(24,data.length,true);cv.setUint16(28,nameBytes.length,true);central.set(nameBytes,46);
  const end=new Uint8Array(22),ev=new DataView(end.buffer);ev.setUint32(0,0x06054b50,true);ev.setUint16(8,1,true);ev.setUint16(10,1,true);ev.setUint32(12,central.length,true);ev.setUint32(16,local.length,true);
  const output=new Uint8Array(local.length+central.length+end.length);output.set(local);output.set(central,local.length);output.set(end,local.length+central.length);return output;
}

test("PLIST reads Cocos frame structures and retains unknown data in parsed metadata", () => {
  const parsed = parsePlist(plist);
  assert.equal(parsed.frames["hero.png"].frame.x, 1);
  assert.equal(parsed.frames["hero.png"].sourceSize.height, 6);
  assert.equal(parsed.frames["hero.png"].raw.mystery, 42);
  assert.equal(parsed.metadata.unknownGlobal, "keep & me");
});

test("PLIST geometry patch changes only requested scalar text and keeps unknown XML intact", () => {
  const parsed = parsePlist(plist);
  const changed = patchPlist(parsed, { "hero.png": { frame: { x: 3, y: 4, width: 5, height: 6 } } });
  assert.match(changed, /\{\{3,4\},\{5,6\}\}/);
  assert.match(changed, /<key>mystery<\/key><integer>42<\/integer>/);
  assert.match(changed, /<key>unknownGlobal<\/key><string>keep &amp; me<\/string>/);
  assert.match(changed, /<key>tail<\/key><string>untouched<\/string>/);
  const repacked = patchPlist(parsed, { "hero.png": { rotated: true } });
  assert.match(repacked, /<key>rotated<\/key><true\/>/);
  assert.equal(parsePlist(repacked).frames["hero.png"].rotated, true);
});

test("PLIST parser recognizes the alternate textureRect/textureRotated frame keys", () => {
  const parsed = parsePlist(`<plist><dict><key>frames</key><dict><key>ship</key><dict><key>textureRect</key><string>{{2,3},{8,9}}</string><key>textureRotated</key><true/><key>spriteOffset</key><string>{1,-1}</string><key>spriteSourceSize</key><string>{10,12}</string></dict></dict></dict></plist>`);
  assert.deepEqual(parsed.frames.ship.frame, { x: 2, y: 3, width: 8, height: 9 });
  assert.equal(parsed.frames.ship.rotated, true);
  assert.deepEqual(parsed.frames.ship.sourceSize, { width: 10, height: 12 });
});

test("PNG validation checks dimensions and rejects damaged chunk data", () => {
  assert.deepEqual(getPngDimensions(png), { width: 16, height: 16 });
  const damaged = png.slice(); damaged[29] ^= 1;
  assert.throws(() => getPngDimensions(damaged), /checksum/);
  assert.throws(() => getPngDimensions(new Uint8Array([137,80,78,71,13,10,26,10])), /PNG/);
});

test("texture imports group PNG and PLIST and preserve incomplete sheets", async () => {
  const doc = await importTextureFiles([file("sprites.png", png), file("sprites.plist", new TextEncoder().encode(plist)), file("orphan.png", png)]);
  assert.equal(Object.keys(doc.sheets).length, 2);
  assert.equal(doc.sheets.sprites.parsed.frames["hero.png"].frame.width, 5);
  assert.ok(doc.sheets.orphan.errors.includes("Sprite metadata is missing (a .plist or atlas .json next to the PNG)."));
  assert.equal(doc.sheets.sprites.source.png[0], 137);
  assert.equal(doc.sourceFiles.length,3);assert.ok(doc.sourceFiles.every(source=>/^sha256-chunked-v1:/.test(source.contentHash)));
});

test("exact-slot size mismatch is rejected from PNG headers before decoding image pixels", async () => {
  const frame = { name: "hero", frame: { x: 1, y: 2, width: 5, height: 6 }, rotated: false };
  await assert.rejects(
    createSpriteReplacement(png, frame, png, "exact"),
    /An exact replacement must already be 5×6px/
  );
});

test("replacement history supports reset, undo, redo without mutating source assets", () => {
  const sheet = { id: "sheet", parsed: { frames: { sprite: { frame: { x: 0, y: 0, width: 1, height: 1 } } } } };
  const doc = { sheets: { sheet }, modifications: {}, history: [], historyIndex: 0, updatedAt: 1 };
  const original = new Uint8Array([137,80]);
  applySpriteModification(doc, "sheet", "sprite", original);
  assert.equal(doc.modifications.sheet.sprite.png, original);
  resetSprite(doc, "sheet", "sprite");
  assert.equal(doc.modifications.sheet.sprite, undefined);
  undoTexture(doc); assert.equal(doc.modifications.sheet.sprite.png, original);
  redoTexture(doc); assert.equal(doc.modifications.sheet.sprite, undefined);
});

test("texture ZIP import-export-reimport preserves sheet paths and unknown PLIST fields", async () => {
  const sourceArchive = writeZip(new Map([["Resources/atlas.png", png], ["Resources/atlas.plist", new TextEncoder().encode(plist)]]));
  const first = await importTextureFiles([file("sample-pack.zip", sourceArchive)]);
  const exportedArchive = writeZip(first.archiveEntries);
  const second = await importTextureFiles([file("roundtrip.zip", exportedArchive)]);
  assert.deepEqual(Object.keys(second.sheets), Object.keys(first.sheets));
  const sheet = Object.values(second.sheets)[0];
  assert.deepEqual(Object.keys(sheet.parsed.frames), ["hero.png"]);
  assert.equal(sheet.parsed.frames["hero.png"].raw.mystery, 42);
  assert.deepEqual([...sheet.source.png], [...png]);
  assert.ok(Object.hasOwn(second.archiveEntries, "Resources/atlas.plist"));
});

test("ZIP roundtrip preserves names and bytes while path validation rejects traversal", async () => {
  const archive = writeZip(new Map([["textures/a.bin", new Uint8Array([1,2,3])], ["atlas.plist", new TextEncoder().encode(plist)]]));
  const result = await readZip(archive);
  assert.deepEqual([...result.get("textures/a.bin")], [1,2,3]);
  assert.equal(new TextDecoder().decode(result.get("atlas.plist")), plist);
  assert.equal(validateArchivePath("nested/sheet.png"), true);
  assert.equal(validateArchivePath("../outside"), false);
  assert.equal(validateArchivePath("C:/outside"), false);
  const hostile = writeZip({ "abcdef": new Uint8Array([1]) });
  const safeBytes = new TextEncoder().encode("abcdef"), evilBytes = new TextEncoder().encode("..\\abc");
  for (let i = 0; i <= hostile.length - safeBytes.length; i++) if (safeBytes.every((byte, n) => hostile[i + n] === byte)) hostile.set(evilBytes, i);
  await assert.rejects(readZip(hostile), /Unsafe ZIP entry path/);
});

test("ZIP reader inflates bounded DEFLATE entries", async () => {
  const expected = new TextEncoder().encode("a deflated Geometry Dash sprite sheet payload");
  const archive = deflatedZip("nested/sprite.dat", expected);
  const files = await readZip(archive);
  assert.deepEqual([...files.get("nested/sprite.dat")], [...expected]);
});

test("detector recognizes valid texture signatures and ImportSession groups loose sheet pairs", async () => {
  const pngFile = file("atlas.png", png), plistFile = file("atlas.plist", new TextEncoder().encode(plist));
  assert.equal((await detectFile(pngFile)).kind, "texture");
  const session = await ImportSession.inspect([pngFile, plistFile]);
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].kind, "texture");
  assert.equal(session.items[0].files.length, 2);
  assert.equal((await detectFile({ ...pngFile, name: "broken.png", slice: () => new Blob(["bad"]) })).kind, "unknown");
});
