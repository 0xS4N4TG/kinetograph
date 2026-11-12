"""Derive the site's pixel mark and icons from public/retro/engine-mark.webp.

The mark is the site's own pixel drawing of the mechanism (two spoked wheels, the camera body and lens, the film
loop), cropped to the mechanism, area-averaged down to a square dot grid and thresholded: white dots on cobalt.
Deterministic; run from packages/site:  python3 scripts/mark.py
  python3 scripts/mark.py --sheet DIR   writes candidate sheets (grids and thresholds) for judging
"""
import struct
import sys
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'public/retro/engine-mark.webp'
COBALT = (0x22, 0x38, 0xC4)
WHITE = (255, 255, 255)

# Crop to the mechanism, ground shadow dropped (it turns to a smear at this size). Source pixels, x0 y0 x1 y1.
CROP = (104, 72, 752, 724)
GRID = 40  # dots per side, margin included
MARGIN = 2  # empty dots around the drawing
BLUR = 8  # source pixels at the 36-dot inner size (scaled for other grids); the drawing is dithered, so blur first or the thin rims drop out
THRESHOLD = 0.28  # coverage (0..1) at which a dot turns white
# The 1x mark (40 dots) crops tighter, base dropped, so the mechanism fills the square.
CROP_1X = (108, 76, 750, 706)
# Denser grids are drawn almost as the picture is (its own dots are about 4 source pixels): no blur, no cleaning.
DENSE = dict(threshold=0.4, blur=0, clean=False)


def dense(grid):
    return dots(grid, round(grid * 0.05), **DENSE)


# Hand fixes after thresholding, as (x, y, on) in dot coordinates of the final grid.
FIXES: list[tuple[int, int, bool]] = []


def dots(grid=GRID, margin=MARGIN, threshold=THRESHOLD, crop=CROP, fixes=FIXES, blur=BLUR, clean=True):
    """Return the grid as rows of 0/1."""
    im = Image.open(SRC).convert('L').crop(crop)
    inner = grid - 2 * margin
    w, h = im.size
    side = max(w, h)  # pad to a square, drawing centred
    sq = Image.new('L', (side, side), 0)
    sq.paste(im, ((side - w) // 2, (side - h) // 2))
    sq = sq.filter(ImageFilter.GaussianBlur(blur * 36 / inner))
    small = sq.resize((inner, inner), Image.BOX)  # area average
    cov = small.load()
    rows = [[0] * grid for _ in range(grid)]
    for y in range(inner):
        for x in range(inner):
            if cov[x, y] / 255 >= threshold:
                rows[y + margin][x + margin] = 1
    # Drop dots with no neighbour: dither leftovers that read as dirt at this size.
    keep = rows if not clean else [[v and any(rows[j][i] for j in range(max(0, y - 1), min(grid, y + 2)) for i in range(max(0, x - 1), min(grid, x + 2)) if (i, j) != (x, y)) for x, v in enumerate(row)] for y, row in enumerate(rows)]
    rows = [[1 if v else 0 for v in row] for row in keep]
    for x, y, on in fixes:
        rows[y][x] = 1 if on else 0
    return rows


def render(rows, scale=1, bg=COBALT):
    n = len(rows)
    im = Image.new('RGB', (n, n), bg)
    px = im.load()
    for y in range(n):
        for x in range(n):
            if rows[y][x]:
                px[x, y] = WHITE
    return im if scale == 1 else im.resize((n * scale, n * scale), Image.NEAREST)


def icon(size, rows):
    """A square icon of `size` px from a grid whose dots map to whole pixels (size is a multiple of the grid)."""
    n = len(rows)
    assert size % n == 0, (size, n)
    return render(rows, size // n)


def write_ico(path, images):
    """PNG-in-ICO, one entry per image (sizes <= 255)."""
    blobs = []
    for im in images:
        from io import BytesIO
        b = BytesIO()
        im.convert('RGBA').save(b, 'PNG', optimize=True)  # the ICO decoder in Next wants RGBA
        blobs.append(b.getvalue())
    head = struct.pack('<HHH', 0, 1, len(images))
    off = 6 + 16 * len(images)
    ent = b''
    for im, b in zip(images, blobs):
        ent += struct.pack('<BBBBHHII', im.width, im.height, 0, 0, 1, 32, len(b), off)
        off += len(b)
    Path(path).write_bytes(head + ent + b''.join(blobs))


def main():
    if len(sys.argv) > 2 and sys.argv[1] == '--sheet':
        out = Path(sys.argv[2])
        out.mkdir(parents=True, exist_ok=True)
        for g in (32, 40, 48):
            for m in (2, 3):
                for t in (0.24, 0.28, 0.32):
                    r = dots(g, m, t)
                    sheet = Image.new('RGB', (g * 8 + g + 8, g * 8), (40, 40, 40))
                    sheet.paste(render(r, 8), (0, 0))
                    sheet.paste(render(r, 1), (g * 8 + 4, 4))
                    sheet.save(out / f'g{g}-m{m}-t{int(t * 100)}.png')
        return
    pub = ROOT / 'public/retro'
    app = ROOT / 'src/app'
    # The site mark, shown at 40 CSS px: each density has its own grid, one dot per device pixel (40, 80, 120, 160).
    render(dots(40, 1, 0.3, crop=CROP_1X, blur=4), 1).save(pub / 'mark-40.png', optimize=True)
    for k in (2, 3, 4):
        render(dense(40 * k), 1).save(pub / f'mark-40@{k}x.png', optimize=True)
    # Icons: the denser the grid, the more of the real drawing; 32 px keeps the blurred 32-dot version.
    icon(32, dots(32, 2)).save(app / 'icon.png', optimize=True)
    icon(180, dense(180)).save(app / 'apple-icon.png', optimize=True)
    icon(192, dense(192)).save(app / 'icon1.png', optimize=True)
    icon(512, dense(128)).save(app / 'icon2.png', optimize=True)
    # 16 px: the hand-reduced drawing above, one dot per pixel.
    write_ico(app / 'favicon.ico', [icon(16, dots16()), icon(32, dots(32, 2)), icon(48, dots(48, 3))])


# The 16 px favicon: the full drawing is noise at this size, so it is redrawn with only the big shapes of the same
# picture: the upper wheel, the larger lower wheel overlapping it (with a hub), the body plate with the lens
# window, and the base.
def dots16():
    g = [[0] * 16 for _ in range(16)]

    def ring(cx, cy, r):
        for y in range(16):
            for x in range(16):
                if r - 0.55 <= ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 <= r + 0.45:
                    g[y][x] = 1

    ring(4.0, 4.0, 2.8)  # upper wheel
    ring(4.5, 9.5, 3.8)  # lower wheel
    for y, x in ((9, 4), (9, 5), (10, 4), (10, 5)):  # hub
        g[y][x] = 1
    for y in range(2, 14):  # body plate
        for x in range(10, 15):
            g[y][x] = 1
    for y in (6, 7):  # lens window
        g[y][11] = g[y][12] = 0
    for x in range(9, 15):  # base
        g[14][x] = 1
    return g


if __name__ == '__main__':
    main()
