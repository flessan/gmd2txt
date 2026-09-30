import { decodeLevelPayload, parseLevelPayload } from "../documents/level-document.js";

// A conservative, partial ID-name mapping based on the public GDBrowser analysis list.
// Unknown IDs stay numeric; Geometry Dash versions and GDPS variants can diverge.
export const KNOWN_TRIGGER_NAMES = Object.freeze({
  29: "Color", 30: "Color", 31: "Start Position", 32: "Enable Trail", 33: "Disable Trail", 34: "Start Position 2",
  104: "Color", 105: "Color", 221: "Color", 717: "Color", 718: "Color", 743: "Color", 744: "Color",
  899: "Color", 900: "Color", 915: "Color", 901: "Move", 1006: "Pulse", 1007: "Alpha", 1049: "Toggle",
  1268: "Spawn", 1346: "Rotate", 1347: "Follow", 1520: "Shake", 1585: "Animate", 1595: "Touch",
  1611: "Count", 1612: "Hide Player", 1613: "Show Player", 1616: "Stop", 1811: "Instant Count",
  1812: "On Death", 1814: "Follow Player Y", 1815: "Collision", 1817: "Pickup", 1818: "Background Effect On",
  1819: "Background Effect Off", 22: "Transition", 23: "Transition", 24: "Transition", 25: "Transition",
  26: "Transition", 27: "Transition", 28: "Transition", 55: "Transition", 56: "Transition", 57: "Transition",
  58: "Transition", 59: "Transition", 1912: "Random", 1913: "Camera Zoom", 1914: "Camera Static",
  1916: "Camera Offset", 1917: "Reverse", 1931: "Level End"
});
export const KNOWN_PORTAL_NAMES = Object.freeze({
  12: "Cube", 13: "Ship", 47: "Ball", 111: "UFO", 660: "Wave", 745: "Robot", 1331: "Spider",
  45: "Mirror On", 46: "Mirror Off", 101: "Mini", 99: "Big", 286: "Dual", 287: "Single",
  200: "0.5× speed", 201: "1× speed", 202: "2× speed", 203: "3× speed", 1334: "4× speed"
});
const START_POSITION_IDS = new Set([31, 34]);
const cache = new Map();

function getParsed(document) {
  if (Array.isArray(document?.content?.parsed?.objects)) return document.content.parsed;
  const raw = document?.content?.raw;
  if (!raw) return { settings: {}, objects: [] };
  return parseLevelPayload(decodeLevelPayload(raw, document.source?.filename));
}
function frequency(rows, keyOf) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key == null || key === "") continue;
    counts.set(String(key), (counts.get(String(key)) || 0) + 1);
  }
  return [...counts].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

export function inspectLevelDocument(document) {
  const cacheKey = `${document?.id || "anonymous"}:${document?.source?.contentHash || ""}:${document?.content?.raw?.length || 0}`;
  if (cache.has(cacheKey)) { const cached = cache.get(cacheKey); cache.delete(cacheKey); cache.set(cacheKey, cached); return cached; }
  const parsed = getParsed(document), objects = parsed.objects || [];
  const objectFrequency = frequency(objects, object => object.id ?? object.raw?.["1"]);
  const triggerObjects = objects.filter(object => KNOWN_TRIGGER_NAMES[Number(object.id ?? object.raw?.["1"])] && !START_POSITION_IDS.has(Number(object.id ?? object.raw?.["1"])));
  const portalObjects = objects.filter(object => KNOWN_PORTAL_NAMES[Number(object.id ?? object.raw?.["1"])]);
  const triggerFrequency = frequency(triggerObjects, object => object.id ?? object.raw?.["1"]).map(item => ({ ...item, name: KNOWN_TRIGGER_NAMES[Number(item.id)] || item.id }));
  const portalFrequency = frequency(portalObjects, object => object.id ?? object.raw?.["1"]).map(item => ({ ...item, name: KNOWN_PORTAL_NAMES[Number(item.id)] || item.id }));
  const settings = parsed.settings || {};
  const startPosition = objects.filter(object => START_POSITION_IDS.has(Number(object.id ?? object.raw?.["1"]))).map(object => {
    const id = Number(object.id ?? object.raw?.["1"]);
    return { x: object.x, y: object.y, type: KNOWN_TRIGGER_NAMES[id] || "Start Position" };
  });
  const result = {
    objectCount: objects.length,
    uniqueObjectIds: objectFrequency.length,
    objectFrequency,
    recognizedTriggerCount: triggerObjects.length,
    triggerFrequency,
    portalCount: portalObjects.length,
    portalFrequency,
    startPosition,
    settings: Object.entries(settings).map(([key, value]) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true })),
    raw: document?.content?.raw || ""
  };
  cache.set(cacheKey, result);
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return result;
}

export function filterFrequency(rows, query = "") {
  const normalized = String(query).trim().toLowerCase();
  if (!normalized) return rows;
  return rows.filter(row => `${row.id} ${row.name || ""}`.toLowerCase().includes(normalized));
}
