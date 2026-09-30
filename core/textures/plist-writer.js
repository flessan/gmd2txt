function format(value) { return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4))); }
function escaped(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;"); }
const rectString = r => `{{${format(r.x)},${format(r.y)}},{${format(r.width)},${format(r.height)}}}`;
const pointString = p => `{${format(p.x)},${format(p.y)}}`;
const sizeString = s => `{${format(s.width)},${format(s.height)}}`;

function replaceText(xml, region, value) {
  if (!region || region.textStart == null || region.textEnd == null) return xml;
  return xml.slice(0, region.textStart) + escaped(value) + xml.slice(region.textEnd);
}

/** Patch only requested known sprite fields. All unrelated XML and unknown keys remain byte-for-byte intact. */
export function patchPlist(plist, frameChanges = {}) {
  let xml = plist.raw;
  const edits = [];
  for (const [name, change] of Object.entries(frameChanges)) {
    const frame = plist.frames[name];
    if (!frame) throw new Error(`Unknown sprite frame: ${name}`);
    for (const [field, value, formatValue] of [
      ["frame", change.frame, rectString], ["offset", change.offset, pointString],
      ["sourceSize", change.sourceSize, sizeString], ["sourceColorRect", change.sourceColorRect, rectString]
    ]) {
      const region = frame._xml[field];
      if (!value || !region) continue;
      edits.push({ start: region.textStart, end: region.textEnd, text: escaped(formatValue(value)) });
    }
    if (change.rotated !== undefined && frame._xml.rotated) {
      const region = frame._xml.rotated;
      if (["true", "false", "t", "f"].includes(region.tag)) {
        const tag = region.tag.length === 1 ? (change.rotated ? "t" : "f") : (change.rotated ? "true" : "false");
        edits.push({ start: region.start, end: region.end, text: `<${tag}/>` });
      } else edits.push({ start: region.textStart, end: region.textEnd, text: change.rotated ? "true" : "false" });
    }
  }
  edits.sort((a, b) => b.start - a.start);
  for (const edit of edits) xml = xml.slice(0, edit.start) + edit.text + xml.slice(edit.end);
  return xml;
}

function plistValue(value, indent = 0) {
  const pad = "\t".repeat(indent), child = "\t".repeat(indent + 1);
  if (value === true) return `${pad}<true/>`;
  if (value === false) return `${pad}<false/>`;
  if (typeof value === "number") return `${pad}<${Number.isInteger(value) ? "integer" : "real"}>${value}</${Number.isInteger(value) ? "integer" : "real"}>`;
  if (typeof value === "string") return `${pad}<string>${escaped(value)}</string>`;
  if (Array.isArray(value)) return `${pad}<array>${value.length ? `\n${value.map(item => plistValue(item, indent + 1)).join("\n")}\n${pad}` : ""}</array>`;
  if (value && typeof value === "object") return `${pad}<dict>${Object.keys(value).length ? `\n${Object.entries(value).map(([key, item]) => `${child}<key>${escaped(key)}</key>\n${plistValue(item, indent + 1)}`).join("\n")}\n${pad}` : ""}</dict>`;
  return `${pad}<string></string>`;
}

export function writePlist(value) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plistValue(value, 1)}\n</plist>\n`;
}
