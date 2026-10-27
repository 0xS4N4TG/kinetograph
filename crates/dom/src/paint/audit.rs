//! What an element asks for that the painter skips: each is reported as an
//! `Unsupported` item once per element, so a frame that is not drawn as Chrome
//! draws it says so. (Features that are drawn approximately, like Chrome's
//! exact dash lengths, are not here: they are drawn.)

use blitz_dom::Node;
use style::properties::ComputedValues;

use super::Painter;

impl<'a> Painter<'a> {
    /// Reports the properties of `node` that are not painted.
    pub fn audit(&mut self, node: &'a Node, style: &ComputedValues) {
        if !self.audited.insert(node.id.as_u64()) {
            return;
        }
        let tag = self.tag_of(node);
        if matches!(tag.as_str(), "input" | "textarea" | "select") {
            self.report_element(
                node,
                "a form control's value, caret and widget drawing are not painted",
            );
        }
        if matches!(tag.as_str(), "iframe" | "object" | "embed") {
            self.report_element(node, "an embedded document is not painted");
        }

        let dbg = |v: &dyn std::fmt::Debug| format!("{v:?}").to_lowercase();

        let ir = dbg(&style.get_inherited_box().image_rendering);
        if ir != "auto" {
            self.report(
                node,
                "image-rendering",
                ir,
                "pictures are always smoothly resampled",
            );
        }
        if style
            .get_background()
            .background_attachment
            .0
            .iter()
            .any(|a| dbg(a) == "fixed")
        {
            self.report(
                node,
                "background-attachment",
                "fixed",
                "a fixed background scrolls with the box (nothing scrolls in a frame)",
            );
        }
        let bdb = dbg(&style.get_border().box_decoration_break);
        if bdb == "clone" {
            self.report(
                node,
                "box-decoration-break",
                "clone",
                "line fragments are sliced",
            );
        }
        let wm = dbg(&style.get_inherited_box().writing_mode);
        if wm != "horizontaltb" && wm != "horizontal-tb" {
            self.report(
                node,
                "writing-mode",
                wm,
                "vertical text is not painted as Chrome lays it out",
            );
        }
        let col = style.get_column();
        if dbg(&col.column_count) != "auto" || dbg(&col.column_width) != "auto" {
            self.report(
                node,
                "columns",
                "multi-column",
                "multi-column layout is not done",
            );
        }
        let clip = dbg(&style.get_effects().clip);
        if clip != "auto" {
            self.report(
                node,
                "clip",
                clip,
                "the deprecated clip property is not drawn",
            );
        }
        let lsi = dbg(&style.get_list().list_style_image);
        if lsi != "none" {
            self.report(
                node,
                "list-style-image",
                lsi,
                "a picture marker is not drawn",
            );
        }
        // Blurs past the limit of the blur effect are clamped.
        if style.get_effects().filter.0.iter().any(
            |f| matches!(f, style::values::generics::effects::Filter::Blur(r) if r.0.px() > 512.0),
        ) {
            self.report(
                node,
                "filter",
                "blur",
                "a blur above 512px is limited to 512px",
            );
        }
    }
}
