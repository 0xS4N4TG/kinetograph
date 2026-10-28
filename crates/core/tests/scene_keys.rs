//! Every scene the repository ships reads all of its keys: the unknown-key
//! check (`scene_keys::unknown_keys`) finds nothing in a valid scene.

use std::path::Path;

use kinetograph_core::scene_keys::unknown_keys;

#[test]
fn the_shipped_scenes_have_no_unknown_keys() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut checked = 0;
    let mut unknown = Vec::new();
    for dir in [root.join("tests/scenes"), root.join("../../examples")] {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            let json = std::fs::read_to_string(&path).unwrap();
            // Only scenes: a fixture that is not one (or does not load) is not checked.
            if serde_json::from_str::<kinetograph_core::Scene>(&json).is_err() {
                continue;
            }
            let keys = unknown_keys(&json);
            if !keys.is_empty() {
                unknown.push(format!("{}: {}", path.display(), keys.join(", ")));
            }
            checked += 1;
        }
    }
    assert!(checked >= 60, "only {checked} scenes checked");
    assert!(unknown.is_empty(), "{}", unknown.join("\n"));
}
