"""Exercise real Poppler extraction, coordinates, case handling, and cache versions."""

import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.services import pdf_service


def pdf_bytes(first="Alpha needle one", second="Needle [two]", third="needle three"):
    def stream(lines):
        text = "BT /F1 16 Tf 72 700 Td "
        for i, line in enumerate(lines):
            if i:
                text += "0 -24 Td "
            text += f"({line}) Tj "
        data = (text + "ET").encode("ascii")
        return (
            b"<< /Length "
            + str(len(data)).encode()
            + b" >>\nstream\n"
            + data
            + b"\nendstream"
        )

    page = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents %d 0 R >>"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
        page % 4,
        stream([first, second]),
        page % 6,
        stream([third]),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    data = b"%PDF-1.4\n"
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(data)
    data += f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode()
    data += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:])
    return (
        data
        + f"trailer << /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )


@unittest.skipUnless(
    pdf_service.available() and shutil.which("pdftotext"), "Poppler required"
)
class PdfSearchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(
            prefix="univdash-find-test-", dir=Path.home()
        )
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.file = self.root / "sample.pdf"
        self.file.write_bytes(pdf_bytes())
        self.cache = patch.object(
            pdf_service, "cache_dir", return_value=self.root / "cache"
        )
        self.cache.start()
        self.addCleanup(self.cache.stop)

    async def test_case_phrase_literal_and_page_coordinates(self):
        found = await pdf_service.search(str(self.file), "needle")
        self.assertEqual([m["page"] for m in found["matches"]], [1, 1, 2])
        self.assertEqual(found["total"], 3)
        for match in found["matches"]:
            for x, y, width, height in match["rects"]:
                self.assertTrue(0 <= x < 1 and 0 <= y < 1)
                self.assertTrue(width > 0 and height > 0)
        sensitive = await pdf_service.search(str(self.file), "Needle", True)
        self.assertEqual(sensitive["total"], 1)
        phrase = await pdf_service.search(str(self.file), "Alpha needle")
        self.assertEqual(len(phrase["matches"][0]["rects"]), 2)
        literal = await pdf_service.search(str(self.file), "[two]")
        self.assertEqual(literal["total"], 1)

    async def test_cached_extraction_and_source_invalidation(self):
        first = await pdf_service.search(str(self.file), "needle")
        with patch.object(
            pdf_service, "_run", new=AsyncMock(side_effect=AssertionError("cache miss"))
        ):
            cached = await pdf_service.search(str(self.file), "Alpha")
        self.assertEqual(cached["total"], 1)
        self.file.write_bytes(pdf_bytes(first="A changed publication"))
        changed = await pdf_service.search(str(self.file), "needle")
        self.assertNotEqual(changed["version"], first["version"])
        self.assertEqual(changed["total"], 2)

    async def test_document_without_text(self):
        self.file.write_bytes(pdf_bytes("", "", ""))
        result = await pdf_service.search(str(self.file), "needle")
        self.assertFalse(result["has_text"])
        self.assertEqual(result["matches"], [])
