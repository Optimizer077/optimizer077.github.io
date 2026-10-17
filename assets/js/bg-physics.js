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

  if (document.documentElement.classList.contains('reduce-motion')) return;

  var BUDGET_FRACTION = 0.05;
  var SCENES = [
    { name: 'flow',      caption: 'curl-noise flow · ẋ = ∇ × ψ(x, t)' },
    { name: 'diffusion', caption: 'forward / reverse diffusion · xₜ = √ᾱₜ x₀ + √(1−ᾱₜ) ε' },
    { name: 'heat',      caption: 'heat equation · ∂T/∂t = α ∇²T  (move the cursor to add heat)' },
    { name: 'lorenz',    caption: 'Lorenz system · σ = 10, ρ = 28, β = 8/3' },
    { name: 'flowmatch', caption: 'flow matching · xₜ = (1−t) ε + t x₁  (straight paths, noise ↔ data)' },
    { name: 'langevin',  caption: 'Langevin dynamics on a loss landscape · dx = −∇U(x) dt + √(2T) dW' },
    { name: 'wave',      caption: 'wave equation · ∂²u/∂t² = c² ∇²u' },
    { name: 'vortex',    caption: 'point vortices · u = Σ Γᵢ (−y, x) / 2π r²  (Biot–Savart)' },
    { name: 'gravity',   caption: 'Newtonian gravity · r̈ = −GM r / |r|³  (orbits)' },
    { name: 'kmeans',    caption: 'k-means clustering · each point joins its nearest centroid' }
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
    '  return sqrt(-2.*log(u1)) * vec2(cos(6.2831853*u2), sin(6.2831853*u2)); }',
    // loss landscape for the Langevin scene: a wide bowl with five Gaussian wells
    'const vec2 WELLS[5] = vec2[5](vec2(-.95, .35), vec2(.85, -.3), vec2(.05, .58), vec2(.32, -.55), vec2(-.45, -.45));',
    'float lossU(vec2 p){ float u = .12*dot(p, p);',
    '  for (int i = 0; i < 5; i++) { vec2 d = p - WELLS[i]; u -= exp(-dot(d, d)/.08); } return u; }',
    'vec2 lossGrad(vec2 p){ vec2 g = .24*p;',
    '  for (int i = 0; i < 5; i++) { vec2 d = p - WELLS[i]; g += exp(-dot(d, d)/.08)*2.*d/.08; } return g; }'
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
    '  } else if (uScene == 4) {\n' +           // flow matching: straight-line paths between noise and data
    '    float c = mod(uSceneT, 12.);\n' +
    '    float tt = c < 1.5 ? 0. : c < 5.5 ? (c-1.5)/4. : c < 7.5 ? 1. : c < 11.5 ? 1. - (c-7.5)/4. : 0.;\n' +
    '    vec2 tgt = mix(eps*vec2(.5*uAspect, .5), shape(uShape, h), tt);\n' +
    '    p += (tgt - p)*(1. - exp(-uDt*9.));\n' +
    '    z = vec2(1. - tt, 0.); bounded = false;\n' +
    '  } else if (uScene == 5) {\n' +           // Langevin dynamics: gradient descent on lossU plus noise
    '    p += -lossGrad(p)*uDt*.25 + nT*sqrt(2.*.03*uDt);\n' +   // warmer: particles explore instead of collapsing
    '    if (hash(fij + uSeed) < .008) p = vec2(9.);\n' +   // steady turnover keeps the descent itself visible
    '    z = vec2(clamp((lossU(p) + 1.)/1.4, 0., 1.), 0.);\n' +
    '  } else if (uScene == 7) {\n' +           // three point vortices advect the particles (Biot-Savart)
    '    vec2 u = vec2(0.);\n' +
    '    for (int i = 0; i < 3; i++) { float fi = float(i);\n' +
    '      vec2 c = vec2(cos(uTime*.11 + fi*2.1)*.55*uAspect, sin(uTime*.09 + fi*2.7)*.45);\n' +
    '      float G = (i == 1 ? -1. : 1.)*.09; vec2 d = p - c; float r2 = dot(d, d) + .01;\n' +
    '      u += G*vec2(-d.y, d.x)/r2; }\n' +
    '    z = mix(z, u, .2); p += z*uDt;\n' +
    '    if (hash(fij + uSeed) < .002) p = vec2(9.);\n' +
    '  } else if (uScene == 8) {\n' +           // Newtonian gravity: orbits around a central mass (leapfrog)
    '    float GM = .12;\n' +
    '    if (uSceneT < .08 || dot(p, p) > 6.) { float r = .25 + h.x*.8, th = h.y*6.2831853;\n' +
    '      p = vec2(cos(th)*uAspect*.75, sin(th)*.85)*r; float rr = length(p);\n' +
    '      z = vec2(-p.y, p.x)/rr*sqrt(GM/rr)*(.8 + .35*hash(fij + .5)); }\n' +
    '    for (int i = 0; i < 2; i++) { float r2 = dot(p, p) + .004;\n' +
    '      z += -GM*p/(r2*sqrt(r2))*uDt*.5; p += z*uDt*.5; }\n' +
    '    bounded = false;\n' +
    '  } else if (uScene == 9) {\n' +           // k-means: points drift toward their nearest of 5 moving centroids
    '    vec2 home = vec2((h.x*2.-1.)*uAspect, h.y*2.-1.);\n' +
    '    float best = 1e9, id = 0.; vec2 bc = home;\n' +
    '    for (int i = 0; i < 5; i++) { float fi = float(i);\n' +
    '      vec2 c = vec2(sin(uTime*.13 + fi*1.7)*.7*uAspect, cos(uTime*.1 + fi*2.3)*.7);\n' +
    '      float dd = dot(home - c, home - c); if (dd < best) { best = dd; bc = c; id = fi; } }\n' +
    '    p += (mix(home, bc, .3) - p)*(1. - exp(-uDt*3.));\n' +
    '    z = vec2(id/4., 0.); bounded = false;\n' +
    '  } else if (uScene == 6) {\n' +           // wave: particles rest on a jittered field; render adds the ripple
    '    vec2 home = vec2((h.x*2.-1.)*uAspect, h.y*2.-1.);\n' +
    '    p += (home - p)*(1. - exp(-uDt*3.));\n' +
    '    z = vec2(0.); bounded = false;\n' +
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
    'uniform vec2 uPointer;\nuniform vec4 uHeat[3];\nuniform vec3 uA, uB;\nuniform float uCenterDim, uInner, uOuter;\nout vec4 vCol;\n' +
    'void main(){\n' +
    '  ivec2 ij = ivec2(gl_VertexID % uSide, gl_VertexID / uSide);\n' +
    '  vec4 s = texelFetch(uState, ij, 0);\n' +
    '  vec2 pos = s.xy; float ripple = 0.;\n' +
    // wave equation: expanding ring pulses from point sources (2D, damped), Huygens-style
    '  if (uScene == 6) { for (int i = 0; i < 3; i++) { vec4 w = uHeat[i]; float age = uTime - w.z;\n' +
    '      if (age < 0. || age > 6.) continue; vec2 d = pos - w.xy; float r = length(d) + 1e-4;\n' +
    '      float ring = w.w*exp(-pow((r - .42*age)/.06, 2.))*exp(-age*.45);\n' +
    '      ripple += ring; pos += d/r*ring*.045; } }\n' +
    '  gl_Position = vec4(pos.x/uAspect, pos.y, 0., 1.);\n' +
    '  gl_PointSize = 1.;\n' +
    '  vec3 col = uA; float a = 1.;\n' +
    // colour maps: amber -> orange -> coral for speed / noise level
    '  vec3 violet = vec3(.48, .33, .05);\n' +   // ochre: the third Ajrak dye, between madder (uA) and indigo (uB)
    '  if (uScene == 0 || uScene == 7 || uScene == 8) { float v = clamp(length(s.zw)*1.8, 0., 1.);\n' +
    '    col = v < .5 ? mix(uA, violet, v*2.) : mix(violet, uB, v*2. - 1.);\n' +
    '    if (uScene == 7) a = 2.2; else if (uScene == 8) a = 3.; }\n' +   // spread-out scenes need more light
    '  else if (uScene == 1) { float v = s.z;\n' +
    '    col = v < .5 ? mix(uA, violet, v*2.) : mix(violet, uB, v*2. - 1.);\n' +
    '    a = .9 - .6*v; }\n' +   // ink on paper: scattered noise stays faint, the shape stays crisp
    '  else if (uScene == 2) {\n' +
    // analytic solution of the 2D heat equation for instantaneous point sources: T ~ exp(-r^2/4at)/t
    '    float T = 0.;\n' +
    '    for (int i = 0; i < 3; i++) { vec4 hs = uHeat[i]; float t = max(uTime - hs.z, 0.) + .15;\n' +
    '      vec2 d = s.xy - hs.xy; T += hs.w*exp(-dot(d, d)/(4.*.02*t))*min(1., .9/(t + .3)); }\n' +
    '    if (uPointerOn > .5) { vec2 d = s.xy - uPointer; T += .8*exp(-dot(d, d)/.006); }\n' +
    '    T = clamp(T, 0., 1.);\n' +
    // heat colour scale (inferno-like): deep violet -> magenta -> orange -> pale yellow
    '    vec3 h0 = vec3(.78, .66, .45), h1 = vec3(.60, .42, .07), h2 = vec3(.63, .19, .12), h3 = vec3(.15, .11, .12);\n' +   // dye ramp: paper -> ochre -> madder -> iron-black
    '    float Tv = sqrt(T);\n' +   // lift moderate temperatures so the spreading heat stays visible
    '    col = Tv < .33 ? mix(h0, h1, Tv/.33) : Tv < .66 ? mix(h1, h2, (Tv - .33)/.33) : mix(h2, h3, (Tv - .66)/.34);\n' +
    '    a = .08 + Tv*16.;\n' +   // cold particles nearly invisible on paper; warm regions show as dye
    '  } else if (uScene == 9) { float v = s.z;\n' +          // k-means: one colour per cluster
    '    col = v < .5 ? mix(uA, violet, v*2.) : mix(violet, uB, v*2. - 1.); a = 2.; }\n' +
    '  else if (uScene == 4) { float v = s.z;\n' +          // flow matching: data = accent, noise = coral
    '    col = v < .5 ? mix(uA, violet, v*2.) : mix(violet, uB, v*2. - 1.); a = .9 - .6*v; }\n' +
    '  else if (uScene == 5) { float v = s.z;\n' +              // Langevin: low loss = accent, high loss = coral
    '    col = v < .5 ? mix(uA, violet, v*2.) : mix(violet, uB, v*2. - 1.); a = .35 + 2.6*v; }\n' +   // bright while descending, dim once settled in a minimum
    '  else if (uScene == 6) { float v = clamp(ripple, 0., 1.);\n' +
    '    col = mix(uB, uA, v); a = .45 + v*5.; }\n' +   // wave crests in madder over indigo
    '  else col = mix(uA, uB, step(0., s.z));\n' +
    // readability: particles behind the text column are dimmed; the side margins stay bright
    '  a *= mix(uCenterDim, 1., smoothstep(uInner, uOuter, abs(gl_Position.x)));\n' +
    '  vCol = vec4(col, a);\n}';

  var FS_RENDER = '#version 300 es\nprecision highp float;\nuniform float uAlpha, uCap;\nin vec4 vCol;\nout vec4 o;\n' +
    'void main(){ float a = min(uAlpha*vCol.a, uCap); o = vec4(vCol.rgb*a, a); }';   // no single particle glows too bright

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
    // particles use the deeper dye shades so they read as ink, not pastel tint
    colA = rgb(cs.getPropertyValue('--clr-accent-dark'), colA);
    colB = rgb(cs.getPropertyValue('--clr-signal-dark') || cs.getPropertyValue('--clr-signal'), colB);
  })();

  /* ---------------- scenes ---------------- */
  // Each visit opens on a random scene, never the one the visitor saw last.
  var lastSeen = -1;
  try { var ls = localStorage.getItem('bg-scene'); if (ls !== null) lastSeen = +ls; } catch (e) {}
  var scene;
  do { scene = Math.floor(Math.random() * SCENES.length); } while (scene === lastSeen && SCENES.length > 1);
  var shapeKind = 0, sceneStart = 0, sceneLen = 25;
  var heat = [[0, 0, -99, 0], [0, 0, -99, 0], [0, 0, -99, 0]], nextHeat = 0, heatSlot = 0;

  // Scenes come from a shuffled bag, so every process appears before any repeats.
  var bag = [];
  function nextScene() {
    if (!bag.length) {
      bag = SCENES.map(function (_, k) { return k; }).filter(function (k) { return k !== scene; });
      for (var k = bag.length - 1; k > 0; k--) { var j = Math.floor(Math.random() * (k + 1)); var tmp = bag[k]; bag[k] = bag[j]; bag[j] = tmp; }
    }
    return bag.shift();
  }

  function setScene(i, now) {
    scene = i;
    sceneStart = now;
    // one full cycle for the cyclic scenes, 13-17 s for the others
    sceneLen = i === 1 ? 14 : i === 4 ? 12 : 13 + Math.random() * 4;
    shapeKind = Math.floor(Math.random() * 3);
    nextHeat = 0;
    heat = [[0, 0, -99, 0], [0, 0, -99, 0], [0, 0, -99, 0]];
    if (i === 2) {
      // start with three sources already burning (staggered ages) so the scene is visible at once
      var tNow = (now - t0) / 1000, asp = canvas.width / canvas.height;
      for (var hs = 0; hs < 3; hs++) {
        heat[hs] = [(Math.random() * 1.6 - 0.8) * asp, Math.random() * 1.4 - 0.7, tNow - hs * 0.8, 0.9 + Math.random() * 0.3];
      }
      heatSlot = 0;
      nextHeat = tNow + 1.4;
    }
    try { localStorage.setItem('bg-scene', String(i)); } catch (e) {}
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

    if (now - sceneStart > sceneLen * 1000) setScene(nextScene(), now);
    var t = (now - t0) / 1000, st = (now - sceneStart) / 1000;
    if ((scene === 2 || scene === 6) && t > nextHeat) {      // heat sources / wave sources
      var aspect0 = canvas.width / canvas.height;
      heat[heatSlot] = [(Math.random() * 1.6 - 0.8) * aspect0, Math.random() * 1.4 - 0.7, t,
                        scene === 6 ? 0.7 + Math.random() * 0.5 : 0.8 + Math.random() * 0.4];
      heatSlot = (heatSlot + 1) % 3;
      nextHeat = t + (scene === 6 ? 1.4 : 2.2);
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
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // ink on paper: dense areas darken, never glow
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
    gl.uniform1f(progRender.u.uAlpha, Math.min(0.4, Math.max(0.02, 28000 / count)) * (small ? 0.75 : 1) * 1.0);
    // Keep text readable: cap each particle's brightness and dim the column where text sits.
    var contentHalf = Math.min(1140, window.innerWidth) / 2 - 32;     // matches .wrap max-width and gutter
    var narrow = window.innerWidth <= 760;                            // phones: text spans the full width
    gl.uniform1f(progRender.u.uCap, narrow ? 0.2 : 0.26);              // fewer, darker ink marks rather than faint dust
    gl.uniform1f(progRender.u.uCenterDim, narrow ? 0.3 : 0.32);
    gl.uniform1f(progRender.u.uInner, narrow ? 2 : 0.92 * contentHalf / (window.innerWidth / 2));
    gl.uniform1f(progRender.u.uOuter, narrow ? 3 : Math.min(1, contentHalf / (window.innerWidth / 2) + 0.12));
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
    scene: function (i) { setScene(i, performance.now()); },
    next: function () { setScene(nextScene(), performance.now()); }
  };
})();
