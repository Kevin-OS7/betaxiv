#!/usr/bin/env python3
"""crop_helper.py — ground figure bboxes on the *same* page frame the extension crops.

The Paper Reader extension crops a figure by slicing a normalized ``[x0,y0,x1,y1]``
rectangle (0..1, origin top-left) out of the PDF.js-rendered page. PDF.js renders the
page's ``view`` box (the cropBox) with ``/Rotate`` applied — i.e. the upright page. To
make the model's bbox land exactly where the extension cuts, you must:

  1. ``render`` the page to a PNG in that *same* frame (cropBox, rotation applied),
  2. read that PNG and return the figure's box in **pixel** coordinates on it,
  3. ``normalize`` those pixels by the PNG's pixel size → the 0..1 bbox to store,
  4. ``preview`` the bbox back onto the page to self-verify the crop is tight.

This replaces eyeballed/"generous" coordinates: the model grounds on a fixed image
(where VLMs are reliable) instead of generating coordinates from a reconstructed layout.

Dependencies: pdfplumber (MIT) + Pillow — both already present (Pillow ships with
pdfplumber). Never uses PyMuPDF / MinerU / Marker (license rule).

All coordinates are in the **upright cropBox frame, origin top-left** — identical to
what the extension renders. ``to_image(force_mediabox=False)`` uses the cropBox; the
backend applies page rotation, so ``image.size`` already reflects the upright page.
"""

import argparse
import re
import sys

DEFAULT_DPI = 150

# A figure/table CAPTION starts with one of these markers + a number. We strip the caption
# from the box because the summary already restates it as text below the image — keeping it
# in the crop just wastes vertical space and looks like a duplicate title. In-figure labels
# (axis ticks, "weight layer", "relu", legends) never match this, so they're preserved.
CAPTION_RE = re.compile(
    r"^\s*(figure|fig|table|tab|algorithm|alg|scheme|chart|exhibit|図|表)\b\.?\s*\d+",
    re.IGNORECASE,
)
# Pixels brighter than this (0..255 luma) count as background when trimming whitespace.
INK_THRESH = 245


def _load_page(pdf_path, page_no):
    import pdfplumber

    pdf = pdfplumber.open(pdf_path)
    if page_no < 1 or page_no > len(pdf.pages):
        sys.exit(f"error: page {page_no} out of range (1..{len(pdf.pages)})")
    return pdf, pdf.pages[page_no - 1]


def _render_pil(page, dpi):
    """Render the page to an upright cropBox PIL image (matches PDF.js)."""
    return page.to_image(resolution=dpi, force_mediabox=False).original.convert("RGB")


def _order_clamp_norm(x0, y0, x1, y1, w, h):
    """pixels -> normalized [x0,y0,x1,y1], ordered and clamped to 0..1."""
    nx0, nx1 = sorted((x0 / w, x1 / w))
    ny0, ny1 = sorted((y0 / h, y1 / h))
    clamp = lambda v: max(0.0, min(1.0, v))
    return [round(clamp(nx0), 4), round(clamp(ny0), 4), round(clamp(nx1), 4), round(clamp(ny1), 4)]


def cmd_render(args):
    pdf, page = _load_page(args.pdf, args.page)
    img = _render_pil(page, args.dpi)
    img.save(args.out)
    w, h = img.size
    # Print pixel size: the model needs it to ground in and to normalize against.
    print(f"{w} {h}")
    print(f"saved {args.out}  ({w}x{h}px @ {args.dpi}dpi, upright cropBox frame)", file=sys.stderr)
    pdf.close()


def cmd_normalize(args):
    w, h = args.png_size
    x0, y0, x1, y1 = args.pixels
    bbox = _order_clamp_norm(x0, y0, x1, y1, w, h)
    # The exact array to drop into figures[].bbox:
    print(bbox)


def _to_pixels(bbox, pixels, w, h):
    if pixels is not None:
        x0, y0, x1, y1 = pixels
    else:
        a, b, c, d = bbox
        x0, y0, x1, y1 = a * w, b * h, c * w, d * h
    x0, x1 = sorted((x0, x1))
    y0, y1 = sorted((y0, y1))
    return x0, y0, x1, y1


def cmd_preview(args):
    from PIL import ImageDraw

    pdf, page = _load_page(args.pdf, args.page)
    img = _render_pil(page, args.dpi)
    w, h = img.size
    x0, y0, x1, y1 = _to_pixels(args.bbox, args.pixels, w, h)

    if args.crop:
        cx0, cy0 = int(max(0, x0)), int(max(0, y0))
        cx1, cy1 = int(min(w, x1)), int(min(h, y1))
        if cx1 > cx0 and cy1 > cy0:
            img.crop((cx0, cy0, cx1, cy1)).save(args.crop)
            print(f"saved crop {args.crop}  ({cx1-cx0}x{cy1-cy0}px)", file=sys.stderr)

    overlay = img.copy()
    draw = ImageDraw.Draw(overlay)
    lw = max(2, round(min(w, h) / 300))
    draw.rectangle([x0, y0, x1, y1], outline=(220, 30, 30), width=lw)
    overlay.save(args.out)
    print(f"saved overlay {args.out}  rect=({int(x0)},{int(y0)},{int(x1)},{int(y1)})px", file=sys.stderr)
    print(_order_clamp_norm(x0, y0, x1, y1, w, h))  # normalized bbox for convenience
    pdf.close()


def _objs_bbox(objs):
    if not objs:
        return None
    return (
        min(o["x0"] for o in objs),
        min(o["top"] for o in objs),
        max(o["x1"] for o in objs),
        max(o["bottom"] for o in objs),
    )


def _cluster(objs, gap):
    """Greedy proximity clustering: merge boxes whose gap is <= `gap` (pts)."""
    boxes = [(o["x0"], o["top"], o["x1"], o["bottom"]) for o in objs]
    changed = True
    while changed:
        changed = False
        out = []
        for b in boxes:
            merged = False
            for i, c in enumerate(out):
                # overlap-or-near test on both axes
                if (b[0] <= c[2] + gap and c[0] <= b[2] + gap
                        and b[1] <= c[3] + gap and c[1] <= b[3] + gap):
                    out[i] = (min(b[0], c[0]), min(b[1], c[1]), max(b[2], c[2]), max(b[3], c[3]))
                    merged = True
                    changed = True
                    break
            if not merged:
                out.append(b)
        boxes = out
    return boxes


def _cropbox_map(page):
    """Build the cropBox-frame normalizer + cropBox size (cw, ch) in points.

    pdfplumber reports object coords (x0/top/x1/bottom) AND ``page.cropbox`` in the same
    **top-left** frame (origin = top of ``page.bbox``; `top` = mediaBox_height − pdf_y) — NOT
    raw bottom-up PDF coords. So ``page.cropbox`` is ``(left, top, right, bottom)`` already.
    The extension (and render/preview via to_image) crop the **cropBox** region, so candidate
    boxes must be normalized against it or a cropBox≠mediaBox PDF drifts. Returns
    ``(mapfn, cw, ch)`` where ``mapfn(x0, top, x1, bottom)`` → cropBox-normalized
    ``[x0,y0,x1,y1]`` in 0..1 (ordered, clamped). For cropBox==mediaBox this reduces to plain
    ``coord / page.width|height``. (Verified against to_image on an asymmetric /CropBox.)
    """
    cb = [float(v) for v in (page.cropbox or page.bbox)]  # (left, top, right, bottom), top-left
    left, top = cb[0], cb[1]
    cw = cb[2] - cb[0]
    ch = cb[3] - cb[1]
    clamp = lambda v: max(0.0, min(1.0, v))

    def mapfn(x0, t, x1, b):
        nx = sorted((clamp((x0 - left) / cw), clamp((x1 - left) / cw)))
        ny = sorted((clamp((t - top) / ch), clamp((b - top) / ch)))
        return [round(nx[0], 4), round(ny[0], 4), round(nx[1], 4), round(ny[1], 4)]

    return mapfn, cw, ch


def compute_candidates(page):
    """ASSIST ONLY: pdfplumber-derived seed boxes, normalized in the cropBox frame.

    Not authoritative — vector clustering can over/under-group. The model still grounds and
    verifies via render/preview. Returns a list of ``(kind, [x0,y0,x1,y1])``.

    Rotated pages (``/Rotate`` 90/180/270) are unsupported here and return ``[]``: pdfplumber's
    object/cropBox coords don't map cleanly onto ``to_image``'s upright frame, so any hint would
    silently disagree with what the extension crops. The main flow (render → ground on the
    upright PNG → preview) already handles rotation correctly, so just use that.
    """
    if int(page.rotation or 0) % 360 != 0:
        return []
    mapfn, cw, ch = _cropbox_map(page)
    out = []
    # Raster figures: page.images give exact boxes.
    for im in page.images:
        out.append(("image", mapfn(im["x0"], im["top"], im["x1"], im["bottom"])))
    # Vector figures: cluster rects/lines/curves by proximity (gap ~ 2% of cropBox height).
    vec = list(page.rects) + list(page.lines) + list(page.curves)
    for b in sorted(_cluster(vec, 0.02 * ch), key=lambda b: (b[3] - b[1]) * (b[2] - b[0]), reverse=True)[:6]:
        if (b[2] - b[0]) * (b[3] - b[1]) > 0.01 * cw * ch:  # drop tiny specks (underlines, rules)
            out.append(("vector", mapfn(b[0], b[1], b[2], b[3])))
    return out


def cmd_candidates(args):
    pdf, page = _load_page(args.pdf, args.page)
    if int(page.rotation or 0) % 360 != 0:
        print(
            f"candidates: page is rotated /Rotate {page.rotation} — not supported here. "
            "Ground the bbox directly via `render` + `preview` (the main flow handles rotation).",
            file=sys.stderr,
        )
        pdf.close()
        return
    for kind, bbox in compute_candidates(page):
        print(f"{kind:6} {bbox}")
    pdf.close()


def _content_bbox(img, box):
    """Tight pixel bbox of the ink inside `box` (whitespace trimmed). None if all background.

    Pure-pixel, so it works on any page (rotated included): we crop the model's loose region,
    threshold to ink, and take the bounding box of what's left — snapping the edges to the real
    figure content and recentring it. White interior regions don't matter (it's the OUTER box
    of all ink), so this never carves a figure apart.
    """
    x0, y0, x1, y1 = (int(round(v)) for v in box)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(img.width, x1), min(img.height, y1)
    if x1 <= x0 or y1 <= y0:
        return None
    region = img.crop((x0, y0, x1, y1)).convert("L")
    mask = region.point(lambda p: 255 if p < INK_THRESH else 0)
    bb = mask.getbbox()
    if not bb:
        return None
    return (x0 + bb[0], y0 + bb[1], x0 + bb[2], y0 + bb[3])


def _mapped_text_lines(page, img):
    """page text lines as pixel boxes in the upright cropBox frame: [(x0,top,x1,bottom,text)].

    Returns [] on rotated pages (pdfplumber object coords don't map onto to_image's upright
    frame there — same limitation as `candidates`), so caption stripping is simply skipped and
    the pixel-based whitespace trim still runs.
    """
    if int(page.rotation or 0) % 360 != 0:
        return []
    cb = [float(v) for v in (page.cropbox or page.bbox)]
    left, top = cb[0], cb[1]
    cw, ch = cb[2] - cb[0], cb[3] - cb[1]
    sx, sy = img.width / cw, img.height / ch
    out = []
    try:
        lines = page.extract_text_lines()
    except Exception:
        return []
    for ln in lines:
        out.append((
            (ln["x0"] - left) * sx, (ln["top"] - top) * sy,
            (ln["x1"] - left) * sx, (ln["bottom"] - top) * sy,
            ln.get("text", "") or "",
        ))
    return out


def _strip_caption(box, lines):
    """Shrink `box` to drop the figure/table caption block. `lines` = _mapped_text_lines output.

    Find the caption marker line ("Figure 3", "Table 1", …) overlapping the box, decide whether
    it sits below the figure (normal figure caption) or above it (typical table caption) by which
    half of the box it lands in, then trim that edge past the whole contiguous caption block.
    Returns the (possibly unchanged) box; never collapses it to empty.
    """
    bx0, by0, bx1, by1 = box

    def in_box(ln):  # horizontal overlap + vertical inside (mostly) the box
        lx0, lt, lx1, lb, _ = ln
        return lx1 > bx0 and lx0 < bx1 and lb > by0 and lt < by1

    inside = [ln for ln in lines if in_box(ln)]
    markers = [ln for ln in inside if CAPTION_RE.match(ln[4])]
    if not markers:
        return box
    mx0, mt, mx1, mb, _ = min(markers, key=lambda ln: ln[1])  # topmost marker line
    midy = (by0 + by1) / 2.0

    if mt >= midy:
        # Caption below the figure: everything from the marker's top down is caption.
        new_top, new_bottom = by0, mt
    else:
        # Caption above (tables): grow through contiguous text lines below the marker so a
        # multi-line caption is fully removed, then trim the box top to just under it.
        cap_bottom = mb
        for lx0, lt, lx1, lb, _ in sorted(inside, key=lambda ln: ln[1]):
            if lt < mt:
                continue
            line_h = max(1.0, lb - lt)
            if lt - cap_bottom <= 0.9 * line_h:  # contiguous → still the caption block
                cap_bottom = max(cap_bottom, lb)
        new_top, new_bottom = cap_bottom, by1

    if new_bottom - new_top < 0.1 * (by1 - by0):  # would gut the box → leave it for the trim step
        return box
    return [bx0, new_top, bx1, new_bottom]


def cmd_tighten(args):
    from PIL import ImageDraw

    pdf, page = _load_page(args.pdf, args.page)
    img = _render_pil(page, args.dpi)
    w, h = img.size
    box = list(_to_pixels(args.bbox, args.pixels, w, h))

    box = _strip_caption(box, _mapped_text_lines(page, img))  # 1. drop caption (no-op if none)
    content = _content_bbox(img, box)                          # 2. trim whitespace to the ink
    if content is None:
        print("tighten: no ink found in the box — is the region empty or all-white?", file=sys.stderr)
        pdf.close()
        return
    pad = args.pad
    x0, y0, x1, y1 = content
    box = [max(0, x0 - pad), max(0, y0 - pad), min(w, x1 + pad), min(h, y1 + pad)]

    if args.crop:
        img.crop((int(box[0]), int(box[1]), int(box[2]), int(box[3]))).save(args.crop)
        print(f"saved crop {args.crop}  ({int(box[2]-box[0])}x{int(box[3]-box[1])}px)", file=sys.stderr)
    overlay = img.copy()
    draw = ImageDraw.Draw(overlay)
    lw = max(2, round(min(w, h) / 300))
    draw.rectangle(box, outline=(220, 30, 30), width=lw)
    overlay.save(args.out)
    print(
        f"saved overlay {args.out}  tightened rect="
        f"({int(box[0])},{int(box[1])},{int(box[2])},{int(box[3])})px",
        file=sys.stderr,
    )
    print(_order_clamp_norm(box[0], box[1], box[2], box[3], w, h))  # the bbox to store
    pdf.close()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("render", help="rasterize one page to PNG (upright cropBox frame); prints 'W H'")
    r.add_argument("pdf")
    r.add_argument("--page", type=int, required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--dpi", type=int, default=DEFAULT_DPI)
    r.set_defaults(func=cmd_render)

    n = sub.add_parser("normalize", help="pixel box on the PNG -> normalized [x0,y0,x1,y1] bbox")
    n.add_argument("--png-size", type=float, nargs=2, metavar=("W", "H"), required=True)
    n.add_argument("--pixels", type=float, nargs=4, metavar=("X0", "Y0", "X1", "Y1"), required=True)
    n.set_defaults(func=cmd_normalize)

    v = sub.add_parser("preview", help="draw the bbox on the page + crop it, to self-verify")
    v.add_argument("pdf")
    v.add_argument("--page", type=int, required=True)
    v.add_argument("--out", required=True, help="overlay PNG path")
    v.add_argument("--crop", help="optional cropped-region PNG path")
    v.add_argument("--dpi", type=int, default=DEFAULT_DPI)
    g = v.add_mutually_exclusive_group(required=True)
    g.add_argument("--bbox", type=float, nargs=4, metavar=("X0", "Y0", "X1", "Y1"), help="normalized 0..1")
    g.add_argument("--pixels", type=float, nargs=4, metavar=("X0", "Y0", "X1", "Y1"), help="pixels on the PNG")
    v.set_defaults(func=cmd_preview)

    t = sub.add_parser(
        "tighten",
        help="refine a loose box: auto-strip the caption + trim whitespace; prints the final bbox",
    )
    t.add_argument("pdf")
    t.add_argument("--page", type=int, required=True)
    t.add_argument("--out", required=True, help="overlay PNG path")
    t.add_argument("--crop", help="optional tightened-crop PNG path (read it to self-verify)")
    t.add_argument("--pad", type=int, default=6, help="px of breathing room kept around the ink")
    t.add_argument("--dpi", type=int, default=DEFAULT_DPI)
    gt = t.add_mutually_exclusive_group(required=True)
    gt.add_argument("--pixels", type=float, nargs=4, metavar=("X0", "Y0", "X1", "Y1"), help="loose box, pixels on the PNG")
    gt.add_argument("--bbox", type=float, nargs=4, metavar=("X0", "Y0", "X1", "Y1"), help="loose box, normalized 0..1")
    t.set_defaults(func=cmd_tighten)

    c = sub.add_parser("candidates", help="ASSIST: print pdfplumber-derived seed boxes (normalized)")
    c.add_argument("pdf")
    c.add_argument("--page", type=int, required=True)
    c.set_defaults(func=cmd_candidates)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
