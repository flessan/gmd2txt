import { normalizeTags } from "./tags.js";

export const LEVEL_APPLICATION_SCHEMA_VERSION = 2;

export function createLevelApplicationMetadata(input = {}) {
  const audioOverride = input.audioOverride?.source === "local" && input.audioOverride.assetId
    ? { source: "local", assetId: String(input.audioOverride.assetId) }
    : null;
  return {
    schemaVersion: LEVEL_APPLICATION_SCHEMA_VERSION,
    audioOverride,
    textureWorkspaceId: input.textureWorkspaceId ? String(input.textureWorkspaceId) : null,
    tags: normalizeTags(input.tags),
    favorite: input.favorite === true,
    notes: String(input.notes || "").slice(0, 4000),
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : null
  };
}

export function mergeLevelApplicationMetadata(current, patch = {}) {
  const base = createLevelApplicationMetadata(current || {});
  const next = { ...base, ...patch };
  if (Object.hasOwn(patch, "audioOverride")) next.audioOverride = patch.audioOverride;
  if (Object.hasOwn(patch, "tags")) next.tags = patch.tags;
  next.updatedAt = Date.now();
  return createLevelApplicationMetadata(next);
}
