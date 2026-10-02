export const MAX_PNG_PIXELS = 100_000_000;

export async function decodePng(fileOrBytes, options = {}) {
  const blob = fileOrBytes instanceof Blob ? fileOrBytes : new Blob([fileOrBytes], { type: "image/png" });
  if (blob.size > (options.maxBytes ?? 128 * 1024 * 1024)) throw new Error("PNG exceeds the size limit.");
  const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (signature.length !== 8 || signature.some((byte, i) => byte !== [137, 80, 78, 71, 13, 10, 26, 10][i])) throw new Error("File is not a PNG image.");
  let bitmap;
  if(typeof globalThis.createImageBitmap==="function"){
    // Sprite work is pixel work: ask the decoder not to premultiply alpha or
    // convert colour spaces, so a pixel read back is the pixel that was stored.
    const precise = { premultiplyAlpha: "none", colorSpaceConversion: "none", alpha: true };
    try { bitmap = await globalThis.createImageBitmap(blob, precise); }
    catch (_) {
      try { bitmap = await globalThis.createImageBitmap(blob); }
      catch (_) { throw new Error("PNG image data is malformed or unsupported."); }
    }
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

export function isPngBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  return view.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => view[index] === value);
}

/** Width/height straight out of the IHDR, without decoding the image. */
export async function pngDimensions(source) { return pngHeaderDimensions(source); }

export async function extractSprite(atlas, frame, options = {}) {
  const isBitmap = typeof ImageBitmap === "function" && atlas instanceof ImageBitmap;
  const logical = dimensions(frame);
  const scale = options.maxDimension ? Math.min(1, options.maxDimension / Math.max(logical.width, logical.height)) : 1;
  const outputWidth = Math.max(1, Math.round(logical.width * scale)), outputHeight = Math.max(1, Math.round(logical.height * scale));
  const canvas = makeCanvas(outputWidth, outputHeight), ctx = canvas.getContext("2d", { willReadFrequently: false });
  // A crop that is not resized must come out pixel for pixel; only an explicit
  // thumbnail (maxDimension) is allowed to resample, and then it is smoothed.
  ctx.imageSmoothingEnabled = options.smoothing ?? (scale !== 1);
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

/**
 * Where a replacement image lands inside a sprite slot, for each fitting mode.
 * Pure maths on purpose: this is the rule people rely on when they drop a big
 * picture onto a small sprite, so it is unit tested in Node.
 *
 *   contain — keep the aspect ratio, whole image visible, transparent margins
 *   cover   — keep the aspect ratio, fill the slot, crop the overflow
 *   stretch — fill the slot exactly, aspect ratio may change ("fit" in the UI)
 *   exact   — the replacement already has the slot's size
 */
export function fitRect(source, target, mode = "contain") {
  const width = Math.max(1, Math.round(Number(source?.width) || 0));
  const height = Math.max(1, Math.round(Number(source?.height) || 0));
  const slotWidth = Math.max(1, Math.round(Number(target?.width) || 0));
  const slotHeight = Math.max(1, Math.round(Number(target?.height) || 0));
  if (mode === "stretch" || mode === "fit") return { x: 0, y: 0, width: slotWidth, height: slotHeight };
  if (mode === "contain") {
    const scale = Math.min(slotWidth / width, slotHeight / height);
    const drawWidth = Math.max(1, Math.round(width * scale));
    const drawHeight = Math.max(1, Math.round(height * scale));
    return { x: Math.round((slotWidth - drawWidth) / 2), y: Math.round((slotHeight - drawHeight) / 2), width: drawWidth, height: drawHeight };
  }
  if (mode === "cover") {
    const scale = Math.max(slotWidth / width, slotHeight / height);
    const drawWidth = Math.max(1, Math.round(width * scale));
    const drawHeight = Math.max(1, Math.round(height * scale));
    return { x: Math.round((slotWidth - drawWidth) / 2), y: Math.round((slotHeight - drawHeight) / 2), width: drawWidth, height: drawHeight };
  }
  throw new Error("Choose how the image should fit the sprite: contain, cover, stretch or exact.");
}

export const SPRITE_FIT_MODES = ["contain", "cover", "stretch", "exact"];

async function toCanvas(source) {
  if (source?.getContext) return source;
  return decodePng(source);
}
export async function createSpriteReplacement(atlasSource, frame, replacementSource, mode = "exact") {
  if (!["exact", "fit", "contain", "cover", "stretch"].includes(mode)) {
    throw new Error("Choose how the image should fit the sprite: contain, cover, stretch or exact.");
  }
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
    throw new Error(`An exact replacement must already be ${logical.width}×${logical.height}px — choose a fitting mode to resize automatically.`);
  }
  const replacement = await toCanvas(replacementSource), closeReplacement = !sourceHasDimensions;
  if (mode === "exact" && (replacement.width !== replacementSize.width || replacement.height !== replacementSize.height)) {
    if (closeReplacement) replacement.close?.();
    throw new Error("Replacement PNG dimensions do not match its header.");
  }
  // The picture is scaled for the person, never silently distorted: "contain"
  // keeps the whole image, "cover" fills the slot, "stretch" is the explicit
  // "make it exactly this size" option.
  const place = fitRect({ width: replacement.width, height: replacement.height }, logical, mode);
  const fitted = makeCanvas(logical.width, logical.height), fctx = fitted.getContext("2d");
  fctx.imageSmoothingEnabled = mode !== "exact";
  fctx.imageSmoothingQuality = "high";
  // "cover" crops from the centre by drawing an oversized image into the slot.
  if (mode === "cover") {
    fctx.drawImage(replacement, place.x, place.y, place.width, place.height);
  } else {
    fctx.clearRect(0, 0, logical.width, logical.height);
    fctx.drawImage(replacement, 0, 0, replacement.width, replacement.height, place.x, place.y, place.width, place.height);
  }
  if (closeReplacement) replacement.close?.();
  return fitted;
}

/**
 * The replacement as the bytes that get stored in the pack.
 *
 * `exact` is a promise that the picture is already the sprite's size, so the
 * file is kept byte for byte — re-encoding it through a canvas would be a
 * silently different image. Everything else is fitted and re-encoded.
 */
export async function createSpriteReplacementBytes(atlasSource, frame, replacementSource, mode = "exact") {
  const sourceIsBytes = replacementSource instanceof Uint8Array || replacementSource instanceof ArrayBuffer;
  if (mode === "exact" && sourceIsBytes && isPngBytes(replacementSource)) {
    const bytes = replacementSource instanceof Uint8Array ? replacementSource : new Uint8Array(replacementSource);
    const size = await pngHeaderDimensions(bytes);
    const logical = dimensions(frame);
    if (size.width !== logical.width || size.height !== logical.height) {
      throw new Error(`An exact replacement must already be ${logical.width}×${logical.height}px — choose a fitting mode to resize automatically.`);
    }
    return { bytes, width: size.width, height: size.height, exact: true };
  }
  const canvas = await createSpriteReplacement(atlasSource, frame, replacementSource, mode);
  try {
    return { bytes: await canvasToPngBytes(canvas), width: canvas.width, height: canvas.height, exact: false };
  } finally {
    canvas.close?.();
  }
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
