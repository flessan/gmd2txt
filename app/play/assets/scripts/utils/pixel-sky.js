/* ============================================================================
   GmdPixelSky — an animated 8-bit sky in the spirit of a blocky overworld.
   ----------------------------------------------------------------------------
   A clear banded blue sky, a bobbing pixel sun, drifting blocky clouds and a
   grass-and-dirt horizon with a couple of square trees. Everything is drawn on
   a chunky pixel grid and never smoothed, so it reads as 8-bit art at any size.

   window.GmdPixelSky.mount(canvas, options) -> { destroy }
   - honours prefers-reduced-motion (one static frame, no animation loop)
   - pauses when the tab is hidden
   - resizes with its canvas
   ========================================================================== */
(function () {
  "use strict";

  const SKY_BANDS = ["#6FA6FF", "#76ABFF", "#7EB0FF", "#86B6FF", "#8EBCFF", "#96C2FF", "#9FC8FF", "#A8CFFF"];
  const SUN_CORE = "#FFF8D0";
  const SUN_MID = "#FFEFA0";
  const SUN_EDGE = "#FFD96A";
  const HALO = "rgba(255, 238, 160, 0.42)";
  const CLOUD_TOP = "#FFFFFF";
  const CLOUD_UNDER = "#DCE9FF";
  const HILLS_FAR = "#69A45D";
  const HILLS_NEAR = "#5D9552";
  const GRASS_TOP = "#7CC45F";
  const GRASS = "#63A94B";
  const DIRT = "#8A6242";
  const TRUNK = "#6B4A2D";
  const LEAF = "#4E9B3B";
  const LEAF_LIGHT = "#5CB447";
  const BIRD = "#2E4A66";

  function makeCloud(rnd) {
    const blocks = [];
    const puff = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < puff + 2; i++) {
      blocks.push({
        x: i * 2 + Math.floor(rnd() * 2),
        y: Math.floor(rnd() * 2),
        w: 2 + Math.floor(rnd() * 3),
        h: 1 + Math.floor(rnd() * 2)
      });
    }
    return blocks;
  }

  function mount(canvas, options = {}) {
    if (!canvas || !canvas.getContext) return { destroy() {} };
    const ctx = canvas.getContext("2d");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const seed = Number(options.seed || 7);
    let rndState = seed * 2654435761 % 4294967296 || 12345;
    const rnd = () => {
      rndState ^= rndState << 13; rndState ^= rndState >>> 17; rndState ^= rndState << 5;
      return ((rndState >>> 0) % 100000) / 100000;
    };

    const clouds = [];
    const cloudCount = options.clouds ?? 7;
    for (let i = 0; i < cloudCount; i++) {
      clouds.push({
        blocks: makeCloud(rnd),
        x: rnd() * 240,
        y: 6 + rnd() * 38,
        speed: 1.2 + rnd() * 2.2,
        scale: 2 + Math.floor(rnd() * 2)
      });
    }
    const birds = [
      { x: rnd() * 200, y: 18 + rnd() * 12, speed: 3.2 + rnd() * 1.4, flap: rnd() * 6 },
      { x: rnd() * 200, y: 14 + rnd() * 16, speed: 2.6 + rnd() * 1.2, flap: rnd() * 6 }
    ];

    let raf = 0;
    let last = 0;

    function draw(now) {
      const width = Math.max(64, canvas.clientWidth || canvas.width);
      const height = Math.max(48, canvas.clientHeight || canvas.height);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      // One on-screen pixel = one art pixel-block.
      const unit = Math.max(3, Math.floor(Math.min(width, height) / 44));
      const cols = Math.ceil(width / unit);
      const rows = Math.ceil(height / unit);
      ctx.imageSmoothingEnabled = false;
      const t = now / 1000;

      // --- banded sky ---
      const horizonRow = Math.floor(rows * (options.horizon ?? 0.8));
      const bands = SKY_BANDS.length;
      for (let band = 0; band < bands; band++) {
        ctx.fillStyle = SKY_BANDS[band];
        const y0 = Math.floor((band / bands) * horizonRow);
        const y1 = Math.floor(((band + 1) / bands) * horizonRow);
        ctx.fillRect(0, y0 * unit, width, (y1 - y0) * unit + unit);
      }

      // --- sun (pixel disc: stepped square) with a soft halo ---
      const bob = reduced ? 0 : Math.round(Math.sin(t * 0.22) * 1.2);
      const sunX = Math.floor(cols * 0.76);
      const sunY = Math.floor(rows * 0.16) + bob;
      ctx.fillStyle = HALO;
      ctx.fillRect((sunX - 5) * unit, (sunY - 5) * unit, 10 * unit, 10 * unit);
      ctx.fillStyle = SUN_EDGE;
      ctx.fillRect((sunX - 3) * unit, (sunY - 3) * unit, 6 * unit, 6 * unit);
      ctx.fillStyle = SUN_MID;
      ctx.fillRect((sunX - 2) * unit, (sunY - 2) * unit, 4 * unit, 4 * unit);
      ctx.fillStyle = SUN_CORE;
      ctx.fillRect((sunX - 1) * unit, (sunY - 1) * unit, 2 * unit, 2 * unit);

      // --- drifting blocky clouds ---
      for (const cloud of clouds) {
        if (!reduced) cloud.x += cloud.speed * (last ? (now - last) / 1000 : 0);
        const span = cols + 40;
        if (cloud.x > span) cloud.x -= span;
        const cx = Math.floor(cloud.x) - 20;
        const cy = Math.floor(cloud.y);
        const s = cloud.scale;
        for (const block of cloud.blocks) {
          ctx.fillStyle = CLOUD_UNDER;
          ctx.fillRect((cx + block.x * s) * unit, (cy + block.y * s + s) * unit, block.w * s * unit, Math.max(unit, s * unit));
          ctx.fillStyle = CLOUD_TOP;
          ctx.fillRect((cx + block.x * s) * unit, (cy + block.y * s) * unit, block.w * s * unit, s * unit);
        }
      }

      // --- birds ---
      for (const bird of birds) {
        if (!reduced) bird.x += bird.speed * (last ? (now - last) / 1000 : 0);
        if (bird.x > cols + 10) bird.x -= cols + 30;
        const bx = Math.floor(bird.x);
        const by = Math.floor(bird.y + (reduced ? 0 : Math.sin(t * 1.3 + bird.flap) * 1.2));
        const wing = reduced || Math.floor(t * 2 + bird.flap) % 2 === 0 ? 0 : 1;
        ctx.fillStyle = BIRD;
        ctx.fillRect((bx - 1) * unit, (by + wing) * unit, unit, unit);
        ctx.fillRect(bx * unit, (by - wing) * unit, unit, unit);
        ctx.fillRect((bx + 1) * unit, (by + wing) * unit, unit, unit);
      }

      // --- blocky horizon: far hills, near hills, grass and dirt ---
      const farTop = horizonRow - 6;
      const nearTop = horizonRow - 3;
      ctx.fillStyle = HILLS_FAR;
      for (let x = 0; x < cols; x++) {
        const h = 2 + Math.round(1.6 + Math.sin(x * 0.21 + seed) * 1.6 + Math.sin(x * 0.07) * 1.2);
        ctx.fillRect(x * unit, (farTop + 6 - h) * unit, unit, h * unit);
      }
      ctx.fillStyle = HILLS_NEAR;
      for (let x = 0; x < cols; x++) {
        const h = 1 + Math.round(1.4 + Math.sin(x * 0.15 + seed * 2) * 1.4);
        ctx.fillRect(x * unit, (nearTop + 3 - h) * unit, unit, h * unit);
      }
      ctx.fillStyle = GRASS_TOP;
      ctx.fillRect(0, horizonRow * unit, width, unit);
      ctx.fillStyle = GRASS;
      ctx.fillRect(0, (horizonRow + 1) * unit, width, unit);
      ctx.fillStyle = DIRT;
      ctx.fillRect(0, (horizonRow + 2) * unit, width, height - (horizonRow + 2) * unit);

      // two square trees on the horizon
      for (const treeX of [Math.floor(cols * 0.16), Math.floor(cols * 0.62)]) {
        const base = horizonRow;
        ctx.fillStyle = TRUNK;
        ctx.fillRect(treeX * unit, (base - 3) * unit, unit, 3 * unit);
        ctx.fillStyle = LEAF;
        ctx.fillRect((treeX - 2) * unit, (base - 6) * unit, 5 * unit, 3 * unit);
        ctx.fillStyle = LEAF_LIGHT;
        ctx.fillRect((treeX - 1) * unit, (base - 7) * unit, 3 * unit, unit);
      }
    }

    function loop(now) {
      draw(now);
      last = now;
      raf = requestAnimationFrame(loop);
    }

    function start() {
      if (raf) return;
      last = 0;
      if (reduced) {
        draw(0);
        return;
      }
      raf = requestAnimationFrame(loop);
    }
    function stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }
    function onVisibility() {
      if (document.hidden) stop();
      else start();
    }
    function onResize() {
      draw(last || 0);
    }

    start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onResize);

    return {
      destroy() {
        stop();
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("resize", onResize);
      }
    };
  }

  window.GmdPixelSky = { mount };
})();
