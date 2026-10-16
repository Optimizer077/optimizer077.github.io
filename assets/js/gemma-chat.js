/* On-device chat with Gemma 4 E2B (LiteRT / MediaPipe LLM Inference, WebGPU).
   - Model: litert-community/gemma-4-E2B-it-litert-lm, web build (.task, ~2.0 GB, Apache-2.0),
     downloaded from Hugging Face only after the visitor confirms, then kept in Cache Storage.
   - Everything runs in the visitor's browser on their GPU; no prompt leaves the device.
   Loaded on demand; exposes window.GemmaChat.open(). */
(function () {
  'use strict';

  var MODEL_URL = 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.task';
  var MODEL_PAGE = 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm';
  var MODEL_BYTES = 2003697664;
  var GENAI = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@0.10.29';
  var MAX_TOKENS = 2048;           // prompt + reply budget
  var PROMPT_BUDGET = 1300;        // keep history under this many tokens

  var SYSTEM = [
    "You are a friendly assistant on Ali Haider's personal website. You run entirely on the visitor's own GPU",
    'inside their browser (Gemma 4 E2B via LiteRT / MediaPipe), so nothing they type is sent to a server.',
    'Facts about Ali: Ph.D. researcher in AI at Kyung Hee University (MLVC Lab, advisor Prof. Sung-Ho Bae).',
    'Current work: vision-language navigation for drones, diffusion models for images and language, MRI reconstruction.',
    'Papers: I-INR: Iterative Implicit Neural Representations (AAAI 2026); Descanning, a color-correction diffusion model',
    '(AAAI 2024); human detection in aerial thermal imaging (Infrared Physics & Technology, 2021). Korean patent on',
    'machine-learning-based image restoration. Side projects: Paper Review Harness, UrduPy, a Jev learning course,',
    'a from-scratch Language Diffusion Models course, Awesome Language Diffusion, and a calculus classroom web app.',
    'If you do not know something about Ali, say so instead of guessing. Keep answers short and clear.'
  ].join(' ');

  var api = { open: open };
  window.GemmaChat = api;

  var panel, els = {}, llm = null, busy = false, history = [], loading = false;

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

  function buildPrompt(userText) {
    var turns = history.concat([{ role: 'user', text: userText }]);
    var render = function (list) {
      var s = '<|turn>system\n' + SYSTEM + '<turn|>\n';
      list.forEach(function (t) { s += '<|turn>' + t.role + '\n' + t.text + '<turn|>\n'; });
      return s + '<|turn>model\n';
    };
    var prompt = render(turns);
    // drop the oldest exchanges if the prompt gets too long for the context window
    while (llm && turns.length > 1 && (llm.sizeInTokens(prompt) || 0) > PROMPT_BUDGET) {
      turns = turns.slice(2);
      prompt = render(turns);
    }
    return prompt;
  }

  /* ---------- device checks ---------- */
  function isPhone() {
    return Math.min(screen.width, screen.height) < 700 || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
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
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Chat with Gemma 4 running on your GPU');

    var head = el('div', 'gemma-head');
    var title = el('div', 'gemma-title');
    title.appendChild(el('b', null, 'Gemma 4 E2B'));
    title.appendChild(el('span', 'gemma-sub', 'on your GPU · LiteRT / WebGPU'));
    head.appendChild(title);
    var close = el('button', 'gemma-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close and unload the model');
    close.addEventListener('click', shutdown);
    head.appendChild(close);
    panel.appendChild(head);

    els.body = el('div', 'gemma-body');
    panel.appendChild(els.body);

    els.status = el('p', 'gemma-status');
    panel.appendChild(els.status);

    var form = el('form', 'gemma-form');
    els.input = el('textarea');
    els.input.rows = 1;
    els.input.placeholder = 'Ask about Ali’s research, or anything…';
    els.input.disabled = true;
    els.send = el('button', 'btn btn-primary', 'Send');
    els.send.type = 'submit';
    els.send.disabled = true;
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

  function setStatus(t) { els.status.textContent = t; }

  function intro(cached, gpuOk, gpuNote) {
    els.body.innerHTML = '';
    var box = el('div', 'gemma-intro');
    box.appendChild(el('p', null, 'Run Google’s Gemma 4 E2B language model directly in this tab, on your own GPU. ' +
      'Nothing you type leaves your device.'));
    var ul = el('ul');
    [
      cached ? 'Model already saved on this device — loads from disk in seconds.' :
        'One-time download: ' + gb(MODEL_BYTES) + ' from Hugging Face (Apache-2.0), saved on this device for next time.',
      'Needs WebGPU and about 2 GB of free GPU memory. Desktop Chrome or Edge works best.',
      'Text only. It can be wrong — it is a small model.'
    ].forEach(function (t) { ul.appendChild(el('li', null, t)); });
    box.appendChild(ul);
    if (!gpuOk) box.appendChild(el('p', 'gemma-warn', gpuNote));
    deviceWarnings(cached).forEach(function (w) { box.appendChild(el('p', 'gemma-warn', '⚠ ' + w)); });
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
    box.appendChild(row);
    els.body.appendChild(box);
    setStatus('');
  }

  function bubble(role, text) {
    var b = el('div', 'gemma-msg is-' + role, text);
    els.body.appendChild(b);
    els.body.scrollTop = els.body.scrollHeight;
    return b;
  }

  /* ---------- lifecycle ---------- */
  function open() {
    if (!panel) buildPanel();
    panel.hidden = false;
    if (llm) { els.input.focus(); return; }
    if (loading) return;
    var checkGpu = navigator.gpu
      ? navigator.gpu.requestAdapter().then(function (a) { return !!a; }).catch(function () { return false; })
      : Promise.resolve(false);
    var checkCache = savedModel().then(function (f) { return !!f; });
    Promise.all([checkGpu, checkCache]).then(function (r) {
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
    return fetch(MODEL_URL).then(function (res) {
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
              if (/HTTP/.test(err && err.message)) throw err;   // network problem: report it
              setStatus('Saving to disk failed; streaming the model instead…');
              return stream();
            });
          });
      });
    });
  }

  function load() {
    if (loading || llm) return;
    loading = true;
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
      llm = inst;
      loading = false;
      els.body.innerHTML = '';
      els.bar = null;
      bubble('model', 'Hi! I am Gemma 4 E2B, running on your GPU right here in the browser (ready in ' +
        ((performance.now() - t0) / 1000).toFixed(0) + ' s). Ask me about Ali’s research, or anything else.');
      els.input.disabled = false;
      els.send.disabled = false;
      setStatus('Ready · nothing leaves your device');
      els.input.focus();
    }).catch(function (err) {
      loading = false;
      els.body.innerHTML = '';
      els.body.appendChild(el('p', 'gemma-warn', 'Could not start the model: ' + (err && err.message ? err.message : err) +
        '. Your GPU may not have enough free memory, or WebGPU is limited in this browser.'));
      setStatus('');
    });
  }

  function send() {
    if (!llm || busy) return;
    var text = els.input.value.trim();
    if (!text) return;
    els.input.value = '';
    bubble('user', text);
    var out = bubble('model', '');
    out.classList.add('is-typing');
    busy = true;
    els.send.textContent = 'Stop';
    els.send.disabled = false;
    els.send.type = 'button';
    var stopHandler = function () { try { llm.cancelProcessing(); } catch (e) {} };
    els.send.addEventListener('click', stopHandler);

    var raw = '', t0 = performance.now(), firstAt = 0;
    var prompt = buildPrompt(text);
    llm.generateResponse(prompt, function (partial, done) {
      if (!firstAt && partial) firstAt = performance.now();
      // newer runtimes stream increments; tolerate cumulative strings too
      raw = partial.indexOf(raw) === 0 && raw ? partial : raw + partial;
      out.textContent = clean(raw);
      els.body.scrollTop = els.body.scrollHeight;
      if (done) out.classList.remove('is-typing');
    }).then(function (full) {
      var reply = clean(full || raw).trim();
      out.textContent = reply || '(no reply)';
      out.classList.remove('is-typing');
      history.push({ role: 'user', text: text }, { role: 'model', text: reply });
      var secs = (performance.now() - (firstAt || t0)) / 1000;
      var toks = llm.sizeInTokens(reply) || 0;
      setStatus(toks && secs > 0 ? (toks / secs).toFixed(1) + ' tokens/s on your GPU · nothing leaves your device'
                                 : 'Ready · nothing leaves your device');
    }).catch(function (err) {
      out.classList.remove('is-typing');
      if (!out.textContent) out.textContent = '(stopped)';
      setStatus('Generation error: ' + (err && err.message ? err.message : err));
    }).then(function () {
      busy = false;
      els.send.removeEventListener('click', stopHandler);
      els.send.textContent = 'Send';
      els.send.type = 'submit';
      els.input.focus();
    });
  }

  function shutdown() {
    if (llm) {
      try { llm.close(); } catch (e) {}       // frees the GPU memory
      llm = null;
    }
    history = [];
    if (panel) { panel.remove(); panel = null; els = {}; }
  }
})();
