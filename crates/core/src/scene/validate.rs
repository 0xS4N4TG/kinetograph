//! Validation of a scene: the rules `Scene::from_json` checks after parsing.

use std::collections::{HashMap, HashSet};

use super::*;

impl Scene {
    pub(super) fn validate(&self) -> Result<()> {
        let bad = |msg: String| Err(Error::Scene(msg));
        if self.width == 0 || self.height == 0 || self.width > MAX_CANVAS_SIDE || self.height > MAX_CANVAS_SIDE {
            return bad(format!(
                "width and height must be 1..={MAX_CANVAS_SIDE}, got {}x{}",
                self.width, self.height
            ));
        }
        if !(self.fps.is_finite() && self.fps > 0.0) {
            return bad(format!("fps must be positive, got {}", self.fps));
        }
        if self.duration_in_frames == 0 {
            return bad("durationInFrames must be at least 1".into());
        }
        if let Some(camera) = &self.camera
            && camera.perspective.min() <= 0.0
        {
            return bad("camera perspective must be greater than 0".into());
        }
        let mut ids = HashSet::new();
        self.validate_layers(&self.layers, &mut ids)
    }

    fn validate_layers<'a>(&self, layers: &'a [Layer], ids: &mut HashSet<&'a str>) -> Result<()> {
        for layer in layers {
            self.validate_layer(layer, layers, ids, false)?;
        }
        Ok(())
    }

    /// Checks one layer of the list `layers`. `copy` is whether it is one of a
    /// motion blur's `frames`: its own `motionBlur` is ignored, so it is not
    /// checked.
    fn validate_layer<'a>(
        &self,
        layer: &'a Layer,
        layers: &'a [Layer],
        ids: &mut HashSet<&'a str>,
        copy: bool,
    ) -> Result<()> {
        {
            if !ids.insert(&layer.id) {
                return Err(Error::Scene(format!("duplicate layer id {:?}", layer.id)));
            }
            let non_negative = |what: &str, n: &Num| {
                if n.min() < 0.0 {
                    return Err(Error::Scene(format!(
                        "layer {:?}: {what} must not be negative",
                        layer.id
                    )));
                }
                Ok(())
            };
            for effect in &layer.effects {
                match effect {
                    Effect::Shader(shader) => {
                        non_negative("shader padding", &shader.padding)?;
                        crate::shader::validate(&layer.id, &shader.code, &shader.names())?;
                    }
                    Effect::GradientMap { stops, .. } => validate_gradient_map(&layer.id, stops)?,
                    Effect::Grain { size, seed, .. } => {
                        validate_seed(&layer.id, "grain", *seed)?;
                        if size.min() < 1.0 {
                            return Err(Error::Scene(format!(
                                "layer {:?}: grain size must be at least 1 canvas pixel",
                                layer.id
                            )));
                        }
                    }
                    Effect::Dither {
                        mode,
                        levels,
                        size,
                        seed,
                        ..
                    } => validate_dither(&layer.id, *mode, levels, size, *seed)?,
                    Effect::Halftone { size, .. } => {
                        if size.min() <= 0.0 {
                            return Err(Error::Scene(format!(
                                "layer {:?}: halftone size must be greater than 0",
                                layer.id
                            )));
                        }
                    }
                    Effect::DotMatrix {
                        size,
                        stagger,
                        order,
                        seed,
                        ..
                    } => validate_dot_matrix(&layer.id, &layer.kind, size, stagger, *order, *seed)?,
                    Effect::Displace { turbulence, .. } => {
                        validate_turbulence(&layer.id, "displace", turbulence)?;
                    }
                    Effect::FilterGraph(graph) => {
                        graph.validate(&layer.id, layer.kind.has_box())?
                    }
                    Effect::ColorGrade(grade) => grade.validate(&layer.id)?,
                    Effect::CornerPin { .. } if !layer.kind.has_box() => {
                        return Err(Error::Scene(format!(
                            "layer {:?}: cornerPin needs a box, and a group without a layout has none; pin a \
                             layer inside it, or put the group's children in a layer that has one",
                            layer.id
                        )));
                    }
                    Effect::Lut { src, .. } if src.trim().is_empty() => {
                        return Err(Error::Scene(format!(
                            "layer {:?}: lut needs a src, the path of a .cube file",
                            layer.id
                        )));
                    }
                    _ => {}
                }
            }
            if let Some(clip) = &layer.clip {
                validate_clip(&layer.id, clip, &layer.kind)?;
            }
            if let Some(matte) = &layer.matte {
                validate_matte(layer, matte, layers)?;
            }
            if !copy && let Some(blur) = &layer.motion_blur {
                if !(MIN_MOTION_SAMPLES..=MAX_MOTION_SAMPLES).contains(&blur.samples) {
                    return Err(Error::Scene(format!(
                        "layer {:?}: motionBlur samples must be a whole number from \
                         {MIN_MOTION_SAMPLES} to {MAX_MOTION_SAMPLES}, got {}",
                        layer.id, blur.samples
                    )));
                }
                if let Some(frames) = &blur.frames {
                    self.validate_frames(layer, blur.samples, frames, layers)?;
                }
                if let Some(changes) = &blur.changes {
                    if blur.frames.is_some() {
                        return Err(Error::Scene(format!(
                            "layer {:?}: motionBlur takes frames or changes, not both",
                            layer.id
                        )));
                    }
                    self.validate_changes(layer, blur.samples, changes, layers)?;
                }
            }
            if let Some(mask) = &layer.mask {
                validate_gradient(&layer.id, "mask gradient", &mask.gradient)?;
                validate_units(layer, "mask gradient", &mask.gradient)?;
            }
            if let Some(item) = &layer.layout_item {
                validate_layout_item(&layer.id, item)?;
            }
            match &layer.kind {
                LayerKind::Shape(s) => {
                    match &s.shape {
                        Geometry::Rect { width, height }
                        | Geometry::RoundedRect { width, height, .. }
                        | Geometry::Ellipse { width, height } => {
                            non_negative("width", width)?;
                            non_negative("height", height)?;
                        }
                        Geometry::Path { d } => {
                            BezPath::from_svg(d).map_err(|e| {
                                Error::Scene(format!(
                                    "layer {:?}: bad SVG path {d:?}: {e}",
                                    layer.id
                                ))
                            })?;
                        }
                    }
                    if let Some(Paint::Gradient(g)) = &s.fill {
                        validate_gradient(&layer.id, "fill gradient", g)?;
                    }
                    if let Some(Paint::Image(i)) = &s.fill {
                        validate_image_paint(&layer.id, i)?;
                    }
                    if let Some(stroke) = &s.stroke {
                        non_negative("stroke width", &stroke.width)?;
                    }
                }
                LayerKind::Text(t) if !t.runs.is_empty() => {
                    for run in &t.runs {
                        let path = self.base_dir.join(&run.src);
                        let bundled = crate::fallback_fonts::face(&run.src).is_some();
                        if !bundled && !path.is_file() {
                            return Err(Error::Scene(format!(
                                "layer {:?}: glyph run font {} is not a file",
                                layer.id,
                                path.display()
                            )));
                        }
                        if run.size.is_nan() || run.size <= 0.0 {
                            return Err(Error::Scene(format!(
                                "layer {:?}: glyph run size must be positive",
                                layer.id
                            )));
                        }
                    }
                    if let Paint::Gradient(g) = &t.color {
                        validate_gradient(&layer.id, "color gradient", g)?;
                    }
                    if let Paint::Image(i) = &t.color {
                        validate_image_paint(&layer.id, i)?;
                    }
                    for (what, side) in [("boxWidth", &t.box_width), ("boxHeight", &t.box_height)] {
                        if let Some(side) = side {
                            non_negative(what, side)?;
                        }
                    }
                }
                LayerKind::Text(t) => {
                    if !self.fonts.contains_key(&t.font) {
                        return Err(Error::Scene(format!(
                            "layer {:?} uses font {:?}, which is not in \"fonts\"",
                            layer.id, t.font
                        )));
                    }
                    if t.size.min() <= 0.0 {
                        return Err(Error::Scene(format!(
                            "layer {:?}: text size must be positive",
                            layer.id
                        )));
                    }
                    if let Paint::Gradient(g) = &t.color {
                        validate_gradient(&layer.id, "color gradient", g)?;
                    }
                    if let Paint::Image(i) = &t.color {
                        validate_image_paint(&layer.id, i)?;
                    }
                    if let Some(max_width) = &t.max_width {
                        non_negative("maxWidth", max_width)?;
                    }
                }
                LayerKind::Image(i) => {
                    if let Some(width) = &i.width {
                        non_negative("width", width)?;
                    }
                    if let Some(height) = &i.height {
                        non_negative("height", height)?;
                    }
                }
                LayerKind::Group(g) => {
                    if let Some(layout) = &g.layout {
                        validate_layout(&layer.id, layout)?;
                    }
                    if let Some(glsl) = &g.glsl {
                        non_negative("width", &glsl.width)?;
                        non_negative("height", &glsl.height)?;
                        validate_shader_group(layer, g, glsl)?;
                    }
                    if let Some(canvas) = &g.canvas {
                        non_negative("width", &canvas.width)?;
                        non_negative("height", &canvas.height)?;
                        if g.glsl.is_some() || g.preserve3d || g.layout.is_some() {
                            return Err(Error::Scene(format!(
                                "layer {:?}: a group with a canvas pass cannot also have a glsl pass, a layout or be preserve3d",
                                layer.id
                            )));
                        }
                        if let Some(bad) = crate::canvas::bad_path(&canvas.commands.0) {
                            return Err(Error::Scene(format!("layer {:?}: canvas: {bad}", layer.id)));
                        }
                        for id in crate::canvas::layer_sources(&canvas.commands.0) {
                            if !g.children.iter().any(|c| c.id == id) {
                                return Err(Error::Scene(format!(
                                    "layer {:?}: the canvas pass draws the layer {id:?}, which is not one of its children",
                                    layer.id
                                )));
                            }
                        }
                    }
                    if g.preserve3d {
                        validate_preserve3d(layer, layers)?;
                        if let Some(child) = g.children.iter().find(|c| c.motion_blur.is_some()) {
                            return Err(Error::Scene(format!(
                                "layer {:?}: motionBlur is not supported on the children of a \
                                 preserve3d group, which are drawn straight into its parent; \
                                 put the preserve3d group inside another group and give that one \
                                 the motionBlur",
                                child.id
                            )));
                        }
                    }
                    self.validate_layers(&g.children, ids)?;
                }
                LayerKind::Noise(n) => {
                    non_negative("width", &n.width)?;
                    non_negative("height", &n.height)?;
                    validate_turbulence(&layer.id, "noise", &n.turbulence)?;
                }
                LayerKind::MeshGradient(m) => {
                    non_negative("width", &m.width)?;
                    non_negative("height", &m.height)?;
                    validate_mesh_gradient(&layer.id, m)?;
                }
                LayerKind::Canvas(c) => {
                    non_negative("width", &c.width)?;
                    non_negative("height", &c.height)?;
                    if let Some(bad) = crate::canvas::bad_path(&c.commands.0) {
                        return Err(Error::Scene(format!("layer {:?}: canvas: {bad}", layer.id)));
                    }
                }
                LayerKind::Glsl(g) => {
                    non_negative("width", &g.width)?;
                    non_negative("height", &g.height)?;
                    crate::glsl::validate(&layer.id, &g.recording.0)?;
                }
                LayerKind::Scene3d(s) => {
                    s.validate(&layer.id, &|font| self.fonts.contains_key(font))?;
                }
                LayerKind::Lottie(l) => {
                    if l.src.trim().is_empty() {
                        return Err(Error::Scene(format!(
                            "layer {:?}: lottie needs a src, the path of a .json or .lottie file",
                            layer.id
                        )));
                    }
                    for (what, side) in [("width", &l.width), ("height", &l.height)] {
                        if let Some(side) = side {
                            non_negative(what, side)?;
                        }
                    }
                }
                LayerKind::Video(v) => {
                    let bad =
                        |msg: String| Err(Error::Scene(format!("layer {:?}: {msg}", layer.id)));
                    if v.src.trim().is_empty() {
                        return bad("video needs a src, the path of a video file".into());
                    }
                    for (what, side) in [("width", &v.width), ("height", &v.height)] {
                        if let Some(side) = side {
                            non_negative(what, side)?;
                        }
                    }
                    if !(v.from.is_finite() && v.trim_before.is_finite() && v.trim_before >= 0.0) {
                        return bad(format!(
                            "video from must be a number and trimBefore a number not below 0, got {} and {}",
                            v.from, v.trim_before
                        ));
                    }
                    if let Some(after) = v.trim_after
                        && !(after.is_finite() && after > v.trim_before)
                    {
                        return bad(format!(
                            "video trimAfter must be above trimBefore ({}), got {after}",
                            v.trim_before
                        ));
                    }
                    if !(v.playback_rate.is_finite() && v.playback_rate > 0.0) {
                        return bad(format!(
                            "video playbackRate must be above 0, got {}",
                            v.playback_rate
                        ));
                    }
                    if let Some(m) = &v.datamosh {
                        if !(m.from.is_finite() && m.to.is_finite() && m.to > m.from) {
                            return bad(format!(
                                "video datamosh needs from and to frames with to above from, got {} and {}",
                                m.from, m.to
                            ));
                        }
                        if m.to - m.from > crate::datamosh::MAX_WINDOW {
                            return bad(format!(
                                "video datamosh window is {} frames, at most {} (the cost of a cold start grows with it)",
                                m.to - m.from,
                                crate::datamosh::MAX_WINDOW
                            ));
                        }
                        if !(0.0..=1.0).contains(&m.mix) {
                            return bad(format!("video datamosh mix must be 0 to 1, got {}", m.mix));
                        }
                        match &m.hold {
                            None => {}
                            Some(Hold::Keyword(word)) if word == "previous" => {}
                            Some(Hold::Keyword(word)) => {
                                return bad(format!(
                                    "video datamosh hold is \"previous\" or {{ src, frame }}, got {word:?}"
                                ));
                            }
                            Some(Hold::Clip { src, frame })
                                if src.trim().is_empty() || !(frame.is_finite() && *frame >= 0.0) =>
                            {
                                return bad(
                                    "video datamosh hold needs a src and a frame of 0 or more".into(),
                                );
                            }
                            Some(Hold::Clip { .. }) => {}
                        }
                    }
                }
                LayerKind::Gif(g) => {
                    if g.src.trim().is_empty() {
                        return Err(Error::Scene(format!(
                            "layer {:?}: gif needs a src, the path of a .gif file",
                            layer.id
                        )));
                    }
                    for (what, side) in [("width", &g.width), ("height", &g.height)] {
                        if let Some(side) = side {
                            non_negative(what, side)?;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Checks a layer's motion blur `frames`: `samples` of them, each of the
    /// layer's type and a valid layer on its own. A copy has its original's id
    /// (and its children those of the original's), so it is checked with an id
    /// set of its own; it sits among the original's `siblings`.
    fn validate_frames<'a>(
        &self,
        layer: &Layer,
        samples: i64,
        frames: &'a [Layer],
        siblings: &'a [Layer],
    ) -> Result<()> {
        if frames.len() as i64 != samples {
            return Err(Error::Scene(format!(
                "layer {:?}: motionBlur frames needs exactly {samples} layers (one per sample), \
                 got {}",
                layer.id,
                frames.len()
            )));
        }
        for (i, copy) in frames.iter().enumerate() {
            if std::mem::discriminant(&copy.kind) != std::mem::discriminant(&layer.kind) {
                return Err(Error::Scene(format!(
                    "layer {:?}: motionBlur frames[{i}] is a {} layer, but the layer is a {}",
                    layer.id,
                    copy.kind.name(),
                    layer.kind.name()
                )));
            }
            self.validate_layer(copy, siblings, &mut HashSet::new(), true)?;
        }
        Ok(())
    }

    /// Checks a layer's motion blur `changes`: `samples` lists, each changing
    /// a layer of the blurred tree at most once, with a layer of its type that
    /// is valid in the place of the one it changes (among that one's
    /// siblings, with an id set of its own, as a `frames` copy is).
    fn validate_changes(
        &self,
        layer: &Layer,
        samples: i64,
        changes: &[Vec<SampleChange>],
        siblings: &[Layer],
    ) -> Result<()> {
        if changes.len() as i64 != samples {
            return Err(Error::Scene(format!(
                "layer {:?}: motionBlur changes needs exactly {samples} lists (one per sample), \
                 got {}",
                layer.id,
                changes.len()
            )));
        }
        let mut tree: HashMap<&str, (&Layer, &[Layer])> = HashMap::new();
        tree.insert(&layer.id, (layer, siblings));
        index_tree(layer, &mut tree);
        for (i, list) in changes.iter().enumerate() {
            let mut seen = HashSet::new();
            for change in list {
                let id = change.replaces();
                let Some(&(original, around)) = tree.get(id) else {
                    return Err(Error::Scene(format!(
                        "layer {:?}: motionBlur changes[{i}] changes {id:?}, which is not the layer \
                         or a layer in it",
                        layer.id
                    )));
                };
                if !seen.insert(id) {
                    return Err(Error::Scene(format!(
                        "layer {:?}: motionBlur changes[{i}] changes {id:?} twice",
                        layer.id
                    )));
                }
                // A layer below the blurred one can become another layer; a
                // change that keeps the children, or of the blurred layer, cannot.
                let whole = !change.keep_children && id != layer.id;
                if !whole && change.layer.id != id {
                    return Err(Error::Scene(format!(
                        "layer {:?}: motionBlur changes[{i}] replaces {id:?} with {:?}, which it can only do \
                         for a layer below it, whole",
                        layer.id, change.layer.id
                    )));
                }
                if !whole
                    && std::mem::discriminant(&change.layer.kind)
                        != std::mem::discriminant(&original.kind)
                {
                    return Err(Error::Scene(format!(
                        "layer {:?}: motionBlur changes[{i}] makes {id:?} a {} layer, but it is a {}",
                        layer.id,
                        change.layer.kind.name(),
                        original.kind.name()
                    )));
                }
                if change.keep_children
                    && let LayerKind::Group(g) = &change.layer.kind
                    && !g.children.is_empty()
                {
                    return Err(Error::Scene(format!(
                        "layer {:?}: motionBlur changes[{i}] keeps the children of {id:?}, so it \
                         gives none",
                        layer.id
                    )));
                }
                self.validate_layer(&change.layer, around, &mut HashSet::new(), true)?;
            }
        }
        Ok(())
    }
}

/// Every layer below `layer` by id, with the list it is in.
fn index_tree<'a>(layer: &'a Layer, into: &mut HashMap<&'a str, (&'a Layer, &'a [Layer])>) {
    if let LayerKind::Group(g) = &layer.kind {
        for child in &g.children {
            into.insert(&child.id, (child, &g.children));
            index_tree(child, into);
        }
    }
}

fn validate_clip(id: &str, clip: &Clip, kind: &LayerKind) -> Result<()> {
    let bad = |msg: String| Err(Error::Scene(format!("layer {id:?}: clip {msg}")));
    match clip {
        Clip::Polygon { points, .. } => {
            if points.len() < 3 {
                return bad(format!(
                    "polygon needs at least 3 points, got {}",
                    points.len()
                ));
            }
        }
        Clip::Inset { radius, .. } => {
            if !kind.has_box() {
                return bad(
                    "inset needs a box, and a group without a layout has none; use a polygon or path clip".into(),
                );
            }
            if radius.min() < 0.0 {
                return bad("inset radius must not be negative".into());
            }
        }
        Clip::Ellipse { rx, ry, .. } => {
            if rx.min() < 0.0 || ry.min() < 0.0 {
                return bad("ellipse rx and ry must not be negative".into());
            }
        }
        Clip::Path { d, .. } => {
            BezPath::from_svg(d).map_err(|e| {
                Error::Scene(format!("layer {id:?}: clip has a bad SVG path {d:?}: {e}"))
            })?;
        }
    }
    Ok(())
}

fn validate_matte(layer: &Layer, matte: &Matte, siblings: &[Layer]) -> Result<()> {
    let bad = |msg: String| Err(Error::Scene(format!("layer {:?}: matte {msg}", layer.id)));
    if matte.layer == layer.id {
        return bad("source cannot be the layer itself".into());
    }
    let Some(source) = siblings.iter().find(|l| l.id == matte.layer) else {
        return bad(format!(
            "source {:?} is not a sibling: it must be in the same layers or children list",
            matte.layer
        ));
    };
    if source.matte.is_some() {
        return bad(format!("source {:?} has a matte of its own", source.id));
    }
    if source.transform.is_3d() {
        return bad(format!(
            "source {:?} has a 3D transform (rotateX, rotateY or z); the matte moves with the \
             layer it cuts, so put them on that layer instead",
            source.id
        ));
    }
    Ok(())
}

/// A `preserve3d` group has no buffer of its own, so it has nowhere to run
/// effects, a clip, a mask or a matte, or to blend as a whole.
fn validate_preserve3d(group: &Layer, siblings: &[Layer]) -> Result<()> {
    let bad = |msg: &str| {
        Err(Error::Scene(format!(
            "layer {:?}: a preserve3d group {msg}; put the group inside another group and \
             give that one what it needs",
            group.id
        )))
    };
    if group.motion_blur.is_some() {
        return bad("cannot have motionBlur");
    }
    if !group.effects.is_empty() {
        return bad("cannot have effects");
    }
    if group.clip.is_some() {
        return bad("cannot have a clip");
    }
    if group.mask.is_some() {
        return bad("cannot have a mask");
    }
    if group.matte.is_some() {
        return bad("cannot have a matte");
    }
    if group.blend_mode != BlendMode::Normal {
        return bad("must use the normal blendMode");
    }
    if siblings
        .iter()
        .any(|l| l.matte.as_ref().is_some_and(|m| m.layer == group.id))
    {
        return bad("cannot be a matte source");
    }
    Ok(())
}

/// A group with a `glsl` pass: its children are the pass's textures.
fn validate_shader_group(group: &Layer, g: &GroupLayer, glsl: &GlslLayer) -> Result<()> {
    let bad = |msg: &str| {
        Err(Error::Scene(format!(
            "layer {:?}: a group with a glsl pass {msg}",
            group.id
        )))
    };
    if g.preserve3d {
        return bad("cannot be a preserve3d group");
    }
    if g.layout.is_some() {
        return bad("cannot have a layout");
    }
    crate::glsl::validate(&group.id, &glsl.recording.0)?;
    for (id, texture) in &glsl.recording.0.textures {
        let Some(child) = &texture.layer else {
            continue;
        };
        if texture.src.is_some() || texture.pixels.is_some() {
            return bad(&format!(
                "has the texture {id:?} with a layer and a src or pixels; it has one of them"
            ));
        }
        if !g.children.iter().any(|c| &c.id == child) {
            return bad(&format!(
                "has the texture {id:?} of the layer {child:?}, which is not one of its children"
            ));
        }
    }
    if let Some(webgpu) = &glsl.recording.0.webgpu {
        for step in &webgpu.passes {
            if let crate::webgpu::Step::Upload(upload) = step
                && let crate::webgpu::Source::Layer(child) = &upload.source
                && !g.children.iter().any(|c| &c.id == child)
            {
                return bad(&format!(
                    "uploads the layer {child:?} into a WebGPU texture, which is not one of its children"
                ));
            }
        }
    }
    Ok(())
}

/// A seed is a whole number that fits a `u32`, so that a pattern is the same
/// on every machine and the hash input is exact.
fn validate_seed(id: &str, what: &str, seed: i64) -> Result<()> {
    if u32::try_from(seed).is_err() {
        return Err(Error::Scene(format!(
            "layer {id:?}: {what} seed must be a whole number from 0 to {}, got {seed}",
            u32::MAX
        )));
    }
    Ok(())
}

fn validate_dither(
    id: &str,
    mode: DitherMode,
    levels: &Num,
    size: &Num,
    seed: Option<i64>,
) -> Result<()> {
    let bad = |msg: String| Err(Error::Scene(format!("layer {id:?}: dither {msg}")));
    if levels.min() < MIN_DITHER_LEVELS || levels.max() > MAX_DITHER_LEVELS {
        return bad(format!(
            "levels must be between {MIN_DITHER_LEVELS} and {MAX_DITHER_LEVELS}"
        ));
    }
    if size.min() < 1.0 {
        return bad("size must be at least 1 canvas pixel".into());
    }
    match (mode, seed) {
        (DitherMode::Random, None) => bad("mode \"random\" needs a seed".into()),
        (_, Some(seed)) => validate_seed(id, "dither", seed),
        _ => Ok(()),
    }
}

fn validate_dot_matrix(
    id: &str,
    kind: &LayerKind,
    size: &Num,
    stagger: &Num,
    order: DotOrder,
    seed: Option<i64>,
) -> Result<()> {
    let bad = |msg: String| Err(Error::Scene(format!("layer {id:?}: dotMatrix {msg}")));
    if size.min() <= 0.0 {
        return bad("size must be greater than 0".into());
    }
    if stagger.min() < 0.0 || stagger.max() >= 1.0 {
        return bad("stagger must be at least 0 and below 1".into());
    }
    match (order, seed) {
        (DotOrder::Random, None) => return bad("order \"random\" needs a seed".into()),
        (_, Some(seed)) => validate_seed(id, "dotMatrix", seed)?,
        _ => {}
    }
    if order == DotOrder::Sweep && !kind.has_box() {
        return bad(
            "order \"sweep\" needs a box, and a group without a layout has none; use order \"random\"".into(),
        );
    }
    Ok(())
}

fn validate_turbulence(id: &str, what: &str, t: &Turbulence) -> Result<()> {
    let bad = |msg: String| {
        Err(Error::Scene(format!(
            "layer {id:?}: {what} turbulence {msg}"
        )))
    };
    if t.base_frequency.x.min() < 0.0 || t.base_frequency.y.min() < 0.0 {
        return bad("baseFrequency must not be negative".into());
    }
    if !(0..=i64::from(MAX_OCTAVES)).contains(&t.num_octaves) {
        return bad(format!(
            "numOctaves must be a whole number from 0 to {MAX_OCTAVES}, got {}",
            t.num_octaves
        ));
    }
    Ok(())
}

fn validate_gradient_map(id: &str, stops: &[Stop]) -> Result<()> {
    let bad = |msg: String| Err(Error::Scene(format!("layer {id:?}: gradientMap {msg}")));
    if !(MIN_GRADIENT_MAP_STOPS..=MAX_GRADIENT_MAP_STOPS).contains(&stops.len()) {
        return bad(format!(
            "needs {MIN_GRADIENT_MAP_STOPS} to {MAX_GRADIENT_MAP_STOPS} stops, got {}",
            stops.len()
        ));
    }
    if stops
        .iter()
        .any(|s| s.offset.min() < 0.0 || s.offset.max() > 1.0)
    {
        return bad("stop offsets must be between 0 and 1".into());
    }
    Ok(())
}

fn validate_mesh_gradient(id: &str, mesh: &MeshGradientLayer) -> Result<()> {
    let bad = |msg: String| Err(Error::Scene(format!("layer {id:?}: meshGradient {msg}")));
    for (what, n) in [("columns", mesh.columns), ("rows", mesh.rows)] {
        if !(MIN_MESH_POINTS..=MAX_MESH_POINTS).contains(&n) {
            return bad(format!(
                "{what} must be a whole number from {MIN_MESH_POINTS} to {MAX_MESH_POINTS}, got {n}"
            ));
        }
    }
    let count = (mesh.columns * mesh.rows) as usize;
    if mesh.colors.len() != count {
        return bad(format!(
            "needs {count} colors (columns x rows), got {}",
            mesh.colors.len()
        ));
    }
    if let Some(points) = &mesh.points
        && points.len() != count
    {
        return bad(format!(
            "needs {count} points (columns x rows), got {}",
            points.len()
        ));
    }
    Ok(())
}

/// The number of lengths `property` takes: `gap` one or two, `padding` and
/// `margin` one or four. Not negative at any keyframe unless `signed`.
fn validate_spacing(
    id: &str,
    what: &str,
    spacing: &Option<Spacing>,
    counts: [usize; 2],
    signed: bool,
) -> Result<()> {
    let Some(Spacing(values)) = spacing else {
        return Ok(());
    };
    if !counts.contains(&values.len()) {
        return Err(Error::Scene(format!(
            "layer {id:?}: {what} takes {} or {} numbers, got {}",
            counts[0],
            counts[1],
            values.len()
        )));
    }
    if !signed && values.iter().any(|n| n.min() < 0.0) {
        return Err(Error::Scene(format!(
            "layer {id:?}: {what} must not be negative"
        )));
    }
    Ok(())
}

fn validate_layout(id: &str, layout: &Layout) -> Result<()> {
    validate_spacing(id, "layout gap", &layout.gap, [1, 2], false)?;
    validate_spacing(id, "layout padding", &layout.padding, [1, 4], false)?;
    for (what, size) in [("width", &layout.width), ("height", &layout.height)] {
        if size.as_ref().is_some_and(|n| n.min() < 0.0) {
            return Err(Error::Scene(format!(
                "layer {id:?}: layout {what} must not be negative"
            )));
        }
    }
    Ok(())
}

fn validate_layout_item(id: &str, item: &LayoutItem) -> Result<()> {
    validate_spacing(id, "layoutItem margin", &item.margin, [1, 4], true)?;
    let sizes = [
        ("flexGrow", &item.flex_grow),
        ("flexShrink", &item.flex_shrink),
        ("width", &item.width),
        ("height", &item.height),
    ];
    for (what, n) in sizes {
        if n.as_ref().is_some_and(|n| n.min() < 0.0) {
            return Err(Error::Scene(format!(
                "layer {id:?}: layoutItem {what} must not be negative"
            )));
        }
    }
    if let Some(FlexBasis::Length(n)) = &item.flex_basis
        && n.min() < 0.0
    {
        return Err(Error::Scene(format!(
            "layer {id:?}: layoutItem flexBasis must not be negative"
        )));
    }
    Ok(())
}

/// A gradient in box units measures from the box of the layer it paints, so a
/// layer without one cannot have it.
fn validate_units(layer: &Layer, what: &str, g: &Gradient) -> Result<()> {
    if g.units == Units::Box && !layer.kind.has_box() {
        return Err(Error::Scene(format!(
            "layer {:?}: {what} uses \"units\": \"box\", and a group without a layout has no box; use the default \
             units, or put the group's children in a layer that has a box",
            layer.id
        )));
    }
    Ok(())
}

/// Checks an image paint: it has a file and a size to draw it at.
fn validate_image_paint(id: &str, i: &ImagePaint) -> Result<()> {
    if i.src.trim().is_empty() {
        return Err(Error::Scene(format!(
            "layer {id:?}: image paint needs a src"
        )));
    }
    if i.width.min() <= 0.0 || i.height.min() <= 0.0 {
        return Err(Error::Scene(format!(
            "layer {id:?}: image paint width and height must be above 0"
        )));
    }
    Ok(())
}

fn validate_gradient(id: &str, what: &str, g: &Gradient) -> Result<()> {
    let bad = |msg: &str| Err(Error::Scene(format!("layer {id:?}: {what} {msg}")));
    if g.stops.len() < 2 {
        return bad("needs at least 2 stops");
    }
    if g.stops
        .iter()
        .any(|s| s.offset.min() < 0.0 || s.offset.max() > 1.0)
    {
        return bad("stop offsets must be between 0 and 1");
    }
    if let GradientGeometry::Radial { r, .. } = &g.geometry
        && r.min() < 0.0
    {
        return bad("radius must not be negative");
    }
    Ok(())
}
