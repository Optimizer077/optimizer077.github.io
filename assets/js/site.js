/* Shared site behaviour: mobile nav, theme toggle, scroll reveal,
   news "show all", live GitHub stars, and pixel-reveal thumbnails. */
(function () {
  'use strict';

  var root = document.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

  /* ---------- On-device Gemma chat: script loaded on first click ---------- */
  var gemmaBtn = document.getElementById('gemma-fab');
  if (gemmaBtn) {
    gemmaBtn.addEventListener('click', function () {
      if (window.GemmaChat) { window.GemmaChat.open(); return; }
      var label = gemmaBtn.querySelector('.ai-fab-label');
      label.textContent = 'Loading…';
      var sc = document.createElement('script');
      sc.src = 'assets/js/gemma-chat.js';
      sc.onload = function () { label.textContent = 'Ask Gemma'; window.GemmaChat.open(); };
      sc.onerror = function () { label.textContent = 'Ask Gemma'; };
      document.head.appendChild(sc);
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

  /* ---------- Pixel-reveal thumbnails ----------
     Each thumbnail starts as coarse pixel blocks and sharpens when it scrolls
     into view (and again on hover), like an INR fit at rising resolution. */
  var BLOCKS = [32, 24, 16, 11, 8, 5, 3, 2];

  function setupPixelThumb(img) {
    var box = img.parentElement;
    var canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    box.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    var tiny = document.createElement('canvas');
    var tctx = tiny.getContext('2d');
    var timer = 0;

    function size() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(box.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(box.clientHeight * dpr));
    }

    function draw(block) {
      var W = canvas.width, H = canvas.height;
      var dpr = W / Math.max(box.clientWidth, 1);
      var b = Math.max(1, Math.round(block * dpr));
      var tw = Math.max(1, Math.ceil(W / b)), th = Math.max(1, Math.ceil(H / b));
      tiny.width = tw;
      tiny.height = th;
      // object-fit: contain on a white panel, at low resolution
      var s = Math.min(tw / img.naturalWidth, th / img.naturalHeight);
      var dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      tctx.fillStyle = getComputedStyle(box).backgroundColor || '#f3f5fb';
      tctx.fillRect(0, 0, tw, th);
      tctx.globalCompositeOperation = 'multiply';   // match the CSS blend on the <img>
      tctx.drawImage(img, (tw - dw) / 2, (th - dh) / 2, dw, dh);
      tctx.globalCompositeOperation = 'source-over';
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tiny, 0, 0, tw, th, 0, 0, tw * b, th * b);
    }

    function play() {
      window.clearTimeout(timer);
      size();
      canvas.classList.remove('is-done');
      var i = 0;
      (function step() {
        if (i >= BLOCKS.length) { canvas.classList.add('is-done'); return; }
        draw(BLOCKS[i++]);
        timer = window.setTimeout(step, 85);
      })();
    }

    size();
    draw(BLOCKS[0]);

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
