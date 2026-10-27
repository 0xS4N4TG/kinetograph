// Kinetograph's C API over libmv's AutoTrack. See kt_libmv.h.

#include "kt_libmv.h"

#include <new>

#include "libmv/autotrack/autotrack.h"
#include "libmv/autotrack/frame_accessor.h"
#include "libmv/autotrack/marker.h"
#include "libmv/autotrack/region.h"
#include "libmv/tracking/track_region.h"

namespace {

using libmv::FloatImage;
using libmv::TrackRegionOptions;
using libmv::TrackRegionResult;
using mv::FrameAccessor;
using mv::Marker;
using mv::Region;

// One clip of grayscale frames, read from the caller one region at a time. The part of a region outside the frame is
// zero, as in Blender's accessor.
class CallbackAccessor : public FrameAccessor {
 public:
  CallbackAccessor(int width, int height, int num_frames, kt_region_fn fn, void *user)
      : width_(width), height_(height), num_frames_(num_frames), fn_(fn), user_(user) {}

  Key GetImage(int clip, int frame, InputMode input_mode, int downscale, const Region *region,
               const Transform *transform, FloatImage *destination) override {
    // AutoTrack asks for MONO, no downscale and no transform (no disabled channels).
    if (clip != 0 || input_mode != MONO || downscale != 0 || transform != nullptr) return nullptr;
    int min_x = 0, min_y = 0, w = width_, h = height_;
    if (region != nullptr) {
      min_x = int(region->min(0));
      min_y = int(region->min(1));
      w = int(region->max(0) - region->min(0));
      h = int(region->max(1) - region->min(1));
    }
    if (w <= 0 || h <= 0) return nullptr;
    destination->Resize(h, w, 1);
    destination->Fill(0.0f);
    if (!fn_(user_, frame, min_x, min_y, w, h, destination->Data())) return nullptr;
    return this;  // Any non-null key; the image is owned by `destination`.
  }

  void ReleaseImage(Key) override {}
  Key GetMaskForTrack(int, int, int, const Region *, FloatImage *) override { return nullptr; }
  void ReleaseMask(Key) override {}

  bool GetClipDimensions(int clip, int *width, int *height) override {
    if (clip != 0) return false;
    *width = width_;
    *height = height_;
    return true;
  }
  int NumClips() override { return 1; }
  int NumFrames(int clip) override { return clip == 0 ? num_frames_ : 0; }

 private:
  int width_, height_, num_frames_;
  kt_region_fn fn_;
  void *user_;
};

Marker ToMarker(const kt_marker &m, Marker::Source source) {
  Marker out;
  out.clip = 0;
  out.frame = m.frame;
  out.track = m.track;
  out.center << m.center[0], m.center[1];
  for (int i = 0; i < 4; ++i) {
    out.patch.coordinates(i, 0) = m.patch[i][0];
    out.patch.coordinates(i, 1) = m.patch[i][1];
  }
  out.search_region.min << m.search_min[0], m.search_min[1];
  out.search_region.max << m.search_max[0], m.search_max[1];
  out.weight = 1.0f;
  out.source = source;
  out.status = Marker::UNKNOWN;
  out.reference_clip = 0;
  out.reference_frame = m.reference_frame;
  out.model_type = Marker::POINT;
  out.model_id = 0;
  out.disabled_channels = 0;
  return out;
}

void FromMarker(const Marker &m, kt_marker *out) {
  out->frame = m.frame;
  out->track = m.track;
  out->center[0] = m.center(0);
  out->center[1] = m.center(1);
  for (int i = 0; i < 4; ++i) {
    out->patch[i][0] = m.patch.coordinates(i, 0);
    out->patch[i][1] = m.patch.coordinates(i, 1);
  }
  out->search_min[0] = m.search_region.min(0);
  out->search_min[1] = m.search_region.min(1);
  out->search_max[0] = m.search_region.max(0);
  out->search_max[1] = m.search_region.max(1);
  out->reference_frame = m.reference_frame;
}

TrackRegionOptions::Mode ToMode(int motion_model) {
  switch (motion_model) {
    case KT_MOTION_LOC_ROT: return TrackRegionOptions::TRANSLATION_ROTATION;
    case KT_MOTION_LOC_SCALE: return TrackRegionOptions::TRANSLATION_SCALE;
    case KT_MOTION_LOC_ROT_SCALE: return TrackRegionOptions::TRANSLATION_ROTATION_SCALE;
    case KT_MOTION_AFFINE: return TrackRegionOptions::AFFINE;
    case KT_MOTION_PERSPECTIVE: return TrackRegionOptions::HOMOGRAPHY;
    default: return TrackRegionOptions::TRANSLATION;
  }
}

}  // namespace

struct kt_tracker {
  CallbackAccessor accessor;
  mv::AutoTrack autotrack;
  kt_tracker(int w, int h, int n, kt_region_fn fn, void *user) : accessor(w, h, n, fn, user), autotrack(&accessor) {}
};

extern "C" {

void kt_track_options_default(kt_track_options *o) {
  o->motion_model = KT_MOTION_LOC;
  o->backwards = 0;
  o->use_brute = 1;
  o->use_normalization = 0;
  o->minimum_correlation = 0.75;
  o->num_iterations = 50;
  o->sigma = 0.9;
}

kt_tracker *kt_tracker_new(int width, int height, int num_frames, kt_region_fn region_fn, void *user) {
  try {
    return new kt_tracker(width, height, num_frames, region_fn, user);
  } catch (...) {
    return nullptr;
  }
}

void kt_tracker_free(kt_tracker *tracker) { delete tracker; }

void kt_tracker_add_marker(kt_tracker *tracker, const kt_marker *marker, int tracked) {
  try {
    tracker->autotrack.AddMarker(ToMarker(*marker, tracked ? Marker::TRACKED : Marker::MANUAL));
  } catch (...) {
  }
}

int kt_tracker_track(kt_tracker *tracker, const kt_track_options *o, kt_marker *marker, kt_track_result *result) {
  try {
    // The options Blender's tracker passes (tracking_configure_tracker and libmv's C API in Blender 4.5).
    TrackRegionOptions options;
    options.direction = o->backwards ? TrackRegionOptions::BACKWARD : TrackRegionOptions::FORWARD;
    options.mode = ToMode(o->motion_model);
    options.minimum_correlation = o->minimum_correlation;
    options.max_iterations = o->num_iterations;
    options.sigma = o->sigma;
    options.num_extra_points = 1;
    options.image1_mask = nullptr;
    options.use_brute_initialization = o->use_brute != 0;
    options.attempt_refine_before_brute = false;
    options.use_normalized_intensities = o->use_normalization != 0;

    Marker tracked = ToMarker(*marker, Marker::TRACKED);
    TrackRegionResult r;
    r.termination = TrackRegionResult::FAILURE;  // TrackMarker leaves it unset when a frame is missing.
    r.correlation = 0.0;
    r.num_iterations = 0;
    const bool ok = tracker->autotrack.TrackMarker(&tracked, &r, &options);
    FromMarker(tracked, marker);
    if (result != nullptr) {
      result->termination = int(r.termination);
      result->correlation = r.correlation;
      result->num_iterations = r.num_iterations;
    }
    return ok && r.is_usable() ? 1 : 0;
  } catch (...) {
    return 0;
  }
}

}  // extern "C"
