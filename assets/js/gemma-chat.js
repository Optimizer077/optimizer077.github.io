/* On-device chat with Gemma 4 E2B (LiteRT / MediaPipe LLM Inference, WebGPU).
   - Model: litert-community/gemma-4-E2B-it-litert-lm, web build (.task, ~2.0 GB, Apache-2.0),
     downloaded from Hugging Face only after the visitor confirms, then kept in the Origin Private File System.
   - Everything runs in the visitor's browser on their GPU; no prompt leaves the device.
   - Answers are grounded in this site (RAG): gemma-rag.js finds the passages of the page that match the question and the
     prompt carries them. Before the model is loaded, or on a device that cannot run it, the same passages are shown directly.
   Loaded on demand together with ali-facts.js and gemma-rag.js; exposes window.GemmaChat.open(). */
(function () {
  'use strict';

  var MODEL_URL = 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.task';
  var MODEL_PAGE = 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm';
  var MODEL_BYTES = 2003697664;
  var GENAI = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@0.10.29';
  var MAX_TOKENS = 2048;           // prompt + reply budget
  var PROMPT_BUDGET = 1300;        // keep history under this many tokens

  var SYSTEM = [
    "You are the assistant on Ali Haider's personal website. You run on the visitor's own GPU inside their browser,",
    'so nothing they type leaves their device.',
    'Answer from the numbered passages in the user message and from nothing else, and do not mention the numbers.',
    'If the passages do not contain the answer, say you do not know and name the section of the site that is closest.',
    'Ali is from Pakistan and is not Korean.',
    'Write one to four short sentences of plain text, without markdown or lists unless asked.'
  ].join(' ');

  var api = { open: open, toggle: toggle };
  window.GemmaChat = api;

  var panel, els = {}, llm = null, busy = false, history = [], loading = false, lastQuestion = '';
  var epoch = 0;                   // bumped when the panel is closed: a reply or a load still in flight then belongs to a panel that is gone
  var abortCtl = null;             // stops the model download when the panel is closed
  var initializing = false;        // a model start (download, then GPU set-up) still running, even if its panel was closed

  /* ---------- helpers ---------- */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function gb(n) { return (n / 1e9).toFixed(2) + ' GB'; }

  function clean(text) {
    return text
      .replace(/<\|channel>[\s\S]*?<channel\|>/g, '')   // drop any thinking channel
      .replace(/<\|?turn\|?>(model|user)?/g, '')
      .replace(/<\|?[a-z_]+\|?>/g, '')
      .replace(/^\s+/, '');
  }

  // The user turn carries the retrieved passages (fresh for every question); the history keeps only the plain questions and answers.
  function userTurn(text, hits, weak) {
    if (!hits || !hits.length) return text;
    var lines = hits.map(function (h, i) {
      return '[' + (i + 1) + '] (' + h.label + (h.title && !h.always ? ', ' + short(h.title, 50) : '') + ') ' + window.AliRAG.snippet(h.text, 440, h.terms);
    });
    return (weak ? 'Passages (they may not answer the question):\n' : 'Passages:\n') + lines.join('\n') + '\n\nQuestion: ' + text;
  }

  // Returns { prompt, used }: the prompt text, and the passages that fit in the context window.
  function buildPrompt(userText, hits) {
    var keep = (hits || []).slice(), turns = history.slice(), weak = !!(hits && hits.weak);
    var render = function () {
      var s = '<|turn>system\n' + SYSTEM + '<turn|>\n';
      turns.forEach(function (t) { s += '<|turn>' + t.role + '\n' + t.text + '<turn|>\n'; });
      return s + '<|turn>user\n' + userTurn(userText, keep, weak) + '<turn|>\n<|turn>model\n';
    };
    var prompt = render();
    // too long for the context window: drop the weakest passage, then the oldest exchange, then one more passage
    while (llm && (llm.sizeInTokens(prompt) || 0) > PROMPT_BUDGET) {
      if (keep.length > 2) keep.pop();
      else if (turns.length >= 2) turns = turns.slice(2);
      else if (keep.length > 1) keep.pop();
      else break;
      prompt = render();
    }
    return { prompt: prompt, used: keep };
  }

  // Passages for a question; the "who Ali is" fact always leads, so the model never has to guess his background.
  function retrieve(text, k) {
    if (!window.AliRAG) return [];
    var hits = window.AliRAG.search(text, { prev: lastQuestion, k: k || 4 });
    var who = window.AliRAG.profile();
    if (who && !hits.some(function (h) { return h.always; })) hits.unshift({ label: who.label, title: who.title, text: who.text, el: who.el, always: true });
    return hits;
  }

  /* ---------- device checks ---------- */
  function isPhone() {
    var coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;        // a touch screen is the main input
    return coarse || Math.min(screen.width, screen.height) < 700 || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  }
  // Warnings shown before anything is downloaded. Hints come from the browser where available.
  function deviceWarnings(cached) {
    var out = [];
    var conn = navigator.connection || {};
    var ram = navigator.deviceMemory;                 // GB, rounded; Chrome/Edge/Android only
    if (isPhone()) {
      out.push('You seem to be on a phone or tablet. This runs a 2 GB language model (LiteRT) on your device: ' +
               'it is heavy on battery and memory, and the tab may crash on phones with little RAM.');
    }
    if (!cached && (conn.saveData || /(^|-)2g|3g/.test(conn.effectiveType || '') || conn.type === 'cellular')) {
      out.push('Your connection looks metered or slow. The download is ' + gb(MODEL_BYTES) + ' — use Wi-Fi if you can.');
    } else if (!cached && isPhone()) {
      out.push('The download is ' + gb(MODEL_BYTES) + ' — use Wi-Fi rather than mobile data.');
    }
    if (ram && ram < 6) {
      out.push('This device reports about ' + ram + ' GB of RAM; the model needs roughly 2 GB free, so it may fail to load.');
    }
    return out;
  }

  /* ---------- UI ---------- */
  function buildPanel() {
    panel = el('div', 'gemma-panel');
    panel.id = 'gemma-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Ask about Ali');
    panel.tabIndex = -1;                                              // a place for focus to land when the panel opens
    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); hide(true); return; }
      if (e.key !== 'Tab' || window.innerWidth > 600) return;         // on a phone the panel fills the screen: keep Tab inside it
      var f = panel.querySelectorAll('a[href], button:not([disabled]), textarea:not([disabled]), [tabindex="0"]');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    var fab = document.getElementById('gemma-fab');
    if (fab) fab.setAttribute('aria-controls', 'gemma-panel');

    var head = el('div', 'gemma-head');
    var title = el('div', 'gemma-title');
    title.appendChild(el('b', null, 'Ask about Ali'));
    els.sub = el('span', 'gemma-sub', 'answers from this site · optional on-device Gemma 4');
    title.appendChild(els.sub);
    head.appendChild(title);
    var close = el('button', 'gemma-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', function () { if (llm || loading || initializing) shutdown(); else hide(true); });   // the model is only unloaded when there is one
    els.close = close;
    head.appendChild(close);
    panel.appendChild(head);

    els.body = el('div', 'gemma-body');
    els.body.setAttribute('role', 'log');                             // new answers are announced; tabindex lets keyboard users scroll it
    els.body.setAttribute('aria-label', 'Conversation');
    els.body.tabIndex = 0;
    panel.appendChild(els.body);

    els.status = el('p', 'gemma-status');
    els.status.setAttribute('role', 'status');
    panel.appendChild(els.status);

    var form = el('form', 'gemma-form');
    els.input = el('textarea');
    els.input.rows = 1;
    els.input.maxLength = 600;                                        // a pasted wall of text would not fit the model's context
    els.input.setAttribute('aria-label', 'Your question about Ali');
    els.input.placeholder = 'Ask about Ali';
    els.input.addEventListener('input', function () {                 // grows with a longer question, up to a few lines
      els.input.style.height = 'auto';
      els.input.style.height = Math.min(els.input.scrollHeight + 2, 120) + 'px';
    });
    els.send = el('button', 'btn btn-primary', 'Send');
    els.send.type = 'submit';
    form.appendChild(els.input);
    form.appendChild(els.send);
    form.addEventListener('submit', function (e) { e.preventDefault(); send(); });
    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    panel.appendChild(form);
    els.form = form;
    document.body.appendChild(panel);
  }

  function setStatus(t) { if (els.status) els.status.textContent = t; }       // the panel may have been closed while a stream was still running

  // The first thing in the panel: run Gemma. Until it is loaded, the box answers from the page text.
  function intro(cached, gpuOk, gpuNote) {
    if (els.intro) els.intro.remove();                                // replaced in place: messages typed meanwhile stay
    var box = el('div', 'gemma-intro');
    els.intro = box;
    var more = box;
    more.appendChild(el('p', null, 'Run Google’s Gemma 4 E2B language model directly in this tab, on your own GPU. ' +
      'It reads ' + where() + ' before it answers, and nothing you type leaves your device.'));
    var ul = el('ul');
    [
      cached ? 'Model already saved on this device — loads from disk in seconds.' :
        'One-time download: ' + gb(MODEL_BYTES) + ' from Hugging Face (Apache-2.0), saved on this device for next time.',
      'Needs WebGPU and about 2 GB of free GPU memory. Desktop Chrome or Edge works best.',
      'Text only. It can be wrong — it is a small model.'
    ].forEach(function (t) { ul.appendChild(el('li', null, t)); });
    more.appendChild(ul);
    if (!gpuOk) more.appendChild(el('p', 'gemma-warn', gpuNote));
    deviceWarnings(cached).forEach(function (w) { more.appendChild(el('p', 'gemma-warn', w)); });
    var row = el('div', 'gemma-actions');
    var go = el('button', 'btn btn-primary', cached ? 'Load Gemma' : (isPhone() ? 'I understand — download ' : 'Download & run (') + gb(MODEL_BYTES) + (isPhone() ? '' : ')'));
    go.type = 'button';
    go.disabled = !gpuOk;
    go.addEventListener('click', function () { load(); });
    var src = el('a', 'btn', 'Model card ↗');
    src.href = MODEL_PAGE; src.target = '_blank'; src.rel = 'noopener noreferrer';
    row.appendChild(go); row.appendChild(src);
    if (cached) {
      var del = el('button', 'btn', 'Delete downloaded model');
      del.type = 'button';
      del.addEventListener('click', function () {
        deleteSaved().then(function () { intro(false, gpuOk, gpuNote); setStatus('Deleted — 2 GB freed.'); });
      });
      row.appendChild(del);
    }
    more.appendChild(row);
    box.appendChild(el('p', 'gemma-lead', 'Before the model is loaded, the box below answers from the text of ' + where() + '.'));
    els.body.insertBefore(box, els.body.firstChild);
    setStatus('');
  }

  // "From: Publications · News": links that scroll to the passage on the page and mark it for a moment.
  // From another page they open the homepage section in a new tab, so the chat stays where it is.
  function sources(hits) {
    var row = el('div', 'gemma-sources'), seen = {}, n = 0;
    var real = hits.filter(function (h) { return !h.always && h.el; });
    (real.length ? real : hits.filter(function (h) { return h.el; })).forEach(function (h) {
      if (seen[h.label] || n >= 3) return;
      seen[h.label] = 1; n++;
      var sec = h.el.closest ? h.el.closest('section[id]') : null;
      var a = el('a', 'gemma-src', h.label);
      var away = h.el.ownerDocument !== document;                     // a passage of the homepage, read from another page
      a.href = (away ? window.AliRAG.home : '') + '#' + (sec ? sec.id : 'about');
      if (away) { a.target = '_blank'; a.rel = 'noopener'; }
      else a.addEventListener('click', function (e) { e.preventDefault(); showOnPage(h.el); });
      row.appendChild(a);
    });
    if (!row.children.length) return null;
    row.insertBefore(document.createTextNode('From: '), row.firstChild);
    return row;
  }

  // Scroll to a passage of this page and mark it; the mark fades once the scroll has arrived.
  function showOnPage(target) {
    if (!target.getClientRects().length) {                            // collapsed (the bio's second paragraph on a phone): open it first
      var more = target.id ? document.querySelector('[aria-controls="' + target.id + '"]') : null;
      if (more && more.getAttribute('aria-expanded') === 'false') more.click();
      if (!target.getClientRects().length) target = target.closest('section[id]') || target;
    }
    var box = target.getBoundingClientRect(), pr = (panel && !panel.hidden) ? panel.getBoundingClientRect() : null;
    if (pr && box.right > pr.left && box.left < pr.right) hide(false);   // the panel would cover it; the side tab brings the panel back
    var tall = box.height > window.innerHeight * 0.6;                 // a tall card starts under the header, a short one is centred
    target.classList.add('is-found');                                 // first: its scroll-margin keeps it clear of the sticky header
    target.scrollIntoView({ behavior: document.documentElement.classList.contains('reduce-motion') ? 'auto' : 'smooth', block: tall ? 'start' : 'center' });
    setTimeout(function () { target.classList.add('is-fading'); }, 3000);
    setTimeout(function () { target.classList.remove('is-found', 'is-fading'); }, 3700);
  }

  function where() { return document.getElementById('about') ? 'this page' : 'the homepage'; }

  function short(t, n) {                    // a title cut at a word, not in the middle of one
    return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '') + '…';
  }

  // Emails and the profile links of the contact passage become real links (DOM nodes, never HTML).
  var LINKS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?:github\.com|scholar\.google\.com|x\.com|linkedin\.com)\/[^\s;,)]+/g;
  function appendRich(p, text) {
    var last = 0, m;
    LINKS.lastIndex = 0;
    while ((m = LINKS.exec(text))) {
      var t = m[0].replace(/[.:]+$/, '');                             // a full stop after a link is not part of it
      if (m.index > last) p.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = el('a', null, t);
      a.href = t.indexOf('@') > 0 ? 'mailto:' + t : 'https://' + t;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      p.appendChild(a);
      last = m.index + t.length;
      LINKS.lastIndex = last;
    }
    if (last < text.length) p.appendChild(document.createTextNode(text.slice(last)));
  }

  // Keep a question and its answer in view; an answer taller than the panel starts at its own top.
  function reveal(first, last) {
    var body = els.body, base = body.getBoundingClientRect().top - body.scrollTop;      // y of the scroll content's top
    var top = first.getBoundingClientRect().top - base, end = last.getBoundingClientRect().bottom - base;
    body.scrollTop = Math.max(0, ((end - top <= body.clientHeight) ? top : last.getBoundingClientRect().top - base) - 8);
  }

  // No model loaded: show the passages themselves.
  function answerFromPage(text, asked) {
    var chat = text.trim();
    if (/^(hi|hello|hey|salam|salaam|assalam\w*|good (morning|afternoon|evening))\b[\s!.,?]*$/i.test(chat)) {
      reveal(asked, bubble('model', 'Hello! Ask about Ali’s research, papers, projects or background.'));
      return;
    }
    if (/^(thanks|thank you|thx|ok|okay|cool|great|nice)\b[\s!.,?]*$/i.test(chat)) {
      reveal(asked, bubble('model', 'You’re welcome. Anything else about Ali?'));
      return;
    }
    if (!window.AliRAG) { bubble('model', 'Instant answers need the page-reading script, which did not load. Reload the page and try again.'); return; }
    var hits = retrieve(text, 4), real = hits.filter(function (h) { return !h.always; });
    var weak = real.length > 0 && real.every(function (h) { return h.weak; });          // the page shares little with the question
    var b = el('div', 'gemma-msg is-model is-passages');
    if (!real.length && !hits.overview) {
      b.textContent = 'I could not find that on ' + where() + '. Try Ali’s research, papers, projects or background; ' +
                      'Gemma (top of this panel) can take open questions.';
    } else {
      b.appendChild(el('p', 'gemma-lead', weak ? 'Not a direct match. The closest passages on ' + where() + ':' : 'From ' + where() + ' (instant, no model):'));
      var shown = (real.length ? real : hits).slice(0, weak ? 2 : 4), lastKey = '';
      shown.forEach(function (h) {
        var p = el('p', 'gemma-hit'), key = h.label + '|' + h.title;
        if (key !== lastKey) p.appendChild(el('b', null, h.label + (h.title && h.title !== h.label ? ' · ' + short(h.title, 80) : '') + ': '));
        lastKey = key;
        var body = h.title ? h.text.replace(h.title, '').replace(/(\.\s*){2,}/g, '. ').replace(/^[\s.:;,·-]+/, '') : h.text;   // the title is already in bold
        appendRich(p, window.AliRAG.snippet(body, 300, h.terms));
        if (h.links && h.links.length) {                                  // a paper: its PDF, arXiv and code links
          var ln = el('span', 'gemma-links');
          h.links.forEach(function (l, i) {
            if (i) ln.appendChild(document.createTextNode(' · '));
            var a = el('a', null, l.t);
            a.href = l.h;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            ln.appendChild(a);
          });
          p.appendChild(document.createTextNode(' '));
          p.appendChild(ln);
        }
        b.appendChild(p);
      });
      var src = sources(shown);
      if (src) b.appendChild(src);
    }
    els.body.appendChild(b);
    reveal(asked, b);
  }

  function bubble(role, text) {
    var b = el('div', 'gemma-msg is-' + role, text);
    els.body.appendChild(b);
    els.body.scrollTop = els.body.scrollHeight;
    return b;
  }

  /* ---------- lifecycle ---------- */
  // On the other pages the homepage text is fetched first: the box stays disabled for that moment, never longer.
  function waitForCorpus() {
    var rag = window.AliRAG, mine = panel;
    if (!rag || rag.loaded()) return;
    els.input.disabled = true;
    els.send.disabled = true;
    rag.ready.then(function () {
      if (panel !== mine || loading || llm) return;                   // closed meanwhile, or the model has taken over the box
      els.input.disabled = false;
      els.send.disabled = false;
    });
  }

  function tabState(open) {                 // the side tab tells assistive technology whether its panel is showing
    var fab = document.getElementById('gemma-fab');
    if (fab) fab.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  // Keyboard and screen-reader users land in the panel; touch users are spared the on-screen keyboard.
  function focusPanel() {
    if (!panel) return;
    panel.setAttribute('aria-modal', window.innerWidth <= 600 ? 'true' : 'false');      // on a phone the panel fills the screen
    var touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    if (!touch && !els.input.disabled) els.input.focus(); else panel.focus();
  }

  // Escape, or following a source link that the panel would cover: the tab brings the panel back with its messages.
  function hide(refocus) {
    if (!panel) return;
    panel.hidden = true;
    tabState(false);
    var fab = document.getElementById('gemma-fab');
    if (refocus && fab) fab.focus();
  }

  function toggle() { if (panel && !panel.hidden) hide(true); else open(); }

  function open() {
    if (panel) {                            // already built: bring it back as it was
      panel.hidden = false;
      tabState(true);
      focusPanel();
      return;
    }
    buildPanel();
    waitForCorpus();
    tabState(true);
    focusPanel();
    var mine = epoch;
    var checkGpu = navigator.gpu
      ? navigator.gpu.requestAdapter().then(function (a) { return !!a; }).catch(function () { return false; })
      : Promise.resolve(false);
    var checkCache = savedModel().then(function (f) { return !!f; });
    Promise.all([checkGpu, checkCache]).then(function (r) {
      if (mine !== epoch || !panel) return;                           // closed while the checks were running
      intro(r[1], r[0], 'WebGPU is not available in this browser, so the model cannot run here. Try desktop Chrome or Edge.');
    });
  }

  function progressStream(stream, total, label) {
    var loaded = 0, lastPaint = 0;
    return stream.pipeThrough(new TransformStream({
      transform: function (chunk, ctl) {
        loaded += chunk.byteLength;
        var now = performance.now();
        if (now - lastPaint > 120) {
          lastPaint = now;
          var pct = Math.min(100, loaded / total * 100);
          setStatus(label + ' ' + gb(loaded) + ' / ' + gb(total) + ' (' + pct.toFixed(0) + '%)');
          if (els.bar) els.bar.style.width = pct.toFixed(1) + '%';
        }
        ctl.enqueue(chunk);
      }
    }));
  }

  /* ---------- model storage (Origin Private File System) ----------
     Cache Storage is unreliable for a 2 GB entry, so the model is saved as a file in OPFS:
     download to disk once, then later visits read it back in a few seconds. */
  var FILE_NAME = 'gemma-4-E2B-it-web.task';

  function opfsRoot() {
    return (navigator.storage && navigator.storage.getDirectory)
      ? navigator.storage.getDirectory().catch(function () { return null; })
      : Promise.resolve(null);
  }

  // Resolves to the saved File if a complete copy exists, else null.
  function savedModel() {
    return opfsRoot().then(function (root) {
      if (!root) return null;
      return root.getFileHandle(FILE_NAME).then(function (h) { return h.getFile(); })
        .then(function (file) { return file.size === MODEL_BYTES ? file : null; })
        .catch(function () { return null; });
    });
  }

  function deleteSaved() {
    return opfsRoot().then(function (root) {
      return root ? root.removeEntry(FILE_NAME).catch(function () {}) : null;
    });
  }

  function enoughSpace() {
    if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(false);
    return navigator.storage.estimate()
      .then(function (e) { return (e.quota - e.usage) > MODEL_BYTES * 1.1; })
      .catch(function () { return false; });
  }

  function download() {
    abortCtl = new AbortController();
    return fetch(MODEL_URL, { signal: abortCtl.signal }).then(function (res) {
      if (!res.ok) throw new Error('download failed (HTTP ' + res.status + ')');
      return res.body;
    });
  }

  // Returns a ReadableStreamDefaultReader over the model bytes.
  function modelReader() {
    return savedModel().then(function (file) {
      if (file) return progressStream(file.stream(), MODEL_BYTES, 'Loading from disk').getReader();
      return Promise.all([opfsRoot(), enoughSpace()]).then(function (r) {
        var root = r[0], space = r[1];
        var stream = function () {          // no usable storage: stream straight into the model
          return download().then(function (body) { return progressStream(body, MODEL_BYTES, 'Downloading').getReader(); });
        };
        if (!root || !space) return stream();
        if (navigator.storage.persist) navigator.storage.persist().catch(function () {});
        return root.getFileHandle(FILE_NAME, { create: true })
          .then(function (h) {
            return h.createWritable().then(function (w) {
              return download().then(function (body) {
                return progressStream(body, MODEL_BYTES, 'Downloading to disk').pipeTo(w);
              }).then(function () { return h.getFile(); });
            });
          })
          .then(function (saved) {
            if (saved.size !== MODEL_BYTES) throw new Error('incomplete download');
            return progressStream(saved.stream(), MODEL_BYTES, 'Loading into GPU memory').getReader();
          })
          .catch(function (err) {
            return deleteSaved().then(function () {
              if (/HTTP/.test(err && err.message) || (err && err.name === 'AbortError')) throw err;   // network problem, or the panel was closed: report it
              setStatus('Saving to disk failed; streaming the model instead…');
              return stream();
            });
          });
      });
    });
  }

  function ready(t0) {
    loading = false;
    els.body.innerHTML = '';
    els.bar = null;
    els.sub.textContent = 'Gemma 4 E2B · running on your GPU';
    bubble('model', 'Hi! I am Gemma 4 E2B, running on your GPU right here in the browser (ready in ' +
      ((performance.now() - t0) / 1000).toFixed(0) + ' s). I read the text of ' + where() + ' before I answer. Ask me about Ali, or anything else.');
    els.input.placeholder = 'Ask about Ali’s research, or anything…';
    els.input.disabled = false;
    els.send.disabled = false;
    setStatus('Ready · nothing leaves your device');
    focusPanel();
  }

  function load() {
    if (loading || llm) return;
    if (window.__gemmaMock) { llm = window.__gemmaMock; els.close.setAttribute('aria-label', 'Close and unload the model'); ready(performance.now()); return; }   // test seam: a stand-in for the 2 GB model
    if (initializing) { setStatus('Still finishing the previous start. Try again in a moment.'); return; }
    loading = true;
    initializing = true;
    var mine = epoch;
    els.close.setAttribute('aria-label', 'Close and unload the model');        // from here on, closing stops the download and frees the memory
    els.input.disabled = true;
    els.send.disabled = true;
    els.body.innerHTML = '';
    var prog = el('div', 'gemma-progress');
    els.bar = el('span');
    prog.appendChild(els.bar);
    els.body.appendChild(prog);
    els.body.appendChild(el('p', 'gemma-note', 'Keep this tab open. The first download can take a few minutes.'));
    setStatus('Preparing…');

    var t0 = performance.now();
    Promise.all([
      import(GENAI + '/genai_bundle.mjs'),
      modelReader()
    ]).then(function (r) {
      var genai = r[0], reader = r[1];
      return genai.FilesetResolver.forGenAiTasks(GENAI + '/wasm').then(function (fileset) {
        return genai.LlmInference.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: reader },
          maxTokens: MAX_TOKENS,
          topK: 40,
          temperature: 0.7,
          randomSeed: Math.floor(Math.random() * 1e6)
        });
      });
    }).then(function (inst) {
      initializing = false;
      if (mine !== epoch) { try { inst.close(); } catch (e) {} return; }      // closed while loading: free the model again
      llm = inst;
      ready(t0);
    }).catch(function (err) {
      initializing = false;
      if (mine !== epoch) return;
      loading = false;
      els.close.setAttribute('aria-label', 'Close');
      els.body.innerHTML = '';
      els.body.appendChild(el('p', 'gemma-warn', 'Could not start the model: ' + (err && err.message ? err.message : err) +
        '. Your GPU may not have enough free memory, or WebGPU is limited in this browser. Instant answers from this page still work.'));
      els.input.disabled = false;
      els.send.disabled = false;
      setStatus('');
    });
  }

  function send() {
    if (busy || els.input.disabled) return;                           // not while the model loads or the page text is still being fetched
    var text = els.input.value.trim();
    if (!text) return;
    els.input.value = '';
    els.input.style.height = '';
    var asked = bubble('user', text);
    if (!llm) { answerFromPage(text, asked); lastQuestion = text; return; }

    var out = bubble('model', '');
    out.classList.add('is-typing');
    out.setAttribute('aria-busy', 'true');                            // announced once complete, not word by word
    busy = true;
    els.send.textContent = 'Stop';
    els.send.disabled = false;
    els.send.type = 'button';
    var stopped = false;
    var stopHandler = function () { stopped = true; try { llm.cancelProcessing(); } catch (e) {} };
    els.send.addEventListener('click', stopHandler);

    var raw = '', t0 = performance.now(), firstAt = 0, mine = epoch;
    var built = buildPrompt(text, retrieve(text, 4));
    llm.generateResponse(built.prompt, function (partial, done) {
      if (mine !== epoch) return;
      if (!firstAt && partial) firstAt = performance.now();
      // newer runtimes stream increments; tolerate cumulative strings too
      raw = partial.indexOf(raw) === 0 && raw ? partial : raw + partial;
      out.textContent = clean(raw);
      els.body.scrollTop = els.body.scrollHeight;
      if (done) out.classList.remove('is-typing');
    }).then(function (full) {
      if (mine !== epoch) return;
      var reply = clean(full || raw).trim();
      out.textContent = reply || '(no reply)';
      out.classList.remove('is-typing');
      out.removeAttribute('aria-busy');
      if (!stopped) history.push({ role: 'user', text: text }, { role: 'model', text: reply });      // a reply cut short by Stop is not remembered
      lastQuestion = text;
      var src = sources(built.used);
      if (src && reply) els.body.appendChild(src);
      reveal(asked, (src && reply) ? src : out);
      var secs = (performance.now() - (firstAt || t0)) / 1000;
      var toks = llm.sizeInTokens(reply) || 0;
      setStatus(toks && secs > 0 ? (toks / secs).toFixed(1) + ' tokens/s on your GPU · nothing leaves your device'
                                 : 'Ready · nothing leaves your device');
    }).catch(function (err) {
      if (mine !== epoch) return;
      out.classList.remove('is-typing');
      out.removeAttribute('aria-busy');
      if (!out.textContent) out.textContent = '(stopped)';
      setStatus('Generation error: ' + (err && err.message ? err.message : err));
    }).then(function () {
      if (mine !== epoch) return;
      busy = false;
      els.send.removeEventListener('click', stopHandler);
      els.send.textContent = 'Send';
      els.send.type = 'submit';
      els.input.focus();
    });
  }

  function shutdown() {
    epoch++;
    busy = false;
    loading = false;
    if (abortCtl) { try { abortCtl.abort(); } catch (e) {} abortCtl = null; }
    if (llm) {
      try { llm.cancelProcessing(); } catch (e) {}
      try { llm.close(); } catch (e) {}       // frees the GPU memory
      llm = null;
    }
    history = [];
    lastQuestion = '';
    if (panel) { panel.remove(); panel = null; els = {}; }
    tabState(false);
    var fab = document.getElementById('gemma-fab');
    if (fab) fab.focus();                     // back where the keyboard user came from
  }
})();
