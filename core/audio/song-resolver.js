/** Resolves an application-local override without changing the Geometry Dash song metadata. */
export class SongResolver {
  constructor({ getAudioAsset }) {
    if (typeof getAudioAsset !== "function") throw new TypeError("SongResolver requires a local audio lookup function.");
    this.getAudioAsset = getAudioAsset;
  }

  async resolve(levelRecord) {
    const override = levelRecord?.applicationMetadata?.audioOverride;
    const originalSong = levelRecord?.document?.metadata?.song || { type: "official", id: 0, name: "Unknown song" };
    if (override?.source === "local" && override.assetId) {
      const asset = await this.getAudioAsset(override.assetId);
      if (asset?.blob) return { type: "local", asset, fallbackSong: originalSong };
      return { type: "missing-local", assetId: override.assetId, fallbackSong: originalSong };
    }
    return { type: "runtime", song: originalSong };
  }
}
