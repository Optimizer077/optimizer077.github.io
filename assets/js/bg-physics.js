/* Background physics on the GPU (WebGL2), kept to about 5% of the frame budget.
   Particle state lives in a float texture and is integrated by a fragment shader.
   Every 20-30 s the scene changes at random:
     0 flow       curl-noise advection
     1 diffusion  forward then reverse diffusion of a shape: x_t = sqrt(abar) x0 + sqrt(1-abar) eps
     2 heat       Brownian particles coloured by an analytic heat-equation solution
     3 lorenz     particles relax onto the Lorenz attractor
   Budget: with EXT_disjoint_timer_query_webgl2 the active particle count is steered
   toward 5% of the frame time; without it a modest fixed count is used. Pauses when
   the tab is hidden or throttled. If WebGL2 is unavailable, flow-field.js (2D canvas)
   runs instead. */
(function () {
  'use strict';

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var BUDGET_FRACTION = 0.05;
  var SCENES = [
    { name: 'flow',      caption: 'curl-noise flow · ẋ = ∇ × ψ(x, t)' },
    { name: 'diffusion', caption: 'forward / reverse diffusion · xₜ = √ᾱₜ x₀ + √(1−ᾱₜ) ε' },
    { name: 'heat',      caption: 'heat equation · ∂T/∂t = α ∇²T  (move the cursor to add heat)' },
    { name: 'lorenz',    caption: 'Lorenz system · σ = 10, ρ = 28, β = 8/3' }
  ];

  var canvas = document.createElement('canvas');
  var gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'low-power' });
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) return;    // 2D fallback takes over

  var small = Math.min(screen.width, screen.height) < 700 || /Mobi|Android/i.test(navigator.userAgent);
  var SIDE = small ? 512 : 1024;            // memory cap: 262k (phones) / 1M (desktop) particles
  var timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  var rows = timerExt ? SIDE / 16 : (small ? SIDE / 16 : SIDE / 8);   // start; governor adjusts with a timer

  /* ---------------- shaders ---------------- */
  var VS_FULL = '#version 300 es\nconst vec2 P[3] = vec2[3](vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.));\n' +
    'void main(){ gl_Position = vec4(P[gl_VertexID], 0., 1.); }';

  var COMMON = [
    'float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }',
    'vec2 gauss(vec2 s){ float u1 = max(hash(s), 1e-4), u2 = hash(s + 17.3);',
    '  return sqrt(-2.*log(u1)) * vec2(cos(6.2831853*u2), sin(6.2831853*u2)); }'
  ].join('\n') + '\n';

  var FS_INIT = '#version 300 es\nprecision highp float;\nuniform float uAspect, uSeed;\nout vec4 o;\n' + COMMON +
    'void main(){ vec2 ij = gl_FragCoord.xy;\n' +
    '  o = vec4((hash(ij + uSeed)*2.-1.)*uAspect, hash(ij.yx*1.37 + uSeed*2.1)*2.-1., 0., 0.); }';

  var FS_UPDATE = '#version 300 es\nprecision highp float;\n' +
    'uniform sampler2D uState;\nuniform int uScene, uShape;\n' +
    'uniform float uTime, uSceneT, uDt, uAspect, uSeed, uPointerOn;\nuniform vec2 uPointer;\nout vec4 o;\n' + COMMON +
    'vec2 curl(vec2 p, float t){\n' +
    '  vec2 q = p*1.6;\n' +
    '  float a = 1.3*q.x + .21*t, b = 1.1*q.y - .17*t, c = 2.1*(q.x+q.y) + .11*t, d = 3.7*q.x - 2.9*q.y + .3*t;\n' +
    '  float dx = 1.3*cos(a)*cos(b) + 1.05*cos(c) + .925*cos(d);\n' +
    '  float dy = -1.1*sin(a)*sin(b) + 1.05*cos(c) - .725*cos(d);\n' +
    '  return vec2(dy, -dx);\n}\n' +
    // data distributions for the diffusion scene
    'vec2 shape(int k, vec2 h){\n' +
    '  if (k == 0) { float a = h.x*6.2831853; return vec2(cos(a), sin(a))*.55 + gauss(h*3.1)*.015; }\n' +
    '  if (k == 1) { float th = h.x*3.1415927;\n' +
    '    vec2 q = h.y < .5 ? vec2(cos(th), sin(th)) : vec2(1. - cos(th), .5 - sin(th));\n' +
    '    return (q - vec2(.5, .25))*.62 + gauss(h*5.7)*.025; }\n' +
    '  float r = sqrt(h.x), th2 = r*12.;\n' +
    '  return vec2(cos(th2), sin(th2))*r*.72 + gauss(h*2.3)*.02;\n}\n' +
    'void main(){\n' +
    '  ivec2 ij = ivec2(gl_FragCoord.xy); vec2 fij = vec2(ij);\n' +
    '  vec4 s = texelFetch(uState, ij, 0);\n' +
    '  vec2 p = s.xy, z = s.zw;\n' +
    '  vec2 h = vec2(hash(fij*.731 + .13), hash(fij.yx*1.37 + .71));\n' +   // fixed per particle
    '  vec2 eps = gauss(fij*.917 + 3.3);\n' +                               // fixed Gaussian per particle
    '  vec2 nT = gauss(fij*.53 + uSeed);\n' +                               // fresh noise every step
    '  bool bounded = true;\n' +
    '  if (uScene == 0) {\n' +
    '    vec2 f = curl(p, uTime)*.32;\n' +
    '    if (uPointerOn > .5) { vec2 d = uPointer - p; float r = length(d) + 1e-4; float k = smoothstep(.5, 0., r);\n' +
    '      f += (d/r*.6 + vec2(-d.y, d.x)/max(r, .06)*.35)*k; }\n' +
    '    z = mix(z, f, .08); p += z*uDt;\n' +
    '    if (hash(fij + uSeed) < .002) p = vec2(9.);\n' +
    '  } else if (uScene == 1) {\n' +
    '    float c = mod(uSceneT, 14.);\n' +       // hold data, noise it, hold noise, denoise, hold
    '    float tt = c < 2. ? 0. : c < 6. ? (c-2.)/4. : c < 8. ? 1. : c < 12. ? 1. - (c-8.)/4. : 0.;\n' +
    '    float ab = cos(1.5707963*tt); ab *= ab;\n' +
    '    vec2 tgt = sqrt(ab)*shape(uShape, h) + sqrt(1. - ab)*eps*vec2(.5*uAspect, .5) + nT*.003;\n' +
    '    p += (tgt - p)*(1. - exp(-uDt*4.));\n' +
    '    z = vec2(tt, 0.); bounded = false;\n' +
    '  } else if (uScene == 2) {\n' +
    '    p += nT*sqrt(2.*.004*uDt);\n' +            // Brownian motion, D = 0.004
    '    if (hash(fij + uSeed) < .001) p = vec2(9.);\n' +
    '    z = vec2(0.);\n' +
    '  } else {\n' +
    '    float K = .034;\n' +                       // screen = (x*K, (z-25)*K); y stored in s.z
    '    vec3 L = vec3(clamp(p.x/K, -25., 25.), z.x, clamp(p.y/K + 25., 0., 55.));\n' +
    '    if (uSceneT < .06) L.y = (h.x - .5)*20.;\n' +
    '    for (int i = 0; i < 2; i++) {\n' +
    '      vec3 dL = vec3(10.*(L.y - L.x), L.x*(28. - L.z) - L.y, L.x*L.y - 2.6666667*L.z);\n' +
    '      L += dL*.0035;\n' +
    '    }\n' +
    '    p = vec2(L.x*K, (L.z - 25.)*K); z = vec2(L.y, 0.); bounded = false;\n' +
    '  }\n' +
    '  if (bounded && (abs(p.x) > uAspect*1.05 || abs(p.y) > 1.05)) {\n' +
    '    p = vec2((hash(fij*1.31 + uSeed*3.1)*2.-1.)*uAspect, hash(fij.yx*.77 + uSeed*5.3)*2.-1.); z = vec2(0.);\n' +
    '  }\n' +
    '  o = vec4(p, z);\n}';

  var VS_RENDER = '#version 300 es\nprecision highp float;\n' +
    'uniform sampler2D uState;\nuniform int uSide, uScene;\nuniform float uAspect, uTime, uPointerOn;\n' +
    'uniform vec2 uPointer;\nuniform vec4 uHeat[3];\nuniform vec3 uA, uB;\nout vec4 vCol;\n' +
    'void main(){\n' +
    '  ivec2 ij = ivec2(gl_VertexID % uSide, gl_VertexID / uSide);\n' +
    '  vec4 s = texelFetch(uState, ij, 0);\n' +
    '  gl_Position = vec4(s.x/uAspect, s.y, 0., 1.);\n' +
    '  gl_PointSize = 1.;\n' +
    '  vec3 col = uA; float a = 1.;\n' +
    '  if (uScene == 0) col = mix(uA, uB, clamp(length(s.zw)*1.8, 0., 1.));\n' +
    '  else if (uScene == 1) { col = mix(uA, uB, s.z); a = 1. + 3.5*s.z; }\n' +   // spread-out noise needs more light per particle
    '  else if (uScene == 2) {\n' +
    // analytic solution of the 2D heat equation for instantaneous point sources: T ~ exp(-r^2/4at)/t
    '    float T = 0.;\n' +
    '    for (int i = 0; i < 3; i++) { vec4 hs = uHeat[i]; float t = max(uTime - hs.z, 0.) + .15;\n' +
    '      vec2 d = s.xy - hs.xy; T += hs.w*exp(-dot(d, d)/(4.*.02*t))*min(1., .9/(t + .3)); }\n' +
    '    if (uPointerOn > .5) { vec2 d = s.xy - uPointer; T += .8*exp(-dot(d, d)/.006); }\n' +
    '    T = clamp(T, 0., 1.);\n' +
    '    col = mix(uA*.5, mix(uB, vec3(1., .86, .62), smoothstep(.55, 1., T)), smoothstep(0., .5, T));\n' +
    '    a = .5 + T*7.;\n' +
    '  } else col = mix(uA, uB, step(0., s.z));\n' +
    '  vCol = vec4(col, a);\n}';

  var FS_RENDER = '#version 300 es\nprecision highp float;\nuniform float uAlpha;\nin vec4 vCol;\nout vec4 o;\n' +
    'void main(){ float a = uAlpha*vCol.a; o = vec4(vCol.rgb*a, a); }';

  /* ---------------- GL setup ---------------- */
  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }
  function program(vs, fs) {
    var pr = gl.createProgram();
    gl.attachShader(pr, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(pr, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    pr.u = {};
    for (var i = 0, n = gl.getProgramParameter(pr, gl.ACTIVE_UNIFORMS); i < n; i++) {
      var name = gl.getActiveUniform(pr, i).name.replace(/\[0\]$/, '');
      pr.u[name] = gl.getUniformLocation(pr, name);
    }
    return pr;
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

  var progInit, progUpdate, progRender, vao, tex, cur = 0;
  try {
    progInit = program(VS_FULL, FS_INIT);
    progUpdate = program(VS_FULL, FS_UPDATE);
    progRender = program(VS_RENDER, FS_RENDER);
    vao = gl.createVertexArray();
    tex = [stateTexture(), stateTexture()];
  } catch (err) {
    return;                                   // 2D fallback takes over
  }

  canvas.id = 'bg-gl';
  canvas.setAttribute('aria-hidden', 'true');
  document.documentElement.classList.add('bg-gl');
  document.body.insertBefore(canvas, document.body.firstChild);

  var caption = document.createElement('p');
  caption.className = 'bg-caption';
  caption.setAttribute('aria-hidden', 'true');
  document.body.appendChild(caption);

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  (function seed() {
    var aspect = canvas.width / canvas.height;
    gl.useProgram(progInit);
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
    colA = rgb(cs.getPropertyValue('--clr-accent'), colA);
    colB = rgb(cs.getPropertyValue('--clr-signal'), colB);
  })();

  /* ---------------- scenes ---------------- */
  var scene = Math.floor(Math.random() * SCENES.length);
  var shapeKind = 0, sceneStart = 0, sceneLen = 25;
  var heat = [[0, 0, -99, 0], [0, 0, -99, 0], [0, 0, -99, 0]], nextHeat = 0, heatSlot = 0;

  function setScene(i, now) {
    scene = i;
    sceneStart = now;
    sceneLen = i === 1 ? 28 : 20 + Math.random() * 10;      // diffusion: two full noise/denoise cycles
    shapeKind = Math.floor(Math.random() * 3);
    nextHeat = 0;
    caption.textContent = SCENES[i].caption;
    window.dispatchEvent(new CustomEvent('bgscene', { detail: { name: SCENES[i].name } }));
    caption.classList.remove('is-on');
    void caption.offsetWidth;                                // restart the fade
    caption.classList.add('is-on');
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
    }
    rows = Math.max(8, Math.min(SIDE, rows));
  }

  /* ---------------- frame ---------------- */
  var raf = 0, last = 0, t0 = performance.now();
  setScene(scene, t0);

  function frame(now) {
    raf = requestAnimationFrame(frame);
    var dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    if (last) { intervals.push(now - last); if (intervals.length > 60) intervals.shift(); }
    last = now;
    if (gl.isContextLost()) return;

    if (now - sceneStart > sceneLen * 1000) {
      var next;
      do { next = Math.floor(Math.random() * SCENES.length); } while (next === scene);
      setScene(next, now);
    }
    var t = (now - t0) / 1000, st = (now - sceneStart) / 1000;
    if (scene === 2 && t > nextHeat) {                       // re-ignite one heat source every ~2.2 s
      var aspect0 = canvas.width / canvas.height;
      heat[heatSlot] = [(Math.random() * 1.6 - 0.8) * aspect0, Math.random() * 1.4 - 0.7, t, 0.8 + Math.random() * 0.4];
      heatSlot = (heatSlot + 1) % 3;
      nextHeat = t + 2.2;
    }

    var query = null;
    if (timerExt && queries.length < 4) { query = gl.createQuery(); gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query); }

    var aspect = canvas.width / canvas.height;
    var active = Math.max(1, Math.round(rows));

    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, tex[1 - cur].f);
    gl.viewport(0, 0, SIDE, active);
    gl.useProgram(progUpdate);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex[cur].t);
    gl.uniform1i(progUpdate.u.uState, 0);
    gl.uniform1i(progUpdate.u.uScene, scene);
    gl.uniform1i(progUpdate.u.uShape, shapeKind);
    gl.uniform1f(progUpdate.u.uTime, t);
    gl.uniform1f(progUpdate.u.uSceneT, st);
    gl.uniform1f(progUpdate.u.uDt, dt);
    gl.uniform1f(progUpdate.u.uAspect, aspect);
    gl.uniform1f(progUpdate.u.uSeed, (now % 1000) * 0.137);
    gl.uniform1f(progUpdate.u.uPointerOn, pointer.on);
    gl.uniform2f(progUpdate.u.uPointer, pointer.x, pointer.y);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    cur = 1 - cur;

    var count = active * SIDE;
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
    gl.uniform1i(progRender.u.uScene, scene);
    gl.uniform1f(progRender.u.uAspect, aspect);
    gl.uniform1f(progRender.u.uTime, t);
    gl.uniform1f(progRender.u.uPointerOn, pointer.on);
    gl.uniform2f(progRender.u.uPointer, pointer.x, pointer.y);
    gl.uniform4fv(progRender.u.uHeat, [].concat(heat[0], heat[1], heat[2]));
    gl.uniform3fv(progRender.u.uA, colA);
    gl.uniform3fv(progRender.u.uB, colB);
    // background: keep it calm and roughly constant in brightness whatever the count
    gl.uniform1f(progRender.u.uAlpha, Math.min(0.4, Math.max(0.02, 28000 / count)) * (small ? 0.75 : 1));
    gl.drawArrays(gl.POINTS, 0, count);

    if (query) { gl.endQuery(timerExt.TIME_ELAPSED_EXT); queries.push(query); }
    if (timerExt) collect();
    govern(now);
  }

  raf = requestAnimationFrame(frame);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
    else if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
  });
  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
    cancelAnimationFrame(raf); raf = 0;
    canvas.remove(); caption.remove();
    document.documentElement.classList.remove('bg-gl');      // 2D fallback resumes
  });
  var rt = 0;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(resize, 150); });

  // for debugging / curiosity: window.__bg.stats()
  window.__bg = {
    stats: function () {
      return { scene: SCENES[scene].name, particles: Math.round(rows) * SIDE, gpuMs: +gpuMs.toFixed(3),
               budgetMs: +budget.toFixed(1), gpuShare: gpuMs ? +(gpuMs / budget * 100).toFixed(2) + '%' : 'n/a (no timer)' };
    },
    scene: function (i) { setScene(i, performance.now()); }
  };
})();
