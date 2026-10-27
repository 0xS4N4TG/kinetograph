# Tracks points through a clip with Blender's own "Track Markers" and writes the markers as a Kinetograph track file
# (the same JSON `kinetograph track` writes), for scripts/track-parity/compare.mjs.
#
#   blender -b --factory-startup --python blender_track.py -- '<settings JSON>' OUT.json
#
# Settings: {"video", "points": [[x, y], ...] (video pixels, y down), "model", "pattern", "search", "match"
# ("keyframe" | "previous"), "minCorrelation", "margin", "from", "to", "backwards"}. Frames are numbered from 0 as in
# Kinetograph; Blender's clip frame n is frame n - 1 here. A disabled marker Blender leaves where a track failed is
# listed in "lost".

import json
import sys

import bpy

settings = json.loads(sys.argv[sys.argv.index("--") + 1])
out_path = sys.argv[sys.argv.index("--") + 2]

MODELS = {
    "loc": "Loc",
    "locrot": "LocRot",
    "locscale": "LocScale",
    "locrotscale": "LocRotScale",
    "affine": "Affine",
    "perspective": "Perspective",
}

clip = bpy.data.movieclips.load(settings["video"])
clip.frame_start = 1
clip.frame_offset = 0
width, height = clip.size
frames = clip.frame_duration

first = settings.get("from", 0)
last = settings.get("to", frames - 1)
backwards = settings.get("backwards", False)
start = (last if backwards else first) + 1  # Blender's frame number

scene = bpy.context.scene
scene.frame_start = first + 1
scene.frame_end = last + 1

defaults = clip.tracking.settings
defaults.default_pattern_size = settings.get("pattern", 21)
defaults.default_search_size = settings.get("search", 71)
defaults.default_motion_model = MODELS[settings.get("model", "loc")]
defaults.default_pattern_match = "PREV_FRAME" if settings.get("match") == "previous" else "KEYFRAME"
defaults.default_correlation_min = settings.get("minCorrelation", 0.75)
defaults.default_margin = settings.get("margin", 0)
defaults.use_default_brute = True
defaults.use_default_normalization = False
defaults.default_frames_limit = 0

tracks = []
for i, (x, y) in enumerate(settings["points"]):
    track = clip.tracking.tracks.new(name=f"p{i + 1}", frame=start)
    track.markers.find_frame(start).co = (x / width, 1.0 - y / height)
    track.motion_model = defaults.default_motion_model
    track.pattern_match = defaults.default_pattern_match
    track.correlation_min = defaults.default_correlation_min
    track.margin = defaults.default_margin
    track.use_brute = True
    track.use_normalization = False
    track.frames_limit = 0
    track.select = True
    tracks.append(track)

# A Clip Editor showing the clip, for the operator's context.
window = bpy.context.window_manager.windows[0]
area = window.screen.areas[0]
area.type = "CLIP_EDITOR"
space = area.spaces.active
space.clip = clip
region = next(r for r in area.regions if r.type == "WINDOW")
# In the background nothing moves the editor to the scene's frame; the operator starts at the editor's.
scene.frame_set(start)
space.clip_user.frame_current = start
with bpy.context.temp_override(window=window, area=area, region=region, space_data=space):
    result = bpy.ops.clip.track_markers(backwards=backwards, sequence=True)
if result != {"FINISHED"}:
    raise SystemExit(f"track_markers: {result}")


def at(u, v):
    return [u * width, (1.0 - v) * height]


out = {"version": 1, "clip": {"width": width, "height": height, "fps": clip.fps, "frames": frames}, "tracks": []}
for track in tracks:
    path, muted = [], set()
    for m in sorted(track.markers, key=lambda m: m.frame):
        frame = m.frame - 1
        if frame < first or frame > last:
            continue
        if m.mute:
            muted.add(frame)
            continue
        u, v = m.co
        c = [at(u + p[0], v + p[1]) for p in m.pattern_corners]
        path.append({"frame": frame, "center": at(u, v), "corners": [c[3], c[2], c[1], c[0]]})
    # Blender disables the marker where the track failed, and adds a disabled one a frame further on; the first is the
    # frame Kinetograph lists.
    step = -1 if backwards else 1
    tracked = {m["frame"] for m in path}
    lost = sorted(f for f in muted if f - step in tracked)
    out["tracks"].append({"name": track.name, "model": settings.get("model", "loc"), "frames": path, "lost": lost})

with open(out_path, "w") as f:
    json.dump(out, f)
print(f"wrote {out_path}: {[len(t['frames']) for t in out['tracks']]} markers, lost {[t['lost'] for t in out['tracks']]}")
