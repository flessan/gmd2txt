const object = value => value && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 4000) => typeof value === "string" ? value.slice(0, max) : "";

/** Ignore malformed preferences instead of allowing stale UI data to break startup. */
export function normalizeViewPreference(value) {
  if (!object(value)) return {};
  const result = {};
  if (["grid", "list"].includes(value.view)) result.view = value.view;
  if (["name", "date", "size", "count"].includes(value.sort)) result.sort = value.sort;
  if (typeof value.query === "string") result.query = text(value.query, 500);
  if (["all", "played", "new"].includes(value.filter)) result.filter = value.filter;
  if (object(value.filters)) {
    const f = value.filters, clean = {};
    if (typeof f.tags === "string") clean.tags = text(f.tags, 1000);
    if (typeof f.projectId === "string") clean.projectId = text(f.projectId, 200);
    if (typeof f.favorite === "boolean") clean.favorite = f.favorite;
    if (["all", "any"].includes(f.tagMode)) clean.tagMode = f.tagMode;
    for (const key of ["fromDate", "toDate"]) if (typeof f[key] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f[key])) clean[key] = f[key];
    for (const key of ["minSize", "maxSize", "minObjects", "maxObjects"]) if (f[key] === "" || (Number.isFinite(Number(f[key])) && Number(f[key]) >= 0)) clean[key] = String(f[key]);
    result.filters = clean;
  }
  return result;
}

export function resolveActiveProject(projects, activeId) {
  if (typeof activeId !== "string" || !activeId) return { project: null, activeId: null, stale: Boolean(activeId) };
  const project = Array.isArray(projects) ? projects.find(item => item?.id === activeId && !item.archivedAt) : null;
  return { project: project || null, activeId: project?.id || null, stale: !project };
}

export function normalizeRecentActivity(value, limit = 100) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => object(item) && typeof item.resourceId === "string" && typeof item.kind === "string")
    .slice(0, Math.max(0, Math.min(100, limit)))
    .map(item => ({ id: text(item.id, 120), at: Number.isFinite(item.at) ? item.at : 0, kind: text(item.kind, 32), resourceId: text(item.resourceId, 200), name: text(item.name, 180), action: text(item.action, 40) }));
}

export function normalizeSavedSearches(value) {
  if (!Array.isArray(value)) return [];
  const scopes = new Set(["all", "library", "audio", "assets", "textures", "projects", "saves"]);
  const definition = input => {
    const source = input, clean = {};
    if (typeof source.query === "string") clean.query = text(source.query, 500);
    if (["all", "level", "audio", "texture", "project", "save"].includes(source.type)) clean.type = source.type;
    if (Array.isArray(source.tags)) clean.tags = source.tags.filter(tag => typeof tag === "string").slice(0, 100).map(tag => text(tag, 80));
    else if (typeof source.tags === "string") clean.tags = text(source.tags, 1000);
    for (const key of ["fromDate", "toDate"]) if (typeof source[key] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(source[key])) clean[key] = source[key];
    for (const key of ["minSize", "maxSize", "minObjects", "maxObjects"]) if (source[key] === "" || Number.isFinite(Number(source[key]))) clean[key] = String(source[key]);
    if (typeof source.projectId === "string") clean.projectId = text(source.projectId, 200);
    if (typeof source.favorite === "boolean") clean.favorite = source.favorite;
    if (["all", "any"].includes(source.tagMode)) clean.tagMode = source.tagMode;
    for (const key of ["from", "to", "minSize", "maxSize", "minObjects", "maxObjects"]) if (Number.isFinite(source[key])) clean[key] = source[key];
    for (const key of ["libraryFilter", "audioFilter", "assetFilter"]) if (["all", "played", "new"].includes(source[key])) clean[key] = source[key];
    return clean;
  };
  return value.filter(item => object(item) && typeof item.id === "string" && typeof item.name === "string" && scopes.has(item.scope) && object(item.definition))
    .slice(0, 500).map(item => ({ id: text(item.id, 200), name: text(item.name, 80), scope: item.scope, definition: definition(item.definition), createdAt: Number.isFinite(item.createdAt) ? item.createdAt : 0, updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0 }));
}
