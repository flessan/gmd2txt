import { parsePlist } from "./plist-parser.js";
import { patchPlist } from "./plist-writer.js";
import { decodePng, canvasToPngBytes } from "./sprites.js";
import { writeZipBlob } from "./zip.js";

export const RESOLUTION_TARGETS = Object.freeze({
  original: { id: "original", label: "Original", scale: 0.25, suffix: "", legacy: true },
  hd: { id: "hd", label: "HD", scale: 0.5, suffix: "-hd", legacy: true },
  uhd: { id: "uhd", label: "UHD", scale: 1, suffix: "-uhd", legacy: false }
});
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_ATLAS_PIXELS = 100_000_000;
const round = value => Math.round(Number(value) || 0);
const escapeXml = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function replacePlistKeyValue(xml, key, value) {
  const pattern = new RegExp("(<key>\\s*" + key + "\\s*</key>\\s*<(string|integer|real)>)([\\s\\S]*?)(</\\2>)");
  let changed = false;
  const output = xml.replace(pattern, (match, open, tag, previous, close) => {
    changed = true;
    return open + escapeXml(value) + close;
  });
  return { xml: output, changed };
}
function scaledRect(rect, sx, sy) {
  if (!rect) return null;
  const x = round(rect.x * sx), y = round(rect.y * sy);
  const right = round((rect.x + rect.width) * sx), bottom = round((rect.y + rect.height) * sy);
  return { x, y, width: Math.max(rect.width > 0 ? 1 : 0, right - x), height: Math.max(rect.height > 0 ? 1 : 0, bottom - y) };
}
function scaledSize(size, sx, sy) {
  if (!size) return null;
  return { width: Math.max(1, round(size.width * sx)), height: Math.max(1, round(size.height * sy)) };
}
function scaledPoint(point, sx, sy) {
  if (!point) return null;
  return { x: Number((point.x * sx).toFixed(4)), y: Number((point.y * sy).toFixed(4)) };
}
function parseSizeString(value) {
  const values = (String(value || "").match(/[-+]?(?:\d+\.?\d*|\.\d+)/g) || []).map(Number);
  return values.length >= 2 ? { width: values[0], height: values[1] } : null;
}
function remapLegacyFrameKeys(xml) {
  for (const [from, to] of [["frame","textureRect"],["rotated","textureRotated"],["offset","spriteOffset"],["sourceColorRect","spriteColorRect"],["sourceSize","spriteSize"]]) {
    xml = xml.replace(new RegExp("<key>\\s*" + from + "\\s*</key>", "g"), "<key>" + to + "</key>");
  }
  return xml;
}
function ensureLegacyAliases(xml) {
  const parsed = parsePlist(xml);
  const insertions = [];
  for (const frame of Object.values(parsed.frames || {})) {
    if (Array.isArray(frame.raw?.aliases)) continue;
    const start = frame._xml?.nodeStart;
    if (start == null) continue;
    const openEnd = xml.indexOf(">", start) + 1;
    if (openEnd > 0) insertions.push({ at: openEnd, text: "\n<key>aliases</key>\n<array/>" });
  }
  insertions.sort((a, b) => b.at - a.at);
  for (const edit of insertions) xml = xml.slice(0, edit.at) + edit.text + xml.slice(edit.at);
  return xml;
}
function validateFrames(parsed, width, height, label) {
  const problems = [];
  for (const frame of Object.values(parsed.frames || {})) {
    const rect = frame.frame;
    if (!rect || rect.x < 0 || rect.y < 0 || rect.x + rect.width > width + 1 || rect.y + rect.height > height + 1 || rect.width <= 0 || rect.height <= 0) problems.push(frame.name);
  }
  if (problems.length) {
    const sample = problems.slice(0, 4).join(", ");
    throw new Error(label + " has " + problems.length + " sprite frame(s) outside the " + width + "×" + height + " atlas (" + sample + (problems.length > 4 ? ", …" : "") + "). Check that the PNG and PLIST belong together.");
  }
}
export function normalizeAtlasStem(filename) {
  let stem = String(filename || "texture-atlas").replace(/\\/g, "/").split("/").pop().replace(/\.png$/i, "");
  stem = stem.replace(/(?:[-_ ](?:uhd|hd|sd|original|ori))$/i, "");
  stem = stem.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "");
  return stem || "texture-atlas";
}
export function convertPlistResolution(xml, options = {}) {
  const sx = Number(options.scaleX ?? options.scale ?? 1), sy = Number(options.scaleY ?? options.scale ?? sx);
  const width = Math.max(1, round(options.width || 1)), height = Math.max(1, round(options.height || 1));
  if (!(sx > 0 && sy > 0 && sx <= 1 && sy <= 1)) throw new Error("Resolution scale must be greater than zero and no larger than the source.");
  const parsed = parsePlist(xml);
  if (!Object.keys(parsed.frames || {}).length) throw new Error("The PLIST contains no readable sprite frames.");
  const changes = Object.create(null);
  for (const [name, frame] of Object.entries(parsed.frames)) changes[name] = {
    frame: scaledRect(frame.frame, sx, sy),
    offset: scaledPoint(frame.offset, sx, sy),
    sourceColorRect: scaledRect(frame.sourceColorRect, sx, sy),
    sourceSize: scaledSize(frame.sourceSize, sx, sy),
    rotated: frame.rotated
  };
  let output = patchPlist(parsed, changes);
  const warnings = [];
  const updatedSize = replacePlistKeyValue(output, "size", "{" + width + "," + height + "}");
  output = updatedSize.xml;
  if (parsed.metadata?.size == null || !updatedSize.changed) warnings.push("PLIST metadata has no editable size entry; the new atlas dimensions could not be recorded there.");
  for (const key of ["textureFileName", "realTextureFileName"]) output = replacePlistKeyValue(output, key, options.pngName || "").xml;
  if (options.legacyFormat) {
    output = remapLegacyFrameKeys(output);
    output = ensureLegacyAliases(output);
    const format = replacePlistKeyValue(output, "format", "3");
    output = format.xml;
    if (!format.changed) warnings.push("PLIST metadata has no format entry. Legacy sprite field names were generated, but the format marker could not be updated.");
  }
  const checked = parsePlist(output);
  if (Object.keys(checked.frames || {}).length !== Object.keys(parsed.frames).length) throw new Error("Converted PLIST did not retain every sprite frame.");
  validateFrames(checked, width, height, "Converted PLIST");
  return { xml: output, frameCount: Object.keys(checked.frames).length, warnings, format: options.legacyFormat ? 3 : Number(parsed.metadata?.format || 2) };
}
async function scalePng(pngFile, width, height) {
  const bitmap = await decodePng(pngFile, { maxPixels: MAX_ATLAS_PIXELS });
  try {
    const canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("This browser cannot create a canvas for PNG scaling.");
    context.clearRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in context) context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    return await canvasToPngBytes(canvas);
  } finally { bitmap.close?.(); }
}
function pngDimensions(bitmap) {
  const width = Number(bitmap.width), height = Number(bitmap.height);
  if (!width || !height || width * height > MAX_ATLAS_PIXELS) throw new Error("UHD atlas dimensions are empty or exceed the 100-megapixel safety limit.");
  return { width, height };
}
export async function buildResolutionArchive(pngFile, plistFile, selectedTargets = ["original","hd","uhd"], options = {}) {
  if (!pngFile || !plistFile) throw new Error("Choose both the UHD PNG atlas and its matching PLIST.");
  if (!/\.png$/i.test(pngFile.name || "")) throw new Error("The atlas file must be a PNG image.");
  if (!/\.plist$/i.test(plistFile.name || "")) throw new Error("The metadata file must be a .plist file.");
  const targets = [...new Set(selectedTargets)].filter(id => RESOLUTION_TARGETS[id]);
  if (!targets.length) throw new Error("Choose at least one output resolution.");
  const bitmap = await decodePng(pngFile, { maxPixels: MAX_ATLAS_PIXELS });
  const source = pngDimensions(bitmap); bitmap.close?.();
  const sourceXml = decoder.decode(await plistFile.arrayBuffer()), sourcePlist = parsePlist(sourceXml);
  if (!Object.keys(sourcePlist.frames || {}).length) throw new Error("The PLIST contains no readable sprite frames.");
  validateFrames(sourcePlist, source.width, source.height, "Input UHD PLIST");
  const metadataSize = parseSizeString(sourcePlist.metadata?.size), warnings = [];
  if (metadataSize && (round(metadataSize.width) !== source.width || round(metadataSize.height) !== source.height)) warnings.push("PLIST metadata reports " + metadataSize.width + "×" + metadataSize.height + " but the PNG is " + source.width + "×" + source.height + ". The PNG dimensions will be used.");
  if (source.width % 4 !== 0 || source.height % 4 !== 0) warnings.push("The source atlas dimensions are not divisible by four. Output sizes will be rounded to whole pixels; review the result before using it in-game.");
  const stem = normalizeAtlasStem(options.stem || pngFile.name), files = new Map(), variants = [];
  const plistStem = normalizeAtlasStem(String(plistFile.name).replace(/\.plist$/i, ".png"));
  if (plistStem.toLowerCase() !== stem.toLowerCase()) {
    warnings.push("The PNG and PLIST filenames have different base names. Frame bounds were checked, but matching names alone cannot prove these are the same source pack.");
  }
  for (const id of targets) {
    if (options.signal?.aborted) throw new DOMException("Conversion cancelled.", "AbortError");
    const target = RESOLUTION_TARGETS[id], width = Math.max(1, round(source.width * target.scale)), height = Math.max(1, round(source.height * target.scale));
    const pngName = stem + target.suffix + ".png", plistName = stem + target.suffix + ".plist";
    const pngBytes = id === "uhd" ? new Uint8Array(await pngFile.arrayBuffer()) : await scalePng(pngFile, width, height);
    const converted = convertPlistResolution(sourceXml, { scaleX: width / source.width, scaleY: height / source.height, width, height, pngName, legacyFormat: target.legacy });
    const plistBytes = encoder.encode(converted.xml);
    files.set(pngName, pngBytes); files.set(plistName, plistBytes);
    variants.push({ id, label: target.label, width, height, pngName, plistName, frameCount: converted.frameCount, format: converted.format, warnings: [...converted.warnings, ...(id === "uhd" ? [] : ["Derived from UHD. Official Original/HD artwork or trim geometry may differ."])], pngBytes: pngBytes.byteLength, plistBytes: plistBytes.byteLength });
    options.onProgress?.({ stage: "variant", current: variants.length, total: targets.length, label: target.label });
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const blob = await writeZipBlob(files, { maxEntries: 16, maxTotalBytes: 768 * 1024 * 1024, signal: options.signal });
  return { blob, source: { ...source, filename: pngFile.name, plistFilename: plistFile.name, frameCount: Object.keys(sourcePlist.frames).length }, variants, files: [...files.keys()], warnings };
}
