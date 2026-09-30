import { decodeSaveFile } from "../saves/save-decoder.js";
import { isSupportedAudioFile } from "../audio/audio-asset.js";

const handlers = new Map();

export function registerFileHandler({ extensions, detect }) {
  for (const extension of extensions) handlers.set(extension.toLowerCase().replace(/^\./, ""), detect);
}

export async function detectFile(file) {
  const extension = String(file?.name || "").split(".").pop().toLowerCase();
  if (extension === "gmdproject") return { kind: "project-backup", confidence: 0.99, handler: "project-backup" };
  if (["gmd", "txt"].includes(extension)) {
    return { kind: "level", confidence: extension === "gmd" ? 0.99 : 0.96, handler: "level" };
  }
  if (isSupportedAudioFile(file)) return { kind: "audio", confidence: 0.96, handler: "audio", assetType: extension || file.type };
  const basename = String(file?.name || "").split(/[\\/]/).pop().toLowerCase();
  const isCanonicalSaveName = ["ccgamemanager.dat", "cclocallevels.dat"].includes(basename);
  if (extension === "dat" || isCanonicalSaveName) {
    try {
      const decoded = await decodeSaveFile(file);
      return { kind: "save", saveType: decoded.saveType, confidence: 0.99, handler: "save" };
    } catch (_) {
      // Preserve a useful error path for the two canonical filenames, while unknown .dat files stay unknown.
      if (isCanonicalSaveName) {
        return { kind: "save", saveType: basename === "ccgamemanager.dat" ? "game-manager" : "local-levels", confidence: 0.35, handler: "save", invalid: true };
      }
      return { kind: "unknown", confidence: 0.02, handler: null };
    }
  }
  // Keep future content sniffing behind one API rather than teaching the UI extensions.
  const sample = typeof file?.slice === "function" ? await file.slice(0, 256).text().catch(() => "") : "";
  if (["png", "plist", "zip"].includes(extension)) {
    let valid = extension === "plist" ? /<(?:plist|dict|d)\b/i.test(sample) : false;
    if (extension !== "plist" && typeof file?.slice === "function" && typeof file.slice(0, 8).arrayBuffer === "function") {
      try {
        const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
        valid = extension === "png" ? [137,80,78,71,13,10,26,10].every((byte, i) => head[i] === byte) : head[0] === 0x50 && head[1] === 0x4b && [0x03,0x05,0x07].includes(head[2]);
      } catch (_) { valid = false; }
    }
    if (valid) return { kind: "texture", confidence: extension === "zip" ? 0.84 : 0.95, handler: "texture", assetType: extension };
    return { kind: "unknown", confidence: 0.02, handler: null };
  }
  for (const [ext, detect] of handlers) {
    const result = await detect({ file, sample, extension: ext });
    if (result) return result;
  }
  return { kind: "unknown", confidence: sample.includes(";") ? 0.15 : 0.05, handler: null };
}
