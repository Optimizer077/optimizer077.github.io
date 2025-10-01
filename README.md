# Ali Haider — Academic Portfolio (No‑Framework)

A lightweight **static** site that auto‑lists the papers you’re reading (from Zotero exports) and embeds slide decks for seminars. Pure **HTML + CSS + vanilla JS** — deploy anywhere (GitHub Pages, Netlify, Cloudflare Pages, any static host).

---

## ✨ Features
- **Auto‑synced reading lists** — drop CSV/TXT into `/data`, reload, and it appears.
- **Newest‑first** — sorted by `Publication Year`/`Year` descending.
- **Duplicate guard** — same normalized `(title + url)` never shows twice, even across topics.
- **Dual navigation** — fixed sidebar + top quick‑links.
- **Zero build step** — no bundlers, no frameworks.

---

## 📁 Structure
```
ali-portfolio/
├── index.html
├── papers.html
├── seminar.html
├── assets/
│   ├── css/
│   │   └── styles.css
│   └── js/
│       ├── common.js
│       ├── papers.js
│       └── seminar.js
└── data/
    ├── vlm.csv               # Url,Title,Author,Publication Year
    ├── reasoning.txt         # URL | Title | Author | Year
    └── seminars.json         # Slides + references
```

---

## 🚀 Quick Start
1. Copy the files into a folder or clone the repo.
2. Put Zotero exports (CSV or pipe‑separated TXT) into `/data`.
3. Open `papers.html` and set which topics/files to load:
   ```html
   <script>
     const TOPIC_FILES = [
       { label: 'VLM',       file: 'data/vlm.csv' },
       { label: 'Reasoning', file: 'data/reasoning.txt' }
       // { label: 'Diffusion', file: 'data/diffusion.csv' },
     ];
   </script>
   ```
4. Serve statically (CORS‑safe):
   - Python: `python -m http.server 8080`
   - Node: `npx http-server -p 8080`
   - Bun: `bunx http-server -p 8080`

> Opening via `file://` may block `fetch()` in browsers. Use a tiny local server.

---

## 🔄 Update Workflow (Zotero → Site)
1. **Organise** collections in Zotero (one per topic).
2. **Export → CSV** with exact header: `Url, Title, Author, Publication Year`  
   or export **TXT** with `URL | Title | Author | Year`.
3. **Save** to `/data/` using lowercase/hyphenated names (e.g., `vlm.csv`, `reasoning.txt`).
4. **Declare** the file in `papers.html` → `TOPIC_FILES`.
5. **Deploy** (push to GitHub/Pages, Netlify, etc.). Refresh to see updates.

---

## 📇 Data Formats

### CSV (preferred)
- Header (exact, case‑sensitive): `Url, Title, Author, Publication Year`
- Quoted fields supported.
- Example:
  ```csv
  Url,Title,Author,Publication Year
  https://arxiv.org/abs/2401.00001,"Big Vision-Language Models, Revisited",Doe et al.,2025
  https://openreview.net/forum?id=xyz,Reasoning with Tools,Smith and Lee,2024
  ```

### Pipe‑separated TXT
- No header. Strict order: `URL | Title | Author | Year`
- Example:
  ```
  https://arxiv.org/abs/2402.11111 | Compositional Reasoning in VLMs | Patel et al. | 2025
  https://proceedings.mlr.press/vNN/abc.html | Diffusion as Planning | Chen & Zhao | 2023
  ```

### Dedupe & Normalization
- Duplicate key = `normalize(title) + '|' + normalize(url)`.
- `normalize()` lowercases, trims, collapses whitespace, strips trailing slashes.
- First occurrence wins; later duplicates across any topic are skipped.

### Sorting
- Primary key = numeric `Publication Year`/`Year` (descending).
- Missing or non‑numeric years are pushed to the bottom.

---

## 🧱 Seminars (`data/seminars.json`)
Each item embeds a Google Slides deck and lists referenced papers.

**Schema:**
```json
[
  {
    "title": "Multimodal Chain-of-Thought",
    "date": "2025-09-20",
    "slides": "https://docs.google.com/presentation/d/.../embed",
    "notes": "Focus on tool-use and verifiers.",
    "references": [
      { "title": "CoT in VLMs", "url": "https://arxiv.org/abs/2403.12345" },
      { "title": "Verifier-guided Decoding", "url": "https://openreview.net/forum?id=..." }
    ]
  }
]
```

**Page mapping:**
- `index.html` — Bio, news, quick links.
- `papers.html` — Parses CSV/TXT, merges, de‑dupes, sorts, filter/search UI.
- `seminar.html` — Renders seminars with embedded slides + references.

---

## 🧪 Accessibility & Performance
- Semantic landmarks: `<header>`, `<aside>`, `<main>`, `<nav>`, `<section>`.
- Respects `prefers-color-scheme`.
- No third‑party fonts; minimal CSS/JS; data‑URI favicon.

---

## 🚢 Deployment

### GitHub Pages
1. Push repository.
2. **Settings → Pages** → “Deploy from branch” (e.g., `main`).
3. Visit `https://<user>.github.io/<repo>/`.

### Netlify / Cloudflare Pages / Vercel
- New project → import repo → **Build command:** none → **Output directory:** `/`.

---

## 🧰 Troubleshooting
- **Empty lists**: verify file names in `TOPIC_FILES`; CSV header exact; TXT order correct; serve via `http://localhost` not `file://`.
- **Encoding**: ensure UTF‑8.
- **Ordering**: confirm numeric years; blanks go last.

---

## 🔒 Privacy
All data is static files you control. No analytics, cookies, or trackers.

---

## 📄 License
MIT — attribution appreciated.
