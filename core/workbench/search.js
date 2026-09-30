const norm = value => String(value ?? "").normalize("NFKD").toLocaleLowerCase();
const list = value => Array.isArray(value) ? value : value == null ? [] : [value];
export function filterResources(records, definition = {}) {
  const query = norm(definition.query).trim();
  const tags = list(definition.tags).map(norm).filter(Boolean);
  const type = definition.type || "all";
  const projectId = definition.projectId || "";
  const from = Number(definition.from) || 0, to = Number(definition.to) || Infinity;
  const minSize=Number(definition.minSize)||0,maxSize=Number(definition.maxSize)||Infinity,minDuration=Number(definition.minDuration)||0,maxDuration=Number(definition.maxDuration)||Infinity,minObjects=Number(definition.minObjects)||0,maxObjects=Number(definition.maxObjects)||Infinity;
  return records.filter(record => {
    if (type !== "all" && record.kind !== type) return false;
    if (projectId && !list(record.projectIds).includes(projectId)) return false;
    if (definition.favorite && !record.favorite) return false;
    const itemTags = list(record.tags).map(norm);
    if (definition.tagMode === "any" ? tags.length && !tags.some(tag => itemTags.includes(tag)) : !tags.every(tag => itemTags.includes(tag))) return false;
    if (Number(record.date || 0) < from || Number(record.date || 0) > to) return false;
    if(Number(record.size||0)<minSize||Number(record.size||0)>maxSize)return false;
    if(Number(record.duration||0)<minDuration||Number(record.duration||0)>maxDuration)return false;
    if(Number(record.objectCount||0)<minObjects||Number(record.objectCount||0)>maxObjects)return false;
    const haystack = norm([record.name, record.author, record.id, record.filename, record.format, record.song, record.projectNames, ...itemTags].flat().join(" "));
    return !query || query.split(/\s+/).every(term => haystack.includes(term));
  });
}
export function sortResources(records, field = "date", direction = "desc") {
  const sign = direction === "asc" ? 1 : -1;
  return [...records].sort((a, b) => {
    const left = a[field], right = b[field];
    if (typeof left === "number" || typeof right === "number") return ((Number(left) || 0) - (Number(right) || 0)) * sign;
    return String(left ?? "").localeCompare(String(right ?? ""), undefined, { sensitivity: "base", numeric: true }) * sign;
  });
}
export function createSavedSearch(input = {}) {
  const name = String(input.name || "Saved search").trim().slice(0, 80) || "Saved search";
  return { id: input.id || `search_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`, name, scope: input.scope || "all", definition: structuredClone(input.definition || {}), createdAt: input.createdAt || Date.now(), updatedAt: Date.now() };
}
