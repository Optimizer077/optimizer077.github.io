/* A small retrieval step (RAG) for the Gemma chat.
   It reads the homepage's text into short passages and ranks them against a question with BM25: no model,
   no download, nothing sent anywhere. On the homepage the passages come from the live page, so the chat knows
   whatever the page says; on the other pages the homepage is fetched once and read the same way.
   assets/js/ali-facts.js adds a few facts the page does not state in one place.
   window.AliRAG.search(question, { prev, k }) -> [{ label, title, text, el, score, always, weak, links }]  (best first)
     weak: the question shares little with the page, so the passages may not answer it
     the array's .overview is true when the question had no topic ("tell me about Ali")
   window.AliRAG.ready resolves once the passages are indexed (at once on the homepage). */
(function () {
  'use strict';

  var PIECE_MAX = 520;             // characters per passage; longer blocks are split at sentence ends
  var SKIP = 'script, style, canvas, svg, math, pre, .bibtex, .pub-cite, .pub-links, .repo-links, .new-flag, .swipe-hint, ' +
             '.persona-grid, .dlm-demo, .tangent-demo, .drone-figure, .loop-figure, [aria-hidden="true"], [hidden]';

  // Where the passages come from: the section, the label shown as the source, the blocks that make one passage, and
  // words that describe the section without being on the page (they help matching, and never reach the prompt).
  var SOURCES = [
    { id: 'about',         label: 'About',         items: '.hero-bio p',                                 also: 'about biography background hobby interests free time enjoy' },
    { id: 'news',          label: 'News',          items: '.news-item',                                  also: 'news update announcement' },
    { id: 'learning',      label: 'Learning',      items: '.learn-card',                                 also: 'learning studying course class lectures' },
    { id: 'side-projects', label: 'Side projects', items: '.repo-card',                                  also: 'project github code tool open source' },
    { id: 'publications',  label: 'Publications',  items: '.pub-card',                                   also: 'paper published publication article journal conference' },
    { id: 'patents',       label: 'Patents',       items: '.pub-card',                                   also: 'patent invention intellectual property' },
    { id: 'projects',      label: 'Projects',      items: '.project-feature, .project-item',             also: 'project work research industry collaboration' },
    { id: 'honors',        label: 'Honors',        items: '.facts-grid .card',                           also: 'honors' },
    { id: 'off-the-clock', label: 'Off the clock', items: '.clock-note',                                 also: 'hobby free time travel' }
  ];

  var STOP = {}, TIME = {};
  ('a an the of to in on at for by with and or but is are was were be been am do does did has have had it its this that ' +
   'these those as into from before after than then so such not no can could should would will just also he she him his her they them ' +
   'their i me my you your we our us what which who whom whose when where why how there here very much many more most ' +
   'some any tell about please ali haider more else another again also then one ones second third former latter ' +
   'hi hello hey thanks thank sorry bother quick question curious wonder wondering actually really basically explain describe say know want moment ' +
   'ok okay').split(' ').forEach(function (w) { STOP[w] = 1; });
  // words about "now": they steer the question (see INTENTS) but are no use for matching on their own
  'now today currently current days day recent recently latest lately ongoing'.split(' ').forEach(function (w) { TIME[w] = 1; });

  // A question about "where he is from" never contains the word "Pakistan"; these add the words the answer uses.
  var INTENTS = [
    [/\b(from|born|nationalit\w*|citizen\w*|countr\w*|origin|korean|korea|pakistan\w*|hometown|live|lives|based)\b/i, 'nationality country origin pakistan korea'],
    [/\b(contact|email|e-mail|reach|mail|social|twitter|github|scholar)\b/i, 'contact email github scholar'],
    [/\b(paper|papers|publication\w*|publish\w*|article\w*|journal|aaai)\b/i, 'paper published journal aaai'],
    [/\b(conference\w*|attend\w*|travel\w*|trip|talk\w*|present\w*)\b/i, 'conference attending travel'],
    [/\bpatent\w*\b/i, 'patent'],
    [/\b(before|previous\w*|earlier|prior|past|career|history|experience)\b/i, 'previously research assistant career experience'],
    [/\b(currently|now|these days|today|recent\w*|latest|lately|ongoing)\b/i, 'currently ongoing research'],
    [/\b(advisor|adviser|supervis\w*|professor|mentor)\b/i, 'advisor professor supervisor'],
    [/\b(speak\w*|spoke\w*|english|urdu|ielts|fluen\w*|native|(which|what|spoken|foreign) languages?)\b/i, 'languages english urdu native fluent'],
    [/\b(award\w*|prize\w*|honou?r\w*|scholarship\w*|fellow\w*|won|win|winner|medal)\b/i, 'honors awards prize scholarship fellow'],
    [/\b(educat\w*|degree\w*|studied|study|university|college|school|bsc|phd)\b/i, 'education university degree'],
    [/\b(project\w*|built|build|made|app|tool|code|repo\w*)\b/i, 'project github'],
    [/\b(course\w*|learn\w*|class\w*|teach\w*|lecture\w*)\b/i, 'course learning'],
    [/\b(fun|hobb\w*|free time|spare time|leisure|pastime\w*|relax\w*|weekend\w*|outside (of )?(work|research))\b/i, 'hobby free time enjoy reading games travel build'],
    [/\b(equation\w*|formula\w*|objective\w*|loss)\b/i, 'key equation'],
    [/\bmath\w*\b/i, 'calculus'],
    [/\b(new|latest|recent\w*|lately|update\w*|announce\w*)\b/i, 'news update announcement'],
    [/\b(programm\w*|coding|software|framework\w*|librar\w*|stack|tools?|python|pytorch|tensorflow)\b/i, 'python pytorch numpy opencv jupyter cpython tensorflow'],
    [/\b(tutorial\w*|lesson\w*|notebook\w*)\b/i, 'course notebooks learning'],
    [/\b(startup\w*|compan\w*|employer\w*|industry)\b/i, 'collaboration startup acquired internship industry'],
    [/\b(co-?authors?|authors?|collaborators?)\b/i, 'authors collaboration']
  ];

  var EQUATION = /\b(equations?|formulas?|formulae|math|maths|mathematical|loss|objective|derivation|refine\w*)\b/i;   // asks for the equation itself
  var RECENT = /\b(new|latest|recent\w*|lately|update\w*)\b/i;                       // the news list is newest first
  var POINTS_BACK = /\b(it|its|that|those|they|them)\b/i;                            // "where was it published?"
  var LEAD = /^\s*(and|also|then|so|what about|how about)\b/i;                       // "and before that?"

  var chunks = null, df = {}, tdf = {}, avgLen = 1, newsN = 0;

  /* ---------------- text -> terms ---------------- */
  // Strip common endings, then keep five letters: "published", "publication" and "publish" meet at "publi",
  // "Pakistani" and "Pakistan" at "pakis". Crude, but the same on both sides, which is all matching needs.
  function fold(s) {                      // lower case without accents: "Télécom" -> "telecom"
    s = s.toLowerCase();
    return s.normalize ? s.normalize('NFD').replace(/[̀-ͯ]/g, '') : s;
  }
  function stem(w) {
    w = w.replace(/^([a-z]{3,})our(s|ed|ing)?$/, '$1or$2');                          // colour -> color
    if (w.length > 4 && /ies$/.test(w)) w = w.replace(/ies$/, 'y');                  // hobbies -> hobby
    else if (w.length > 4 && /ied$/.test(w)) w = w.replace(/ied$/, 'y');             // studied -> study
    else if (w.length > 4 && /(ses|xes|zes|ches|shes)$/.test(w)) w = w.slice(0, -2);  // classes -> class
    else if (w.length > 5 && /(ing|ed)$/.test(w)) w = w.replace(/(ing|ed)$/, '');   // but not "thing" or "need"
    else if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) w = w.slice(0, -1);     // drones -> drone, papers -> paper
    return w.slice(0, 5);
  }
  function terms(text, forQuery) {
    var out = [], parts = fold(text).replace(/ph\.?\s?d\b\.?/g, 'phd').replace(/[^a-z0-9]+/g, ' ').split(' ');   // "Ph.D." is one word
    for (var i = 0; i < parts.length; i++) {
      var w = parts[i];
      if (w.length < 2 || STOP[w] || (forQuery && TIME[w])) continue;
      out.push(stem(w));
    }
    return out;
  }

  /* ---------------- the page -> passages ---------------- */
  function plain(el) {
    var c = el.cloneNode(true), d = c.ownerDocument;
    c.querySelectorAll(SKIP).forEach(function (n) { n.remove(); });
    c.querySelectorAll('ol').forEach(function (ol) {                                 // keep the numbers of an ordered list
      [].forEach.call(ol.children, function (li, i) { li.insertBefore(d.createTextNode((i + 1) + ') '), li.firstChild); });
    });
    c.querySelectorAll('ul > li, ol > li').forEach(function (li) { li.appendChild(d.createTextNode('; ')); });
    c.querySelectorAll('li, p, div, span, h1, h2, h3, h4, figcaption, summary, time').forEach(function (n) {
      n.appendChild(d.createTextNode(' '));                                          // elements that touch in the markup must not glue words together
    });
    return c.textContent.replace(/\s+/g, ' ').replace(/\s+([,.;:)!?])/g, '$1').trim().replace(/[;,]$/, '.');
  }

  function pieces(text) {                 // split long text at sentence ends into passages of at most PIECE_MAX characters
    if (text.length <= PIECE_MAX + 80) return [text];
    var sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text], out = [], cur = '';
    sentences.forEach(function (s) {
      if (cur && (cur + s).length > PIECE_MAX) { out.push(cur.trim()); cur = ''; }
      cur += s;
    });
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  // A publication in reading order (the markup puts the figure caption first): venue, title, authors, venue line, note, caption.
  function paper(el) {
    var parts = ['.pub-venue-tag', '.pub-title', '.pub-authors', '.pub-venue', '.pub-note', '.pub-fig figcaption'].map(function (sel) {
      var n = el.querySelector(sel);
      return n ? (sel === '.pub-authors' ? 'Authors: ' : '') + plain(n) : '';
    }).filter(Boolean);
    return parts.length ? parts.join('. ').replace(/\.\.+/g, '.') : plain(el);
  }

  // One block of the page becomes one or more passages. o: label, title, text, el, hidden (matched, never shown),
  // always (the "who is Ali" fact), heading (the section's heading, for "side projects"-style questions),
  // extra (shown only when the question asks for it), links (anchors to show), needs (a regexp the question must match).
  var group = 0;                          // pieces of one block share a group, so an answer never repeats a block
  function add(list, o) {
    group++;
    var titleTerms = terms(o.title);
    var order = o.label === 'News' ? newsN++ : -1;
    pieces(o.text).forEach(function (p, i) {
      var c = { label: o.label, title: o.title, text: p, extra: i === 0 ? (o.extra || '') : '', links: i === 0 ? (o.links || []) : [],
                needs: o.needs ? new RegExp(o.needs, 'i') : null, el: o.el, always: !!o.always, group: group, order: order,
                tf: {}, titleTerms: titleTerms, len: 0, heading: o.heading || '' };
      var bump = function (t, n) { c.tf[t] = (c.tf[t] || 0) + n; c.len += n; };
      titleTerms.forEach(function (t) { bump(t, 2); });                // the title counts double
      terms(p).forEach(function (t) { bump(t, 1); });
      terms(o.hidden || '').forEach(function (t) { bump(t, 1); });
      c.len = c.len || 1;
      list.push(c);
    });
  }

  function harvest(doc) {
    var list = [];
    newsN = 0;
    SOURCES.forEach(function (src) {
      var sec = doc.getElementById(src.id);
      if (!sec) return;
      var h2 = sec.querySelector('h2'), hidden = src.also + ' ' + (h2 ? plain(h2) : '');
      sec.querySelectorAll(src.items).forEach(function (el) {
        var isPaper = el.classList.contains('pub-card');
        var text = isPaper ? paper(el) : plain(el);
        if (!text) return;
        var t = el.querySelector('.pub-title, .learn-title, .project-title strong, h3, time');
        var eq = [].map.call(el.querySelectorAll('.eq-row[aria-label]'), function (e) { return e.getAttribute('aria-label'); });
        var extra = eq.length ? 'Key equation: ' + eq.join(' ') : '';       // matched like the rest, but shown only when the question asks for it
        var links = isPaper ? [].map.call(el.querySelectorAll('.pub-links a'), function (a) {
          return { t: plain(a).replace(/[↗\s]+$/, ''), h: a.href };
        }).filter(function (l) { return l.t && /^https?:/.test(l.h); }) : [];
        add(list, { label: src.label, title: src.id === 'about' ? 'Bio' : (t ? plain(t) : ''), text: text, el: el,
                    hidden: hidden + ' ' + extra, extra: extra, links: links,
                    heading: h2 ? plain(h2).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim() : '' });
      });
    });

    var about = doc.getElementById('about');                            // who he is, and how to reach him
    if (about) {
      var head = [].map.call(about.querySelectorAll('.eyebrow, .hero-name, .hero-lede'), plain).join('. ');
      var links = [].map.call(about.querySelectorAll('.hero-links a'), function (a) {
        var h = a.getAttribute('href') || '';
        return plain(a).replace(/\s*[↗✉]\s*/g, '').trim() + ': ' + h.replace(/^mailto:/, '').replace(/^https?:\/\//, '');
      }).join('; ');
      add(list, { label: 'About', title: 'Introduction', text: head, el: about, hidden: SOURCES[0].also });
      if (links) add(list, { label: 'About', title: 'Contact', text: links + '.', el: about, hidden: 'contact profiles email reach github scholar twitter social' });
    }

    var tags = doc.querySelector('.marquee ul');                        // the research-interest line under the introduction
    if (tags) {
      var list2 = [].map.call(tags.querySelectorAll('li'), function (li) { return plain(li).replace(/[;.]$/, ''); }).join('; ');
      add(list, { label: 'About', title: 'Research interests', text: 'Research interests: ' + list2 + '.', el: doc.querySelector('.marquee'),
                  hidden: SOURCES[0].also + ' research topics areas' });
    }

    (window.ALI_FACTS || []).forEach(function (f) {
      add(list, { label: 'About', title: f.title, text: f.text, el: doc.getElementById(f.section || 'about'), hidden: SOURCES[0].also, always: f.always, needs: f.needs });
    });
    return list;
  }

  function build(doc) {                   // (re)index the passages of a document
    df = {}; tdf = {};
    chunks = harvest(doc);
    var total = 0;
    chunks.forEach(function (c) {
      total += c.len;
      Object.keys(c.tf).forEach(function (t) { df[t] = (df[t] || 0) + 1; });
      c.titleTerms.forEach(function (t) { tdf[t] = 1; });
    });
    avgLen = total / Math.max(1, chunks.length);
  }
  function index() { if (!chunks) build(document); }

  // The homepage is the corpus. On the homepage that is the live page (a source link can scroll to its passage); on the
  // other pages it is fetched once and read the same way (a source link then opens the homepage).
  var homeUrl = new URL('index.html', document.baseURI).href, loaded = false;
  var ready = new Promise(function (resolve) {
    function done() { loaded = true; resolve(); }
    if (document.getElementById('about')) { build(document); done(); return; }
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 8000);      // a stalled request must not keep the chat waiting
    fetch(homeUrl, ctl ? { signal: ctl.signal } : {}).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (html) {
      build(new DOMParser().parseFromString(html, 'text/html'));
    }).catch(function () {
      index();                                                            // offline: only the hand-written facts
    }).then(function () { clearTimeout(timer); done(); });
  });

  /* ---------------- ranking ---------------- */
  function idf(t) { return Math.log(1 + (chunks.length - (df[t] || 0) + 0.5) / ((df[t] || 0) + 0.5)); }

  // BM25 over the passage, plus a bonus when the question names words from its title.
  // `base` are the question's own words, `intent` the words implied by what is being asked; either lets a passage in.
  function score(q, c) {
    var k1 = 1.4, b = 0.6, s = 0, own = 0, t;
    var named = c.heading.indexOf(' ') > 0 && q.low.indexOf(c.heading) >= 0;      // e.g. "learning these days", "side projects"
    for (t in q.all) {
      var f = c.tf[t];
      if (!f) continue;
      var part = q.all[t] * idf(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * c.len / avgLen));
      s += part;
      if (q.base[t] || q.intent[t]) own += part;
    }
    c.titleTerms.forEach(function (t2) { if (q.base[t2]) s += 1.2 * idf(t2); });
    if (named && s > 0) { s += 3; own += 3; }
    if (q.recent && c.label === 'News' && s > 0) s += Math.max(0, 6 - c.order) * 0.6;
    return { s: s, own: own };
  }

  function head(text, max) {
    var cut = text.slice(0, max), end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
    return end > max * 0.5 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
  }
  // At most `max` characters of a passage. With the question's terms it keeps the sentences that mention them
  // (the equation, or the co-authors), not just the opening.
  function snippet(text, max, qTerms) {
    if (text.length <= max) return text;
    if (!qTerms || !qTerms.length) return head(text, max);
    var want = {}, sentences = text.match(/[^.!?;]+[.!?;]*\s*/g) || [text], best = 0, bestScore = 0;
    qTerms.forEach(function (t) { want[t] = 1; });
    var hits = sentences.map(function (s) { return terms(s).filter(function (t) { return want[t]; }).length; });
    for (var i = 0; i < sentences.length; i++) {
      var len = 0, sc = 0;
      for (var j = i; j < sentences.length && len + sentences[j].length <= max; j++) { len += sentences[j].length; sc += hits[j]; }
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    if (!best) return head(text, max);
    var out = '', k = best;
    while (k < sentences.length && (out + sentences[k]).length <= max) out += sentences[k++];
    return '… ' + (out || head(sentences[best], max)).trim();
  }

  function pack(c, s, q) {
    return { label: c.label, title: c.title, text: c.text + (q && q.eq && c.extra ? ' ' + c.extra : ''), el: c.el, score: s, always: c.always,
             weak: !!(q && q.weak), links: c.links, terms: q ? Object.keys(q.all) : [] };
  }

  function profile() {
    index();
    for (var i = 0; i < chunks.length; i++) if (chunks[i].always) return chunks[i];
    return null;
  }

  // question: the visitor's words; opts.prev: the question before it (used when this one points back at it);
  // opts.k: how many passages to return.
  function search(question, opts) {
    index();
    opts = opts || {};
    var k = opts.k || 4, text = String(question || '');
    var q = { base: {}, all: {}, intent: {}, low: fold(text).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' '),
              eq: EQUATION.test(text), recent: RECENT.test(text), weak: false };
    if (!/[a-z]/i.test(text)) return [];                                               // no letters (emoji, another script, "?"): nothing to match
    var inPage = function (t) { return df[t]; };
    var base = terms(text, true), hadWords = base.length > 0;
    var ownKnown = base.filter(inPage), known = ownKnown.slice();                      // a word found nowhere on the page cannot help

    // A question that points back ("what is it about?", "and before that?") keeps the topic of the one before it.
    // One that names a topic of its own ("Where is he from?", "and his patents?") does not.
    var follow = !!opts.prev && ((!hadWords && !/\b(ali|haider)\b/i.test(text)) || POINTS_BACK.test(text) || (LEAD.test(text) && !known.length));
    if (follow) known = known.concat(terms(opts.prev, true).filter(inPage));

    // The share of the question the page knows: with most words missing, or one stray word, the passages are a guess.
    var number = function (t) { return /^\d+$/.test(t); };
    var content = base.filter(function (t) { return !number(t); });
    if (content.length >= 4 && ownKnown.filter(function (t) { return !number(t); }).length / content.length < 0.34) q.weak = true;

    known.forEach(function (t) { q.base[t] = 1; q.all[t] = 1; });
    var trig = {};
    INTENTS.forEach(function (rule) {
      var m = text.match(rule[0]);
      if (!m) return;
      terms(rule[1]).forEach(function (t) { q.all[t] = Math.max(q.all[t] || 0, 0.5); q.intent[t] = 1; });
      terms(m[0], true).forEach(function (t) { trig[t] = 1; });
    });
    var hasIntent = Object.keys(q.intent).length > 0;
    if (base.length > 1 && base.length <= 3 && ownKnown.length === 1 && !hasIntent && !tdf[ownKnown[0]] && !follow) q.weak = true;

    var hasBase = known.length > 0;
    var share = base.length ? base.filter(function (t) { return trig[t]; }).length / base.length : 0;
    if (!hasBase && hasIntent && share >= 0.5) hasBase = true;                         // unknown words that say what is asked ("for fun")
    if (hadWords && !hasBase) return [];                                               // every content word is unknown here: off topic

    if (!Object.keys(q.all).length) {                                                  // "tell me about Ali": no content words at all
      var out0 = [];
      chunks.forEach(function (c) { if (out0.length < 3 && (c.always || c.title === 'Bio')) out0.push(pack(c, 1)); });
      out0.overview = true;
      return out0;
    }

    var scored = [];
    chunks.forEach(function (c) {
      if (c.needs && !c.needs.test(text)) return;                                      // a fact that only answers certain questions
      var r = score(q, c);
      if (r.s > 0 && (!hasBase || r.own > 0)) scored.push({ c: c, s: r.s });          // with words of its own, a passage must match one of them
    });
    scored.sort(function (a, b2) { return b2.s - a.s; });
    var best = scored.length ? scored[0].s : 0, out = [], seen = {};
    scored.forEach(function (r) {
      if (out.length < k && !seen[r.c.group] && r.s >= Math.max(1.0, best * 0.4)) {
        seen[r.c.group] = 1;
        out.push(pack(r.c, r.s, q));
      }
    });
    out.weak = q.weak;
    return out;
  }

  window.AliRAG = { search: search, snippet: snippet, size: function () { index(); return chunks.length; },
                    profile: function () { var p = profile(); return p && pack(p, 1); },
                    ready: ready, loaded: function () { return loaded; }, home: homeUrl };
})();
