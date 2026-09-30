import { extractSprite } from "./sprites.js";

/** Deterministic shelf packer shared by explicit per-sheet repacks and multi-sheet merges. */
export async function packSpriteItems(inputItems, options = {}) {
  const padding = Math.max(0, Math.floor(options.padding ?? 2));
  const maxWidth = Math.max(64, Math.floor(options.maxWidth ?? 2048));
  const maxHeight = Math.max(64, Math.floor(options.maxHeight ?? 2048));
  const items = inputItems.map(item => ({ ...item, width: item.image.width, height: item.image.height }));
  try {
    for (const item of items) if (item.width + padding * 2 > maxWidth || item.height + padding * 2 > maxHeight) throw new Error(`Sprite ${item.name} exceeds repack dimensions.`);
    items.sort((a, b) => b.height - a.height || b.width - a.width || a.name.localeCompare(b.name));
    let x = padding, y = padding, rowHeight = 0, usedWidth = padding, usedHeight = padding;
    for (const item of items) {
      if (x + item.width + padding > maxWidth) { x = padding; y += rowHeight + padding; rowHeight = 0; }
      if (y + item.height + padding > maxHeight) throw new Error("Sprites do not fit within the requested atlas dimensions.");
      item.frame = { x, y, width: item.width, height: item.height };
      x += item.width + padding; rowHeight = Math.max(rowHeight, item.height);
      usedWidth = Math.max(usedWidth, x); usedHeight = Math.max(usedHeight, y + rowHeight + padding);
    }
    const width = Math.max(1, options.width || Math.min(maxWidth, 2 ** Math.ceil(Math.log2(usedWidth))));
    const height = Math.max(1, options.height || Math.min(maxHeight, 2 ** Math.ceil(Math.log2(usedHeight))));
    if (width > maxWidth || height > maxHeight || width < usedWidth || height < usedHeight) throw new Error("Chosen atlas dimensions are too small or exceed the configured limits.");
    const canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
    const ctx = canvas.getContext("2d");
    for (const item of items) ctx.drawImage(item.image, item.frame.x, item.frame.y);
    return { canvas, width, height, placements: Object.fromEntries(items.map(item => [item.name, { frame: item.frame, rotated: false }])) };
  } finally { for (const item of items) item.image.close?.(); }
}

export async function packSprites(atlasSource, sheet, names = Object.keys(sheet.parsed.frames), options = {}) {
  const items = [];
  try {
    for (const name of names) {
      const frame = sheet.parsed.frames[name];
      if (!frame) throw new Error(`Unknown sprite: ${name}`);
      items.push({ name, image: await extractSprite(atlasSource, frame) });
    }
    return await packSpriteItems(items, options);
  } catch (error) { for (const item of items) item.image.close?.(); throw error; }
}
