/* Shared site behaviour: mobile nav, theme toggle, scroll reveal,
   news "show all", live GitHub stars, BibTeX copy, and pixel-reveal thumbnails. */
(function () {
  'use strict';

  var root = document.documentElement;
  var reduceMotion = document.documentElement.classList.contains('reduce-motion');

  /* ---------- Motion: footer switch + notice when the OS asks for reduced motion ---------- */
  var setMotion = function (value) {
    try { localStorage.setItem('motion', value); } catch (e) {}
    window.location.reload();                     // every animation decides at start-up
  };
  var footer = document.querySelector('.site-footer p');
  if (footer) {
    var mt = document.createElement('button');
    mt.type = 'button';
    mt.className = 'motion-toggle';
    mt.textContent = reduceMotion ? '▶ play animations' : '⏸ pause animations';
    mt.addEventListener('click', function () { setMotion(reduceMotion ? 'on' : 'off'); });
    footer.appendChild(mt);
  }
  var noticeSeen = false;
  // only when the visitor has not chosen yet (an explicit pause is not 'the system')
  try { noticeSeen = localStorage.getItem('motion-notice') === 'seen' || localStorage.getItem('motion') !== null; } catch (e) {}
  if (reduceMotion && root.classList.contains('sys-reduce') && !noticeSeen) {
    var nb = document.createElement('div');
    nb.className = 'motion-notice';
    nb.setAttribute('role', 'status');
    nb.innerHTML = '<span>Animations are paused by your system’s reduced-motion setting.</span>' +
      '<button type="button" class="play">▶ Play</button><button type="button" class="dismiss" aria-label="Keep them paused">Keep paused</button>';
    nb.querySelector('.play').addEventListener('click', function () { setMotion('on'); });
    nb.querySelector('.dismiss').addEventListener('click', function () {
      try { localStorage.setItem('motion-notice', 'seen'); } catch (e) {}
      nb.remove();
    });
    document.body.appendChild(nb);
  }

  /* ---------- Mobile nav ---------- */
  var navBtn = document.getElementById('nav-toggle');
  if (navBtn) {
    var setNav = function (open) {
      document.body.classList.toggle('nav-open', open);
      navBtn.setAttribute('aria-expanded', String(open));
      navBtn.innerHTML = open ? '&#10005;' : '&#9776;';
    };
    navBtn.addEventListener('click', function () {
      setNav(!document.body.classList.contains('nav-open'));
    });
    document.querySelectorAll('.site-header nav a').forEach(function (a) {
      a.addEventListener('click', function () { setNav(false); });
    });
  }


  /* ---------- Bio "more about me" (phones only; CSS hides the button elsewhere) ---------- */
  var bioBtn = document.getElementById('bio-toggle');
  if (bioBtn) {
    bioBtn.addEventListener('click', function () {
      var open = bioBtn.parentElement.classList.toggle('is-open');
      bioBtn.setAttribute('aria-expanded', String(open));
      bioBtn.textContent = open ? 'Show less ↑' : 'More about me ↓';
    });
  }

  /* ---------- Header nav follows the section on screen (homepage) ---------- */
  var navLinks = {};
  document.querySelectorAll('.site-header nav a').forEach(function (a) {
    var h = a.getAttribute('href') || '';
    if (h.charAt(0) === '#') navLinks[h.slice(1)] = a;
    else if (h === 'index.html') navLinks.about = a;
  });
  if (Object.keys(navLinks).length > 1 && 'IntersectionObserver' in window) {
    var setActive = function (id) {
      var link = navLinks[id];
      if (!link) return;
      Object.keys(navLinks).forEach(function (k) { navLinks[k].classList.toggle('active', navLinks[k] === link); });
    };
    var clearActive = function () {
      Object.keys(navLinks).forEach(function (k) { navLinks[k].classList.remove('active'); });
    };
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        if (navLinks[entry.target.id]) setActive(entry.target.id);
        else clearActive();                       // a section that has no menu entry
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    // watch every section, so ones without a menu entry clear the highlight
    document.querySelectorAll('#about, main section.block').forEach(function (sec) { if (sec.id) spy.observe(sec); });
  }

  /* ---------- Mobile section tabs: show after the hero, highlight current section ---------- */
  var tabs = document.getElementById('section-tabs');
  if (tabs && 'IntersectionObserver' in window) {
    var hero = document.querySelector('.hero');
    if (hero) {
      new IntersectionObserver(function (entries) {
        tabs.classList.toggle('is-visible', !entries[0].isIntersecting);
      }, { rootMargin: '-120px 0px 0px 0px' }).observe(hero);
    }
    var links = {};
    tabs.querySelectorAll('a').forEach(function (a) { links[a.getAttribute('href').slice(1)] = a; });
    var current = null;
    var sectionObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var a = links[entry.target.id];
        if (!a || a === current) return;
        if (current) current.classList.remove('is-active');
        a.classList.add('is-active');
        current = a;
        // keep the active tab in view without moving the page
        tabs.scrollTo({ left: a.offsetLeft - tabs.clientWidth / 2 + a.clientWidth / 2, behavior: 'smooth' });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(links).forEach(function (id) {
      var sec = document.getElementById(id);
      if (sec) sectionObserver.observe(sec);
    });
  }

  /* ---------- On-device Gemma chat: scripts loaded on first click (facts, retrieval, chat; fingerprinted in data-scripts) ---------- */
  var gemmaBtn = document.getElementById('gemma-fab');
  if (gemmaBtn) {
    var gemmaLabel = gemmaBtn.querySelector('.ai-fab-label'), gemmaText = gemmaLabel.textContent, gemmaBusy = false, gemmaDone = {};
    gemmaBtn.setAttribute('aria-haspopup', 'dialog');
    gemmaBtn.setAttribute('aria-expanded', 'false');
    gemmaBtn.addEventListener('click', function () {
      var chat = window.GemmaChat;
      if (chat) { (chat.toggle || chat.open)(); return; }
      if (gemmaBusy) return;                    // aria-busy, not disabled: a disabled button would drop the keyboard focus
      gemmaBusy = true;
      gemmaBtn.setAttribute('aria-busy', 'true');
      gemmaLabel.textContent = 'Loading…';
      var files = (gemmaBtn.getAttribute('data-scripts') || 'assets/js/gemma-chat.js').split(/\s+/);
      var finish = function () {
        gemmaBusy = false;
        gemmaBtn.removeAttribute('aria-busy');
        if (window.GemmaChat) { gemmaLabel.textContent = gemmaText; window.GemmaChat.open(); return; }
        gemmaLabel.textContent = 'Unavailable';
        setTimeout(function () { gemmaLabel.textContent = gemmaText; }, 2500);
      };
      (function next(i) {                       // the chat is the last file; the facts and retrieval before it are optional
        if (i === files.length) { finish(); return; }
        if (gemmaDone[files[i]]) { next(i + 1); return; }
        var sc = document.createElement('script'), timer = 0;
        var settle = function (ok) {
          clearTimeout(timer);
          sc.onload = sc.onerror = null;
          if (ok) gemmaDone[files[i]] = true; else sc.remove();
          next(i + 1);
        };
        sc.src = files[i];
        sc.onload = function () { settle(true); };
        sc.onerror = function () { settle(false); };
        timer = setTimeout(function () { settle(false); }, 15000);      // a stalled request must not leave the tab saying "Loading…"
        document.head.appendChild(sc);
      })(0);
    });
  }

  /* ---------- Pause CSS animations in sections that are off screen ---------- */
  if ('IntersectionObserver' in window) {
    var pauseObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        entry.target.classList.toggle('is-offscreen', !entry.isIntersecting);
      });
    }, { rootMargin: '100px 0px' });
    document.querySelectorAll('.hero, .marquee, .block, .rl-hero').forEach(function (el) { pauseObs.observe(el); });
  }

  /* ---------- Scroll reveal (staggered among siblings) ---------- */
  var reveals = document.querySelectorAll('.reveal');
  var showAll = function () { reveals.forEach(function (el) { el.classList.add('is-in'); }); };

  if (reduceMotion || !('IntersectionObserver' in window)) {
    showAll();
  } else {
    reveals.forEach(function (el) {
      var siblings = Array.prototype.filter.call(el.parentElement.children, function (c) {
        return c.classList.contains('reveal');
      });
      var idx = siblings.indexOf(el);
      el.style.transitionDelay = Math.min(idx, 6) * 70 + 'ms';
    });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
    // Safety net: never leave content invisible.
    window.setTimeout(showAll, 4000);
  }

  /* ---------- News: show all ---------- */
  var newsList = document.getElementById('news-list');
  var newsMore = document.getElementById('news-more');
  if (newsList && newsMore) {
    var total = newsList.children.length;
    newsMore.textContent = 'Show all ' + total + ' updates ↓';
    newsMore.addEventListener('click', function () {
      var collapsed = newsList.classList.toggle('is-collapsed');
      newsMore.setAttribute('aria-expanded', String(!collapsed));
      newsMore.textContent = collapsed ? 'Show all ' + total + ' updates ↓' : 'Show fewer ↑';
      if (!collapsed) {
        newsList.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('is-in'); });
      }
    });
  }

  /* ---------- Live GitHub star counts (progressive enhancement) ---------- */
  // The API response is ~190 KB, so fetch it only when the section is close
  // and keep just the star counts in localStorage for 12 hours.
  var repoCards = document.querySelectorAll('[data-repo]');
  var STAR_KEY = 'gh-stars-v1', STAR_TTL = 12 * 3600 * 1000;
  var showStars = function (stars) {
    repoCards.forEach(function (card) {
      var n = stars[card.getAttribute('data-repo')];
      var slot = card.querySelector('.repo-stars');
      if (slot && n > 0) {
        slot.textContent = '★ ' + n;
        slot.hidden = false;
      }
    });
  };
  var loadStars = function () {
    try {
      var cached = JSON.parse(localStorage.getItem(STAR_KEY) || 'null');
      if (cached && Date.now() - cached.t < STAR_TTL) { showStars(cached.stars); return; }
    } catch (e) {}
    fetch('https://api.github.com/users/Optimizer077/repos?per_page=100')
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (repos) {
        if (!Array.isArray(repos)) return;
        var stars = {};
        repos.forEach(function (r) { stars[r.name] = r.stargazers_count; });
        try { localStorage.setItem(STAR_KEY, JSON.stringify({ t: Date.now(), stars: stars })); } catch (e) {}
        showStars(stars);
      })
      .catch(function () { /* offline or rate-limited: cards stay as they are */ });
  };
  if (repoCards.length && window.fetch) {
    var repoSection = repoCards[0].closest('section');
    if (repoSection && 'IntersectionObserver' in window) {
      var starObs = new IntersectionObserver(function (entries) {
        if (!entries[0].isIntersecting) return;
        starObs.disconnect();
        loadStars();
      }, { rootMargin: '600px 0px' });
      starObs.observe(repoSection);
    } else {
      loadStars();
    }
  }

  /* ---------- Figure lightbox: click a publication figure to see it large ---------- */
  var figButtons = document.querySelectorAll('.pub-thumb[data-full]');
  if (figButtons.length) {
    var lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.setAttribute('role', 'dialog');
    lb.setAttribute('aria-modal', 'true');
    lb.setAttribute('aria-label', 'Figure');
    lb.hidden = true;
    lb.innerHTML = '<figure><img alt="" /><figcaption></figcaption></figure>' +
                   '<button type="button" class="lightbox-close" aria-label="Close figure">Close</button>';
    document.body.appendChild(lb);
    var lbImg = lb.querySelector('img'), lbCap = lb.querySelector('figcaption'), lastFocus = null;
    var closeLb = function () {
      lb.classList.remove('is-open');
      window.setTimeout(function () { lb.hidden = true; lbImg.removeAttribute('src'); }, reduceMotion ? 0 : 220);
      if (lastFocus) lastFocus.focus();
    };
    figButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var fig = btn.closest('figure');
        var cap = fig && fig.querySelector('figcaption');
        lastFocus = btn;
        lbImg.src = btn.getAttribute('data-full');
        lbCap.textContent = cap ? cap.textContent : '';
        lb.hidden = false;
        void lb.offsetWidth;                      // let the open transition run
        lb.classList.add('is-open');
        lb.querySelector('.lightbox-close').focus();
      });
    });
    lb.addEventListener('click', function (e) { if (e.target === lb || e.target.classList.contains('lightbox-close')) closeLb(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !lb.hidden) closeLb(); });
  }

  /* ---------- Section headings: an ink underline draws itself when the heading arrives ---------- */
  var heads = document.querySelectorAll('.block-head');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    heads.forEach(function (h) { h.classList.add('is-drawn'); });
  } else {
    var headObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add('is-drawn'); headObs.unobserve(entry.target); }
      });
    }, { rootMargin: '0px 0px -20% 0px' });
    heads.forEach(function (h) { headObs.observe(h); });
  }

  /* ---------- News timeline: the line is drawn down as you read ---------- */
  var timeline = document.getElementById('news-list');
  if (timeline && !reduceMotion) {
    timeline.classList.add('is-drawing');
    var tlTick = 0;
    var tlUpdate = function () {
      tlTick = 0;
      var r = timeline.getBoundingClientRect();
      var p = (window.innerHeight * 0.75 - r.top) / Math.max(r.height, 1);
      timeline.style.setProperty('--p', Math.max(0, Math.min(1, p)).toFixed(3));
    };
    window.addEventListener('scroll', function () { if (!tlTick) tlTick = requestAnimationFrame(tlUpdate); }, { passive: true });
    window.addEventListener('resize', tlUpdate);
    tlUpdate();
  }

  /* ---------- Citations: copy a publication's BibTeX ---------- */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.cite-copy') : null;
    var pre = btn && btn.parentNode.querySelector('.bibtex');
    if (!pre) return;
    var label = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', label);
    var selectAll = function () {
      var r = document.createRange();
      r.selectNodeContents(pre);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    };
    var done = function (ok) {
      btn.textContent = ok ? 'Copied' : 'Selected: press Ctrl+C';
      window.setTimeout(function () { btn.textContent = label; }, 1800);
    };
    var legacy = function () {
      selectAll();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (err) {}
      done(ok);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(pre.textContent).then(function () { done(true); }, legacy);
    } else {
      legacy();
    }
  });

  /* ---------- Figure reveals ----------
     Each publication figure reveals itself in a way that matches its paper when it
     scrolls into view (and again on hover):
       pixel   (I-INR)      coarse to fine, like an INR fit at rising resolution
       scan    (Descanning) a yellowed, noisy, blurred scan is restored to clean
       sweep   (FCRN)       a detector sweeps across the frame
       denoise (KMBE)       noise is removed step by step */
  var BLOCKS = [32, 24, 16, 11, 8, 5, 3, 2];
  var STEPS = 16;

  function setupPixelThumb(img) {
    var box = img.parentElement;
    var mode = img.getAttribute('data-reveal') || 'pixel';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    box.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    var tiny = document.createElement('canvas');
    var tctx = tiny.getContext('2d');
    var hasFilter = typeof ctx.filter === 'string';
    var timer = 0;
    var paper = getComputedStyle(box).backgroundColor || '#faf6ee';

    function size() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(box.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(box.clientHeight * dpr));
    }

    // the figure drawn with object-fit: contain on the paper panel
    function drawFull(target, w, h, filter) {
      var s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
      var dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      target.fillStyle = paper;
      target.fillRect(0, 0, w, h);
      if (filter && hasFilter) target.filter = filter;
      target.globalCompositeOperation = 'multiply';
      target.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      target.globalCompositeOperation = 'source-over';
      if (hasFilter) target.filter = 'none';
    }

    function speckle(amount) {
      var n = Math.round(canvas.width * canvas.height * 0.06 * amount);
      for (var i = 0; i < n; i++) {
        var v = Math.random() < 0.5 ? 40 : 235;
        ctx.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',' + (0.35 + Math.random() * 0.4) + ')';
        ctx.fillRect(Math.random() * canvas.width, Math.random() * canvas.height, 1.5, 1.5);
      }
    }

    // p: 0 = fully degraded, 1 = clean
    function draw(p) {
      var W = canvas.width, H = canvas.height, q = 1 - p;
      if (mode === 'pixel') {
        var dpr = W / Math.max(box.clientWidth, 1);
        var block = BLOCKS[Math.min(BLOCKS.length - 1, Math.floor(p * BLOCKS.length))];
        var bsz = Math.max(1, Math.round(block * dpr));
        var tw = Math.max(1, Math.ceil(W / bsz)), th = Math.max(1, Math.ceil(H / bsz));
        tiny.width = tw; tiny.height = th;
        drawFull(tctx, tw, th);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tiny, 0, 0, tw, th, 0, 0, tw * bsz, th * bsz);
      } else if (mode === 'scan') {
        drawFull(ctx, W, H, 'blur(' + (q * 2.5).toFixed(2) + 'px) sepia(' + (q * 0.9).toFixed(2) + ') contrast(' + (1 - q * 0.35).toFixed(2) + ')');
        ctx.fillStyle = 'rgba(214, 186, 120,' + (q * 0.35).toFixed(3) + ')';   // paper yellowing
        ctx.fillRect(0, 0, W, H);
        speckle(q * 0.6);
      } else if (mode === 'sweep') {
        drawFull(ctx, W, H, 'grayscale(1) opacity(.35)');
        var x = Math.round(W * p);
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, x, H); ctx.clip();
        drawFull(ctx, W, H);
        ctx.restore();
        if (p < 1) {
          var accent = getComputedStyle(document.documentElement).getPropertyValue('--clr-accent').trim() || '#a1301f';
          ctx.fillStyle = accent;
          ctx.fillRect(x - 1, 0, 2, H);
        }
      } else {   // denoise
        drawFull(ctx, W, H);
        speckle(q * 1.4);
      }
    }

    function play() {
      window.clearTimeout(timer);
      size();
      canvas.classList.remove('is-done');
      var i = 0;
      (function step() {
        if (i > STEPS) { canvas.classList.add('is-done'); return; }
        var p = i / STEPS;
        draw(1 - Math.pow(1 - p, 2));       // ease out
        i++;
        timer = window.setTimeout(step, 70);
      })();
    }

    size();
    draw(0);

    if ('IntersectionObserver' in window) {
      var obs = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) {
          obs.disconnect();
          window.setTimeout(play, 250);
        }
      }, { threshold: 0.4 });
      obs.observe(box);
    } else {
      play();
    }

    var card = box.closest('.pub-card');
    if (card && window.matchMedia('(hover: hover)').matches) {
      card.addEventListener('mouseenter', play);
    }
  }

  if (!reduceMotion) {
    document.querySelectorAll('img[data-pixel]').forEach(function (img) {
      var start = function () {
        if (img.naturalWidth) setupPixelThumb(img);
      };
      if (img.complete) start();
      else img.addEventListener('load', start, { once: true });
    });
  }
})();
