#!/usr/bin/env python3
"""Generate a tiny, valid multi-page PDF with no third-party dependencies.

Used only to give Paper Reader something to open during a smoke test. Writes
papers/sample.pdf. Pure stdlib — no PyMuPDF/MinerU/Marker (license rule).
"""
import sys
import zlib  # noqa: F401  (kept for parity; not strictly needed)


def text_stream(lines):
    body = ["BT", "/F1 16 Tf", "72 720 Td", "18 TL"]
    for ln in lines:
        esc = ln.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        body.append(f"({esc}) Tj")
        body.append("T*")
    body.append("ET")
    return "\n".join(body).encode("latin-1")


def build(path):
    pages_text = [
        ["Paper Reader - Sample Document", "", "Page 1",
         "This is a placeholder PDF for smoke-testing the left pane.",
         "Drop a real paper into papers/ to read it for real."],
        ["Page 2", "", "The right pane renders the schema-validated summary",
         "written by the paper-summarizer skill."],
    ]

    objects = []  # list of raw object byte bodies (without the "N 0 obj" wrapper)

    # 1: Catalog, 2: Pages, 3..: page+content+font
    # We lay out object numbers up front.
    n_pages = len(pages_text)
    catalog_num = 1
    pages_num = 2
    font_num = 3
    first_page_num = 4
    # page objects then their content streams interleaved
    page_nums = [first_page_num + i * 2 for i in range(n_pages)]
    content_nums = [first_page_num + i * 2 + 1 for i in range(n_pages)]

    objects.append((catalog_num,
                    f"<< /Type /Catalog /Pages {pages_num} 0 R >>".encode()))
    kids = " ".join(f"{p} 0 R" for p in page_nums)
    objects.append((pages_num,
                    f"<< /Type /Pages /Count {n_pages} /Kids [{kids}] >>".encode()))
    objects.append((font_num,
                    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"))

    for i in range(n_pages):
        stream = text_stream(pages_text[i])
        page = (
            f"<< /Type /Page /Parent {pages_num} 0 R "
            f"/MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 {font_num} 0 R >> >> "
            f"/Contents {content_nums[i]} 0 R >>"
        ).encode()
        objects.append((page_nums[i], page))
        content = b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"
        objects.append((content_nums[i], content))

    objects.sort(key=lambda o: o[0])

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for num, body in objects:
        offsets[num] = len(out)
        out += f"{num} 0 obj\n".encode() + body + b"\nendobj\n"

    xref_pos = len(out)
    max_num = max(offsets)
    out += b"xref\n"
    out += f"0 {max_num + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for num in range(1, max_num + 1):
        out += f"{offsets[num]:010d} 00000 n \n".encode()
    out += b"trailer\n"
    out += f"<< /Size {max_num + 1} /Root {catalog_num} 0 R >>\n".encode()
    out += b"startxref\n"
    out += f"{xref_pos}\n".encode()
    out += b"%%EOF\n"

    with open(path, "wb") as f:
        f.write(out)
    print(f"wrote {path} ({len(out)} bytes, {n_pages} pages)")


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "papers/sample.pdf")
