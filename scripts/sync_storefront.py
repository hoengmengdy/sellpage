"""Keep the existing standalone storefront aligned with the Flask storefront.

Run from the project root after editing templates/index.html or static assets:
    python scripts/sync_storefront.py
"""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]


def sync():
    html = (ROOT / "templates/index.html").read_text(encoding="utf-8")
    replacements = {
        "{{ url_for('static', filename='css/style.css') }}": "css/style.css",
        "{{ url_for('static', filename='images/logo.jpg') }}": "images/logo.jpg",
        "<script src=\"{{ url_for('static', filename='js/app.js') }}\"></script>":
            '<script src="js/products-data.js"></script>\n  <script src="js/app.js"></script>',
    }
    for original, replacement in replacements.items():
        html = html.replace(original, replacement)
    (ROOT / "index.html").write_text(html, encoding="utf-8")
    for asset in ("css/style.css", "js/app.js"):
        shutil.copyfile(ROOT / "static" / asset, ROOT / asset)


if __name__ == "__main__":
    sync()
