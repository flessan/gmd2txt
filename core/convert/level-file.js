/**
 * gmd2txt conversion core.
 *
 * This module is the single place that knows how Geometry Dash level files work:
 *
 *   .gmd  → an XML plist wrapper that carries a level's data (key `k4`) plus
 *           human metadata such as name, creator and song.
 *   .txt  → the level payload itself: usually a gzip-compressed, base64 level
 *           string (it starts with `H4sI`), but plain readable level strings
 *           are accepted too.
 *
 * Everything here is pure and browser/Node agnostic: pass text in, get text
 * out. No DOM, no network, no storage. The UI layer only formats and downloads.
 *
 * Reading is deliberately tolerant (BOMs, NUL padding, URL-safe base64, XML
 * entities, standard plist keys) because real-world exports differ. Writing is
 * deliberately conservative: a small, valid, well-formed wrapper that the
 * bundled importer and common Geometry Dash tooling both accept.
 */

import { createLevelDocument } from "../documents/level-document.js";
import { sha256Text } from "../import/handlers/level-importer.js";
import { KNOWN_PORTAL_NAMES, KNOWN_TRIGGER_NAMES } from "../inspector/level-inspector.js";

/** Files larger than this are not level files; refuse them instead of hanging the tab. */
export const LEVEL_FILE_LIMIT_BYTES = 64 * 1024 * 1024;

export const GMD_EXTENSION = ".gmd";
export const TEXT_EXTENSION = ".txt";

const XML_ENTITIES = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" });
const GMD_PAIR_PATTERN = /<k>\s*([^<]+?)\s*<\/k>\s*<(s|i|r|t)>([\s\S]*?)<\/\2>/gi;
const PLIST_PAIR_PATTERN = /<key>\s*([^<]+?)\s*<\/key>\s*<(string|integer|real)>([\s\S]*?)<\/\2>/gi;
const BASE64_PATTERN = /^[A-Za-z0-9+/=_-]+$/;
const START_POSITION_IDS = new Set([31, 34]);
const GAME_MODE_PORTALS = Object.freeze({
  12: "Cube", 13: "Ship", 47: "Ball", 111: "UFO", 660: "Wave", 745: "Robot", 1331: "Spider",
  101: "Mini", 99: "Big", 286: "Dual", 287: "Single"
});

/* ------------------------------------------------------------------ *
 * Small text helpers
 * ------------------------------------------------------------------ */

export function unescapeXmlEntities(value) {
  return String(value ?? "").replace(/&(?:#x[0-9a-f]+|#\d+|[a-z]+);/gi, token => {
    const named = XML_ENTITIES[token.slice(1, -1).toLowerCase()];
    if (named) return named;
    const hex = token.match(/^&#x([0-9a-f]+);$/i);
    if (hex) return safeCodePoint(parseInt(hex[1], 16));
    const decimal = token.match(/^&#(\d+);$/);
    if (decimal) return safeCodePoint(parseInt(decimal[1], 10));
    return token;
  });
}

function safeCodePoint(code) {
  try { return String.fromCodePoint(code); } catch (_) { return ""; }
}

function escapeXmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Removes a byte-order mark and the terminal NUL padding found in some real exports. */
export function stripFileDecorations(text) {
  return String(text ?? "").replace(/^\uFEFF/, "").replace(/\0+$/, "");
}

export function extensionOf(filename) {
  const match = String(filename ?? "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? `.${match[1]}` : "";
}

export function baseNameOf(filename) {
  return String(filename ?? "").replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]+$/i, "");
}

/** Turns any level name into a safe file name (Windows/macOS/Linux friendly). */
export function sanitizeFileName(value, fallback = "level") {
  const cleaned = String(value ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

/** Adds " (2)", " (3)"… until the name is unused, so batches never overwrite each other. */
export function uniqueFileName(name, used = new Set()) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let candidate = name, index = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${stem} (${index++})${extension}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function looksLikeBase64(text, minLength = 40) {
  return text.length >= minLength && BASE64_PATTERN.test(text);
}

/* ------------------------------------------------------------------ *
 * Compression: level strings are gzip data encoded as base64
 * ------------------------------------------------------------------ */

export function base64ToBytes(value) {
  const normalized = String(value ?? "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

const MAX_EXPANDED_BYTES = LEVEL_FILE_LIMIT_BYTES * 8;

/**
 * Runs bytes through the platform compression streams without ever leaving an
 * unhandled rejection behind: a damaged payload must fail quietly so callers can
 * report a friendly message.
 */
async function transformBytes(bytes, format, kind) {
  const transform = new (kind === "compress" ? CompressionStream : DecompressionStream)(format);
  const reader = transform.readable.getReader();
  const writer = transform.writable.getWriter();
  const pump = writer.write(bytes).then(() => writer.close()).catch(() => {});
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) { chunks.push(value); total += value.length; }
      if (total > MAX_EXPANDED_BYTES) throw new Error("This level expands beyond the supported size.");
    }
  } catch (error) {
    try { await writer.abort(); } catch (_) { /* already closed */ }
    await pump;
    throw error;
  }
  await pump;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  return merged;
}

function isGzipBytes(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function isZlibBytes(bytes) {
  return bytes.length > 2 && (bytes[0] & 0x0f) === 8 && ((bytes[0] << 8) + bytes[1]) % 31 === 0;
}

async function inflateBytes(bytes) {
  if (typeof DecompressionStream === "function") {
    // Only attempt the container the bytes actually claim to be, so damaged
    // input fails once instead of spawning several doomed streams.
    const formats = isGzipBytes(bytes) ? ["gzip"] : isZlibBytes(bytes) ? ["deflate"] : ["deflate-raw"];
    for (const format of formats) {
      try { return await transformBytes(bytes, format, "decompress"); } catch (_) { /* fall through */ }
    }
  }
  const pako = globalThis.pako;
  if (typeof pako?.ungzip === "function" && isGzipBytes(bytes)) return pako.ungzip(bytes);
  if (typeof pako?.inflate === "function") return pako.inflate(bytes);
  throw new Error("This browser cannot decompress Geometry Dash level strings.");
}

/**
 * Decodes a compressed level string. Returns null when the text is not
 * compressed data (which is normal for a readable level string).
 */
export async function decodeCompressedLevelString(levelString) {
  const text = String(levelString ?? "").trim();
  if (!looksLikeBase64(text)) return null;
  try {
    const bytes = await inflateBytes(base64ToBytes(text));
    const decoded = new TextDecoder("utf-8").decode(bytes);
    return decoded.includes(";") || decoded.includes(",") ? decoded : null;
  } catch (_) {
    return null;
  }
}

/** Compresses readable level text into the gzip+base64 form Geometry Dash expects. */
export async function encodeCompressedLevelString(readableText) {
  const bytes = new TextEncoder().encode(String(readableText ?? ""));
  let compressed;
  if (typeof CompressionStream === "function") {
    compressed = await transformBytes(bytes, "gzip", "compress");
  } else if (typeof globalThis.pako?.gzip === "function") {
    compressed = globalThis.pako.gzip(bytes);
  } else {
    throw new Error("This browser cannot compress level text; the level string was kept as plain text.");
  }
  return bytesToBase64(compressed);
}

/* ------------------------------------------------------------------ *
 * .gmd wrapper: read and write
 * ------------------------------------------------------------------ */

export function looksLikeGmd(text) {
  return /<k>\s*k4\s*<\/k>/i.test(text) || /<key>\s*k4\s*<\/key>/i.test(text) || /<plist[\s>]/i.test(text);
}

/** Reads every `<k>key</k><tag>value</tag>` (and standard plist) pair in an export. */
export function readGmdFields(text) {
  const fields = new Map();
  const source = String(text ?? "");
  for (const match of source.matchAll(GMD_PAIR_PATTERN)) {
    fields.set(match[1], { tag: match[2].toLowerCase(), value: unescapeXmlEntities(match[3]) });
  }
  for (const match of source.matchAll(PLIST_PAIR_PATTERN)) {
    if (!fields.has(match[1])) fields.set(match[1], { tag: match[2].toLowerCase(), value: unescapeXmlEntities(match[3]) });
  }
  return fields;
}

function decodeWrappedText(value) {
  const raw = String(value ?? "").trim();
  if (!raw || !looksLikeBase64(raw, 4)) return raw;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(base64ToBytes(raw));
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded) ? raw : decoded;
  } catch (_) {
    return raw;
  }
}

function integerField(fields, key) {
  const raw = fields.get(key)?.value;
  const value = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(value) ? value : null;
}

/** Pulls the level payload and the human metadata out of a `.gmd` document. */
export function extractGmdLevelString(text) {
  const fields = readGmdFields(text);
  const levelString = fields.get("k4")?.value;
  if (typeof levelString !== "string" || !levelString.trim()) return null;
  return { levelString: unescapeXmlEntities(levelString).trim(), fields };
}

/** Metadata carried by the `.gmd` wrapper (as opposed to inside the level data). */
export function gmdFieldsToLevelFields(fields) {
  const songId = integerField(fields, "k45");
  const official = integerField(fields, "k8");
  return {
    name: fields.get("k2")?.value?.trim() || "",
    author: fields.get("k5")?.value?.trim() || "",
    description: decodeWrappedText(fields.get("k3")?.value).trim(),
    levelId: integerField(fields, "k1"),
    customSongId: songId !== null && songId > 0 ? songId : null,
    officialSongIndex: official !== null && official >= 0 ? official : null
  };
}

/**
 * Writes a `.gmd` document. Keys mirror the exports produced by common Geometry
 * Dash tools (kCEK/k2/k3/k4/k5/k13/k16/k21 plus song keys), so the result can be
 * imported by the same tools that produced the files this app reads.
 */
export function buildGmdText({ levelString, name = "", author = "", description = "", levelId = null, customSongId = null, officialSongIndex = null }) {
  const rows = ['<?xml version="1.0"?>', '<plist version="1.0" gjver="2.0">', "\t<dict>"];
  const addText = (key, value) => { if (value !== null && value !== undefined && String(value).length) rows.push(`\t\t<k>${key}</k><s>${escapeXmlText(value)}</s>`); };
  const addInt = (key, value) => { if (Number.isFinite(Number(value)) && Number(value) !== 0) rows.push(`\t\t<k>${key}</k><i>${Math.trunc(Number(value))}</i>`); };

  rows.push("\t\t<k>kCEK</k><i>4</i>");
  addInt("k1", levelId);
  addText("k2", name);
  addText("k3", description ? bytesToBase64(new TextEncoder().encode(String(description))) : "");
  addText("k4", levelString);
  addText("k5", author);
  rows.push("\t\t<k>k13</k><t />");
  rows.push("\t\t<k>k16</k><i>1</i>");
  rows.push("\t\t<k>k21</k><i>2</i>");
  if (Number.isFinite(Number(customSongId)) && Number(customSongId) > 0) addInt("k45", customSongId);
  else if (Number.isFinite(Number(officialSongIndex)) && Number(officialSongIndex) > 0) addInt("k8", officialSongIndex);
  rows.push("\t</dict>", "</plist>", "");
  return rows.join("\n");
}

/* ------------------------------------------------------------------ *
 * Level data: header, objects, human summary
 * ------------------------------------------------------------------ */

/** Parses the `k1,value,k2,value…` header that precedes the first object. */
export function parseLevelHeader(readableText) {
  const settings = {};
  const header = String(readableText ?? "").split(";")[0] || "";
  const pairs = header.split(",");
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const key = pairs[i].trim();
    if (key) settings[key] = pairs[i + 1];
  }
  return settings;
}

function numericSetting(settings, ...keys) {
  for (const key of keys) {
    if (settings[key] === undefined) continue;
    const value = Number.parseInt(String(settings[key]).trim(), 10);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Walks the level once and reports what is inside it. This is intentionally
 * cheaper than a full object parse: it reads the object id and stops, so even a
 * 10 MB level string stays responsive.
 */
export function scanLevelObjects(readableText) {
  const parts = String(readableText ?? "").split(";");
  const countByType = new Map();
  const startPositions = [];
  const gameModes = new Set();
  let objectCount = 0;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const comma = part.indexOf(",");
    if (comma < 0 || part.slice(0, comma) !== "1") continue;
    const next = part.indexOf(",", comma + 1);
    const id = Number(next < 0 ? part.slice(comma + 1) : part.slice(comma + 1, next));
    if (!Number.isFinite(id) || id <= 0) continue;
    objectCount++;
    countByType.set(id, (countByType.get(id) || 0) + 1);
    if (GAME_MODE_PORTALS[id]) gameModes.add(GAME_MODE_PORTALS[id]);
    if (START_POSITION_IDS.has(id) && startPositions.length < 8) {
      const fields = part.split(",");
      startPositions.push({ x: Number(fields[3] ?? 0), y: Number(fields[5] ?? 0) });
    }
  }

  let triggerCount = 0, portalCount = 0;
  for (const [id, count] of countByType) {
    if (KNOWN_TRIGGER_NAMES[id] && !START_POSITION_IDS.has(id)) triggerCount += count;
    if (KNOWN_PORTAL_NAMES[id]) portalCount += count;
  }

  const topObjectTypes = [...countByType]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 8)
    .map(([id, count]) => ({ id, count }));

  return {
    objectCount,
    uniqueObjectTypes: countByType.size,
    topObjectTypes,
    triggerCount,
    portalCount,
    gameModes: [...gameModes],
    startPositions,
    hasStartPosition: startPositions.length > 0
  };
}

const OFFICIAL_SONG_FALLBACK = index => `Official song #${Number(index) + 1}`;

/** Reads the song fields in both the wrapper and the level header. */
export function resolveSong(fields = {}, settings = {}, officialSongs = null) {
  const customSongId = fields.customSongId ?? numericSetting(settings, "k45", "k10");
  if (Number.isFinite(customSongId) && customSongId > 0) {
    return { type: "custom", id: customSongId, name: `Custom song #${customSongId}`, artist: "" };
  }
  const index = fields.officialSongIndex ?? numericSetting(settings, "k8");
  if (Number.isFinite(index) && index >= 0) {
    const entry = Array.isArray(officialSongs) ? officialSongs[index] : null;
    if (Array.isArray(entry) && entry[1]) {
      return { type: "official", id: index, name: entry[1], artist: entry[3]?.[1] || "" };
    }
    return { type: "official", id: index, name: OFFICIAL_SONG_FALLBACK(index), artist: "" };
  }
  return { type: "unknown", id: null, name: "Not stated in the file", artist: "" };
}

export function songLabel(song, { detailed = false } = {}) {
  if (!song || song.type === "unknown") return "Song not stated in the file";
  if (song.type === "custom") return detailed && song.artist ? `${song.name} · ${song.artist}` : song.name;
  if (song.type === "official") return song.artist ? `${song.name} — ${song.artist}` : song.name;
  return song.name;
}

/* ------------------------------------------------------------------ *
 * Detection
 * ------------------------------------------------------------------ */

export function looksLikeLevelText(text) {
  const value = String(text ?? "");
  if (!value || value.includes("<plist")) return false;
  const firstComma = value.indexOf(",");
  if (firstComma < 0) return false;
  const header = value.slice(0, value.indexOf(";") < 0 ? value.length : value.indexOf(";"));
  const headerFields = header.match(/(?:^|,)[A-Za-z]{1,4}\d+,/g) || [];
  const hasObjects = /(?:^|;)1,\d+(?:,|;|$)/.test(value);
  return hasObjects && headerFields.length >= 2;
}

function isSaveFile(text, filename) {
  if (extensionOf(filename) === ".dat") return true;
  return /<k>(GS_|GJ_|GJA?_)</.test(text) || /<(?:plist|dict)[\s>][\s\S]*<k>GS_/.test(text);
}

/* ------------------------------------------------------------------ *
 * Conversion
 * ------------------------------------------------------------------ */

function failure(code, message, hint = "") {
  return { ok: false, code, message, hint };
}

function readableOrNull(value) {
  return typeof value === "string" && value.length ? value : null;
}

/**
 * Converts one level file's text in either direction.
 *
 * @returns {Promise<object>} either `{ ok:true, … }` with both the converted
 * output and a human-readable description of the level, or `{ ok:false, code,
 * message, hint }` with plain-language guidance for the person using the app.
 */
export async function convertLevelText({ text, filename = "", size = null, fieldsHint = {}, officialSongs = null } = {}) {
  const original = String(text ?? "");
  if (size !== null && Number(size) > LEVEL_FILE_LIMIT_BYTES) {
    return failure("too-large", "This file is too big to be a Geometry Dash level.", `Level files are normally well under 64 MB; this one is ${Math.round(Number(size) / (1024 * 1024))} MB.`);
  }
  if (original.length > LEVEL_FILE_LIMIT_BYTES) {
    return failure("too-large", "This file is too big to be a Geometry Dash level.", "Level files are normally well under 64 MB.");
  }

  const stripped = stripFileDecorations(original).trim();
  if (!stripped) return failure("empty", "This file is empty.", "Pick the .gmd or .txt level file you want to convert.");
  if (isSaveFile(stripped, filename)) {
    return failure("save-file", "This looks like a Geometry Dash save file, not a level file.", "Save files such as CCGameManager.dat are opened by the advanced workshop, not by the converter.");
  }

  const extension = extensionOf(filename);
  const warnings = [];
  let payload = stripped;
  let sourceKind = null;
  let wrapperFields = {};
  let headerReadable = null;

  if (looksLikeGmd(stripped) || extension === GMD_EXTENSION) {
    const extracted = extractGmdLevelString(stripped);
    if (!extracted) {
      return failure("no-level-string", "This .gmd file does not contain a level inside it.", "A .gmd file should include the level's k4 data. The file may be damaged or empty.");
    }
    payload = stripFileDecorations(extracted.levelString).trim();
    wrapperFields = gmdFieldsToLevelFields(extracted.fields);
    sourceKind = "gmd";
  } else if (looksLikeLevelText(stripped)) {
    sourceKind = "txt";
  } else if (looksLikeBase64(stripped)) {
    headerReadable = await decodeCompressedLevelString(stripped);
    if (!headerReadable) {
      return failure("corrupt", "That text looks like compressed level data, but it could not be unpacked.", "The file may be truncated or damaged, or it may not be a Geometry Dash level at all.");
    }
    sourceKind = "txt";
  } else {
    return failure("unknown", "We could not read this as a Geometry Dash level.", "Drop a .gmd export or a .txt level string. Save files such as CCGameManager.dat belong in the advanced workshop.");
  }

  let readable = headerReadable || readableOrNull(await decodeCompressedLevelString(payload));
  const compressed = Boolean(readable);
  if (!readable) readable = payload;

  if (sourceKind === "txt" && !looksLikeLevelText(readable)) {
    return failure("corrupt", "The level data in this file could not be understood.", "The payload decoded, but it does not contain a Geometry Dash level header or objects.");
  }

  const settings = parseLevelHeader(readable);
  const scan = scanLevelObjects(readable);
  if (scan.objectCount === 0) warnings.push("This level contains no objects — it may be an empty or unfinished level.");

  const settingsFields = {
    name: String(settings.k2 ?? "").trim(),
    author: String(settings.k5 ?? "").trim(),
    description: String(settings.k3 ?? "").trim(),
    levelId: numericSetting(settings, "k1"),
    customSongId: numericSetting(settings, "k45", "k10"),
    officialSongIndex: numericSetting(settings, "k8")
  };
  const fields = {
    name: fieldsHint.name || wrapperFields.name || settingsFields.name || "",
    author: fieldsHint.author || wrapperFields.author || settingsFields.author || "",
    description: fieldsHint.description || wrapperFields.description || settingsFields.description || "",
    levelId: fieldsHint.levelId ?? wrapperFields.levelId ?? settingsFields.levelId ?? null,
    customSongId: fieldsHint.customSongId ?? wrapperFields.customSongId ?? settingsFields.customSongId ?? null,
    officialSongIndex: fieldsHint.officialSongIndex ?? wrapperFields.officialSongIndex ?? settingsFields.officialSongIndex ?? null
  };
  const song = resolveSong(fields, settings, officialSongs);
  const fallbackName = baseNameOf(filename) || "Geometry Dash level";
  const displayName = fields.name || fallbackName;

  const name = sanitizeFileName(displayName, "level");
  const decodedText = readable !== payload ? readable : null;

  let output;
  if (sourceKind === "gmd") {
    output = { extension: TEXT_EXTENSION, filename: `${name}${TEXT_EXTENSION}`, text: payload, description: "level string (.txt)" };
  } else {
    if (!compressed) {
      try {
        payload = await encodeCompressedLevelString(payload);
      } catch (error) {
        warnings.push(error.message);
      }
    }
    output = { extension: GMD_EXTENSION, filename: `${name}${GMD_EXTENSION}`, text: buildGmdText({ levelString: payload, ...fields, name: displayName }), description: "level file (.gmd)" };
  }

  return {
    ok: true,
    sourceKind,
    targetKind: sourceKind === "gmd" ? "txt" : "gmd",
    displayName,
    levelString: payload,
    readableText: readable,
    decodedText,
    compressed,
    fields: { ...fields, name: displayName },
    metadata: {
      name: displayName,
      author: fields.author || "Unknown creator",
      description: fields.description,
      levelId: fields.levelId,
      difficulty: { demon: false, demonType: null, stars: 0, rating: 0 },
      song: { ...song, fileId: song.type === "custom" ? String(song.id) : null }
    },
    settings,
    scan,
    song,
    warnings,
    original,
    output
  };
}

/** The "decoded text" download, offered only when it differs from the level string. */
export function decodedFileName(conversion) {
  return `${sanitizeFileName(conversion.displayName, "level")} (readable).txt`;
}

/**
 * Builds the Library document for a converted level. The document keeps the
 * original file when it differs from the payload, and stores only a light
 * header + object count so the browser database stays small; the advanced
 * inspector re-parses the payload on demand.
 */
export async function buildLevelDocument(conversion, { filename = "", size = null, mimeType = "" } = {}) {
  const metadata = conversion.metadata;
  const playable = conversion.compressed ? conversion.levelString : conversion.levelString;
  const hash = await sha256Text(String(playable).trim());
  const sourceLevelId = metadata.levelId == null ? "local" : String(metadata.levelId);
  const original = String(conversion.original ?? "");
  const keepsOriginal = conversion.sourceKind === "gmd" || original.trim() !== String(playable).trim();
  return createLevelDocument({
    id: `level_${sourceLevelId}_${hash}`,
    metadata,
    raw: playable,
    parsed: { settings: conversion.settings, objectCount: conversion.scan.objectCount },
    source: {
      type: conversion.sourceKind === "gmd" ? "gmd" : "txt",
      origin: "local-file",
      filename: filename || `${sanitizeFileName(conversion.displayName, "level")}${conversion.sourceKind === "gmd" ? GMD_EXTENSION : TEXT_EXTENSION}`,
      fileSize: Number.isFinite(Number(size)) ? Number(size) : null,
      mimeType: mimeType || "",
      contentHash: hash,
      ...(keepsOriginal ? { originalPayload: original } : {})
    }
  });
}
