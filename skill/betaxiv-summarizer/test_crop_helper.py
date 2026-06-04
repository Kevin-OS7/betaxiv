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


def _make_pdf(media, crop, rect, rotate=0, texts=None, extra_rects=()):
    """Minimal one-page PDF with a filled rectangle (+ optional text). Coords in PDF pts.

    `texts` is a list of (x, y_baseline, string) in bottom-up PDF user space — used to plant a
    caption line so the caption-stripping path can be exercised. `extra_rects` draws additional
    filled rectangles (e.g. a second stacked figure). Uses base-14 Helvetica (no font embedding
    needed; license-clean).
    """
    rx, ry, rw, rh = rect
    body = f"{rx} {ry} {rw} {rh} re f\n"
    for ex, ey, ew, eh in extra_rects:
        body += f"{ex} {ey} {ew} {eh} re f\n"
    for tx, ty, s in texts or []:
        esc = s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        body += f"BT /F1 10 Tf {tx} {ty} Td ({esc}) Tj ET\n"
    content = body.encode("latin-1")
    mb = " ".join(str(v) for v in media)
    cb = " ".join(str(v) for v in crop)
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [{mb}] /CropBox [{cb}] /Rotate {rotate} "
        f"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".encode(),
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"endstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
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


def _tighten_box(page, loose):
    """Run the tighten pipeline (caption-strip → whitespace-trim) and return (pixel_box, size)."""
    img = crop_helper._render_pil(page, 72)  # dpi 72 ⇒ 1px == 1pt for a 612x792 page
    box = crop_helper._strip_caption(list(loose), crop_helper._mapped_text_lines(page, img))
    return crop_helper._content_bbox(img, box), img.size


class TightenTest(unittest.TestCase):
    def assertNear(self, got, want, tol=3):
        self.assertLessEqual(abs(got - want), tol, f"{got} != {want} (±{tol})")

    def test_whitespace_trim_snaps_a_loose_box_to_the_ink(self):
        # rect ink at px x150..450, top y 192..392; a loose box with fat margins must snap to it.
        pdf = _make_pdf((0, 0, 612, 792), (0, 0, 612, 792), (150, 400, 300, 200))
        page = pdfplumber.open(pdf).pages[0]
        box, _ = _tighten_box(page, (100, 150, 500, 450))
        self.assertIsNotNone(box)
        x0, y0, x1, y1 = box
        self.assertNear(x0, 150); self.assertNear(y0, 192)
        self.assertNear(x1, 450); self.assertNear(y1, 392)

    def test_strips_a_figure_caption_below_the_image(self):
        # Same rect (bottom edge px 392) with a "Figure 1." caption line beneath it (~px 405).
        # Without stripping, the trim would reach down to the caption (~412); it must stop at 392.
        pdf = _make_pdf(
            (0, 0, 612, 792), (0, 0, 612, 792), (150, 400, 300, 200),
            texts=[(150, 380, "Figure 1. A residual building block")],
        )
        page = pdfplumber.open(pdf).pages[0]
        box, _ = _tighten_box(page, (100, 150, 500, 460))
        self.assertIsNotNone(box)
        self.assertNear(box[3], 392)          # bottom snaps to the figure, not the caption
        self.assertLess(box[3], 400)

    def test_strips_a_table_caption_above_the_body(self):
        # rect body top edge px 392; a "Table 1." caption sits above it (~px 365..372). The top
        # edge must trim down past the caption to the body, not include the caption.
        pdf = _make_pdf(
            (0, 0, 612, 792), (0, 0, 612, 792), (150, 200, 300, 200),
            texts=[(150, 420, "Table 1. Network architectures")],
        )
        page = pdfplumber.open(pdf).pages[0]
        box, _ = _tighten_box(page, (100, 350, 500, 610))
        self.assertIsNotNone(box)
        self.assertNear(box[1], 392)          # top snaps to the body, not the caption
        self.assertGreater(box[1], 380)

    def test_in_figure_labels_are_not_mistaken_for_a_caption(self):
        # A label like "relu" inside the figure must NOT trigger caption stripping (no marker).
        pdf = _make_pdf(
            (0, 0, 612, 792), (0, 0, 612, 792), (150, 400, 300, 200),
            texts=[(300, 500, "relu")],
        )
        page = pdfplumber.open(pdf).pages[0]
        # _strip_caption is a no-op → box unchanged.
        kept = crop_helper._strip_caption([100, 150, 500, 450], crop_helper._mapped_text_lines(
            page, crop_helper._render_pil(page, 72)))
        self.assertEqual(kept, [100, 150, 500, 450])


class LocateTest(unittest.TestCase):
    """Caption-anchored figure detection (compute_figures) — the `locate` core."""

    def assertClose(self, got, want, tol=0.04):
        self.assertEqual(len(got), len(want))
        for g, w in zip(got, want):
            self.assertLessEqual(abs(g - w), tol, f"{got} != {want}")

    def _figs(self, **kw):
        page = pdfplumber.open(_make_pdf(**kw)).pages[0]
        return crop_helper.compute_figures(page)

    def test_caption_regex_tolerates_missing_space_and_anchors_at_line_start(self):
        # The bug this fixes: pdfplumber drops the space → "Figure1", and `\b` used to reject it.
        m = crop_helper.CAPTION_RE.match
        for s in ["Figure1.Training error", "Fig. 4 shows", "Table3.Error rates", "  Figure 5. Deep"]:
            self.assertTrue(m(s), f"should match: {s!r}")
        for s in ["Figured results follow", "our experiments. Fig.1 shows", "a comfortable table 2"]:
            self.assertFalse(m(s), f"should NOT match: {s!r}")

    def test_locates_figure_excluding_its_caption_and_body_prose(self):
        # Figure graphic in the left column (top-left px y 192..392), a no-space caption beneath
        # it, and a wide body-prose line up top. The box must snap to the rect — caption below and
        # body above both excluded.
        figs = self._figs(
            media=(0, 0, 612, 792), crop=(0, 0, 612, 792),
            rect=(100, 400, 180, 200),
            texts=[(100, 380, "Figure1.Atestfigurecaption"),
                   (60, 720, "This is a wide body prose line spanning much of the column width here")],
        )
        self.assertEqual(len(figs), 1, figs)
        _, box = figs[0]
        self.assertClose(box, [0.163, 0.242, 0.458, 0.495])
        self.assertLess(box[3], 0.50)      # caption (norm top ~0.51) excluded
        self.assertGreater(box[1], 0.20)   # body line (norm ~0.09) excluded

    def test_inline_reference_without_adjacent_graphics_is_dropped(self):
        # "Figure 9 shows…" sits far from the only graphic (no horizontal overlap) → it's an inline
        # cross-reference, not a caption, so compute_figures returns nothing.
        figs = self._figs(
            media=(0, 0, 612, 792), crop=(0, 0, 612, 792),
            rect=(80, 400, 120, 150),
            texts=[(360, 660, "Figure 9 shows the result in more detail")],
        )
        self.assertEqual(figs, [])

    def test_two_stacked_figures_sharing_a_merged_cluster_are_split(self):
        # Two graphics 20pt apart merge into ONE proximity cluster; a caption sits in the gap.
        # Without splitting the cluster at the caption, BOTH captions resolve to the same merged
        # box (the page-5 Table 1 / Figure 4 bug). They must come back as two distinct boxes.
        figs = self._figs(
            media=(0, 0, 612, 792), crop=(0, 0, 612, 792),
            rect=(100, 550, 200, 120),                  # figure A: top-left y 122..242
            extra_rects=[(100, 410, 200, 120)],         # figure B: top-left y 262..382 (gap 20pt)
            texts=[(100, 538, "Figure 1. Top one"),     # caption A in the gap (~y 247..254)
                   (100, 394, "Figure 2. Bottom two")],  # caption B below figure B (~y 388..400)
        )
        self.assertEqual(len(figs), 2, figs)
        a, b = sorted((box for _, box in figs), key=lambda x: x[1])
        self.assertLess(crop_helper._iou(a, b), 0.3, f"boxes should be distinct: {a} {b}")
        self.assertClose([a[1], a[3]], [0.154, 0.305])   # figure A ≈ its own rect
        self.assertClose([b[1], b[3]], [0.331, 0.482])   # figure B ≈ its own rect

    def test_rotated_page_declines(self):
        figs = self._figs(
            media=(0, 0, 612, 792), crop=(0, 0, 612, 792), rect=(100, 400, 180, 200), rotate=90,
            texts=[(100, 380, "Figure1.Atest")],
        )
        self.assertEqual(figs, [])


class NormalizeTest(unittest.TestCase):
    def test_order_and_clamp(self):
        # pixel box with reversed corners + out-of-range spill → ordered, clamped 0..1
        out = crop_helper._order_clamp_norm(900, 100, 100, -50, 1000, 1000)
        self.assertEqual(out, [0.1, 0.0, 0.9, 0.1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
