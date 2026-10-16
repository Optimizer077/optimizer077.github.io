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
  var repoCards = document.querySelectorAll('[data-repo]');
  if (repoCards.length && window.fetch) {
    fetch('https://api.github.com/users/Optimizer077/repos?per_page=100')
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (repos) {
        if (!Array.isArray(repos)) return;
        var stars = {};
        repos.forEach(function (r) { stars[r.name] = r.stargazers_count; });
        repoCards.forEach(function (card) {
          var n = stars[card.getAttribute('data-repo')];
          var slot = card.querySelector('.repo-stars');
          if (slot && n > 0) {
            slot.textContent = '★ ' + n;
            slot.hidden = false;
          }
        });
      })
      .catch(function () { /* offline or rate-limited: cards stay as they are */ });
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
