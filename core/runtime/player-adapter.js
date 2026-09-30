export const PLAYER_RUNTIME_URL = new URL("../../app/play/index.html?gmdplayer=1", import.meta.url).href;

export class PlayerAdapter {
  constructor({ onExit = () => {}, onError = () => {}, onWarning = () => {}, onProgress = () => {} } = {}) {
    this.onExit = onExit;
    this.onError = onError;
    this.onWarning = onWarning;
    this.onProgress = onProgress;
    this.iframe = null;
    this._audioObjectUrl = null;
    this.levelId = null;
    this._readyHandler = null;
    this._readyTimer = null;
    this._rejectReady = null;
    this._onMessage = event => {
      if (event.source !== this.iframe?.contentWindow || event.origin !== globalThis.location?.origin || event.data?.channel !== "gmdplayer-runtime") return;
      if (event.data.type === "error") this.onError(event.data.message || "The player could not open this level.");
      if (event.data.type === "warning") this.onWarning(event.data.message || "The local song could not be played; using the level's original song behavior.");
      if (event.data.type === "progress") this.onProgress(event.data.progress);
      if (event.data.type === "exit-request") this.stop();
    };
    this._onKey = event => { if (event.key === "Escape") this.exit(); };
  }

  async load(levelDocument, mount, options = {}) {
    if (!levelDocument?.content?.raw) throw new Error("This level has no source level string.");
    this.stop(false);
    this.levelId = levelDocument.id;
    if (options.localAudio?.blob) {
      if (globalThis.URL?.createObjectURL) this._audioObjectUrl = URL.createObjectURL(options.localAudio.blob);
      else this.onWarning("This browser cannot pass a local audio file to the player; the original song behavior will be used.");
    }
    const frame = document.createElement("iframe");
    frame.className = "player-frame";
    frame.title = `Playing ${levelDocument.metadata.name}`;
    frame.allow = "autoplay; fullscreen";
    frame.allowFullscreen = true;
    this.iframe = frame;
    window.addEventListener("message", this._onMessage);
    window.addEventListener("keydown", this._onKey);
    const ready = new Promise((resolve, reject) => {
      this._rejectReady = reject;
      this._readyTimer = setTimeout(() => {
        if (this._readyHandler) window.removeEventListener("message", this._readyHandler);
        this._readyHandler = null; this._readyTimer = null; this._rejectReady = null;
        reject(new Error("The player did not respond in time. Check that local player files are available, then retry."));
      }, 60000);
      this._readyHandler = event => {
        if (event.source !== frame.contentWindow || event.origin !== globalThis.location?.origin || event.data?.channel !== "gmdplayer-runtime" || event.data.type !== "ready") return;
        window.removeEventListener("message", this._readyHandler); clearTimeout(this._readyTimer);
        this._readyHandler = null; this._readyTimer = null; this._rejectReady = null; resolve();
      };
      window.addEventListener("message", this._readyHandler);
    });
    frame.src = PLAYER_RUNTIME_URL;
    mount.replaceChildren(frame);
    try { await ready; } catch (error) { this.stop(false); throw error; }
    this._send({
      type: "load-level",
      document: levelDocument,
      localAudio: this._audioObjectUrl ? { url: this._audioObjectUrl, displayName: options.localAudio.displayName || "Local song" } : null
    });
    return true;
  }

  _send(message) {
    this.iframe?.contentWindow?.postMessage({ channel: "gmdplayer-runtime", ...message }, new URL(PLAYER_RUNTIME_URL).origin);
  }
  play() { this._send({ type: "play" }); }
  pause() { this._send({ type: "pause" }); }
  restart() { this._send({ type: "restart" }); }
  exit() { this._send({ type: "exit" }); }
  stop(notify = true) {
    if (this._readyHandler) window.removeEventListener("message", this._readyHandler);
    if (this._readyTimer) clearTimeout(this._readyTimer);
    const rejectReady = this._rejectReady; this._readyHandler = null; this._readyTimer = null; this._rejectReady = null;
    if (rejectReady) rejectReady(new DOMException("Player loading cancelled.", "AbortError"));
    window.removeEventListener("message", this._onMessage);
    window.removeEventListener("keydown", this._onKey);
    if (this.iframe) this.iframe.remove();
    if (this._audioObjectUrl) globalThis.URL?.revokeObjectURL?.(this._audioObjectUrl);
    this._audioObjectUrl = null;
    this.iframe = null;
    this.levelId = null;
    if (notify) this.onExit();
  }
}
