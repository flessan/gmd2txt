import { decodePng, composeModifiedAtlas, extractSprite, canvasToPngBytes } from "./sprites.js";
import { packSpriteItems } from "./atlas-packer.js";
import { writeZip } from "./zip.js";
import { downloadTextureBlob } from "./texture-download.js";

const xmlEscape = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
function patchedFrameXml(frame, placement) {
  const xml = frame.rawXml, changes = [];
  const frameRegion = frame._xml.frame;
  if (!frameRegion) throw new Error(`Sprite ${frame.name} has no patchable frame geometry.`);
  changes.push({ start: frameRegion.textStart - frame._xml.nodeStart, end: frameRegion.textEnd - frame._xml.nodeStart, text: `{{${placement.x},${placement.y}},{${placement.width},${placement.height}}}` });
  const rotated = frame._xml.rotated;
  if (rotated) {
    if (["true", "false", "t", "f"].includes(rotated.tag)) changes.push({ start: rotated.start - frame._xml.nodeStart, end: rotated.end - frame._xml.nodeStart, text: `<${rotated.tag.length === 1 ? "f" : "false"}/>` });
    else changes.push({ start: rotated.textStart - frame._xml.nodeStart, end: rotated.textEnd - frame._xml.nodeStart, text: "false" });
  }
  changes.sort((a,b) => b.start - a.start);
  let output = xml;
  for (const change of changes) output = output.slice(0, change.start) + change.text + output.slice(change.end);
  return output;
}

function patchMergedMetadata(xml, width, height, pngPath) {
  const pngName = String(pngPath || "atlas.png").replace(/\\/g, "/").split("/").pop();
  const replaceValue = (source, key, value) => {
    const pattern = new RegExp("(<key>\\s*" + key + "\\s*</key>\\s*<string>)[\\s\\S]*?(</string>)");
    let changed = false;
    source = source.replace(pattern, (match, open, close) => { changed = true; return open + xmlEscape(value) + close; });
    if (changed) return source;
    const metadata = new RegExp("(<key>metadata</key>\\s*<dict>)([\\s\\S]*?)(</dict>)");
    return source.replace(metadata, (match, open, body, close) => open + body + "\\n<key>" + key + "</key><string>" + xmlEscape(value) + "</string>\\n" + close);
  };
  xml = replaceValue(xml, "size", "{" + width + "," + height + "}");
  xml = replaceValue(xml, "textureFileName", pngName);
  xml = replaceValue(xml, "realTextureFileName", pngName);
  return xml;
}

function availablePath(map, target) { let path = target, count = 1; while (map.has(path)) path = target.replace(/(\.[^.]+)?$/, `-${count++}$1`); return path; }

/** Merge frames from multiple independent sheets into a new atlas; original sheets and metadata remain untouched. */
export async function mergeTextureSheets(document, sheetIds = Object.keys(document.sheets || {}), options = {}) {
  const selected = sheetIds.map(id => document.sheets[id]).filter(Boolean);
  if (!selected.length) throw new Error("Select at least one texture sheet to merge.");
  const items = [], entries = [], first = selected.find(sheet => sheet.parsed?.plist);
  if (!first) throw new Error("A valid XML PLIST sheet is required for merged output metadata.");
  try {
    for (const sheet of selected) {
      if (!sheet.source.png || !sheet.parsed?.plist) throw new Error(`Sheet “${sheet.name}” is incomplete and cannot be merged.`);
      const mods = document.modifications?.[sheet.id] || {};
      const hasMods = Object.keys(mods).length > 0;
      const atlas = hasMods ? await composeModifiedAtlas(sheet.source.png, sheet, mods) : await decodePng(sheet.source.png);
      try {
        for (const frame of Object.values(sheet.parsed.frames)) {
          const mergedName = `${sheet.name}/${frame.name}`;
          const image = await extractSprite(atlas, frame);
          items.push({ name: mergedName, image });
          entries.push({ mergedName, frame, sheet });
        }
      } finally { atlas.close?.(); }
    }
    if (!items.length) throw new Error("The selected sheets contain no valid sprites.");
    const packed = await packSpriteItems(items, options);
    try {
      const xmlFrames = entries.map(({ mergedName, frame }) => `<key>${xmlEscape(mergedName)}</key>${patchedFrameXml(frame, packed.placements[mergedName].frame)}`).join("\n");
      const region = first.parsed.plist.framesRegion;
      if (!region) throw new Error("The selected PLIST does not have a writable frames dictionary.");
      const mergedPlistRaw = first.parsed.plist.raw.slice(0, region.openEnd) + `\n${xmlFrames}\n` + first.parsed.plist.raw.slice(region.closeStart);
      const output = new Map(Object.entries(document.archiveEntries || {}));
      const pngPath = availablePath(output, "__gmdplayer_merged__/atlas.png");
      const plistPath = availablePath(output, "__gmdplayer_merged__/atlas.plist");
      output.set(pngPath, await canvasToPngBytes(packed.canvas));
      const mergedPlist = patchMergedMetadata(mergedPlistRaw, packed.width, packed.height, pngPath);
      output.set(plistPath, new TextEncoder().encode(mergedPlist));
      const bytes = writeZip(output);
      const filename = `${(document.name || "texture-pack").replace(/[^\w.-]+/g, "_")}-merged.zip`;
      downloadTextureBlob(bytes, filename, "application/zip");
      return { width: packed.width, height: packed.height, spriteCount: entries.length, pngPath, plistPath };
    } finally { packed.canvas.close?.(); }
  } catch (error) {
    for (const item of items) item.image.close?.();
    throw error;
  }
}
