/* Background physics on the GPU (WebGL2), kept to about 5% of the frame budget.
   Particle state lives in a float texture and is integrated by a fragment shader. The 30 processes
   themselves (their equations of motion and their colouring) are in bg-scenes.js; this file is the engine:

     - every scene gets its own pair of small programs, compiled lazily and in parallel
       (KHR_parallel_shader_compile) while the previous scene is still playing;
     - scenes come from a shuffled bag, so all 30 appear once before any repeats; then the bag is refilled;
     - each scene fades in and out over the paper, and tells the portrait (pixel-hero.js) through a
       'bgscene' event so both show the same process at the same time.
   Budget: with EXT_disjoint_timer_query_webgl2 the active particle count is steered toward 5% of the
   frame time; without it a modest count is used, thinned if frames drop and restored when they recover.
   Pauses when the tab is hidden or throttled.
   If WebGL2 is unavailable, flow-field.js (2D canvas) runs instead. */
(function () {
  'use strict';

  if (document.documentElement.classList.contains('reduce-motion')) return;
  var DEFS = window.BG_SCENES;
  if (!DEFS || !DEFS.length) return;

  var BUDGET_FRACTION = 0.05;
  var DEFAULT_LEN = 9;                       // seconds per scene
  var FADE_IN = 0.9, FADE_OUT = 0.7;

  var canvas = document.createElement('canvas');
  var gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'low-power' });
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) return;    // 2D fallback takes over

  var small = Math.min(screen.width, screen.height) < 700 || /Mobi|Android/i.test(navigator.userAgent);
  var SIDE = small ? 512 : 1024;            // memory cap: 262k (phones) / 1M (desktop) particles
  var timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  var parallel = gl.getExtension('KHR_parallel_shader_compile');
  var ROWS0 = timerExt ? SIDE / 16 : (small ? SIDE / 16 : SIDE / 8);
  var rows = ROWS0;                          // start here; the governor adjusts

  /* ---------------- shader sources ---------------- */
  var PRE = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n';
  var VS_FULL = '#version 300 es\nconst vec2 P[3] = vec2[3](vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.));\n' +
    'void main(){ gl_Position = vec4(P[gl_VertexID], 0., 1.); }';

  var HASH = [
    'float hash(vec2 p){ vec3 q = fract(vec3(p.xyx)*.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y)*q.z); }',   // Hoskins hash12: no lattice artefacts
    'vec2 gauss(vec2 s){ float u1 = max(hash(s), 1e-4), u2 = hash(s + 17.3);',
    '  return sqrt(-2.*log(u1)) * vec2(cos(6.2831853*u2), sin(6.2831853*u2)); }'
  ].join('\n') + '\n';

  var UPD_LIB = [
    'float refl(float x, float L){ return abs(mod(x - L, 4.*L) - 2.*L) - L; }',   // fold a coordinate back into [-L, L]
    // data distributions for the diffusion and flow-matching scenes: a ring, an S-curve, a spiral
    'vec2 shape(int k, vec2 h){',
    '  if (k == 0) { float a = h.x*6.2831853; return vec2(cos(a), sin(a))*.55 + gauss(h*3.1)*.015; }',
    '  if (k == 1) { float th = h.x*3.1415927;',
    '    vec2 q = h.y < .5 ? vec2(cos(th), sin(th)) : vec2(1. - cos(th), .5 - sin(th));',
    '    return (q - vec2(.5, .25))*.62 + gauss(h*5.7)*.025; }',
    '  float r = sqrt(h.x), th2 = r*12.;',
    '  return vec2(cos(th2), sin(th2))*r*.72 + gauss(h*2.3)*.02;',
    '}'
  ].join('\n') + '\n';

  var FS_INIT = PRE + 'uniform float uAspect, uSeed;\nout vec4 o;\n' + HASH +
    'void main(){ vec2 ij = gl_FragCoord.xy;\n' +
    '  o = vec4((hash(ij + uSeed)*2.-1.)*uAspect, hash(ij.yx*1.37 + uSeed*2.1)*2.-1., 0., 0.); }';

  function updSource(def) {
    return PRE + 'uniform sampler2D uState;\nuniform int uShape, uN;\n' +        // uN: a loop bound the compiler cannot unroll
      'uniform float uTime, uSceneT, uLen, uDt, uAspect, uSeed, uPointerOn, uVar, uFresh, uFromRow;\nuniform vec2 uPointer;\nout vec4 o;\n' +
      HASH + UPD_LIB + (def.fns || '') + '\n' +
      'void main(){\n' +
      '  ivec2 ij = ivec2(gl_FragCoord.xy); vec2 fij = vec2(ij);\n' +
      '  vec4 s = texelFetch(uState, ij, 0);\n' +
      '  vec2 p = s.xy, z = s.zw;\n' +
      '  vec2 cv = vec2(uAspect, 1.);\n' +
      '  vec2 h = vec2(hash(fij*.731 + .13), hash(fij.yx*1.37 + .71));\n' +      // fixed per particle
      '  vec2 eps = gauss(fij*.917 + 3.3);\n' +                                  // fixed Gaussian per particle
      '  vec2 nT = gauss(fij*.53 + uSeed);\n' +                                  // fresh noise every step
      '  bool bounded = true;\n' +
      '  bool fresh = uFresh > .5 || fij.y >= uFromRow;\n' +                     // new scene, or a row that was switched off
      '  if (fresh) z = vec2(0.);\n' +
      def.upd + '\n' +
      '  if (!(abs(p.x) < 1e6 && abs(p.y) < 1e6 && abs(z.x) < 1e6 && abs(z.y) < 1e6)) { p = vec2(9.); z = vec2(0.); bounded = true; }\n' +   // NaN guard
      '  if (bounded && (abs(p.x) > uAspect*1.05 || abs(p.y) > 1.05)) {\n' +
      '    p = vec2((hash(fij*1.31 + uSeed*3.1)*2.-1.)*uAspect, hash(fij.yx*.77 + uSeed*5.3)*2.-1.); z = vec2(0.);\n' +
      '  }\n' +
      '  o = vec4(p, z);\n}';
  }

  function renSource(def) {
    return PRE + 'uniform sampler2D uState;\nuniform int uSide;\n' +
      'uniform float uAspect, uTime, uSceneT, uLen, uPointerOn, uFade, uVar;\nuniform vec2 uPointer;\nuniform vec4 uHeat[3];\n' +
      'uniform vec3 uA, uB;\nuniform float uCenterDim, uInner, uOuter;\nout vec4 vCol;\n' + HASH +
      'const vec3 OCHRE = vec3(.48, .33, .05);\n' +                                // the third Ajrak dye, between madder (uA) and indigo (uB)
      'vec3 ramp(float v){ return v < .5 ? mix(uA, OCHRE, v*2.) : mix(OCHRE, uB, v*2. - 1.); }\n' +
      'void main(){\n' +
      '  ivec2 ij = ivec2(gl_VertexID % uSide, gl_VertexID / uSide);\n' +
      '  vec4 s = texelFetch(uState, ij, 0);\n' +
      '  vec2 pos = s.xy;\n' +
      '  vec3 col = uA; float a = 1.;\n' +
      def.col + '\n' +
      '  gl_Position = vec4(pos.x/uAspect, pos.y, 0., 1.);\n' +
      '  gl_PointSize = 1.;\n' +
      '  a *= uFade;\n' +
      // readability: particles behind the text column are dimmed; the side margins stay bright
      '  a *= mix(uCenterDim, 1., smoothstep(uInner, uOuter, abs(gl_Position.x)));\n' +
      '  vCol = vec4(col, a);\n}';
  }

  var FS_RENDER = PRE + 'uniform float uAlpha, uCap;\nin vec4 vCol;\nout vec4 o;\n' +
    'void main(){ float a = min(uAlpha*vCol.a, uCap); o = vec4(vCol.rgb*a, a); }';   // no single particle glows too bright

  /* ---------------- GL setup ---------------- */
  // Programs are started without waiting for the result; poll() finishes them once the driver is done.
  function begin(vs, fs) {
    var h = { pr: gl.createProgram(), vs: gl.createShader(gl.VERTEX_SHADER), fs: gl.createShader(gl.FRAGMENT_SHADER), u: null };
    gl.shaderSource(h.vs, vs); gl.compileShader(h.vs);
    gl.shaderSource(h.fs, fs); gl.compileShader(h.fs);
    gl.attachShader(h.pr, h.vs); gl.attachShader(h.pr, h.fs);
    gl.linkProgram(h.pr);
    return h;
  }
  function isDone(h) { return !parallel || gl.getProgramParameter(h.pr, parallel.COMPLETION_STATUS_KHR); }
  function finish(h, label) {
    if (!gl.getProgramParameter(h.pr, gl.LINK_STATUS)) {
      throw new Error(label + ': ' + (gl.getProgramInfoLog(h.pr) || '') + (gl.getShaderInfoLog(h.vs) || '') + (gl.getShaderInfoLog(h.fs) || ''));
    }
    h.u = {};
    for (var i = 0, n = gl.getProgramParameter(h.pr, gl.ACTIVE_UNIFORMS); i < n; i++) {
      var name = gl.getActiveUniform(h.pr, i).name.replace(/\[0\]$/, '');
      h.u[name] = gl.getUniformLocation(h.pr, name);
    }
    gl.deleteShader(h.vs); gl.deleteShader(h.fs);
  }
  function stateTexture() {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, SIDE, SIDE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    var f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('float FBO');
    return { t: t, f: f };
  }

  var progInit, vao, tex, cur = 0;
  try {
    progInit = begin(VS_FULL, FS_INIT);
    finish(progInit, 'init');
    vao = gl.createVertexArray();
    tex = [stateTexture(), stateTexture()];
  } catch (err) {
    if (window.console) console.warn('[bg] ' + err.message);
    return;                                   // 2D fallback takes over
  }

  canvas.id = 'bg-gl';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(canvas, document.body.firstChild);
  document.documentElement.classList.add('bg-gl');           // hides the 2D fallback straight away; undone if no scene can start

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  (function seed() {
    var aspect = canvas.width / canvas.height;
    gl.useProgram(progInit.pr);
    gl.bindVertexArray(vao);
    gl.viewport(0, 0, SIDE, SIDE);
    for (var k = 0; k < 2; k++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, tex[k].f);
      gl.uniform1f(progInit.u.uAspect, aspect);
      gl.uniform1f(progInit.u.uSeed, Math.random() * 100 + k);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  })();

  /* ---------------- colours ---------------- */
  var colA = [0.49, 0.61, 1.0], colB = [1.0, 0.48, 0.64];
  (function readColours() {
    var cs = getComputedStyle(document.documentElement);
    var rgb = function (v, fb) {
      var m = /^#([0-9a-f]{6})$/i.exec((v || '').trim());
      if (!m) return fb;
      var n = parseInt(m[1], 16);
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };
    // particles use the deeper dye shades so they read as ink, not pastel tint
    colA = rgb(cs.getPropertyValue('--clr-accent-dark'), colA);
    colB = rgb(cs.getPropertyValue('--clr-signal-dark') || cs.getPropertyValue('--clr-signal'), colB);
  })();

  /* ---------------- scenes ---------------- */
  var scenes = DEFS.map(function (d, i) {
    return { def: d, idx: i, upd: null, ren: null, ready: false, failed: false, building: false };
  });
  var byId = {};
  scenes.forEach(function (sc) { byId[sc.def.id] = sc; });
  var pending = [];

  function build(sc) {
    if (sc.ready || sc.failed || sc.building) return;
    sc.building = true;
    try {
      sc.upd = begin(VS_FULL, updSource(sc.def));
      sc.ren = begin(renSource(sc.def), FS_RENDER);
      pending.push(sc);
    } catch (e) { fail(sc, e); }
  }
  function fail(sc, e) {
    sc.failed = true; sc.building = false;
    [sc.upd, sc.ren].forEach(function (h) { if (h) { gl.deleteProgram(h.pr); gl.deleteShader(h.vs); gl.deleteShader(h.fs); } });
    if (window.console) console.warn('[bg] scene "' + sc.def.id + '" disabled: ' + e.message);
  }
  function settle(sc) {
    try { finish(sc.upd, sc.def.id + ' update'); finish(sc.ren, sc.def.id + ' render'); sc.ready = true; sc.building = false; }
    catch (e) { fail(sc, e); }
  }
  function poll() {
    for (var i = pending.length - 1; i >= 0; i--) {
      var sc = pending[i];
      if (!isDone(sc.upd) || !isDone(sc.ren)) continue;
      pending.splice(i, 1);
      settle(sc);
    }
  }
  function buildNow(sc) {                     // blocking: only for the debug hooks
    build(sc);
    var k = pending.indexOf(sc);
    if (k >= 0) { pending.splice(k, 1); settle(sc); }
  }
  function buildSoon(sc) {                    // without parallel compilation, take the whole stall in an idle callback, not in a frame
    if (parallel) { build(sc); return; }
    if (sc.soon || sc.ready || sc.failed) return;
    sc.soon = true;
    (window.requestIdleCallback || function (f) { return setTimeout(f, 60); })(function () { buildNow(sc); }, { timeout: 1500 });
  }

  // Scenes come from a shuffled bag, so every process appears before any repeats.
  var queue = [];                              // entries {sc, n}: n is the position within its round
  function shuffle(a) {
    for (var k = a.length - 1; k > 0; k--) { var j = Math.floor(Math.random() * (k + 1)); var t = a[k]; a[k] = a[j]; a[j] = t; }
    return a;
  }
  function refill(avoid) {
    var ok = scenes.filter(function (sc) { return !sc.failed; });
    var round = shuffle(ok.slice());
    if (round.length > 1 && round[0] === avoid) { var j = 1 + Math.floor(Math.random() * (round.length - 1)); var t = round[0]; round[0] = round[j]; round[j] = t; }
    round.forEach(function (sc, k) { queue.push({ sc: sc, n: k + 1, of: round.length }); });
  }
  function ensureQueue(need, avoid) {
    queue = queue.filter(function (e) { return !e.sc.failed; });
    for (var guard = 0; queue.length < need && guard < 3; guard++) refill(queue.length ? queue[queue.length - 1].sc : avoid);
  }
  function startRound(first) {                 // a fresh round that opens with the given scene
    var ok = scenes.filter(function (sc) { return !sc.failed; });
    queue = shuffle(ok.filter(function (sc) { return sc !== first; })).map(function (sc, k) { return { sc: sc, n: k + 2, of: ok.length }; });
    return { sc: first, n: 1, of: ok.length };
  }

  var wantNext = false;
  var scene = null, entry = null, sceneStart = -1, curLen = DEFAULT_LEN, uVar = 0.5, shapeKind = 0, fresh = 1;
  var heat = [[0, 0, -99, 0], [0, 0, -99, 0], [0, 0, -99, 0]], nextHeat = 0, heatSlot = 0;
  var t0 = performance.now();
  var lastSeen = '';
  try { lastSeen = localStorage.getItem('bg-scene-id') || ''; } catch (e) {}

  function prefetch() {
    ensureQueue(3, scene);
    for (var k = 0; k < 2 && k < queue.length; k++) buildSoon(queue[k].sc);
  }

  function setScene(e, now) {
    entry = e; scene = e.sc;
    queue = queue.filter(function (x) { return x !== e; });
    sceneStart = -1;                           // set on the first frame, so a compile stall never eats the scene's time
    curLen = scene.def.len || DEFAULT_LEN;
    uVar = Math.random();
    shapeKind = Math.floor(Math.random() * 3);
    fresh = 1;
    nextHeat = 0;
    heat = [[0, 0, -99, 0], [0, 0, -99, 0], [0, 0, -99, 0]];
    var src = scene.def.src;
    if (src && src.kind === 'heat') {
      // start with sources already burning (staggered ages) so the scene is visible at once
      var tNow = (now - t0) / 1000, asp = canvas.width / canvas.height;
      for (var hs = 0; hs < 3; hs++) {
        heat[hs] = [(Math.random() * 1.6 - 0.8) * asp, Math.random() * 1.4 - 0.7, tNow - hs * 0.8, 0.9 + Math.random() * 0.3];
      }
      heatSlot = 2;                          // the next refresh replaces the oldest source
      nextHeat = tNow + 1.4;
    }
    try { localStorage.setItem('bg-scene-id', scene.def.id); } catch (err) {}
    var detail = { name: scene.def.id, index: scene.idx, n: e.n, of: e.of, len: curLen };
    window.__bgCurrent = detail;
    window.dispatchEvent(new CustomEvent('bgscene', { detail: detail }));
    prefetch();
  }

  // first scene: a random one the visitor did not see last, started as soon as its programs are ready
  var firstTry = null, firstAt = 0, firstFails = 0;
  function shutDown() {                        // the engine is finished: hand the page back to the 2D fallback and tell the portrait
    cancelAnimationFrame(raf); raf = 0;
    canvas.remove();
    document.documentElement.classList.remove('bg-gl');
    window.__bg = null; window.__bgCurrent = null;
    window.dispatchEvent(new CustomEvent('bgscene', { detail: null }));   // the portrait then runs its own loop
  }
  function giveUp() { shutDown(); }            // nothing compiles here
  function startFirst(now) {
    if (!firstTry) {
      ensureQueue(1, byId[lastSeen]);
      var pool = queue.filter(function (e) { return e.sc.def.id !== lastSeen && !e.sc.failed; });
      firstTry = pool[Math.floor(Math.random() * pool.length)] || queue[0];
      if (!firstTry) { giveUp(); return; }
      firstAt = 0;
      build(firstTry.sc);
    }
    if (firstTry.sc.ready) {
      var sc = firstTry.sc; firstTry = null;
      setScene(startRound(sc), now);
      return;
    }
    if (!firstAt) firstAt = now;
    if (firstTry.sc.failed || now - firstAt > 8000) {          // pick another one; after a few misses, stop trying
      firstTry = null;
      if (++firstFails >= 4) giveUp();
    }
  }

  function pickNext() {                        // the first ready scene in the bag
    ensureQueue(3, scene);
    for (var k = 0; k < queue.length; k++) if (queue[k].sc.ready) return queue[k];
    buildSoon(queue[0].sc);
    return null;
  }

  /* ---------------- input ---------------- */
  var pointer = { x: 0, y: 0, on: 0 };
  function setPointer(e) {
    var aspect = canvas.width / canvas.height;
    pointer.x = (e.clientX / window.innerWidth * 2 - 1) * aspect;
    pointer.y = 1 - e.clientY / window.innerHeight * 2;
    pointer.on = 1;
  }
  window.addEventListener('pointermove', setPointer, { passive: true });
  window.addEventListener('pointerdown', setPointer, { passive: true });
  window.addEventListener('pointerup', function (e) { if (e.pointerType !== 'mouse') pointer.on = 0; });
  document.addEventListener('pointerleave', function () { pointer.on = 0; });

  /* ---------------- budget governor ---------------- */
  var intervals = [], budget = 16.7, calibrated = false, gpuMs = 0, queries = [], lastAdjust = 0;
  function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(s.length / 2)] || 0; }

  function collect() {
    while (queries.length) {
      var q = queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      var ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      if (!gl.getParameter(timerExt.GPU_DISJOINT_EXT) && ms > 0) gpuMs = gpuMs ? gpuMs * 0.85 + ms * 0.15 : ms;
      gl.deleteQuery(q);
      queries.shift();
    }
  }

  function govern(now) {
    if (!calibrated) {
      var normal = intervals.filter(function (v) { return v < 100; });
      if (normal.length >= 40) { budget = Math.min(33.4, Math.max(6.9, median(normal))); calibrated = true; }
      return;
    }
    if (now - lastAdjust < 500) return;
    lastAdjust = now;
    var frameMs = median(intervals.slice(-20));
    if (frameMs > 250) return;                               // throttled (hidden window): leave as is
    if (timerExt && gpuMs > 0) {
      var ratio = (BUDGET_FRACTION * budget) / gpuMs;
      rows *= Math.min(1.12, Math.max(0.8, Math.pow(ratio, 0.6)));
    } else if (frameMs > budget * 1.25) {
      rows *= 0.7;                                           // no timer: just back off if frames drop
    } else if (frameMs < budget * 1.05) {
      rows = Math.min(ROWS0, rows * 1.05);                   // ...and come back once they recover
    }
    rows = Math.max(8, Math.min(SIDE, rows));
  }

  /* ---------------- frame ---------------- */
  var raf = 0, last = 0, prevActive = 0;
  // a uniform the compiler optimised away has no location; skip it instead of passing undefined
  function u1i(l, v) { if (l) gl.uniform1i(l, v); }
  function u1f(l, v) { if (l) gl.uniform1f(l, v); }
  function u2f(l, x, y) { if (l) gl.uniform2f(l, x, y); }

  function smooth(a, b, x) { var k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); }

  function frame(now) {
    if (!canvas.isConnected) return;                         // gave up, or the context was lost
    raf = requestAnimationFrame(frame);
    var dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    if (last) { intervals.push(now - last); if (intervals.length > 60) intervals.shift(); }
    last = now;
    if (gl.isContextLost()) return;

    poll();
    if (!scene) { startFirst(now); if (!scene) return; }
    if (sceneStart < 0) sceneStart = now;

    var st = (now - sceneStart) / 1000;
    if (wantNext) {                                          // a "next" that arrived before any scene was ready
      var wn = pickNext();
      if (wn) { wantNext = false; setScene(wn, now); sceneStart = now; st = 0; }
    }
    if (st > curLen - FADE_OUT - 0.3) {                      // about to switch: is the next scene ready?
      var nxt = pickNext();
      if (!nxt) curLen = st + FADE_OUT + 0.4;                // not yet: stay a little longer rather than go blank
      else if (st >= curLen) { setScene(nxt, now); sceneStart = now; st = 0; }
    }
    var nominal = scene.def.len || DEFAULT_LEN;
    var t = (now - t0) / 1000;
    var src = scene.def.src;
    if (src && t > nextHeat) {                               // heat sources / wave sources
      var aspect0 = canvas.width / canvas.height;
      var wave = src.kind === 'wave';
      heat[heatSlot] = [(Math.random() * 1.6 - 0.8) * aspect0, Math.random() * 1.4 - 0.7, t,
                        wave ? 0.7 + Math.random() * 0.5 : 0.8 + Math.random() * 0.4];
      heatSlot = (heatSlot + 1) % 3;
      nextHeat = t + (src.period || 2);
    }
    var fade = smooth(0, FADE_IN, st) * (1 - smooth(curLen - FADE_OUT, curLen, st));

    var query = null;
    if (timerExt && queries.length < 4) { query = gl.createQuery(); gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query); }

    var aspect = canvas.width / canvas.height;
    var active = Math.max(1, Math.round(rows));
    var fromRow = active > prevActive ? prevActive : SIDE + 1;   // rows that were off until now start fresh
    prevActive = active;

    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, tex[1 - cur].f);
    gl.viewport(0, 0, SIDE, active);
    var U = scene.upd.u;
    gl.useProgram(scene.upd.pr);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex[cur].t);
    u1i(U.uState, 0);
    u1i(U.uShape, shapeKind);
    u1i(U.uN, Math.min(256, Math.ceil((st + 2.4) / 0.13) + 2));
    u1f(U.uTime, t);
    u1f(U.uSceneT, st);
    u1f(U.uLen, nominal);
    u1f(U.uDt, dt);
    u1f(U.uAspect, aspect);
    u1f(U.uSeed, (now % 1000) * 0.137);
    u1f(U.uVar, uVar);
    u1f(U.uFresh, fresh);
    u1f(U.uFromRow, fromRow);
    u1f(U.uPointerOn, pointer.on);
    u2f(U.uPointer, pointer.x, pointer.y);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    cur = 1 - cur;
    fresh = 0;

    var count = active * SIDE;
    var R = scene.ren.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // ink on paper: dense areas darken, never glow
    gl.useProgram(scene.ren.pr);
    gl.bindTexture(gl.TEXTURE_2D, tex[cur].t);
    u1i(R.uState, 0);
    u1i(R.uSide, SIDE);
    u1f(R.uAspect, aspect);
    u1f(R.uTime, t);
    u1f(R.uSceneT, st);
    u1f(R.uLen, nominal);
    u1f(R.uVar, uVar);
    u1f(R.uFade, fade);
    u1f(R.uPointerOn, pointer.on);
    u2f(R.uPointer, pointer.x, pointer.y);
    if (R.uHeat) gl.uniform4fv(R.uHeat, [].concat(heat[0], heat[1], heat[2]));
    gl.uniform3fv(R.uA, colA);
    gl.uniform3fv(R.uB, colB);
    // background: keep it calm and roughly constant in brightness whatever the count
    u1f(R.uAlpha, Math.min(0.4, Math.max(0.02, 28000 / count)) * (small ? 0.75 : 1) * (scene.def.gain || 1));
    // Keep text readable: cap each particle's brightness and dim the column where text sits.
    var contentHalf = Math.min(1140, window.innerWidth) / 2 - 32;     // matches .wrap max-width and gutter
    var narrow = window.innerWidth <= 760;                            // phones: text spans the full width
    u1f(R.uCap, (narrow ? 0.2 : 0.26) * (scene.def.cap || 1));         // fewer, darker ink marks rather than faint dust
    u1f(R.uCenterDim, narrow ? 0.3 : 0.32);
    u1f(R.uInner, narrow ? 2 : 0.92 * contentHalf / (window.innerWidth / 2));
    u1f(R.uOuter, narrow ? 3 : Math.min(1, contentHalf / (window.innerWidth / 2) + 0.12));
    gl.drawArrays(gl.POINTS, 0, count);

    if (query) { gl.endQuery(timerExt.TIME_ELAPSED_EXT); queries.push(query); }
    if (timerExt) collect();
    govern(now);
  }

  raf = requestAnimationFrame(frame);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
    else if (!raf) { last = 0; firstAt = 0; raf = requestAnimationFrame(frame); }
  });
  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
    shutDown();                                              // 2D fallback resumes
  });
  var rt = 0;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(resize, 150); });

  // for debugging / curiosity: window.__bg.stats(), .scene('rossler'), .next()
  function find(x) { return typeof x === 'number' ? scenes[x] : byId[x]; }
  window.__bg = {
    stats: function () {
      return { scene: scene ? scene.def.id : null, n: entry ? entry.n + '/' + entry.of : null, particles: Math.round(rows) * SIDE,
               gpuMs: +gpuMs.toFixed(3), budgetMs: +budget.toFixed(1),
               gpuShare: gpuMs ? +(gpuMs / budget * 100).toFixed(2) + '%' : 'n/a (no timer)' };
    },
    list: function () { return scenes.map(function (sc) { return sc.def.id + (sc.failed ? ' (failed)' : ''); }); },
    scene: function (x, variant, shape) {                   // jump to a scene (blocks until its programs are compiled)
      var sc = find(x);
      if (!sc) return false;
      buildNow(sc);
      if (sc.failed) return false;
      document.documentElement.classList.add('bg-gl');
      setScene(startRound(sc), performance.now());
      sceneStart = performance.now();
      if (typeof variant === 'number') uVar = variant;      // pin the random variant, for tests
      if (typeof shape === 'number') shapeKind = shape;
      return true;
    },
    next: function () {                                     // true if the background takes over (now, or as soon as a scene is ready)
      var e = pickNext();
      if (e) { setScene(e, performance.now()); sceneStart = performance.now(); return true; }
      wantNext = !!scene;
      return !!scene;
    }
  };
})();
