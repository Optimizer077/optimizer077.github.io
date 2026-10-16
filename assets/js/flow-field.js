/* Flow-field background.
   Pixel particles follow a smooth, slowly changing vector field (think of the
   velocity field in flow matching / probability-flow ODEs) and leave fading
   trails. Near the pointer they are pulled in and swirl around it. */
(function () {
  'use strict';

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!document.createElement('canvas').getContext) return;

  var canvas = document.createElement('canvas');
  canvas.id = 'flow-bg';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(canvas, document.body.firstChild);
  var ctx = canvas.getContext('2d');

  var small = window.matchMedia('(max-width: 760px)').matches;
  var COUNT = small ? 70 : 300;
  var CATCH_R = small ? 150 : 230;      // CSS px around the pointer
  var SPEED = small ? 1.5 : 1.9;      // per step at 30 fps

  var W = 0, H = 0, scale = 1;          // canvas px per CSS px
  var parts = [];
  var colA = [53, 80, 232], colB = [224, 69, 123], alpha = 0.5, fade = 0.07;
  var pointer = { x: -1e4, y: -1e4, on: false };
  var raf = 0, t = 0;

  function readColours() {
    var cs = getComputedStyle(document.documentElement);
    var hex = function (v, fb) {
      v = (v || '').trim();
      var m = /^#([0-9a-f]{6})$/i.exec(v);
      if (!m) return fb;
      var n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    colA = hex(cs.getPropertyValue('--clr-accent'), colA);
    colB = hex(cs.getPropertyValue('--clr-signal'), colB);
    var light = document.documentElement.getAttribute('data-theme') === 'light';
    alpha = small ? 0.2 : (light ? 0.3 : 0.42);
    fade = light ? 0.16 : 0.13;
  }

  function resize() {
    // Cap the backing resolution on very wide screens; the pixel look hides it.
    scale = 0.5;   // half resolution: particles render as 2x2 CSS-pixel blocks, 4x cheaper to fade
    W = Math.round(window.innerWidth * scale);
    H = Math.round(window.innerHeight * scale);
    canvas.width = W;
    canvas.height = H;
  }

  function spawn(p) {
    p = p || {};
    p.x = Math.random() * W;
    p.y = Math.random() * H;
    p.life = 200 + Math.random() * 400;
    p.age = 0;
    p.mix = Math.random();
    return p;
  }

  /* Smooth time-varying field: a sum of sines stands in for Perlin noise. */
  function angleAt(x, y) {
    var s = 1 / scale;
    x *= s; y *= s;
    return Math.sin(x * 0.0023 + t * 0.00021) * 1.7 +
           Math.cos(y * 0.0029 - t * 0.00017) * 1.7 +
           Math.sin((x + y) * 0.0011 + t * 0.00009) * 1.2;
  }

  function step() {
    // fade previous frame -> trails
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,' + fade + ')';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';

    var px = pointer.x * scale, py = pointer.y * scale, R = CATCH_R * scale;
    var size = 1;
    var sp = SPEED * scale;

    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var a = angleAt(p.x, p.y);
      var vx = Math.cos(a) * sp, vy = Math.sin(a) * sp;

      if (pointer.on) {
        var dx = px - p.x, dy = py - p.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d < R && d > 1) {
          var k = 1 - d / R;
          // pull toward the pointer and swirl around it
          vx += (dx / d) * k * 1.6 * scale + (-dy / d) * k * 2.4 * scale;
          vy += (dy / d) * k * 1.6 * scale + (dx / d) * k * 2.4 * scale;
        }
      }

      p.x += vx;
      p.y += vy;
      p.age++;
      if (p.age > p.life || p.x < -10 || p.y < -10 || p.x > W + 10 || p.y > H + 10) { spawn(p); continue; }

      var fadeIn = Math.min(p.age / 40, 1) * Math.min((p.life - p.age) / 40, 1);
      var m = (p.mix + p.x / W) * 0.5;
      ctx.fillStyle = 'rgba(' +
        Math.round(colA[0] + (colB[0] - colA[0]) * m) + ',' +
        Math.round(colA[1] + (colB[1] - colA[1]) * m) + ',' +
        Math.round(colA[2] + (colB[2] - colA[2]) * m) + ',' +
        (alpha * fadeIn).toFixed(3) + ')';
      ctx.fillRect(Math.round(p.x), Math.round(p.y), size, size);
    }
  }

  var lastStep = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - lastStep < 32) return;   // ~30 fps is plenty for an ambient background
    if (document.documentElement.classList.contains('gpu-on')) return;   // GPU mode draws instead
    lastStep = now;
    t = now;
    step();
  }

  function start() { if (!raf) raf = requestAnimationFrame(frame); }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  readColours();
  resize();
  for (var i = 0; i < COUNT; i++) parts.push(spawn());
  start();

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else start();
  });
  window.addEventListener('pointermove', function (e) {
    pointer.x = e.clientX; pointer.y = e.clientY; pointer.on = true;
  }, { passive: true });
  window.addEventListener('pointerdown', function (e) {
    pointer.x = e.clientX; pointer.y = e.clientY; pointer.on = true;
  }, { passive: true });
  document.addEventListener('pointerleave', function () { pointer.on = false; });
  window.addEventListener('pointerup', function (e) { if (e.pointerType !== 'mouse') pointer.on = false; });
  window.addEventListener('blur', function () { pointer.on = false; });

  var rt = 0;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { resize(); parts.forEach(function (p) { spawn(p); }); }, 200);
  });

  new MutationObserver(readColours).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme']
  });
})();
