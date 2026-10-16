#!/bin/sh
# Rebuilds public/fx from the licensed overlay packs in ~/Downloads (not committed: third-party packs), at 1080p.
set -e
D="$HOME/Downloads"
O="$(dirname "$0")/../public/fx"
mkdir -p "$O"
enc() { ffmpeg -v error -y $4 -i "$1" -vf "$2" -c:v libx264 -crf ${5:-18} -preset slow -pix_fmt yuv420p -an -movflags +faststart "$3"; }
enc "$D/TEXT ANIMATION OVERLAYS/ASSETS/\"FILM\" txt.mp4" "crop=2160:1215:0:1312,scale=1920:1080" "$O/hand-film.mp4"
enc "$D/TEXT ANIMATION OVERLAYS/ASSETS/\"IMPACT\" txt.mp4" "crop=2160:1215:0:1312,scale=1920:1080" "$O/hand-impact.mp4"
enc "$D/CUSTOM TRANSITIONS/FILM BURNS/16mm burn 01.mov" "scale=1920:1080" "$O/burn-16mm-01.mp4"
enc "$D/GRUNGE OVERLAYS/overlay_2.mp4" "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080" "$O/grunge-02.mp4"
enc "$D/GRUNGE OVERLAYS/overlay_6.mp4" "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080" "$O/grunge-06.mp4" "-t 4" 30
# Stills of each, for the style frames.
for f in "$O"/*.mp4; do
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
  ffmpeg -v error -y -ss "$(echo "$d * 0.55" | bc)" -i "$f" -frames:v 1 "${f%.mp4}.png"
done
ffmpeg -v error -y -ss 0.3 -i "$O/burn-16mm-01.mp4" -frames:v 1 "$O/burn-16mm-01.png"
ffmpeg -v error -y -f lavfi -i color=c=black@0.0:s=8x8,format=rgba -frames:v 1 "$O/clear.png"
