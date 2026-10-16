# Academic Portfolio — Static Site

A lightweight static academic website. Pure **HTML + CSS + vanilla JS** — no build step, no frameworks, deploys directly to GitHub Pages.

---

## Pages

| File | Purpose |
|---|---|
| `index.html` | Home page — bio, research interests, news, publications, projects, honors |
| `reading.html` | Paper reading list, auto-populated from Zotero CSV exports |
| `seminar.html` | Lab seminar slide decks (Google Slides embeds) |

---

## Reading List

Papers are loaded from CSV files in the repo root. Each CSV maps to one section in `reading.html`:

| CSV file | Section |
|---|---|
| `Autonomous_Drive.csv` | VLN / VLA / Autonomous Driving |
| `vlm.csv` | Vision-Language / Multimodal Models |
| `reasoning.csv` | Reasoning Models |
| `token.csv` | Token Reduction |
| `diffusion.csv` | Diffusion Models |
| `inr.csv` | Implicit Neural Representations |
| `retrieval.csv` | Instance Retrieval |
| `mri.csv` | MRI Papers |
| `hyperspectral.csv` | Hyperspectral Imaging |
| `misc.csv` | Misc / Interesting Papers |

`assets/js/reading.js` fetches each CSV at page load, merges papers that appear in several topics, and renders a searchable list with topic chips, a papers-per-year chart (click a bar to filter), a "recently added" strip (from Zotero's `Date Added`), and abs/PDF/DOI links. Filters are kept in the URL hash, e.g. `reading.html#q=diffusion&topic=vlm`. No build step required.

---

## Syncing from Zotero

Run `zotero_sync.py` to refresh the CSVs directly from your local Zotero library:

```bash
# Refresh all sections silently
python zotero_sync.py --refresh

# Interactive — choose which sections to update
python zotero_sync.py
```

Requirements: Python 3 (stdlib only). Zotero must be installed locally. The script copies the Zotero SQLite to a temp file so Zotero can stay open while syncing.

After running, commit and push the updated CSV files to publish changes.

---

## Structure

```
optimizer077.github.io/
├── index.html
├── reading.html
├── seminar.html
├── style.css
├── zotero_sync.py        # Zotero -> CSV sync utility
├── Autonomous_Drive.csv
├── vlm.csv
├── reasoning.csv
├── diffusion.csv
├── inr.csv
├── token.csv
├── retrieval.csv
├── mri.csv
├── hyperspectral.csv
├── misc.csv
├── 404.html              # Custom not-found page (served by GitHub Pages)
├── favicon.svg, apple-touch-icon.png
├── robots.txt, sitemap.xml
├── assets/
│   ├── meta/og-card.png  # Link-preview image (Open Graph / X)
│   ├── img/              # Profile photo (portrait.webp is what the site loads)
│   ├── Pub/              # Publication thumbnail images
│   └── js/
│       ├── site.js       # Nav, theme toggle, scroll reveal, GitHub stars, pixel-reveal thumbnails
│       ├── pixel-hero.js # Hero portrait that denoises from pixel noise
│       ├── hill-drive.js # "Off the clock" pixel car scene
│       ├── drone-nav.js  # Drone navigation illustration (Projects)
│       ├── learn-loop.js # Self-improving agent loop (Learning)
│       ├── mini-demos.js # Diffusion-text and tangent-plot card demos
│       ├── flow-field.js # Background flow particles
│       ├── gpu-mode.js   # Opt-in WebGL2 particle sim, governed to ~75% of the GPU frame budget
│       ├── gemma-chat.js # Opt-in on-device Gemma 4 E2B chat (MediaPipe LLM Inference / WebGPU)
│       └── reading.js    # Reading page: search, filters, year chart
└── _includes/
    └── header.html
```

---

## GPU mode and on-device Gemma

The ⚡ **GPU mode** button (homepage, bottom-right) loads `assets/js/gpu-mode.js` on demand. It runs a WebGL2
particle flow simulation and adjusts its size every 0.4 s so GPU time stays near **75% of the frame budget**:

- With `EXT_disjoint_timer_query_webgl2`, GPU time per frame is measured directly.
- Without it, the load grows until frames drop, then holds at 75% of that level.
- Past the particle cap (≈0.5M on phones, ≈4.2M on desktop) it adds simulation substeps instead of memory.
- It pauses when the tab is hidden, stops itself if the device struggles, and frees all GPU memory on stop.

From the GPU mode panel, **Chat with Gemma 4 on this GPU** loads `assets/js/gemma-chat.js`, which runs
[`litert-community/gemma-4-E2B-it-litert-lm`](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm)
(`gemma-4-E2B-it-web.task`, ~2.0 GB, Apache-2.0) with `@mediapipe/tasks-genai@0.10.29` on WebGPU. The model is
downloaded from Hugging Face only after the visitor confirms, cached in Cache Storage, and runs fully in the browser.

---

## Local Preview

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`. (Direct `file://` access may block CSV fetches in some browsers.)

---

## Deployment

Push to the `main` branch — GitHub Pages serves the site automatically.
