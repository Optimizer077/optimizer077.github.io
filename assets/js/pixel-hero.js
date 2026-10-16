/* Pixel-diffusion portrait.
   The photo is sampled into a grid of square "pixels". Each pixel starts at a
   random position with a random colour (x_T) and is pulled into place while its
   colour denoises toward the true value (x_0). After that, the cursor pushes
   pixels away and a spring brings them back. */
(function () {
  'use strict';

  var canvas = document.getElementById('pixel-hero');
  if (!canvas || !canvas.getContext) return;

  var ctx = canvas.getContext('2d');
  var frame = canvas.parentElement;
  var tVal = document.getElementById('t-val');
  var renoiseBtn = document.getElementById('renoise');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var DENOISE_MS = 2800;   // length of the x_T -> x_0 animation
  var MAX_DELAY = 0.45;    // per-pixel start offset, as a fraction of the run
  var LEVELS = 10;         // colour steps between noise and the true colour
  var T_MAX = 1000;

  var crop = (canvas.getAttribute('data-crop') || '').split(',').map(Number);
  var particles = [];
  var cssW = 0, cssH = 0, cell = 0;
  var phase = 'denoise';   // 'denoise' | 'idle'
  var startTime = 0;
  var raf = 0;
  var pointer = { x: -1e4, y: -1e4, active: false };

  var img = new Image();
  img.onload = init;
  img.src = canvas.getAttribute('data-src');

  function init() {
    build();
    frame.classList.add('is-live');
    if (reduceMotion) {
      if (renoiseBtn) renoiseBtn.hidden = true;
      settle();
      return;
    }
    renoise();
    bindEvents();
  }

  /* Sample the photo into a grid and create one particle per cell. */
  function build() {
    var sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
    if (crop.length === 4 && crop.every(function (n) { return !isNaN(n); })) {
      sx = crop[0]; sy = crop[1]; sw = crop[2]; sh = crop[3];
    }

    cssW = frame.clientWidth -
      parseFloat(getComputedStyle(frame).paddingLeft) -
      parseFloat(getComputedStyle(frame).paddingRight);
    // ~4.5 CSS px per tile keeps the face readable on phones without too many tiles
    var cols = Math.max(60, Math.min(78, Math.round(cssW / 4.5)));
    var rows = Math.round(cols * sh / sw);
    cell = cssW / cols;
    cssH = rows * cell;

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var off = document.createElement('canvas');
    off.width = cols;
    off.height = rows;
    var octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(img, sx, sy, sw, sh, 0, 0, cols, rows);
    var data = octx.getImageData(0, 0, cols, rows).data;

    particles = new Array(cols * rows);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var i = r * cols + c, k = i * 4;
        var R = data[k], G = data[k + 1], B = data[k + 2];
        var nR = Math.random() * 255, nG = Math.random() * 255, nB = Math.random() * 255;
        var colours = new Array(LEVELS);
        for (var s = 0; s < LEVELS; s++) {
          var f = s / (LEVELS - 1);
          colours[s] = 'rgb(' +
            Math.round(nR + (R - nR) * f) + ',' +
            Math.round(nG + (G - nG) * f) + ',' +
            Math.round(nB + (B - nB) * f) + ')';
        }
        var tx = c * cell, ty = r * cell;
        particles[i] = {
          tx: tx, ty: ty,
          x: tx, y: ty,
          nx: 0, ny: 0,
          vx: 0, vy: 0,
          delay: 0,
          colours: colours
        };
      }
    }
  }

  function setT(t) {
    if (tVal) tVal.textContent = String(t);
  }

  function clear() {
    ctx.clearRect(0, 0, cssW, cssH);
  }

  function drawSettled() {
    clear();
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
    setT(0);
    drawSettled();
  }

  /* Scatter every pixel to a random spot and replay the denoising run. */
  function renoise() {
    if (raf) cancelAnimationFrame(raf);
    for (var i = 0; i < particles.length; i++) {
      var q = particles[i];
      q.nx = Math.random() * (cssW - cell);
      q.ny = Math.random() * (cssH - cell);
      q.delay = Math.random() * MAX_DELAY;
    }
    phase = 'denoise';
    startTime = performance.now();
    raf = requestAnimationFrame(denoiseFrame);
  }

  function denoiseFrame(now) {
    var p = Math.min((now - startTime) / DENOISE_MS, 1);
    var size = cell * 0.86;
    var span = 1 - MAX_DELAY;
    clear();
    for (var i = 0; i < particles.length; i++) {
      var q = particles[i];
      var e = (p - q.delay) / span;
      e = e < 0 ? 0 : e > 1 ? 1 : e;
      e = 1 - Math.pow(1 - e, 3);                 // ease-out cubic
      var jitter = (1 - e) * cell * 2.4;          // residual noise shrinks with t
      q.x = q.nx + (q.tx - q.nx) * e + (Math.random() - 0.5) * jitter;
      q.y = q.ny + (q.ty - q.ny) * e + (Math.random() - 0.5) * jitter;
      ctx.fillStyle = q.colours[Math.round(e * (LEVELS - 1))];
      ctx.fillRect(q.x, q.y, size, size);
    }
    setT(Math.round(T_MAX * (1 - p)));
    if (p < 1) {
      raf = requestAnimationFrame(denoiseFrame);
    } else {
      raf = 0;
      settle();
    }
  }

  /* Cursor repulsion with a spring back to the target position. */
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
                      Math.abs(q.x - q.tx) + Math.abs(q.y - q.ty) > 0.1)) {
        moving = true;
      }
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

  function bindEvents() {
    canvas.addEventListener('pointermove', function (e) {
      var pt = localPoint(e);
      pointer.x = pt.x;
      pointer.y = pt.y;
      pointer.active = true;
      wake();
    });
    canvas.addEventListener('pointerleave', function () { pointer.active = false; });
    canvas.addEventListener('pointercancel', function () { pointer.active = false; });
    canvas.addEventListener('pointerdown', function (e) {
      if (phase !== 'idle') return;
      var pt = localPoint(e);
      burst(pt.x, pt.y);
    });
    canvas.addEventListener('pointerup', function (e) {
      if (e.pointerType !== 'mouse') pointer.active = false;
    });

    if (renoiseBtn) renoiseBtn.addEventListener('click', renoise);

    var lastW = frame.clientWidth, resizeTimer = 0;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (frame.clientWidth === lastW) return;
        lastW = frame.clientWidth;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        var wasDenoising = phase === 'denoise';
        build();
        if (wasDenoising) renoise(); else settle();
      }, 200);
    });
  }
})();
