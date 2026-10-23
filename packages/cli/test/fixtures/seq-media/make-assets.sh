#!/bin/bash
# Writes assets/click.wav (clicks every 20 frames at 30 fps) and assets/gray.mp4 (grey level = 2 * frame index).
set -e
cd "$(dirname "$0")"
mkdir -p assets
# 4 s at 48 kHz mono: a 20 ms 1 kHz burst at t = 0, 2/3 s, 4/3 s ...
ffmpeg -y -loglevel error -f lavfi -i "aevalsrc='if(lt(mod(t,2/3),0.02),0.8*sin(2*PI*1000*t),0)':s=48000:d=4" assets/click.wav
ffmpeg -y -loglevel error -f lavfi -i "color=c=black:s=160x90:r=30:d=4,geq=lum='2*N':cb=128:cr=128" -pix_fmt yuv420p -c:v libx264 -crf 10 -g 1 -color_range tv assets/gray.mp4
