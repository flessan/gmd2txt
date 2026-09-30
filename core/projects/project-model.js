import { normalizeTags } from "../documents/tags.js";

export const PROJECT_SCHEMA_VERSION = 2;
export const PROJECT_RESOURCE_TYPES = Object.freeze(["levels", "audioAssets", "textureWorkspaces", "saveSnapshots"]);
const LIMITS = Object.freeze({ name: 180, description: 4000, resourceIds: 100000 });
const id = () => `project_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;

function normalizeIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || "").trim()).filter(Boolean))].slice(0, LIMITS.resourceIds);
}

export function createProject(input = {}) {
  const now = Date.now();
  return normalizeProject({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: input.id || id(),
    name: input.name || "Untitled project",
    description: input.description || "",
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : now,
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : now,
    archivedAt: input.archivedAt ?? null,
    tags: input.tags || [], favorite: input.favorite === true,
    resources: input.resources || {},
    metadata: input.metadata || {}
  });
}

export function normalizeProject(input = {}) {
  const resources = input.resources || {};
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: String(input.id || id()),
    name: String(input.name || "Untitled project").trim().slice(0, LIMITS.name) || "Untitled project",
    description: String(input.description || "").slice(0, LIMITS.description),
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : Date.now(),
    archivedAt: Number.isFinite(input.archivedAt) ? input.archivedAt : null,
    tags: normalizeTags(input.tags), favorite: input.favorite === true,
    resources: Object.fromEntries(PROJECT_RESOURCE_TYPES.map(type => [type, normalizeIds(resources[type])])),
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {}
  };
}

export function updateProjectModel(project, patch = {}) {
  const normalized = normalizeProject({ ...project, ...patch, resources: { ...project.resources, ...(patch.resources || {}) }, metadata: { ...project.metadata, ...(patch.metadata || {}) }, updatedAt: Date.now() });
  return normalized;
}

export function setProjectResource(project, type, resourceId, included = true) {
  if (!PROJECT_RESOURCE_TYPES.includes(type)) throw new TypeError(`Unknown project resource type: ${type}`);
  const resources = { ...project.resources };
  const current = new Set(resources[type] || []);
  if (included) current.add(String(resourceId)); else current.delete(String(resourceId));
  return updateProjectModel(project, { resources: { ...resources, [type]: [...current] } });
}
