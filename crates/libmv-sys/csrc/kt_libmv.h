/* Kinetograph's C API over libmv's AutoTrack (libmv/autotrack, MIT). Written for Kinetograph; Blender's own C API
 * (intern/libmv/intern, GPL) is not used.
 *
 * Coordinates are libmv's frame pixels: (0, 0) is the centre of the pixel in row 0, column 0 of the image the region
 * callback reads, and y grows with the row. The caller picks which way up row 0 is (Kinetograph hands rows over bottom
 * first, as Blender's image buffers are, so its tracks match Blender's). */
#ifndef KT_LIBMV_H
#define KT_LIBMV_H

#ifdef __cplusplus
extern "C" {
#endif

/* libmv::TrackRegionOptions::Mode, in Blender's order (MovieTrackingTrack.motion_model). */
enum {
  KT_MOTION_LOC = 0,
  KT_MOTION_LOC_ROT = 1,
  KT_MOTION_LOC_SCALE = 2,
  KT_MOTION_LOC_ROT_SCALE = 3,
  KT_MOTION_AFFINE = 4,
  KT_MOTION_PERSPECTIVE = 5,
};

/* Fills `out` (`width * height` floats, row-major, already zero) with the grayscale pixels of frame `frame` in the
 * rectangle whose top-left pixel is (x, y). The rectangle can reach outside the frame; those pixels stay zero. Returns
 * 0 when there is no such frame. */
typedef int (*kt_region_fn)(void *user, int frame, int x, int y, int width, int height, float *out);

typedef struct kt_marker {
  int frame;
  int track;
  float center[2];
  float patch[4][2]; /* pattern corners, absolute */
  float search_min[2];
  float search_max[2]; /* search area, absolute */
  int reference_frame; /* the frame whose pattern is matched: the previous frame, or the keyframe */
} kt_marker;

typedef struct kt_track_options {
  int motion_model; /* KT_MOTION_* */
  int backwards;
  int use_brute;
  int use_normalization;
  double minimum_correlation;
  int num_iterations;
  double sigma;
} kt_track_options;

typedef struct kt_track_result {
  int termination; /* libmv::TrackRegionResult::Termination */
  double correlation;
  int num_iterations;
} kt_track_result;

typedef struct kt_tracker kt_tracker;

/* Blender's defaults for a new track: Loc, brute-force start on, no normalization, minimum correlation 0.75, and the
 * fixed 50 iterations and sigma 0.9 Blender always passes. */
void kt_track_options_default(kt_track_options *options);

kt_tracker *kt_tracker_new(int width, int height, int num_frames, kt_region_fn region_fn, void *user);
void kt_tracker_free(kt_tracker *tracker);

/* Stores a marker for prediction and as a reference pattern: a placed one (`tracked` 0) or a tracking result (1). */
void kt_tracker_add_marker(kt_tracker *tracker, const kt_marker *marker, int tracked);

/* Tracks `marker` into marker->frame: on entry it holds the guess (the previous frame's marker moved to the new frame
 * number, reference_frame set); on return, the tracked position. Returns 1 when the result is usable. */
int kt_tracker_track(kt_tracker *tracker, const kt_track_options *options, kt_marker *marker,
                     kt_track_result *result);

#ifdef __cplusplus
}
#endif

#endif /* KT_LIBMV_H */
