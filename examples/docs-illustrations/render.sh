#!/usr/bin/env bash
# Renders the three docs loops to 720p H.264 (no audio) and a poster .webp for each, into the docs media folder.
# Run from the repository root: examples/docs-illustrations/render.sh
# KINETOGRAPH names the CLI (default: npx kinetograph). Needs cwebp for the posters.
set -euo pipefail

KG=${KINETOGRAPH:-npx kinetograph}
ENTRY=examples/docs-illustrations/index.tsx
OUT=${OUT:-packages/site/public/docs-media/illustrations}
TMP=$(mktemp -d)
mkdir -p "$OUT"

# composition id, file name, poster frame
for spec in "Pipeline pipeline 75" "PureFrame pure-frame 143" "StudioLoop studio-loop 72"; do
  set -- $spec
  $KG render "$ENTRY" --comp "$1" --encoder libx264 --crf 25 --pixel-format yuv420p -o "$OUT/$2.mp4"
  $KG still "$ENTRY" "$3" --comp "$1" -o "$TMP/$2.png"
  cwebp -quiet -q 82 "$TMP/$2.png" -o "$OUT/$2-poster.webp"
done
rm -rf "$TMP"
ls -l "$OUT"/*.mp4 "$OUT"/*.webp
