const DEFAULT_DIFFICULTY = () => ({ demon: false, demonType: null, stars: 0, rating: 0 });

export function createLevelDocument({ id, metadata = {}, raw, parsed = null, source = {}, timestamps = {} }) {
  const now = Date.now();
  return {
    type: "level",
    id,
    metadata: {
      name: metadata.name || "Untitled level",
      author: metadata.author || "Unknown",
      description: metadata.description || "",
      levelId: metadata.levelId ?? null,
      difficulty: { ...DEFAULT_DIFFICULTY(), ...(metadata.difficulty || {}) },
      song: { type: "official", id: 0, name: "Unknown song", artist: "", fileId: null, ...(metadata.song || {}) }
    },
    content: { format: "gd-level-string", raw, parsed },
    progress: { normal: 0, practice: 0, attempts: 0 },
    source: { type: "gmd", filename: "", ...source },
    timestamps: { importedAt: now, updatedAt: now, lastPlayedAt: null, ...timestamps }
  };
}

export function parseLevelPayload(payload) {
  const settings = {};
  const objects = [];
  const parts = String(payload).split(";");
  const pairs = parts[0].split(",");
  for (let i = 0; i + 1 < pairs.length; i += 2) settings[pairs[i]] = pairs[i + 1];
  for (const objectString of parts.slice(1)) {
    if (!objectString) continue;
    const fields = objectString.split(",");
    const values = {};
    for (let i = 0; i + 1 < fields.length; i += 2) values[fields[i]] = fields[i + 1];
    const objectId = Number.parseInt(values["1"] || "0", 10);
    if (objectId) objects.push({ id: objectId, x: Number.parseFloat(values["2"] || "0"), y: Number.parseFloat(values["3"] || "0"), raw: values });
  }
  return { settings, objects };
}

export function decodeLevelPayload(raw, filename = "") {
  const text = String(raw).replace(/^\uFEFF/, "").trim();
  // The runtime's parser expects base64 (URL-safe is common) and pako inflate.
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(text) && text.length > 40) {
    try {
      const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
      const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      if (globalThis.pako?.ungzip) {
        const decoded = new TextDecoder().decode(globalThis.pako.ungzip(bytes));
        if (decoded.includes(";") || decoded.includes(",")) return decoded;
      }
      if (globalThis.pako?.inflate) {
        const decoded = new TextDecoder().decode(globalThis.pako.inflate(bytes));
        if (decoded.includes(";") || decoded.includes(",")) return decoded;
      }
    } catch (_) { /* Plain-text and non-compressed files are handled below. */ }
  }
  if (text.includes(";") || text.includes(",")) return text;
  throw new Error(`Could not decode ${filename || "this file"} as a Geometry Dash level string.`);
}

export function metadataFromParsed(parsed) {
  const s = parsed.settings || {};
  const name = s.k1 || s.name || "Untitled level";
  let description = s.k3 || s.description || "";
  try {
    if (description && /^[A-Za-z0-9+/_-]+={0,2}$/.test(description)) {
      const b64 = description.replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(b64 + "=".repeat((4 - b64.length % 4) % 4));
      description = new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
    }
  } catch (_) { /* Preserve undecodable metadata literally. */ }
  const levelIdValue = s.k2 || s.kID || "";
  const numericLevelId = Number.parseInt(levelIdValue, 10);
  const songId = Number.parseInt(s.k8 || s.k10 || "0", 10) || 0;
  return {
    name,
    author: s.author || "Unknown",
    description,
    levelId: Number.isFinite(numericLevelId) && numericLevelId > 0 ? numericLevelId : null,
    difficulty: { demon: false, demonType: null, stars: Number.parseInt(s.k18 || "0", 10) || 0, rating: 0 },
    song: { type: songId > 0 ? "custom" : "official", id: songId, name: songId > 0 ? `Song ${songId}` : "Official song", artist: "", fileId: songId > 0 ? String(songId) : null }
  };
}
