/* Pixel illustration of a self-improving agent loop (generate -> verify -> learn).
   Each round the agent samples K candidate answers, a verifier scans and marks
   them, and the passing ones flow back into the agent, raising its skill.
   A chart on the right tracks the success rate per round. Illustration only. */
(function () {
  'use strict';

  var canvas = document.getElementById('learn-loop');
  if (!canvas || !canvas.getContext) return;

  var ctx = canvas.getContext('2d');
  var stagesEl = document.getElementById('loop-stages');
  var roundEl = document.getElementById('loop-round');
  var rateEl = document.getElementById('loop-rate');
  var reduceMotion = document.documentElement.classList.contains('reduce-motion');

  var PX = 3;
  var K = 8;                      // candidates per round
  var MAX_ROUNDS = 12;
  var T = { sample: 1500, verify: 1300, learn: 1100, hold: 2600 };

  var buf = document.createElement('canvas');
  var b = buf.getContext('2d');
  var W = 0, H = 0;
  var C = {};
  var L = {};                     // layout
  var raf = 0, onScreen = true, last = 0;

  var sim;

  function colours() {
    var cs = getComputedStyle(document.documentElement);
    var g = function (n, fb) { return (cs.getPropertyValue(n) || '').trim() || fb; };
    C = {
      bg: g('--clr-bg-alt', '#10162a'), surface: g('--clr-surface', '#121a30'),
      border: g('--clr-border', '#232b45'), text: g('--clr-primary', '#eef1fb'),
      muted: g('--clr-muted', '#8a92a9'), ok: g('--clr-accent', '#7c9cff'), bad: g('--clr-signal', '#ff7aa2')
    };
  }

  function layout() {
    var cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    W = Math.max(100, Math.round(cssW / PX));
    H = Math.max(50, Math.round(cssH / PX));
    buf.width = W; buf.height = H;

    var leftW = Math.round(W * 0.58);
    var agent = Math.max(12, Math.min(18, Math.round(H * 0.26)));
    var cols = 4, rows = 2, gap = 3;
    var tileW = Math.max(8, Math.floor((leftW - agent - 14 - gap * (cols - 1)) / cols));
    var tileH = Math.max(7, Math.min(Math.round(tileW * 0.72), Math.floor((H - 16 - gap) / rows)));
    var gridH = rows * tileH + gap;
    var top = Math.round((H - gridH) / 2);
    L = {
      agentX: 4, agentY: Math.round(H / 2 - agent / 2), agent: agent,
      gridX: 4 + agent + 10, gridY: top, tileW: tileW, tileH: tileH, gap: gap, cols: cols,
      chartX: leftW + 8, chartY: 6, chartW: W - leftW - 12, chartH: H - 14
    };
  }

  function tileRect(i) {
    var c = i % L.cols, r = Math.floor(i / L.cols);
    return { x: L.gridX + c * (L.tileW + L.gap), y: L.gridY + r * (L.tileH + L.gap), w: L.tileW, h: L.tileH };
  }

  function newTask() {
    sim = {
      p: 0.18 + Math.random() * 0.08,  // agent skill = chance a sample passes
      round: 1, history: [], phase: 'sample', t0: 0,
      tiles: [], flyers: [], passed: 0
    };
    newRound();
  }

  function newRound() {
    sim.tiles = [];
    for (var i = 0; i < K; i++) sim.tiles.push({ shown: false, verdict: null });
    sim.passed = 0;
    sim.phase = 'sample';
    sim.t0 = performance.now();
    setStage('sample');
    if (roundEl) roundEl.textContent = String(sim.round);
  }

  function setStage(name) {
    if (!stagesEl) return;
    Array.prototype.forEach.call(stagesEl.children, function (li) {
      li.classList.toggle('is-active', li.getAttribute('data-stage') === name);
    });
  }

  /* ---------- simulation ---------- */
  function update(now) {
    var e = now - sim.t0;

    if (sim.phase === 'sample') {
      var shown = Math.min(K, Math.floor(e / (T.sample / K)) + 1);
      for (var i = 0; i < shown; i++) sim.tiles[i].shown = true;
      if (e >= T.sample) { sim.phase = 'verify'; sim.t0 = now; setStage('verify'); }
      return;
    }

    if (sim.phase === 'verify') {
      sim.scan = e / T.verify;                         // 0..1 across the grid columns
      var col = Math.floor(sim.scan * L.cols);
      sim.tiles.forEach(function (tile, i) {
        if (tile.verdict === null && i % L.cols < col) {
          tile.verdict = Math.random() < sim.p ? 'ok' : 'bad';
          if (tile.verdict === 'ok') sim.passed++;
        }
      });
      if (e >= T.verify) {
        sim.tiles.forEach(function (tile) {
          if (tile.verdict === null) { tile.verdict = Math.random() < sim.p ? 'ok' : 'bad'; if (tile.verdict === 'ok') sim.passed++; }
        });
        var rate = sim.passed / K;
        sim.history.push(rate);
        if (rateEl) rateEl.textContent = Math.round(rate * 100) + '%';
        // passing samples fly back into the agent
        sim.tiles.forEach(function (tile, i) {
          if (tile.verdict !== 'ok') return;
          var r = tileRect(i);
          for (var k = 0; k < 4; k++) {
            sim.flyers.push({
              x: r.x + Math.random() * r.w, y: r.y + Math.random() * r.h,
              tx: L.agentX + 2 + Math.random() * (L.agent - 4), ty: L.agentY + 2 + Math.random() * (L.agent - 4),
              d: Math.random() * 0.35
            });
          }
        });
        sim.phase = 'learn'; sim.t0 = now; setStage('learn');
      }
      return;
    }

    if (sim.phase === 'learn') {
      if (e >= T.learn) {
        // learning step: more passes -> bigger improvement, with diminishing returns
        sim.p = Math.min(0.97, sim.p + 0.32 * (sim.passed / K + 0.15) * (1 - sim.p) + (Math.random() - 0.5) * 0.03);
        sim.flyers = [];
        if (sim.round >= MAX_ROUNDS || (sim.history.length > 2 && sim.history.slice(-2).every(function (r) { return r >= 0.95; }))) {
          sim.phase = 'hold'; sim.t0 = now; setStage('');
          return;
        }
        sim.round++;
        newRound();
      }
      return;
    }

    if (sim.phase === 'hold' && e >= T.hold) newTask();
  }

  /* ---------- drawing ---------- */
  function render(now) {
    b.fillStyle = C.bg;
    b.fillRect(0, 0, W, H);

    drawAgent(now);

    // dotted link agent -> samples
    b.fillStyle = C.border;
    var midY = L.agentY + Math.floor(L.agent / 2);
    for (var x = L.agentX + L.agent + 1; x < L.gridX - 1; x += 2) b.fillRect(x, midY, 1, 1);

    sim.tiles.forEach(function (tile, i) { drawTile(tile, tileRect(i), now); });

    if (sim.phase === 'verify') {
      var gx = L.gridX + Math.round(sim.scan * (L.cols * (L.tileW + L.gap)));
      b.fillStyle = C.text;
      b.globalAlpha = 0.6;
      b.fillRect(gx, L.gridY - 3, 1, 2 * L.tileH + L.gap + 6);
      b.globalAlpha = 1;
    }

    if (sim.phase === 'learn') {
      var k = Math.min(1, (now - sim.t0) / T.learn);
      b.fillStyle = C.ok;
      sim.flyers.forEach(function (f) {
        var u = Math.max(0, Math.min(1, (k - f.d) / (1 - f.d)));
        u = 1 - Math.pow(1 - u, 3);
        b.fillRect(Math.round(f.x + (f.tx - f.x) * u), Math.round(f.y + (f.ty - f.y) * u), 1, 1);
      });
    }

    drawChart(now);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buf, 0, 0, W, H, 0, 0, canvas.width, canvas.height);
  }

  function drawAgent(now) {
    var x = L.agentX, y = L.agentY, s = L.agent;
    b.fillStyle = C.surface;
    b.fillRect(x, y, s, s);
    var fill = Math.round((s - 2) * sim.p);
    b.fillStyle = C.ok;
    b.globalAlpha = 0.45;
    b.fillRect(x + 1, y + s - 1 - fill, s - 2, fill);
    b.globalAlpha = 1;
    b.fillStyle = C.border;
    b.fillRect(x, y, s, 1); b.fillRect(x, y + s - 1, s, 1);
    b.fillRect(x, y, 1, s); b.fillRect(x + s - 1, y, 1, s);
    // face: two eyes that blink, antenna
    var blink = Math.floor(now / 2600) % 6 === 0 && (now % 2600) < 160;
    b.fillStyle = C.text;
    var ey = y + Math.round(s * 0.38);
    b.fillRect(x + Math.round(s * 0.3), ey, 2, blink ? 1 : 2);
    b.fillRect(x + Math.round(s * 0.6), ey, 2, blink ? 1 : 2);
    b.fillRect(x + Math.floor(s / 2), y - 3, 1, 3);
    b.fillStyle = sim.phase === 'learn' ? C.ok : C.bad;
    b.fillRect(x + Math.floor(s / 2), y - 4, 1, 1);
  }

  function drawTile(tile, r, now) {
    if (!tile.shown) {
      b.fillStyle = C.border;
      for (var x = r.x; x < r.x + r.w; x += 2) { b.fillRect(x, r.y, 1, 1); b.fillRect(x, r.y + r.h - 1, 1, 1); }
      return;
    }
    b.fillStyle = C.surface;
    b.fillRect(r.x, r.y, r.w, r.h);
    if (tile.verdict === null) {
      // still "being generated": flickering token pixels
      for (var yy = r.y + 2; yy < r.y + r.h - 2; yy += 2) {
        for (var xx = r.x + 2; xx < r.x + r.w - 2; xx += 2) {
          if (Math.random() < 0.45) { b.fillStyle = Math.random() < 0.5 ? C.muted : C.text; b.fillRect(xx, yy, 1, 1); }
        }
      }
      b.fillStyle = C.border;
    } else {
      var ok = tile.verdict === 'ok';
      b.fillStyle = ok ? C.ok : C.bad;
      // fixed "text" lines
      for (var ly = r.y + 2; ly < r.y + r.h - 3; ly += 2) b.fillRect(r.x + 2, ly, Math.max(2, r.w - 6 - (ly % 3)), 1);
      // mark: check or cross in the corner
      var cx = r.x + r.w - 4, cy = r.y + r.h - 4;
      if (ok) { b.fillRect(cx, cy + 1, 1, 1); b.fillRect(cx + 1, cy + 2, 1, 1); b.fillRect(cx + 2, cy + 1, 1, 1); b.fillRect(cx + 3, cy, 1, 1); }
      else { b.fillRect(cx, cy, 1, 1); b.fillRect(cx + 2, cy, 1, 1); b.fillRect(cx + 1, cy + 1, 1, 1); b.fillRect(cx, cy + 2, 1, 1); b.fillRect(cx + 2, cy + 2, 1, 1); }
    }
    // border
    b.fillRect(r.x, r.y, r.w, 1); b.fillRect(r.x, r.y + r.h - 1, r.w, 1);
    b.fillRect(r.x, r.y, 1, r.h); b.fillRect(r.x + r.w - 1, r.y, 1, r.h);
  }

  function drawChart(now) {
    var x0 = L.chartX, y0 = L.chartY, w = L.chartW, h = L.chartH;
    b.fillStyle = C.border;
    b.fillRect(x0, y0 + h, w, 1);          // x axis
    b.fillRect(x0, y0, 1, h);              // y axis
    for (var gy = 0; gy <= 4; gy++) {      // dotted gridlines at 0/25/50/75/100%
      var yy = y0 + Math.round(h * gy / 4);
      for (var gx = x0 + 2; gx < x0 + w; gx += 3) b.fillRect(gx, yy, 1, 1);
    }
    var n = sim.history.length;
    var step = (w - 4) / (MAX_ROUNDS - 1);
    var px = function (i) { return x0 + 2 + Math.round(i * step); };
    var py = function (v) { return y0 + Math.round(h * (1 - v)); };

    // line between points
    b.fillStyle = C.ok;
    for (var i = 1; i < n; i++) {
      var ax = px(i - 1), ay = py(sim.history[i - 1]), bx = px(i), by = py(sim.history[i]);
      var steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
      for (var s = 0; s <= steps; s++) b.fillRect(Math.round(ax + (bx - ax) * s / steps), Math.round(ay + (by - ay) * s / steps), 1, 1);
    }
    for (var j = 0; j < n; j++) {
      b.fillStyle = j === n - 1 && Math.floor(now / 400) % 2 ? C.bad : C.ok;
      b.fillRect(px(j) - 1, py(sim.history[j]) - 1, 3, 3);
    }
  }

  /* ---------- loop ---------- */
  function frame(now) {
    update(now);
    render(now);
    raf = onScreen ? requestAnimationFrame(frame) : 0;
  }

  colours();
  layout();
  newTask();

  if (reduceMotion) {
    // static summary: a finished run
    var hist = [0.25, 0.38, 0.5, 0.62, 0.62, 0.75, 0.88, 0.88, 1];
    sim.history = hist; sim.p = 0.9; sim.round = hist.length;
    sim.tiles.forEach(function (t, i) { t.shown = true; t.verdict = i < 7 ? 'ok' : 'bad'; });
    if (roundEl) roundEl.textContent = String(hist.length);
    if (rateEl) rateEl.textContent = '100%';
    setStage('');
    render(0);
    return;
  }

  render(performance.now());
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      onScreen = entries[0].isIntersecting;
      if (onScreen && !raf) raf = requestAnimationFrame(frame);
    }).observe(canvas);
  } else {
    raf = requestAnimationFrame(frame);
  }

  var rt = 0, lastW = canvas.clientWidth;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      if (canvas.clientWidth === lastW) return;
      lastW = canvas.clientWidth;
      layout();
      render(performance.now());
    }, 200);
  });
})();
