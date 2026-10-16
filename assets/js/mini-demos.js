/* Small card animations:
   1. Masked-diffusion text: a sentence starts fully masked and is unmasked
      in parallel over a few denoising steps, then re-masked (forward process).
   2. Tangent plot: a point slides along a curve with its tangent line. */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function whenVisible(el, onChange) {
    if (!('IntersectionObserver' in window)) { onChange(true); return; }
    new IntersectionObserver(function (entries) { onChange(entries[0].isIntersecting); }).observe(el);
  }

  /* ---------- 1. Masked diffusion over text ---------- */
  var tokensEl = document.getElementById('dlm-tokens');
  var tEl = document.getElementById('dlm-t');

  if (tokensEl) {
    var SENTENCES = [
      'diffusion models write the whole sentence in parallel',
      'start from masks and unmask the most confident tokens first',
      'every step refines all positions at once'
    ];
    var STEPS = 6;
    var NOISE = 'abcdefghijklmnopqrstuvwxyz';
    var sentenceIdx = 0, spans = [], order = [], step = 0, phase = 'denoise';
    var timer = 0, visible = false;

    var build = function () {
      var words = SENTENCES[sentenceIdx].split(' ');
      tokensEl.innerHTML = '';
      spans = words.map(function (w) {
        var s = document.createElement('span');
        s.className = 'tok is-mask';
        s.dataset.word = w;
        s.textContent = '▒'.repeat(w.length);
        tokensEl.appendChild(s);
        return s;
      });
      // random "confidence" order decides which positions unmask first
      order = spans.map(function (_, i) { return i; }).sort(function () { return Math.random() - 0.5; });
      step = 0;
      phase = 'denoise';
      if (tEl) tEl.textContent = '1.00';
    };

    var scramble = function (s) {
      var w = s.dataset.word, out = '';
      for (var i = 0; i < w.length; i++) out += NOISE[Math.floor(Math.random() * NOISE.length)];
      s.textContent = out;
    };

    var tick = function () {
      if (!visible) { timer = 0; return; }
      if (phase === 'denoise') {
        step++;
        var upto = Math.round(order.length * step / STEPS);
        order.forEach(function (idx, rank) {
          var s = spans[idx];
          if (rank < upto) {
            if (s.classList.contains('is-mask') || s.classList.contains('is-noisy')) {
              s.textContent = s.dataset.word;
              s.className = 'tok is-new';
            } else {
              s.className = 'tok';
            }
          } else if (rank < upto + 2) {
            s.className = 'tok is-noisy';
            scramble(s);
          }
        });
        if (tEl) tEl.textContent = (1 - step / STEPS).toFixed(2);
        if (step >= STEPS) { phase = 'hold'; timer = setTimeout(tick, 2200); return; }
        timer = setTimeout(tick, 520);
        return;
      }
      if (phase === 'hold') {
        phase = 'renoise';
        step = STEPS;
        timer = setTimeout(tick, 60);
        return;
      }
      // forward process: mask everything again, quickly, then next sentence
      step--;
      var keep = Math.round(order.length * step / STEPS);
      order.forEach(function (idx, rank) {
        var s = spans[idx];
        if (rank >= keep) { s.className = 'tok is-mask'; s.textContent = '▒'.repeat(s.dataset.word.length); }
      });
      if (tEl) tEl.textContent = (1 - step / STEPS).toFixed(2);
      if (step <= 0) {
        sentenceIdx = (sentenceIdx + 1) % SENTENCES.length;
        timer = setTimeout(function () { build(); tick(); }, 500);
        return;
      }
      timer = setTimeout(tick, 140);
    };

    build();
    if (reduceMotion) {
      spans.forEach(function (s) { s.textContent = s.dataset.word; s.className = 'tok'; });
      if (tEl) tEl.textContent = '0.00';
    } else {
      whenVisible(tokensEl, function (v) {
        visible = v;
        if (v && !timer) timer = setTimeout(tick, 600);
      });
    }
  }

  /* ---------- 2. Tangent plot ---------- */
  var canvas = document.getElementById('tangent-demo');
  if (canvas && canvas.getContext) {
    var ctx = canvas.getContext('2d');
    var xOut = document.getElementById('tan-x');
    var dOut = document.getElementById('tan-d');
    var PX = 3;
    var buf = document.createElement('canvas'), b = buf.getContext('2d');
    var W = 0, H = 0, raf = 0, onScreen = false, t0 = performance.now();

    var f = function (x) { return Math.sin(x) * 0.8 + Math.sin(2.3 * x) * 0.25; };
    var df = function (x) { return Math.cos(x) * 0.8 + Math.cos(2.3 * x) * 0.575; };
    var X0 = -3.2, X1 = 3.2, Y0 = -1.3, Y1 = 1.3;

    var colours = function () {
      var cs = getComputedStyle(document.documentElement);
      return {
        bg: cs.getPropertyValue('--clr-bg-alt').trim() || '#ebe7dc',
        axis: cs.getPropertyValue('--clr-border').trim() || '#dad4c5',
        curve: cs.getPropertyValue('--clr-primary').trim() || '#141613',
        accent: cs.getPropertyValue('--clr-accent').trim() || '#0b7a6c',
        signal: cs.getPropertyValue('--clr-signal').trim() || '#c27a12'
      };
    };
    var c = colours();
    new MutationObserver(function () { c = colours(); if (reduceMotion) draw(0.6); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { c = colours(); });

    var sx = function (x) { return (x - X0) / (X1 - X0) * (W - 1); };
    var sy = function (y) { return (1 - (y - Y0) / (Y1 - Y0)) * (H - 1); };

    var resize = function () {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      W = Math.max(40, Math.round(canvas.clientWidth / PX));
      H = Math.max(24, Math.round(canvas.clientHeight / PX));
      buf.width = W; buf.height = H;
    };

    var draw = function (u) {
      var x = X0 + 0.4 + (X1 - X0 - 0.8) * u;
      b.fillStyle = c.bg;
      b.fillRect(0, 0, W, H);
      b.fillStyle = c.axis;
      b.fillRect(0, Math.round(sy(0)), W, 1);
      b.fillRect(Math.round(sx(0)), 0, 1, H);
      b.fillStyle = c.curve;
      for (var i = 0; i < W; i++) {
        var xv = X0 + (X1 - X0) * i / (W - 1);
        b.fillRect(i, Math.round(sy(f(xv))), 1, 1);
      }
      var slope = df(x), y = f(x);
      b.fillStyle = slope >= 0 ? c.accent : c.signal;
      for (var k = -1.1; k <= 1.1; k += (X1 - X0) / W / 1.5) {
        var tx = x + k, ty = y + slope * k;
        if (ty > Y0 && ty < Y1) b.fillRect(Math.round(sx(tx)), Math.round(sy(ty)), 1, 1);
      }
      b.fillRect(Math.round(sx(x)) - 1, Math.round(sy(y)) - 1, 3, 3);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(buf, 0, 0, W, H, 0, 0, canvas.width, canvas.height);
      if (xOut) xOut.textContent = x.toFixed(2);
      if (dOut) dOut.textContent = (slope >= 0 ? '+' : '') + slope.toFixed(2);
    };

    var frame = function (now) {
      var u = (Math.sin((now - t0) / 2400) + 1) / 2;   // ping-pong along the curve
      draw(u);
      raf = onScreen ? requestAnimationFrame(frame) : 0;
    };

    resize();
    draw(0.6);
    if (!reduceMotion) {
      whenVisible(canvas, function (v) {
        onScreen = v;
        if (v && !raf) raf = requestAnimationFrame(frame);
      });
    }
    window.addEventListener('resize', function () { resize(); draw(0.6); });
  }
})();
