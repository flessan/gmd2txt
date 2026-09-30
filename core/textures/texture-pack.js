import { parsePlist } from "./plist-parser.js";
import { hashFileContent } from "../workbench/content-hash.js";
import { readZip } from "./zip.js";

const MAX_FILE = 128 * 1024 * 1024;
const MAX_FILES = 2000;
const randomId = () => globalThis.crypto?.randomUUID?.() || `texture-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const bytes = async file => {
  if (file.size > MAX_FILE) throw new Error(`File exceeds the size limit: ${file.name}`);
  return new Uint8Array(await file.arrayBuffer());
};
const pngCrcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let value = n; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; table[n] = value >>> 0; }
  return table;
})();
function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = pngCrcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function getPngDimensions(data) {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (b.length < 45 || ![137,80,78,71,13,10,26,10].every((value, i) => b[i] === value)) throw new Error("Invalid or unsupported PNG file.");
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let offset = 8, width = 0, height = 0, sawHeader = false, sawData = false, sawEnd = false;
  while (offset + 12 <= b.length) {
    const length = view.getUint32(offset);
    if (length > b.length - offset - 12) throw new Error("PNG chunk is truncated.");
    const type = String.fromCharCode(b[offset + 4], b[offset + 5], b[offset + 6], b[offset + 7]);
    const crcOffset = offset + 8 + length;
    if (pngCrc32(b.subarray(offset + 4, crcOffset)) !== view.getUint32(crcOffset)) throw new Error(`PNG ${type} checksum is invalid.`);
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) throw new Error("PNG header is invalid.");
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      const depth = b[offset + 16], color = b[offset + 17];
      const allowed = { 0: [1,2,4,8,16], 2: [8,16], 3: [1,2,4,8], 4: [8,16], 6: [8,16] };
      if (!allowed[color]?.includes(depth) || b[offset + 18] !== 0 || b[offset + 19] > 1 || b[offset + 20] > 1) throw new Error("Unsupported PNG color format.");
      sawHeader = true;
    } else if (type === "IDAT") sawData = true;
    else if (type === "IEND") { if (length !== 0) throw new Error("PNG end marker is malformed."); sawEnd = true; break; }
    offset = crcOffset + 4;
  }
  if (!sawHeader || !sawData || !sawEnd || !width || !height || width * height > 100_000_000) throw new Error("PNG is incomplete or dimensions exceed the safety limit.");
  return { width, height };
}
function stem(path) { return path.replace(/\\/g, "/").replace(/\.[^.]+$/, "").toLowerCase(); }
function displayStem(path) { return path.replace(/\\/g, "/").split("/").pop().replace(/\.[^.]+$/, ""); }
function safeFilename(name) { return String(name).replace(/[\\/]/g, "_").replace(/[\0-\x1f]/g, "").slice(0, 180) || "texture"; }

function pairFiles(entries, packName, sourceType, sourceFiles) {
  const candidates = [...entries.entries()].filter(([path]) => /\.(png|plist)$/i.test(path));
  const byStem = new Map();
  for (const [path, data] of candidates) {
    const key = stem(path);
    if (!byStem.has(key)) byStem.set(key, {});
    const record = byStem.get(key);
    if (/\.png$/i.test(path)) record.png = { path, data };
    else record.plist = { path, data };
  }
  const sheets = Object.create(null);
  for (const [key, pair] of byStem) {
    const referencePath = pair.png?.path || pair.plist?.path || key;
    const id = safeFilename(referencePath.replace(/\.[^.]+$/, ""));
    const sheet = { id, name: displayStem(referencePath), source: { pngPath: pair.png?.path || null, plistPath: pair.plist?.path || null, png: pair.png?.data || null, plist: pair.plist?.data || null }, parsed: { width: null, height: null, plist: null, frames: {} }, errors: [] };
    if (pair.png) { try { Object.assign(sheet.parsed, getPngDimensions(pair.png.data)); } catch (error) { sheet.errors.push(error.message); } }
    if (pair.plist) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(pair.plist.data);
        sheet.parsed.plist = parsePlist(text);
        sheet.parsed.frames = sheet.parsed.plist.frames;
        if (sheet.parsed.width && sheet.parsed.height) for (const frame of Object.values(sheet.parsed.frames)) {
          const rect = frame.frame;
          if (!Number.isInteger(rect.x) || !Number.isInteger(rect.y) || !Number.isInteger(rect.width) || !Number.isInteger(rect.height) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > sheet.parsed.width || rect.y + rect.height > sheet.parsed.height) sheet.errors.push(`Sprite frame is outside atlas bounds: ${frame.name}`);
        }
      } catch (error) { sheet.errors.push(`PLIST: ${error.message}`); }
    }
    if (!pair.png) sheet.errors.push("PNG sheet is missing.");
    if (!pair.plist) sheet.errors.push("PLIST metadata is missing.");
    sheets[id] = sheet;
  }
  return {
    schemaVersion: 1, id: randomId(), name: packName || "Texture pack", createdAt: Date.now(), updatedAt: Date.now(), sourceType,
    sourceFiles, archiveEntries: Object.fromEntries([...entries].map(([path, data]) => [path, data])),
    sheets, modifications: Object.create(null), history: [], historyIndex: 0
  };
}

export async function importTextureFiles(files) {
  const list = Array.from(files || []);
  if (!list.length || list.length > MAX_FILES) throw new Error(`Choose between 1 and ${MAX_FILES} files.`);
  const all = new Map(), sources = [], zipNames = [];
  let sourceTotal = 0, expandedTotal = 0;
  for (const file of list) {
    const name = String(file.name || "asset").replace(/\\/g, "/");
    const data = await bytes(file);
    sourceTotal += data.length;
    if (sourceTotal > 256 * 1024 * 1024) throw new Error("Selected source files exceed the 256 MiB total limit.");
    let contentHash="";try{contentHash=await hashFileContent(data);}catch(_){/* Content remains usable if Web Crypto is unavailable. */}
    sources.push({ name, size: data.length, type: file.type || "", contentHash });
    if (/\.zip$/i.test(name)) {
      zipNames.push(name);
      const entries = await readZip(data);
      for (const [path, content] of entries) {
        const storedPath = list.filter(item => /\.zip$/i.test(item.name)).length > 1 ? `${name.split("/").pop().replace(/\.zip$/i, "")}/${path}` : path;
        if (all.has(storedPath)) throw new Error(`Duplicate archive path in selected packs: ${storedPath}`);
        if (all.size >= MAX_FILES || (expandedTotal += content.length) > 256 * 1024 * 1024) throw new Error("Selected archive entries exceed file-count or expanded-size limits.");
        all.set(storedPath, content);
      }
    } else {
      if (all.has(name)) throw new Error(`Duplicate texture filename: ${name}`);
      if (all.size >= MAX_FILES || (expandedTotal += data.length) > 256 * 1024 * 1024) throw new Error("Selected assets exceed file-count or expanded-size limits.");
      all.set(name, data);
    }
  }
  const packName = zipNames.length === 1 ? zipNames[0].split("/").pop().replace(/\.zip$/i, "") : list.length === 1 ? list[0].name.replace(/\.[^.]+$/, "") : "Texture pack";
  return pairFiles(all, packName, zipNames.length ? "zip" : "files", sources);
}

export function getSpriteEntries(document) {
  const result = [];
  for (const sheet of Object.values(document.sheets || {})) for (const frame of Object.values(sheet.parsed?.frames || {})) result.push({ sheetId: sheet.id, sheetName: sheet.name, frame });
  return result;
}

export function applySpriteModification(document, sheetId, spriteName, pngBytes, details = {}) {
  const sheet = document.sheets?.[sheetId], frame = sheet?.parsed?.frames?.[spriteName];
  if (!sheet || !frame) throw new Error("Sprite was not found in this texture workspace.");
  const before = document.modifications?.[sheetId]?.[spriteName] || null;
  const history = document.history.slice(0, document.historyIndex);
  history.push({ sheetId, spriteName, before, after: { png: pngBytes, mode: details.mode || "exact", updatedAt: Date.now() } });
  document.history = history; document.historyIndex = history.length;
  document.modifications[sheetId] ||= Object.create(null);
  document.modifications[sheetId][spriteName] = history.at(-1).after;
  document.updatedAt = Date.now();
  return document;
}
export function resetSprite(document, sheetId, spriteName) {
  const before = document.modifications?.[sheetId]?.[spriteName] || null;
  if (!before) return document;
  document.history = document.history.slice(0, document.historyIndex);
  document.history.push({ sheetId, spriteName, before, after: null }); document.historyIndex = document.history.length;
  delete document.modifications[sheetId][spriteName];
  document.updatedAt = Date.now(); return document;
}
export function resetAllSprites(document) {
  const current = Object.entries(document.modifications || {}).flatMap(([sheetId, sprites]) => Object.entries(sprites).map(([spriteName, value]) => ({ sheetId, spriteName, value })));
  if (!current.length) return document;
  document.history = document.history.slice(0, document.historyIndex);
  for (const { sheetId, spriteName, value } of current) document.history.push({ sheetId, spriteName, before: value, after: null });
  document.historyIndex = document.history.length; document.modifications = {}; document.updatedAt = Date.now(); return document;
}
export function undoTexture(document) {
  if (document.historyIndex <= 0) return document;
  const item = document.history[--document.historyIndex]; document.modifications[item.sheetId] ||= Object.create(null);
  if (item.before) document.modifications[item.sheetId][item.spriteName] = item.before; else delete document.modifications[item.sheetId][item.spriteName];
  document.updatedAt = Date.now(); return document;
}
export function redoTexture(document) {
  if (document.historyIndex >= document.history.length) return document;
  const item = document.history[document.historyIndex++]; document.modifications[item.sheetId] ||= Object.create(null);
  if (item.after) document.modifications[item.sheetId][item.spriteName] = item.after; else delete document.modifications[item.sheetId][item.spriteName];
  document.updatedAt = Date.now(); return document;
}
