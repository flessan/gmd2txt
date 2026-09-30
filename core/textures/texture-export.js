import { composeModifiedAtlas, canvasToPngBytes } from "./sprites.js";
import { patchPlist } from "./plist-writer.js";
import { packSprites } from "./atlas-packer.js";
import { writeZip } from "./zip.js";

function download(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime }), url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function buildTextureFiles(document) {
  const output = new Map(Object.entries(document.archiveEntries || {}));
  for (const sheet of Object.values(document.sheets || {})) {
    if (!sheet.source.png || !sheet.source.plist) continue;
    const mods = document.modifications?.[sheet.id] || {};
    if (Object.keys(mods).length && sheet.source.pngPath) {
      const canvas = await composeModifiedAtlas(sheet.source.png, sheet, mods);
      output.set(sheet.source.pngPath, await canvasToPngBytes(canvas)); canvas.close?.();
    }
    if (sheet.source.plistPath && sheet.parsed.plist) {
      const changes = {};
      for (const [name, mod] of Object.entries(mods)) if (mod.geometry) changes[name] = mod.geometry;
      if (Object.keys(changes).length) output.set(sheet.source.plistPath, new TextEncoder().encode(patchPlist(sheet.parsed.plist, changes)));
    }
  }
  return output;
}
export async function exportTexturePack(document, filename = "texture-pack.zip") {
  const files = await buildTextureFiles(document);
  download(writeZip(files), filename, "application/zip");
}
export async function exportTextureSheet(document, sheetId) {
  const sheet = document.sheets[sheetId];
  if (!sheet?.source.png || !sheet?.source.plist) throw new Error("This sheet needs both PNG and PLIST before it can be exported.");
  const files = await buildTextureFiles(document);
  const png = files.get(sheet.source.pngPath), plist = files.get(sheet.source.plistPath);
  const base = sheet.name.replace(/[^\w.-]+/g, "_");
  download(png, `${base}.png`, "image/png"); download(plist, `${base}.plist`, "application/xml");
}
export async function exportSplitSprites(document, sheetId) {
  const sheet = document.sheets[sheetId];
  if (!sheet?.source.png || !sheet.parsed.frames) throw new Error("This sheet cannot be split until its PNG and PLIST are valid.");
  const files = new Map();
  const { extractSprite, decodePng, canvasToPngBytes } = await import("./sprites.js");
  for (const [name, frame] of Object.entries(sheet.parsed.frames)) {
    const mod = document.modifications?.[sheetId]?.[name];
    const canvas = mod?.png ? await decodePng(mod.png) : await extractSprite(sheet.source.png, frame);
    files.set(`${name.replace(/[\\/]/g, "_")}.png`, await canvasToPngBytes(canvas)); canvas.close?.();
  }
  download(writeZip(files), `${sheet.name.replace(/[^\w.-]+/g, "_")}-sprites.zip`, "application/zip");
}

/** Explicit repack export. Never invoked by exact-slot replacement or ordinary pack export. */
export async function exportRepackedTexturePack(document, sheetId, options = {}) {
  const sheet = document.sheets?.[sheetId];
  if (!sheet?.source.png || !sheet?.source.plist || !sheet.parsed.plist) throw new Error("Repacking requires a valid PNG + XML PLIST pair.");
  const files = await buildTextureFiles(document);
  const modifiedAtlas = await composeModifiedAtlas(sheet.source.png, sheet, document.modifications?.[sheetId] || {});
  const packed = await packSprites(modifiedAtlas, sheet, Object.keys(sheet.parsed.frames), options);
  modifiedAtlas.close?.();
  const frameChanges = {};
  for (const [name, placement] of Object.entries(packed.placements)) frameChanges[name] = { frame: placement.frame, rotated: placement.rotated };
  files.set(sheet.source.pngPath, await canvasToPngBytes(packed.canvas));
  files.set(sheet.source.plistPath, new TextEncoder().encode(patchPlist(sheet.parsed.plist, frameChanges)));
  packed.canvas.close?.();
  const name = `${(document.name || "texture-pack").replace(/[^\w.-]+/g, "_")}-repacked.zip`;
  download(writeZip(files), name, "application/zip");
  return { placements: packed.placements, width: packed.width, height: packed.height };
}
