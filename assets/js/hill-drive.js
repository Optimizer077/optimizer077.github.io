/* Pixel-art scene: a small car driving across endless rolling hills.
   Drawn into a low-resolution buffer and scaled up without smoothing.
   Click / tap / Space to jump; hold the pointer down to boost. */
(function () {
  'use strict';

  var canvas = document.getElementById('hill-drive');
  if (!canvas || !canvas.getContext) return;

  var ctx = canvas.getContext('2d');
  var speedOut = document.getElementById('drive-speed');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var PX = 3;                 // CSS pixels per scene pixel
  var BASE_SPEED = 38;        // scene px / s
  var BOOST_SPEED = 115;
  var GRAVITY = 260;
  var JUMP_V = -118;
  var WHEELBASE = 10;

  var buf = document.createElement('canvas');
  var b = buf.getContext('2d');
  var W = 0, H = 0;

  var scroll = 0, speed = BASE_SPEED, boosting = false;
  var car = { y: 0, vy: 0, air: false, angle: 0, spin: 0 };
  var dust = [];
  var stars = [];
  var clouds = [];
  var palette = null, sprite = null;
  var raf = 0, last = 0, onScreen = true;

  /* ---------- Palettes follow the site theme ---------- */
  var PALETTES = {
    light: {
      skyTop: '#dfe6fb', skyBottom: '#f5f6fa', sun: '#ffb547', cloud: '#ffffff',
      far: '#c8d0ea', mid: '#9fb0e6', ground: '#3550e8', grass: '#7c9cff', dust: '#d5ddf8',
      body: '#e0457b', window: '#fdf2f6', wheel: '#0f1426', hub: '#8a92a9',
      light: '#ffd36b', tail: '#a32020', star: null
    },
    dark: {
      skyTop: '#05070e', skyBottom: '#101830', sun: '#fde68a', cloud: '#17203a',
      far: '#131b34', mid: '#16304a', ground: '#0e7490', grass: '#22d3ee', dust: '#1f6f86',
      body: '#f472b6', window: '#cffafe', wheel: '#02040a', hub: '#64748b',
      light: '#fff2b0', tail: '#ff5a4f', star: '#e8e2d2'
    }
  };

  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    return t === 'light' ? 'light' : 'dark';   // dark is the site default
  }

  /* 18×7 car, facing right. b body, w window, l headlight, k tail light */
  var CAR = [
    '......bbbbbbb.....',
    '.....bwwwbwwwb....',
    '....bwwwwbwwwwb...',
    'bbbbbbbbbbbbbbbbbb',
    'kbbbbbbbbbbbbbbbbl',
    'bbbbbbbbbbbbbbbbbb',
    '.bbbbbbbbbbbbbbbb.'
  ];

  function buildSprite(p) {
    var s = document.createElement('canvas');
    s.width = CAR[0].length;
    s.height = CAR.length;
    var c = s.getContext('2d');
    var map = { b: p.body, w: p.window, l: p.light, k: p.tail };
    for (var y = 0; y < CAR.length; y++) {
      for (var x = 0; x < CAR[y].length; x++) {
        var col = map[CAR[y][x]];
        if (col) { c.fillStyle = col; c.fillRect(x, y, 1, 1); }
      }
    }
    return s;
  }

  function applyTheme() {
    palette = PALETTES[currentTheme()];
    sprite = buildSprite(palette);
  }

  /* ---------- Terrain ---------- */
  function groundY(x) {
    return H * 0.74 +
      Math.sin(x * 0.021) * 7 +
      Math.sin(x * 0.047 + 1.3) * 3.2 +
      Math.sin(x * 0.009 + 0.4) * 5;
  }
  function midY(x) {
    return H * 0.56 + Math.sin(x * 0.013 + 2) * 8 + Math.sin(x * 0.031) * 3;
  }
  function farY(x) {
    // sharper peaks for distant mountains
    return H * 0.46 - Math.abs(Math.sin(x * 0.011 + 0.7)) * 16 - Math.sin(x * 0.027) * 3;
  }

  /* ---------- Setup ---------- */
  function resize() {
    var cssW = canvas.clientWidth;
    var cssH = canvas.clientHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    W = Math.max(60, Math.round(cssW / PX));
    H = Math.max(40, Math.round(cssH / PX));
    buf.width = W;
    buf.height = H;

    stars = [];
    for (var i = 0; i < Math.round(W / 9); i++) {
      stars.push({ x: Math.random() * W, y: Math.random() * H * 0.45, p: Math.random() * 6.28 });
    }
    clouds = [];
    for (var j = 0; j < 4; j++) {
      clouds.push({ x: Math.random() * W, y: 6 + Math.random() * H * 0.22, w: 10 + Math.random() * 14 });
    }
    car.y = groundY(scroll + W * 0.28);
  }

  /* ---------- Simulation ---------- */
  function jump() {
    if (car.air) return;
    car.air = true;
    car.vy = JUMP_V;
    puff(8);
  }

  function puff(n) {
    var cx = W * 0.28 - 9;
    for (var i = 0; i < n; i++) {
      dust.push({
        x: cx + Math.random() * 3,
        y: car.y - 1 - Math.random() * 2,
        vx: -10 - Math.random() * 20,
        vy: -6 - Math.random() * 10,
        life: 0.5 + Math.random() * 0.4
      });
    }
  }

  function step(dt, t) {
    var target = boosting ? BOOST_SPEED : BASE_SPEED;
    speed += (target - speed) * Math.min(dt * 3, 1);
    scroll += speed * dt;

    var carX = W * 0.28;
    var rear = groundY(scroll + carX - WHEELBASE / 2);
    var front = groundY(scroll + carX + WHEELBASE / 2);
    var ground = (rear + front) / 2;
    var slope = Math.atan2(front - rear, WHEELBASE);

    if (car.air) {
      car.vy += GRAVITY * dt;
      car.y += car.vy * dt;
      car.angle += (Math.max(-0.35, Math.min(0.35, car.vy * 0.004)) - car.angle) * Math.min(dt * 6, 1);
      if (car.y >= ground) {
        car.y = ground;
        car.air = false;
        car.vy = 0;
        puff(10);
      }
    } else {
      car.y = ground;
      car.angle += (slope - car.angle) * Math.min(dt * 12, 1);
      if (speed > 60 && Math.random() < dt * 22) puff(1);
    }
    car.spin += speed * dt * 0.35;

    for (var i = dust.length - 1; i >= 0; i--) {
      var d = dust[i];
      d.life -= dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.vy += 30 * dt;
      if (d.life <= 0) dust.splice(i, 1);
    }

    if (speedOut) speedOut.textContent = String(Math.round(speed));
    render(t);
  }

  /* ---------- Rendering ---------- */
  function render(t) {
    var p = palette;
    var sky = b.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, p.skyTop);
    sky.addColorStop(1, p.skyBottom);
    b.fillStyle = sky;
    b.fillRect(0, 0, W, H);

    if (p.star) {
      b.fillStyle = p.star;
      for (var s = 0; s < stars.length; s++) {
        var st = stars[s];
        if (Math.sin(t * 0.002 + st.p) > -0.3) b.fillRect(Math.round(st.x), Math.round(st.y), 1, 1);
      }
    }

    // sun / moon
    b.fillStyle = p.sun;
    var sx = Math.round(W * 0.82), sy = Math.round(H * 0.2);
    b.fillRect(sx - 3, sy - 5, 7, 11);
    b.fillRect(sx - 5, sy - 3, 11, 7);
    b.fillRect(sx - 4, sy - 4, 9, 9);

    // clouds drift slowly
    b.fillStyle = p.cloud;
    for (var c = 0; c < clouds.length; c++) {
      var cl = clouds[c];
      var cxp = ((cl.x - scroll * 0.08) % (W + 40) + W + 40) % (W + 40) - 20;
      b.fillRect(Math.round(cxp), Math.round(cl.y), Math.round(cl.w), 3);
      b.fillRect(Math.round(cxp + cl.w * 0.25), Math.round(cl.y - 2), Math.round(cl.w * 0.45), 2);
    }

    var x;
    b.fillStyle = p.far;
    for (x = 0; x < W; x++) {
      var fy = Math.round(farY(x + scroll * 0.2));
      b.fillRect(x, fy, 1, H - fy);
    }
    b.fillStyle = p.mid;
    for (x = 0; x < W; x++) {
      var my = Math.round(midY(x + scroll * 0.5));
      b.fillRect(x, my, 1, H - my);
    }
    for (x = 0; x < W; x++) {
      var gy = Math.round(groundY(x + scroll));
      b.fillStyle = p.ground;
      b.fillRect(x, gy, 1, H - gy);
      b.fillStyle = p.grass;
      b.fillRect(x, gy, 1, 1);
      // little fence posts every so often
      if (Math.floor(x + scroll) % 46 === 0) b.fillRect(x, gy - 3, 1, 3);
    }

    // dust
    b.fillStyle = p.dust;
    for (var i = 0; i < dust.length; i++) {
      b.fillRect(Math.round(dust[i].x), Math.round(dust[i].y), 1, 1);
    }

    // car
    var carX = W * 0.28;
    var bounce = car.air ? 0 : Math.round(Math.sin(t * 0.03) * 0.5);
    b.save();
    b.translate(Math.round(carX), Math.round(car.y) + bounce);
    b.rotate(car.angle);
    b.imageSmoothingEnabled = false;
    b.drawImage(sprite, -9, -10);
    drawWheel(-5, -2);
    drawWheel(5, -2);
    b.restore();

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buf, 0, 0, W, H, 0, 0, canvas.width, canvas.height);
  }

  function drawWheel(x, y) {
    b.fillStyle = palette.wheel;
    b.fillRect(x - 1, y - 2, 3, 5);
    b.fillRect(x - 2, y - 1, 5, 3);
    // rotating hub pixel
    var k = Math.floor(car.spin) % 4;
    var off = [[0, -1], [1, 0], [0, 1], [-1, 0]][k];
    b.fillStyle = palette.hub;
    b.fillRect(x + off[0], y + off[1], 1, 1);
  }

  /* ---------- Loop ---------- */
  function frame(now) {
    var dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    step(dt, now);
    raf = onScreen ? requestAnimationFrame(frame) : 0;
  }

  function startLoop() {
    if (raf || reduceMotion) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  /* ---------- Init ---------- */
  applyTheme();
  resize();
  render(0);

  if (reduceMotion) return;

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      onScreen = entries[0].isIntersecting;
      if (onScreen) startLoop();
    }).observe(canvas);
  } else {
    startLoop();
  }

  canvas.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    jump();
    boosting = true;
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) {
    canvas.addEventListener(ev, function () { boosting = false; });
  });
  canvas.addEventListener('keydown', function (e) {
    if (e.code === 'Space' || e.key === ' ' || e.key === 'ArrowUp') {
      e.preventDefault();
      jump();
    } else if (e.key === 'ArrowRight') {
      boosting = true;
    }
  });
  canvas.addEventListener('keyup', function (e) {
    if (e.key === 'ArrowRight') boosting = false;
  });

  // Re-read colours when the theme changes (toggle or OS setting).
  new MutationObserver(applyTheme).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme']
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { resize(); render(performance.now()); }, 150);
  });
})();
