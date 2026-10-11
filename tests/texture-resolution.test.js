import test from "node:test";
import assert from "node:assert/strict";
import { parsePlist } from "../core/textures/plist-parser.js";
import { convertPlistResolution, normalizeAtlasStem } from "../core/textures/resolution-converter.js";

const modernPlist = '<?xml version="1.0" encoding="UTF-8"?>\n' +
'<plist version="1.0"><dict><key>frames</key><dict><key>piece.png</key><dict>' +
'<key>frame</key><string>{{8,12},{16,20}}</string>' +
'<key>offset</key><string>{-2,4}</string><key>rotated</key><false/>' +
'<key>sourceColorRect</key><string>{{0,0},{16,20}}</string>' +
'<key>sourceSize</key><string>{16,20}</string></dict></dict>' +
'<key>metadata</key><dict><key>format</key><integer>2</integer>' +
'<key>size</key><string>{128,128}</string>' +
'<key>realTextureFileName</key><string>sheet-uhd.png</string>' +
'<key>textureFileName</key><string>sheet-uhd.png</string></dict></dict></plist>';

test("UHD PLIST coordinates scale into an HD legacy-field PLIST", () => {
  const result = convertPlistResolution(modernPlist, { scale: 0.5, width: 64, height: 64, pngName: "sheet-hd.png", legacyFormat: true });
  const parsed = parsePlist(result.xml), frame = parsed.frames["piece.png"];
  assert.equal(frame.frame.x, 4); assert.equal(frame.frame.y, 6);
  assert.equal(frame.frame.width, 8); assert.equal(frame.frame.height, 10);
  assert.equal(frame.sourceSize.width, 8); assert.equal(frame.sourceSize.height, 10);
  assert.equal(frame.offset.x, -1); assert.equal(frame.offset.y, 2);
  assert.match(result.xml, /<key>textureRect<\/key>/);
  assert.match(result.xml, /<key>spriteSize<\/key>/);
  assert.match(result.xml, /<key>aliases<\/key>/);
  assert.match(result.xml, /<integer>3<\/integer>/);
  assert.match(result.xml, /sheet-hd\.png/);
  assert.equal(result.frameCount, 1); assert.deepEqual(result.warnings, []);
});
test("Original scale preserves rotated frame flags and updates atlas size", () => {
  const rotated = modernPlist.replace("<false/>", "<true/>");
  const result = convertPlistResolution(rotated, { scale: 0.25, width: 32, height: 32, pngName: "sheet.png", legacyFormat: true });
  const parsed = parsePlist(result.xml), frame = parsed.frames["piece.png"];
  assert.equal(frame.frame.x, 2); assert.equal(frame.frame.y, 3);
  assert.equal(frame.rotated, true); assert.equal(parsed.metadata.size, "{32,32}");
});
test("UHD source PLIST keeps modern field names when not downgraded", () => {
  const result = convertPlistResolution(modernPlist, { scale: 1, width: 128, height: 128, pngName: "sheet-uhd.png", legacyFormat: false });
  assert.match(result.xml, /<key>frame<\/key>/);
  assert.doesNotMatch(result.xml, /<key>textureRect<\/key>/);
  assert.match(result.xml, /<integer>2<\/integer>/);
});
test("atlas output names normalize common resolution suffixes", () => {
  assert.equal(normalizeAtlasStem("GJ_LaunchSheet-uhd.png"), "GJ_LaunchSheet");
  assert.equal(normalizeAtlasStem("sheet_hd.PNG"), "sheet");
  assert.equal(normalizeAtlasStem("custom atlas.png"), "custom_atlas");
});
