/* GPU mode (opt-in): a WebGL2 particle flow simulation whose size is adjusted
   continuously so the GPU stays about 75% busy each frame.

   - Particle state (position, velocity) lives in a float texture; a fragment
     shader integrates a curl-noise velocity field every frame (ping-pong).
   - Load control: with EXT_disjoint_timer_query_webgl2 we measure GPU time per
     frame and scale the active particle count toward 0.75 x frame budget.
     Without it, we grow until frames start to drop, then hold at 75% of that.
   - Safety: hard particle cap per device class, auto-stop if the device
     struggles, pause when the tab is hidden, clean handling of context loss,
     and all GPU memory is released on stop.
   Loaded on demand by site.js; exposes window.GPUMode.{start,stop,running}. */
(function () {
  'use strict';

  var TARGET = 0.75;                       // fraction of the frame budget to use
  var api = { running: false, start: start, stop: stop, onchange: null };
  window.GPUMode = api;

  var canvas, gl, hud, timerExt;
  var progInit, progUpdate, progRender, vao;
  var tex = [], fbo = [], cur = 0;
  var SIDE = 0, work = 0, maxRows = 0;
  var MAX_SUBSTEPS = 48;                   // extra simulation steps per frame once the particle cap is hit
  var raf = 0, lastFrame = 0, startTime = 0;
  var intervals = [], budget = 16.7, calibrated = false;
  var gpuMs = 0, pendingQueries = [];
  var ceiling = 0, lastAdjust = 0, slowWindows = 0;
  var pointer = { x: 0, y: 0, on: 0 };
  var colA = [0.49, 0.61, 1.0], colB = [1.0, 0.48, 0.64];
  var listeners = [];

  /* ---------------- shaders ---------------- */
  var VS_FULL = '#version 300 es\n' +
    'const vec2 P[3] = vec2[3](vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.));\n' +
    'void main(){ gl_Position = vec4(P[gl_VertexID], 0., 1.); }';

  var COMMON = 'float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }\n';

  var FS_INIT = '#version 300 es\nprecision highp float;\n' +
    'uniform float uAspect, uSeed;\nout vec4 o;\n' + COMMON +
    'void main(){ vec2 ij = gl_FragCoord.xy;\n' +
    '  vec2 p = vec2((hash(ij + uSeed)*2.-1.)*uAspect, hash(ij.yx*1.37 + uSeed*2.1)*2.-1.);\n' +
    '  o = vec4(p, 0., 0.); }';

  var FS_UPDATE = '#version 300 es\nprecision highp float;\n' +
    'uniform sampler2D uState;\nuniform float uTime, uDt, uAspect, uPointerOn, uSeed;\nuniform vec2 uPointer;\nout vec4 o;\n' + COMMON +
    // velocity = curl of a smooth, time-varying stream function (divergence-free flow)
    'vec2 curl(vec2 p, float t){\n' +
    '  vec2 q = p*1.6;\n' +
    '  float a = 1.3*q.x + .21*t, b = 1.1*q.y - .17*t, c = 2.1*(q.x+q.y) + .11*t, d = 3.7*q.x - 2.9*q.y + .3*t;\n' +
    '  float dx = 1.3*cos(a)*cos(b) + 1.05*cos(c) + .925*cos(d);\n' +
    '  float dy = -1.1*sin(a)*sin(b) + 1.05*cos(c) - .725*cos(d);\n' +
    '  return vec2(dy, -dx);\n}\n' +
    'void main(){\n' +
    '  ivec2 ij = ivec2(gl_FragCoord.xy);\n' +
    '  vec4 s = texelFetch(uState, ij, 0);\n' +
    '  vec2 p = s.xy, v = s.zw;\n' +
    '  vec2 f = curl(p, uTime) * .32;\n' +
    '  if (uPointerOn > .5) {\n' +
    '    vec2 d = uPointer - p; float r = length(d) + 1e-4;\n' +
    '    float k = smoothstep(.6, 0., r);\n' +
    '    f += (d / r * .8 + vec2(-d.y, d.x) / max(r, .06) * .45) * k;\n' +
    '  }\n' +
    '  v = mix(v, f, .08);\n' +
    '  p += v * uDt;\n' +
    '  vec2 fij = vec2(ij);\n' +
    '  float die = hash(fij + uSeed);\n' +
    '  if (abs(p.x) > uAspect*1.05 || abs(p.y) > 1.05 || die < .002) {\n' +
    '    p = vec2((hash(fij*1.31 + uSeed*3.1)*2.-1.)*uAspect, hash(fij.yx*.77 + uSeed*5.3)*2.-1.);\n' +
    '    v = vec2(0.);\n' +
    '  }\n' +
    '  o = vec4(p, v);\n}';

  var VS_RENDER = '#version 300 es\nprecision highp float;\n' +
    'uniform sampler2D uState;\nuniform int uSide;\nuniform float uAspect;\nuniform vec3 uA, uB;\nout vec3 vCol;\n' +
    'void main(){\n' +
    '  ivec2 ij = ivec2(gl_VertexID % uSide, gl_VertexID / uSide);\n' +
    '  vec4 s = texelFetch(uState, ij, 0);\n' +
    '  gl_Position = vec4(s.x / uAspect, s.y, 0., 1.);\n' +
    '  gl_PointSize = 1.;\n' +
    '  vCol = mix(uA, uB, clamp(length(s.zw) * 1.8, 0., 1.));\n}';

  var FS_RENDER = '#version 300 es\nprecision highp float;\nuniform float uAlpha;\nin vec3 vCol;\nout vec4 o;\n' +
    'void main(){ o = vec4(vCol * uAlpha, uAlpha); }';

  /* ---------------- GL helpers ---------------- */
  function shader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    p.u = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var name = gl.getActiveUniform(p, i).name;
      p.u[name] = gl.getUniformLocation(p, name);
    }
    return p;
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
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('float framebuffer unsupported');
    return { t: t, f: f };
  }

  /* ---------------- UI ---------------- */
  function makeHud() {
    hud = document.createElement('div');
    hud.className = 'gpu-hud';
    hud.setAttribute('role', 'status');
    hud.innerHTML = '<div class="gpu-hud-row"><b>GPU mode</b><span class="gpu-hud-dot"></span></div>' +
      '<div class="gpu-hud-bar"><span></span><i style="left:' + (TARGET * 100) + '%"></i></div>' +
      '<p class="gpu-hud-text">calibrating…</p>' +
      '<button type="button" class="gpu-hud-gemma">Chat with Gemma 4 on this GPU →</button>';
    document.body.appendChild(hud);
    hud.querySelector('.gpu-hud-gemma').addEventListener('click', openGemma);
  }
  function setHud(text, frac) {
    if (!hud) return;
    hud.querySelector('.gpu-hud-text').textContent = text;
    if (frac != null) hud.querySelector('.gpu-hud-bar span').style.width = Math.min(100, frac * 100).toFixed(1) + '%';
  }
  function fmtCount(n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Math.round(n / 1e3) + 'k'; }

  // On-device LLM (loaded only when asked for). It takes over the GPU from the particles.
  function openGemma() {
    if (window.GemmaChat) { window.GemmaChat.open(); return; }
    var sc = document.createElement('script');
    sc.src = 'assets/js/gemma-chat.js';
    sc.onload = function () { window.GemmaChat.open(); };
    document.head.appendChild(sc);
  }

  /* ---------------- lifecycle ---------------- */
  function on(target, ev, fn, opts) { target.addEventListener(ev, fn, opts); listeners.push([target, ev, fn, opts]); }

  function start() {
    if (api.running) return true;
    canvas = document.createElement('canvas');
    canvas.id = 'gpu-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) {
      canvas = null; gl = null;
      return 'This browser does not support WebGL2 float textures, so GPU mode is unavailable.';
    }
    try {
      var small = Math.min(screen.width, screen.height) < 700 || /Mobi|Android/i.test(navigator.userAgent);
      var maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      SIDE = Math.min(small ? 724 : 2048, maxTex);       // memory cap: ~0.5M (phones) / ~4.2M (desktop) particles
      maxRows = SIDE;
      work = Math.max(16, Math.round(SIDE / 16));          // start light, the governor grows it

      progInit = program(VS_FULL, FS_INIT);
      progUpdate = program(VS_FULL, FS_UPDATE);
      progRender = program(VS_RENDER, FS_RENDER);
      vao = gl.createVertexArray();
      tex = [stateTexture(), stateTexture()];

      timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      document.body.insertBefore(canvas, document.body.firstChild);
      resize();
      var aspect = canvas.width / canvas.height;
      for (var k = 0; k < 2; k++) {            // fill both state textures with random positions
        gl.bindFramebuffer(gl.FRAMEBUFFER, tex[k].f);
        gl.viewport(0, 0, SIDE, SIDE);
        gl.useProgram(progInit);
        gl.uniform1f(progInit.u.uAspect, aspect);
        gl.uniform1f(progInit.u.uSeed, Math.random() * 100 + k);
        gl.bindVertexArray(vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    } catch (err) {
      cleanup();
      return 'GPU mode could not start: ' + err.message;
    }

    readColours();
    makeHud();
    document.documentElement.classList.add('gpu-on');
    on(canvas, 'webglcontextlost', function (e) { e.preventDefault(); stop('GPU context was reset by the browser — stopped safely.'); });
    on(window, 'resize', resize);
    on(window, 'pointermove', function (e) { setPointer(e); }, { passive: true });
    on(window, 'pointerdown', function (e) { setPointer(e); }, { passive: true });
    on(window, 'pointerup', function (e) { if (e.pointerType !== 'mouse') pointer.on = 0; });
    on(document, 'pointerleave', function () { pointer.on = 0; });
    on(document, 'visibilitychange', function () {
      if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
      else if (api.running && !raf) { lastFrame = 0; intervals = []; raf = requestAnimationFrame(frame); }
    });

    api.running = true;
    calibrated = false; intervals = []; ceiling = 0; slowWindows = 0; gpuMs = 0;
    startTime = lastAdjust = performance.now(); lastFrame = 0;
    raf = requestAnimationFrame(frame);
    if (api.onchange) api.onchange(true);
    return true;
  }

  function stop(message) {
    if (!api.running && !canvas) return;
    api.running = false;
    cancelAnimationFrame(raf); raf = 0;
    cleanup();
    if (hud) {
      if (message) {
        setHud(message, 0);
        var h = hud; hud = null;
        setTimeout(function () { h.remove(); }, 4000);
      } else { hud.remove(); hud = null; }
    }
    if (api.onchange) api.onchange(false, message);
  }

  function cleanup() {
    listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
    listeners = [];
    document.documentElement.classList.remove('gpu-on');
    if (gl) {
      pendingQueries.forEach(function (q) { gl.deleteQuery(q); });
      tex.forEach(function (s) { gl.deleteTexture(s.t); gl.deleteFramebuffer(s.f); });
      [progInit, progUpdate, progRender].forEach(function (p) { if (p) gl.deleteProgram(p); });
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();         // hand all GPU memory back immediately
    }
    pendingQueries = []; tex = [];
    if (canvas) canvas.remove();
    canvas = null; gl = null;
  }

  function resize() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  function setPointer(e) {
    if (!canvas) return;
    var aspect = canvas.width / canvas.height;
    pointer.x = (e.clientX / window.innerWidth * 2 - 1) * aspect;
    pointer.y = 1 - e.clientY / window.innerHeight * 2;
    pointer.on = 1;
  }
  function readColours() {
    var cs = getComputedStyle(document.documentElement);
    var rgb = function (v, fb) {
      var m = /^#([0-9a-f]{6})$/i.exec((v || '').trim());
      if (!m) return fb;
      var n = parseInt(m[1], 16);
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };
    colA = rgb(cs.getPropertyValue('--clr-accent'), colA);
    colB = rgb(cs.getPropertyValue('--clr-signal'), colB);
  }

  /* ---------------- frame ---------------- */
  function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(s.length / 2)] || 0; }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    var dt = lastFrame ? Math.min((now - lastFrame) / 1000, 1 / 30) : 1 / 60;
    if (lastFrame) { intervals.push(now - lastFrame); if (intervals.length > 60) intervals.shift(); }
    lastFrame = now;
    if (!gl || gl.isContextLost()) return;

    var query = null;
    if (timerExt && pendingQueries.length < 4) {
      query = gl.createQuery();
      gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query);
    }

    var aspect = canvas.width / canvas.height;
    var t = (now - startTime) / 1000;
    // `work` grows past the particle cap by adding substeps (more GPU time, no extra memory)
    var activeRows = Math.max(1, Math.min(maxRows, Math.round(work)));
    var substeps = activeRows < maxRows ? 1 : Math.max(1, Math.min(MAX_SUBSTEPS, Math.round(work / maxRows)));

    // 1. integrate the active rows (ping-pong), `substeps` times per frame
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, SIDE, activeRows);
    gl.useProgram(progUpdate);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(progUpdate.u.uState, 0);
    gl.uniform1f(progUpdate.u.uDt, dt / substeps);
    gl.uniform1f(progUpdate.u.uAspect, aspect);
    gl.uniform1f(progUpdate.u.uPointerOn, pointer.on);
    gl.uniform2f(progUpdate.u.uPointer, pointer.x, pointer.y);
    gl.bindVertexArray(vao);
    for (var k = 0; k < substeps; k++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, tex[1 - cur].f);
      gl.bindTexture(gl.TEXTURE_2D, tex[cur].t);
      gl.uniform1f(progUpdate.u.uTime, t + k * dt / substeps);
      gl.uniform1f(progUpdate.u.uSeed, ((now + k * 7.3) % 1000) * 0.137);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      cur = 1 - cur;
    }

    // 2. draw the particles additively
    var count = activeRows * SIDE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(progRender);
    gl.bindTexture(gl.TEXTURE_2D, tex[cur].t);
    gl.uniform1i(progRender.u.uState, 0);
    gl.uniform1i(progRender.u.uSide, SIDE);
    gl.uniform1f(progRender.u.uAspect, aspect);
    gl.uniform3fv(progRender.u.uA, colA);
    gl.uniform3fv(progRender.u.uB, colB);
    // keep overall brightness roughly constant as the count changes
    gl.uniform1f(progRender.u.uAlpha, Math.min(0.5, Math.max(0.012, 45000 / count)) * 0.55);
    gl.drawArrays(gl.POINTS, 0, count);

    if (query) { gl.endQuery(timerExt.TIME_ELAPSED_EXT); pendingQueries.push(query); }
    collectQueries();
    govern(now, count, substeps);
  }

  function collectQueries() {
    while (pendingQueries.length) {
      var q = pendingQueries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      var disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT);
      var ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      if (!disjoint && ms > 0) gpuMs = gpuMs ? gpuMs * 0.8 + ms * 0.2 : ms;
      gl.deleteQuery(q);
      pendingQueries.shift();
    }
  }

  /* Adjust the active particle count every ~0.4 s to sit near TARGET of the frame budget. */
  function govern(now, count, substeps) {
    var recent = intervals.slice(-12);
    if (recent.length >= 6 && median(recent) > 250) {
      // Browser is throttling us (window hidden/occluded): hold still, this is not a slow GPU.
      setHud('paused while the window is not visible', 0);
      lastAdjust = now;
      return;
    }
    if (!calibrated) {
      var normal = intervals.filter(function (v) { return v < 100; });
      if (normal.length >= 40) {
        budget = Math.min(33.4, Math.max(6.9, median(normal)));      // display refresh interval
        calibrated = true;
        intervals = [];
      }
      setHud('measuring display refresh…', 0);
      return;
    }
    if (now - lastAdjust < 400 || intervals.length < 12) return;
    lastAdjust = now;

    var frameMs = median(intervals);
    if (frameMs > 100) {                       // visible but very slow: the device is struggling, back off then stop
      work *= 0.5;
      if (++slowWindows >= 4) { stop('Your device was struggling, so GPU mode stopped itself.'); return; }
    } else {
      slowWindows = 0;
    }

    var load, label;
    if (timerExt && gpuMs > 0) {
      load = gpuMs / budget;
      var ratio = TARGET / Math.max(load, 0.01);
      work *= Math.min(1.15, Math.max(0.8, Math.pow(ratio, 0.7)));
      label = 'GPU ' + gpuMs.toFixed(1) + ' / ' + budget.toFixed(1) + ' ms per frame';
    } else {
      // No GPU timer: grow until frames drop, then hold at 75% of that ceiling.
      if (frameMs > budget * 1.2) { ceiling = work; work *= 0.6; }
      else if (!ceiling) work *= 1.12;
      else work += (ceiling * TARGET - work) * 0.3;
      load = ceiling ? Math.min(1, work / ceiling) : Math.min(1, budget / frameMs) * 0.5;
      label = 'frame ' + frameMs.toFixed(1) + ' ms · load estimated (no GPU timer)';
    }
    work = Math.max(8, Math.min(maxRows * MAX_SUBSTEPS, work));
    var capped = work >= maxRows * MAX_SUBSTEPS && load < TARGET;
    setHud(fmtCount(count) + ' particles' + (substeps > 1 ? ' × ' + substeps + ' steps' : '') + ' · ' + Math.round(load * 100) + '% of frame' +
           (capped ? ' (safety cap reached)' : '') + '\n' + label, load);
  }
})();
