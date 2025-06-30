# Ali Haider — Academic Portfolio

A lightweight, **no-framework** personal site that automatically lists the papers I’m reading and the seminars I give. Everything is plain HTML + CSS with a sprinkle of JavaScript, so it works on any static host (GitHub Pages, Netlify, Cloudflare Pages, etc.).

---

## 🚀 What’s Inside

| File / Folder | Purpose |
|--------------|---------|
| `index.html` | Landing page (bio, recent news, links). |
| `papers.html` | Dynamic reading list. Loads topic-wise CSV/TXT exports from Zotero (VLM, Reasoning, Diffusion, INR …). |
| `seminar.html` | Embeds Google-Slides decks for each internal seminar and lists referenced papers. |
| `data/` | Folder where Zotero exports live (e.g. `vlm.csv`, `reasoning.csv`). |

### Key Features

* **Auto-synced lists** – push a fresh CSV, refresh the site, and new papers appear.  
* **Newest-first sorting** – JavaScript sorts by *Publication Year* descending.  
* **Duplicate guard** – same URL/Title never shows twice, even across sections.  
* **Dual navigation** – fixed sidebar + top quick-links.  
* **No build step** – static files only; `git push` is the deployment.

---

## 🔄 Paper Update Workflow

1. **Organise collections in Zotero** – one collection per topic (e.g. *VLM*).
2. **Export → CSV** with columns  
   `Url, Title, Author, Publication Year`  
   &nbsp;  or export as `|`-separated TXT (`URL | Title | Author | Year`).
3. **Save the file** inside `data/`, lowercase and hyphen-free, e.g.
4. 
