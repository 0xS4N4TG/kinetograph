//! `background-color` and `background-image` layers, and the same machinery
//! for `mask-image`: each image is sized, positioned and tiled in its
//! positioning area and cut to its painting area.

use blitz_dom::Node;
use serde_json::{Value, json};
use style::color::AbsoluteColor;
use style::properties::ComputedValues;
use style::values::computed::{BackgroundRepeat, BackgroundSize, Image, LengthPercentage};
use style::values::generics::length::GenericLengthPercentageOrAuto as LpAuto;
use style::values::specified::background::BackgroundRepeatKeyword as Rep;

use super::geom::{BoxGeom, Radii, Rect, Region, path_d, rounded_rect_path};
use super::gradient::gradient_paint;
use super::images::Source;
use super::util::{
    Layer, current_color, hex, hex_of, lp, num, path_shape, rect_shape, resolve_color, rgba,
};
use super::{Origin, Painter};

/// How a background layer repeats along one axis.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tile {
    Repeat,
    Space,
    Round,
    NoRepeat,
}

impl From<Rep> for Tile {
    fn from(r: Rep) -> Tile {
        match r {
            Rep::Repeat => Tile::Repeat,
            Rep::Space => Tile::Space,
            Rep::Round => Tile::Round,
            Rep::NoRepeat => Tile::NoRepeat,
        }
    }
}

/// One layer of `background-*` or `mask-*`, its lists already indexed.
pub struct ImageLayerSpec<'s> {
    pub image: &'s Image,
    pub size: &'s BackgroundSize,
    pub pos_x: &'s LengthPercentage,
    pub pos_y: &'s LengthPercentage,
    pub repeat: (Tile, Tile),
    pub origin: Region,
    pub clip: Region,
    /// `background` or `mask`, for reports.
    pub property: &'static str,
}

/// A region named by a `Debug` string of Stylo's origin and clip enums.
pub fn region_named(name: &str) -> Region {
    match name {
        "PaddingBox" => Region::Padding,
        "ContentBox" => Region::Content,
        _ => Region::Border,
    }
}

/// Cap on tiles of a gradient drawn one by one.
const MAX_TILES: usize = 150;

impl<'a> Painter<'a> {
    /// `background-color` and `background-image`, bottom first, as one layer
    /// or (with `background-blend-mode`) a group, in the box's own space.
    pub fn background(
        &mut self,
        node: &'a Node,
        style: &ComputedValues,
        geom: &BoxGeom,
    ) -> Vec<Value> {
        let bg = style.get_background();
        let current = current_color(style);
        let color = rgba(&resolve_color(&bg.background_color, &current));
        let images = &bg.background_image.0;
        let n = images.len().max(1);
        let pick = |len: usize, i: usize| i % len.max(1);

        let clip_of = |i: usize| -> Region {
            let list = &bg.background_clip.0;
            if list.is_empty() {
                return Region::Border;
            }
            region_named(&format!("{:?}", list[pick(list.len(), i)]))
        };
        let origin_of = |i: usize| -> Region {
            let list = &bg.background_origin.0;
            if list.is_empty() {
                return Region::Padding;
            }
            region_named(&format!("{:?}", list[pick(list.len(), i)]))
        };

        let id = self.layer_id(node, "bg");
        let mut layers: Vec<Value> = Vec::new();
        let mut any_blend = false;

        // `background-clip: text` is not parsed by this Stylo; the mirror
        // property carries it (see `shim`).
        let text_clip: Vec<bool> = match self.kg_value(node, "--kg-background-clip") {
            Some(v) => super::shim::split_commas(&v)
                .iter()
                .map(|w| w.trim() == "text")
                .collect(),
            None => Vec::new(),
        };
        let is_text = |i: usize| !text_clip.is_empty() && text_clip[i % text_clip.len()];
        let mask_id = format!("{id}.text");
        let mut mask_source_added = false;
        let mut add_mask = |p: &mut Self, layers: &mut Vec<Value>| {
            if !mask_source_added {
                mask_source_added = true;
                let sources = p.text_mask_layers(node, &mask_id);
                layers.push(super::util::group(&mask_id, sources).build());
            }
        };

        // The colour fills the painting area of the lowest layer.
        if color[3] > 0.0 {
            let (rect, radii) = geom.region(clip_of(n - 1));
            let mut shape = self.region_shape(
                &format!("{id}.color"),
                rect,
                radii,
                Value::String(hex_of(color)),
            );
            if is_text(n - 1) {
                add_mask(self, &mut layers);
                shape["matte"] = json!({ "layer": mask_id, "mode": "alpha" });
            }
            layers.push(shape);
        }

        for i in (0..images.len()).rev() {
            let image = &images[i];
            if matches!(image, Image::None) {
                continue;
            }
            let size_list = &bg.background_size.0;
            let px_list = &bg.background_position_x.0;
            let py_list = &bg.background_position_y.0;
            let rep_list = &bg.background_repeat.0;
            if size_list.is_empty()
                || px_list.is_empty()
                || py_list.is_empty()
                || rep_list.is_empty()
            {
                continue;
            }
            let BackgroundRepeat(rx, ry) = rep_list[pick(rep_list.len(), i)];
            let spec = ImageLayerSpec {
                image,
                size: &size_list[pick(size_list.len(), i)],
                pos_x: &px_list[pick(px_list.len(), i)],
                pos_y: &py_list[pick(py_list.len(), i)],
                repeat: (rx.into(), ry.into()),
                origin: origin_of(i),
                clip: clip_of(i),
                property: "background",
            };
            let layer_id = format!("{id}.{i}");
            let Some(mut layer) = self.image_layer(node, geom, &current, &spec, &layer_id, false)
            else {
                continue;
            };
            if is_text(i) {
                add_mask(self, &mut layers);
                layer["matte"] = json!({ "layer": mask_id, "mode": "alpha" });
            }
            let blend_list = &bg.background_blend_mode.0;
            if !blend_list.is_empty() {
                let mode = blend_name(&format!("{:?}", blend_list[pick(blend_list.len(), i)]));
                if mode != "normal" {
                    any_blend = true;
                    if let Some(o) = layer.as_object_mut() {
                        o.insert("blendMode".into(), json!(mode));
                    }
                }
            }
            layers.push(layer);
        }
        if layers.is_empty() {
            return layers;
        }
        if any_blend {
            // Blending stays inside the element's own background.
            return vec![super::util::group(&id, layers).build()];
        }
        layers
    }

    /// A filled shape of a region (rounded when it has radii) at its place in
    /// the box's space.
    pub fn region_shape(&mut self, id: &str, rect: Rect, radii: Radii, fill: Value) -> Value {
        if rect.is_empty() {
            return Layer::new(id, "shape")
                .set("shape", json!({ "kind": "rect", "width": 0, "height": 0 }))
                .build();
        }
        let radii = radii.fitted(rect.w, rect.h);
        if radii.is_zero() {
            return rect_shape(id, rect.w, rect.h, 0.0, fill)
                .at(rect.x, rect.y)
                .build();
        }
        if let Some(r) = radii.uniform_circle() {
            return rect_shape(id, rect.w, rect.h, r, fill)
                .at(rect.x, rect.y)
                .build();
        }
        let path = rounded_rect_path(Rect::new(0.0, 0.0, rect.w, rect.h), radii);
        path_shape(id, &path_d(&path), fill)
            .at(rect.x, rect.y)
            .build()
    }

    /// One image layer: a gradient or a picture sized, positioned and tiled
    /// in the origin region and cut to the clip region. The layer is in the
    /// box's own space. `None` (after a report) if it cannot be drawn.
    ///
    /// `as_mask`: the layer is a mask source, painted opaque white where the
    /// image is opaque is not needed; the colours are kept.
    pub fn image_layer(
        &mut self,
        node: &'a Node,
        geom: &BoxGeom,
        current: &AbsoluteColor,
        spec: &ImageLayerSpec<'_>,
        id: &str,
        _as_mask: bool,
    ) -> Option<Value> {
        let (area, _) = geom.region(spec.origin);
        let (paint, paint_radii) = geom.region(spec.clip);

        // The image: natural size and source.
        enum Img {
            Gradient(Box<style::values::computed::image::Gradient>),
            Picture { path: String, w: f64, h: f64 },
        }
        let img = match spec.image {
            Image::Gradient(g) => Img::Gradient(g.clone()),
            Image::Url(u) => {
                // The element's loaded copy has the resolved URL; the
                // computed value has it too.
                match self.source_of_url(u) {
                    Source::Raster { path, w, h } => Img::Picture { path, w, h },
                    Source::Unsupported(reason) => {
                        self.report(node, spec.property, "url()", &reason);
                        return None;
                    }
                }
            }
            other => {
                self.report(
                    node,
                    spec.property,
                    format!("{other:?}"),
                    "this kind of image is not drawn",
                );
                return None;
            }
        };
        let natural = match &img {
            Img::Picture { w, h, .. } => Some((*w, *h)),
            Img::Gradient(_) => None,
        };

        // The size of one tile.
        let (mut tw, mut th) = tile_size(spec.size, natural, area);
        if !(tw > 0.0 && th > 0.0) {
            return None;
        }
        // `round` adjusts the tile to a whole number across the area.
        if spec.repeat.0 == Tile::Round && area.w > 0.0 {
            tw = area.w / (area.w / tw).round().max(1.0);
        }
        if spec.repeat.1 == Tile::Round && area.h > 0.0 {
            th = area.h / (area.h / th).round().max(1.0);
        }

        let (xs, x_total) = axis_tiles(
            area.x,
            area.w,
            tw,
            lp(spec.pos_x, area.w - tw),
            spec.repeat.0,
            paint.x,
            paint.right(),
        );
        let (ys, y_total) = axis_tiles(
            area.y,
            area.h,
            th,
            lp(spec.pos_y, area.h - th),
            spec.repeat.1,
            paint.y,
            paint.bottom(),
        );
        if xs.is_empty() || ys.is_empty() {
            return None;
        }
        // The real count (the lists are cut short), as a whole number.
        let count = (x_total * y_total).min(1e9) as usize;

        match img {
            Img::Gradient(g) => {
                if count > MAX_TILES {
                    self.report(
                        node,
                        spec.property,
                        "repeating gradient tile",
                        &format!("{count} tiles of a gradient are more than are drawn one by one"),
                    );
                    return None;
                }
                let mut shapes: Vec<Value> = Vec::new();
                let single = count == 1;
                for (yi, &ty) in ys.iter().enumerate() {
                    for (xi, &tx) in xs.iter().enumerate() {
                        let tile = Rect::new(tx, ty, tw, th);
                        let shape_rect = if single { tile.intersect(&paint) } else { tile };
                        if shape_rect.is_empty() {
                            continue;
                        }
                        // The gradient is laid out in its tile, written in the
                        // shape's own coordinates.
                        let local = Rect::new(tx - shape_rect.x, ty - shape_rect.y, tw, th);
                        let fill = match gradient_paint(&g, local, current) {
                            Ok(f) => f,
                            Err(reason) => {
                                self.report(node, spec.property, "gradient", &reason);
                                return None;
                            }
                        };
                        let sid = if single {
                            id.to_string()
                        } else {
                            format!("{id}.{xi}-{yi}")
                        };
                        let whole = single && tile.contains_rect(&paint);
                        let shape = if whole {
                            self.region_shape(&sid, paint, paint_radii, fill)
                        } else {
                            rect_shape(&sid, shape_rect.w, shape_rect.h, 0.0, fill)
                                .at(shape_rect.x, shape_rect.y)
                                .build()
                        };
                        shapes.push(shape);
                    }
                }
                if shapes.is_empty() {
                    return None;
                }
                let whole_single =
                    count == 1 && Rect::new(xs[0], ys[0], tw, th).contains_rect(&paint);
                if whole_single {
                    return shapes.pop();
                }
                // The tiles are cut to the painting area.
                let clip = self.region_clip(paint, paint_radii, 0.0, 0.0);
                if shapes.len() == 1 {
                    let mut only = shapes.pop().unwrap();
                    self.clip_layer(&mut only, paint, paint_radii);
                    return Some(only);
                }
                Some(super::util::group(id, shapes).set("clip", clip).build())
            }
            Img::Picture { path, .. } => {
                let repeat_x = matches!(spec.repeat.0, Tile::Repeat | Tile::Round);
                let repeat_y = matches!(spec.repeat.1, Tile::Repeat | Tile::Round);
                let space = spec.repeat.0 == Tile::Space || spec.repeat.1 == Tile::Space;
                if space && count > MAX_TILES {
                    self.report(
                        node,
                        spec.property,
                        "background-repeat: space",
                        "too many tiles",
                    );
                    return None;
                }
                if space || (!repeat_x && !repeat_y && count == 1) {
                    // Individual tiles, each one picture.
                    let mut shapes = Vec::new();
                    for (yi, &ty) in ys.iter().enumerate() {
                        for (xi, &tx) in xs.iter().enumerate() {
                            let tile = Rect::new(tx, ty, tw, th);
                            let vis = tile.intersect(&paint);
                            if vis.is_empty() {
                                continue;
                            }
                            let sid = if count == 1 {
                                id.to_string()
                            } else {
                                format!("{id}.{xi}-{yi}")
                            };
                            let fill =
                                image_paint(&path, tx - vis.x, ty - vis.y, tw, th, false, false);
                            shapes.push(
                                rect_shape(&sid, vis.w, vis.h, 0.0, fill)
                                    .at(vis.x, vis.y)
                                    .build(),
                            );
                        }
                    }
                    if shapes.is_empty() {
                        return None;
                    }
                    let whole_single =
                        count == 1 && Rect::new(xs[0], ys[0], tw, th).contains_rect(&paint);
                    if whole_single {
                        // One picture covering the painting area: shape it
                        // like the area, so a radius rounds it.
                        let fill = image_paint(
                            &path,
                            xs[0] - paint.x,
                            ys[0] - paint.y,
                            tw,
                            th,
                            false,
                            false,
                        );
                        return Some(self.region_shape(id, paint, paint_radii, fill));
                    }
                    if shapes.len() == 1 {
                        let mut only = shapes.pop().unwrap();
                        self.clip_layer(&mut only, paint, paint_radii);
                        return Some(only);
                    }
                    let clip = self.region_clip(paint, paint_radii, 0.0, 0.0);
                    return Some(super::util::group(id, shapes).set("clip", clip).build());
                }
                // Repeating along at least one axis: one shape with an image
                // paint, limited to the tile's band on an axis that does not
                // repeat.
                let mut shape_rect = paint;
                if !repeat_x {
                    shape_rect = Rect::new(xs[0], shape_rect.y, tw, shape_rect.h).intersect(&paint);
                }
                if !repeat_y {
                    shape_rect = Rect::new(shape_rect.x, ys[0], shape_rect.w, th).intersect(&paint);
                }
                if shape_rect.is_empty() {
                    return None;
                }
                let fill = image_paint(
                    &path,
                    xs[0] - shape_rect.x,
                    ys[0] - shape_rect.y,
                    tw,
                    th,
                    repeat_x,
                    repeat_y,
                );
                if shape_rect == paint {
                    return Some(self.region_shape(id, paint, paint_radii, fill));
                }
                let mut shape = rect_shape(id, shape_rect.w, shape_rect.h, 0.0, fill)
                    .at(shape_rect.x, shape_rect.y)
                    .build();
                self.clip_layer(&mut shape, paint, paint_radii);
                Some(shape)
            }
        }
    }

    /// A clip path (scene `clip`) of a region, in the coordinates of a layer
    /// whose origin is at (`ox`, `oy`) of the box's space.
    pub fn region_clip(&self, rect: Rect, radii: Radii, ox: f64, oy: f64) -> Value {
        let radii = radii.fitted(rect.w, rect.h);
        let r = Rect::new(rect.x - ox, rect.y - oy, rect.w, rect.h);
        if radii.is_zero() {
            json!({ "kind": "polygon", "points": [
                [num(r.x), num(r.y)], [num(r.right()), num(r.y)],
                [num(r.right()), num(r.bottom())], [num(r.x), num(r.bottom())] ] })
        } else {
            json!({ "kind": "path", "d": path_d(&rounded_rect_path(r, radii)) })
        }
    }

    /// Cuts `layer` (whose origin is its `transform` x, y) to a region, when
    /// the region is not already the layer's own extent.
    pub fn clip_layer(&self, layer: &mut Value, rect: Rect, radii: Radii) {
        let (ox, oy) = layer_origin(layer);
        let clip = self.region_clip(rect, radii, ox, oy);
        if let Some(o) = layer.as_object_mut() {
            o.insert("clip".into(), clip);
        }
    }
}

/// The offset of a layer in its parent.
pub fn layer_origin(layer: &Value) -> (f64, f64) {
    let t = layer.get("transform");
    let g = |k: &str| {
        t.and_then(|t| t.get(k))
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    };
    (g("x"), g("y"))
}

fn image_paint(path: &str, x: f64, y: f64, w: f64, h: f64, rx: bool, ry: bool) -> Value {
    let mut v = json!({
        "type": "image", "src": path,
        "x": num(x), "y": num(y), "width": num(w), "height": num(h),
    });
    if rx {
        v["repeatX"] = json!(true);
    }
    if ry {
        v["repeatY"] = json!(true);
    }
    v
}

/// Maps a CSS blend mode's `Debug` name to the scene's.
pub fn blend_name(name: &str) -> &'static str {
    match name {
        "Multiply" => "multiply",
        "Screen" => "screen",
        "Overlay" => "overlay",
        "Darken" => "darken",
        "Lighten" => "lighten",
        "ColorDodge" => "colorDodge",
        "ColorBurn" => "colorBurn",
        "HardLight" => "hardLight",
        "SoftLight" => "softLight",
        "Difference" => "difference",
        "Exclusion" => "exclusion",
        "Hue" => "hue",
        "Saturation" => "saturation",
        "Color" => "color",
        "Luminosity" => "luminosity",
        _ => "normal",
    }
}

/// The size of one tile: CSS Backgrounds 3 §3.9 "background-size" with the
/// image's natural size (none for a gradient, which takes the area).
fn tile_size(size: &BackgroundSize, natural: Option<(f64, f64)>, area: Rect) -> (f64, f64) {
    match size {
        BackgroundSize::Cover | BackgroundSize::Contain => {
            let Some((nw, nh)) = natural else {
                return (area.w, area.h);
            };
            if !(nw > 0.0 && nh > 0.0) {
                return (area.w, area.h);
            }
            let (sx, sy) = (area.w / nw, area.h / nh);
            let s = if matches!(size, BackgroundSize::Cover) {
                sx.max(sy)
            } else {
                sx.min(sy)
            };
            (nw * s, nh * s)
        }
        BackgroundSize::ExplicitSize { width, height } => {
            let w = match width {
                LpAuto::LengthPercentage(l) => Some(lp(&l.0, area.w)),
                LpAuto::Auto => None,
            };
            let h = match height {
                LpAuto::LengthPercentage(l) => Some(lp(&l.0, area.h)),
                LpAuto::Auto => None,
            };
            match (w, h, natural) {
                (Some(w), Some(h), _) => (w, h),
                (Some(w), None, Some((nw, nh))) if nw > 0.0 => (w, w * nh / nw),
                (None, Some(h), Some((nw, nh))) if nh > 0.0 => (h * nw / nh, h),
                (None, None, Some((nw, nh))) => (nw, nh),
                // A gradient has no ratio: an auto side is the area's.
                (Some(w), None, _) => (w, area.h),
                (None, Some(h), _) => (area.w, h),
                (None, None, _) => (area.w, area.h),
            }
        }
    }
}

/// Where the tiles of one axis start, for the area `area_start` long
/// `area_len` and a tile `tile` long at offset `off` (CSS Backgrounds 3 §3.5
/// and §3.6), covering at least `paint_start..paint_end`.
fn axis_tiles(
    area_start: f64,
    area_len: f64,
    tile: f64,
    off: f64,
    repeat: Tile,
    paint_start: f64,
    paint_end: f64,
) -> (Vec<f64>, f64) {
    // The list is cut to what any caller draws one by one (`MAX_TILES`, and
    // one more so that "too many" shows); the count is the real one, worked
    // out before anything is listed, so a near-zero tile costs nothing.
    let keep = MAX_TILES + 1;
    if tile.is_nan() || tile <= 0.0 || !(area_start + off).is_finite() {
        return (Vec::new(), 0.0);
    }
    match repeat {
        Tile::NoRepeat => (vec![area_start + off], 1.0),
        Tile::Repeat | Tile::Round => {
            let start = area_start + off;
            let first = ((paint_start - start) / tile).floor();
            let last = ((paint_end - start) / tile).ceil();
            let total = (last - first).max(0.0);
            if !total.is_finite() {
                return (Vec::new(), 0.0);
            }
            let starts = (0..(total as usize).min(keep))
                .map(|k| start + (first + k as f64) * tile)
                .collect();
            (starts, total)
        }
        Tile::Space => {
            let n = (area_len / tile).floor();
            if !n.is_finite() || n < 2.0 {
                return (vec![area_start + off], 1.0);
            }
            let gap = (area_len - n * tile) / (n - 1.0);
            let starts = (0..(n as usize).min(keep))
                .map(|k| area_start + k as f64 * (tile + gap))
                .collect();
            (starts, n)
        }
    }
}

#[allow(dead_code)]
fn unused(_: Origin, _: String) -> String {
    hex(&AbsoluteColor::BLACK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeat_tiles_cover_the_paint_area() {
        let (xs, _) = axis_tiles(0.0, 100.0, 30.0, 0.0, Tile::Repeat, 0.0, 100.0);
        assert_eq!(xs, vec![0.0, 30.0, 60.0, 90.0]);
        // Offset: a tile starts before the area and the first one is included.
        let (xs, _) = axis_tiles(0.0, 100.0, 30.0, 10.0, Tile::Repeat, 0.0, 100.0);
        assert_eq!(
            xs,
            vec![-20.0, 10.0, 40.0, 70.0, 100.0 - 0.0]
                .into_iter()
                .take(4)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_tiny_tile_is_counted_not_listed() {
        for repeat in [Tile::Repeat, Tile::Round, Tile::Space] {
            let (xs, total) = axis_tiles(0.0, 1000.0, 0.0001, 0.0, repeat, 0.0, 1000.0);
            assert!(xs.len() <= MAX_TILES + 1, "{repeat:?}");
            assert!(total > MAX_TILES as f64, "{repeat:?}");
        }
        for bad in [f64::NAN, f64::INFINITY, -1.0, 0.0] {
            let (xs, total) = axis_tiles(0.0, 100.0, bad, 0.0, Tile::Repeat, 0.0, 100.0);
            assert!(xs.len() <= MAX_TILES + 1 && total.is_finite());
        }
    }

    #[test]
    fn space_distributes_the_gap() {
        let (xs, _) = axis_tiles(0.0, 100.0, 30.0, 0.0, Tile::Space, 0.0, 100.0);
        assert_eq!(xs.len(), 3);
        assert!((xs[1] - 35.0).abs() < 1e-9 && (xs[2] - 70.0).abs() < 1e-9);
    }

    #[test]
    fn cover_and_contain_keep_the_ratio() {
        let area = Rect::new(0.0, 0.0, 200.0, 100.0);
        assert_eq!(
            tile_size(&BackgroundSize::Cover, Some((50.0, 50.0)), area),
            (200.0, 200.0)
        );
        assert_eq!(
            tile_size(&BackgroundSize::Contain, Some((50.0, 50.0)), area),
            (100.0, 100.0)
        );
    }
}
