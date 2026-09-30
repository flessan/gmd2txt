export function createSaveDocument({ id, files = {}, decoded = {}, normalized = {}, metadata = {}, source = {} }) {
  return {
    type: "save",
    id,
    files: { gameManager: null, localLevels: null, ...files },
    decoded: { gameManager: null, localLevels: null, ...decoded },
    normalized: { gameManager: null, localLevels: [], ...normalized },
    metadata: { platform: "unknown", gameVersion: null, binaryVersion: null, encoding: null, importedAt: Date.now(), ...metadata },
    source: { filenames: [], ...source }
  };
}
