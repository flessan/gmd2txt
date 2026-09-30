import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync, inflateSync } from "node:zlib";
import { detectFile } from "../core/import/file-detector.js";
import { ImportSession } from "../core/import/import-session.js";
import { importSave } from "../core/import/handlers/save-importer.js";
import { maskSensitiveFields, normalizeSaveData, parseSaveXml } from "../core/saves/save-decoder.js";

globalThis.pako = { ungzip: bytes => gunzipSync(bytes), inflate: bytes => inflateSync(bytes), inflateRaw: bytes => inflateSync(bytes, { finishFlush: 2 }) };
const levelString = "kA6,1,kA7,1;1,1,2,32,3,15,999,keep;";
const innerLevel = gzipSync(levelString).toString("base64url");
const gameManagerXml = `<?xml version="1.0"?><plist version="1.0" gjver="2.0"><dict><key>binaryVersion</key><integer>42</integer><key>playerName</key><string>Fixture Player</string><key>playerUDID</key><string>private-fixture</string><key>stars</key><integer>91</integer><key>secretCoins</key><integer>7</integer><key>GLM_01</key><dict><key>1</key><dict><key>progress</key><integer>100</integer><key>attempts</key><integer>3</integer></dict></dict><key>reportedAchievements</key><array><string>first</string></array></dict></plist>`;
const localLevelsXml = `<?xml version="1.0"?><plist version="1.0" gjver="2.0"><dict><key>LLM_01</key><dict><key>_isArr</key><true/><key>k_0</key><dict><key>k1</key><integer>123</integer><key>k2</key><string>Fixture Local</string><key>k3</key><string>SGVsbG8gZGVzY3JpcHRpb24=</string><key>k4</key><string>${innerLevel}</string><key>k8</key><integer>0</integer></dict></dict></dict></plist>`;
function encryptedFile(name, xml, padding = []) {
  const encoded = Buffer.from(gzipSync(Buffer.from(xml, "utf8")).toString("base64url"), "utf8");
  const bytes = Buffer.concat([Buffer.from(encoded.map(byte => byte ^ 11)), Buffer.from(padding)]);
  return {
    name, size: bytes.length, type: "application/octet-stream",
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    slice() { return new Blob([bytes], { type: "application/octet-stream" }); }
  };
}
function plainXmlFile(name, xml) {
  const bytes = new TextEncoder().encode(xml);
  return { name, size: bytes.length, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }, slice() { return new Blob([bytes]); } };
}
const manager = () => encryptedFile("CCGameManager.dat", gameManagerXml);
const paddedManager = () => encryptedFile("CCGameManager.dat", gameManagerXml, [0, 3]);
const localLevels = () => encryptedFile("CCLocalLevels.dat", localLevelsXml);

test("XML parser handles plist dictionaries, arrays, booleans, and GD shorthand tags", () => {
  const tree = parseSaveXml("<d><k>items</k><d><k>_isArr</k><t/><k>k_0</k><s>hello</s></d><k>flag</k><f/></d>");
  assert.equal(tree.items.k_0, "hello");
  assert.equal(tree.items._isArr, true);
  assert.equal(tree.flag, false);
});

test("save detector validates content and does not accept arbitrary DAT files", async () => {
  assert.deepEqual(await detectFile(manager()), { kind: "save", saveType: "game-manager", confidence: 0.99, handler: "save" });
  assert.equal((await detectFile(localLevels())).saveType, "local-levels");
  const arbitrary = encryptedFile("notes.dat", "<plist><dict><key>just-a-note</key><string>hello</string></dict></plist>");
  assert.equal((await detectFile(arbitrary)).kind, "unknown");
  const broken = { name: "CCGameManager.dat", arrayBuffer: async () => new TextEncoder().encode("corrupt").buffer };
  const result = await detectFile(broken);
  assert.equal(result.kind, "save");
  assert.equal(result.invalid, true);
});

test("decoder accepts Geometry Dash encoded save text with trailing binary padding", async () => {
  const save = await importSave([paddedManager()]);
  assert.equal(save.metadata.gameVersion, "2.0");
  assert.equal(save.metadata.binaryVersion, 42);
  assert.equal(save.normalized.gameManager.player.name, "Fixture Player");
});

test("decoder accepts a directly readable XML variant", async () => {
  const decoded = await importSave([plainXmlFile("CCGameManager.dat", gameManagerXml)]);
  assert.equal(decoded.decoded.gameManager.encoding, "plain-xml");
  assert.equal(decoded.normalized.gameManager.player.name, "Fixture Player");
});

test("ImportSession groups manager and local-level save files in one workspace", async () => {
  const session = await ImportSession.inspect([manager(), localLevels()]);
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].kind, "save");
  assert.equal(session.items[0].files.length, 2);
  assert.deepEqual(new Set(session.items[0].detections.map(item => item.saveType)), new Set(["game-manager", "local-levels"]));
});

test("decoder normalizes available stats and leaves missing fields absent", async () => {
  const save = await importSave([manager()]);
  assert.equal(save.type, "save");
  assert.equal(save.normalized.gameManager.stats.Stars, 91);
  assert.equal(save.normalized.gameManager.stats["Secret Coins"], 7);
  assert.equal(save.normalized.gameManager.stats.Diamonds, undefined);
  assert.equal(save.metadata.gameVersion, "2.0");
  assert.equal(save.metadata.binaryVersion, 42);
  assert.match(save.decoded.gameManager.xml, /Fixture Player/);
  assert.ok(save.files.gameManager.original instanceof Blob);
  assert.equal(save.files.gameManager.size, manager().size);
  assert.equal((await importSave([manager()])).id, save.id);
});

test("local levels become canonical LevelDocuments with save provenance", async () => {
  const save = await importSave([localLevels()]);
  const levels = save.normalized.localLevels;
  assert.equal(levels.length, 1);
  assert.equal(levels[0].name, "Fixture Local");
  assert.equal(levels[0].levelId, 123);
  assert.equal(levels[0].document.type, "level");
  assert.equal(levels[0].document.metadata.name, "Fixture Local");
  assert.equal(levels[0].document.metadata.description, "Hello description");
  assert.equal(levels[0].document.source.type, "save");
  assert.equal(levels[0].document.source.filename, "CCLocalLevels.dat");
  assert.equal(levels[0].document.content.raw, innerLevel);
  assert.equal((await importSave([localLevels()])).normalized.localLevels[0].document.id, levels[0].document.id);
});

test("combined save preserves both original files and makes no changes to either", async () => {
  const input = [manager(), localLevels()];
  const before = await Promise.all(input.map(file => file.arrayBuffer()));
  const save = await importSave(input);
  assert.ok(save.files.gameManager);
  assert.ok(save.files.localLevels);
  assert.equal(save.source.filenames.length, 2);
  const after = await Promise.all(input.map(file => file.arrayBuffer()));
  assert.deepEqual(new Uint8Array(before[0]), new Uint8Array(after[0]));
  assert.deepEqual(new Uint8Array(before[1]), new Uint8Array(after[1]));
});

test("normalizes Geometry Dash GS_value and GLM_01-style structures", async () => {
  const tree = parseSaveXml("<plist><dict><key>GS_value</key><dict><key>1</key><integer>29</integer><key>14</key><integer>13</integer></dict><key>GLM_01</key><dict><key>1</key><dict><key>k1</key><integer>1</integer><key>k2</key><string>Stereo Madness</string><key>k7</key><integer>1</integer></dict></dict></dict></plist>");
  const normalized = normalizeSaveData(tree, "game-manager");
  assert.equal(normalized.statValues.length, 2);
  assert.equal(normalized.statValues[0].key, "1");
  assert.equal(normalized.statValues[0].value, 29);
  assert.equal(normalized.levels.length, 1);
  assert.equal(normalized.levels[0].name, "Stereo Madness");
  assert.equal(normalized.levels[0].id, 1);
});

test("corrupt saves fail with a safe message and sensitive fields are masked recursively", async () => {
  const broken = { name: "CCGameManager.dat", arrayBuffer: async () => new TextEncoder().encode("not a save").buffer };
  await assert.rejects(() => importSave([broken]), /Unable to decode save file.*No data was uploaded/);
  const safe = maskSensitiveFields({ playerName: "player", playerUDID: "secret", GJP2: "private", nested: { password: "do-not-show", stars: 12 } });
  assert.equal(safe.playerName, "player");
  assert.equal(safe.playerUDID, "[hidden]");
  assert.equal(safe.GJP2, "[hidden]");
  assert.equal(safe.nested.password, "[hidden]");
  assert.equal(safe.nested.stars, 12);
});

test("normalizer supports optional-field absence and an empty local-level collection", async () => {
  assert.deepEqual(normalizeSaveData({ binaryVersion: 1 }, "game-manager").stats, {});
  const tree = parseSaveXml("<plist><dict><key>LLM_01</key><dict><key>_isArr</key><true/></dict></dict></plist>");
  const normalized = normalizeSaveData(tree, "local-levels");
  assert.deepEqual(normalized.localLevelRecords, []);
  assert.equal((await importSave([encryptedFile("CCLocalLevels.dat", "<plist><dict><key>LLM_01</key><dict><key>_isArr</key><true/></dict></dict></plist>")])).normalized.localLevels.length, 0);
});
