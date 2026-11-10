//! Reading the files a scene names (fonts, images, animations, video and tables), once each.

use super::*;

/// The `src` of every image layer in the scene, in order of use. One used
/// twice is listed twice.
fn image_sources(scene: &Scene) -> Vec<String> {
    // `walk_layers` also visits motion-blur copies, which can hold images of
    // their own.
    let mut sources = filter_image_sources(scene);
    walk_layers(&scene.layers, &mut |layer| match &layer.kind {
        LayerKind::Image(i) => sources.push(i.src.clone()),
        // A picture as a fill or a text colour (`scene::Paint::Image`).
        LayerKind::Shape(ShapeLayer {
            fill: Some(Paint::Image(i)),
            ..
        })
        | LayerKind::Text(TextLayer {
            color: Paint::Image(i),
            ..
        }) => sources.push(i.src.clone()),
        // The pictures a canvas's commands draw.
        LayerKind::Canvas(c) => canvas::sources(&c.commands.0, &mut sources),
        _ => {}
    });
    sources
}

/// The `href` of every `feImage` in the scene's filter graphs, in order of use.
pub(super) fn filter_image_sources(scene: &Scene) -> Vec<String> {
    let mut sources = Vec::new();
    walk_layers(&scene.layers, &mut |layer| {
        for effect in &layer.effects {
            if let crate::scene::Effect::FilterGraph(graph) = effect {
                sources.extend(graph.image_sources().map(str::to_string));
            }
        }
    });
    sources
}

/// Decodes the image file `src`, relative to `base_dir`.
fn read_image(base_dir: &Path, src: &str) -> Result<ImageData> {
    let path = base_dir.join(src);
    // An SVG picture is painted at the size it is drawn at (`svg_picture`); here it is checked and painted at its
    // natural size.
    if crate::svg_picture::is_svg(src) {
        let picture = crate::svg_picture::Picture::open(base_dir, src)
            .map_err(|e| Error::Render(format!("cannot decode {}: {e}", path.display())))?;
        let (width, height) = crate::scene::image_dimensions(base_dir, src).map_err(Error::Render)?;
        let rgba = picture
            .paint(width, height)
            .ok_or_else(|| Error::Render(format!("cannot paint {}", path.display())))?;
        return Ok(ImageData {
            data: Blob::from(rgba),
            format: ImageFormat::Rgba8,
            alpha_type: ImageAlphaType::Alpha,
            width,
            height,
        });
    }
    // A `data:` URL is decoded from memory, with no file.
    let decoded = if let Some(bytes) = crate::scene::data_uri_bytes(src) {
        image::load_from_memory(&bytes)
            .map_err(|e| Error::Render(format!("cannot decode a data: picture: {e}")))?
    } else {
        image::open(&path)
            .map_err(|e| Error::Render(format!("cannot decode {}: {e}", path.display())))?
    }
    .to_rgba8();
    let (width, height) = decoded.dimensions();
    Ok(ImageData {
        data: Blob::from(decoded.into_raw()),
        format: ImageFormat::Rgba8,
        alpha_type: ImageAlphaType::Alpha,
        width,
        height,
    })
}

/// Decodes every image the scene refers to. The renderer reads them a file at
/// a time (`read_assets`); this is for the test that every committed scene's
/// files load.
#[cfg(test)]
pub(crate) fn load_images(scene: &Scene) -> Result<HashMap<String, ImageData>> {
    let mut images = HashMap::new();
    for src in image_sources(scene) {
        if images.contains_key(&src) {
            continue;
        }
        let image = read_image(&scene.base_dir, &src)?;
        images.insert(src, image);
    }
    Ok(images)
}

/// The model, texture and environment files the 3D layers of `scene` name.
pub(crate) fn scene3d_sources(scene: &Scene) -> Sources3d {
    let mut all = Sources3d::default();
    walk_layers(&scene.layers, &mut |layer| {
        if let LayerKind::Scene3d(s) = &layer.kind {
            let sources = s.sources();
            all.models.extend(sources.models);
            all.textures.extend(sources.textures);
            all.environments.extend(sources.environments);
        }
    });
    all
}

/// A file as the renderer read it. Two scenes that name the same file get
/// the same `FileId` as long as it has not been edited, and the renderer then
/// keeps what it read instead of reading again. (The modification time only
/// decides whether to read again; it never reaches a pixel.)
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct FileId {
    /// Absolute, so the same file reached from two scenes' directories is one.
    pub(super) path: PathBuf,
    pub(super) len: u64,
    modified: Option<SystemTime>,
}

impl FileId {
    /// A file that cannot be inspected gets an id no earlier read has, so
    /// the read that follows reports what is wrong with it.
    pub(super) fn of(path: &Path) -> FileId {
        let path = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
        let meta = std::fs::metadata(&path).ok();
        FileId {
            len: meta.as_ref().map_or(0, std::fs::Metadata::len),
            modified: meta.and_then(|m| m.modified().ok()),
            path,
        }
    }
}

/// The files behind everything a renderer has loaded from scenes, by the
/// name a scene calls it: a font family, an image's or a table's `src`.
#[derive(Default)]
pub(super) struct Loaded {
    pub(super) fonts: BTreeMap<String, FileId>,
    pub(super) images: HashMap<String, FileId>,
    pub(super) lotties: HashMap<String, FileId>,
    pub(super) videos: HashMap<String, FileId>,
    pub(super) gifs: HashMap<String, FileId>,
    pub(super) luts: HashMap<String, FileId>,
    pub(super) models: HashMap<String, FileId>,
    pub(super) textures3d: HashMap<String, FileId>,
    pub(super) environments: HashMap<String, FileId>,
}

/// What reading a scene's assets found that the renderer did not hold yet
/// (`read_assets`).
pub(super) struct NewAssets {
    /// An engine with every font, made when a font is new or has changed
    /// (and when the renderer has none).
    pub(super) text: Option<TextEngine>,
    /// Every font the renderer will hold.
    pub(super) fonts: BTreeMap<String, FileId>,
    pub(super) images: Vec<(String, FileId, ImageData)>,
    pub(super) lotties: Vec<(String, FileId, Lottie)>,
    pub(super) videos: Vec<(String, FileId, VideoDecoder)>,
    pub(super) gifs: Vec<(String, FileId, Gif)>,
    pub(super) luts: Vec<(String, FileId, Lut)>,
    pub(super) models: Vec<(String, FileId, Model)>,
    pub(super) textures3d: Vec<(String, FileId, Texture)>,
    pub(super) environments: Vec<(String, FileId, Environment)>,
    /// A name the renderer already held now stands for another file, so what
    /// the layer cache drew from the old one is out of date.
    pub(super) rebound: bool,
}

impl NewAssets {
    /// Whether nothing was read: no font, file or table the renderer did not
    /// hold, and none that changed.
    pub(super) fn is_empty(&self) -> bool {
        self.text.is_none()
            && self.images.is_empty()
            && self.lotties.is_empty()
            && self.videos.is_empty()
            && self.gifs.is_empty()
            && self.luts.is_empty()
            && self.models.is_empty()
            && self.textures3d.is_empty()
            && self.environments.is_empty()
            && !self.rebound
    }
}

/// Reads the fonts, images, Lottie animations, videos, GIFs and tables of `scene` that
/// `loaded` does not have
/// (or has from another file). It changes nothing, so a failure leaves the
/// renderer as it was; `Renderer::install_assets` keeps the result. With
/// `has_text` false the result has a text engine whatever the fonts are.
///
/// Fonts the renderer holds stay registered when the scene does not name
/// them. That cannot change a frame: a text layer's font must be one of the
/// scene's own (`Scene::validate`), and no system fonts are loaded for text
/// to fall back on.
pub(super) fn read_assets(scene: &Scene, loaded: &Loaded, has_text: bool) -> Result<NewAssets> {
    let mut rebound = false;

    let mut fonts = loaded.fonts.clone();
    // The new fonts' paths, as the scene spells them.
    let mut files = BTreeMap::new();
    for (name, file) in &scene.fonts {
        let path = scene.base_dir.join(file);
        let id = FileId::of(&path);
        match fonts.get(name) {
            Some(held) if *held == id => continue,
            Some(_) => rebound = true,
            None => {}
        }
        files.insert(name.clone(), path.to_string_lossy().into_owned());
        fonts.insert(name.clone(), id);
    }
    let text = if has_text && files.is_empty() {
        None
    } else {
        for (name, id) in &fonts {
            files
                .entry(name.clone())
                .or_insert_with(|| id.path.to_string_lossy().into_owned());
        }
        // Paths are already joined to their scene's directory.
        Some(TextEngine::new(&files, Path::new(""))?)
    };

    let mut images = Vec::new();
    let mut seen = HashSet::new();
    for src in image_sources(scene) {
        if !seen.insert(src.clone()) {
            continue;
        }
        let id = FileId::of(&scene.base_dir.join(&src));
        match loaded.images.get(&src) {
            Some(held) if *held == id => continue,
            Some(_) => rebound = true,
            None => {}
        }
        let image = read_image(&scene.base_dir, &src)?;
        images.push((src, id, image));
    }

    let mut lotties = Vec::new();
    let mut seen = HashSet::new();
    for (layer, src) in lottie_sources(scene) {
        if !seen.insert(src.clone()) {
            continue;
        }
        let id = FileId::of(&scene.base_dir.join(&src));
        match loaded.lotties.get(&src) {
            Some(held) if *held == id => continue,
            Some(_) => rebound = true,
            None => {}
        }
        let lottie = open_lottie(&scene.base_dir, &layer, &src)?;
        lotties.push((src, id, lottie));
    }

    let mut videos = Vec::new();
    let mut seen = HashSet::new();
    for (layer, src) in video_sources(scene) {
        if !seen.insert(src.clone()) {
            continue;
        }
        let id = FileId::of(&scene.base_dir.join(&src));
        match loaded.videos.get(&src) {
            Some(held) if *held == id => continue,
            Some(_) => rebound = true,
            None => {}
        }
        let video = open_video(&scene.base_dir, &layer, &src)?;
        videos.push((src, id, video));
    }

    let mut gifs = Vec::new();
    let mut seen = HashSet::new();
    for (layer, src) in gif_sources(scene) {
        if !seen.insert(src.clone()) {
            continue;
        }
        let id = FileId::of(&scene.base_dir.join(&src));
        match loaded.gifs.get(&src) {
            Some(held) if *held == id => continue,
            Some(_) => rebound = true,
            None => {}
        }
        let gif = open_gif(&scene.base_dir, &layer, &src)?;
        gifs.push((src, id, gif));
    }

    let mut luts = Vec::new();
    let mut seen = HashSet::new();
    for (layer, src) in crate::lut::lut_sources(scene) {
        if !seen.insert(src.clone()) {
            continue;
        }
        let id = FileId::of(&scene.base_dir.join(&src));
        match loaded.luts.get(&src) {
            Some(held) if *held == id => continue,
            Some(_) => rebound = true,
            None => {}
        }
        let lut = crate::lut::read_lut(&scene.base_dir, &layer, &src)?;
        luts.push((src, id, lut));
    }

    let sources3d = scene3d_sources(scene);
    let mut models = Vec::new();
    let mut seen = HashSet::new();
    for src in sources3d.models {
        if !seen.insert(src.clone()) {
            continue;
        }
        let id = FileId::of(&scene.base_dir.join(&src));
        match loaded.models.get(&src) {
            Some(held) if *held == id => continue,
            Some(_) => rebound = true,
            None => {}
        }
        let model = Model::open(&scene.base_dir, &src)?;
        models.push((src, id, model));
    }

    let mut textures3d = Vec::new();
    let mut seen = HashSet::new();
    for src in sources3d.textures {
        if !seen.insert(src.clone()) {
            continue;
        }
        let id = FileId::of(&scene.base_dir.join(&src));
        match loaded.textures3d.get(&src) {
            Some(held) if *held == id => continue,
            Some(_) => rebound = true,
            None => {}
        }
        let texture = Texture::open(&scene.base_dir, &src)?;
        textures3d.push((src, id, texture));
    }

    let mut environments = Vec::new();
    let mut seen = HashSet::new();
    for src in sources3d.environments {
        if !seen.insert(src.clone()) {
            continue;
        }
        let id = FileId::of(&scene.base_dir.join(&src));
        match loaded.environments.get(&src) {
            Some(held) if *held == id => continue,
            Some(_) => rebound = true,
            None => {}
        }
        let environment = Environment::open(&scene.base_dir, &src)?;
        environments.push((src, id, environment));
    }

    Ok(NewAssets {
        text,
        fonts,
        images,
        lotties,
        videos,
        gifs,
        luts,
        models,
        textures3d,
        environments,
        rebound,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scene with an image that has a table, in `dir`, whose fonts are
    /// `fonts` (family -> file).
    fn assets_scene(dir: &Path, fonts: &[(&str, &str)]) -> Scene {
        let fonts: BTreeMap<&str, &str> = fonts.iter().copied().collect();
        let json = serde_json::json!({
            "width": 64, "height": 64, "fps": 30, "durationInFrames": 2,
            "fonts": fonts,
            "layers": [
                { "id": "pic", "type": "image", "src": "pic.png", "width": 8, "height": 8,
                  "effects": [{ "type": "lut", "src": "look.cube" }] },
            ],
        });
        Scene::from_json(&json.to_string(), dir.to_path_buf()).unwrap()
    }
    fn write_assets(dir: &Path, cube_comment: &str) {
        std::fs::create_dir_all(dir).unwrap();
        image::RgbaImage::from_pixel(8, 8, image::Rgba([1, 2, 3, 255]))
            .save(dir.join("pic.png"))
            .unwrap();
        std::fs::write(
            dir.join("look.cube"),
            format!(
                "# {cube_comment}\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n"
            ),
        )
        .unwrap();
    }
    /// What `Renderer::install_assets` records.
    fn hold(loaded: &mut Loaded, fresh: &NewAssets) {
        loaded.fonts = fresh.fonts.clone();
        for (src, id, _) in &fresh.images {
            loaded.images.insert(src.clone(), id.clone());
        }
        for (src, id, _) in &fresh.lotties {
            loaded.lotties.insert(src.clone(), id.clone());
        }
        for (src, id, _) in &fresh.videos {
            loaded.videos.insert(src.clone(), id.clone());
        }
        for (src, id, _) in &fresh.gifs {
            loaded.gifs.insert(src.clone(), id.clone());
        }
        for (src, id, _) in &fresh.luts {
            loaded.luts.insert(src.clone(), id.clone());
        }
    }
    #[test]
    fn assets_are_read_once_and_again_only_when_they_changed() {
        let base = std::env::temp_dir().join(format!("kinetograph-assets-{}", std::process::id()));
        let (a, b) = (base.join("a"), base.join("b"));
        write_assets(&a, "a");
        write_assets(&b, "b, a file of another length");
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let font = root.join("assets/fonts/DMSans-Medium.ttf");
        let font = font.to_str().unwrap();
        let mut loaded = Loaded::default();

        // The first read gets everything, and an engine.
        let scene = assets_scene(&a, &[("DM Sans", font)]);
        let fresh = read_assets(&scene, &loaded, false).unwrap();
        assert!(fresh.text.is_some() && !fresh.rebound);
        assert_eq!((fresh.images.len(), fresh.luts.len()), (1, 1));
        hold(&mut loaded, &fresh);

        // The same scene again: nothing to do.
        let fresh = read_assets(&scene, &loaded, true).unwrap();
        assert!(fresh.text.is_none() && !fresh.rebound);
        assert!(fresh.images.is_empty() && fresh.luts.is_empty());

        // Another directory: the same names stand for other files.
        let moved = assets_scene(&b, &[("DM Sans", font)]);
        let fresh = read_assets(&moved, &loaded, true).unwrap();
        assert!(fresh.rebound);
        assert_eq!((fresh.images.len(), fresh.luts.len()), (1, 1));
        // The font is the same file, spelt as an absolute path both times.
        assert!(fresh.text.is_none());

        // A new family builds a new engine and rebinds nothing.
        let more = assets_scene(&a, &[("DM Sans", font), ("Second", font)]);
        let fresh = read_assets(&more, &loaded, true).unwrap();
        assert!(fresh.text.is_some() && !fresh.rebound);
        assert_eq!(fresh.fonts.len(), 2);
        hold(&mut loaded, &fresh);

        // A family that is not named again stays.
        let fewer = assets_scene(&a, &[]);
        let fresh = read_assets(&fewer, &loaded, true).unwrap();
        assert!(fresh.text.is_none() && fresh.fonts.len() == 2);

        // A file edited in place is read again.
        write_assets(&a, "a, edited so that it is longer");
        let fresh = read_assets(&scene, &loaded, true).unwrap();
        assert!(fresh.rebound && fresh.luts.len() == 1);
        let _ = std::fs::remove_dir_all(&base);
    }
    #[test]
    fn the_picture_of_an_fe_image_is_read_once_like_an_image() {
        let media = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenes/media");
        let graph = serde_json::json!({
            "type": "filterGraph", "filterUnits": "userSpaceOnUse", "x": 0, "y": 0, "width": 8, "height": 8,
            "primitives": [{"primitive": "feImage", "href": "flat.png"},
                           {"primitive": "feImage", "href": "flat.png", "x": 1}],
        });
        let json = serde_json::json!({
            "width": 8, "height": 8, "fps": 30, "durationInFrames": 1,
            "layers": [{ "id": "a", "type": "group", "children": [], "effects": [graph] }],
        });
        let scene = Scene::from_json(&json.to_string(), media).unwrap();
        assert_eq!(filter_image_sources(&scene), ["flat.png", "flat.png"]);
        let fresh = read_assets(&scene, &Loaded::default(), false).unwrap();
        assert_eq!(fresh.images.len(), 1);
        assert_eq!(fresh.images[0].0, "flat.png");
    }
    #[test]
    fn lottie_files_are_read_once_like_images() {
        let anims = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenes/anims");
        let json = serde_json::json!({
            "width": 64, "height": 64, "fps": 30, "durationInFrames": 2,
            "layers": [
                { "id": "a", "type": "lottie", "src": "burst.json", "width": 32, "height": 32 },
                { "id": "b", "type": "lottie", "src": "burst.json", "width": 16, "height": 16 },
            ],
        });
        let scene = Scene::from_json(&json.to_string(), anims).unwrap();
        let mut loaded = Loaded::default();
        let fresh = read_assets(&scene, &loaded, false).unwrap();
        // Two layers, one file.
        assert_eq!(fresh.lotties.len(), 1);
        hold(&mut loaded, &fresh);
        // The next frame's scene names it again: nothing is read.
        let fresh = read_assets(&scene, &loaded, true).unwrap();
        assert!(fresh.lotties.is_empty() && !fresh.rebound);
    }
    #[test]
    fn video_and_gif_files_are_opened_once_per_file() {
        let media = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenes/media");
        let json = serde_json::json!({
            "width": 64, "height": 64, "fps": 24, "durationInFrames": 2,
            "layers": [
                { "id": "a", "type": "video", "src": "clip.mp4" },
                { "id": "b", "type": "video", "src": "clip.mp4", "trimBefore": 12 },
                { "id": "c", "type": "gif", "src": "spinner.gif" },
                { "id": "d", "type": "gif", "src": "spinner.gif", "loop": false },
            ],
        });
        let scene = Scene::from_json(&json.to_string(), media).unwrap();
        let mut loaded = Loaded::default();
        let fresh = read_assets(&scene, &loaded, false).unwrap();
        // Four layers, two files.
        assert_eq!((fresh.videos.len(), fresh.gifs.len()), (1, 1));
        hold(&mut loaded, &fresh);
        // The next frame's scene names them again: nothing is read.
        let fresh = read_assets(&scene, &loaded, true).unwrap();
        assert!(fresh.videos.is_empty() && fresh.gifs.is_empty() && !fresh.rebound);
    }
    #[test]
    fn a_missing_file_fails_the_read_and_names_it() {
        let dir = std::env::temp_dir().join(format!("kinetograph-missing-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let scene = assets_scene(&dir, &[]);
        let err = read_assets(&scene, &Loaded::default(), false)
            .err()
            .expect("read a missing image")
            .to_string();
        assert!(err.contains("pic.png"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
