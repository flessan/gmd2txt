/* ============================================================================
   Pre-game start screen — “include music or play without it”, before the run.
   ----------------------------------------------------------------------------
   The standalone player shows one clear choice over the pixel sky: play with
   the soundtrack, or play in silence. The choice can be remembered (localStorage
   `gmd-play-music`), and ?music=0|1 overrides it for a single visit. Embedded
   runtimes (the gmd2txt workspace) never show this screen — the embedding app
   asks the same question and sends the answer over the bridge.

   This script also owns the animated 8-bit sky: it is the backdrop of the whole
   game page (pre-game screen and gameplay alike), so it mounts unconditionally.
   ========================================================================== */
(function () {
  "use strict";

  const STORAGE_KEY = "gmd-play-music";
  const overlay = document.getElementById("pregame");
  const params = new URLSearchParams(location.search);
  const paramChoice = params.get("music"); // "0" | "1" | null

  // The animated 8-bit sky (clear sky, drifting clouds, bobbing sun) is the
  // game page's backdrop at all times — behind the start screen and the game.
  const sky = document.getElementById("pregame-sky");
  if (sky && window.GmdPixelSky) window.GmdPixelSky.mount(sky, { seed: 3, clouds: 6 });

  const remembered = (() => {
    try { return localStorage.getItem(STORAGE_KEY); } catch (_) { return null; }
  })();

  function storeChoice(enabled, remember) {
    if (!remember) return;
    try { localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off"); } catch (_) {}
  }

  function applyChoice(enabled, remember) {
    window.gmdMusicEnabled = enabled !== false;
    storeChoice(window.gmdMusicEnabled, remember);
    if (!window.gmdMusicEnabled) {
      // Silence means silence: stop anything that started before the choice.
      try { window.gmdRuntimeGame?.scene?.getScene("GameScene")?._audio?.stopMusic?.(); } catch (_) {}
    }
    // The click that made this choice is a user gesture: unlock audio now.
    try { window.gmdRuntimeGame?.sound?.context?.resume?.(); } catch (_) {}
  }

  function hide() {
    if (overlay) overlay.hidden = true;
  }

  // No start screen when embedded, when ?music= says so, or when the visitor
  // remembered a choice earlier.
  const embedded = !!window.gmdplayerEmbedded;
  const hasParam = paramChoice === "0" || paramChoice === "1";
  const hasMemory = remembered === "on" || remembered === "off";
  if (embedded || hasParam || hasMemory) {
    if (hasParam) window.gmdMusicEnabled = paramChoice !== "0";
    else if (hasMemory) window.gmdMusicEnabled = remembered === "on";
    hide();
    window.gmdplayerAwaitStartChoice = null;
    window.gmdplayerStartChosen = true;
    return;
  }

  // While the question is open, stay quiet — no menu music or fallback may
  // start before the player has picked. applyChoice sets the real value.
  window.gmdMusicEnabled = false;

  // The game waits on this promise before a bundled level begins.
  let resolveChoice = null;
  window.gmdplayerAwaitStartChoice = new Promise(resolve => { resolveChoice = resolve; });

  if (!overlay) {
    // Markup missing: fall back to playing with music rather than hanging.
    window.gmdMusicEnabled = true;
    window.gmdplayerAwaitStartChoice = null;
    window.gmdplayerStartChosen = true;
    return;
  }

  overlay.hidden = false;
  const rememberBox = document.getElementById("pregame-remember");
  const withMusic = document.getElementById("pregame-music");
  const withoutMusic = document.getElementById("pregame-silent");

  function choose(enabled) {
    return () => {
      applyChoice(enabled, Boolean(rememberBox?.checked));
      window.gmdplayerStartChosen = true;
      hide();
      resolveChoice?.({ music: window.gmdMusicEnabled });
      resolveChoice = null;
    };
  }

  withMusic?.addEventListener("click", choose(true));
  withoutMusic?.addEventListener("click", choose(false));
})();
