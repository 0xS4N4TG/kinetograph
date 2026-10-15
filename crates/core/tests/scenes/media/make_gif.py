"""Writes the test GIF: five 32x24 pictures with known delays and disposal.

Pictures 0 to 3 are solid red, green, blue and yellow; picture 3 is disposed to
the background, so picture 4, which is transparent but for a white square,
has transparent corners. Delays in milliseconds (GIF stores hundredths of a
second): 0, 10, 40, 200, 60.
"""
import sys

from PIL import Image, ImageDraw

W, H = 32, 24
SOLID = [(220, 30, 30), (30, 200, 60), (30, 60, 220), (240, 220, 40)]

frames = [Image.new("RGBA", (W, H), colour + (255,)) for colour in SOLID]
last = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ImageDraw.Draw(last).rectangle([12, 8, 19, 15], fill=(255, 255, 255, 255))
frames.append(last)

frames[0].save(
    sys.argv[1],
    save_all=True,
    append_images=frames[1:],
    duration=[0, 10, 40, 200, 60],
    loop=0,
    disposal=[1, 1, 1, 2, 1],
    optimize=False,
)
