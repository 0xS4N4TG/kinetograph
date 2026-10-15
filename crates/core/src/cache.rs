//! Finished layer textures kept from one frame to the next.
//!
//! A layer that has not changed since the last frame draws the same texture
//! again, so the renderer keeps the texture a layer was blended from and
//! blends it again, skipping the raster, the effects, the clip, mask and
//! matte, and a group's whole subtree. A cached texture is only used when
//! everything it was made from is equal to what it is made from now, compared
//! exactly (the resolved layer, `PartialEq`, no hashing): any difference, in
//! any field, redraws the layer. What a layer's texture is made from:
//!
//! - the resolved layer and, below a group, its whole subtree, motion blur
//!   samples included. Every value that changes from frame to frame is in it:
//!   keyframed numbers are resolved, and what a pass reads of the frame (a
//!   grain's or dither's `frame`, a custom shader's `frame` and `time`, the
//!   noise seeds) is a field of the effect. The layer's own `opacity` and
//!   `blend_mode` are not: they are applied when the texture is blended, not
//!   when it is made (a motion-blurred layer's samples carry theirs);
//! - the matrix of the layer's parent, which places it on the canvas;
//! - its matte source, resolved, since the source is drawn through it;
//! - for a layer warped by a 3D placement, the placement and the camera's
//!   projection that the warp pass is given; the camera only for a layer
//!   with something placed in 3D inside it, so a camera that moves leaves
//!   flat layers alone;
//! - for a motion-blurred layer, the opacity its samples are weighted by.
//!
//! Nothing else about a frame is read by the passes that make a layer's
//! texture: the scene (fonts, images, tables, shaders) is the renderer's own
//! and does not change, so a cache belongs to one renderer and one scene. A
//! layer that blurs what is behind it (or has a matte source that does) is
//! never cached, because its texture is made from the canvas under it.
//!
//! An entry is found by the layer's id and the ids of the groups it is in, and
//! only lives while the frames keep drawing the layer: what a frame does not
//! use is dropped when it ends, so the cache holds no more than a frame
//! needs, and no more than `limit` bytes.

use std::collections::BTreeMap;

use glam::DMat4;
use vello::kurbo::Affine;

use crate::pool::Pooled;
use crate::resolve::{ResolvedEffect, ResolvedKind, ResolvedLayer};
use crate::warp;

/// Everything a layer's finished texture is made from (see the module), by
/// reference. The caller works it out for the layer being drawn.
#[derive(Clone, Copy)]
pub struct Inputs<'a> {
    pub layer: &'a ResolvedLayer,
    /// The layer's matte source, among its siblings, if it has a matte.
    pub matte: Option<&'a ResolvedLayer>,
    /// The flat matrix of the layer's parent.
    pub parent: Affine,
    /// The 3D placement the texture is warped by: the matrix of the space it
    /// is in and its world matrix. `None` for a layer that is not warped, and
    /// for one with motion blur, whose samples are placed one by one.
    pub placement: Option<(Affine, DMat4)>,
    /// The camera's projection, for a layer that something in 3D is in.
    pub projection: Option<DMat4>,
    /// For a motion-blurred layer, the opacity its samples are weighted by.
    pub opacity_scale: Option<f32>,
}

/// An owned copy of `Inputs`, kept with the texture.
struct Key {
    layer: ResolvedLayer,
    matte: Option<ResolvedLayer>,
    parent: Affine,
    placement: Option<(Affine, DMat4)>,
    projection: Option<DMat4>,
    opacity_scale: Option<f32>,
}

impl Key {
    fn of(inputs: &Inputs) -> Key {
        Key {
            layer: inputs.layer.clone(),
            matte: inputs.matte.cloned(),
            parent: inputs.parent,
            placement: inputs.placement,
            projection: inputs.projection,
            opacity_scale: inputs.opacity_scale,
        }
    }

    fn matches(&self, inputs: &Inputs) -> bool {
        same_texture(&self.layer, inputs.layer)
            && self.matte.as_ref() == inputs.matte
            && self.parent == inputs.parent
            && self.placement == inputs.placement
            && self.projection == inputs.projection
            && self.opacity_scale == inputs.opacity_scale
    }
}

/// Whether two resolved layers give the same texture: every field but the
/// ones applied when it is blended. All fields are named, so a field added to
/// `ResolvedLayer` stops this compiling until it is put on one side or the
/// other.
fn same_texture(a: &ResolvedLayer, b: &ResolvedLayer) -> bool {
    let ResolvedLayer {
        id,
        transform,
        opacity: _,
        blend_mode: _,
        effects,
        clip,
        mask,
        matte,
        kind,
        // Where the layer sits in a layout is in its transform already.
        item: _,
        motion,
    } = a;
    *id == b.id
        && *transform == b.transform
        && *effects == b.effects
        && *clip == b.clip
        && *mask == b.mask
        && *matte == b.matte
        && *kind == b.kind
        && *motion == b.motion
}

/// Whether `layer` blurs what is behind it, anywhere in it: in its own
/// effects, those of a layer inside it or in one of its motion blur samples,
/// whatever the radius is at this frame (below the blur's minimum it does
/// nothing now, and not at another frame).
pub fn mentions_backdrop(layer: &ResolvedLayer) -> bool {
    layer
        .effects
        .iter()
        .any(|e| matches!(e, ResolvedEffect::BackdropBlur { .. }))
        || layer.motion.iter().any(mentions_backdrop)
        || matches!(&layer.kind, ResolvedKind::Group { children, .. } if children.iter().any(mentions_backdrop))
}

/// Whether drawing `layer` can depend on the camera: it or a layer inside it
/// (or a motion blur sample of either) is moved in 3D, or is a `preserve3d`
/// group, whose children are placed by the camera whatever the group's own
/// transform is.
pub fn uses_projection(layer: &ResolvedLayer) -> bool {
    warp::layer_world(&layer.transform).is_some()
        || layer.motion.iter().any(uses_projection)
        || matches!(&layer.kind, ResolvedKind::Group { children, preserve3d, .. }
            if *preserve3d || children.iter().any(uses_projection))
}

struct Entry<T> {
    key: Key,
    /// `None` for a layer that was drawn without a texture of its own, which
    /// `note` records: the layer is only known to have been this.
    texture: Option<T>,
    /// The frame it was last made or used in.
    round: u64,
}

/// A texture the cache found for a layer, taken out of it while it is used.
/// Give it back with `LayerCache::put_back`.
pub struct Hit<T>(Entry<T>);

impl<T> Hit<T> {
    pub fn texture(&self) -> &T {
        self.0
            .texture
            .as_ref()
            .expect("a hit has the texture of its entry")
    }
}

pub struct LayerCache<T: Pooled> {
    enabled: bool,
    /// Sorted, so that what is dropped comes back in the same order each time.
    entries: BTreeMap<Vec<String>, Entry<T>>,
    /// Counts the frames; an entry whose `round` is not the current one was
    /// not used by the frame.
    round: u64,
    bytes: u64,
    limit: u64,
    hits: u64,
    misses: u64,
}

impl<T: Pooled> LayerCache<T> {
    /// An empty cache that keeps up to `limit` bytes of textures. It starts
    /// off: it keeps nothing until `set_enabled(true)`.
    pub fn new(limit: u64) -> LayerCache<T> {
        LayerCache {
            enabled: false,
            entries: BTreeMap::new(),
            round: 0,
            bytes: 0,
            limit,
            hits: 0,
            misses: 0,
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// Turns the cache on or off. Turning it off empties it (and turning it
    /// off when it is off does nothing); the textures come back for the
    /// caller to release.
    pub fn set_enabled(&mut self, on: bool) -> Vec<T> {
        self.enabled = on;
        if on {
            return Vec::new();
        }
        self.bytes = 0;
        std::mem::take(&mut self.entries)
            .into_values()
            .filter_map(|e| e.texture)
            .collect()
    }

    /// Starts a frame.
    pub fn begin_frame(&mut self) {
        self.round += 1;
    }

    /// Ends a frame: drops the entries it did not use. The textures come
    /// back for the caller to release.
    pub fn end_frame(&mut self) -> Vec<T> {
        let mut dropped = Vec::new();
        for (id, entry) in std::mem::take(&mut self.entries) {
            if entry.round == self.round {
                self.entries.insert(id, entry);
            } else if let Some(texture) = entry.texture {
                self.bytes -= texture.bytes();
                dropped.push(texture);
            }
        }
        dropped
    }

    /// The cached texture of the layer `id` if it was made from `inputs`.
    /// `Err` holds the texture of an older entry that was not, which the
    /// caller releases (a new texture replaces it with `put`).
    pub fn take(&mut self, id: &[String], inputs: &Inputs) -> Result<Hit<T>, Option<T>> {
        let Some(entry) = self.entries.remove(id) else {
            self.misses += 1;
            return Err(None);
        };
        self.bytes -= entry.texture.as_ref().map_or(0, Pooled::bytes);
        match entry.texture {
            Some(_) if entry.key.matches(inputs) => {
                self.hits += 1;
                Ok(Hit(entry))
            }
            texture => {
                self.misses += 1;
                Err(texture)
            }
        }
    }

    /// Whether the layer `id` was drawn without a texture of its own last
    /// frame (`note`) and was then what `inputs` says it is now.
    pub fn is_unchanged(&self, id: &[String], inputs: &Inputs) -> bool {
        self.entries
            .get(id)
            .is_some_and(|e| e.texture.is_none() && e.key.matches(inputs))
    }

    /// Records that the layer `id`, made from `inputs`, was drawn this frame
    /// without a texture to keep. If the next frame finds it unchanged
    /// (`is_unchanged`) it is drawn the way that gives it one, so a layer that
    /// stays the same is cached from its third frame on.
    pub fn note(&mut self, id: Vec<String>, inputs: &Inputs) {
        if self.enabled {
            self.entries.insert(
                id,
                Entry {
                    key: Key::of(inputs),
                    texture: None,
                    round: self.round,
                },
            );
        }
    }

    /// Puts back what `take` found, as used by this frame.
    pub fn put_back(&mut self, id: Vec<String>, hit: Hit<T>) {
        let mut entry = hit.0;
        entry.round = self.round;
        self.bytes += entry.texture.as_ref().map_or(0, Pooled::bytes);
        self.entries.insert(id, entry);
    }

    /// Keeps `texture`, made from `inputs`, for the layer `id`, if the cache
    /// is on and has room. The textures that are not kept come back for the
    /// caller to release: an older entry for the layer, or `texture` itself.
    pub fn put(&mut self, id: Vec<String>, inputs: &Inputs, texture: T) -> Vec<T> {
        let mut released = Vec::new();
        if let Some(old) = self.entries.remove(&id)
            && let Some(old) = old.texture
        {
            self.bytes -= old.bytes();
            released.push(old);
        }
        if !self.enabled || self.bytes + texture.bytes() > self.limit {
            released.push(texture);
            return released;
        }
        self.bytes += texture.bytes();
        self.entries.insert(
            id,
            Entry {
                key: Key::of(inputs),
                texture: Some(texture),
                round: self.round,
            },
        );
        released
    }

    /// How many layers were drawn from the cache, and how many were looked
    /// for and not found (or found out of date), since it was made.
    pub fn counts(&self) -> (u64, u64) {
        (self.hits, self.misses)
    }

    /// How many textures are kept, and their bytes.
    #[cfg(test)]
    fn kept(&self) -> (usize, u64) {
        (self.entries.len(), self.bytes)
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::Scene;
    use crate::scene::BlendMode;

    // --- Which layers are the same. ------------------------------------------

    fn scene(layers: &str) -> Scene {
        let json = format!(
            r##"{{"width": 100, "height": 100, "fps": 30, "durationInFrames": 100,
                "layers": {layers}}}"##
        );
        Scene::from_json(&json, PathBuf::new()).unwrap()
    }

    fn at(scene: &Scene, frame: u32) -> Vec<ResolvedLayer> {
        scene.resolve(frame).unwrap().layers
    }

    fn inputs(layer: &ResolvedLayer) -> Inputs<'_> {
        Inputs {
            layer,
            matte: None,
            parent: Affine::IDENTITY,
            placement: None,
            projection: None,
            opacity_scale: None,
        }
    }

    /// Whether `b` is made from what `a` was.
    fn same(a: &ResolvedLayer, b: &ResolvedLayer) -> bool {
        Key::of(&inputs(a)).matches(&inputs(b))
    }

    /// The first layer of a scene of one, at two frames.
    fn across_frames(layer: &str) -> bool {
        let scene = scene(&format!("[{layer}]"));
        same(&at(&scene, 3)[0], &at(&scene, 4)[0])
    }

    const MOVE: &str = r#"[{"frame": 0, "value": 0}, {"frame": 50, "value": 100}]"#;

    fn shape(rest: &str) -> String {
        format!(
            r##"{{"id": "a", "type": "shape", "shape": {{"kind": "rect", "width": 20, "height": 20}},
               "fill": "#ff0000"{rest}}}"##
        )
    }

    #[test]
    fn a_layer_is_the_same_whatever_opacity_and_blend_mode_it_is_blended_with() {
        // Both are applied when the texture is blended.
        assert!(across_frames(&shape(&format!(r#", "opacity": {MOVE}"#))));
        let multiply = at(
            &scene(&format!("[{}]", shape(r#", "blendMode": "multiply""#))),
            0,
        );
        let screen = at(
            &scene(&format!("[{}]", shape(r#", "blendMode": "screen""#))),
            0,
        );
        assert_eq!(multiply[0].blend_mode, BlendMode::Multiply);
        assert!(same(&multiply[0], &screen[0]));
    }

    #[test]
    fn anything_else_that_changes_in_a_layer_makes_it_different() {
        for changing in [
            format!(r#", "transform": {{"x": {MOVE}}}"#),
            format!(r#", "transform": {{"rotation": {MOVE}}}"#),
            format!(r#", "effects": [{{"type": "blur", "radius": {MOVE}}}]"#),
            format!(
                r##", "effects": [{{"type": "dropShadow", "x": {MOVE}, "color": "#000000"}}]"##
            ),
            format!(r#", "effects": [{{"type": "saturate", "amount": {MOVE}}}]"#),
            format!(r#", "clip": {{"kind": "inset", "top": {MOVE}}}"#),
        ] {
            assert!(!across_frames(&shape(&changing)), "{changing}");
        }
        // And the same layer, nothing animated, is the same.
        assert!(across_frames(&shape(
            r#", "transform": {"x": 5}, "effects": [{"type": "blur", "radius": 3}]"#
        )));
    }

    #[test]
    fn what_a_pass_reads_of_the_frame_is_in_the_layer() {
        let grain = |animate: bool| {
            shape(&format!(
                r#", "effects": [{{"type": "grain", "amount": 0.2, "seed": 4, "animate": {animate}}}]"#
            ))
        };
        // A new pattern each frame is a different texture; a fixed one is not.
        assert!(!across_frames(&grain(true)));
        assert!(across_frames(&grain(false)));
        let dither = |animate: bool| {
            shape(&format!(
                r#", "effects": [{{"type": "dither", "mode": "random", "seed": 4, "animate": {animate}}}]"#
            ))
        };
        assert!(!across_frames(&dither(true)));
        assert!(across_frames(&dither(false)));
        // A custom shader is given the frame and the time.
        let shader = shape(
            r#", "effects": [{"type": "shader",
                "code": "fn effect(px: vec2<f32>) -> vec4<f32> { return layer(px); }"}]"#,
        );
        assert!(!across_frames(&shader));
        // Seeded noise, fixed.
        let noise = r#"{"id": "n", "type": "noise", "width": 40, "height": 40,
            "turbulence": {"type": "fractalNoise", "baseFrequency": 0.05, "seed": 3}}"#;
        assert!(across_frames(noise));
    }

    #[test]
    fn a_group_is_the_same_while_everything_in_it_is() {
        let group = |child: &str| {
            format!(
                r#"{{"id": "g", "type": "group", "children": [{}, {child}]}}"#,
                shape(", \"transform\": {\"x\": 3}").replace("\"a\"", "\"still\"")
            )
        };
        assert!(across_frames(&group(&shape(", \"transform\": {\"x\": 7}"))));
        // One child of a nested group, moving.
        let nested = format!(
            r#"{{"id": "outer", "type": "group", "children": [{}]}}"#,
            group(&shape(&format!(r#", "transform": {{"y": {MOVE}}}"#)))
                .replace("\"g\"", "\"inner\"")
        );
        assert!(!across_frames(&nested));
    }

    #[test]
    fn motion_blur_samples_are_part_of_the_layer() {
        let blurred = |transform: &str| {
            shape(&format!(
                r#", "transform": {transform}, "motionBlur": {{"samples": 4, "shutter": 1}}"#
            ))
        };
        assert!(!across_frames(&blurred(&format!(r#"{{"x": {MOVE}}}"#))));
        assert!(across_frames(&blurred(r#"{"x": 10}"#)));
    }

    #[test]
    fn what_a_layer_is_drawn_with_is_part_of_what_it_was_made_from() {
        let layers = at(
            &scene(&format!(
                "[{}, {}]",
                shape(""),
                shape("").replace("\"a\"", "\"b\"")
            )),
            0,
        );
        let base = inputs(&layers[0]);
        let key = Key::of(&base);
        assert!(key.matches(&base));
        // The matte source.
        assert!(!key.matches(&Inputs {
            matte: Some(&layers[1]),
            ..base
        }));
        // The parent's matrix, the placement, the camera and the weight.
        assert!(!key.matches(&Inputs {
            parent: Affine::translate((1.0, 0.0)),
            ..base
        }));
        let placement = Some((Affine::IDENTITY, DMat4::from_rotation_x(0.5)));
        assert!(!key.matches(&Inputs { placement, ..base }));
        let camera = Some(DMat4::from_scale(glam::DVec3::splat(2.0)));
        assert!(!key.matches(&Inputs {
            projection: camera,
            ..base
        }));
        assert!(!key.matches(&Inputs {
            opacity_scale: Some(0.5),
            ..base
        }));
        // The matte source is kept in full, down to its own opacity.
        let with_matte = Key::of(&Inputs {
            matte: Some(&layers[1]),
            ..base
        });
        assert!(with_matte.matches(&Inputs {
            matte: Some(&layers[1]),
            ..base
        }));
        let mut dimmer = layers[1].clone();
        dimmer.opacity = 0.5;
        assert!(!with_matte.matches(&Inputs {
            matte: Some(&dimmer),
            ..base
        }));
    }

    #[test]
    fn layers_that_blur_what_is_behind_them_are_found_wherever_they_are() {
        let blur = |radius: &str| {
            format!(r#", "effects": [{{"type": "backdropBlur", "radius": {radius}}}]"#)
        };
        let layers = at(
            &scene(&format!(
                r#"[{plain}, {frost},
                    {{"id": "faint", "type": "group", "children": [], "effects": [{{"type": "backdropBlur", "radius": 0.5}}]}},
                    {{"id": "deep", "type": "group", "children": [
                       {{"id": "mid", "type": "group", "children": [{inner}]}}]}},
                    {sampled}]"#,
                plain = shape(""),
                frost = shape(&blur("8")).replace("\"a\"", "\"frost\""),
                inner = shape(&blur("8")).replace("\"a\"", "\"inner\""),
                sampled = shape(&format!(r#"{}, "motionBlur": {{"samples": 2}}"#, blur("8")))
                    .replace("\"a\"", "\"sampled\""),
            )),
            0,
        );
        let found: Vec<_> = layers
            .iter()
            .map(|l| (l.id.as_str(), mentions_backdrop(l)))
            .collect();
        assert_eq!(
            found,
            [
                ("a", false),
                ("frost", true),
                // Under the blur's minimum it does nothing now, and may not
                // at the next frame.
                ("faint", true),
                ("deep", true),
                ("sampled", true),
            ]
        );
    }

    #[test]
    fn layers_moved_in_3d_or_holding_one_use_the_camera_and_others_do_not() {
        let layers = at(
            &scene(&format!(
                r#"[{flat}, {tilted},
                    {{"id": "outer", "type": "group", "children": [{inner}]}},
                    {{"id": "stack", "type": "group", "preserve3d": true, "children": []}},
                    {{"id": "plain", "type": "group", "children": [{flat2}]}}]"#,
                flat = shape(""),
                tilted = shape(r#", "transform": {"rotateX": 30}"#).replace("\"a\"", "\"tilted\""),
                inner = shape(r#", "transform": {"z": 10}"#).replace("\"a\"", "\"inner\""),
                flat2 = shape("").replace("\"a\"", "\"flat2\""),
            )),
            0,
        );
        let found: Vec<_> = layers
            .iter()
            .map(|l| (l.id.as_str(), uses_projection(l)))
            .collect();
        assert_eq!(
            found,
            [
                ("a", false),
                ("tilted", true),
                ("outer", true),
                ("stack", true),
                ("plain", false),
            ]
        );
    }

    #[test]
    fn the_diorama_keeps_what_stops_moving_and_redraws_what_moves() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/bench-diorama.json");
        let scene = Scene::load(&path).unwrap();
        // The hills and trees stop at frame 40; the clouds, poster, lantern,
        // birds and fog move to the end, and the grain is new every frame.
        let (before, after) = (at(&scene, 50), at(&scene, 51));
        let mut still = Vec::new();
        let mut redrawn = Vec::new();
        for (a, b) in before.iter().zip(&after) {
            if same(a, b) {
                still.push(a.id.as_str());
            } else {
                redrawn.push(a.id.as_str());
            }
        }
        for id in [
            "hill-3",
            "hill-4",
            "hill-5",
            "tree-1",
            "tree-4",
            "house-body",
            "house-roof",
            "river",
            "rock-1",
            "caption-title",
            "paper-grain",
        ] {
            assert!(still.contains(&id), "{id} should be kept: {still:?}");
        }
        for id in [
            "cloud-1",
            "cloud-3",
            "hill-1",
            "hill-2",
            "poster",
            "lantern",
            "birds",
            "fog",
            "grain-overlay",
        ] {
            assert!(redrawn.contains(&id), "{id} should be redrawn: {redrawn:?}");
        }
        // While the hills are still moving, they are redrawn.
        let (before, after) = (at(&scene, 20), at(&scene, 21));
        let hill = |layers: &[ResolvedLayer]| layers.iter().position(|l| l.id == "hill-3").unwrap();
        assert!(!same(&before[hill(&before)], &after[hill(&after)]));
    }

    // --- The cache. -----------------------------------------------------------

    /// A texture of `0` bytes.
    struct Bytes(u64);

    impl Pooled for Bytes {
        fn dims(&self) -> [u32; 2] {
            [1, 1]
        }

        fn bytes(&self) -> u64 {
            self.0
        }
    }

    fn id(name: &str) -> Vec<String> {
        vec!["group".into(), name.into()]
    }

    /// A cache that is on.
    fn cache(limit: u64) -> LayerCache<Bytes> {
        let mut cache = LayerCache::new(limit);
        assert!(cache.set_enabled(true).is_empty());
        cache
    }

    #[test]
    fn a_texture_comes_back_for_the_same_inputs_and_not_for_different_ones() {
        let layers = at(
            &scene(&format!(
                "[{}]",
                shape(&format!(r#", "transform": {{"x": {MOVE}}}"#))
            )),
            0,
        );
        let later = at(
            &scene(&format!(
                "[{}]",
                shape(&format!(r#", "transform": {{"x": {MOVE}}}"#))
            )),
            10,
        );
        let mut cache = cache(1000);
        cache.begin_frame();
        assert!(cache.take(&id("a"), &inputs(&layers[0])).is_err());
        assert!(
            cache
                .put(id("a"), &inputs(&layers[0]), Bytes(10))
                .is_empty()
        );
        cache.end_frame();
        cache.begin_frame();
        // The same layer: the texture, and it stays kept once it is put back.
        let hit = cache.take(&id("a"), &inputs(&layers[0])).ok().unwrap();
        assert_eq!(hit.texture().0, 10);
        assert_eq!(cache.kept(), (0, 0));
        cache.put_back(id("a"), hit);
        assert_eq!(cache.kept(), (1, 10));
        assert!(cache.end_frame().is_empty());
        // A layer that has moved: the old texture is handed back to release.
        cache.begin_frame();
        let stale = cache.take(&id("a"), &inputs(&later[0])).err().unwrap();
        assert_eq!(stale.map(|t| t.0), Some(10));
        assert_eq!(cache.kept(), (0, 0));
        // Hits and misses (the first look, and the moved layer).
        assert_eq!(cache.counts(), (1, 2));
    }

    #[test]
    fn what_a_frame_does_not_use_is_dropped_when_it_ends() {
        let layers = at(&scene(&format!("[{}]", shape(""))), 0);
        let mut cache = cache(1000);
        cache.begin_frame();
        for name in ["a", "b", "c"] {
            assert!(
                cache
                    .put(id(name), &inputs(&layers[0]), Bytes(10))
                    .is_empty()
            );
        }
        assert!(cache.end_frame().is_empty());
        assert_eq!(cache.kept(), (3, 30));
        // The next frame draws a and c, a from the cache, c anew.
        cache.begin_frame();
        let a = cache.take(&id("a"), &inputs(&layers[0])).ok().unwrap();
        cache.put_back(id("a"), a);
        let stale = cache.put(id("c"), &inputs(&layers[0]), Bytes(12));
        // c's old texture is released, b is dropped at the end.
        assert_eq!(stale.iter().map(|t| t.0).collect::<Vec<_>>(), [10]);
        let dropped = cache.end_frame();
        assert_eq!(dropped.iter().map(|t| t.0).collect::<Vec<_>>(), [10]);
        assert_eq!(cache.kept(), (2, 22));
    }

    #[test]
    fn the_cache_keeps_no_more_than_its_limit() {
        let layers = at(&scene(&format!("[{}]", shape(""))), 0);
        let mut cache = cache(25);
        cache.begin_frame();
        assert!(
            cache
                .put(id("a"), &inputs(&layers[0]), Bytes(10))
                .is_empty()
        );
        assert!(
            cache
                .put(id("b"), &inputs(&layers[0]), Bytes(10))
                .is_empty()
        );
        // 30 would be over: the texture is handed back, not kept.
        let refused = cache.put(id("c"), &inputs(&layers[0]), Bytes(10));
        assert_eq!(refused.iter().map(|t| t.0).collect::<Vec<_>>(), [10]);
        assert_eq!(cache.kept(), (2, 20));
        // Replacing an entry counts the new one in place of the old.
        let replaced = cache.put(id("a"), &inputs(&layers[0]), Bytes(15));
        assert_eq!(replaced.iter().map(|t| t.0).collect::<Vec<_>>(), [10]);
        assert_eq!(cache.kept(), (2, 25));
    }

    #[test]
    fn a_layer_drawn_without_a_texture_is_noted_and_found_unchanged_the_next_frame() {
        let still = at(&scene(&format!("[{}]", shape(""))), 0);
        let moving = at(
            &scene(&format!(
                "[{}]",
                shape(&format!(r#", "transform": {{"x": {MOVE}}}"#))
            )),
            0,
        );
        let later = at(
            &scene(&format!(
                "[{}]",
                shape(&format!(r#", "transform": {{"x": {MOVE}}}"#))
            )),
            10,
        );
        let mut cache = cache(1000);
        cache.begin_frame();
        assert!(!cache.is_unchanged(&id("a"), &inputs(&still[0])));
        cache.note(id("a"), &inputs(&still[0]));
        cache.note(id("m"), &inputs(&moving[0]));
        // It keeps no texture, so it costs no bytes.
        assert_eq!(cache.kept(), (2, 0));
        assert!(cache.end_frame().is_empty());
        cache.begin_frame();
        assert!(cache.is_unchanged(&id("a"), &inputs(&still[0])));
        // A layer that moved is not.
        assert!(!cache.is_unchanged(&id("m"), &inputs(&later[0])));
        // Taking it is a miss, which a texture then replaces.
        assert!(matches!(
            cache.take(&id("a"), &inputs(&still[0])),
            Err(None)
        ));
        assert!(cache.put(id("a"), &inputs(&still[0]), Bytes(7)).is_empty());
        assert_eq!(cache.kept().1, 7);
        cache.end_frame();
        // From then on it is a hit, and is no longer "noted".
        cache.begin_frame();
        assert!(!cache.is_unchanged(&id("a"), &inputs(&still[0])));
        assert!(cache.take(&id("a"), &inputs(&still[0])).is_ok());
        // A noted layer that the frame does not use is dropped, texture-less.
        assert!(cache.end_frame().is_empty());
        assert_eq!(cache.kept(), (0, 0));
        // A cache that is off notes nothing.
        let mut off = LayerCache::<Bytes>::new(1000);
        off.note(id("a"), &inputs(&still[0]));
        assert_eq!(off.kept(), (0, 0));
    }

    #[test]
    fn a_cache_that_is_off_keeps_nothing_and_gives_everything_back() {
        let layers = at(&scene(&format!("[{}]", shape(""))), 0);
        let mut cache = LayerCache::new(1000);
        // New, it keeps nothing.
        assert!(!cache.enabled());
        cache.begin_frame();
        let back = cache.put(id("z"), &inputs(&layers[0]), Bytes(1));
        assert_eq!(back.iter().map(|t| t.0).collect::<Vec<_>>(), [1]);
        assert!(cache.set_enabled(true).is_empty());
        assert!(cache.enabled());
        cache.put(id("a"), &inputs(&layers[0]), Bytes(10));
        cache.put(id("b"), &inputs(&layers[0]), Bytes(20));
        let mut freed: Vec<_> = cache.set_enabled(false).iter().map(|t| t.0).collect();
        freed.sort();
        assert_eq!(freed, [10, 20]);
        assert!(!cache.enabled());
        assert_eq!(cache.kept(), (0, 0));
        // A texture put in while it is off is handed straight back.
        let back = cache.put(id("c"), &inputs(&layers[0]), Bytes(5));
        assert_eq!(back.iter().map(|t| t.0).collect::<Vec<_>>(), [5]);
        // On again, it starts empty.
        assert!(cache.set_enabled(true).is_empty());
        assert!(cache.take(&id("a"), &inputs(&layers[0])).is_err());
    }
}
