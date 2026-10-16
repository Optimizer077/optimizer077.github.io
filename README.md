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
│       ├── flow-field.js # 2D-canvas fallback background (no WebGL2)
│       ├── bg-physics.js # GPU background (WebGL2): random physics scenes, ~5% GPU budget
│       ├── gemma-chat.js # Opt-in on-device Gemma 4 E2B chat (MediaPipe LLM Inference / WebGPU)
│       └── reading.js    # Reading page: search, filters, year chart
└── _includes/
    └── header.html
```

---

## Background physics and on-device Gemma

`assets/js/bg-physics.js` draws the page background on the GPU (WebGL2). Each visit opens on a random scene (never the one shown
last, remembered in localStorage); then every 12–17 s it moves to the next of ten scenes (shuffled, no repeats until all have played), with a caption naming the
equation. The portrait plays a matching effect, and its **↻ next** button skips to the next process:

| Scene | What the particles do |
|---|---|
| Flow | follow a curl-noise velocity field (they swirl around the cursor) |
| Diffusion | a shape (ring, two moons or spiral) is noised, `xₜ = √ᾱₜ x₀ + √(1−ᾱₜ) ε`, then denoised back |
| Heat equation | Brownian particles coloured by an analytic solution of `∂T/∂t = α∇²T`; the cursor adds heat |
| Lorenz system | particles relax onto the Lorenz attractor (σ = 10, ρ = 28, β = 8/3) |
| Flow matching | straight-line paths between noise and a shape, `xₜ = (1−t) ε + t x₁` |
| Langevin dynamics | noisy gradient descent into the minima of a loss landscape, `dx = −∇U dt + √(2T) dW` |
| Wave equation | expanding ripples from point sources, `∂²u/∂t² = c²∇²u` |
| Point vortices | particles advected by three moving vortices (Biot–Savart); the portrait twists and unwinds |
| Gravity | orbits around a central mass; the portrait is bent into an Einstein ring (point-mass lens equation) |
| k-means | points join their nearest of five moving centroids; the portrait's colours are clustered (k = 6, Lloyd's algorithm) |

Its GPU cost is kept near **5% of the frame budget**: with `EXT_disjoint_timer_query_webgl2` the particle count is
steered by measured GPU time (cap ≈1M on desktop, ≈262k on phones); without it a modest fixed count is used and
reduced if frames drop. It pauses when the tab is hidden, and `flow-field.js` (2D canvas) takes over if WebGL2 is
unavailable. In the browser console, `__bg.stats()` shows the current scene, particle count and GPU share.

The **✦ Ask Gemma** button (homepage, bottom-right) loads `assets/js/gemma-chat.js`, which runs
[`litert-community/gemma-4-E2B-it-litert-lm`](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm)
(`gemma-4-E2B-it-web.task`, ~2.0 GB, Apache-2.0) with `@mediapipe/tasks-genai@0.10.29` on WebGPU. Before anything
is downloaded it warns about size, battery and memory (with extra warnings on phones and metered connections). The
model is saved in the Origin Private File System after the first download and runs entirely in the browser.

---

## Local Preview

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`. (Direct `file://` access may block CSV fetches in some browsers.)

---

## Deployment

1. If you changed `style.css` or anything in `assets/js/`, run `python stamp_assets.py`. It adds a content
   fingerprint (`?v=…`) to those links so phones and browsers download the new files immediately instead of
   using a cached copy.
2. Push to the `main` branch — GitHub Pages serves the site automatically (desktop and mobile are the same
   responsive pages).
