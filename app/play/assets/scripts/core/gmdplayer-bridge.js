/* Narrow postMessage adapter: all gameplay behavior stays in the legacy runtime. */
(function () {
  const CHANNEL = "gmdplayer-runtime";
  const send = (type, extra = {}) => window.parent.postMessage({ channel: CHANNEL, type, ...extra }, "*");

  function runtime() {
    const game = window.gmdRuntimeGame || window.Phaser?.GAMES?.[0];
    if (!game) return null;
    try {
      const scene = game.scene.getScene("GameScene");
      if (scene?.sys?.isActive()) return { game, scene };
    } catch (_) { /* Phaser is still booting. */ }
    return null;
  }

  function sendProgress(scene = runtime()?.scene) {
    const id = window.currentlevel?.[2];
    if (!id) return;
    send("progress", { progress: {
      id,
      normal: Number(localStorage.getItem(`bestPercent_${id}`) || 0),
      practice: Number(localStorage.getItem(`practiceBestPercent_${id}`) || 0),
      attempts: Number(scene?._levelAttempts || 0)
    } });
  }

  function waitForScene(timeout = 30000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        const instance = runtime();
        if (instance) return resolve(instance);
        if (Date.now() - start > timeout) return reject(new Error("The Geometry Dash runtime did not finish starting."));
        setTimeout(poll, 100);
      };
      poll();
    });
  }

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && window.parent !== window) {
      sendProgress();
      send("exit-request");
    }
  });

  // The bundled build only wires jumping to pointer input, so the usual Geometry
  // Dash keys are mirrored onto the very same entry points the pointer path uses.
  // Holding a key keeps `upKeyDown` set, which is also how auto-jumping works.
  const JUMP_KEYS = new Set([" ", "Spacebar", "ArrowUp", "Up", "w", "W"]);
  function keyboardJump(pressed) {
    const scene = runtime()?.scene;
    if (!scene || window.isEditor) return;
    if (scene._menuActive || scene._paused || scene._levelWon) return;
    if (pressed) {
      if (!scene._state?.upKeyDown) scene._pushButton?.();
    } else if (scene._state?.upKeyDown) {
      scene._releaseButton?.();
    }
  }

  window.addEventListener("keydown", event => {
    if (event.repeat || !JUMP_KEYS.has(event.key)) return;
    keyboardJump(true);
  });
  window.addEventListener("keyup", event => {
    if (!JUMP_KEYS.has(event.key)) return;
    keyboardJump(false);
  });
  // A key held while the player loses focus must not keep the cube jumping.
  window.addEventListener("blur", () => {
    const scene = runtime()?.scene;
    if (scene?._state?.upKeyDown) scene._releaseButton?.();
  });

  window.addEventListener("message", async event => {
    // A runtime opened on its own (window.parent === window) would otherwise
    // receive its own outgoing messages and wait forever for a level hand-off.
    if (window.parent === window) return;
    if (event.source !== window.parent || event.data?.channel !== CHANNEL) return;
    const message = event.data;
    window._gmdplayerHandoffRequested = true;
    try {
      const { game, scene } = await waitForScene();
      if (message.type === "load-level") {
        const doc = message.document;
        if (!doc?.content?.raw || !doc.id) throw new Error("The level document is incomplete.");
        window.levelID = null;
        const song = doc.metadata?.song || {};
        let songKey = "stereo_madness";
        let songAuthor = song.artist || "Unknown";
        if (song.type === "custom" && Number(song.id) > 0) {
          songKey = `ng_song_${song.id}`;
        } else if (song.type === "official" && Number.isFinite(Number(song.id))) {
          const official = window.allLevels?.[Number(song.id)];
          if (official) { songKey = official[0]; songAuthor = official[3]?.[1] || songAuthor; }
        }
        let localSongBuffer = null;
        if (message.localAudio?.url) {
          try {
            const context = game.sound?.context;
            if (!context) throw new Error("The player audio context is unavailable.");
            const response = await fetch(message.localAudio.url);
            if (!response.ok) throw new Error("The local audio file could not be read by the player.");
            const encodedAudio = await response.arrayBuffer();
            localSongBuffer = await context.decodeAudioData(encodedAudio.slice(0));
          } catch (audioError) {
            send("warning", { message: `Could not play “${message.localAudio.displayName || "local audio"}”; using the level's original song behavior. ${audioError.message || "Unsupported audio format."}` });
          }
        }
        window.currentlevel = [songKey, doc.metadata?.name || "Imported level", doc.id, ["GMDPlayer", songAuthor]];
        window._onlineLevelName = window.currentlevel[1];
        window._onlineLevelId = doc.id;
        window._onlineLevelString = doc.content.raw;
        window._onlineSongBuffer = localSongBuffer;
        window._onlineSongKey = localSongBuffer ? songKey : null;
        window._onlineSongOffset = 0;
        window._gmdplayerLocalSongKey = localSongBuffer ? songKey : null;
        window._onlineSongTitle = localSongBuffer ? (message.localAudio.displayName || "Local song") : null;
        window._onlineSongArtist = localSongBuffer ? "Local file" : null;
        try { game.cache.text.entries.set(doc.id, doc.content.raw); } catch (_) {}
        game.registry.set("autoStartGame", true);
        scene.scene.restart();
        // Phaser's create event is emitted after its scene create method has completed.
        await new Promise(resolve => {
          const current = game.scene.getScene("GameScene");
          const timer = setTimeout(resolve, 1200);
          current.events.once("create", () => { clearTimeout(timer); resolve(); });
        });
        send("level-loaded", { id: doc.id });
      } else if (message.type === "play") {
        if (scene._paused) scene._resumeGame();
        else if (scene._menuActive) scene._startGame();
      } else if (message.type === "pause") {
        if (scene._paused) scene._resumeGame(); else scene._pauseGame();
      } else if (message.type === "restart") {
        scene._restartLevel();
      } else if (message.type === "park") {
        // The embedder is hiding the frame: pause it, wind the level back to the
        // start and stay silent, so showing it again is instant.
        try {
          if (game?.sound) game.sound.mute = true;
          if (!scene._paused && typeof scene._pauseGame === "function") scene._pauseGame();
          if (typeof scene._restartLevel === "function") scene._restartLevel();
          // The runtime refuses to pause during a level's intro, so keep trying
          // until it takes: a parked runtime must not keep playing off-screen.
          let attempts = 0;
          const settle = () => {
            const current = runtime()?.scene;
            if (!current || current._paused === true || current._menuActive) return;
            if (++attempts > 8) return;
            if (typeof current._pauseGame === "function") current._pauseGame();
            if (current._paused !== true) setTimeout(settle, 500);
          };
          setTimeout(settle, 500);
        } catch (_) {}
      } else if (message.type === "exit") {
        sendProgress(scene);
        send("exit-request");
      }
    } catch (error) {
      send("error", { message: error?.message || String(error) });
    }
  });

  waitForScene(60000).then(() => send("ready")).catch(error => send("error", { message: error.message }));
})();
