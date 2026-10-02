/**
 * Phaser / TexturePacker JSON atlases (the format the bundled Geometry Dash
 * sheets use) are read into the same shape the XML PLIST parser produces, so
 * every sprite tool works on either kind of pack. Two layouts are common:
 *
 *   hash  — { frames: { "sprite.png": { frame: {x,y,w,h}, rotated, ... } } }
 *   array — { frames: [ { filename: "sprite.png", frame: {...}, ... } ] }
 *
 * Only the geometry is normalised: name, atlas rectangle, rotation flag and the
 * original (untrimmed) size. Anything missing is treated as "not trimmed".
 */

function frameObject(entry) {
  // Both layouts keep the geometry either on the entry itself (array form) or
  // under `frame` (hash form), and some packers nest it one level deeper.
  const inner = entry?.frame && typeof entry.frame === "object" ? entry.frame : entry;
  if (inner && typeof inner === "object" && (inner.x !== undefined || inner.width !== undefined || inner.w !== undefined)) return inner;
  if (entry?.frame && typeof entry.frame === "object" && typeof entry.frame.frame === "object") return entry.frame.frame;
  return null;
}

function rectFrom(entry) {
  const raw = frameObject(entry);
  if (!raw) return null;
  const x = Number(raw.x), y = Number(raw.y);
  const width = Number(raw.w ?? raw.width), height = Number(raw.h ?? raw.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function trimmedSize(entry, width, height) {
  const source = entry?.sourceSize || entry?.frame?.sourceSize || {};
  const sourceWidth = Number(source.w ?? source.width), sourceHeight = Number(source.h ?? source.height);
  if (Number.isFinite(sourceWidth) && Number.isFinite(sourceHeight) && sourceWidth > 0 && sourceHeight > 0) {
    return { width: sourceWidth, height: sourceHeight };
  }
  return { width, height };
}

function toFrame(entry, name, fallback) {
  const rect = rectFrom(entry);
  if (!rect) return null;
  const logical = { ...rect };
  const size = trimmedSize(entry, rect.width, rect.height);
  return {
    name: String(name || entry?.filename || fallback || "sprite"),
    frame: logical,
    rotated: entry?.rotated === true,
    trimmed: Boolean(entry?.trimmed),
    sourceSize: { width: size.width, height: size.height },
    spriteSourceSize: entry?.spriteSourceSize || entry?.frame?.spriteSourceSize || { x: 0, y: 0, width: logical.width, height: logical.height },
    rawXml: null
  };
}

/**
 * @param {string|Uint8Array} input atlas JSON text (or its bytes)
 * @returns {{frames: Record<string, object>, meta: {size: {width:number|null,height:number|null}, image: string|null}}}
 */
export function parseJsonAtlas(input) {
  const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`Atlas JSON is not valid JSON: ${error.message}`);
  }
  const rawFrames = data?.frames;
  const frames = Object.create(null);
  if (Array.isArray(rawFrames)) {
    for (const entry of rawFrames) {
      const name = entry?.filename || entry?.name;
      const frame = toFrame(entry, name);
      if (frame) frames[frame.name] = frame;
    }
  } else if (rawFrames && typeof rawFrames === "object") {
    for (const [name, entry] of Object.entries(rawFrames)) {
      const frame = toFrame(entry, name);
      if (frame) frames[frame.name] = frame;
    }
  } else {
    throw new Error("This JSON file is not a sprite atlas (no frames were found).");
  }
  if (!Object.keys(frames).length) throw new Error("This JSON atlas has no usable sprite frames.");
  const size = data?.meta?.size || {};
  const width = Number(size.w ?? size.width), height = Number(size.h ?? size.height);
  return {
    frames,
    meta: {
      size: { width: Number.isFinite(width) ? width : null, height: Number.isFinite(height) ? height : null },
      image: data?.meta?.image || null
    }
  };
}
