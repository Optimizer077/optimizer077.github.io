/* Reading list: loads the Zotero CSV exports, merges duplicates, and renders a
   searchable, filterable list (topic, year, free text) with a year histogram
   and a "recently added" strip. Filter state lives in the URL hash. */
(function () {
  'use strict';

  var TOPICS = [
    { id: 'vln-vla',       file: 'Autonomous_Drive', label: 'VLN / VLA',     title: 'Vision-Language Navigation & Action' },
    { id: 'vlm',           file: 'vlm',              label: 'VLM',           title: 'Vision-Language & Multimodal Models' },
    { id: 'reasoning',     file: 'reasoning',        label: 'Reasoning',     title: 'Reasoning Models' },
    { id: 'token',         file: 'token',            label: 'Token Reduction', title: 'Token Reduction & Compression' },
    { id: 'diffusion',     file: 'diffusion',        label: 'Diffusion',     title: 'Diffusion Models' },
    { id: 'inr',           file: 'inr',              label: 'INR',           title: 'Implicit Neural Representations' },
    { id: 'retrieval',     file: 'retrieval',        label: 'Retrieval',     title: 'Instance Retrieval' },
    { id: 'mri',           file: 'mri',              label: 'MRI',           title: 'MRI & Medical Imaging' },
    { id: 'hyperspectral', file: 'hyperspectral',    label: 'Hyperspectral', title: 'Hyperspectral Imaging' },
    { id: 'misc',          file: 'misc',             label: 'Others',        title: 'Other Interesting Papers' }
  ];
  var TOPIC_BY_ID = {};
  TOPICS.forEach(function (t, i) { t.index = i; TOPIC_BY_ID[t.id] = t; });

  var PAGE = 8;             // rows shown per topic before "show all"
  var NEW_DAYS = 30;
  var OLDEST_BAR = 2019;    // earlier years share one "older" bar
  var TYPE_LABEL = {
    journalArticle: 'journal', conferencePaper: 'conference', computerProgram: 'code',
    webpage: 'web', bookSection: 'book chapter', thesis: 'thesis'
  };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    q: $('rl-q'), sort: $('rl-sort'), topics: $('rl-topics'), bars: $('rl-bars'),
    summary: $('rl-summary'), sections: $('rl-sections'), loading: $('rl-loading'),
    empty: $('rl-empty'), clear: $('rl-clear'), recent: $('rl-recent'), recentList: $('rl-recent-list'),
    stPapers: $('st-papers'), stTopics: $('st-topics'), stRecent: $('st-recent'), stSync: $('st-sync')
  };
  if (!els.sections) return;

  var papers = [];
  var lastSync = '';
  var state = { q: '', topic: 'all', year: '', sort: 'year' };
  var expanded = {};

  /* ---------- CSV ---------- */
  function parseCSV(text) {
    var rows = [], row = [], field = '', i = 0, inQ = false;
    while (i < text.length) {
      var ch = text[i];
      if (inQ) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
        if (ch === '"') { inQ = false; i++; continue; }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQ = true; i++; continue; }
      if (ch === ',') { row.push(field); field = ''; i++; continue; }
      if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = ''; i++; continue;
      }
      field += ch; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function toObjects(rows) {
    if (!rows.length) return [];
    var head = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    return rows.slice(1).map(function (r) {
      var o = {};
      head.forEach(function (h, i) { o[h] = (r[i] || '').trim(); });
      return o;
    });
  }

  /* ---------- Normalisation ---------- */
  function parseAuthors(s) {
    if (!s) return [];
    return s.split(';').map(function (a) {
      a = a.trim();
      if (!a) return null;
      if (a.indexOf(',') !== -1) {
        var parts = a.split(',');
        return { last: parts[0].trim(), first: parts.slice(1).join(',').trim() };
      }
      var bits = a.split(' ');
      return { last: bits.pop(), first: bits.join(' ') };
    }).filter(Boolean);
  }

  function authorLine(list) {
    if (!list.length) return 'Unknown authors';
    var names = list.slice(0, 3).map(function (a) { return a.last; });
    if (list.length > 3) return names.join(', ') + ' et al.';
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
  }

  function arxivId(url, doi) {
    var m = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i.exec(url || '') ||
            /arxiv\.(\d{4}\.\d{4,5})/i.exec(doi || '');
    return m ? m[1] : '';
  }

  function hostOf(url) {
    var m = /^https?:\/\/(?:www\.)?([^/]+)/i.exec(url || '');
    return m ? m[1] : '';
  }

  function normalise(raw, topic) {
    var title = raw.title;
    var doi = raw.doi;
    var url = raw.url || (doi ? 'https://doi.org/' + doi : '');
    if (!title || !url) return null;
    var ax = arxivId(url, doi);
    var year = raw['publication year'] || (ax ? '20' + ax.slice(0, 2) : '');
    var authors = parseAuthors(raw.author);
    var venue = raw['publication title'] || raw['conference name'] || '';
    return {
      title: title,
      url: url,
      doi: doi,
      arxiv: ax,
      year: year,
      added: raw['date added'] || '',
      type: raw['item type'] || '',
      venue: venue,
      host: hostOf(url),
      authors: authors,
      authorLine: authorLine(authors),
      mine: authors.some(function (a) { return /^haider$/i.test(a.last) && /^ali/i.test(a.first); }),
      topics: [topic.id],
      key: ax || url.toLowerCase() || title.toLowerCase(),
      hay: [title, venue, ax, year, doi, authors.map(function (a) { return a.first + ' ' + a.last; }).join(' ')]
        .join(' ').toLowerCase()
    };
  }

  /* ---------- Load ---------- */
  function load() {
    return Promise.all(TOPICS.map(function (t) {
      return fetch(t.file + '.csv')
        .then(function (r) { return r.ok ? r.text() : ''; })
        .catch(function () { return ''; })
        .then(function (text) { return { topic: t, rows: text ? toObjects(parseCSV(text.trim())) : [] }; });
    })).then(function (results) {
      var byKey = {};
      results.forEach(function (res) {        // fixed topic order => deterministic merge
        res.rows.forEach(function (raw) {
          var p = normalise(raw, res.topic);
          if (!p) return;
          var titleKey = 't:' + p.title.toLowerCase().replace(/\W+/g, ' ').trim();
          var existing = byKey[p.key] || byKey[titleKey];
          if (existing) {
            if (existing.topics.indexOf(res.topic.id) === -1) existing.topics.push(res.topic.id);
            if (!existing.added) existing.added = p.added;
            return;
          }
          byKey[p.key] = p;
          byKey[titleKey] = p;
          papers.push(p);
        });
      });
      papers.forEach(function (p) { if (p.added > lastSync) lastSync = p.added; });
    });
  }

  /* ---------- Helpers ---------- */
  function daysBetween(a, b) {
    return (Date.parse(b) - Date.parse(a)) / 86400000;
  }
  function isNew(p) { return p.added && lastSync && daysBetween(p.added, lastSync) <= NEW_DAYS; }
  function fmtDate(iso) {
    var d = iso.split('-');
    return d.length === 3 ? parseInt(d[2], 10) + ' ' + MONTHS[parseInt(d[1], 10) - 1] + ' ' + d[0] : iso;
  }
  function yearBucket(p) {
    var y = parseInt(p.year, 10);
    if (!y) return 'n/a';
    return y < OLDEST_BAR ? 'older' : String(y);
  }
  function terms() {
    return state.q.toLowerCase().split(/\s+/).filter(Boolean);
  }
  function matches(p, opts) {
    opts = opts || {};
    if (!opts.ignoreTopic && state.topic !== 'all' && p.topics[0] !== state.topic) return false;
    if (!opts.ignoreYear && state.year && yearBucket(p) !== state.year) return false;
    var t = terms();
    for (var i = 0; i < t.length; i++) if (p.hay.indexOf(t[i]) === -1) return false;
    return true;
  }
  function sorter(a, b) {
    if (state.sort === 'title') return a.title.localeCompare(b.title);
    if (state.sort === 'added') return (b.added || '').localeCompare(a.added || '') || (b.year || '').localeCompare(a.year || '');
    return (b.year || '0').localeCompare(a.year || '0') || (b.added || '').localeCompare(a.added || '');
  }
  function filtersActive() { return !!(state.q || state.year || state.topic !== 'all'); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /* Insert text with search terms wrapped in <mark>, without using innerHTML. */
  function highlight(node, text, t) {
    if (!t.length) { node.textContent = text; return; }
    var re = new RegExp('(' + t.map(function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')', 'ig');
    var last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) node.appendChild(document.createTextNode(text.slice(last, m.index)));
      node.appendChild(el('mark', null, m[0]));
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
  }

  function extLink(href, label, cls) {
    var a = el('a', cls, label);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  /* ---------- Rendering ---------- */
  function paperRow(p, t) {
    var li = el('li', 'rl-paper' + (p.mine ? ' is-mine' : ''));
    li.appendChild(el('span', 'rl-year', p.year || '—'));

    var body = el('div', 'rl-body');
    var a = extLink(p.url, '', 'rl-title');
    highlight(a, p.title, t);
    body.appendChild(a);

    var meta = el('p', 'rl-meta');
    var au = el('span', 'rl-authors');
    au.title = p.authors.map(function (x) { return (x.first + ' ' + x.last).trim(); }).join(', ');
    highlight(au, p.authorLine, t);
    meta.appendChild(au);
    var where = p.venue || (p.arxiv ? 'arXiv ' + p.arxiv : p.host);
    if (where) {
      meta.appendChild(el('span', 'rl-sep', '·'));
      var w = el('span', 'rl-venue');
      highlight(w, where, t);
      meta.appendChild(w);
    }
    if (TYPE_LABEL[p.type]) meta.appendChild(el('span', 'rl-chip', TYPE_LABEL[p.type]));
    if (p.mine) meta.appendChild(el('span', 'rl-chip is-mine', '★ my paper'));
    if (isNew(p)) meta.appendChild(el('span', 'rl-chip is-new', 'new'));
    p.topics.slice(1).forEach(function (id) {
      meta.appendChild(el('span', 'rl-chip is-also', 'also in ' + TOPIC_BY_ID[id].label));
    });
    body.appendChild(meta);
    li.appendChild(body);

    var links = el('div', 'rl-links');
    if (p.arxiv) {
      links.appendChild(extLink('https://arxiv.org/abs/' + p.arxiv, 'abs'));
      links.appendChild(extLink('https://arxiv.org/pdf/' + p.arxiv, 'pdf'));
    } else {
      links.appendChild(extLink(p.url, 'link'));
    }
    if (p.doi && !p.arxiv) links.appendChild(extLink('https://doi.org/' + p.doi, 'doi'));
    li.appendChild(links);
    return li;
  }

  function renderTopics() {
    var counts = { all: 0 };
    papers.forEach(function (p) {
      if (!matches(p, { ignoreTopic: true })) return;
      counts.all++;
      counts[p.topics[0]] = (counts[p.topics[0]] || 0) + 1;
    });
    els.topics.innerHTML = '';
    var mk = function (id, label) {
      var b = el('button', 'rl-topic' + (state.topic === id ? ' is-active' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(state.topic === id));
      b.appendChild(document.createTextNode(label + ' '));
      b.appendChild(el('span', 'rl-count', String(counts[id] || 0)));
      if (!counts[id] && state.topic !== id) b.disabled = true;
      b.addEventListener('click', function () {
        state.topic = state.topic === id && id !== 'all' ? 'all' : id;
        update(true);
      });
      els.topics.appendChild(b);
    };
    mk('all', 'All');
    TOPICS.forEach(function (t) { mk(t.id, t.label); });
  }

  function renderBars() {
    var counts = {}, maxY = OLDEST_BAR;
    papers.forEach(function (p) {
      var y = parseInt(p.year, 10);
      if (y > maxY) maxY = y;
      if (!matches(p, { ignoreYear: true })) return;
      var bkt = yearBucket(p);
      counts[bkt] = (counts[bkt] || 0) + 1;
    });
    var keys = ['older'];
    for (var y = OLDEST_BAR; y <= maxY; y++) keys.push(String(y));
    var peak = Math.max.apply(null, keys.map(function (k) { return counts[k] || 0; }).concat([1]));
    els.bars.innerHTML = '';
    keys.forEach(function (k) {
      var n = counts[k] || 0;
      var b = el('button', 'rl-bar' + (state.year === k ? ' is-active' : '') + (state.year && state.year !== k ? ' is-dim' : ''));
      b.type = 'button';
      b.title = (k === 'older' ? 'Before ' + OLDEST_BAR : k) + ': ' + n + ' paper' + (n === 1 ? '' : 's');
      b.setAttribute('aria-pressed', String(state.year === k));
      b.setAttribute('aria-label', b.title);
      var fill = el('span', 'rl-bar-fill');
      fill.style.setProperty('--h', (n / peak * 100).toFixed(1) + '%');
      b.appendChild(el('span', 'rl-bar-n', n ? String(n) : ''));
      b.appendChild(fill);
      b.appendChild(el('span', 'rl-bar-y', k === 'older' ? '<' + String(OLDEST_BAR).slice(2) : "'" + k.slice(2)));
      if (!n && state.year !== k) b.disabled = true;
      b.addEventListener('click', function () {
        state.year = state.year === k ? '' : k;
        update(true);
      });
      els.bars.appendChild(b);
    });
  }

  function renderRecent() {
    var show = !filtersActive() && lastSync;
    els.recent.hidden = !show;
    if (!show) return;
    var list = papers.filter(function (p) { return p.added; })
      .sort(function (a, b) { return b.added.localeCompare(a.added) || (b.year || '').localeCompare(a.year || ''); })
      .slice(0, 6);
    els.recentList.innerHTML = '';
    list.forEach(function (p) {
      var li = el('li', 'rl-recent-card');
      var top = el('p', 'rl-recent-top');
      top.appendChild(el('span', 'rl-recent-topic', TOPIC_BY_ID[p.topics[0]].label));
      top.appendChild(el('span', null, 'added ' + fmtDate(p.added)));
      li.appendChild(top);
      li.appendChild(extLink(p.url, p.title, 'rl-recent-title'));
      li.appendChild(el('p', 'rl-recent-meta', p.authorLine + (p.year ? ' · ' + p.year : '')));
      els.recentList.appendChild(li);
    });
  }

  function renderSections() {
    var t = terms();
    var active = filtersActive();
    var total = 0;
    var frag = document.createDocumentFragment();

    TOPICS.forEach(function (topic) {
      if (state.topic !== 'all' && state.topic !== topic.id) return;
      var list = papers.filter(function (p) { return p.topics[0] === topic.id && matches(p); }).sort(sorter);
      if (!list.length) return;
      total += list.length;

      var sec = el('section', 'rl-section');
      sec.id = topic.id;
      var head = el('div', 'rl-section-head');
      var h2 = el('h2', 'rl-h2', topic.title);
      head.appendChild(h2);
      head.appendChild(el('span', 'rl-section-count', list.length + (list.length === 1 ? ' paper' : ' papers')));
      sec.appendChild(head);

      var open = active || expanded[topic.id] || list.length <= PAGE + 2;
      var ol = el('ol', 'rl-list');
      (open ? list : list.slice(0, PAGE)).forEach(function (p) { ol.appendChild(paperRow(p, t)); });
      sec.appendChild(ol);

      if (list.length > PAGE + 2 && !active) {
        var more = el('button', 'btn rl-more', open ? 'Show fewer ↑' : 'Show all ' + list.length + ' ↓');
        more.type = 'button';
        more.addEventListener('click', function () {
          expanded[topic.id] = !expanded[topic.id];
          renderSections();
          if (!expanded[topic.id]) sec.scrollIntoView({ block: 'start' });
        });
        sec.appendChild(more);
      }
      frag.appendChild(sec);
    });

    els.sections.innerHTML = '';
    els.sections.appendChild(frag);
    els.empty.hidden = total > 0;
    return total;
  }

  function renderSummary(total) {
    els.summary.innerHTML = '';
    els.summary.appendChild(el('span', null, filtersActive()
      ? 'Showing ' + total + ' of ' + papers.length + ' papers'
      : papers.length + ' papers'));
    var chip = function (label, onClear) {
      var b = el('button', 'rl-filter-chip', label + ' ×');
      b.type = 'button';
      b.setAttribute('aria-label', 'Remove filter ' + label);
      b.addEventListener('click', function () { onClear(); update(true); });
      els.summary.appendChild(b);
    };
    if (state.q) chip('“' + state.q + '”', function () { state.q = ''; els.q.value = ''; });
    if (state.topic !== 'all') chip(TOPIC_BY_ID[state.topic].label, function () { state.topic = 'all'; });
    if (state.year) chip(state.year === 'older' ? 'before ' + OLDEST_BAR : state.year, function () { state.year = ''; });
  }

  function renderStats() {
    var topicsUsed = {};
    papers.forEach(function (p) { topicsUsed[p.topics[0]] = 1; });
    els.stPapers.textContent = String(papers.length);
    els.stTopics.textContent = String(Object.keys(topicsUsed).length);
    els.stRecent.textContent = String(papers.filter(isNew).length);
    els.stSync.textContent = lastSync ? fmtDate(lastSync) : '—';
  }

  /* ---------- State <-> URL hash ---------- */
  function readHash() {
    var h = window.location.hash.replace(/^#/, '');
    if (!h) return;
    if (TOPIC_BY_ID[h]) { state.topic = h; return; }       // old-style #inr anchors
    h.split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i === -1) return;
      var k = kv.slice(0, i), v = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
      if (k === 'q') state.q = v;
      if (k === 'topic' && TOPIC_BY_ID[v]) state.topic = v;
      if (k === 'year') state.year = v;
      if (k === 'sort' && /^(year|added|title)$/.test(v)) state.sort = v;
    });
  }
  function writeHash() {
    var parts = [];
    if (state.q) parts.push('q=' + encodeURIComponent(state.q));
    if (state.topic !== 'all') parts.push('topic=' + state.topic);
    if (state.year) parts.push('year=' + state.year);
    if (state.sort !== 'year') parts.push('sort=' + state.sort);
    var h = parts.length ? '#' + parts.join('&') : '';
    if (h !== window.location.hash) history.replaceState(null, '', h || window.location.pathname);
  }

  function update(push) {
    renderTopics();
    renderBars();
    renderRecent();
    var total = renderSections();
    renderSummary(total);
    if (push) writeHash();
  }

  /* ---------- Events ---------- */
  var debounce = 0;
  els.q.addEventListener('input', function () {
    clearTimeout(debounce);
    debounce = setTimeout(function () { state.q = els.q.value.trim(); update(true); }, 90);
  });
  els.q.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { els.q.value = ''; state.q = ''; update(true); els.q.blur(); }
  });
  els.sort.addEventListener('change', function () { state.sort = els.sort.value; update(true); });
  els.clear.addEventListener('click', function () {
    state = { q: '', topic: 'all', year: '', sort: state.sort };
    els.q.value = '';
    update(true);
  });
  document.addEventListener('keydown', function (e) {
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) {
      e.preventDefault();
      els.q.focus();
    }
  });

  window.addEventListener('hashchange', function () {
    state = { q: '', topic: 'all', year: '', sort: 'year' };
    readHash();
    els.q.value = state.q;
    els.sort.value = state.sort;
    if (papers.length) update(false);
  });

  /* ---------- Go ---------- */
  readHash();
  els.q.value = state.q;
  els.sort.value = state.sort;
  load().then(function () {
    renderStats();
    update(false);
  }).catch(function () {
    els.sections.innerHTML = '';
    els.sections.appendChild(el('p', 'rl-loading', 'Could not load the reading list. If you opened the file directly, serve the folder over HTTP.'));
  });
})();
