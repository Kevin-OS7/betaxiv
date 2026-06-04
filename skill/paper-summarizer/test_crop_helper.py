"""Regression tests for crop_helper.py — the cropBox-frame coordinate math.

The TS cropGeometry test guards the extension's crop math; this guards the helper side,
specifically that `candidates` normalizes against the **cropBox** (not the mediaBox) so a
cropBox≠mediaBox PDF doesn't drift. Pure stdlib + pdfplumber; runs under pytest OR directly
(`python3 test_crop_helper.py`). No third-party PDF writers (license rule).
"""

import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crop_helper  # noqa: E402

import pdfplumber  # noqa: E402


def _make_pdf(media, crop, rect, rotate=0):
    """Minimal one-page PDF with a filled rectangle. Boxes/rect in PDF user space (pts)."""
    rx, ry, rw, rh = rect
    content = f"{rx} {ry} {rw} {rh} re f\n".encode("latin-1")
    mb = " ".join(str(v) for v in media)
    cb = " ".join(str(v) for v in crop)
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [{mb}] /CropBox [{cb}] /Rotate {rotate} "
        f"/Contents 4 0 R >>".encode(),
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"endstream",
    ]
    buf = io.BytesIO()
    buf.write(b"%PDF-1.4\n")
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(buf.tell())
        buf.write(b"%d 0 obj\n" % i + o + b"\nendobj\n")
    xref = buf.tell()
    buf.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for off in offs:
        buf.write(b"%010d 00000 n \n" % off)
    buf.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF" % (len(objs) + 1, xref))
    path = os.path.join(tempfile.mkdtemp(), "t.pdf")
    with open(path, "wb") as f:
        f.write(buf.getvalue())
    return path


def _vec_bbox(page):
    cands = crop_helper.compute_candidates(page)
    vecs = [b for k, b in cands if k == "vector"]
    assert vecs, f"no vector candidate: {cands}"
    return vecs[0]


def _render_rect_bbox(page):
    """Ground truth: normalized bbox of the dark rect in the to_image (cropBox) PNG."""
    im = page.to_image(resolution=72, force_mediabox=False).original.convert("L")
    w, h = im.size
    px = im.load()
    xs = [x for y in range(h) for x in range(w) if px[x, y] < 128]
    ys = [y for y in range(h) for x in range(w) if px[x, y] < 128]
    return [min(xs) / w, min(ys) / h, (max(xs) + 1) / w, (max(ys) + 1) / h]


class CropBoxFrameTest(unittest.TestCase):
    def assertClose(self, got, want, tol=0.01):
        self.assertEqual(len(got), len(want))
        for g, w in zip(got, want):
            self.assertLessEqual(abs(g - w), tol, f"{got} != {want}")

    def test_candidates_uses_cropbox_frame_when_asymmetric(self):
        # ASYMMETRIC cropBox is the discriminating case: a vertically symmetric box hides a
        # wrong top-offset (cb[1] vs mediaBox_height-cb[3] coincide). /CropBox [100 200 500 700]
        # ⇒ pdfplumber page.cropbox=(100,92,500,592) top-left; cw=400, ch=500.
        # rect x 150..450, y(bottom-up) 250..650 ⇒ matches to_image render exactly:
        #   x: (150-100)/400=0.125 .. (450-100)/400=0.875
        #   y: (142-92)/500=0.1   .. (542-92)/500=0.9      (object top=792-650=142, bottom=542)
        pdf = _make_pdf((0, 0, 612, 792), (100, 200, 500, 700), (150, 250, 300, 400))
        page = pdfplumber.open(pdf).pages[0]
        self.assertClose(_vec_bbox(page), [0.125, 0.1, 0.875, 0.9])

    def test_candidates_match_the_real_renderer_on_asymmetric_cropbox(self):
        # The actual contract: candidates must land in the SAME frame to_image/the extension
        # crop. Compare against pixels measured from the real renderer, not hardcoded numbers.
        pdf = _make_pdf((0, 0, 612, 792), (100, 200, 500, 700), (150, 250, 300, 400))
        page = pdfplumber.open(pdf).pages[0]
        self.assertClose(_vec_bbox(page), _render_rect_bbox(page), tol=0.02)

    def test_candidates_decline_on_rotated_pages(self):
        # Rotated pages are unsupported (pdfplumber coords don't map onto to_image's upright
        # frame). compute_candidates returns [] rather than emitting a silently-wrong hint;
        # the main render→ground→preview flow handles rotation on its own.
        for rot in (90, 180, 270):
            pdf = _make_pdf((0, 0, 612, 792), (100, 200, 500, 700), (150, 250, 300, 300), rotate=rot)
            page = pdfplumber.open(pdf).pages[0]
            self.assertEqual(crop_helper.compute_candidates(page), [], f"rot={rot}")

    def test_candidates_reduces_to_plain_norm_when_cropbox_equals_mediabox(self):
        # cropBox == mediaBox: the same rect normalizes by full page size.
        pdf = _make_pdf((0, 0, 612, 792), (0, 0, 612, 792), (144, 216, 216, 432))
        page = pdfplumber.open(pdf).pages[0]
        # x: 144/612=0.2353 .. 360/612=0.5882 ; y top: (792-648)/792=0.1818 .. (792-216)/792=0.7273
        self.assertClose(_vec_bbox(page), [0.2353, 0.1818, 0.5882, 0.7273])


class NormalizeTest(unittest.TestCase):
    def test_order_and_clamp(self):
        # pixel box with reversed corners + out-of-range spill → ordered, clamped 0..1
        out = crop_helper._order_clamp_norm(900, 100, 100, -50, 1000, 1000)
        self.assertEqual(out, [0.1, 0.0, 0.9, 0.1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
