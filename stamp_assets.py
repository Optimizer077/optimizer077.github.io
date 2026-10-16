"""stamp_assets.py — add a content fingerprint to CSS/JS links so phones and browsers
fetch fresh files right after a deploy (GitHub Pages lets browsers cache for 10 min).

    python stamp_assets.py      # run before committing/pushing site changes

Each link like  src="assets/js/site.js"  becomes  src="assets/js/site.js?v=1a2b3c4d",
where the value is the first 8 hex digits of the file's SHA-1. Unchanged files keep
their stamp, so only edited files are re-downloaded. Stdlib only.
"""
import hashlib
import os
import re

REPO = os.path.dirname(os.path.abspath(__file__))
PAGES = ["index.html", "seminar.html", "reading.html", "404.html"]
LINK = re.compile(r'(?P<attr>href|src)="(?P<slash>/?)(?P<path>(?:style\.css|assets/js/[\w.-]+\.js))(?:\?v=[0-9a-f]+)?"')


def fingerprint(rel_path: str) -> str:
    with open(os.path.join(REPO, rel_path), "rb") as f:
        return hashlib.sha1(f.read()).hexdigest()[:8]


def stamp(page: str) -> int:
    path = os.path.join(REPO, page)
    with open(path, encoding="utf-8") as f:
        html = f.read()

    def repl(m: re.Match) -> str:
        return f'{m["attr"]}="{m["slash"]}{m["path"]}?v={fingerprint(m["path"])}"'

    new_html, count = LINK.subn(repl, html)
    if new_html != html:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(new_html)
    return count


if __name__ == "__main__":
    for page in PAGES:
        if os.path.exists(os.path.join(REPO, page)):
            print(f"{page:14} {stamp(page)} asset link(s) stamped")
