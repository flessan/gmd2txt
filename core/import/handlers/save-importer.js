import { createSaveDocument } from "../../documents/save-document.js";
import { importLevel } from "./level-importer.js";
import { decodeSaveFile } from "../../saves/save-decoder.js";

async function contentHash(bytes) {
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (const byte of new Uint8Array(bytes)) { a = Math.imul(a ^ byte, 16777619); b = Math.imul(b ^ (byte + 13), 2246822519); }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}

function getValue(object, key) { return object && !Array.isArray(object) ? object[key] : undefined; }
function decodeText(value) {
  const raw = String(value || "");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return raw;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64 + "=".repeat((4 - b64.length % 4) % 4));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
  } catch (_) { return raw; }
}
function localLevelRecords(tree) {
  const root = tree?.LLM_01 || tree?.LLM_02 || tree;
  const records = [];
  const seen = new Set();
  const visit = value => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (!Array.isArray(value) && typeof value.k4 === "string" && typeof value.k2 === "string") {
      records.push(value);
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
    else Object.values(value).forEach(visit);
  };
  visit(root);
  return records;
}

async function toLevelDocument(record, filename, index) {
  const name = String(record.k2 || `Local level ${index + 1}`);
  const level = await importLevel({ name: `${name}.txt`, text: async () => record.k4 });
  const encodedId = Number.parseInt(record.k1 || "", 10);
  const sourceLevelId = Number.isFinite(encodedId) && encodedId > 0 ? encodedId : level.metadata.levelId;
  if (sourceLevelId != null) level.metadata.levelId = sourceLevelId;
  level.metadata.name = name;
  if (record.k3) level.metadata.description = decodeText(record.k3);
  if (record.k5) level.metadata.author = String(record.k5);
  const customSongId = Number.parseInt(record.k45 || "0", 10) || 0;
  const officialSongIndex = Number.parseInt(record.k8 || "", 10);
  if (customSongId > 0) level.metadata.song = { type: "custom", id: customSongId, name: `Custom song ${customSongId}`, artist: "", fileId: String(customSongId) };
  else if (Number.isFinite(officialSongIndex) && officialSongIndex >= 0) level.metadata.song = { type: "official", id: officialSongIndex, name: `Official song ${officialSongIndex + 1}`, artist: "", fileId: null };
  const hash = level.source.contentHash;
  level.id = `level_${sourceLevelId == null ? "local" : sourceLevelId}_${hash}`;
  level.source = { ...level.source, type: "save", filename, originalLevelId: sourceLevelId ?? null };
  return level;
}

export async function importSave(files) {
  const list = Array.from(files || []);
  if (!list.length) throw new Error("Choose a Geometry Dash save file first.");
  const filePayloads = { gameManager: null, localLevels: null };
  const decoded = { gameManager: null, localLevels: null };
  const normalized = { gameManager: null, localLevels: [], localLevelErrors: [] };
  const filenames = [];
  const identityParts = [];
  let gameVersion = null;

  for (const file of list) {
    const result = await decodeSaveFile(file);
    const slot = result.saveType === "game-manager" ? "gameManager" : "localLevels";
    if (filePayloads[slot]) continue;
    const bytes = await file.arrayBuffer();
    const blob = file.slice ? file.slice(0, file.size, file.type || "application/octet-stream") : new Blob([bytes], { type: file.type || "application/octet-stream" });
    filePayloads[slot] = { filename: file.name || (slot === "gameManager" ? "CCGameManager.dat" : "CCLocalLevels.dat"), size: bytes.byteLength, mimeType: file.type || "application/octet-stream", original: blob };
    decoded[slot] = { xml: result.xml, tree: result.tree, encoding: result.encoding };
    filenames.push(file.name || "Geometry Dash save.dat");
    identityParts.push(`${slot}:${await contentHash(bytes)}`);
    gameVersion = result.gameVersion ?? gameVersion;
    if (slot === "gameManager") {
      normalized.gameManager = result.normalized;
    } else {
      const records = localLevelRecords(result.tree);
      for (let index = 0; index < records.length; index++) {
        const record = records[index];
        try {
          const document = await toLevelDocument(record, file.name || "CCLocalLevels.dat", index);
          normalized.localLevels.push({ id: document.id, name: document.metadata.name, levelId: document.metadata.levelId, document });
        } catch (_) {
          // Keep the save snapshot usable even if one embedded level is corrupt/unsupported.
          normalized.localLevelErrors.push(`Local level ${index + 1} could not be decoded.`);
        }
      }
    }
  }

  if (!filePayloads.gameManager && !filePayloads.localLevels) throw new Error("No valid Geometry Dash save data was found.");
  const idHash = await contentHash(new TextEncoder().encode(identityParts.sort().join("|")).buffer);
  return createSaveDocument({
    id: `save_${idHash}`,
    files: filePayloads,
    decoded,
    normalized,
    metadata: { platform: "unknown", gameVersion, importedAt: Date.now() },
    source: { filenames }
  });
}
