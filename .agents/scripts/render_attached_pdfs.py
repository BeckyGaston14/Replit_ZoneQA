"""Render workspace PDFs for visual inspection."""

import sys
from pathlib import Path

import fitz


root = Path("attached_assets")
output = Path(".agents/outputs/attached-pdf-pages")
output.mkdir(parents=True, exist_ok=True)
pdfs = [Path(item) for item in sys.argv[1:]] or sorted(root.glob("*.pdf"))
if not pdfs:
    print("No PDF attachments found in attached_assets")
else:
    for pdf_path in pdfs:
        document = fitz.open(pdf_path)
        print(f"{pdf_path}: {document.page_count} pages")
        for index, page in enumerate(document):
            image_path = output / f"{pdf_path.stem}-page-{index + 1}.png"
            page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).save(image_path)
            print(image_path)