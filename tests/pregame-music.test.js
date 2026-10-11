import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The pre-game start screen and the soundtrack contract are pinned here:
 * before a level boots, the player picks "music" or "no music" (standalone in
 * the runtime page, inside the workspace via the start sheet); music must
 * actually play — an unlocked AudioContext, a gated enable flag, and a bundled
 * chiptune fallback that cannot fail to load — and the game frame keeps its
 * animated 8-bit pixel sky.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFile(path.join(root, file), "utf8");

const playPageFile = "app/play/index.html";
const pregameFile = "app/play/assets/scripts/core/pregame.js";
const configFile = "app/play/assets/scripts/utils/config.js";
const audioFile = "app/play/assets/scripts/core/audio.js";
const loadingFile = "app/play/assets/scripts/core/loading-screen.js";
const bridgeFile = "app/play/assets/scripts/core/gmdplayer-bridge.js";
const sceneFile = "app/play/assets/scripts/core/game-scene.js";
const pixelSkyFile = "app/play/assets/scripts/utils/pixel-sky.js";
const playStyleFile = "app/play/assets/style.css";
const appShellFile = "app/index.html";
const appConvertFile = "app/views/convert.js";
const appCssFile = "app/assets/workspace.css";
const adapterFile = "core/runtime/player-adapter.js";
const swFile = "sw.js";

test("the standalone runtime shows a music-or-silence start screen before the level", async () => {
  const [page, pregame, config] = await Promise.all([
    read(playPageFile),
    read(pregameFile),
    read(configFile)
  ]);

  // The start screen markup with both choices and the remember-me opt-out.
  assert.match(page, /id="pregame-music"/, "the page needs the play-with-music button");
  assert.match(page, /id="pregame-silent"/, "the page needs the play-without-music button");
  assert.match(page, /id="pregame-remember"/, "the page needs the remember-my-choice control");
  assert.match(page, /id="pregame-sky"/, "the page needs the pixel-sky backdrop canvas");

  // The scripts that drive the screen load before the scene code consumes the
  // choice promise, and after the config that defines the embedded flag.
  const configAt = page.indexOf("assets/scripts/utils/config.js");
  const skyAt = page.indexOf("assets/scripts/utils/pixel-sky.js");
  const pregameAt = page.indexOf("assets/scripts/core/pregame.js");
  const sceneAt = page.indexOf("assets/scripts/core/game-scene.js");
  assert.ok(configAt >= 0 && skyAt > configAt, "pixel-sky.js loads after config.js");
  assert.ok(pregameAt > skyAt, "pregame.js loads after pixel-sky.js");
  assert.ok(sceneAt > pregameAt, "pregame.js loads before game-scene.js consumes its promise");

  // The choice is published as a promise plus the enable flag the audio and
  // bridge modules read, and it is remembered under the shared storage key.
  assert.match(pregame, /window\.gmdplayerAwaitStartChoice\s*=/, "the choice must be awaitable");
  assert.match(pregame, /window\.gmdMusicEnabled\s*=/, "the choice must set the music enable flag");
  assert.match(pregame, /gmd-play-music/, "the remembered choice uses the shared storage key");
  assert.match(config, /gmdMusicEnabled/, "config resolves the music preference");
  assert.match(config, /gmd-play-music/, "config reads the same remembered choice key");

  // Embedded previews never show the standalone screen: the workspace asks.
  assert.match(pregame, /gmdplayerEmbedded|gmdplayer/, "the screen must skip embedded previews");
});

test("music actually plays: unlock, gate and a bundled fallback song", async () => {
  const [audio, loading, bridge] = await Promise.all([
    read(audioFile),
    read(loadingFile),
    read(bridgeFile)
  ]);

  // The bundled chiptune is preloaded like any other song…
  assert.match(loading, /load\.audio\("pixel_sky"/, "the fallback song is preloaded");
  assert.match(loading, /PixelSky\.wav/, "the fallback song points at the bundled WAV");

  // …and plays whenever a level song cannot, so music is never silent.
  assert.match(audio, /_startPixelFallback/, "the audio manager needs the fallback path");
  assert.match(audio, /"pixel_sky"/, "the fallback path plays the preloaded chiptune");

  // "Without music" really is silent, and the flag is honoured at every start.
  assert.match(audio, /gmdMusicEnabled\s*===\s*false/, "music start must respect the disable flag");
  assert.match(audio, /startMusic\s*\(/, "gameplay music keeps its entry point");
  assert.match(audio, /startMenuMusic\s*\(/, "menu music keeps its entry point");

  // A gesture or a workspace message unlocks the suspended AudioContext —
  // the historical reason the game "had no music".
  assert.match(bridge, /unlockAudio/, "the bridge unlocks audio on interaction");
  assert.match(bridge, /context\?\.resume\?\.|context\.resume\(\)|sound\.context\.resume/, "unlocking resumes the context");
  assert.match(bridge, /type === "music"|type === 'music'/, "the bridge handles the music message");
});

test("the workspace asks before it starts and hands the choice to the runtime", async () => {
  const [shell, convert, adapter] = await Promise.all([
    read(appShellFile),
    read(appConvertFile),
    read(adapterFile)
  ]);

  // The M3 start sheet with both choices, a remember control and dismissers.
  assert.match(shell, /id="start-dialog"/, "the workspace needs the start sheet");
  assert.match(shell, /id="start-title"/, "the start sheet names the level");
  assert.match(shell, /id="start-with-music"/, "the start sheet has the music choice");
  assert.match(shell, /id="start-without-music"/, "the start sheet has the silent choice");
  assert.match(shell, /id="start-remember"/, "the start sheet can remember the choice");
  assert.match(shell, /data-start-close/, "the start sheet can be dismissed");

  // The pre-game choice drives the run and the player-bar toggle.
  assert.match(convert, /function requestStartChoice/, "the choice is asked before every start");
  assert.match(convert, /gmd-play-music/, "the workspace shares the storage key with the runtime");
  assert.match(convert, /musicEnabled/, "the choice reaches the adapter");
  assert.match(convert, /setPlayerMusicState/, "the player bar reflects the choice");
  assert.match(convert, /id="player-music"|#player-music/, "the player bar has a music toggle");

  // The adapter carries the choice into the runtime before the first play.
  assert.match(adapter, /setMusic\s*\(/, "the adapter exposes the music control");
  assert.match(adapter, /type: "music"/, "the adapter sends the music message");
  assert.match(adapter, /options\.musicEnabled/, "the load options carry the music choice");
});

test("the game frame keeps its animated 8-bit pixel sky", async () => {
  const [sky, page, style, shell, convert, css, workspace] = await Promise.all([
    read(pixelSkyFile),
    read(playPageFile),
    read(playStyleFile),
    read(appShellFile),
    read(appConvertFile),
    read(appCssFile),
    read("app/workspace.js")
  ]);

  assert.match(sky, /window\.GmdPixelSky\s*=/, "the sky helper is shared on window");
  assert.match(sky, /mount\s*\(/, "the sky helper exposes mount");
  assert.match(sky, /destroy/, "the sky helper can be torn down again");
  assert.match(page, /pregame-sky|sky-backdrop/, "the runtime page mounts the sky canvas");
  assert.match(style, /#pregame-sky|\.sky-backdrop/, "the runtime style places the sky behind the game");
  assert.match(style, /\.pixel-btn-primary/, "the start screen keeps its 8-bit button styling");

  // The same sky decorates the workspace play room.
  assert.match(shell, /id="play-sky"/, "the play room has a sky canvas");
  assert.match(convert, /GmdPixelSky\.mount/, "the play room mounts the sky");
  assert.match(workspace, /mountPlaySky/, "the shell paints the sky when the room opens");
  assert.match(css, /\.play-sky-stage/, "the workspace styles the sky stage");
});

test("offline keeps the soundtrack fallback in the shell cache", async () => {
  const sw = await read(swFile);
  assert.match(sw, /PixelSky\.wav/, "the fallback song is part of the shell cache");
  assert.match(sw, /pregame\.js/, "the start screen script is part of the shell cache");
  assert.match(sw, /pixel-sky\.js/, "the sky script is part of the shell cache");
  assert.match(sw, /mp3\|wav\|ogg/, "runtime audio is cacheable at runtime");
  const wav = await stat(path.join(root, "app/play/assets/music/PixelSky.wav"));
  assert.ok(wav.size > 1000, "the bundled fallback song is a real audio file");
});

test("the existing player contract is untouched by the start screen", async () => {
  const [shell, css, convert, adapter, scene] = await Promise.all([
    read(appShellFile),
    read(appCssFile),
    read(appConvertFile),
    read(adapterFile),
    read(sceneFile)
  ]);

  // Parked-off-screen preview rig (pinned).
  assert.match(shell, /player-overlay" class="player-overlay is-parked/, "the parked overlay markup is unchanged");
  assert.match(shell, /id="player-stage"/, "the player stage keeps its id");
  assert.doesNotMatch(shell, /id="player-park"/, "no parked-by-id rewrite");
  assert.match(css, /\.player-overlay\.is-parked \{[^}]*visibility: hidden;/, "the parked rule keeps its treatment");
  assert.match(css, /\.player-overlay\.is-parked \{[^}]*left: -20000px;/, "the parked rule keeps its off-screen left");

  // Warm-runtime handoff (pinned).
  assert.match(convert, /scheduleWarmRuntime\(900, entry\)/, "the warm runtime is still scheduled");
  assert.match(convert, /&hold=1/, "the warm frame still waits for its level");
  const frames = convert.match(/document\.createElement\("iframe"\)/g) || [];
  assert.equal(frames.length, 1, "exactly one place creates the preview iframe");

  // Runtime handshake (pinned).
  assert.match(adapter, /options\.staged === true/, "staged loads still skip the re-send");
  assert.match(adapter, /options\.keepAlive === true/, "keepAlive is honoured");
  assert.match(adapter, /mount\.replaceChildren\(frame\)/, "the frame is mounted without re-parenting");

  // The scene-level pre-game gate never introduces the dead-end strings.
  assert.doesNotMatch(scene, /Waiting for level/, "no waiting-for-level dead end");
  assert.doesNotMatch(scene, /GMDPlayer is ready/, "no ready-splash regression");
  assert.match(scene, /gmdplayerAwaitStartChoice/, "the scene awaits the pre-game choice");
});
