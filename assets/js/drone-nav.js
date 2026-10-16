/* Pixel-art illustration of vision-language drone navigation.
   Each episode generates a small city, types out a language instruction,
   and flies a drone through it step by step. A dashed box marks the landmark
   the drone is grounding at each step. This is an illustration only. */
(function () {
  'use strict';

  var canvas = document.getElementById('drone-nav');
  if (!canvas || !canvas.getContext) return;

  var ctx = canvas.getContext('2d');
  var promptEl = document.getElementById('drone-prompt');
  var stepsEl = document.getElementById('drone-steps');
  var statusEl = document.getElementById('drone-status');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var PX = 3;               // CSS pixels per scene pixel
  var CRUISE_SPEED = 30;    // scene px / s
  var LAND_SPEED = 14;
  var TYPE_RATE = 42;       // characters / s
  var HOLD_MS = 2600;       // pause after reaching the goal

  var buf = document.createElement('canvas');
  var b = buf.getContext('2d');
  var W = 0, H = 0, GROUND = 0;

  var city = [], trees = [], stars = [], skyline = [];
  var landmarks = {};
  var ep = null;
  var palette = null;
  var raf = 0, last = 0, onScreen = true;

  var PALETTES = {
    light: {
      skyTop: '#dfe6fb', skyBottom: '#f5f6fa', far: '#cdd4ea',
      bldg: ['#4a5372', '#5a6485', '#414a66'], win: '#c3cbe6', winLit: '#ffc56b',
      ground: '#2a3042', tree: '#4caf8a', trunk: '#2a3042',
      tower: '#c22a60', pad: '#3550e8', padMark: '#ffffff',
      drone: '#0f1426', rotor: '#7d849a', led: '#ff3b30',
      trail: '#3550e8', box: '#c22a60', star: null
    },
    dark: {
      skyTop: '#070a14', skyBottom: '#121a30', far: '#141c36',
      bldg: ['#1b2442', '#212b4e', '#18203b'], win: '#26304f', winLit: '#ffc56b',
      ground: '#080b16', tree: '#2a7a63', trunk: '#080b16',
      tower: '#ff7aa2', pad: '#7c9cff', padMark: '#0a0e1a',
      drone: '#eef1fb', rotor: '#8a92a9', led: '#ff5a7a',
      trail: '#7c9cff', box: '#ff7aa2', star: '#e6e9f5'
    }
  };

  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    return t === 'light' ? 'light' : 'dark';   // dark is the site default
  }
  function applyTheme() {
    palette = PALETTES[currentTheme()];
    if (reduceMotion && ep) render(0);
  }

  function rand(a, c) { return a + Math.random() * (c - a); }
  function randInt(a, c) { return Math.floor(rand(a, c + 1)); }

  /* ---------- City ---------- */
  function genCity() {
    city = []; trees = []; landmarks = {};
    var x = 20;   // launch pad lives at x 2..14
    while (x < W - 8) {
      var w = randInt(10, 20);
      if (x + w > W - 3) break;
      if (Math.random() < 0.12 && city.length > 1) {
        trees.push({ x: x + 1, w: w - 2 });
        x += w + 2;
        continue;
      }
      var h = Math.round(rand(H * 0.2, H * 0.5));
      city.push({ x: x, w: w, h: h, top: GROUND - h, kind: 'plain', shade: randInt(0, 2), windows: [] });
      x += w + randInt(1, 3);
    }
    if (city.length < 3) return;

    var n = city.length;
    var towerIdx = randInt(Math.floor(n * 0.25), Math.max(Math.floor(n * 0.25), Math.floor(n * 0.55)));
    var heliIdx = randInt(Math.max(towerIdx + 1, Math.floor(n * 0.65)), n - 1);
    var antennaPool = [];
    for (var i = 1; i < n; i++) if (i !== towerIdx && i !== heliIdx) antennaPool.push(i);
    var antennaIdx = antennaPool.length ? antennaPool[randInt(0, antennaPool.length - 1)] : towerIdx;

    var tower = city[towerIdx];
    tower.kind = 'tower';
    tower.w = Math.min(tower.w, 9);
    tower.h = Math.round(H * 0.64);
    tower.top = GROUND - tower.h;

    var heli = city[heliIdx];
    heli.kind = 'helipad';
    heli.w = Math.max(heli.w, 13);
    if (heli.x + heli.w > W - 2) heli.w = W - 2 - heli.x;
    heli.h = Math.round(rand(H * 0.28, H * 0.42));
    heli.top = GROUND - heli.h;

    var ant = city[antennaIdx];
    if (ant.kind === 'plain') ant.kind = 'antenna';

    landmarks = { tower: tower, helipad: heli, antenna: ant.kind === 'antenna' ? ant : tower };

    city.forEach(function (bd) {
      bd.windows = [];
      for (var wy = bd.top + 3; wy < GROUND - 2; wy += 4) {
        for (var wx = bd.x + 2; wx < bd.x + bd.w - 2; wx += 3) {
          bd.windows.push({ x: wx, y: wy, lit: Math.random() < 0.3 });
        }
      }
    });

    skyline = [];
    var sh = H * 0.45;
    for (var sx = 0; sx < W; sx++) {
      if (sx % 6 === 0) sh = H * rand(0.3, 0.55);
      skyline.push(Math.round(GROUND - sh));
    }
    stars = [];
    for (var s = 0; s < W / 8; s++) stars.push({ x: randInt(0, W - 1), y: randInt(1, Math.round(H * 0.35)), p: rand(0, 6.28) });
  }

  /* ---------- Episodes ---------- */
  var VIAS = {
    tower:   { phrase: 'fly past the pink tower',             step: 'fly past the pink tower' },
    antenna: { phrase: 'pass the building with the antenna',  step: 'pass the antenna building' }
  };

  function newEpisode() {
    genCity();
    if (!landmarks.helipad) return null;

    var viaKey = landmarks.antenna !== landmarks.tower && Math.random() < 0.45 ? 'antenna' : 'tower';
    var via = landmarks[viaKey];
    var heli = landmarks.helipad;

    var tallest = Math.min.apply(null, city.map(function (bd) { return bd.top - (bd.kind === 'antenna' ? 8 : bd.kind === 'tower' ? 5 : 0); }));
    var cruise = Math.max(6, tallest - 7);
    var padX = 8;

    var steps = ['take off from the pad', 'climb above the rooftops', VIAS[viaKey].step, 'find the helipad', 'land on the helipad'];
    var text = 'Take off, climb above the rooftops, ' + VIAS[viaKey].phrase + ', then land on the helipad.';

    var cx = function (bd) { return bd.x + Math.floor(bd.w / 2); };
    var wps = [
      { x: padX, y: GROUND - 1 },
      { x: padX, y: GROUND - 12, step: 0, box: null, speed: LAND_SPEED },
      { x: padX, y: cruise, step: 1, box: null, speed: CRUISE_SPEED },
      { x: cx(via), y: cruise, step: 2, box: via, speed: CRUISE_SPEED },
      { x: cx(heli), y: cruise, step: 3, box: heli, speed: CRUISE_SPEED },
      { x: cx(heli), y: heli.top - 2, step: 4, box: heli, speed: LAND_SPEED }
    ];

    return {
      text: text, typed: 0, steps: steps, wps: wps,
      seg: 0, segT: 0, x: wps[0].x, y: wps[0].y,
      phase: 'typing', holdUntil: 0, trail: [], trailClock: 0,
      shownStep: -2
    };
  }

  function renderSteps(active, done) {
    if (!stepsEl) return;
    if (stepsEl.children.length !== ep.steps.length) {
      stepsEl.innerHTML = '';
      ep.steps.forEach(function (s) {
        var li = document.createElement('li');
        li.textContent = s;
        stepsEl.appendChild(li);
      });
    }
    Array.prototype.forEach.call(stepsEl.children, function (li, i) {
      li.classList.toggle('is-active', i === active && !done);
      li.classList.toggle('is-done', done || i < active);
    });
  }

  function setStatus(text) {
    if (statusEl && statusEl.textContent !== text) statusEl.textContent = text;
  }

  function startEpisode() {
    ep = newEpisode();
    if (!ep) return;
    if (promptEl) promptEl.textContent = '';
    if (stepsEl) stepsEl.innerHTML = '';
    renderSteps(-1, false);
    setStatus('parsing instruction…');
  }

  /* ---------- Simulation ---------- */
  function update(dt, now) {
    if (!ep) return;

    if (ep.phase === 'typing') {
      ep.typed = Math.min(ep.text.length, ep.typed + TYPE_RATE * dt);
      if (promptEl) promptEl.textContent = ep.text.slice(0, Math.floor(ep.typed));
      if (ep.typed >= ep.text.length) {
        ep.phase = 'flying';
        renderSteps(0, false);
      }
      return;
    }

    if (ep.phase === 'flying') {
      var to = ep.wps[ep.seg + 1];
      var dx = to.x - ep.x, dy = to.y - ep.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var move = to.speed * dt;
      if (dist <= move) {
        ep.x = to.x; ep.y = to.y;
        ep.seg++;
        if (ep.seg >= ep.wps.length - 1) {
          ep.phase = 'done';
          ep.holdUntil = now + HOLD_MS;
          renderSteps(ep.steps.length, true);
          setStatus('goal reached ✓');
          return;
        }
      } else {
        ep.x += (dx / dist) * move;
        ep.y += (dy / dist) * move;
      }
      var step = ep.wps[ep.seg + 1].step;
      if (step !== ep.shownStep) {
        ep.shownStep = step;
        renderSteps(step, false);
        setStatus('step ' + (step + 1) + ' / ' + ep.steps.length);
      }
      ep.trailClock += dt;
      if (ep.trailClock > 0.08) {
        ep.trailClock = 0;
        ep.trail.push({ x: Math.round(ep.x), y: Math.round(ep.y) - 2 });
        if (ep.trail.length > 160) ep.trail.shift();
      }
      return;
    }

    if (ep.phase === 'done' && now > ep.holdUntil) startEpisode();
  }

  /* ---------- Rendering ---------- */
  function render(now) {
    var p = palette;
    var sky = b.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, p.skyTop);
    sky.addColorStop(1, p.skyBottom);
    b.fillStyle = sky;
    b.fillRect(0, 0, W, H);

    if (p.star) {
      b.fillStyle = p.star;
      stars.forEach(function (s) {
        if (Math.sin(now * 0.002 + s.p) > -0.2) b.fillRect(s.x, s.y, 1, 1);
      });
    }

    b.fillStyle = p.far;
    for (var x = 0; x < skyline.length; x++) b.fillRect(x, skyline[x], 1, GROUND - skyline[x]);

    // launch pad
    b.fillStyle = p.pad;
    b.fillRect(2, GROUND - 1, 13, 1);

    var blink = Math.floor(now / 500) % 2 === 0;

    city.forEach(function (bd) {
      b.fillStyle = p.bldg[bd.shade];
      b.fillRect(bd.x, bd.top, bd.w, GROUND - bd.top);
      bd.windows.forEach(function (w) {
        b.fillStyle = w.lit ? p.winLit : p.win;
        b.fillRect(w.x, w.y, 1, 2);
      });
      var mid = bd.x + Math.floor(bd.w / 2);
      if (bd.kind === 'tower') {
        b.fillStyle = p.tower;
        b.fillRect(bd.x, bd.top, bd.w, 3);
        b.fillRect(mid, bd.top - 5, 1, 5);
        if (blink) { b.fillStyle = p.led; b.fillRect(mid, bd.top - 6, 1, 1); }
      } else if (bd.kind === 'antenna') {
        b.fillStyle = p.bldg[bd.shade];
        b.fillRect(mid, bd.top - 8, 1, 8);
        b.fillRect(mid - 2, bd.top - 5, 5, 1);
        if (!blink) { b.fillStyle = p.led; b.fillRect(mid, bd.top - 9, 1, 1); }
      } else if (bd.kind === 'helipad') {
        b.fillStyle = p.pad;
        b.fillRect(mid - 4, bd.top - 1, 9, 1);
        b.fillStyle = p.padMark;
        b.fillRect(mid - 1, bd.top - 1, 3, 1);
        if (blink) {
          b.fillStyle = p.pad;
          b.fillRect(mid - 5, bd.top - 2, 1, 1);
          b.fillRect(mid + 5, bd.top - 2, 1, 1);
        }
      }
    });

    trees.forEach(function (t) {
      b.fillStyle = p.tree;
      b.fillRect(t.x, GROUND - 6, t.w, 4);
      b.fillRect(t.x + 1, GROUND - 7, t.w - 2, 1);
      b.fillStyle = p.trunk;
      b.fillRect(t.x + Math.floor(t.w / 2), GROUND - 2, 1, 2);
    });

    b.fillStyle = p.ground;
    b.fillRect(0, GROUND, W, H - GROUND);

    if (!ep) { blit(); return; }

    // trail
    b.fillStyle = p.trail;
    for (var i = 0; i < ep.trail.length; i += 2) b.fillRect(ep.trail[i].x, ep.trail[i].y, 1, 1);

    // grounding box on the current landmark
    var target = ep.phase === 'flying' ? ep.wps[ep.seg + 1].box : ep.phase === 'done' ? landmarks.helipad : null;
    if (target) drawBox(target, now);

    drawDrone(ep.x, ep.y, now, ep.phase === 'flying' || ep.phase === 'typing');
    blit();
  }

  function drawBox(bd, now) {
    var extra = bd.kind === 'tower' ? 7 : bd.kind === 'antenna' ? 10 : 3;
    var x0 = bd.x - 2, y0 = bd.top - extra, x1 = bd.x + bd.w + 1, y1 = GROUND - 1;
    var dash = Math.floor(now / 120) % 3;
    b.fillStyle = palette.box;
    for (var x = x0; x <= x1; x++) {
      if ((x + dash) % 3 !== 0) { b.fillRect(x, y0, 1, 1); b.fillRect(x, y1, 1, 1); }
    }
    for (var y = y0; y <= y1; y++) {
      if ((y + dash) % 3 !== 0) { b.fillRect(x0, y, 1, 1); b.fillRect(x1, y, 1, 1); }
    }
    // solid corners
    b.fillRect(x0, y0, 3, 1); b.fillRect(x0, y0, 1, 3);
    b.fillRect(x1 - 2, y0, 3, 1); b.fillRect(x1, y0, 1, 3);
  }

  function drawDrone(x, y, now, flying) {
    var bob = flying && ep.phase === 'flying' ? Math.round(Math.sin(now * 0.012) * 0.6) : 0;
    x = Math.round(x);
    y = Math.round(y) + bob;
    var p = palette;
    b.fillStyle = p.drone;
    b.fillRect(x - 2, y - 3, 5, 2);       // body
    b.fillRect(x - 4, y - 4, 9, 1);       // arms
    b.fillRect(x - 2, y - 1, 1, 1);       // legs
    b.fillRect(x + 2, y - 1, 1, 1);
    b.fillStyle = p.rotor;
    if (Math.floor(now / 60) % 2 === 0) {
      b.fillRect(x - 6, y - 5, 4, 1);
      b.fillRect(x + 3, y - 5, 4, 1);
    } else {
      b.fillRect(x - 5, y - 5, 2, 1);
      b.fillRect(x + 4, y - 5, 2, 1);
    }
    if (Math.floor(now / 400) % 2 === 0) {
      b.fillStyle = p.led;
      b.fillRect(x, y - 3, 1, 1);
    }
  }

  function blit() {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buf, 0, 0, W, H, 0, 0, canvas.width, canvas.height);
  }

  /* ---------- Setup & loop ---------- */
  function resize() {
    var cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    W = Math.max(90, Math.round(cssW / PX));
    H = Math.max(50, Math.round(cssH / PX));
    GROUND = H - 5;
    buf.width = W;
    buf.height = H;
  }

  function frame(now) {
    var dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    update(dt, now);
    render(now);
    raf = onScreen ? requestAnimationFrame(frame) : 0;
  }

  function startLoop() {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  /* Reduced motion: show one finished episode with the full path drawn. */
  function staticEpisode() {
    startEpisode();
    if (!ep) return;
    if (promptEl) promptEl.textContent = ep.text;
    for (var i = 0; i < ep.wps.length - 1; i++) {
      var a = ep.wps[i], c = ep.wps[i + 1];
      var n = Math.max(Math.abs(c.x - a.x), Math.abs(c.y - a.y));
      for (var k = 0; k <= n; k += 2) {
        ep.trail.push({ x: Math.round(a.x + (c.x - a.x) * k / n), y: Math.round(a.y + (c.y - a.y) * k / n) - 2 });
      }
    }
    var end = ep.wps[ep.wps.length - 1];
    ep.x = end.x; ep.y = end.y;
    ep.phase = 'done';
    renderSteps(ep.steps.length, true);
    setStatus('goal reached ✓');
    render(0);
  }

  applyTheme();
  resize();

  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  if (reduceMotion) {
    staticEpisode();
    return;
  }

  startEpisode();
  render(0);

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      onScreen = entries[0].isIntersecting;
      if (onScreen) startLoop();
    }).observe(canvas);
  } else {
    startLoop();
  }

  var resizeTimer = 0, lastW = canvas.clientWidth;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (canvas.clientWidth === lastW) return;
      lastW = canvas.clientWidth;
      resize();
      startEpisode();
    }, 200);
  });
})();
