const normalize = value => String(value ?? "").normalize("NFKD").toLowerCase().trim();

export function matchesSearch(query, fields) {
  const needle = normalize(query);
  if (!needle) return true;
  return fields.some(value => normalize(value).includes(needle));
}

export function searchLevelRecords(records, query, audioAssets = []) {
  const audioById = new Map(audioAssets.map(asset => [asset.id, asset]));
  return records.filter(record => {
    const document = record.document || record;
    const app = record.applicationMetadata || {};
    const localAudio = app.audioOverride?.assetId ? audioById.get(app.audioOverride.assetId) : null;
    return matchesSearch(query, [
      document.metadata?.name, document.metadata?.author, document.metadata?.levelId,
      document.metadata?.song?.name, document.metadata?.song?.id, document.source?.filename,
      ...(app.tags || []), app.notes, localAudio?.displayName, localAudio?.filename
    ]);
  });
}

export function searchAudioAssets(assets, query) {
  return assets.filter(asset => matchesSearch(query, [asset.displayName, asset.filename, asset.mimeType, asset.artist, asset.album, asset.notes, asset.gdSongId]));
}
