#!/usr/bin/env bash
# Regenerates the test clips next to this script. They are made entirely by
# ffmpeg's synthetic sources (testsrc, testsrc2, sine) and Pillow, so no real
# footage is committed. The files are committed; run this only to change them.
#
#   clip.mp4        64x36, 24 fps, 2 s, H.264 with B-frames and a keyframe every
#                   12 pictures (so seeking is exercised), no audio.
#   offset.webm     48x28, 25 fps, 1.2 s, VP9, first picture at 0.48 s (not 0).
#   with-audio.mp4  64x36, 24 fps, 1 s of H.264 and a 440 Hz stereo AAC track.
#   tone-mono.wav   8 kHz mono 16-bit, 0.25 s of a 440 Hz sine.
#   surround.wav    8 kHz six-channel 16-bit, 0.1 s (the front left carries a
#                   440 Hz sine, the other five are silent).
#   spinner.gif     32x24, five pictures with delays 0, 10, 40, 200 and 60 ms
#                   (make_gif.py).
#
# Needs ffmpeg with libx264, libvpx-vp9 and aac, and python3 with Pillow.
set -euo pipefail
cd "$(dirname "$0")"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=64x36:rate=24:duration=2" \
  -c:v libx264 -preset veryslow -crf 32 -pix_fmt yuv420p -g 12 -keyint_min 12 -sc_threshold 0 -bf 2 \
  -x264-params "open-gop=0:threads=1" -movflags +faststart -an clip.mp4

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc=size=48x28:rate=25:duration=1.2" \
  -vf "setpts=PTS+0.5/TB" \
  -c:v libvpx-vp9 -b:v 0 -crf 45 -g 10 -deadline good -cpu-used 5 -pix_fmt yuv420p -an offset.webm

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=64x36:rate=24:duration=1" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=1" \
  -c:v libx264 -preset veryslow -crf 34 -pix_fmt yuv420p -g 8 \
  -c:a aac -b:a 24k -ac 2 -shortest with-audio.mp4

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.25" \
  -ac 1 -c:a pcm_s16le tone-mono.wav

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.1" \
  -af "pan=5.1|FL=c0|FR=0*c0|FC=0*c0|LFE=0*c0|BL=0*c0|BR=0*c0" \
  -c:a pcm_s16le surround.wav

python3 make_gif.py spinner.gif
