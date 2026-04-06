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

The JS in `reading.html` fetches each CSV at page load, parses it, deduplicates by URL+title, sorts newest-first, and renders the list — no build step required.

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
├── assets/
│   ├── img/              # Profile photo
│   └── Pub/              # Publication thumbnail images
└── _includes/
    └── header.html
```

---

## Local Preview

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`. (Direct `file://` access may block CSV fetches in some browsers.)

---

## Deployment

Push to the `main` branch — GitHub Pages serves the site automatically.
