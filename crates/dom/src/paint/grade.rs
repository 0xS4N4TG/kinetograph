//! HyperFrames' `data-color-grading` on a picture: the `data-kg-grade` attribute the runtime writes (the grade as
//! HyperFrames normalises it, one frame of it) becomes a `colorGrade` effect on the element's group
//! (`crates/core/src/grade.rs`). The element's content box is the box the vignette and the grain are laid out on.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use blitz_dom::Node;
use serde_json::{Value, json};

use super::geom::BoxGeom;
use super::{Painter, attr};

/// The attribute that carries the grade.
pub const GRADE_ATTR: &str = "data-kg-grade";

/// Whether the look-up table at `path` reads, remembered for the process (a table is read once, not each frame).
fn lut_problem(path: &std::path::Path) -> Option<String> {
    static CHECKED: OnceLock<Mutex<HashMap<std::path::PathBuf, Option<String>>>> = OnceLock::new();
    let cache = CHECKED.get_or_init(Default::default);
    let mut cache = cache.lock().unwrap_or_else(|e| e.into_inner());
    cache
        .entry(path.to_path_buf())
        .or_insert_with(|| {
            let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read: {e}"));
            text.and_then(|t| kinetograph_core::lut::Lut::parse(&t).map(|_| ()))
                .err()
        })
        .clone()
}

impl<'a> Painter<'a> {
    /// The `colorGrade` effect of an element that carries a grade, or none.
    pub fn color_grade_effect(&mut self, node: &'a Node, geom: &BoxGeom) -> Option<Value> {
        let text = attr(node, GRADE_ATTR)?;
        let Ok(Value::Object(mut grade)) = serde_json::from_str::<Value>(text) else {
            self.report(node, "data-color-grading", text, "the grade could not be read");
            return None;
        };
        grade.insert("type".into(), json!("colorGrade"));
        let content = geom.content_box();
        grade.insert(
            "box".into(),
            json!([content.x, content.y, content.w, content.h]),
        );
        let src = grade
            .get("lut")
            .and_then(|l| l.get("src"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(src) = src {
            let intensity = grade["lut"].get("intensity").cloned().unwrap_or(json!(1));
            let problem = match self.resolve_relative(&src) {
                None => Some("the file is not in the project".to_string()),
                Some(path) => match lut_problem(&path) {
                    Some(problem) => Some(problem),
                    None => {
                        let absolute = std::path::absolute(&path).unwrap_or(path);
                        grade.insert(
                            "lut".into(),
                            json!({
                                "src": absolute.to_string_lossy(),
                                "intensity": intensity,
                            }),
                        );
                        None
                    }
                },
            };
            if let Some(problem) = problem {
                grade.remove("lut");
                self.report(
                    node,
                    "data-color-grading",
                    format!("lut {src}"),
                    &format!("the look-up table is not drawn: {problem}"),
                );
            }
        }
        Some(Value::Object(grade))
    }
}
