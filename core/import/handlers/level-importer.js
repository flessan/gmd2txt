import { createLevelDocument, decodeLevelPayload, metadataFromParsed, parseLevelPayload } from "../../documents/level-document.js";

function xmlUnescape(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39);|&#(?:x([\da-f]+)|(\d+));/gi, token => {
    const named = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" };
    if (named[token.toLowerCase()]) return named[token.toLowerCase()];
    const hex = token.match(/^&#x([\da-f]+);$/i);
    const dec = token.match(/^&#(\d+);$/);
    return String.fromCodePoint(parseInt(hex?.[1] || dec?.[1] || "0", hex ? 16 : 10));
  });
}

function decodeWrappedText(value) {
  const raw = String(value || "");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return raw;
  try {
    const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
  } catch (_) { return raw; }
}

function extractGmdPayload(text) {
  const values = {};
  const pairPattern = /<k>\s*([^<]+?)\s*<\/k>\s*<(s|i|r|t)>\s*([\s\S]*?)\s*<\/\2>/gi;
  for (const match of text.matchAll(pairPattern)) values[match[1]] = xmlUnescape(match[3].trim());
  const levelString = values.k4 || text.match(/<k>\s*k4\s*<\/k>\s*<s>([\s\S]*?)<\/s>/i)?.[1];
  if (!levelString) throw new Error("This .gmd file does not contain the expected k4 level string.");
  return { levelString: xmlUnescape(levelString.trim()), values };
}

/** Content hash shared with the converter so the same level dedupes across both tools. */
export async function sha256Text(value) {
  const bytes = new TextEncoder().encode(value);
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  // Deterministic 128-bit fallback for non-secure local contexts.
  const seeds = [2166136261, 2246822519, 3266489917, 668265263];
  const hashes = seeds.map(seed => seed >>> 0);
  for (const byte of bytes) {
    for (let i = 0; i < hashes.length; i++) hashes[i] = Math.imul(hashes[i] ^ (byte + i * 17), 16777619 + i * 2);
  }
  return hashes.map(hash => (hash >>> 0).toString(16).padStart(8, "0")).join("");
}

export async function importLevel(file) {
  if (!file || typeof file.text !== "function") throw new TypeError("A browser File is required.");
  const original = await file.text();
  const isGmd = /\.gmd$/i.test(file.name || "") || /<k>\s*k4\s*<\/k>/i.test(original);
  const gmd = isGmd ? extractGmdPayload(original) : null;
  const rawLevelString = gmd ? gmd.levelString : original.replace(/^\uFEFF/, "").trim();
  // Some real exported level text files are NUL-padded; discard only terminal padding so the runtime can decode them.
  const playableLevelString = rawLevelString.replace(/\0+$/, "");
  const decoded = decodeLevelPayload(playableLevelString, file.name);
  const parsed = parseLevelPayload(decoded);
  if (!Object.keys(parsed.settings).length && !parsed.objects.length) {
    throw new Error("This file did not contain recognizable Geometry Dash level data.");
  }
  const metadata = metadataFromParsed(parsed);
  if (metadata.name === "Untitled level") metadata.name = (file.name || "Untitled level").replace(/\.(gmd|txt)$/i, "") || "Untitled level";
  if (gmd) {
    metadata.name = gmd.values.k2 || gmd.values.k1 || metadata.name;
    metadata.description = decodeWrappedText(gmd.values.k3) || metadata.description;
    const wrappedId = Number.parseInt(gmd.values.k1 || "", 10);
    if (metadata.levelId == null && Number.isFinite(wrappedId) && wrappedId > 0) metadata.levelId = wrappedId;
    if (gmd.values.k5) metadata.author = gmd.values.k5;
    const customSongId = Number.parseInt(gmd.values.k45 || "0", 10) || 0;
    const officialSongIndex = Number.parseInt(gmd.values.k8 || "", 10);
    if (customSongId > 0) {
      metadata.song = { type: "custom", id: customSongId, name: `Custom song ${customSongId}`, artist: "", fileId: String(customSongId) };
    } else if (Number.isFinite(officialSongIndex) && officialSongIndex >= 0) {
      metadata.song = { type: "official", id: officialSongIndex, name: `Official song ${officialSongIndex + 1}`, artist: "", fileId: null };
    }
  }
  const hash = await sha256Text(playableLevelString.trim());
  const sourceLevelId = metadata.levelId == null ? "local" : String(metadata.levelId);
  const id = `level_${sourceLevelId}_${hash}`;
  return createLevelDocument({
    id,
    metadata,
    raw: playableLevelString,
    parsed,
    source: {
      type: /\.txt$/i.test(file.name) ? "txt" : "gmd",
      origin: "local-file",
      filename: file.name || "level.gmd",
      fileSize: Number.isFinite(file.size) ? file.size : null,
      mimeType: file.type || "",
      contentHash: hash,
      ...(gmd || playableLevelString !== rawLevelString ? { originalPayload: original } : {})
    }
  });
}
