import { normalizeTags } from "../documents/tags.js";

export const AUDIO_ASSET_SCHEMA_VERSION = 2;
export const MAX_AUDIO_FILE_BYTES = 512 * 1024 * 1024;

const EXTENSION_MIME = Object.freeze({
  mp3: "audio/mpeg", ogg: "audio/ogg", opus: "audio/opus", wav: "audio/wav",
  m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", flac: "audio/flac", webm: "audio/webm"
});
const randomId = () => globalThis.crypto?.randomUUID?.() || `audio-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function audioExtension(filename) {
  const match = String(filename || "").match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : "";
}
export function isSupportedAudioFile(file) {
  return Boolean(file && (EXTENSION_MIME[audioExtension(file.name)] || String(file.type || "").toLowerCase().startsWith("audio/")));
}
export function inferAudioMime(file) {
  const declared = String(file?.type || "").trim().toLowerCase();
  return declared.startsWith("audio/") ? declared : EXTENSION_MIME[audioExtension(file?.name)] || "application/octet-stream";
}
export function createAudioAsset(file, metadata = {}) {
  if (!isSupportedAudioFile(file)) throw new Error("Choose an audio file such as MP3, OGG, WAV, M4A, AAC, FLAC, or WebM.");
  if (!Number.isFinite(file.size) || file.size <= 0) throw new Error("This audio file is empty or could not be read.");
  if (file.size > MAX_AUDIO_FILE_BYTES) throw new Error("Audio files larger than 512 MiB are not supported.");
  const filename = String(file.name || "audio").split(/[\\/]/).pop();
  return {
    schemaVersion: AUDIO_ASSET_SCHEMA_VERSION,
    id: metadata.id || randomId(),
    filename,
    displayName: String(metadata.displayName || filename.replace(/\.[^.]+$/, "") || "Untitled audio").slice(0, 180),
    mimeType: inferAudioMime(file),
    fileSize: file.size,
    contentHash: String(metadata.contentHash || ""),
    duration: Number.isFinite(metadata.duration) && metadata.duration > 0 ? metadata.duration : null,
    importedAt: Number.isFinite(metadata.importedAt) ? metadata.importedAt : Date.now(),
    source: "local-file",
    blob: file,
    gdSongId: metadata.gdSongId == null ? null : String(metadata.gdSongId).slice(0, 64),
    artist: String(metadata.artist || "").slice(0, 180),
    album: String(metadata.album || "").slice(0, 180),
    notes: String(metadata.notes || "").slice(0, 2000),
    tags: normalizeTags(metadata.tags),
    favorite: metadata.favorite === true
  };
}

export function updateAudioAssetMetadata(asset, patch = {}) {
  const allowed = ["displayName", "duration", "gdSongId", "artist", "album", "notes", "tags", "favorite", "contentHash"];
  const updated = { ...asset };
  for (const key of allowed) if (Object.hasOwn(patch, key)) updated[key] = patch[key];
  updated.displayName = String(updated.displayName || asset.filename).trim().slice(0, 180) || asset.filename;
  updated.duration = Number.isFinite(Number(updated.duration)) && Number(updated.duration) > 0 ? Number(updated.duration) : null;
  updated.gdSongId = updated.gdSongId == null || updated.gdSongId === "" ? null : String(updated.gdSongId).slice(0, 64);
  updated.artist = String(updated.artist || "").slice(0, 180);
  updated.album = String(updated.album || "").slice(0, 180);
  updated.notes = String(updated.notes || "").slice(0, 2000);
  updated.tags = normalizeTags(updated.tags);
  updated.favorite = updated.favorite === true;
  updated.contentHash = String(updated.contentHash || "").slice(0,180);
  updated.schemaVersion = AUDIO_ASSET_SCHEMA_VERSION;
  updated.updatedAt = Date.now();
  return updated;
}
