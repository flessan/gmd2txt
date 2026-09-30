export const MAX_PNG_PIXELS = 100_000_000;

export async function decodePng(fileOrBytes, options = {}) {
  const blob = fileOrBytes instanceof Blob ? fileOrBytes : new Blob([fileOrBytes], { type: "image/png" });
  if (blob.size > (options.maxBytes ?? 128 * 1024 * 1024)) throw new Error("PNG exceeds the size limit.");
  const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (signature.length !== 8 || signature.some((byte, i) => byte !== [137, 80, 78, 71, 13, 10, 26, 10][i])) throw new Error("File is not a PNG image.");
  let bitmap;
  if(typeof globalThis.createImageBitmap==="function"){
    try { bitmap = await globalThis.createImageBitmap(blob); } catch (_) { throw new Error("PNG image data is malformed or unsupported."); }
  }else if(typeof globalThis.Image==="function"&&globalThis.URL?.createObjectURL){
    const url=URL.createObjectURL(blob);bitmap=await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error("PNG image data is malformed or unsupported."));image.src=url;}).finally(()=>URL.revokeObjectURL(url));
  }else throw new Error("PNG decoding is unavailable in this browser.");
  if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > (options.maxPixels ?? MAX_PNG_PIXELS)) { bitmap.close?.(); throw new Error("PNG dimensions exceed the safety limit."); }
  return bitmap;
}

async function pngHeaderDimensions(source) {
  const blob = source instanceof Blob ? source : new Blob([source], { type: "image/png" });
  if (blob.size < 24) throw new Error("PNG header is incomplete.");
  const header = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
  if (![137,80,78,71,13,10,26,10].every((value, index) => header[index] === value) || String.fromCharCode(...header.subarray(12, 16)) !== "IHDR") throw new Error("File is not a valid PNG image.");
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height || width * height > MAX_PNG_PIXELS) throw new Error("PNG dimensions exceed the safety limit.");
  return { width, height };
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; return canvas;
}
function dimensions(frame) { return frame.rotated ? { width: frame.frame.height, height: frame.frame.width } : { width: frame.frame.width, height: frame.frame.height }; }
function checkedRect(frame, atlasWidth, atlasHeight) {
  const r = frame.frame;
  const x = Math.floor(r.x), y = Math.floor(r.y), width = Math.ceil(r.width), height = Math.ceil(r.height);
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > atlasWidth || y + height > atlasHeight) throw new Error(`Sprite frame is outside its atlas: ${frame.name}`);
  return { x, y, width, height };
}

export async function extractSprite(atlas, frame, options = {}) {
  const isBitmap = typeof ImageBitmap === "function" && atlas instanceof ImageBitmap;
  const logical = dimensions(frame);
  const scale = options.maxDimension ? Math.min(1, options.maxDimension / Math.max(logical.width, logical.height)) : 1;
  const outputWidth = Math.max(1, Math.round(logical.width * scale)), outputHeight = Math.max(1, Math.round(logical.height * scale));
  const canvas = makeCanvas(outputWidth, outputHeight), ctx = canvas.getContext("2d", { willReadFrequently: false });
  if (!isBitmap && !atlas?.getContext && typeof createImageBitmap === "function") {
    const blob = atlas instanceof Blob ? atlas : new Blob([atlas], { type: "image/png" });
    const size = await pngHeaderDimensions(blob), rect = checkedRect(frame, size.width, size.height);
    let crop;
    try {
      crop = await createImageBitmap(blob, rect.x, rect.y, rect.width, rect.height, {
        resizeWidth: Math.max(1, Math.round(rect.width * scale)),
        resizeHeight: Math.max(1, Math.round(rect.height * scale)),
        resizeQuality: "high"
      });
    } catch (_) {
      const bitmap = await decodePng(blob);
      try {
        if (frame.rotated) { ctx.translate(0, outputHeight); ctx.rotate(-Math.PI / 2); ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, outputHeight, outputWidth); }
        else ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, outputWidth, outputHeight);
      } finally { bitmap.close?.(); }
      return canvas;
    }
    try {
      if (frame.rotated) { ctx.translate(0, outputHeight); ctx.rotate(-Math.PI / 2); ctx.drawImage(crop, 0, 0, outputHeight, outputWidth); }
      else ctx.drawImage(crop, 0, 0, outputWidth, outputHeight);
    } finally { crop.close?.(); }
    return canvas;
  }
  const bitmap = isBitmap || atlas?.getContext ? atlas : await decodePng(atlas);
  const rect = checkedRect(frame, bitmap.width, bitmap.height);
  if (frame.rotated) {
    // Cocos-style rotated frames are packed 90 degrees clockwise; rotate them back for preview.
    ctx.translate(0, outputHeight); ctx.rotate(-Math.PI / 2);
    ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, outputHeight, outputWidth);
  } else ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, outputWidth, outputHeight);
  if (!isBitmap && !atlas?.getContext) bitmap.close?.();
  return canvas;
}

async function toCanvas(source) {
  if (source?.getContext) return source;
  return decodePng(source);
}
export async function createSpriteReplacement(atlasSource, frame, replacementSource, mode = "exact") {
  if (!["exact", "fit"].includes(mode)) throw new Error("Choose Exact dimensions or Fit to slot.");
  const atlasSize = atlasSource?.getContext || (typeof ImageBitmap === "function" && atlasSource instanceof ImageBitmap)
    ? { width: atlasSource.width, height: atlasSource.height }
    : await pngHeaderDimensions(atlasSource);
  checkedRect(frame, atlasSize.width, atlasSize.height);
  const logical = dimensions(frame);
  const sourceHasDimensions = replacementSource?.getContext || (typeof ImageBitmap === "function" && replacementSource instanceof ImageBitmap);
  const replacementSize = sourceHasDimensions
    ? { width: replacementSource.width, height: replacementSource.height }
    : await pngHeaderDimensions(replacementSource);
  if (mode === "exact" && (replacementSize.width !== logical.width || replacementSize.height !== logical.height)) {
    throw new Error(`Exact replacement requires ${logical.width}×${logical.height}px. Choose Fit to slot to resize explicitly.`);
  }
  let replacement, closeReplacement = false;
  if (!sourceHasDimensions && mode === "fit" && typeof createImageBitmap === "function") {
    const blob = replacementSource instanceof Blob ? replacementSource : new Blob([replacementSource], { type: "image/png" });
    try {
      replacement = await createImageBitmap(blob, { resizeWidth: logical.width, resizeHeight: logical.height, resizeQuality: "high" });
      closeReplacement = true;
    } catch (_) { replacement = await decodePng(blob); closeReplacement = true; }
  } else { replacement = await toCanvas(replacementSource); closeReplacement = !sourceHasDimensions; }
  if (mode === "exact" && (replacement.width !== replacementSize.width || replacement.height !== replacementSize.height)) {
    if (closeReplacement) replacement.close?.();
    throw new Error("Replacement PNG dimensions do not match its header.");
  }
  const fitted = makeCanvas(logical.width, logical.height), fctx = fitted.getContext("2d");
  fctx.imageSmoothingEnabled = mode !== "exact";
  fctx.drawImage(replacement, 0, 0, logical.width, logical.height);
  if (closeReplacement) replacement.close?.();
  return fitted;
}

export async function composeModifiedAtlas(atlasSource, sheet, modifications = {}) {
  const original = await toCanvas(atlasSource);
  const output = makeCanvas(original.width, original.height), ctx = output.getContext("2d");
  ctx.drawImage(original, 0, 0);
  for (const [name, modification] of Object.entries(modifications)) {
    const frame = sheet.parsed.frames[name];
    if (!frame || !modification?.png) continue;
    const patch = await decodePng(modification.png), rect = checkedRect(frame, original.width, original.height), logical = dimensions(frame);
    if (patch.width !== logical.width || patch.height !== logical.height) { patch.close?.(); throw new Error(`Saved replacement dimensions do not fit ${name}.`); }
    if (frame.rotated) {
      ctx.save(); ctx.translate(rect.x + rect.width, rect.y); ctx.rotate(Math.PI / 2);
      ctx.drawImage(patch, 0, 0, logical.width, logical.height, 0, 0, rect.height, rect.width); ctx.restore();
    } else ctx.drawImage(patch, rect.x, rect.y, rect.width, rect.height);
    patch.close?.();
  }
  original.close?.();
  return output;
}

export async function canvasToPngBytes(canvas) {
  const blob = await canvas.convertToBlob?.({ type: "image/png" }) || await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("PNG encoding failed.")), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}
