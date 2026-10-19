/* The 30 processes drawn by the GPU background (bg-physics.js).
   Each scene is two small GLSL snippets that the engine wraps into its own pair of programs:

     upd  runs once per particle per frame (fragment shader, GPGPU). In scope:
            p, z (vec2)       the particle's state; p is the screen position unless the scene says otherwise
            fij, h, eps, nT   particle id, two fixed uniforms in [0,1), a fixed Gaussian, fresh Gaussian noise
            fresh             true on the first frame of the scene, and for rows that were switched off meanwhile
            bounded           set to false when the scene handles its own domain (otherwise strays are respawned)
          Uniforms: uTime, uSceneT (seconds into this scene), uLen, uDt, uAspect, uSeed (changes every frame),
          uN (a loop bound the compiler cannot unroll), uPointer, uPointerOn, uShape (0-2) and uVar (0-1), the
          last two drawn at random for every visit so a repeat never looks the same.
          Helpers: hash, gauss, shape, refl, cv (the canvas, (aspect, 1)). `fns` are compiled into the update
          shader only; the colouring cannot call them. ij is the particle's integer id.
     col  runs once per particle in the vertex shader: reads s (the state), may move pos, sets col and a
          (relative brightness). Helpers: hash, ramp(v) = madder -> ochre -> indigo, uA/uB, uHeat, uPointer, uSceneT.
     Optional per-scene fields: len (seconds, default 9), gain (brightness multiplier), cap (per-particle
     alpha ceiling multiplier, for scenes made of thin lines), src ({kind: 'heat' | 'wave', period}).

   Coordinates: x in [-aspect, aspect], y in [-1, 1]. Every scene stays valid from any starting state,
   because the previous scene's particles are the next scene's starting cloud.
   Order matters only for window.__bg.scene(i); the ids match build_math.py. */
(function () {
  'use strict';
  var S = [];
  function add(def) { S.push(def); }

  /* ====================================================================================
     1-10: the original processes
     ==================================================================================== */

  add({ id: 'flow', gain: 1.6,          // curl-noise advection, the cursor stirs it
    fns: `
vec2 curl(vec2 p, float t){
  vec2 q = p*1.6;
  float a = 1.3*q.x + .21*t, b = 1.1*q.y - .17*t, c = 2.1*(q.x+q.y) + .11*t, d = 3.7*q.x - 2.9*q.y + .3*t;
  float dx = 1.3*cos(a)*cos(b) + 1.05*cos(c) + .925*cos(d);
  float dy = -1.1*sin(a)*sin(b) + 1.05*cos(c) - .725*cos(d);
  return vec2(dy, -dx);
}`,
    upd: `
vec2 f = curl(p, uTime)*.32;
if (uPointerOn > .5) { vec2 d = uPointer - p; float r = length(d) + 1e-4; float k = 1. - smoothstep(0., .5, r);
  f += (d/r*.6 + vec2(-d.y, d.x)/max(r, .06)*.35)*k; }
z = mix(z, f, .08); p += z*uDt;
if (hash(fij + uSeed) < .002) p = vec2(9.);`,
    col: `
float v = clamp(length(s.zw)*1.8, 0., 1.);
col = ramp(v);`
  });

  add({ id: 'diffusion', gain: 1.7,     // forward then reverse diffusion: x_t = sqrt(abar) x0 + sqrt(1-abar) eps
    upd: `
float c = mod(uSceneT, uLen);
float tt = c < 1. ? 0. : c < 4. ? (c - 1.)/3. : c < 5. ? 1. : c < 8. ? 1. - (c - 5.)/3. : 0.;
float ab = cos(1.5707963*tt); ab *= ab;
vec2 tgt = sqrt(ab)*shape(uShape, h)*vec2(max(uAspect*.75, 1.), 1.) + sqrt(1. - ab)*eps*vec2(.5*uAspect, .5) + nT*.003;
p += (tgt - p)*(1. - exp(-uDt*4.));
z = vec2(tt, 0.); bounded = false;`,
    col: `
float v = s.z;
col = ramp(v); a = .9 - .6*v;`      // ink on paper: scattered noise stays faint, the shape stays crisp
  });

  add({ id: 'heat', src: { kind: 'heat', period: 2.2 },   // Brownian particles over an analytic heat kernel
    upd: `
p += nT*sqrt(2.*.004*uDt);
if (hash(fij + uSeed) < .001) p = vec2(9.);
z = vec2(0.);`,
    col: `
// analytic solution of the 2D heat equation for instantaneous point sources: T ~ exp(-r^2/4at)/t
float T = 0.;
for (int i = 0; i < 3; i++) { vec4 hs = uHeat[i]; float t = max(uTime - hs.z, 0.) + .15;
  vec2 d = s.xy - hs.xy; T += hs.w*exp(-dot(d, d)/(4.*.02*t))*min(1., .9/(t + .3)); }
if (uPointerOn > .5) { vec2 d = s.xy - uPointer; T += .8*exp(-dot(d, d)/.006); }
T = clamp(T, 0., 1.);
vec3 h0 = vec3(.78, .66, .45), h1 = vec3(.60, .42, .07), h2 = vec3(.63, .19, .12), h3 = vec3(.15, .11, .12);   // paper -> ochre -> madder -> iron-black
float Tv = sqrt(T);
col = Tv < .33 ? mix(h0, h1, Tv/.33) : Tv < .66 ? mix(h1, h2, (Tv - .33)/.33) : mix(h2, h3, (Tv - .66)/.34);
a = .08 + Tv*16.;`
  });

  add({ id: 'lorenz',        // particles relax onto the Lorenz attractor
    upd: `
float K = .034;
vec3 L = vec3(clamp(p.x/K, -25., 25.), z.x, clamp(p.y/K + 25., 0., 55.));
if (fresh) L.y = (h.x - .5)*20.;
for (int i = 0; i < 3; i++) {
  vec3 dL = vec3(10.*(L.y - L.x), L.x*(28. - L.z) - L.y, L.x*L.y - 2.6666667*L.z);
  L += dL*.005;
}
p = vec2(L.x*K, (L.z - 25.)*K); z = vec2(L.y, 0.); bounded = false;`,
    col: `col = mix(uA, uB, step(0., s.z));`
  });

  add({ id: 'flowmatch', gain: 1.7,     // straight-line paths between noise and data
    upd: `
float c = mod(uSceneT, uLen);
float tt = c < 1. ? 0. : c < 4. ? (c - 1.)/3. : c < 5. ? 1. : c < 8. ? 1. - (c - 5.)/3. : 0.;
vec2 tgt = mix(eps*vec2(.5*uAspect, .5), shape(uShape, h)*vec2(max(uAspect*.75, 1.), 1.), tt);
p += (tgt - p)*(1. - exp(-uDt*9.));
z = vec2(1. - tt, 0.); bounded = false;`,
    col: `
float v = s.z;
col = ramp(v); a = .9 - .6*v;`
  });

  add({ id: 'langevin', gain: 1.6,      // gradient descent on a loss landscape plus noise
    fns: `
const vec2 WELLS[5] = vec2[5](vec2(-.95, .35), vec2(.85, -.3), vec2(.05, .58), vec2(.32, -.55), vec2(-.45, -.45));
float lossU(vec2 p){ float u = .12*dot(p, p);
  for (int i = 0; i < 5; i++) { vec2 d = p - WELLS[i]; u -= exp(-dot(d, d)/.08); } return u; }
vec2 lossGrad(vec2 p){ vec2 g = .24*p;
  for (int i = 0; i < 5; i++) { vec2 d = p - WELLS[i]; g += exp(-dot(d, d)/.08)*2.*d/.08; } return g; }`,
    upd: `
vec2 sc = vec2(uAspect*.8, 1.);                     // the landscape is stretched over the canvas
vec2 q = p/sc;
p += -lossGrad(q)/sc*uDt*.25 + nT*sqrt(2.*.03*uDt);
if (hash(fij + uSeed) < .008) p = vec2(9.);
z = vec2(clamp((lossU(p/sc) + 1.)/1.4, 0., 1.), 0.);`,
    col: `
float v = s.z;
col = ramp(v); a = .35 + 2.6*v;`    // bright while descending, dim once settled in a minimum
  });

  add({ id: 'wave', gain: 1.3, src: { kind: 'wave', period: 1.4 },    // ripples from point sources (Huygens)
    upd: `
vec2 home = (vec2(h.x, h.y)*2. - 1.)*cv;
p += (home - p)*(1. - exp(-uDt*3.));
z = vec2(0.); bounded = false;`,
    col: `
float ripple = 0.;
for (int i = 0; i < 3; i++) { vec4 w = uHeat[i]; float age = uTime - w.z;
  if (age < 0. || age > 6.) continue; vec2 d = pos - w.xy; float r = length(d) + 1e-4;
  float q = (r - .42*age)/.06; float ring = w.w*exp(-q*q)*exp(-age*.45);
  ripple += ring; pos += d/r*ring*.045; }
float v = clamp(ripple, 0., 1.);
col = mix(uB, uA, v); a = .45 + v*5.;`    // crests in madder over indigo
  });

  add({ id: 'vortex', gain: 1.5,        // three point vortices (Biot-Savart)
    upd: `
vec2 u = vec2(0.);
for (int i = 0; i < 3; i++) { float fi = float(i);
  vec2 c = vec2(cos(uTime*.11 + fi*2.1)*.55*uAspect, sin(uTime*.09 + fi*2.7)*.45);
  float G = (i == 1 ? -1. : 1.)*.09; vec2 d = p - c; float r2 = dot(d, d) + .01;
  u += G*vec2(-d.y, d.x)/r2; }
z = mix(z, u, .2); p += z*uDt;
if (hash(fij + uSeed) < .002) p = vec2(9.);`,
    col: `
float v = clamp(length(s.zw)*1.8, 0., 1.);
col = ramp(v); a = 2.2;`
  });

  add({ id: 'gravity',       // orbits around a central mass (leapfrog)
    upd: `
float GM = .12;
if (fresh || dot(p, p) > 6.) { float r = .25 + h.x*.8, th = h.y*6.2831853;
  p = vec2(cos(th)*uAspect*.75, sin(th)*.85)*r; float rr = length(p);
  z = vec2(-p.y, p.x)/rr*sqrt(GM/rr)*(.8 + .35*hash(fij + .5)); }
for (int i = 0; i < 2; i++) { float r2 = dot(p, p) + .004;
  z += -GM*p/(r2*sqrt(r2))*uDt*.5; p += z*uDt*.5; }
bounded = false;`,
    col: `
float v = clamp(length(s.zw)*1.8, 0., 1.);
col = ramp(v); a = 3.;`
  });

  add({ id: 'kmeans', gain: 1.5,        // points drift toward the nearest of five moving centroids
    upd: `
vec2 home = (vec2(h.x, h.y)*2. - 1.)*cv;
float best = 1e9, id = 0.; vec2 bc = home;
for (int i = 0; i < 5; i++) { float fi = float(i);
  vec2 c = vec2(sin(uTime*.13 + fi*1.7)*.7*uAspect, cos(uTime*.1 + fi*2.3)*.7);
  float dd = dot(home - c, home - c); if (dd < best) { best = dd; bc = c; id = fi; } }
p += (mix(home, bc, .3) - p)*(1. - exp(-uDt*3.));
z = vec2(id/4., 0.); bounded = false;`,
    col: `
float v = s.z;
col = ramp(v); a = 2.;`
  });

  /* ====================================================================================
     11-30: new processes
     ==================================================================================== */

  add({ id: 'rossler', cap: 1.5,       // Rossler attractor: x' = -y - z, y' = x + ay, z' = b + z(x - c)
    upd: `
vec2 K = vec2(.075*uAspect, .075);
vec3 L = vec3(p/K, z.x);
if (fresh || dot(L, L) > 1600.) L = vec3((h.x - .5)*12., (h.y - .5)*12., h.x*5.);
for (int i = 0; i < 3; i++) {
  vec3 dL = vec3(-L.y - L.z, L.x + .2*L.y, .2 + L.z*(L.x - 5.7));
  L += dL*.03;
}
p = L.xy*K; z = vec2(L.z, 0.); bounded = false;`,
    col: `
col = ramp(clamp(s.z/20., 0., 1.)); a = 1.3;`
  });

  add({ id: 'clifford', cap: 1.7, gain: 1.5,   // Clifford map: x' = sin(ay) + c cos(ax), y' = sin(bx) + d cos(by)
    upd: `
// four parameter sets that are chaotic and stay so: nudging a, b, c, d lets the map slip into periodic windows, so they are fixed
vec4 pr = uVar < .25 ? vec4(-1.4, 1.6, 1., .7) : uVar < .5 ? vec4(1.5, -1.8, 1.6, .9) : uVar < .75 ? vec4(-1.7, 1.3, -.1, -1.21) : vec4(-1.7, 1.8, -1.9, -.4);
vec2 ext = vec2(1. + abs(pr.z), 1. + abs(pr.w));      // |x'| <= 1 + |c|, |y'| <= 1 + |d|
vec2 K = vec2(.94*uAspect/ext.x, .94/ext.y);
vec2 u = p/K;
if (fresh || abs(u.x) > 4. || abs(u.y) > 4.) u = (vec2(h.x, h.y)*2. - 1.)*ext;
vec2 un = vec2(sin(pr.x*u.y) + pr.z*cos(pr.x*u.x), sin(pr.y*u.x) + pr.w*cos(pr.y*u.y));
z = vec2(clamp(length(un - u)*.45, 0., 1.), 0.);
p = un*K; bounded = false;`,
    col: `
col = ramp(.5 + .5*sin(6.2831853*(s.z*.8 + uSceneT*.06))); a = 1.3;`      // the colours drift slowly; the shape does not
  });

  add({ id: 'doublependulum', cap: 2, gain: 1.6,   // 1e5+ double pendulums that differ by a hair: the butterfly effect
    fns: `
const float G = 9.81;
vec2 pend(vec2 th, vec2 w){
  float dl = th.x - th.y, den = 3. - cos(2.*dl);
  float a1 = (-3.*G*sin(th.x) - G*sin(th.x - 2.*th.y) - 2.*sin(dl)*(w.y*w.y + w.x*w.x*cos(dl)))/den;
  float a2 = (2.*sin(dl)*(2.*w.x*w.x + 2.*G*cos(th.x) + w.y*w.y*cos(dl)))/den;
  return vec2(a1, a2);
}
void rk4(inout vec2 th, inout vec2 w, float dt){
  vec2 k1t = w,                k1w = pend(th, w);
  vec2 k2t = w + .5*dt*k1w,    k2w = pend(th + .5*dt*k1t, k2t);
  vec2 k3t = w + .5*dt*k2w,    k3w = pend(th + .5*dt*k2t, k3t);
  vec2 k4t = w + dt*k3w,       k4w = pend(th + dt*k3t, k4t);
  th += dt/6.*(k1t + 2.*k2t + 2.*k3t + k4t);
  w  += dt/6.*(k1w + 2.*k2w + 2.*k3w + k4w);
}`,
    upd: `
// p = (theta1, theta2), z = (omega1, omega2): the render stage turns the angles into the tip position
if (fresh) p = vec2(2.2 + 1.2*uVar, 2.6 + .8*uVar) + (vec2(h.x, h.y) - .5)*2.4e-2;
float dt = min(uDt, .033)*.5;
rk4(p, z, dt); rk4(p, z, dt);
bounded = false;`,
    col: `
float hx = hash(vec2(ij)*.731 + .13);
vec2 tip = vec2(0., .1) + .44*(vec2(sin(s.x), -cos(s.x)) + vec2(sin(s.y), -cos(s.y)));
pos = tip*vec2(uAspect, 1.);
col = ramp(hx); a = 1.4;`
  });

  add({ id: 'doublegyre', cap: 2.2, gain: 2,   // double-gyre flow: psi = A sin(pi f(x,t)) sin(pi y); dye starts in the left gyre only
    upd: `
if (fresh) p = (vec2(h.x, h.y)*2. - 1.)*cv;
// map to the textbook domain [0,2] x [0,1]
float X = p.x/uAspect + 1., Y = p.y*.5 + .5;
float e = .25*sin(1.1*uTime), ff = e*X*X + (1. - 2.*e)*X;
float dff = 2.*e*X + 1. - 2.*e;
float A0 = .5;
vec2 vel = 3.1415927*A0*vec2(-sin(3.1415927*ff)*cos(3.1415927*Y), cos(3.1415927*ff)*sin(3.1415927*Y)*dff);
p += vel*vec2(uAspect, 2.)*uDt*.9;
if (abs(p.x) > uAspect*1.02 || abs(p.y) > 1.02) p = (vec2(h.x, h.y)*2. - 1.)*cv;
z = vec2(step(.5, h.x), 0.); bounded = false;`,
    col: `
col = s.z > .5 ? uB : uA; a = s.z > .5 ? .1 : 2.6;`
  });

  add({ id: 'vanderpol', cap: 2, gain: 1.5,   // x'' - mu(1 - x^2)x' + x = 0: drops released all over the phase plane spiral onto the limit cycle
    upd: `
float mu = .8 + 1.7*uVar;
vec2 K = vec2(.27*uAspect*.8, .2);
vec2 u = p/K;
float age = z.x + uDt;                                       // seconds since this particle was released; it lives 3.2 s
bool born = fresh || age > 3.2 || abs(u.x) > 6. || abs(u.y) > 9.;
if (born) { u = (vec2(h.x, h.y)*2. - 1.)*vec2(3.8, 5.2) + gauss(fij*.77 + uSeed)*.15; age = fresh ? h.x*3.2 : 0.; }
for (int i = 0; i < 2; i++) {
  vec2 d = vec2(u.y, mu*(1. - u.x*u.x)*u.y - u.x);
  u += d*.0125;
}
p = u*K; z = vec2(age, 0.); bounded = false;`,
    col: `
float v = clamp(s.z/3.2, 0., 1.);
col = ramp(v); a = 3.4*smoothstep(0., .12, s.z)*(1. - smoothstep(2.6, 3.2, s.z)) + .05;`
  });

  add({ id: 'chaosgame', cap: 1.8, gain: 3,   // chaos game: jump halfway to a random corner, forever: the Sierpinski triangle (it slowly turns)
    upd: `
float rot0 = .14*uSceneT;
float beat = floor(uSceneT*7.);
if (fresh) z = p;
if (fresh || floor((uSceneT - uDt)*7.) != beat) {                    // one hop every 1/7 s, all particles together
  float k = floor(hash(fij*1.9 + beat*3.7)*3.);
  float ang = 2.0943951*k + rot0 + 1.5707963;
  vec2 v = vec2(cos(ang), sin(ang))*.92*cv;
  z = .5*(z + v);
}
p += (z - p)*(1. - exp(-uDt*16.));
bounded = false;`,
    col: `
float ang = atan(pos.y, pos.x/uAspect) - .14*uSceneT - 1.5707963;
float k = floor(mod(ang/6.2831853*3. + .5, 3.));                    // which corner this point is nearest
col = ramp(k/2.); a = 1.4;`
  });

  add({ id: 'levy', cap: 1.8,      // Levy flights: 80 walkers, a power-law step (alpha = 1.3) every 0.13 s; each particle shows its walker a little earlier, drawing the path
    upd: `
float M = 80.;
float id = floor(h.y*M);
float lag = h.x*2.4;
float nst = max(uSceneT + 2.4 - lag, 0.)/.13;
vec2 q = (vec2(hash(vec2(id, 1.7) + uVar*9.), hash(vec2(id, 4.1) + uVar*9.))*2. - 1.)*.9;
for (int j = 0; j < uN; j++) {
  float fj = float(j);
  if (fj >= nst) break;
  float f = min(1., nst - fj);
  vec2 g = gauss(vec2(id*.37 + fj*1.31, fj*.77 + id*.19) + 5.5);
  float u1 = max(hash(vec2(id*.53 + fj*.91, fj*.31 + id*.77) + 3.1), 1e-3);
  q += normalize(g)*min(.03*pow(u1, -1./1.3), 1.4)*f;
}
q = vec2(refl(q.x, 1.), refl(q.y, 1.));
p = q*cv + eps*.003;
z = vec2(h.x, 0.); bounded = false;`,
    col: `
col = ramp(s.z); a = 2.4*(1. - .85*s.z);`
  });

  add({ id: 'mcmc', cap: 1.6, gain: 1.5,   // Metropolis-Hastings: walkers settle into the target density
    fns: `
float logPi(vec2 u, int kind){
  if (kind == 0) { float d = u.y + .9*u.x*u.x - .35; return -u.x*u.x/(2.*.42*.42) - d*d/(2.*.07*.07); }       // banana
  if (kind == 1) { float d = length(u) - .75; return -d*d/(2.*.06*.06); }                                      // ring
  vec2 a = u - vec2(-.8, -.35), b = u - vec2(.75, .4), c = u - vec2(-.1, .72);                                 // three blobs
  return log(exp(-dot(a, a)/(2.*.04)) + exp(-dot(b, b)/(2.*.04)) + exp(-dot(c, c)/(2.*.04)) + 1e-30);
}`,
    upd: `
vec2 K = cv*.85;
vec2 u = p/K;
if (fresh || abs(u.x) > 3. || abs(u.y) > 3.) u = vec2(-1.1 + 2.2*step(.5, uVar), .85) + eps*.1;
float st = mix(.13, .045, smoothstep(0., 5., uSceneT));
float lp0 = logPi(u, uShape);
for (int i = 0; i < 2; i++) {
  vec2 q = u + gauss(fij*.61 + uSeed*(1.3 + float(i)))*st;
  float lq = logPi(q, uShape);
  if (log(max(hash(fij*.37 + uSeed*(2.9 + float(i))), 1e-6)) < lq - lp0) { u = q; lp0 = lq; }
}
p = u*K; z = vec2(clamp(exp(lp0*.12), 0., 1.), 0.); bounded = false;`,
    col: `
col = ramp(1. - s.z); a = 1. + 1.3*s.z;`
  });

  add({ id: 'kuramoto', cap: 1.6, gain: 3,   // Kuramoto oscillators on concentric rings; coupling grows past K_c = 2*gamma
    upd: `
float gam = .5, w0 = .8;
if (fresh) z = vec2(h.y*6.2831853, w0 + clamp(gam*tan(3.1415927*(h.x - .5)*.98), -6., 6.));
float Kt = mix(.25, 2.4, smoothstep(.8, 6.5, uSceneT));
float r = Kt > 2.*gam ? sqrt(1. - 2.*gam/Kt) : 0.;      // steady-state order parameter for a Lorentzian spread
r = max(r, .03);
float psi = w0*uSceneT;
z.x += (z.y + Kt*r*sin(psi - z.x))*uDt*1.6;
float rad = .14 + .8*sqrt(hash(fij*.77 + 2.9));
p = vec2(cos(z.x), sin(z.x))*rad*cv; bounded = false;`,
    col: `
float rel = s.z - .8*uSceneT;
col = ramp(.5 + .5*cos(rel)); a = 1.2;`
  });

  add({ id: 'chladni', cap: 1.3,       // sand on a vibrating plate piles up on the nodal lines of cos(n pi x)cos(m pi y) - cos(m pi x)cos(n pi y)
    fns: `
float plate(vec2 u, vec2 nm){
  return cos(nm.x*3.1415927*u.x)*cos(nm.y*3.1415927*u.y) - cos(nm.y*3.1415927*u.x)*cos(nm.x*3.1415927*u.y);
}`,
    upd: `
vec2 nm1 = uVar < .33 ? vec2(2., 5.) : uVar < .66 ? vec2(3., 7.) : vec2(1., 6.);
vec2 nm2 = uVar < .33 ? vec2(4., 9.) : uVar < .66 ? vec2(5., 8.) : vec2(3., 10.);
float sw = smoothstep(4.2, 6.4, uSceneT);
vec2 u = vec2(p.x/uAspect*.5 + .5, p.y*.5 + .5);
float w = mix(plate(u, nm1), plate(u, nm2), sw);
if (fresh) p = (vec2(h.x, h.y)*2. - 1.)*cv;
p += nT*(.0012 + .05*abs(w))*sqrt(uDt*60.);                // sand jumps where the plate moves most, rests at the nodes
p = vec2(refl(p.x, uAspect), refl(p.y, 1.));
z = vec2(clamp(abs(w), 0., 1.), 0.); bounded = false;`,
    col: `
col = ramp(clamp(s.z*1.2, 0., 1.)); a = 1.6;`
  });

  add({ id: 'doubleslit', cap: 1.7,    // each particle goes through one slit and lands where the interference pattern allows
    upd: `
float T = 3.2;
float tt = uSceneT + h.x*T;
float c = floor(tt/T);
float u = tt/T - c;
vec2 S0 = vec2(-.93*uAspect, 0.);
float xp = -.4*uAspect, xs = .9*uAspect;
float sl = hash(fij + c*7.31) < .5 ? 1. : -1.;
vec2 slit = vec2(xp, sl*.09);
// landing height by rejection sampling of cos^2(19.6 y) * sinc^2(6.5 y)
float yl = 0., ok = 0.;
for (int i = 0; i < 12; i++) {
  float fi = float(i);
  float yc = (hash(fij*1.7 + c*3.1 + fi*5.3)*2. - 1.)*.88;
  float cc = cos(19.6*yc), x6 = 6.5*yc;
  float sn = abs(x6) < 1e-3 ? 1. : sin(x6)/x6;
  if (ok < .5 && hash(fij*2.3 + c*4.7 + fi*9.1) < cc*cc*sn*sn) { yl = yc; ok = 1.; }
}
if (ok < .5) yl = floor((hash(fij*.9 + c*1.3)*2. - 1.)*5. + .5)*3.1415927/19.6;      // fall back to a fringe maximum
vec2 land = vec2(xs + (hash(fij*.6 + c*2.1) - .5)*.1, yl);                              // a band, so each fringe shows as a bar
if (u < .34) p = mix(S0, slit, u/.34);
else if (u < .66) p = mix(slit, land, (u - .34)/.32);
else p = land;
p += eps*.0025;
z = vec2(sl, u);
if (h.y > .96) {                                              // 4% of the particles draw the plate with its two slits
  float y = (hash(fij*3.3 + 1.1)*2. - 1.)*.98;
  if (abs(abs(y) - .09) < .03) y = sign(y)*(.2 + .78*hash(fij*5.1 + 2.7));
  p = vec2(xp, y) + eps*.002; z = vec2(0., 2.);
}
bounded = false;`,
    col: `
if (s.w > 1.5) { col = uB; a = 1.3; }
else { col = s.z > 0. ? uA : uB; a = s.w < .66 ? .6 : 1.8; }`
  });

  add({ id: 'cyclotron', cap: 1.5,     // gyration plus E x B drift: both signs drift the same way, gyrate opposite ways
    upd: `
float nb = 7.;
float b = floor(h.y*nb);
float qs = mod(b, 2.) < .5 ? 1. : -1.;
float rho = .05 + .11*hash(vec2(b, 3.3) + uVar*7.);
float om = qs*(4.5 + 1.5*hash(vec2(b, 9.1) + uVar*3.));
float yb = (b + .5)/nb*1.76 - .88;
float x0 = (hash(vec2(b, 5.7) + uVar*11.)*2. - 1.)*uAspect;
float ph = 6.2831853*hash(vec2(b, 1.9) + uVar*5.);
float lag = h.x*2.4;                                         // each particle samples the orbit at an earlier time: a trail
float t = uSceneT - lag;
float xg = mod(x0 + .42*t*max(uAspect*.6, 1.) + uAspect, 2.*uAspect) - uAspect;
p = vec2(xg + rho*cos(om*t + ph), yb + rho*sin(om*t + ph)) + eps*.0045;
z = vec2(qs*.5 + .5, h.x); bounded = false;`,
    col: `
col = mix(uB, uA, s.z); a = 1.7*(1. - .85*s.w);`
  });

  add({ id: 'phyllotaxis', cap: 1.4,   // seeds at the golden angle: r = c sqrt(n), theta = n * 137.5 degrees (detuned later on)
    upd: `
float N = 2600.;
float n = floor(h.x*N);
float tb = n/N*4.2;
float grow = 1. - pow(1. - clamp((uSceneT - tb)/1., 0., 1.), 3.);
float alpha = (137.5077 + .5*sin(.35*uSceneT)*smoothstep(4., 6., uSceneT))*.017453293;
float rr = sqrt((n + .5)/N);
p = vec2(cos(n*alpha), sin(n*alpha))*rr*cv*.94*grow + eps*.0042;
z = vec2(rr, 0.); bounded = false;`,
    col: `
col = ramp(s.z); a = 1.4;`
  });

  add({ id: 'lissajous', cap: 1.3, gain: 1.3,   // x = A sin(at + d), y = B sin(bt), with a comet running along the curve
    upd: `
vec2 ab = uVar < .25 ? vec2(3., 2.) : uVar < .5 ? vec2(5., 4.) : uVar < .75 ? vec2(3., 4.) : vec2(5., 6.);
float sv = h.x*6.2831853;
float dlt = .45*uSceneT;
p = vec2(sin(ab.x*sv + dlt), sin(ab.y*sv))*cv*.93 + eps*.004;
float head = fract(uSceneT*.22)*6.2831853;
float dd = mod(sv - head + 6.2831853, 6.2831853);
z = vec2(exp(-dd*1.4), h.x); bounded = false;`,
    col: `
col = ramp(s.w); a = .55 + 4.*s.z;`
  });

  add({ id: 'montecarlo', cap: 3, gain: 3,   // darts in the unit square: the fraction inside the inscribed circle estimates pi/4
    upd: `
vec2 q = vec2(h.x, h.y)*2. - 1.;
float tl = hash(fij*.43 + 8.8)*5.5;                    // landing time
p = q*cv*.98;
z = vec2(dot(q, q) < 1. ? 1. : 0., tl); bounded = false;`,
    col: `
float age = uSceneT - s.w;
col = s.z > .5 ? uA : uB;
float dart = hash(vec2(ij)*.37 + 2.2) < .06 ? 1. : 0.;     // one particle in sixteen is a visible dart
a = (age < 0. ? 0. : 22.*(1. + 2.5*exp(-age*7.)))*dart;`
  });

  add({ id: 'galaxy', cap: 1.3,        // differential rotation, Omega ~ 1/r, winds a straight bar into spiral arms
    upd: `
float rr = .04 + .92*pow(h.x, 1.6);
float th0 = (h.y < .5 ? 0. : 3.1415927) + (hash(fij*.9 + 4.4) - .5)*.35 + .3*uVar;
float th = th0 + uSceneT*.9/(rr + .1);
p = vec2(cos(th), sin(th))*rr*cv*.96;
z = vec2(rr, 0.); bounded = false;`,
    col: `
col = ramp(s.z); a = 1.3;`
  });

  add({ id: 'transport', cap: 1.8, gain: 4.5,   // optimal transport of a uniform disk onto an annulus: a radial monotone map, no crossings
    upd: `
float c = mod(uSceneT, uLen);
float r0 = sqrt(h.x), th = h.y*6.2831853;
float rin = .35 + .35*uVar;
float r1 = sqrt(rin*rin + (1. - rin*rin)*r0*r0);
float sm = c < 1. ? 0. : c < 4. ? (c - 1.)/3. : c < 5. ? 1. : c < 8. ? 1. - (c - 5.)/3. : 0.;
sm = sm*sm*(3. - 2.*sm);
p = vec2(cos(th), sin(th))*mix(r0, r1, sm)*cv*.96;
z = vec2(r0, sm); bounded = false;`,
    col: `
col = ramp(s.z); a = 1.2;`
  });

  add({ id: 'bridge', cap: 2.2, gain: 4,   // Brownian bridges B(s) = sum xi_k sqrt(2) sin(k pi s)/(k pi), coefficients drifting slowly
    upd: `
float M = 420.;
float id = floor(h.y*M);
float sv = h.x;
float y = 0.;
for (int k = 1; k <= 9; k++) {
  float fk = float(k);
  vec2 sd = vec2(id*.317 + fk*1.13 + 7.1, fk*2.71 + id*.173 + 3.3);
  vec2 g1 = gauss(sd), g2 = gauss(sd + 41.7);
  float w = (.2 + .17*fk)*uTime;
  y += (g1.x*cos(w) + g2.x*sin(w))*1.4142136*sin(fk*3.1415927*sv)/(fk*3.1415927);
}
p = vec2(mix(-.97, .97, sv)*uAspect, y*1.05) + eps*.0025;
z = vec2(fract(id*.6180339), 0.); bounded = false;`,
    col: `
col = ramp(s.z); a = 1.1;`
  });

  add({ id: 'fountain', cap: 1.8, gain: 1.6,   // jets of drops, each a parabola r(t) = r0 + v0 t + g t^2/2; density pulses run up every jet
    upd: `
float K = 16.;
float side = h.y < .5 ? -1. : 1.;
float k = floor(fract(h.y*2.)*K);                       // jet number within this fountain
float fan = (k/(K - 1.) - .5)*2.;                       // -1 .. 1 across the fan
float ang = 1.5707963 + fan*.46 + .06*sin(uSceneT*.8 + k*.9);
float sp = 1.75 + .3*hash(vec2(k, side + 3.)) + .12*cos(uSceneT*.6 + k);
vec2 v = vec2(sp*cos(ang)*(.7 + .5*uAspect), sp*sin(ang));
float g = 1.55, fl = -.97;
float tf = 2.*v.y/g;                                    // flight time back to the floor
float tau = h.x*tf;
p = vec2(side*.72*uAspect + v.x*tau, fl + v.y*tau - .5*g*tau*tau);
float pulse = .5 + .5*sin(9.*tau - 7.*uSceneT);
z = vec2(fan*.5 + .5, .25 + 1.7*pulse*pulse); bounded = false;`,
    col: `
col = ramp(s.z); a = s.w;`
  });

  add({ id: 'cosmicweb', cap: 1.1,     // Zel'dovich approximation: x = q - D(t) grad(Phi); caustics are where the Jacobian vanishes
    upd: `
vec2 q = vec2(h.x, h.y)*2. - 1.;
vec2 psi = vec2(0.); float s11 = 0., s12 = 0., s22 = 0.;
for (int i = 0; i < 10; i++) {
  float fi = float(i);
  float ang = 6.2831853*hash(vec2(fi, uVar*13.7) + 1.3);
  float mag = 2.4 + 4.6*hash(vec2(fi + .5, uVar*13.7) + 7.7);
  vec2 kv = vec2(cos(ang), sin(ang))*mag;
  float a = (.5 + .5*hash(vec2(fi + 1.5, uVar*13.7) + 2.2))*.85/(mag*mag);
  float th = dot(kv, q) + 6.2831853*hash(vec2(fi + 2.5, uVar*13.7) + 4.4);
  psi += a*kv*sin(th);
  float cs = a*cos(th);
  s11 += cs*kv.x*kv.x; s12 += cs*kv.x*kv.y; s22 += cs*kv.y*kv.y;
}
float D = .05 + 1.4*pow(clamp(uSceneT/uLen, 0., 1.), 1.1);
float det = (1. + D*s11)*(1. + D*s22) - D*D*s12*s12;
float rho = 1./max(abs(det), .05);
p = (q + D*psi)*cv*.96;
p = vec2(refl(p.x, uAspect), refl(p.y, 1.));
z = vec2(clamp(log(rho)/2.5 + .35, 0., 1.), 0.); bounded = false;`,
    col: `
col = ramp(s.z); a = .5 + 1.5*s.z;`
  });

  window.BG_SCENES = S;
})();
