"""
zotero_sync.py  —  Sync reading list CSVs from local Zotero library.

Usage:
    python zotero_sync.py            # interactive menu
    python zotero_sync.py --refresh  # silently refresh all existing sections

Requirements: Python 3 (uses only stdlib). Zotero must be installed locally.
"""
import sqlite3, csv, os, re, sys, shutil

# ── Paths ────────────────────────────────────────────────────────────────────
ZOTERO_DB = os.path.expanduser('~/Zotero/zotero.sqlite')
REPO_DIR  = os.path.dirname(os.path.abspath(__file__))
TMP_DB    = os.path.join(REPO_DIR, '_zotero_tmp.sqlite')

# ── Existing site sections: csv_filename -> (display label, [zotero collection names]) ──
SECTIONS = {
    'Autonomous_Drive': ('VLN / VLA / Autonomous Driving',  ['Autonomous_Drive']),
    'vlm':              ('VLM / Multimodal Models',          ['VLM/MML', 'VLM_studies', 'Agentic_ai']),
    'reasoning':        ('Reasoning Models',                 ['Reasoning', 'Thinking_out_loud']),
    'token':            ('Token Reduction',                  ['Token_reduction', 'Compression', 'Quantization']),
    'diffusion':        ('Diffusion Models',                 ['Diffusion_Models', 'Efficeint_Diffusion_Models',
                                                              'diffusion_Representations', 'Diffusion_classifier']),
    'inr':              ('Implicit Neural Representations',  ['INR_papers']),
    'retrieval':        ('Instance Retrieval',               ['Instance reterival', 'Feature Matching']),
    'mri':              ('MRI Papers',                       ['MRI_Papers']),
    'hyperspectral':    ('Hyperspectral Imaging',            ['Hyperspectral']),
    'misc':             ('Misc / Interesting Papers',        ['Interesting_papers']),
}

HEADERS = ['Key', 'Item Type', 'Publication Year', 'Author', 'Title',
           'Publication Title', 'DOI', 'Url', 'Conference Name']

# ── DB helpers ────────────────────────────────────────────────────────────────
def field(cur, iid, name):
    cur.execute("""SELECT idv.value FROM itemData id
        JOIN itemDataValues idv ON id.valueID=idv.valueID
        JOIN fields f ON id.fieldID=f.fieldID
        WHERE id.itemID=? AND f.fieldName=?""", (iid, name))
    r = cur.fetchone()
    return r['value'] if r else ''

def creators(cur, iid):
    cur.execute("""SELECT lastName, firstName, fieldMode
        FROM itemCreators ic JOIN creators c ON ic.creatorID=c.creatorID
        WHERE ic.itemID=? ORDER BY ic.orderIndex""", (iid,))
    parts = []
    for r in cur.fetchall():
        if r['fieldMode'] == 1:
            parts.append(r['lastName'])
        else:
            parts.append((r['lastName'] + ', ' + r['firstName']).strip(', '))
    return '; '.join(parts)

def export_section(cur, col_names, csv_path):
    q = ','.join('?' * len(col_names))
    cur.execute(f'SELECT collectionID FROM collections WHERE collectionName IN ({q})', col_names)
    col_ids = [r['collectionID'] for r in cur.fetchall()]
    if not col_ids:
        return 0
    q2 = ','.join('?' * len(col_ids))
    cur.execute(f"""SELECT DISTINCT i.itemID, it.typeName
        FROM collectionItems ci
        JOIN items i ON ci.itemID=i.itemID
        JOIN itemTypes it ON i.itemTypeID=it.itemTypeID
        WHERE ci.collectionID IN ({q2})
          AND it.typeName NOT IN ('attachment','note')""", col_ids)
    rows, seen = [], set()
    for item in cur.fetchall():
        iid = item['itemID']
        title = field(cur, iid, 'title')
        if not title or iid in seen:
            continue
        seen.add(iid)
        url = field(cur, iid, 'url')
        doi = field(cur, iid, 'DOI')
        if not url and doi:
            url = 'https://doi.org/' + doi
        date = field(cur, iid, 'date')
        m = re.search(r'\b(19|20)\d{2}\b', date)
        year = m.group(0) if m else ''
        rows.append({
            'Key': str(iid),
            'Item Type': item['typeName'],
            'Publication Year': year,
            'Author': creators(cur, iid),
            'Title': title,
            'Publication Title': field(cur, iid, 'publicationTitle') or field(cur, iid, 'proceedingsTitle') or '',
            'DOI': doi,
            'Url': url,
            'Conference Name': field(cur, iid, 'conferenceName') or '',
        })
    rows.sort(key=lambda r: r['Publication Year'] or '0', reverse=True)
    with open(csv_path, 'w', newline='', encoding='utf-8') as f:
        csv.DictWriter(f, fieldnames=HEADERS).writeheader()
        csv.DictWriter(f, fieldnames=HEADERS).writerows(rows)
    return len(rows)

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    if not os.path.exists(ZOTERO_DB):
        print(f'ERROR: Zotero database not found at:\n  {ZOTERO_DB}')
        print('Edit ZOTERO_DB path at the top of this script.')
        sys.exit(1)

    # Make a safe read-only copy so Zotero can stay open
    shutil.copy2(ZOTERO_DB, TMP_DB)

    db = sqlite3.connect(TMP_DB)
    db.row_factory = sqlite3.Row
    cur = db.cursor()

    silent = '--refresh' in sys.argv

    if not silent:
        print('\n' + '='*60)
        print('  Zotero Sync  —  optimizer077.github.io')
        print('='*60)
        print(f'\n{"#":>3}  {"Section":<38} {"Zotero collections"}')
        print('-'*60)
        for i, (csv_name, (label, cols)) in enumerate(SECTIONS.items(), 1):
            print(f' {i:2}.  {label:<38} {", ".join(cols)}')
        print('-'*60)
        print('\nOptions:')
        print('  Enter numbers to refresh specific sections  (e.g. 1,3)')
        print('  Press Enter (or type "all") to refresh ALL sections')
        print('-'*60)
        choice = input('Your choice: ').strip().lower()
    else:
        choice = 'all'

    keys = list(SECTIONS.keys())
    if choice in ('', 'all'):
        to_refresh = keys
    else:
        try:
            indices = [int(x)-1 for x in choice.split(',') if x.strip()]
            to_refresh = [keys[i] for i in indices]
        except (ValueError, IndexError):
            print('Invalid input. Exiting.')
            db.close(); os.remove(TMP_DB); sys.exit(1)

    print()
    for csv_name in to_refresh:
        label, col_names = SECTIONS[csv_name]
        out_path = os.path.join(REPO_DIR, csv_name + '.csv')
        n = export_section(cur, col_names, out_path)
        status = f'{n} items' if n else 'no items found (check collection names)'
        print(f'  {"[OK]" if n else "[--]"}  {csv_name}.csv  —  {status}')

    db.close()
    try:
        os.remove(TMP_DB)
    except Exception:
        pass

    print(f'\nDone. {len(to_refresh)} section(s) updated.')
    print('Commit & push the updated CSV files to publish changes.')

if __name__ == '__main__':
    main()
