const decodedFileCache = new WeakMap();
const SENSITIVE_KEY = /(?:password|passwd|passcode|gjp\d*|udid|email|account|token|secret|playeruserid)/i;

export class SaveDecodeError extends Error {
  constructor(reason = "invalid XML payload") {
    super(`Unable to decode save file: ${reason}. The file may be corrupted, from an unsupported version, or not a Geometry Dash save. No data was uploaded.`);
    this.name = "SaveDecodeError";
    this.reason = reason;
  }
}

function xmlUnescape(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity) => {
    const lower = entity.toLowerCase();
    const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (entities[lower]) return entities[lower];
    const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    try { return String.fromCodePoint(code); } catch (_) { return "�"; }
  });
}

function tokenizeXml(xml) {
  const tokens = [];
  const pattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/?[\w:.-]+(?:\s[^<>]*?)?\s*\/?>|[^<]+/gi;
  for (const match of xml.matchAll(pattern)) {
    const token = match[0];
    if (/^<!--|^<\?/.test(token) || /^<!DOCTYPE/i.test(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

export function parseSaveXml(xml) {
  if (typeof xml !== "string" || !/<(?:plist|dict|d)\b/i.test(xml)) throw new SaveDecodeError("invalid XML payload");
  const tokens = tokenizeXml(xml);
  let cursor = 0;
  const skipWhitespace = () => { while (cursor < tokens.length && !tokens[cursor].startsWith("<") && !tokens[cursor].trim()) cursor++; };
  const tagInfo = token => {
    const match = token.match(/^<\s*(\/)?\s*([\w:.-]+)/);
    return match ? { close: !!match[1], name: match[2].toLowerCase(), selfClosing: /\/\s*>$/.test(token) } : null;
  };
  const consumeText = tagName => {
    const chunks = [];
    while (cursor < tokens.length) {
      const info = tagInfo(tokens[cursor]);
      if (info?.close && info.name === tagName) { cursor++; break; }
      if (!info) chunks.push(tokens[cursor++]);
      else if (info.close) throw new SaveDecodeError("invalid XML payload");
      else throw new SaveDecodeError("unsupported XML structure");
    }
    return xmlUnescape(chunks.join("").trim());
  };
  const parseNode = () => {
    skipWhitespace();
    const open = tokens[cursor++];
    const info = tagInfo(open);
    if (!info || info.close) throw new SaveDecodeError("invalid XML payload");
    const { name, selfClosing } = info;
    if (selfClosing) return name === "t" || name === "true" ? true : name === "f" || name === "false" ? false : null;
    if (["plist", "root"].includes(name)) {
      const value = parseNode();
      while (cursor < tokens.length && !tagInfo(tokens[cursor])?.close) cursor++;
      if (cursor < tokens.length) cursor++;
      return value;
    }
    if (["dict", "d"].includes(name)) {
      const result = {};
      while (cursor < tokens.length) {
        skipWhitespace();
        const next = tagInfo(tokens[cursor]);
        if (!next) { cursor++; continue; }
        if (next.close) { if (next.name !== name) throw new SaveDecodeError("invalid XML payload"); cursor++; break; }
        const key = parseNode();
        if (typeof key !== "string" || cursor >= tokens.length) throw new SaveDecodeError("invalid XML dictionary");
        result[key] = parseNode();
      }
      return result;
    }
    if (["array", "a"].includes(name)) {
      const result = [];
      while (cursor < tokens.length) {
        skipWhitespace();
        const next = tagInfo(tokens[cursor]);
        if (next?.close) { if (next.name !== name) throw new SaveDecodeError("invalid XML payload"); cursor++; break; }
        if (next) result.push(parseNode()); else cursor++;
      }
      return result;
    }
    if (["true", "false"].includes(name)) { consumeText(name); return name === "true"; }
    const text = consumeText(name);
    if (["integer", "i"].includes(name)) return /^[-+]?\d+$/.test(text) ? Number(text) : text;
    if (["real", "r"].includes(name)) return Number.isFinite(Number(text)) ? Number(text) : text;
    if (["key", "k", "string", "s", "data", "date"].includes(name)) return text;
    return { $tag: name, text };
  };

  try {
    skipWhitespace();
    if (!tokens.length) throw new SaveDecodeError("invalid XML payload");
    const tree = parseNode();
    if (!tree || typeof tree !== "object") throw new SaveDecodeError("invalid XML payload");
    return tree;
  } catch (error) {
    if (error instanceof SaveDecodeError) throw error;
    throw new SaveDecodeError("invalid XML payload");
  }
}

function utf8(bytes, fatal = true) {
  try { return new TextDecoder("utf-8", { fatal }).decode(bytes); } catch (_) { return null; }
}
function isXmlText(text) { return typeof text === "string" && /<(?:\?xml|plist|dict|d)\b/i.test(text) && /<\/(?:plist|dict|d)>/i.test(text); }
function cleanEncodedText(value) {
  return String(value ?? "").replace(/^\uFEFF/, "").replace(/[\u0000-\u001f]+$/g, "").trim();
}
function base64Bytes(value) {
  const normalized = cleanEncodedText(value).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) return null;
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch (_) { return null; }
}

async function nativeInflate(bytes, format) {
  if (typeof DecompressionStream !== "function") return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (_) { return null; }
}

async function inflateCandidates(bytes) {
  const attempts = [];
  const pako = globalThis.pako;
  if (pako?.ungzip) attempts.push(() => pako.ungzip(bytes));
  if (pako?.inflate) attempts.push(() => pako.inflate(bytes));
  if (pako?.inflateRaw && bytes.length > 18 && bytes[0] === 0x1f && bytes[1] === 0x8b) attempts.push(() => pako.inflateRaw(bytes.subarray(10, bytes.length - 8)));
  attempts.push(() => nativeInflate(bytes, "gzip"));
  attempts.push(() => nativeInflate(bytes, "deflate"));
  attempts.push(() => nativeInflate(bytes, "deflate-raw"));
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result) return result instanceof Uint8Array ? result : new Uint8Array(result);
    } catch (_) { /* Try the next supported save encoding. */ }
  }
  return null;
}

function xorBytes(bytes, key = 11) { return bytes.map(byte => byte ^ key); }

async function decodeSaveBytes(bytes) {
  const direct = utf8(bytes);
  const deXored = utf8(xorBytes(bytes));
  for (const candidateText of [direct, deXored]) {
    if (isXmlText(candidateText)) return { xml: candidateText.replace(/^\uFEFF/, ""), encoding: candidateText === direct ? "plain-xml" : "xor-xml" };
    if (!candidateText) continue;
    const packed = base64Bytes(candidateText);
    if (!packed) continue;
    const decompressed = await inflateCandidates(packed);
    const xml = decompressed && utf8(decompressed);
    if (isXmlText(xml)) return { xml: xml.replace(/^\uFEFF/, ""), encoding: candidateText === direct ? "base64-compressed" : "xor-base64-compressed" };
  }
  // Some platforms store the compressed stream directly rather than base64 text.
  for (const candidate of [bytes, xorBytes(bytes)]) {
    const decompressed = await inflateCandidates(candidate);
    const xml = decompressed && utf8(decompressed);
    if (isXmlText(xml)) return { xml: xml.replace(/^\uFEFF/, ""), encoding: candidate === bytes ? "compressed" : "xor-compressed" };
  }
  throw new SaveDecodeError("unsupported encoding or invalid XML payload");
}

function walkKeys(value, visitor, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) { value.forEach(item => walkKeys(item, visitor, seen)); return; }
  for (const [key, child] of Object.entries(value)) { visitor(key, child); walkKeys(child, visitor, seen); }
}

function inferSaveType(tree, filename = "") {
  const keys = new Set();
  walkKeys(tree, key => keys.add(String(key).toLowerCase()));
  const manager = ["playername", "playerudid", "binaryversion", "glm_01", "gs_value", "gs_completed"].some(key => keys.has(key));
  const local = keys.has("llm_01") || keys.has("llm_02");
  const name = String(filename).split(/[\\/]/).pop().toLowerCase();
  if (manager && !local) return "game-manager";
  if (local && !manager) return "local-levels";
  if (manager && local) {
    if (name === "cclocallevels.dat") return "local-levels";
    if (name === "ccgamemanager.dat") return "game-manager";
  }
  if (name === "ccgamemanager.dat" && manager) return "game-manager";
  if (name === "cclocallevels.dat" && local) return "local-levels";
  return null;
}

const STAT_FIELDS = {
  Stars: ["stars", "starcount"], "Secret Coins": ["secretcoins", "secretcoin"],
  "User Coins": ["usercoins", "usercoin"], Diamonds: ["diamonds", "diamondcount"],
  Keys: ["demonkeys", "keys"], Attempts: ["attempts", "totalattempts"], Jumps: ["jumps", "totaljumps"],
  Orbs: ["orbs", "manaorbs"], Moons: ["moons", "mooncount"], Demons: ["demons", "completed demons"]
};

function findField(object, aliases) {
  let value;
  walkKeys(object, (key, child) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (value === undefined && aliases.some(alias => normalized === alias.replace(/[^a-z0-9]/g, "")) && (typeof child === "string" || typeof child === "number")) value = child;
  });
  return value;
}
function findNamedValue(object, names) {
  let found;
  walkKeys(object, (key, child) => { if (found === undefined && names.includes(String(key).toLowerCase())) found = child; });
  return found;
}

function dictionaryEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).filter(([key]) => key !== "_isArr");
}
function scalarNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
function normalizeOfficialLevels(tree) {
  const source = findNamedValue(tree, ["glm_01"]);
  if (!source || typeof source !== "object") return [];
  return dictionaryEntries(source).map(([key, value]) => {
    const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const id = scalarNumber(record.k1) ?? scalarNumber(key) ?? key;
    const fields = {};
    for (const field of ["k1","k2","k7","k8","k18","k19","k21","k25","k26","k36","k37","k50","k64","k71","k76","k85","k86","k87","k88","k89","k90"]) {
      if (record[field] !== undefined) fields[field] = record[field];
    }
    return { key, id, name: String(record.k2 || "Level " + id), raw: value, fields };
  });
}
function normalizeKeyedValues(value) {
  return dictionaryEntries(value).map(([key, raw]) => ({ key, value: raw }));
}
function nonEmptyGdGroups(tree, prefix) {
  return Object.entries(tree || {})
    .filter(([key]) => new RegExp("^" + prefix + "_[0-9]+$").test(key))
    .map(([key, value]) => ({ key, entries: dictionaryEntries(value), raw: value }))
    .filter(group => group.entries.length || (group.raw != null && typeof group.raw !== "object"));
}
export function normalizeSaveData(tree, saveType) {
  const result = {
    stats: {}, statValues: [], levels: [], localLevelRecords: [], quests: null, achievements: null,
    collections: [], player: {}, misc: {},
    summary: { topLevelKeys: 0, officialLevelRecords: 0, statValueEntries: 0, nonEmptyGameStateGroups: 0, nonEmptyLevelGroups: 0 }
  };
  if (saveType === "game-manager") {
    const playerName = findNamedValue(tree, ["playername"]);
    const playerUdid = findNamedValue(tree, ["playerudid"]);
    const binaryVersion = findNamedValue(tree, ["binaryversion"]);
    if (playerName !== undefined) result.player.name = playerName;
    if (playerUdid !== undefined) result.player.udid = playerUdid;
    if (binaryVersion !== undefined) result.binaryVersion = binaryVersion;
    for (const [label, aliases] of Object.entries(STAT_FIELDS)) {
      const value = findField(tree, aliases);
      if (value !== undefined) result.stats[label] = value;
    }
    result.statValues = normalizeKeyedValues(tree?.GS_value);
    result.levels = normalizeOfficialLevels(tree);
    result.quests = findNamedValue(tree, ["gs_12", "gs_15", "quests"]);
    result.achievements = findNamedValue(tree, ["reportedachievements", "gja_001", "achievements"]);
    result.collections = nonEmptyGdGroups(tree, "GS");
    result.summary = {
      topLevelKeys: Object.keys(tree || {}).length,
      officialLevelRecords: result.levels.length,
      statValueEntries: result.statValues.length,
      nonEmptyGameStateGroups: result.collections.length,
      nonEmptyLevelGroups: nonEmptyGdGroups(tree, "GLM").length
    };
    const known = new Set(["playername","playerudid","playeruserid","binaryversion","glm_01","gs_value","gs_completed","gs_10","gs_12","gs_15","reportedachievements","unlockvaluekeeper"]);
    result.misc = Object.fromEntries(Object.entries(tree || {}).filter(([key]) => !known.has(String(key).toLowerCase())));
  }
  return result;
}

function extractGameVersion(xml) {
  const match = String(xml || "").match(/\bgjver=["']([^"']+)["']/i);
  return match?.[1] ?? null;
}
export async function decodeSaveFile(file) {
  if (file && typeof file === "object" && decodedFileCache.has(file)) return decodedFileCache.get(file);
  const task = (async () => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!bytes.length) throw new SaveDecodeError("empty file");
      const { xml, encoding } = await decodeSaveBytes(bytes);
      const tree = parseSaveXml(xml);
      const saveType = inferSaveType(tree, file.name);
      if (!saveType) throw new SaveDecodeError("unrecognized Geometry Dash save structure");
      const normalized = normalizeSaveData(tree, saveType);
      const gameVersion = extractGameVersion(xml);
      return {
        xml, tree, saveType, encoding, gameVersion,
        binaryVersion: normalized.binaryVersion ?? null,
        normalized,
        diagnostics: {
          inputBytes: bytes.length,
          xmlBytes: new TextEncoder().encode(xml).length,
          encoding,
          topLevelKeys: normalized.summary?.topLevelKeys ?? Object.keys(tree || {}).length
        }
      };
    } catch (error) {
      if (error instanceof SaveDecodeError) throw error;
      throw new SaveDecodeError("invalid XML payload");
    }
  })();
  if (file && typeof file === "object") decodedFileCache.set(file, task);
  return task;
}

export async function probeSaveFile(file) {
  return decodeSaveFile(file);
}

export function maskSensitiveFields(value, hide = true) {
  if (!hide) return value;
  if (Array.isArray(value)) return value.map(item => maskSensitiveFields(item, hide));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, child] of Object.entries(value)) output[key] = SENSITIVE_KEY.test(key) ? "[hidden]" : maskSensitiveFields(child, hide);
    return output;
  }
  return value;
}

function xmlEscape(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
function serializeNode(value, depth = 0) {
  const indent = "  ".repeat(depth);
  if (Array.isArray(value)) return `${indent}<array>\n${value.map(item => serializeNode(item, depth + 1)).join("\n")}\n${indent}</array>`;
  if (value && typeof value === "object") return `${indent}<dict>\n${Object.entries(value).map(([key, child]) => `${"  ".repeat(depth + 1)}<key>${xmlEscape(key)}</key>\n${serializeNode(child, depth + 1)}`).join("\n")}\n${indent}</dict>`;
  if (typeof value === "boolean") return `${indent}<${value ? "true" : "false"}/>`;
  if (typeof value === "number" && Number.isInteger(value)) return `${indent}<integer>${value}</integer>`;
  if (typeof value === "number") return `${indent}<real>${value}</real>`;
  return `${indent}<string>${xmlEscape(value ?? "")}</string>`;
}
export function serializeSaveXml(tree) { return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n${serializeNode(tree, 1)}\n</plist>`; }
