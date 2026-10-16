/* Pixel portrait with physics effects.
   The photo is sampled into a grid of square "pixels". The portrait plays the same
   physics as the page background (bg-physics.js) and switches when it does:
     diffusion  pixels are noised (x_0 -> x_T) and denoised back (x_T -> x_0)
     flow       pixels are advected along a curl-noise field, then return
     heat       colours evolve under the heat equation (blur), then the run is reversed
     lorenz     pixels are pulled onto the Lorenz attractor and back
   Without the GPU background it picks an effect at random every ~25 s.
   Between effects the cursor pushes pixels away and a spring brings them back. */
(function () {
  'use strict';

  var canvas = document.getElementById('pixel-hero');
  if (!canvas || !canvas.getContext) return;

  var ctx = canvas.getContext('2d');
  var frame = canvas.parentElement;
  var tVal = document.getElementById('t-val');
  var capEl = document.getElementById('hero-cap');
  var replayBtn = document.getElementById('renoise');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var LEVELS = 10;          // colour steps between noise and the true colour
  var HEAT_SNAPS = [0, 3, 8, 18, 36, 70, 120];   // heat-equation steps stored as blur levels
  var FLOW_STEPS = 24;      // samples along each pixel's flow path
  var STAGGER = 0.3;        // per-pixel start offset, as a fraction of the run

  var EFFECTS = {
    diffusion: { out: 1700, hold: 500, back: 2600, label: 't',
                 cap: 'Fig. 1 — diffusion: x<sub>0</sub> → x<sub>T</sub> → x<sub>0</sub>' },
    flow:      { out: 2200, hold: 300, back: 2400, label: 's',
                 cap: 'Fig. 1 — pixels advected by a curl-noise flow, then returned' },
    heat:      { out: 2000, hold: 600, back: 2200, label: 'αt',
                 cap: 'Fig. 1 — heat equation on the image, ∂u/∂t = α∇²u, run back' },
    lorenz:    { out: 2200, hold: 700, back: 2600, label: 't',
                 cap: 'Fig. 1 — pixels pulled onto the Lorenz attractor and back' }
  };
  var NAMES = Object.keys(EFFECTS);

  var crop = (canvas.getAttribute('data-crop') || '').split(',').map(Number);
  var particles = [];
  var cols = 0, rows = 0, cssW = 0, cssH = 0, cell = 0;
  var phase = 'idle';       // 'effect' | 'idle'
  var fx = null;            // { name, start }
  var current = 'diffusion', pending = null;
  var raf = 0, visible = true, randomTimer = 0;
  var pointer = { x: -1e4, y: -1e4, active: false };

  var img = new Image();
  img.onload = init;
  img.src = canvas.getAttribute('data-src');

  /* ---------------- setup ---------------- */
  function init() {
    build();
    frame.classList.add('is-live');
    if (reduceMotion) {
      if (replayBtn) replayBtn.hidden = true;
      settle();
      return;
    }
    if (window.__bg && window.__bg.stats) current = window.__bg.stats().scene;
    if (!EFFECTS[current]) current = 'diffusion';
    play(current, true);             // first view: start fully "out" and come back
    bindEvents();
  }

  function rgb(r, g, b) { return 'rgb(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ')'; }

  /* Sample the photo into a grid, precompute colour levels (noise mix and heat blur). */
  function build() {
    var sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
    if (crop.length === 4 && crop.every(function (n) { return !isNaN(n); })) {
      sx = crop[0]; sy = crop[1]; sw = crop[2]; sh = crop[3];
    }
    cssW = frame.clientWidth -
      parseFloat(getComputedStyle(frame).paddingLeft) -
      parseFloat(getComputedStyle(frame).paddingRight);
    cols = Math.max(60, Math.min(78, Math.round(cssW / 4.5)));   // ~4.5 CSS px per tile
    rows = Math.round(cols * sh / sw);
    cell = cssW / cols;
    cssH = rows * cell;

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var off = document.createElement('canvas');
    off.width = cols; off.height = rows;
    var octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(img, sx, sy, sw, sh, 0, 0, cols, rows);
    var data = octx.getImageData(0, 0, cols, rows).data;

    var heat = heatLevels(data);
    particles = new Array(cols * rows);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var i = r * cols + c, k = i * 4;
        var R = data[k], G = data[k + 1], B = data[k + 2];
        var nR = Math.random() * 255, nG = Math.random() * 255, nB = Math.random() * 255;
        var colours = new Array(LEVELS);
        for (var s = 0; s < LEVELS; s++) {
          var f = s / (LEVELS - 1);
          colours[s] = rgb(nR + (R - nR) * f, nG + (G - nG) * f, nB + (B - nB) * f);
        }
        var tx = c * cell, ty = r * cell;
        particles[i] = {
          tx: tx, ty: ty, x: tx, y: ty, vx: 0, vy: 0,
          colours: colours,
          heat: heat.map(function (lvl) { return lvl[i]; }),
          delay: Math.random(),
          nx: 0, ny: 0, ax: 0, ay: 0, path: null
        };
      }
    }
  }

  /* Explicit heat-equation steps on the colour grid (u += α∇²u, insulated edges);
     snapshots at HEAT_SNAPS become the blur levels. */
  function heatLevels(data) {
    var n = cols * rows, alpha = 0.22;
    var ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    for (var i = 0; i < n; i++) { ch[0][i] = data[i * 4]; ch[1][i] = data[i * 4 + 1]; ch[2][i] = data[i * 4 + 2]; }
    var tmp = new Float32Array(n), out = [], step = 0;
    var snap = function () {
      var lvl = new Array(n);
      for (var j = 0; j < n; j++) lvl[j] = rgb(ch[0][j], ch[1][j], ch[2][j]);
      out.push(lvl);
    };
    for (var si = 0; si < HEAT_SNAPS.length; si++) {
      while (step < HEAT_SNAPS[si]) {
        for (var c = 0; c < 3; c++) {
          var u = ch[c];
          for (var y = 0; y < rows; y++) {
            for (var x = 0; x < cols; x++) {
              var idx = y * cols + x, v = u[idx];
              var l = x > 0 ? u[idx - 1] : v, r = x < cols - 1 ? u[idx + 1] : v;
              var t = y > 0 ? u[idx - cols] : v, b = y < rows - 1 ? u[idx + cols] : v;
              tmp[idx] = v + alpha * (l + r + t + b - 4 * v);
            }
          }
          u.set(tmp);
        }
        step++;
      }
      snap();
    }
    return out;
  }

  /* ---------------- per-effect preparation ---------------- */
  function curl(x, y, t) {                          // same stream function as the background
    var qx = x * 1.6, qy = y * 1.6;
    var a = 1.3 * qx + 0.21 * t, b = 1.1 * qy - 0.17 * t, c = 2.1 * (qx + qy) + 0.11 * t, d = 3.7 * qx - 2.9 * qy + 0.3 * t;
    var dx = 1.3 * Math.cos(a) * Math.cos(b) + 1.05 * Math.cos(c) + 0.925 * Math.cos(d);
    var dy = -1.1 * Math.sin(a) * Math.sin(b) + 1.05 * Math.cos(c) - 0.725 * Math.cos(d);
    return [dy, -dx];
  }

  function lorenzPoints(n) {
    var x = 0.1, y = 0, z = 25, pts = [], dt = 0.006;
    for (var i = 0; i < 400; i++) { var dx0 = 10 * (y - x), dy0 = x * (28 - z) - y, dz0 = x * y - 8 / 3 * z; x += dx0 * dt; y += dy0 * dt; z += dz0 * dt; }
    for (var k = 0; k < n; k++) {
      for (var s = 0; s < 3; s++) { var dx = 10 * (y - x), dy = x * (28 - z) - y, dz = x * y - 8 / 3 * z; x += dx * dt; y += dy * dt; z += dz * dt; }
      pts.push([x, z]);
    }
    return pts;
  }

  function prepare(name) {
    var i, q;
    if (name === 'diffusion') {
      for (i = 0; i < particles.length; i++) {
        q = particles[i];
        q.nx = Math.random() * (cssW - cell);
        q.ny = Math.random() * (cssH - cell);
      }
    } else if (name === 'flow') {
      var t0 = Math.random() * 100, stepLen = cssW * 0.028;
      for (i = 0; i < particles.length; i++) {
        q = particles[i];
        var px = q.tx, py = q.ty, path = new Float32Array(FLOW_STEPS * 2);
        for (var s = 0; s < FLOW_STEPS; s++) {
          path[s * 2] = px; path[s * 2 + 1] = py;
          var v = curl(px / cssW * 2 - 1, 1 - py / cssH * 2, t0 + s * 0.05);
          var len = Math.sqrt(v[0] * v[0] + v[1] * v[1]) + 1e-6;
          px += v[0] / len * stepLen;
          py -= v[1] / len * stepLen;
        }
        q.path = path;
      }
    } else if (name === 'lorenz') {
      var pts = lorenzPoints(particles.length);
      for (i = pts.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var tmp = pts[i]; pts[i] = pts[j]; pts[j] = tmp; }
      for (i = 0; i < particles.length; i++) {
        q = particles[i];
        q.ax = cssW / 2 + pts[i][0] / 22 * cssW * 0.46 - cell / 2;
        q.ay = cssH * 0.92 - pts[i][1] / 50 * cssH * 0.84;
      }
    }
  }

  /* ---------------- playback ---------------- */
  function setCaption(name) {
    if (capEl) capEl.innerHTML = EFFECTS[name].cap;    // static strings defined above
    var lab = document.getElementById('t-lab');
    if (lab) lab.textContent = EFFECTS[name].label;
  }

  function play(name, entering) {
    if (!EFFECTS[name]) return;
    if (raf) cancelAnimationFrame(raf);
    current = name;
    prepare(name);
    setCaption(name);
    var e = EFFECTS[name];
    // `entering`: skip the "out" half so the first view assembles the portrait
    fx = { name: name, start: performance.now() - (entering ? e.out + e.hold : 0) };
    phase = 'effect';
    raf = requestAnimationFrame(effectFrame);
  }

  function smooth(x) { return x * x * (3 - 2 * x); }

  function amount(now) {
    var e = EFFECTS[fx.name], t = now - fx.start;
    if (t < e.out) return { u: smooth(t / e.out), done: false };
    if (t < e.out + e.hold) return { u: 1, done: false };
    var b = (t - e.out - e.hold) / e.back;
    if (b < 1) return { u: 1 - (1 - Math.pow(1 - b, 3)), done: false };
    return { u: 0, done: true };
  }

  function effectFrame(now) {
    var a = amount(now), u = a.u;
    var size = cell * (cell < 5 ? 0.92 : 0.86);
    ctx.clearRect(0, 0, cssW, cssH);
    for (var i = 0; i < particles.length; i++) {
      var q = particles[i];
      var ui = Math.min(1, Math.max(0, (u - q.delay * STAGGER) / (1 - STAGGER)));
      var x = q.tx, y = q.ty, col = q.colours[LEVELS - 1];
      if (fx.name === 'diffusion') {
        var jit = ui * cell * 2.4;
        x = q.tx + (q.nx - q.tx) * ui + (Math.random() - 0.5) * jit;
        y = q.ty + (q.ny - q.ty) * ui + (Math.random() - 0.5) * jit;
        col = q.colours[Math.round((1 - ui) * (LEVELS - 1))];
      } else if (fx.name === 'flow') {
        var f = ui * (FLOW_STEPS - 1), k0 = Math.floor(f), k1 = Math.min(FLOW_STEPS - 1, k0 + 1), w = f - k0;
        x = q.path[k0 * 2] + (q.path[k1 * 2] - q.path[k0 * 2]) * w;
        y = q.path[k0 * 2 + 1] + (q.path[k1 * 2 + 1] - q.path[k0 * 2 + 1]) * w;
      } else if (fx.name === 'heat') {
        col = q.heat[Math.round(u * (HEAT_SNAPS.length - 1))];   // whole image diffuses together
      } else if (fx.name === 'lorenz') {
        var bend = Math.sin(Math.PI * ui) * cell * 5;
        x = q.tx + (q.ax - q.tx) * ui + bend;
        y = q.ty + (q.ay - q.ty) * ui - bend * 0.6;
      }
      q.x = x; q.y = y;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, size, size);
    }
    if (tVal) tVal.textContent = String(Math.round(u * 1000));
    if (!a.done) { raf = requestAnimationFrame(effectFrame); return; }
    raf = 0;
    settle();
    if (pending && pending !== current) { var p = pending; pending = null; setTimeout(function () { play(p); }, 400); }
    pending = null;
  }

  function drawSettled() {
    ctx.clearRect(0, 0, cssW, cssH);
    var size = cell * (cell < 5 ? 0.92 : 0.86);
    for (var i = 0; i < particles.length; i++) {
      var q = particles[i];
      ctx.fillStyle = q.colours[LEVELS - 1];
      ctx.fillRect(q.x, q.y, size, size);
    }
  }

  function settle() {
    for (var i = 0; i < particles.length; i++) {
      var q = particles[i];
      q.x = q.tx; q.y = q.ty; q.vx = 0; q.vy = 0;
    }
    phase = 'idle';
    if (tVal) tVal.textContent = '0';
    drawSettled();
  }

  /* ---------------- idle: cursor repulsion with a spring back ---------------- */
  function physicsFrame() {
    var R = cell * 9, R2 = R * R, push = cell * 0.9;
    var moving = false;
    for (var i = 0; i < particles.length; i++) {
      var q = particles[i];
      if (pointer.active) {
        var dx = q.x - pointer.x, dy = q.y - pointer.y, d2 = dx * dx + dy * dy;
        if (d2 < R2 && d2 > 0.01) {
          var d = Math.sqrt(d2), f = (1 - d / R) * push;
          q.vx += (dx / d) * f;
          q.vy += (dy / d) * f;
        }
      }
      q.vx = (q.vx + (q.tx - q.x) * 0.06) * 0.82;
      q.vy = (q.vy + (q.ty - q.y) * 0.06) * 0.82;
      q.x += q.vx;
      q.y += q.vy;
      if (!moving && (Math.abs(q.vx) + Math.abs(q.vy) > 0.03 ||
                      Math.abs(q.x - q.tx) + Math.abs(q.y - q.ty) > 0.1)) moving = true;
    }
    if (moving || pointer.active) {
      drawSettled();
      raf = requestAnimationFrame(physicsFrame);
    } else {
      raf = 0;
      settle();
    }
  }

  function wake() {
    if (phase === 'idle' && !raf) raf = requestAnimationFrame(physicsFrame);
  }

  function localPoint(e) {
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function burst(x, y) {
    var R = cell * 14;
    for (var i = 0; i < particles.length; i++) {
      var q = particles[i];
      var dx = q.x - x, dy = q.y - y, d = Math.sqrt(dx * dx + dy * dy);
      if (d < R && d > 0.01) {
        var f = (1 - d / R) * cell * 6;
        q.vx += (dx / d) * f;
        q.vy += (dy / d) * f;
      }
    }
    wake();
  }

  /* Follow the background's scene; if there is none, choose at random. */
  function onScene(name) {
    if (!EFFECTS[name]) return;
    if (!visible || phase === 'effect') { pending = name; return; }
    play(name);
  }

  function scheduleRandom() {
    clearTimeout(randomTimer);
    randomTimer = setTimeout(function () {
      var next;
      do { next = NAMES[Math.floor(Math.random() * NAMES.length)]; } while (next === current && NAMES.length > 1);
      onScene(next);
      scheduleRandom();
    }, 22000 + Math.random() * 8000);
  }

  function bindEvents() {
    canvas.addEventListener('pointermove', function (e) {
      var pt = localPoint(e);
      pointer.x = pt.x; pointer.y = pt.y; pointer.active = true;
      wake();
    });
    canvas.addEventListener('pointerleave', function () { pointer.active = false; });
    canvas.addEventListener('pointercancel', function () { pointer.active = false; });
    canvas.addEventListener('pointerdown', function (e) {
      if (phase !== 'idle') return;
      var pt = localPoint(e);
      burst(pt.x, pt.y);
    });
    canvas.addEventListener('pointerup', function (e) { if (e.pointerType !== 'mouse') pointer.active = false; });

    if (replayBtn) replayBtn.addEventListener('click', function () { play(current); });

    window.addEventListener('bgscene', function (e) { onScene(e.detail && e.detail.name); });
    if (!window.__bg) scheduleRandom();

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible && pending && phase === 'idle') { var p = pending; pending = null; play(p); }
      }).observe(frame);
    }

    var lastW = frame.clientWidth, resizeTimer = 0;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (frame.clientWidth === lastW) return;
        lastW = frame.clientWidth;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        build();
        settle();
      }, 200);
    });
  }
})();
