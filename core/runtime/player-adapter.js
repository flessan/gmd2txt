export const PLAYER_RUNTIME_URL = new URL("../../app/play/index.html?gmdplayer=1", import.meta.url).href;

function getRuntime(frame) {
  const win = frame?.contentWindow;
  const game = win?.Phaser?.GAMES?.[0];
  if (!game) return null;
  try {
    const scene = game.scene.getScene("GameScene");
    if (scene?.sys?.isActive()) return { win, game, scene };
  } catch (_) {}
  return null;
}

function waitForRuntime(frame, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const runtime = getRuntime(frame);
      if (runtime) return resolve(runtime);
      if (Date.now() - started >= timeout) {
        reject(new Error("The Geometry Dash runtime did not finish starting. Check that the player assets are available."));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

function resolveSong(win, document) {
  const song = document.metadata?.song || {};
  let songKey = "stereo_madness";
  let songAuthor = song.artist || "Unknown";
  if (song.type === "custom" && Number(song.id) > 0) {
    songKey = `ng_song_${song.id}`;
  } else if (song.type === "official" && Number.isFinite(Number(song.id))) {
    const official = win.allLevels?.[Number(song.id)];
    if (official) {
      songKey = official[0] || songKey;
      songAuthor = official[3]?.[1] || songAuthor;
    }
  }
  return { songKey, songAuthor };
}

export class PlayerAdapter {
  constructor({ onExit = () => {}, onError = () => {}, onWarning = () => {}, onProgress = () => {} } = {}) {
    this.onExit = onExit;
    this.onError = onError;
    this.onWarning = onWarning;
    this.onProgress = onProgress;
    this.iframe = null;
    this._audioObjectUrl = null;
    this._runtime = null;
    this.levelId = null;
    this._readyTimer = null;
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
    frame.title = `Playing ${levelDocument.metadata?.name || "Geometry Dash level"}`;
    frame.allow = "autoplay; fullscreen; gamepad";
    frame.allowFullscreen = true;
    frame.setAttribute("aria-label", frame.title);
    this.iframe = frame;
    window.addEventListener("message", this._onMessage);
    window.addEventListener("keydown", this._onKey);
    mount.replaceChildren(frame);
    frame.src = PLAYER_RUNTIME_URL;

    try {
      const runtime = await waitForRuntime(frame);
      this._runtime = runtime;
      const { win, game } = runtime;
      win.isEditor = false;
      win.levelID = null;
      const { songKey, songAuthor } = resolveSong(win, levelDocument);
      let localSongBuffer = null;

      if (this._audioObjectUrl) {
        try {
          const context = game.sound?.context;
          if (!context) throw new Error("The player audio context is unavailable.");
          if (context.state === "suspended") await context.resume().catch(() => {});
          const response = await fetch(this._audioObjectUrl);
          if (!response.ok) throw new Error("The local audio file could not be read.");
          const encoded = await response.arrayBuffer();
          localSongBuffer = await context.decodeAudioData(encoded.slice(0));
        } catch (error) {
          this.onWarning(`Could not play “${options.localAudio.displayName || "local audio"}”; using the level's original song behavior. ${error.message || "Unsupported audio format."}`);
        }
      }

      const runtimeOrigin = new URL(PLAYER_RUNTIME_URL).origin;
      const loadMessage = {
        channel: "gmdplayer-runtime",
        type: "load-level",
        document: levelDocument,
        localAudio: this._audioObjectUrl
          ? {
              url: this._audioObjectUrl,
              displayName: options.localAudio?.displayName || "Local song"
            }
          : null
      };

      const waitForLevelLoad = new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          window.removeEventListener("message", onMessage);
          callback(value);
        };
        const onMessage = event => {
          if (
            event.source !== frame.contentWindow ||
            event.origin !== runtimeOrigin ||
            event.data?.channel !== "gmdplayer-runtime"
          ) return;

          if (
            event.data.type === "level-loaded" &&
            String(event.data.id) === String(levelDocument.id)
          ) {
            finish(resolve, true);
          } else if (event.data.type === "error") {
            finish(reject, new Error(
              event.data.message || "The Geometry Dash runtime could not load this level."
            ));
          }
        };

        timer = setTimeout(() => {
          finish(reject, new Error(
            "The Geometry Dash runtime did not acknowledge the level load."
          ));
        }, 15000);

        window.addEventListener("message", onMessage);
        frame.contentWindow.postMessage(loadMessage, runtimeOrigin);
      });

      try {
        await waitForLevelLoad;
      } catch (bridgeError) {
        const direct = getRuntime(frame);
        if (!direct) throw bridgeError;

        const directWin = direct.win;
        const directGame = direct.game;
        directWin.isEditor = false;
        directWin.levelID = null;
        directWin.currentlevel = [
          songKey,
          levelDocument.metadata?.name || "Imported level",
          levelDocument.id,
          ["GMDPlayer", songAuthor]
        ];
        directWin._onlineLevelName = directWin.currentlevel[1];
        directWin._onlineLevelId = levelDocument.id;
        directWin._onlineLevelString = levelDocument.content.raw;
        directWin._onlineSongBuffer = localSongBuffer;
        directWin._onlineSongKey = localSongBuffer ? songKey : null;
        directWin._onlineSongOffset = 0;
        directWin._gmdplayerLocalSongKey = localSongBuffer ? songKey : null;
        directWin._onlineSongTitle = localSongBuffer
          ? (options.localAudio.displayName || "Local song")
          : null;
        directWin._onlineSongArtist = localSongBuffer ? "Local file" : null;
        try {
          directGame.cache.text.entries.set(levelDocument.id, levelDocument.content.raw);
        } catch (_) {}
        directGame.registry.set("autoStartGame", true);
        direct.scene.scene.restart();
      }

      const afterLoad = await new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const check = () => {
          const current = getRuntime(frame);
          if (
            current &&
            String(current.win.currentlevel?.[2]) === String(levelDocument.id) &&
            current.scene._menuActive === false
          ) {
            return resolve(current);
          }
          if (Date.now() - startedAt >= 15000) {
            return reject(new Error(
              "The level loaded, but the Geometry Dash runtime did not enter play mode."
            ));
          }
          setTimeout(check, 100);
        };
        check();
      });

      this._runtime = afterLoad;

      const started = await new Promise(resolve => {
        const startedAt = Date.now();
        const check = () => {
          const current = getRuntime(frame);
          const currentScene = current?.scene;
          if (current && current.win.currentlevel?.[2] === levelDocument.id && currentScene && currentScene._menuActive === false) {
            this._runtime = current;
            return resolve(true);
          }
          if (Date.now() - startedAt >= 12000) return resolve(false);
          setTimeout(check, 100);
        };
        check();
      });
      if (!started) {
        throw new Error("The level loaded into the Geometry Dash runtime, but the game did not enter play mode.");
      }

      try { frame.contentWindow.focus(); frame.focus(); } catch (_) {}
      window.clearTimeout(this._readyTimer);
      this._readyTimer = null;
      return true;
    } catch (error) {
      this.stop(false);
      throw error;
    }
  }

  _send(message) {
    this.iframe?.contentWindow?.postMessage({ channel: "gmdplayer-runtime", ...message }, new URL(PLAYER_RUNTIME_URL).origin);
  }

  _sceneCall(method, ...args) {
    const runtime = this._runtime || getRuntime(this.iframe);
    const scene = runtime?.scene;
    if (scene && typeof scene[method] === "function") {
      try { scene[method](...args); return true; } catch (_) {}
    }
    return false;
  }

  play() {
    const runtime = this._runtime || getRuntime(this.iframe);
    const scene = runtime?.scene;
    if (scene) {
      if (scene._paused && typeof scene._resumeGame === "function") return scene._resumeGame();
      if (scene._menuActive && typeof scene._startGame === "function") {
        scene._instantLevelStart = true;
        return scene._startGame();
      }
    }
    this._send({ type: "play" });
  }

  pause() {
    const runtime = this._runtime || getRuntime(this.iframe);
    const scene = runtime?.scene;
    if (scene && typeof scene._pauseGame === "function") {
      if (scene._paused) scene._resumeGame(); else scene._pauseGame();
      return;
    }
    this._send({ type: "pause" });
  }

  restart() {
    if (!this._sceneCall("_restartLevel")) this._send({ type: "restart" });
  }

  exit() {
    this.stop();
  }

  stop(notify = true) {
    window.removeEventListener("message", this._onMessage);
    window.removeEventListener("keydown", this._onKey);
    window.clearTimeout(this._readyTimer);
    this._readyTimer = null;
    if (this.iframe) this.iframe.remove();
    if (this._audioObjectUrl) globalThis.URL?.revokeObjectURL?.(this._audioObjectUrl);
    this._audioObjectUrl = null;
    this._runtime = null;
    this.iframe = null;
    this.levelId = null;
    if (notify) this.onExit();
  }
}
