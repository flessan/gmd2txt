const weakCache = new WeakMap();
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
async function digest(bytes) { if (!globalThis.crypto?.subtle) throw new Error("Content hashing requires Web Crypto in a secure local browser context."); return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); }
/** Bounded-memory deterministic SHA-256 fingerprint: hash 4 MiB chunks, then hash their digests with the byte length. */
export function hashFileContent(file, { signal, onProgress, chunkBytes = 4 * 1024 * 1024, cache = true } = {}) {
  if (cache && file && typeof file === "object" && weakCache.has(file)) return weakCache.get(file);
  const operation = (async () => {
    const size=file instanceof Uint8Array?file.byteLength:file?.size;
    if (!file || (!file.slice&&!(file instanceof Uint8Array)) || !Number.isFinite(size)) throw new TypeError("A file-like object is required for content hashing.");
    const chunkDigests = [];
    for (let offset = 0; offset < size; offset += chunkBytes) {
      if (signal?.aborted) throw new DOMException("Hashing cancelled.", "AbortError");
      const chunk = file instanceof Uint8Array?file.subarray(offset,Math.min(size,offset+chunkBytes)):new Uint8Array(await file.slice(offset, Math.min(size, offset + chunkBytes)).arrayBuffer());
      chunkDigests.push(await digest(chunk));
      onProgress?.({ current: Math.min(offset + chunkBytes, size), total: size });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const combined = new Uint8Array(8 + chunkDigests.length * 32), view = new DataView(combined.buffer);
    view.setBigUint64(0, BigInt(size), false);
    chunkDigests.forEach((chunk, index) => combined.set(chunk, 8 + index * 32));
    return `sha256-chunked-v1:${size}:${hex(await digest(combined))}`;
  })();
  if (cache && file && typeof file === "object") {
    weakCache.set(file, operation);
    operation.catch(() => { if (weakCache.get(file) === operation) weakCache.delete(file); });
  }
  return operation;
}
