/* Pixel portrait with physics effects.
   The photo is sampled into a grid of square "pixels". The portrait plays the same process as the page
   background (bg-physics.js) and switches when it does; 30 processes in all, listed in hero-effects.js,
   with captions and formulas from processes.js. Each effect runs for about 70% of the scene, then the
   portrait rests (and follows the cursor) until the next one.
   Without the GPU background it runs its own shuffled loop, one process every ~9 s.
   Between effects the cursor pushes pixels away and a spring brings them back. */
(function () {
  'use strict';

  var canvas = document.getElementById('pixel-hero');
  if (!canvas || !canvas.getContext) return;

  var ctx = canvas.getContext('2d');
  var frame = canvas.parentElement;
  var capEl = document.getElementById('hero-cap');
  var eqEl = document.getElementById('hero-eq');
  var countEl = document.getElementById('hero-count');
  var replayBtn = document.getElementById('renoise');
  var reduceMotion = document.documentElement.classList.contains('reduce-motion');

  var FX = window.HERO_FX || {};
  var has = function (name) { return Object.prototype.hasOwnProperty.call(FX, name); };
  var INFO = {};
  (window.PROCESSES || []).forEach(function (p) { INFO[p.id] = p; });
  var NAMES = Object.keys(FX);
  if (!NAMES.length) return;

  var LEVELS = 10;          // colour steps between noise and the true colour
  var HEAT_SNAPS = [0, 3, 8, 18, 36, 70, 120];   // heat-equation steps stored as blur levels
  var STAGGER = 0.3;        // per-pixel start offset, as a fraction of the run
  var SPAN = 0.72;          // an effect takes this fraction of its scene
  var OWN_LEN = 9;          // seconds per effect when the background is not driving
  var SMALL = Math.min(screen.width, screen.height) < 700 || /Mobi|Android/i.test(navigator.userAgent);   // phones: draw at 30 fps

  var crop = (canvas.getAttribute('data-crop') || '').split(',').map(Number);
  var particles = [];
  var cols = 0, rows = 0, cssW = 0, cssH = 0, cell = 0;
  var phase = 'idle';       // 'effect' | 'idle'
  var fx = null;            // { name, def, start, dur }
  var current = '', pending = null, started = false;
  var raf = 0, visible = true, ownTimer = 0, ownBag = [], ownN = 0, lastPaint = 0;
  var pointer = { x: -1e4, y: -1e4, active: false };
  var out = { x: 0, y: 0, c: '' };
  var NOISE = [[160, 48, 31], [31, 62, 112], [122, 84, 13], [34, 30, 33]];
  var E = { W: 0, H: 0, cell: 0, LEVELS: LEVELS, HEAT_SNAPS: HEAT_SNAPS, particles: particles, t: 0,
            col: { a: [160, 48, 31], b: [31, 62, 112], o: [122, 84, 13] }, mixLevels: null };

  var img = new Image();
  img.onload = init;
  img.src = canvas.getAttribute('data-src');

  /* ---------------- setup ---------------- */
  function init() {
    readColours();
    build();
    frame.classList.add('is-live');
    settle();                                          // the clean portrait, until the first effect starts
    if (reduceMotion) {
      if (replayBtn) replayBtn.hidden = true;
      return;
    }
    bindEvents();
    var now = window.__bgCurrent;                      // the background may already be running
    if (now && has(now.name)) onScene(now);
    else ownTimer = setTimeout(function () { if (!started) runOwn(); }, 2200);   // no GPU background: run our own loop
  }

  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
  function rgb(r, g, b) { return 'rgb(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ')'; }

  function readColours() {                              // the dye colours, as the background uses them
    var cs = getComputedStyle(document.documentElement);
    var hex = function (v, fb) {
      var m = /^#([0-9a-f]{6})$/i.exec((v || '').trim());
      if (!m) return fb;
      var n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    E.col.a = hex(cs.getPropertyValue('--clr-accent-dark'), E.col.a);
    E.col.b = hex(cs.getPropertyValue('--clr-signal-dark') || cs.getPropertyValue('--clr-signal'), E.col.b);
    NOISE = [E.col.a, E.col.b, E.col.o, [34, 30, 33], [196, 178, 146], [236, 226, 206]];   // madder, indigo, ochre, iron black, two paper tones
  }

  E.mixLevels = function (q, target) {                  // LEVELS colours from the tile's true colour to a dye
    var res = new Array(LEVELS);
    for (var s = 0; s < LEVELS; s++) {
      var f = s / (LEVELS - 1);
      res[s] = rgb(q.rgb[0] + (target[0] - q.rgb[0]) * f, q.rgb[1] + (target[1] - q.rgb[1]) * f, q.rgb[2] + (target[2] - q.rgb[2]) * f);
    }
    return res;
  };

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
    E.W = cssW; E.H = cssH; E.cell = cell;

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
    var km = kmeans(data, 6);
    particles = new Array(cols * rows);
    E.particles = particles;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var i = r * cols + c, k = i * 4;
        var R = data[k], G = data[k + 1], B = data[k + 2];
        var nc = NOISE[Math.floor(Math.random() * NOISE.length)];       // a dye, jittered
        var nR = clamp255(nc[0] + (Math.random() - 0.5) * 60), nG = clamp255(nc[1] + (Math.random() - 0.5) * 60), nB = clamp255(nc[2] + (Math.random() - 0.5) * 60);
        var colours = new Array(LEVELS);
        for (var s = 0; s < LEVELS; s++) {
          var f = s / (LEVELS - 1);
          colours[s] = rgb(nR + (R - nR) * f, nG + (G - nG) * f, nB + (B - nB) * f);
        }
        var tx = c * cell, ty = r * cell;
        particles[i] = {
          tx: tx, ty: ty, x: tx, y: ty, vx: 0, vy: 0,
          rgb: [R, G, B], lum: 0.299 * R + 0.587 * G + 0.114 * B,
          colours: colours,
          heat: heat.map(function (lvl) { return lvl[i]; }),
          klev: km.levels(i, R, G, B),
          kx: km.cx[km.label[i]] * cell, ky: km.cy[km.label[i]] * cell,
          delay: Math.random(),
          nx: 0, ny: 0, ax: 0, ay: 0, path: null, alt: null
        };
      }
    }
  }

  /* k-means (Lloyd's algorithm) on pixel colours. Returns per-pixel labels, the spatial centroid of
     each cluster (in grid units), and colour levels from the true colour to the cluster colour. */
  function kmeans(data, k) {
    var n = cols * rows, label = new Uint8Array(n), C = [], it, i, j;
    for (j = 0; j < k; j++) {                         // spread initial centroids over the image
      var s = Math.floor((j + 0.5) / k * n) * 4;
      C.push([data[s], data[s + 1], data[s + 2]]);
    }
    for (it = 0; it < 10; it++) {
      var sum = C.map(function () { return [0, 0, 0, 0]; });
      for (i = 0; i < n; i++) {
        var r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], best = 1e12, bj = 0;
        for (j = 0; j < k; j++) {
          var dr = r - C[j][0], dg = g - C[j][1], db = b - C[j][2], d = dr * dr + dg * dg + db * db;
          if (d < best) { best = d; bj = j; }
        }
        label[i] = bj; sum[bj][0] += r; sum[bj][1] += g; sum[bj][2] += b; sum[bj][3]++;
      }
      for (j = 0; j < k; j++) if (sum[j][3]) C[j] = [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]];
    }
    var cx = new Array(k).fill(0), cy = new Array(k).fill(0), cnt = new Array(k).fill(0);
    for (i = 0; i < n; i++) { cx[label[i]] += i % cols; cy[label[i]] += Math.floor(i / cols); cnt[label[i]]++; }
    for (j = 0; j < k; j++) { cx[j] = cnt[j] ? cx[j] / cnt[j] : cols / 2; cy[j] = cnt[j] ? cy[j] / cnt[j] : rows / 2; }
    return {
      label: label, cx: cx, cy: cy,
      levels: function (idx, R, G, B) {
        var c = C[label[idx]], res = [];
        for (var s2 = 0; s2 < 6; s2++) { var f = s2 / 5; res.push(rgb(R + (c[0] - R) * f, G + (c[1] - G) * f, B + (c[2] - B) * f)); }
        return res;
      }
    };
  }

  /* Explicit heat-equation steps on the colour grid (u += α∇²u, insulated edges);
     snapshots at HEAT_SNAPS become the blur levels. */
  function heatLevels(data) {
    var n = cols * rows, alpha = 0.22;
    var ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    for (var i = 0; i < n; i++) { ch[0][i] = data[i * 4]; ch[1][i] = data[i * 4 + 1]; ch[2][i] = data[i * 4 + 2]; }
    var tmp = new Float32Array(n), res = [], step = 0;
    var snap = function () {
      var lvl = new Array(n);
      for (var j = 0; j < n; j++) lvl[j] = rgb(ch[0][j], ch[1][j], ch[2][j]);
      res.push(lvl);
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
    return res;
  }

  /* ---------------- playback ---------------- */
  function setCaption(name) {
    var info = INFO[name];
    if (!info) return;
    if (capEl) capEl.textContent = info.cap;
    // formulas are MathML produced at build time from LaTeX by build_math.py (trusted, static)
    if (eqEl) eqEl.innerHTML = info.eqHero || info.eq;
  }

  function setCount(n, of) {
    if (countEl) countEl.textContent = n && of ? '(' + n + ' of ' + of + ')' : '';
  }

  function play(name, lenSec) {
    var def = has(name) ? FX[name] : null;
    if (!def) return;
    if (raf) cancelAnimationFrame(raf);
    current = name;
    started = true;
    if (def.prep) def.prep(E);
    setCaption(name);
    var span = (lenSec || OWN_LEN) * 1000 * SPAN, w = def.w, sum = w[0] + w[1] + w[2];
    fx = { name: name, def: def, start: performance.now(), dur: { out: span * w[0] / sum, hold: span * w[1] / sum, back: span * w[2] / sum } };
    phase = 'effect';
    raf = requestAnimationFrame(effectFrame);
  }

  function smooth(x) { return x * x * (3 - 2 * x); }

  function amount(now) {
    var d = fx.dur, t = now - fx.start;
    if (t < d.out) return { u: smooth(t / d.out), done: false };
    if (t < d.out + d.hold) return { u: 1, done: false };
    var b = (t - d.out - d.hold) / d.back;
    if (b < 1) return { u: 1 - (1 - Math.pow(1 - b, 3)), done: false };
    return { u: 0, done: true };
  }

  function effectFrame(now) {
    if (SMALL && now - lastPaint < 30) { raf = requestAnimationFrame(effectFrame); return; }   // effects are time-based: skipping a frame only costs smoothness
    lastPaint = now;
    var a = amount(now), u = a.u, def = fx.def, stagger = def.stagger !== false;
    E.t = (now - fx.start) / 1000;
    var size = cell * (cell < 5 ? 0.92 : 0.86), base = LEVELS - 1;
    ctx.clearRect(0, 0, cssW, cssH);
    for (var i = 0; i < particles.length; i++) {
      var q = particles[i];
      var ui = stagger ? Math.min(1, Math.max(0, (u - q.delay * STAGGER) / (1 - STAGGER))) : u;
      out.x = q.tx; out.y = q.ty; out.c = q.colours[base];
      def.at(q, u, ui, E, out);
      q.x = out.x; q.y = out.y;
      ctx.fillStyle = out.c;
      ctx.fillRect(out.x, out.y, size, size);
    }
    if (!a.done) { raf = requestAnimationFrame(effectFrame); return; }
    raf = 0;
    settle();
    if (pending && pending.name !== current) { var p = pending; pending = null; setTimeout(function () { onScene(p); }, 400); }
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

  /* Follow the background's scene (detail = { name, n, of, len }); if there is none, run our own loop. */
  function onScene(detail) {
    if (!detail || !has(detail.name)) return;
    clearTimeout(ownTimer);
    setCount(detail.n, detail.of);
    if (!visible) { pending = detail; return; }
    play(detail.name, detail.len);                      // interrupts a running effect so the portrait stays in sync
  }

  function ownNext() {
    if (!ownBag.length) {
      ownBag = NAMES.filter(function (n) { return n !== current; });     // the one on screen opens the round, so it is never repeated
      for (var k = ownBag.length - 1; k > 0; k--) { var j = Math.floor(Math.random() * (k + 1)); var t = ownBag[k]; ownBag[k] = ownBag[j]; ownBag[j] = t; }
      ownN = NAMES.length - ownBag.length;
    }
    ownN++;
    return { name: ownBag.shift(), n: ownN, of: NAMES.length, len: OWN_LEN };
  }

  function runOwn() {
    onScene(ownNext());
    ownTimer = setTimeout(runOwn, OWN_LEN * 1000);
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

    // "next": advance the background (the portrait follows its event); without it, take our own next one
    if (replayBtn) replayBtn.addEventListener('click', function () {
      if (window.__bg && window.__bg.next && window.__bg.next()) return;
      clearTimeout(ownTimer);
      runOwn();
    });

    window.addEventListener('bgscene', function (e) {
      if (e.detail) onScene(e.detail);
      else { clearTimeout(ownTimer); runOwn(); }       // the background engine has stopped
    });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible && pending && phase === 'idle') { var p = pending; pending = null; play(p.name, p.len); }
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

  // for debugging / curiosity: window.__hero.play('rossler')
  window.__hero = { play: function (n, len) { if (has(n)) { clearTimeout(ownTimer); play(n, len || OWN_LEN); } return has(n); }, names: NAMES };
})();
