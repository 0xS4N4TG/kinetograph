//! Images an SVG hands to the renderer, and files it reads.
//!
//! The scene's `image` layer takes a `data:` URL, which the core decodes from
//! memory, so the bytes of an `<image>` that usvg has decoded are passed on
//! as one (`data_url`) and no file is written anywhere.
//!
//! What an `<image href>` reads (`resolve_under`) must stay inside the
//! project's directories: no `..`, and the file as the system resolves it
//! (symbolic links included) under one of them. An absolute path is taken
//! when it lands there (`staticFile()` gives one).

use std::path::{Component, Path, PathBuf};

/// `bytes` as a `data:` URL of `ext` (`png`, `jpg` or `webp`).
pub fn data_url(ext: &str, bytes: &[u8]) -> String {
    use base64::Engine as _;
    let mime = match ext {
        "jpg" => "jpeg",
        "webp" => "webp",
        _ => "png",
    };
    format!(
        "data:image/{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// The file `href` names under one of `roots`, canonicalized, or `None`: the
/// path must have no `..`, exist, and resolve (through links) to somewhere
/// under the canonical form of that root. An absolute path is accepted only
/// by that last test.
pub fn resolve_under(roots: &[&Path], href: &str) -> Option<PathBuf> {
    let rel = Path::new(href);
    if href.is_empty()
        || rel.components().any(|c| {
            !matches!(
                c,
                Component::Normal(_) | Component::CurDir | Component::RootDir
            )
        })
    {
        return None;
    }
    roots.iter().find_map(|root| {
        let base = root.canonicalize().ok()?;
        // An absolute path is taken as it is; failing that, as a path from the
        // root (`/logo.png`, the form of a URL).
        let stripped = rel.strip_prefix("/").unwrap_or(rel);
        [rel, stripped].into_iter().find_map(|r| {
            let file = base.join(r).canonicalize().ok()?;
            (file.starts_with(&base) && file.is_file()).then_some(file)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    /// A fresh directory under the temporary one.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kg-assets-test-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn image_bytes_become_a_data_url_the_scene_decodes_in_memory() {
        let url = data_url("png", b"\x89PNG bytes");
        assert!(url.starts_with("data:image/png;base64,"));
        assert!(data_url("jpg", b"x").starts_with("data:image/jpeg;base64,"));
        assert!(data_url("webp", b"x").starts_with("data:image/webp;base64,"));
    }

    #[test]
    fn an_href_stays_inside_its_roots() {
        let base = scratch("roots");
        let (public, outside) = (base.join("public"), base.join("outside"));
        std::fs::create_dir_all(public.join("sub")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(public.join("a.png"), b"a").unwrap();
        std::fs::write(public.join("sub/b.png"), b"b").unwrap();
        std::fs::write(outside.join("secret.txt"), b"s").unwrap();
        symlink(outside.join("secret.txt"), public.join("link.png")).unwrap();
        let roots = [public.as_path()];
        let public = public.canonicalize().unwrap();
        assert_eq!(resolve_under(&roots, "a.png"), Some(public.join("a.png")));
        assert_eq!(
            resolve_under(&roots, "./sub/b.png"),
            Some(public.join("sub/b.png"))
        );
        // Out of the root: by `..`, by an absolute path, by a link, or missing.
        assert_eq!(resolve_under(&roots, "../outside/secret.txt"), None);
        assert_eq!(resolve_under(&roots, "sub/../../outside/secret.txt"), None);
        let absolute = outside.join("secret.txt");
        assert_eq!(resolve_under(&roots, absolute.to_str().unwrap()), None);
        // An absolute path inside a root is read (`staticFile()` gives one).
        let inside = public.join("a.png");
        assert_eq!(
            resolve_under(&roots, inside.to_str().unwrap()),
            Some(public.join("a.png"))
        );
        let dotted = format!("{}/sub/../a.png", public.display());
        assert_eq!(resolve_under(&roots, &dotted), None);
        assert_eq!(resolve_under(&roots, "/a.png"), Some(public.join("a.png")));
        assert_eq!(resolve_under(&roots, "link.png"), None);
        assert_eq!(resolve_under(&roots, "nope.png"), None);
        assert_eq!(resolve_under(&roots, ""), None);
        assert_eq!(resolve_under(&roots, "sub"), None);
        // A second root is tried.
        let second = [outside.as_path(), roots[0]];
        assert_eq!(resolve_under(&second, "a.png"), Some(public.join("a.png")));
    }
}
