const KEY_TAGS = new Set(["key", "k"]);
const DICT_TAGS = new Set(["dict", "d"]);
const ARRAY_TAGS = new Set(["array", "a"]);
const STRING_TAGS = new Set(["string", "s", "data", "date"]);
const NUMBER_TAGS = new Set(["integer", "i", "real", "r"]);

function decodeXml(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    const names = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (names[key]) return names[key];
    const number = key.startsWith("#x") ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    try { return String.fromCodePoint(number); } catch (_) { return match; }
  });
}

function parseXmlTree(xml) {
  const root = { name: "#document", children: [], start: 0, end: xml.length };
  const stack = [root];
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[\w:.-]+(?:\s[^<>]*?)?\s*\/?>|[^<]+/gi;
  for (const match of xml.matchAll(tokens)) {
    const text = match[0], start = match.index;
    if (/^<!--|^<\?|^<!DOCTYPE/i.test(text)) continue;
    if (/^<!\[CDATA\[/i.test(text)) {
      const parent = stack.at(-1); parent.text += text.slice(9, -3); parent.textStart ??= start + 9; parent.textEnd = start + text.length - 3; continue;
    }
    if (!text.startsWith("<")) {
      const parent = stack.at(-1); parent.text += text; parent.textStart ??= start; parent.textEnd = start + text.length; continue;
    }
    const closeMatch = text.match(/^<\s*\/\s*([\w:.-]+)/);
    if (closeMatch) {
      const node = stack.pop();
      if (!node || node.name !== closeMatch[1].toLowerCase()) throw new Error("malformed PLIST XML");
      node.closeStart = start;
      node.end = start + text.length;
      continue;
    }
    const openMatch = text.match(/^<\s*([\w:.-]+)/);
    if (!openMatch) throw new Error("malformed PLIST XML");
    const selfClosing = /\/\s*>$/.test(text);
    const node = {
      name: openMatch[1].toLowerCase(),
      attributes: Object.fromEntries([...text.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)].map(attr => [attr[1], decodeXml(attr[3])])),
      children: [], text: "", start, openEnd: start + text.length, end: null
    };
    stack.at(-1).children.push(node);
    if (selfClosing) { node.closeStart = node.openEnd; node.end = node.openEnd; }
    else stack.push(node);
  }
  if (stack.length !== 1) throw new Error("malformed PLIST XML");
  return root.children.find(node => node.name === "plist") || root.children[0] || null;
}

function scalar(node) {
  const text = decodeXml(node.text || "").trim();
  if (STRING_TAGS.has(node.name) || KEY_TAGS.has(node.name)) return text;
  if (NUMBER_TAGS.has(node.name)) return Number.isFinite(Number(text)) ? Number(text) : text;
  if (node.name === "true" || node.name === "t") return true;
  if (node.name === "false" || node.name === "f") return false;
  return text;
}

function nodeToValue(node) {
  if (!node) return null;
  if (node.name === "plist") return nodeToValue(node.children[0]);
  if (DICT_TAGS.has(node.name)) {
    const output = Object.create(null);
    for (let index = 0; index < node.children.length;) {
      const keyNode = node.children[index++];
      if (!keyNode || !KEY_TAGS.has(keyNode.name)) continue;
      const valueNode = node.children[index++];
      if (!valueNode) break;
      output[decodeXml(keyNode.text || "").trim()] = nodeToValue(valueNode);
    }
    return output;
  }
  if (ARRAY_TAGS.has(node.name)) return node.children.map(nodeToValue);
  return scalar(node);
}

function dictionaryEntries(node) {
  const entries = new Map();
  if (!node || !DICT_TAGS.has(node.name)) return entries;
  for (let index = 0; index + 1 < node.children.length;) {
    const keyNode = node.children[index++], valueNode = node.children[index++];
    if (keyNode && KEY_TAGS.has(keyNode.name)) entries.set(decodeXml(keyNode.text || "").trim(), valueNode);
  }
  return entries;
}
function parseNumbers(text) { return (String(text || "").match(/[-+]?(?:\d+\.?\d*|\.\d+)/g) || []).map(Number); }
function parseRect(node) {
  const n = parseNumbers(node?.text || "");
  return n.length >= 4 ? { x: n[0], y: n[1], width: n[2], height: n[3] } : null;
}
function parsePoint(node) {
  const n = parseNumbers(node?.text || "");
  return n.length >= 2 ? { x: n[0], y: n[1] } : null;
}
function parseSize(node) {
  const n = parseNumbers(node?.text || "");
  return n.length >= 2 ? { width: n[0], height: n[1] } : null;
}

export function parsePlist(xml) {
  if (typeof xml !== "string" || !/<(?:plist|dict|d)\b/i.test(xml)) throw new Error("PLIST XML was not recognized.");
  let ast;
  try { ast = parseXmlTree(xml); } catch (_) { throw new Error("PLIST XML is malformed."); }
  const root = nodeToValue(ast);
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("PLIST does not contain a dictionary root.");
  const metadata = root.metadata || {};
  const rootDict = ast?.name === "plist" ? ast.children[0] : ast;
  const frameNode = dictionaryEntries(rootDict).get("frames");
  const frameEntries = dictionaryEntries(frameNode);
  const frames = Object.create(null);
  for (const [name, node] of frameEntries) {
    const fields = dictionaryEntries(node);
    const frameNode = fields.get("frame") || fields.get("textureRect");
    const rotatedNode = fields.get("rotated") || fields.get("textureRotated");
    const offsetNode = fields.get("offset") || fields.get("spriteOffset");
    const colorRectNode = fields.get("sourceColorRect") || fields.get("spriteColorRect");
    const sizeNode = fields.get("sourceSize") || fields.get("spriteSourceSize") || fields.get("spriteSize");
    const atlasRect = parseRect(frameNode);
    if (!atlasRect) continue;
    frames[name] = {
      name,
      frame: atlasRect,
      rotated: rotatedNode ? nodeToValue(rotatedNode) === true : false,
      offset: parsePoint(offsetNode) || { x: 0, y: 0 },
      sourceColorRect: parseRect(colorRectNode),
      sourceSize: parseSize(sizeNode) || { width: atlasRect.width, height: atlasRect.height },
      raw: nodeToValue(node),
      rawXml: xml.slice(node.start, node.end),
      _xml: {
        nodeStart: node.start,
        frame: frameNode ? { start: frameNode.start, end: frameNode.end, textStart: frameNode.textStart ?? frameNode.openEnd, textEnd: frameNode.textEnd ?? frameNode.closeStart, tag: frameNode.name } : null,
        rotated: rotatedNode ? { start: rotatedNode.start, end: rotatedNode.end, textStart: rotatedNode.textStart ?? rotatedNode.openEnd, textEnd: rotatedNode.textEnd ?? rotatedNode.closeStart, tag: rotatedNode.name } : null,
        sourceSize: sizeNode ? { start: sizeNode.start, end: sizeNode.end, textStart: sizeNode.textStart ?? sizeNode.openEnd, textEnd: sizeNode.textEnd ?? sizeNode.closeStart, tag: sizeNode.name } : null,
        sourceColorRect: colorRectNode ? { start: colorRectNode.start, end: colorRectNode.end, textStart: colorRectNode.textStart ?? colorRectNode.openEnd, textEnd: colorRectNode.textEnd ?? colorRectNode.closeStart, tag: colorRectNode.name } : null,
        offset: offsetNode ? { start: offsetNode.start, end: offsetNode.end, textStart: offsetNode.textStart ?? offsetNode.openEnd, textEnd: offsetNode.textEnd ?? offsetNode.closeStart, tag: offsetNode.name } : null
      }
    };
  }
  if (!Object.keys(frames).length && !frameNode) throw new Error("PLIST has no sprite frames dictionary.");
  return { format: "xml", raw: xml, metadata, frames, frameNames: Object.keys(frames), framesRegion: frameNode ? { openEnd: frameNode.openEnd, closeStart: frameNode.closeStart } : null, _source: { astName: ast.name, attributes: ast.attributes || {} } };
}
