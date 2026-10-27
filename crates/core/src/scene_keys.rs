//! The keys of a scene file that the format does not read (`bogusTop`, a
//! misspelt `opacty`): serde skips them, so a typo would change nothing and
//! say nothing. `unknown_keys` names each by its JSON path, for `lint` and
//! `render` to warn about (`--strict` fails on them).
//!
//! The scene types cannot refuse unknown fields themselves: a layer is a
//! struct with its kind flattened in, and the kinds, effects and clips are
//! internally tagged enums, which serde reads through a buffer that drops what
//! no field takes. So the check asks serde: a key is read when giving it a
//! value no field type accepts makes the layer (or the scene) fail to parse.
//! Two such values are tried, a control-character string and `true`, since a
//! string field takes the first; a key that takes both is taken as not read.
//!
//! So a field must refuse one of them. A field typed `serde_json::Value` or
//! `IgnoredAny`, or an untagged enum with both a string and a bool variant,
//! takes any value and would be reported as unknown: give such a field a type
//! that refuses one of the two values, or add a case here before adding it.
//! `the_shipped_scenes_have_no_unknown_keys` (tests/scene_keys.rs) fails when a
//! shipped scene uses one.
//!
//! Each layer is parsed on its own with its children left out, and a key's
//! answer is kept for every object at the same place in the same kinds of
//! objects (`layers[].effects[]{type=blur}.radius`), so a scene with a
//! thousand glyphs or canvas commands asks about each key once.

use std::collections::HashMap;

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::scene::{Layer, Scene};

/// The keys an internally tagged enum of the format is told apart by.
const TAGS: [&str; 6] = ["type", "kind", "op", "primitive", "c", "k"];

/// The JSON paths of the keys in `json` that the scene format does not read,
/// sorted (the order of an object's keys depends on serde_json's features).
/// Empty when `json` is not a scene that parses.
pub fn unknown_keys(json: &str) -> Vec<String> {
    let Ok(root) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    let mut finder = Finder::default();
    finder.unit::<Scene>(&root, String::new(), "scene", "layers");
    finder.found.sort();
    finder.found
}

#[derive(Default)]
struct Finder {
    /// Whether a key is read, by the place it is at (`Finder::shape`).
    read: HashMap<String, bool>,
    found: Vec<String>,
}

/// One step from an object of the unit to the object a key is in.
enum Step<'a> {
    Key(&'a str),
    Index(usize),
}

impl Finder {
    /// Checks the keys of one unit: the scene (type `T` = `Scene`, its layers
    /// in `nested`) or a layer (`Layer`, its children in `children`). The
    /// nested layers are left out of the copy that is parsed and checked as
    /// units of their own.
    fn unit<T: DeserializeOwned>(&mut self, value: &Value, path: String, kind: &str, nested: &str) {
        let Some(object) = value.as_object() else {
            return;
        };
        let mut stripped = object.clone();
        if stripped.contains_key(nested) {
            stripped.insert(nested.to_string(), Value::Array(Vec::new()));
        }
        let stripped = Value::Object(stripped);
        // A unit that does not parse as it is has nothing to compare against.
        if serde_json::from_value::<T>(stripped.clone()).is_err() {
            return;
        }
        let shape = format!("{kind}{}", tags_of(object));
        let mut steps = Vec::new();
        self.object::<T>(&stripped, object, &mut steps, &path, &shape, nested);
    }

    /// The keys of `object`, which is at `steps` in the unit `stripped`, then
    /// the objects inside the keys that are read.
    fn object<'a, T: DeserializeOwned>(
        &mut self,
        stripped: &Value,
        object: &'a Map<String, Value>,
        steps: &mut Vec<Step<'a>>,
        path: &str,
        shape: &str,
        nested: &str,
    ) {
        let at_root = steps.is_empty();
        for (key, value) in object {
            let key_path = join(path, key);
            let place = format!("{shape}.{key}");
            if !self.is_read::<T>(stripped, steps, key, &place) {
                self.found.push(key_path);
                continue;
            }
            if at_root && key == nested {
                if let Some(layers) = value.as_array() {
                    for (i, layer) in layers.iter().enumerate() {
                        self.unit::<Layer>(layer, format!("{key_path}[{i}]"), "layer", "children");
                    }
                }
                continue;
            }
            steps.push(Step::Key(key));
            self.value::<T>(stripped, value, steps, &key_path, &place, nested);
            steps.pop();
        }
    }

    fn value<'a, T: DeserializeOwned>(
        &mut self,
        stripped: &Value,
        value: &'a Value,
        steps: &mut Vec<Step<'a>>,
        path: &str,
        shape: &str,
        nested: &str,
    ) {
        match value {
            Value::Object(object) => {
                let shape = format!("{shape}{}", tags_of(object));
                self.object::<T>(stripped, object, steps, path, &shape, nested);
            }
            Value::Array(items) => {
                let shape = format!("{shape}[]");
                for (i, item) in items.iter().enumerate() {
                    steps.push(Step::Index(i));
                    self.value::<T>(
                        stripped,
                        item,
                        steps,
                        &format!("{path}[{i}]"),
                        &shape,
                        nested,
                    );
                    steps.pop();
                }
            }
            _ => {}
        }
    }

    /// Whether parsing the unit fails once `key` (of the object at `steps`)
    /// holds a value no field type takes.
    fn is_read<T: DeserializeOwned>(
        &mut self,
        stripped: &Value,
        steps: &[Step],
        key: &str,
        place: &str,
    ) -> bool {
        if let Some(&read) = self.read.get(place) {
            return read;
        }
        let read = [Value::String("\u{1}".into()), Value::Bool(true)]
            .into_iter()
            .any(|probe| {
                let mut copy = stripped.clone();
                let Some(target) = object_at(&mut copy, steps) else {
                    return false;
                };
                target.insert(key.to_string(), probe);
                serde_json::from_value::<T>(copy).is_err()
            });
        self.read.insert(place.to_string(), read);
        read
    }
}

fn object_at<'v>(value: &'v mut Value, steps: &[Step]) -> Option<&'v mut Map<String, Value>> {
    let mut at = value;
    for step in steps {
        at = match step {
            Step::Key(k) => at.get_mut(*k)?,
            Step::Index(i) => at.get_mut(*i)?,
        };
    }
    at.as_object_mut()
}

/// `{type=blur}` for an object tagged `"type": "blur"`: objects of different
/// kinds at the same place read different keys.
fn tags_of(object: &Map<String, Value>) -> String {
    let mut out = String::new();
    for tag in TAGS {
        if let Some(Value::String(name)) = object.get(tag) {
            out.push_str(&format!("{{{tag}={name}}}"));
        }
    }
    out
}

fn join(path: &str, key: &str) -> String {
    let plain = key
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$');
    if plain {
        if path.is_empty() {
            key.to_string()
        } else {
            format!("{path}.{key}")
        }
    } else {
        format!("{path}[{}]", Value::String(key.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::unknown_keys;

    #[test]
    fn names_each_unknown_key_by_its_path() {
        let json = r##"{"width":64,"height":64,"fps":10,"durationInFrames":2,"bogusTop":1,
            "layers":[{"id":"r","type":"shape","wibble":3,"shape":{"kind":"rect","width":20,"height":20,"nope":1},"fill":"#f00"}]}"##;
        assert_eq!(
            unknown_keys(json),
            ["bogusTop", "layers[0].shape.nope", "layers[0].wibble"]
        );
    }

    #[test]
    fn reads_keys_by_the_kind_of_object_they_are_in() {
        // `radius` is read by a blur and not by an opacity effect; `children` only by a group.
        let json = r##"{"width":64,"height":64,"fps":10,"durationInFrames":2,"layers":[
            {"id":"g","type":"group","opacity":1,"children":[
                {"id":"a","type":"shape","shape":{"kind":"rect","width":2,"height":2},"fill":"#fff",
                 "effects":[{"type":"blur","radius":2},{"type":"blur","radius":3,"spread":1}],"children":[]}
            ]}]}"##;
        assert_eq!(
            unknown_keys(json),
            [
                "layers[0].children[0].children",
                "layers[0].children[0].effects[1].spread"
            ]
        );
    }

    #[test]
    fn a_default_valued_or_string_key_is_still_read() {
        let json = r##"{"width":64,"height":64,"fps":10,"durationInFrames":2,"background":"#000","fonts":{"Inter":"a.ttf"},
            "layers":[{"id":"t","type":"text","text":"hi","font":"Inter","size":10,"opacity":1,"blendMode":"normal","color":"#fff"}]}"##;
        assert_eq!(unknown_keys(json), Vec::<String>::new());
    }

    #[test]
    fn says_nothing_of_json_that_is_not_a_scene() {
        assert!(unknown_keys("not json").is_empty());
        assert!(unknown_keys(r#"{"width":1}"#).is_empty());
    }
}
