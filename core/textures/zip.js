const MAX_ENTRIES = 2000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const u16 = (view, offset) => view.getUint16(offset, true);
const u32 = (view, offset) => view.getUint32(offset, true);

export function validateArchivePath(path) {
  const original = String(path), normalized = original.replace(/\\/g, "/");
  if (!normalized || original.includes("\\") || normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || normalized.includes("\0")) return false;
  return normalized.split("/").every(part => part !== ".." && part !== ".");
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "function") {
    try {
      const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
      const chunks = []; let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_ENTRY_BYTES) { await reader.cancel(); throw new Error("ZIP entry expanded beyond the size limit."); }
        chunks.push(value);
      }
      const output = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
      return output;
    } catch (error) {
      if (error.message?.includes("size limit")) throw error;
      if (typeof globalThis.pako?.Inflate !== "function") throw new Error("This browser does not support deflated ZIP entries.");
    }
  }
  if (typeof globalThis.pako?.Inflate === "function") {
    const chunks = []; let total = 0, overflow = false;
    const inflater = new globalThis.pako.Inflate({ raw: true, chunkSize: 64 * 1024 });
    inflater.onData = chunk => { total += chunk.length; if (total > MAX_ENTRY_BYTES) { overflow = true; return; } chunks.push(chunk); };
    inflater.push(bytes, true);
    if (overflow) throw new Error("ZIP entry expanded beyond the size limit.");
    if (inflater.err) throw new Error("Deflated ZIP entry is corrupt.");
    const output = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  }
  throw new Error("This browser cannot decompress deflated ZIP entries.");
}

export async function readZip(input, options = {}) {
  const maxArchiveBytes = options.maxArchiveBytes ?? ((options.maxTotalBytes ?? MAX_TOTAL_BYTES) + 32 * 1024 * 1024);
  if (typeof input?.size === "number" && input.size > maxArchiveBytes) throw new Error("ZIP archive exceeds the compressed-file size limit.");
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer());
  if (bytes.byteLength > maxArchiveBytes) throw new Error("ZIP archive exceeds the compressed-file size limit.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let endOffset = -1;
  const searchStart = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= searchStart; i--) {
    if (u32(view, i) === 0x06054b50 && i + 22 + u16(view, i + 20) === bytes.length) { endOffset = i; break; }
  }
  if (endOffset < 0) throw new Error("ZIP end-of-central-directory record not found.");
  const diskNumber = u16(view, endOffset + 4), centralDisk = u16(view, endOffset + 6), diskEntries = u16(view, endOffset + 8);
  const count = u16(view, endOffset + 10), centralSize = u32(view, endOffset + 12), centralOffset = u32(view, endOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== count) throw new Error("Multi-volume ZIP archives are not supported.");
  const maxEntries = options.maxEntries ?? MAX_ENTRIES, maxTotal = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
  if (count > maxEntries || centralOffset + centralSize > endOffset) throw new Error("ZIP directory exceeds safety limits or is malformed.");
  const files = new Map();
  let cursor = centralOffset, total = 0;
  for (let i = 0; i < count; i++) {
    if (options.signal?.aborted) throw new DOMException("Operation cancelled.", "AbortError");
    if (cursor + 46 > bytes.length || u32(view, cursor) !== 0x02014b50) throw new Error("Malformed ZIP central directory.");
    const flags = u16(view, cursor + 8), method = u16(view, cursor + 10);
    const compressedSize = u32(view, cursor + 20), uncompressedSize = u32(view, cursor + 24), expectedCrc = u32(view, cursor + 16);
    const madeBy = u16(view, cursor + 4) >>> 8, externalAttributes = u32(view, cursor + 38);
    const nameLength = u16(view, cursor + 28), extraLength = u16(view, cursor + 30), commentLength = u16(view, cursor + 32), localOffset = u32(view, cursor + 42);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if ((flags & 1) || (flags & 0x40)) throw new Error(`Encrypted ZIP entry is not supported: ${name}`);
    if (madeBy === 3 && ((externalAttributes >>> 16) & 0xf000) === 0xa000) throw new Error(`ZIP symlinks are not allowed: ${name}`);
    if (!validateArchivePath(name)) throw new Error(`Unsafe ZIP entry path rejected: ${name}`);
    if (files.has(name)) throw new Error(`Duplicate ZIP entry path rejected: ${name}`);
    if (name.endsWith("/")) continue;
    if (uncompressedSize > (options.maxEntryBytes ?? MAX_ENTRY_BYTES) || compressedSize > bytes.length || localOffset + 30 > bytes.length) throw new Error(`ZIP entry exceeds size limits: ${name}`);
    total += uncompressedSize;
    if (total > maxTotal) throw new Error("ZIP expanded size exceeds the archive limit.");
    if (u32(view, localOffset) !== 0x04034b50) throw new Error(`Malformed ZIP local header: ${name}`);
    const localNameLength = u16(view, localOffset + 26), localExtraLength = u16(view, localOffset + 28);
    const localName = decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    if (localName !== name) throw new Error(`ZIP filename mismatch: ${name}`);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > centralOffset) throw new Error(`Truncated or overlapping ZIP entry: ${name}`);
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = await inflateRaw(compressed);
    else throw new Error(`Unsupported ZIP compression method ${method}: ${name}`);
    if (data.byteLength !== uncompressedSize) throw new Error(`ZIP size mismatch: ${name}`);
    if (crc32(data) !== expectedCrc) throw new Error(`ZIP checksum mismatch: ${name}`);
    files.set(name, data);
  }
  return files;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
function crc32(bytes) { let crc = 0xffffffff; for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function crc32Update(crc, bytes) { for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8); return crc; }

export async function checksumContent(content, { signal, onProgress } = {}) {
  let crc = 0xffffffff, size = 0;
  const consume = bytes => { size += bytes.byteLength; crc = crc32Update(crc, bytes); };
  if (content instanceof Blob) {
    if (typeof content.stream === "function") {
      const reader = content.stream().getReader();
      while (true) {
        if (signal?.aborted) { await reader.cancel(); throw new DOMException("Operation cancelled.", "AbortError"); }
        const { value, done } = await reader.read(); if (done) break;
        consume(value); onProgress?.(size, content.size);
      }
    } else {
      for (let offset = 0; offset < content.size; offset += 1024 * 1024) {
        if (signal?.aborted) throw new DOMException("Operation cancelled.", "AbortError");
        consume(new Uint8Array(await content.slice(offset, offset + 1024 * 1024).arrayBuffer())); onProgress?.(size, content.size);
      }
    }
  } else {
    const bytes = content instanceof Uint8Array ? content : content instanceof ArrayBuffer ? new Uint8Array(content) : encoder.encode(String(content));
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
      if (signal?.aborted) throw new DOMException("Operation cancelled.", "AbortError");
      consume(bytes.subarray(offset, Math.min(bytes.length, offset + 1024 * 1024))); onProgress?.(size, bytes.length);
      if (offset) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  return { size, crc32: (crc ^ 0xffffffff) >>> 0 };
}
function concat(chunks) { const length = chunks.reduce((sum, item) => sum + item.length, 0), out = new Uint8Array(length); let at = 0; for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; } return out; }

export function writeZip(entries) {
  const local = [], central = [];
  let offset = 0;
  const list = entries instanceof Map ? [...entries] : Object.entries(entries);
  if (list.length > MAX_ENTRIES) throw new Error("Too many files for ZIP export.");
  let totalBytes = 0;
  for (const [name, content] of list) {
    if (!validateArchivePath(name) || name.endsWith("/")) throw new Error(`Unsafe ZIP export path: ${name}`);
    const nameBytes = encoder.encode(name), data = content instanceof Uint8Array ? content : new Uint8Array(content);
    totalBytes += data.byteLength;
    if (data.byteLength > MAX_ENTRY_BYTES || totalBytes > MAX_TOTAL_BYTES) throw new Error("ZIP export exceeds entry or expanded-size limits.");
    const checksum = crc32(data), header = new Uint8Array(30 + nameBytes.length), hv = new DataView(header.buffer);
    hv.setUint32(0, 0x04034b50, true); hv.setUint16(4, 20, true); hv.setUint16(6, 0x0800, true); hv.setUint32(14, checksum, true); hv.setUint32(18, data.length, true); hv.setUint32(22, data.length, true); hv.setUint16(26, nameBytes.length, true); header.set(nameBytes, 30); local.push(header, data);
    const record = new Uint8Array(46 + nameBytes.length), rv = new DataView(record.buffer);
    rv.setUint32(0, 0x02014b50, true); rv.setUint16(4, 20, true); rv.setUint16(6, 20, true); rv.setUint16(8, 0x0800, true); rv.setUint32(16, checksum, true); rv.setUint32(20, data.length, true); rv.setUint32(24, data.length, true); rv.setUint16(28, nameBytes.length, true); rv.setUint32(42, offset, true); record.set(nameBytes, 46); central.push(record); offset += header.length + data.length;
  }
  const directory = concat(central), end = new Uint8Array(22), dv = new DataView(end.buffer);
  dv.setUint32(0, 0x06054b50, true); dv.setUint16(8, list.length, true); dv.setUint16(10, list.length, true); dv.setUint32(12, directory.length, true); dv.setUint32(16, offset, true);
  return concat([...local, directory, end]);
}

/** Creates a stored ZIP Blob without concatenating large source blobs into a second archive-sized buffer. */
export async function writeZipBlob(entries, options = {}) {
  const list = entries instanceof Map ? [...entries] : Object.entries(entries);
  const maxEntries = options.maxEntries ?? 10000;
  const maxTotalBytes = options.maxTotalBytes ?? 1024 * 1024 * 1024;
  const label = options.label || "Project archive";
  if (list.length > maxEntries || list.length > 65535) throw new Error(`Too many files for ${label} export.`);
  const local = [], central = [], checksumMap = options.checksums || new Map();
  let offset = 0, totalBytes = 0;
  for (let index = 0; index < list.length; index++) {
    if (options.signal?.aborted) throw new DOMException("Operation cancelled.", "AbortError");
    const [name, raw] = list[index];
    if (!validateArchivePath(name) || name.endsWith("/")) throw new Error(`Unsafe ZIP export path: ${name}`);
    const content = raw instanceof Blob ? raw : raw instanceof Uint8Array ? new Blob([raw]) : raw instanceof ArrayBuffer ? new Blob([raw]) : new Blob([String(raw)]);
    const size = content.size;
    totalBytes += size;
    if (size > 0xffffffff || totalBytes > maxTotalBytes || offset + size > 0xffffffff) throw new Error(`${label} exceeds the supported 1 GiB ZIP32 size limit.`);
    const nameBytes = encoder.encode(name);
    let checksum = checksumMap.get(name);
    if (checksum === undefined) checksum = (await checksumContent(content, { signal: options.signal })).crc32;
    const header = new Uint8Array(30 + nameBytes.length), hv = new DataView(header.buffer);
    hv.setUint32(0, 0x04034b50, true); hv.setUint16(4, 20, true); hv.setUint16(6, 0x0800, true);
    hv.setUint32(14, checksum, true); hv.setUint32(18, size, true); hv.setUint32(22, size, true); hv.setUint16(26, nameBytes.length, true); header.set(nameBytes, 30);
    local.push(header, content);
    const record = new Uint8Array(46 + nameBytes.length), rv = new DataView(record.buffer);
    rv.setUint32(0, 0x02014b50, true); rv.setUint16(4, 20, true); rv.setUint16(6, 20, true); rv.setUint16(8, 0x0800, true);
    rv.setUint32(16, checksum, true); rv.setUint32(20, size, true); rv.setUint32(24, size, true); rv.setUint16(28, nameBytes.length, true); rv.setUint32(42, offset, true); record.set(nameBytes, 46); central.push(record);
    offset += header.length + size;
    options.onProgress?.({ stage: "archive", current: index + 1, total: list.length, filename: name });
    if (index % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  const directory = new Blob(central).size, end = new Uint8Array(22), dv = new DataView(end.buffer);
  dv.setUint32(0, 0x06054b50, true); dv.setUint16(8, list.length, true); dv.setUint16(10, list.length, true); dv.setUint32(12, directory, true); dv.setUint32(16, offset, true);
  return new Blob([...local, ...central, end], { type: "application/zip" });
}
