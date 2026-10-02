import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The play preview is the one place where the converter talks to the vendored
 * Geometry Dash runtime, so its contract is pinned here: the runtime publishes a
 * game handle, every context can start playing by itself, and the app never
 * re-parents a booted iframe (moving an iframe makes browsers boot it again,
 * which is what used to throw the pre-warmed runtime away).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFile(path.join(root, file), "utf8");

const sceneFile = "app/play/assets/scripts/core/game-scene.js";
const bridgeFile = "app/play/assets/scripts/core/gmdplayer-bridge.js";
const runtimeMainFile = "app/play/assets/scripts/core/main.js";
const adapterFile = "core/runtime/player-adapter.js";
const appMainFile = "app/views/convert.js";
const appShellFile = "app/index.html";

test("the runtime publishes its game handle and nothing resolves Phaser.GAMES only", async () => {
  const [runtimeMain, bridge, adapter] = await Promise.all([
    read(runtimeMainFile),
    read(bridgeFile),
    read(adapterFile)
  ]);
  assert.match(runtimeMain, /window\.gmdRuntimeGame\s*=\s*new Phaser\.Game\(/, "the runtime must expose the running game");
  for (const [name, source] of [["bridge", bridge], ["adapter", adapter]]) {
    assert.match(source, /gmdRuntimeGame/, `${name} must prefer window.gmdRuntimeGame`);
    const lookups = source.match(/Phaser\?\.GAMES/g) || [];
    for (const lookup of lookups) {
      assert.ok(
        source.includes(`gmdRuntimeGame || window.Phaser?.GAMES`) || /win\?\.gmdRuntimeGame \|\| win\?\.Phaser\?\.GAMES/.test(source),
        `${name} must only use Phaser.GAMES as a fallback (found ${lookup})`
      );
    }
  }
});

test("no runtime context can end on a waiting-for-level dead end", async () => {
  const scene = await read(sceneFile);
  assert.doesNotMatch(scene, /Waiting for level/, "the standalone \"waiting for level\" panel is gone");
  assert.doesNotMatch(scene, /GMDPlayer is ready\. Send a level to the runtime to begin\./);
  // A runtime that is embedded but never receives a hand-off plays a bundled level.
  assert.match(scene, /startBundledLevel\(\)/);
  assert.match(scene, /window\.gmdplayerHoldForLevel \? 30000 : 1500/);
  assert.match(scene, /window\.currentlevel\?\.\[2\]/);
  // Bundled level text is fetched rather than pushed through the scene loader,
  // which may already be shut down when the fallback runs.
  assert.match(scene, /fetch\("assets\/levels\/" \+ runtimeMatch\[1\] \+ "\.txt"\)/);
});

test("a runtime opened on its own ignores its own messages", async () => {
  const bridge = await read(bridgeFile);
  assert.match(bridge, /if \(window\.parent === window\) return;/, "self-messages must not count as a hand-off");
  assert.match(bridge, /window\._gmdplayerHandoffRequested = true/);
  for (const type of ["load-level", "play", "pause", "restart", "park", "exit"]) {
    assert.match(bridge, new RegExp(`"${type}"`), `the bridge must handle ${type}`);
    assert.match(bridge, new RegExp(`type === "${type}"`), `the bridge must react to ${type}`);
  }
});

test("the usual jump keys reach gameplay, which is pointer-only in the bundled build", async () => {
  const bridge = await read(bridgeFile);
  assert.match(bridge, /JUMP_KEYS/);
  assert.match(bridge, /scene\._pushButton\?\.\(\)/, "keys must use the same entry point as the pointer path");
  assert.match(bridge, /scene\._releaseButton\?\.\(\)/);
  assert.match(bridge, /if \(event\.repeat \|\| !JUMP_KEYS\.has\(event\.key\)\) return;/, "held keys must not repeat-press");
  assert.match(bridge, /scene\._menuActive \|\| scene\._paused \|\| scene\._levelWon/, "keys must not act in menus, pause or the end screen");
  assert.match(bridge, /window\.addEventListener\("blur"/, "a key held while losing focus must be released");
});

test("the player adapter can adopt a pre-warmed frame without moving it", async () => {
  const adapter = await read(adapterFile);
  assert.match(adapter, /const adopted = options\.frame \|\| null;/);
  assert.match(adapter, /if \(!adopted\) \{[\s\S]*?mount\.replaceChildren\(frame\);/u, "only a fresh frame may be mounted");
  assert.match(adapter, /options\.staged === true/, "staged hand-offs resume instantly");
  assert.match(adapter, /this\._keepAlive = options\.keepAlive === true;/);
  assert.match(adapter, /if \(frame && !this\._keepAlive\) frame\.remove\(\);/);
  assert.match(adapter, /park\(\)\s*\{[\s\S]*?type: "park"/, "the adapter must be able to park the runtime");
});

test("the converter boots the runtime early and parks it off screen instead of a dialog", async () => {
  const [app, shell] = await Promise.all([read(appMainFile), read(appShellFile)]);
  assert.doesNotMatch(shell, /id="player-park"/, "the parked iframe must not be re-parented between containers");
  assert.match(shell, /id="player-overlay"[^>]*class="player-overlay is-parked"/, "the preview starts parked");
  assert.match(shell, /id="player-stage"/);
  assert.match(app, /scheduleWarmRuntime\(900, entry\)/, "converting a level must start the runtime in the background");
  assert.match(app, /&hold=1/, "the pre-warmed runtime waits for its level instead of starting one");
  assert.match(app, /stageWarmLevel/, "the converted level is handed over before the preview is opened");
  assert.match(app, /warmRuntime\.loadedKey === key/, "a staged level is only resumed when it really is loaded");
  assert.match(app, /runtimeFrameMessage/);
  assert.match(app, /data\.type === "level-loaded"/);
  assert.match(app, /document\.body\.classList\.add\("has-player"\)/);
  assert.match(app, /releaseWarmRuntime/, "a hidden runtime must not live forever");
  assert.match(app, /setTimeout\(releaseWarmRuntime, 10 \* 60 \* 1000\)/);
});

test("the preview does not move an iframe that is already running", async () => {
  const [app, css] = await Promise.all([read(appMainFile), read("app/assets/workspace.css")]);
  // The only place a frame may be created is the warm-up, and it is appended to
  // the stage it will be shown in.
  const creations = app.match(/document\.createElement\("iframe"\)/g) || [];
  assert.equal(creations.length, 1, "the app must create exactly one runtime frame");
  assert.match(app, /dom\.playerStage\.replaceChildren\(frame\)/);
  assert.doesNotMatch(app, /playerPark/);
  assert.match(css, /\.player-overlay\.is-parked \{[\s\S]*?visibility: hidden;/);
  assert.match(css, /\.player-overlay\.is-parked \{[\s\S]*?left: -20000px;/);
});

test("parking the runtime silences and rewinds it for an instant replay", async () => {
  const bridge = await read(bridgeFile);
  const park = bridge.slice(bridge.indexOf('message.type === "park"'), bridge.indexOf('message.type === "exit"'));
  assert.match(park, /_pauseGame/, "a parked runtime must be paused");
  assert.match(park, /_restartLevel/, "a parked runtime restarts the level so replays begin at the first obstacle");
  assert.match(park, /sound\.mute = true/, "a parked runtime must be silent");
  // The runtime refuses to pause during the level intro, so parking retries.
  assert.match(park, /const settle = \(\) =>/, "parking must retry the pause until it takes");
  assert.match(park, /if \(\+\+attempts > 8\) return;/);
});
