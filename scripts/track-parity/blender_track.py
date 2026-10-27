# Tracks points through a clip with Blender's own "Track Markers" and writes the markers as a Kinetograph track file
# (the same JSON `kinetograph track` writes), for scripts/track-parity/compare.mjs. Optionally places the points with
# "Detect Features" first, and makes plane tracks from the tracked points with "Create Plane Track" after.
#
#   blender -b --factory-startup --python blender_track.py -- '<settings JSON>' OUT.json
#
# Settings: {"video", "points": [[x, y], ...] (video pixels, y down), "model", "pattern", "search", "match"
# ("keyframe" | "previous"), "minCorrelation", "margin", "from", "to", "backwards", "detect": {"margin", "threshold",
# "minDistance", "inside" | "outside": [[x, y, x, y, ...], ...] (polygons, video pixels)}, "planes": [{"name",
# "tracks": ["p1", ...] (default all)}], "trackOnly": false}. Frames are numbered from 0 as in Kinetograph; Blender's
# clip frame n is frame n - 1 here. A disabled marker Blender leaves where a track failed is listed in "lost".
# "detected" lists the detected markers' normalised positions exactly as Blender stores them (f32, v up).

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


def configure(track, name):
    track.name = name
    track.motion_model = defaults.default_motion_model
    track.pattern_match = defaults.default_pattern_match
    track.correlation_min = defaults.default_correlation_min
    track.margin = defaults.default_margin
    track.use_brute = True
    track.use_normalization = False
    track.frames_limit = 0
    track.select = True


tracks = []
for i, (x, y) in enumerate(settings.get("points", [])):
    track = clip.tracking.tracks.new(name=f"p{i + 1}", frame=start)
    track.markers.find_frame(start).co = (x / width, (height - y) / height)
    configure(track, f"p{i + 1}")
    tracks.append(track)

# A Clip Editor showing the clip, for the operators' context.
window = bpy.context.window_manager.windows[0]
area = window.screen.areas[0]
area.type = "CLIP_EDITOR"
space = area.spaces.active
space.clip = clip
region = next(r for r in area.regions if r.type == "WINDOW")
# In the background nothing moves the editor to the scene's frame; the operators start at the editor's.
scene.frame_set(start)
space.clip_user.frame_current = start
context = dict(window=window, area=area, region=region, space_data=space)

detected = []
detect = settings.get("detect")
if detect is not None:
    polygons = detect.get("inside") or detect.get("outside")
    placement = "FRAME"
    if polygons:
        # The polygons as strokes of the clip's annotation, in its normalised coordinates (v up).
        placement = "INSIDE_GPENCIL" if detect.get("inside") else "OUTSIDE_GPENCIL"
        space.annotation_source = "CLIP"
        # Python cannot add a stroke, and in the background the annotate operator cannot place one (no view), but it
        # does add one with a point per event; the points are then moved into place.
        for flat in polygons:
            n = len(flat) // 2
            events = [
                {"name": "", "location": (0, 0, 0), "mouse": (20 + 40 * i, 20 + 90 * (i % 2)), "mouse_event": (20 + 40 * i, 20 + 90 * (i % 2)), "pressure": 1.0,
                 "size": 0.0, "x_tilt": 0.0, "y_tilt": 0.0, "time": 0.0, "is_start": i == 0}
                for i in range(n)
            ]
            with bpy.context.temp_override(**context):
                bpy.ops.gpencil.annotate(mode="DRAW", wait_for_input=False, stroke=events)
            stroke = clip.annotation.layers[-1].active_frame.strokes[-1]
            if len(stroke.points) != n:
                raise SystemExit(f"annotate made {len(stroke.points)} points, not {n}")
            for i, p in enumerate(stroke.points):
                p.co = (flat[2 * i] / width, (height - flat[2 * i + 1]) / height, 0.0)
    before = len(clip.tracking.tracks)
    with bpy.context.temp_override(**context):
        result = bpy.ops.clip.detect_features(
            placement=placement,
            margin=detect.get("margin", 16),
            threshold=detect.get("threshold", 0.5),
            min_distance=detect.get("minDistance", 120),
        )
    if result != {"FINISHED"}:
        raise SystemExit(f"detect_features: {result}")
    for track in list(clip.tracking.tracks)[before:]:
        n = len(tracks) + 1
        configure(track, f"p{n}")
        m = track.markers.find_frame(start)
        detected.append([m.co[0], m.co[1]])
        tracks.append(track)
    for track in tracks:
        track.select = True

if tracks and not settings.get("detectOnly", False):
    with bpy.context.temp_override(**context):
        result = bpy.ops.clip.track_markers(backwards=backwards, sequence=True)
    if result != {"FINISHED"}:
        raise SystemExit(f"track_markers: {result}")

planes = []
for i, request in enumerate(settings.get("planes", [])):
    names = request.get("tracks")
    for track in clip.tracking.tracks:
        track.select = names is None or track.name in names
    scene.frame_set(start)
    space.clip_user.frame_current = start
    before = len(clip.tracking.plane_tracks)
    with bpy.context.temp_override(**context):
        result = bpy.ops.clip.create_plane_track()
    if result != {"FINISHED"}:
        raise SystemExit(f"create_plane_track: {result}")
    plane = clip.tracking.plane_tracks[before]
    plane.name = request.get("name", f"plane{i + 1}")
    planes.append((plane, names))


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
        path.append({"frame": frame, "center": at(u, v), "corners": [c[3], c[2], c[1], c[0]], "co": [u, v]})
    # Blender disables the marker where the track failed, and adds a disabled one a frame further on; the first is the
    # frame Kinetograph lists.
    step = -1 if backwards else 1
    tracked = {m["frame"] for m in path}
    lost = sorted(f for f in muted if f - step in tracked)
    disabled = sorted(m.frame - 1 for m in track.markers if m.mute)
    out["tracks"].append(
        {"name": track.name, "model": settings.get("model", "loc"), "frames": path, "lost": lost, "disabled": disabled}
    )
if planes:
    out["planes"] = []
    for plane, names in planes:
        pframes = []
        for m in sorted(plane.markers, key=lambda m: m.frame):
            c = [at(*p) for p in m.corners]
            pframes.append({"frame": m.frame - 1, "corners": [c[3], c[2], c[1], c[0]], "co": [list(p) for p in m.corners]})
        out["planes"].append({"name": plane.name, "tracks": names or [t.name for t in tracks], "frames": pframes})
if detect is not None:
    out["detected"] = detected

with open(out_path, "w") as f:
    json.dump(out, f)
print(
    f"wrote {out_path}: {[len(t['frames']) for t in out['tracks']]} markers, lost {[t['lost'] for t in out['tracks']]}, "
    f"{len(detected)} detected, planes {[len(p['frames']) for p in out.get('planes', [])]}"
)
