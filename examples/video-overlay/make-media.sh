#!/bin/sh
# Generates the example's media with ffmpeg's test sources, so the repo holds
# no real footage: a 6 s 640x360 clip of `testsrc2` with a 440 Hz tone that
# beeps once a second, and a 2 s looping GIF badge. Run from this directory;
# the outputs are committed, so this is only needed to remake them.
set -eu
cd "$(dirname "$0")"
ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=30:duration=6" \
  -f lavfi -i "sine=frequency=440:beep_factor=2:sample_rate=48000:duration=6" \
  -c:v libx264 -preset veryslow -crf 34 -g 30 -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
  -c:a aac -b:a 48k -movflags +faststart -shortest \
  public/clip.mp4
ffmpeg -v error -y \
  -f lavfi -i "testsrc=size=120x120:rate=10:duration=2" \
  -vf "split[a][b];[a]palettegen=max_colors=32[p];[b][p]paletteuse" -loop 0 \
  public/badge.gif
