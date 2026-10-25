# launch-film

**Status:** active
**Paths:** `examples/launch/**`
**Last touched:** 2026-10-25

## What this is
The Kinetograph launch film (examples/launch), rendered by Kinetograph itself.

## Current state
- v13 final: pauses in the voice (respace.py), s11 receipts scene back, bold numbers, wordmark reveal "kinetograph." with red dot.
- End card stills: examples/launch/out/stills/kinetograph-endcard.png (with "rendered in 26 s") and kinetograph-endcard-clean.png.
- Now deterministic at any worker count (see engine).

## Open threads
- [ ] s09 film strip still shows old thin "98%" self-stills
- [ ] Update examples/launch/HANDOFF.md

## Key files
- `examples/launch/print/captions.tsx:124` (hot-word caption that exposed the island bug)
- `examples/launch/out/` (gitignored renders)

## Recent sessions
- 2026-10-25-release-and-fixes — v13 final (~39.5 s, 1184 frames); end-card stills made; renders in ~26-30 s
