//! The `colorGrade` effect: HyperFrames' colour grade (`data-color-grading`) as one pass over a layer.
//!
//! The effect carries the grade as HyperFrames normalises it: ten primary controls, three tonal wheels, four RGB curves,
//! three hue curves, up to four secondaries, a `.cube` look-up table, a vignette and film grain. `shaders/color_grade.wgsl`
//! applies all of it in one pass, in the order of HyperFrames' own shader. The numbers are plain (not animated by
//! keyframes): the DOM painter writes the grade of one frame, so a tween of the grade is a new effect each frame.
//!
//! The curves, hue curves and secondaries reach the shader as a table of 1024 x 3 RGBA8 texels that
//! [`ResolvedColorGrade::advanced`] builds the way HyperFrames does (the same cubic through the same points, sampled at the
//! same places, rounded to 8 bits), so the quantisation is the original's.

use serde::Deserialize;

use crate::error::{Error, Result};

/// Texels along a curve row.
pub const CURVE_SIZE: usize = 1024;
/// Rows of the table: curves, hue curves, secondaries.
pub const TABLE_ROWS: usize = 3;
/// Most secondaries a grade holds.
pub const MAX_SECONDARIES: usize = 4;
/// Most points a curve holds.
pub const MAX_CURVE_POINTS: usize = 16;
/// Texels one secondary takes in row 2.
const SECONDARY_TEXELS: usize = 5;

/// Floats the shader reads the effect controls in: 64, sixteen `vec4`.
pub const EFFECT_SLOTS: usize = 64;

/// The palette colours the shader holds.
pub const PALETTE_SLOTS: usize = 6;
const EFFECT_PALETTE: [&str; 2] = ["#000000", "#ffffff"];
const ART_PALETTE: [&str; 2] = ["#1a1a1a", "#f5f5dc"];

/// The controls of `effects`, in the order the shader reads them: name, default, lowest, highest. HyperFrames'
/// `COLOR_GRADING_EFFECT_KEYS` with its `EFFECT_DEFAULTS` and limits.
pub const EFFECT_KEYS: [(&str, f64, f64, f64); EFFECT_SLOTS] = [
    ("blur", 0.0, 0.0, 1.0),
    ("pixelate", 0.0, 0.0, 1.0),
    ("chromaBleed", 0.0, 0.0, 1.0),
    ("tapeDamage", 0.0, 0.0, 1.0),
    ("tapeTracking", 0.0, 0.0, 1.0),
    ("tapeNoise", 1.0, 0.0, 1.0),
    ("tapeSpeed", 0.5, 0.0, 1.0),
    ("filmArtifacts", 0.0, 0.0, 1.0),
    ("halftone", 0.0, 0.0, 1.0),
    ("halftoneSize", 0.0, 0.0, 1.0),
    ("twoInkPrint", 0.0, 0.0, 1.0),
    ("twoInkPrintSize", 0.0, 0.0, 1.0),
    ("ascii", 0.0, 0.0, 1.0),
    ("asciiSize", 5.0 / 76.0, 0.0, 1.0),
    ("asciiInvert", 0.0, 0.0, 1.0),
    ("asciiStyle", 0.0, 0.0, 7.0),
    ("asciiColor", 1.0, 0.0, 1.0),
    ("asciiRotation", 0.0, 0.0, 1.0),
    ("dither", 0.0, 0.0, 1.0),
    ("ditherSize", 0.0, 0.0, 1.0),
    ("bloom", 0.0, 0.0, 3.0),
    ("bloomRadius", 8.0, 1.0, 100.0),
    ("monoScreen", 0.0, 0.0, 1.0),
    ("monoScreenSize", 0.0, 0.0, 1.0),
    ("monoScreenAngle", 0.0, 0.0, 1.0),
    ("monoScreenSpread", 0.0, 0.0, 1.0),
    ("monoScreenShape", 0.0, 0.0, 4.0),
    ("monoScreenInvert", 0.0, 0.0, 1.0),
    ("scanlines", 0.0, 0.0, 1.0),
    ("scanlineCount", 0.0, 0.0, 1.0),
    ("scanlineSoftness", 0.0, 0.0, 1.0),
    ("chromaticAberration", 0.0, 0.0, 1.0),
    ("chromaticAngle", 0.0, 0.0, 1.0),
    ("crtCurvature", 0.0, 0.0, 1.0),
    ("digitalGlitch", 0.0, 0.0, 1.0),
    ("digitalGlitchColorSplit", 0.0, 0.0, 1.0),
    ("digitalGlitchLineTear", 0.0, 0.0, 1.0),
    ("digitalGlitchPixelate", 0.0, 0.0, 1.0),
    ("digitalGlitchBlockAmount", 0.0, 0.0, 1.0),
    ("digitalGlitchBlockDisplacement", 0.0, 0.0, 1.0),
    ("digitalGlitchBlockOpacity", 0.0, 0.0, 1.0),
    ("digitalGlitchSpeed", 0.0, 0.0, 1.0),
    ("engraving", 0.0, 0.0, 1.0),
    ("engravingSpacing", 7.0 / 17.0, 0.0, 1.0),
    ("engravingMinThickness", 0.2, 0.0, 1.0),
    ("engravingMaxThickness", 3.2 / 7.0, 0.0, 1.0),
    ("engravingAngle", 0.25, 0.0, 1.0),
    ("engravingContrast", 7.0 / 15.0, 0.0, 1.0),
    ("engravingSharpness", 0.59, 0.0, 1.0),
    ("engravingWave", 0.2, 0.0, 1.0),
    ("engravingWaveFrequency", 2.0 / 9.0, 0.0, 1.0),
    ("crosshatch", 0.0, 0.0, 1.0),
    ("crosshatchSpacing", 7.0 / 25.0, 0.0, 1.0),
    ("crosshatchThickness", 0.25, 0.0, 1.0),
    ("crosshatchAngle", 0.25, 0.0, 1.0),
    ("crosshatchContrast", 1.0 / 3.0, 0.0, 1.0),
    ("crosshatchEdges", 0.5, 0.0, 1.0),
    ("crosshatchLineWeight", 0.0, 0.0, 1.0),
    ("crosshatchWave", 0.33, 0.0, 1.0),
    ("crosshatchWaveFrequency", 2.0 / 9.0, 0.0, 1.0),
    ("kuwahara", 0.0, 0.0, 1.0),
    ("kuwaharaRadius", 1.0 / 7.0, 0.0, 1.0),
    ("kuwaharaSharpness", 5.0 / 16.0, 0.0, 1.0),
    ("kuwaharaSaturation", 0.5, 0.0, 1.0),
];

/// The `colorGrade` effect as the scene spells it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ColorGrade {
    /// The mix of the grade with the source, 0..=1.
    pub intensity: f64,
    pub adjust: Adjust,
    pub wheels: Wheels,
    /// Control points `[input, output]` of each curve, 2 to 16, inputs from 0 to 1 and increasing, with the points at 0
    /// and 1. Empty is the identity.
    pub curves: Curves,
    /// Control points `[hue degrees, delta]`, 3 to 16; empty is the identity.
    pub hue_curves: HueCurves,
    /// The enabled secondaries, at most four.
    pub secondaries: Vec<Secondary>,
    pub lut: Option<GradeLut>,
    pub vignette: Vignette,
    pub grain: GradeGrain,
    /// The look effects: any of the [`EFFECT_KEYS`] by name (`halftone: 0.9, halftoneSize: 0.4`), the controls left out
    /// at their default. The effect itself is the control that bears its name, 0 for off.
    pub effects: std::collections::BTreeMap<String, f64>,
    /// Two to six `#rrggbb` colours the palette effects (ascii, dither, monoScreen, engraving, crosshatch) draw with,
    /// darkest first. The default is black and white, or dark ink on paper for engraving and crosshatch.
    pub palette: Option<Vec<String>>,
    /// The seconds the time-varying effects (tape, glitch, crosshatch's wave) run at; the frame's time when absent.
    pub time: Option<f64>,
    /// The graded picture's box in the layer's space, `[x, y, width, height]`: the vignette and the grain are laid out on
    /// it. The DOM painter writes the element's content box.
    #[serde(rename = "box")]
    pub rect: Option<[f64; 4]>,
}

impl Default for ColorGrade {
    fn default() -> Self {
        ColorGrade {
            intensity: 1.0,
            adjust: Adjust::default(),
            wheels: Wheels::default(),
            curves: Curves::default(),
            hue_curves: HueCurves::default(),
            secondaries: Vec::new(),
            lut: None,
            vignette: Vignette::default(),
            grain: GradeGrain::default(),
            effects: Default::default(),
            palette: None,
            time: None,
            rect: None,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Adjust {
    pub exposure: f64,
    pub contrast: f64,
    pub highlights: f64,
    pub shadows: f64,
    pub whites: f64,
    pub blacks: f64,
    pub temperature: f64,
    pub tint: f64,
    pub vibrance: f64,
    pub saturation: f64,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Wheel {
    /// Degrees.
    pub hue: f64,
    pub amount: f64,
    pub level: f64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Wheels {
    pub shadows: Wheel,
    pub midtones: Wheel,
    pub highlights: Wheel,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Curves {
    pub master: Vec<[f64; 2]>,
    pub red: Vec<[f64; 2]>,
    pub green: Vec<[f64; 2]>,
    pub blue: Vec<[f64; 2]>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HueCurves {
    pub hue_vs_hue: Vec<[f64; 2]>,
    pub hue_vs_saturation: Vec<[f64; 2]>,
    pub hue_vs_luma: Vec<[f64; 2]>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Secondary {
    pub key: SecondaryKey,
    pub correction: SecondaryCorrection,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct SecondaryKey {
    pub hue: HueRange,
    pub saturation: SoftRange,
    pub luma: SoftRange,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(default)]
pub struct HueRange {
    /// Degrees.
    pub center: f64,
    /// Degrees each side of the centre, 0..=180.
    pub range: f64,
    /// Degrees past the range.
    pub softness: f64,
}

impl Default for HueRange {
    fn default() -> Self {
        HueRange {
            center: 0.0,
            range: 180.0,
            softness: 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(default)]
pub struct SoftRange {
    pub min: f64,
    pub max: f64,
    pub softness: f64,
}

impl Default for SoftRange {
    fn default() -> Self {
        SoftRange {
            min: 0.0,
            max: 1.0,
            softness: 0.05,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SecondaryCorrection {
    /// Degrees, -180..=180.
    pub hue_shift: f64,
    pub saturation: f64,
    pub luma: f64,
    pub temperature: f64,
    pub tint: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct GradeLut {
    /// A `.cube` file.
    pub src: String,
    #[serde(default = "one")]
    pub intensity: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(default)]
pub struct Vignette {
    pub amount: f64,
    pub midpoint: f64,
    pub roundness: f64,
    pub feather: f64,
}

impl Default for Vignette {
    fn default() -> Self {
        Vignette {
            amount: 0.0,
            midpoint: 0.5,
            roundness: 0.0,
            feather: 0.65,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(default)]
pub struct GradeGrain {
    pub amount: f64,
    pub size: f64,
    pub roughness: f64,
    /// HyperFrames' grain seed: the hash of the element plus 60 times the time, a whole number the pattern is made from.
    pub seed: f64,
}

impl Default for GradeGrain {
    fn default() -> Self {
        GradeGrain {
            amount: 0.0,
            size: 0.25,
            roughness: 0.5,
            seed: 0.0,
        }
    }
}

fn one() -> f64 {
    1.0
}

impl ColorGrade {
    /// What is wrong with the effect, if anything.
    pub fn validate(&self, layer: &str) -> Result<()> {
        let fail = |what: String| Err(Error::Scene(format!("layer {layer:?}: colorGrade {what}")));
        if let Some(lut) = &self.lut
            && lut.src.trim().is_empty()
        {
            return fail("lut needs a src, the path of a .cube file".to_string());
        }
        if self.secondaries.len() > MAX_SECONDARIES {
            return fail(format!("holds at most {MAX_SECONDARIES} secondaries"));
        }
        if let Some(name) = self
            .effects
            .keys()
            .find(|k| !EFFECT_KEYS.iter().any(|(key, ..)| key == k))
        {
            return fail(format!(
                "has no effect control {name:?}; the controls are {}",
                EFFECT_KEYS.map(|k| k.0).join(", ")
            ));
        }
        if let Some(colors) = &self.palette
            && !(2..=PALETTE_SLOTS).contains(&colors.len())
        {
            return fail(format!("palette needs 2 to {PALETTE_SLOTS} colours"));
        }
        if let Some(colors) = &self.palette
            && let Some(bad) = colors.iter().find(|c| parse_hex(c).is_none())
        {
            return fail(format!("palette colour {bad:?} is not #rrggbb"));
        }
        for (name, curve) in [
            ("master", &self.curves.master),
            ("red", &self.curves.red),
            ("green", &self.curves.green),
            ("blue", &self.curves.blue),
        ] {
            if curve.len() > MAX_CURVE_POINTS {
                return fail(format!(
                    "curve {name} holds at most {MAX_CURVE_POINTS} points"
                ));
            }
        }
        Ok(())
    }

    /// The look-up table's file, if the grade has one that matters.
    pub fn lut_src(&self) -> Option<&str> {
        self.lut.as_ref().map(|l| l.src.as_str())
    }
}

/// The grade at one frame, ready for the compositor.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedColorGrade {
    pub intensity: f32,
    /// exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation.
    pub adjust: [f32; 10],
    /// Shadows, midtones, highlights: hue / 360, amount, level.
    pub wheels: [[f32; 3]; 3],
    pub rgb_curves: bool,
    pub hue_curves: bool,
    pub secondaries: u32,
    /// The table's key (its `src`) and the mix with the colour.
    pub lut: Option<(String, f32)>,
    /// Amount, midpoint, roundness, feather.
    pub vignette: [f32; 4],
    /// Amount, size, roughness, seed.
    pub grain: [f32; 4],
    /// The effect controls, in the order of [`EFFECT_KEYS`], clamped, the missing ones at their defaults.
    pub effects: [f32; EFFECT_SLOTS],
    /// The palette colours (sRGB, 0..=1), the last repeated to fill the slots; how many the palette has; the seconds.
    pub palette: [[f32; 3]; PALETTE_SLOTS],
    pub palette_len: u32,
    pub time: f32,
    pub rect: Option<[f64; 4]>,
    /// The `CURVE_SIZE` x `TABLE_ROWS` RGBA8 table, or empty when the grade has no curves, hue curves or secondaries.
    pub advanced: Vec<u8>,
}

/// `#rrggbb` as sRGB floats.
fn parse_hex(text: &str) -> Option<[f32; 3]> {
    let hex = text.strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |i: usize| f32::from(u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0)) / 255.0;
    Some([channel(0), channel(2), channel(4)])
}

fn unit(v: f64) -> f64 {
    if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 }
}

fn limited(v: f64, lo: f64, hi: f64) -> f64 {
    if v.is_finite() { v.clamp(lo, hi) } else { 0.0 }
}

/// A float rounded to the byte HyperFrames' texture holds (`unitFloatToByte`).
fn byte(v: f64) -> u8 {
    (unit(v) * 255.0 + 0.5).floor() as u8
}

/// Stored as a signed value in a byte: `v * 127 / range` about 128, never 0.
fn signed(v: f64, range: f64) -> f64 {
    ((v * (127.0 / range) + 128.0) / 255.0).clamp(1.0 / 255.0, 1.0)
}

/// Slopes of the shape-preserving cubic through `points` (`pointSlopes`).
fn tangents(points: &[[f64; 2]]) -> Vec<f64> {
    let n = points.len();
    let spans: Vec<f64> = (1..n).map(|i| points[i][0] - points[i - 1][0]).collect();
    let slopes: Vec<f64> = (1..n)
        .map(|i| (points[i][1] - points[i - 1][1]) / spans[i - 1])
        .collect();
    if n == 2 {
        return vec![slopes[0], slopes[0]];
    }
    let endpoint = |s0: f64, s1: f64, m0: f64, m1: f64| {
        let slope = ((2.0 * s0 + s1) * m0 - s0 * m1) / (s0 + s1);
        if slope.signum() != m0.signum() {
            return 0.0;
        }
        if m0.signum() != m1.signum() && slope.abs() > 3.0 * m0.abs() {
            return 3.0 * m0;
        }
        slope
    };
    let mut out = vec![0.0; n];
    out[0] = endpoint(spans[0], spans[1], slopes[0], slopes[1]);
    out[n - 1] = endpoint(spans[n - 2], spans[n - 3], slopes[n - 2], slopes[n - 3]);
    for i in 1..n - 1 {
        let (before, after) = (slopes[i - 1], slopes[i]);
        if before == 0.0 || after == 0.0 || before.signum() != after.signum() {
            out[i] = 0.0;
            continue;
        }
        let bw = 2.0 * spans[i] + spans[i - 1];
        let aw = spans[i] + 2.0 * spans[i - 1];
        out[i] = (bw + aw) / (bw / before + aw / after);
    }
    out
}

/// The cubic through `points`, at `size` places given by `input_at`, clamped to `lo..=hi` (`compileCurveSamples`).
fn samples(points: &[[f64; 2]], input_at: impl Fn(usize) -> f64, lo: f64, hi: f64) -> Vec<f64> {
    let t = tangents(points);
    let mut seg = 0;
    (0..CURVE_SIZE)
        .map(|i| {
            let x = input_at(i);
            while seg < points.len() - 2 && x > points[seg + 1][0] {
                seg += 1;
            }
            let (a, b) = (points[seg], points[seg + 1]);
            let span = b[0] - a[0];
            let u = ((x - a[0]) / span).clamp(0.0, 1.0);
            let (u2, u3) = (u * u, u * u * u);
            let y = (2.0 * u3 - 3.0 * u2 + 1.0) * a[1]
                + (u3 - 2.0 * u2 + u) * span * t[seg]
                + (-2.0 * u3 + 3.0 * u2) * b[1]
                + (u3 - u2) * span * t[seg + 1];
            y.clamp(lo, hi)
        })
        .collect()
}

/// The curve of a channel as `CURVE_SIZE` samples; an unusable curve is the identity.
fn rgb_curve(points: &[[f64; 2]]) -> Vec<f64> {
    let valid = points.len() >= 2
        && points.len() <= MAX_CURVE_POINTS
        && points.iter().all(|p| p[0].is_finite() && p[1].is_finite())
        && points.windows(2).all(|w| w[1][0] > w[0][0])
        && points[0][0] == 0.0
        && points[points.len() - 1][0] == 1.0;
    let identity = [[0.0, 0.0], [1.0, 1.0]];
    let pts: Vec<[f64; 2]> = if valid {
        points.iter().map(|p| [p[0], unit(p[1])]).collect()
    } else {
        identity.to_vec()
    };
    samples(&pts, |i| i as f64 / (CURVE_SIZE - 1) as f64, 0.0, 1.0)
}

/// A periodic hue curve as `CURVE_SIZE` samples around the circle; fewer than three points is flat zero.
fn hue_curve(points: &[[f64; 2]], lo: f64, hi: f64) -> Vec<f64> {
    if points.len() < 3 || points.len() > MAX_CURVE_POINTS {
        return vec![0.0; CURVE_SIZE];
    }
    let mut sorted: Vec<[f64; 2]> = points
        .iter()
        .map(|p| [limited(p[0], 0.0, 359.999999), limited(p[1], lo, hi)])
        .collect();
    sorted.sort_by(|a, b| a[0].total_cmp(&b[0]));
    if sorted.windows(2).any(|w| w[0][0] == w[1][0]) {
        return vec![0.0; CURVE_SIZE];
    }
    let n = sorted.len();
    let mut periodic: Vec<[f64; 2]> = vec![
        [sorted[n - 2][0] - 360.0, sorted[n - 2][1]],
        [sorted[n - 1][0] - 360.0, sorted[n - 1][1]],
    ];
    periodic.extend(sorted.iter().copied());
    periodic.push([sorted[0][0] + 360.0, sorted[0][1]]);
    periodic.push([sorted[1][0] + 360.0, sorted[1][1]]);
    samples(&periodic, |i| i as f64 / CURVE_SIZE as f64 * 360.0, lo, hi)
}

fn curve_is_identity(points: &[[f64; 2]]) -> bool {
    points.iter().all(|p| (p[0] - p[1]).abs() <= 0.0001)
}

impl ColorGrade {
    /// The grade as the compositor takes it; `time` is the frame's time in seconds, for the effects that run on it.
    pub fn resolve(&self, time: f64) -> ResolvedColorGrade {
        let mut effects = [0.0f32; EFFECT_SLOTS];
        for (slot, (key, default, lo, hi)) in effects.iter_mut().zip(EFFECT_KEYS) {
            *slot = self
                .effects
                .get(key)
                .map_or(default, |v| limited(*v, lo, hi)) as f32;
        }
        let art = EFFECT_KEYS
            .iter()
            .zip(&effects)
            .any(|((k, ..), v)| (*k == "engraving" || *k == "crosshatch") && *v > 0.0);
        let defaults: &[&str] = if art { &ART_PALETTE } else { &EFFECT_PALETTE };
        let custom: Option<Vec<[f32; 3]>> = self
            .palette
            .as_ref()
            .filter(|p| (2..=PALETTE_SLOTS).contains(&p.len()))
            .and_then(|p| p.iter().map(|c| parse_hex(c)).collect());
        let colors = custom.unwrap_or_else(|| {
            defaults
                .iter()
                .map(|c| parse_hex(c).unwrap_or_default())
                .collect()
        });
        let last = colors[colors.len() - 1];
        let mut palette = [last; PALETTE_SLOTS];
        palette[..colors.len()].copy_from_slice(&colors);
        let palette_len = colors.len() as u32;
        let a = &self.adjust;
        let adjust = [
            limited(a.exposure, -2.0, 2.0),
            limited(a.contrast, -1.0, 1.0),
            limited(a.highlights, -1.0, 1.0),
            limited(a.shadows, -1.0, 1.0),
            limited(a.whites, -1.0, 1.0),
            limited(a.blacks, -1.0, 1.0),
            limited(a.temperature, -1.0, 1.0),
            limited(a.tint, -1.0, 1.0),
            limited(a.vibrance, -1.0, 1.0),
            limited(a.saturation, -1.0, 1.0),
        ]
        .map(|v| v as f32);
        let wheel = |w: &Wheel| {
            [
                (w.hue.rem_euclid(360.0) / 360.0) as f32,
                unit(w.amount) as f32,
                limited(w.level, -1.0, 1.0) as f32,
            ]
        };
        let rgb_curves = [
            &self.curves.master,
            &self.curves.red,
            &self.curves.green,
            &self.curves.blue,
        ]
        .iter()
        .any(|c| !curve_is_identity(c));
        let hue_curves = [
            &self.hue_curves.hue_vs_hue,
            &self.hue_curves.hue_vs_saturation,
            &self.hue_curves.hue_vs_luma,
        ]
        .iter()
        .any(|c| c.iter().any(|p| p[1].abs() > 0.0001));
        let secondaries: Vec<&Secondary> = self.secondaries.iter().take(MAX_SECONDARIES).collect();
        let secondary_active = secondaries.iter().any(|s| {
            let c = &s.correction;
            [c.hue_shift, c.saturation, c.luma, c.temperature, c.tint]
                .iter()
                .any(|v| v.abs() > 0.0001)
        });
        let secondary_count = if secondary_active { secondaries.len() } else { 0 };
        let advanced = if rgb_curves || hue_curves || secondary_count > 0 {
            self.advanced(&secondaries)
        } else {
            Vec::new()
        };
        let v = &self.vignette;
        let g = &self.grain;
        ResolvedColorGrade {
            intensity: unit(self.intensity) as f32,
            adjust,
            wheels: [
                wheel(&self.wheels.shadows),
                wheel(&self.wheels.midtones),
                wheel(&self.wheels.highlights),
            ],
            rgb_curves,
            hue_curves,
            secondaries: secondary_count as u32,
            lut: self
                .lut
                .as_ref()
                .filter(|l| !l.src.trim().is_empty())
                .map(|l| (l.src.clone(), unit(l.intensity) as f32)),
            vignette: [
                unit(v.amount) as f32,
                unit(v.midpoint) as f32,
                limited(v.roundness, -1.0, 1.0) as f32,
                unit(v.feather) as f32,
            ],
            grain: [
                unit(g.amount) as f32,
                unit(g.size) as f32,
                unit(g.roughness) as f32,
                // A whole number in f32: HyperFrames' uniform is the same.
                if g.seed.is_finite() { g.seed as f32 } else { 0.0 },
            ],
            effects,
            palette,
            palette_len,
            time: self.time.filter(|t| t.is_finite()).unwrap_or(time) as f32,
            rect: self.rect.filter(|r| r.iter().all(|v| v.is_finite())),
            advanced,
        }
    }

    /// The RGBA8 table (`writeAdvancedCurveRows`, `writeAdvancedSecondary`).
    fn advanced(&self, secondaries: &[&Secondary]) -> Vec<u8> {
        let mut data = vec![0u8; CURVE_SIZE * TABLE_ROWS * 4];
        let mut put = |row: usize, column: usize, v: [f64; 4]| {
            let at = (row * CURVE_SIZE + column) * 4;
            for (k, x) in v.iter().enumerate() {
                data[at + k] = byte(*x);
            }
        };
        let red = rgb_curve(&self.curves.red);
        let green = rgb_curve(&self.curves.green);
        let blue = rgb_curve(&self.curves.blue);
        let master = rgb_curve(&self.curves.master);
        let hue = hue_curve(&self.hue_curves.hue_vs_hue, -180.0, 180.0);
        let saturation = hue_curve(&self.hue_curves.hue_vs_saturation, -1.0, 1.0);
        let luma = hue_curve(&self.hue_curves.hue_vs_luma, -1.0, 1.0);
        for i in 0..CURVE_SIZE {
            put(0, i, [red[i], green[i], blue[i], master[i]]);
            put(
                1,
                i,
                [
                    signed(hue[i], 180.0),
                    signed(saturation[i], 1.0),
                    signed(luma[i], 1.0),
                    1.0,
                ],
            );
        }
        for (index, s) in secondaries.iter().enumerate() {
            let base = index * SECONDARY_TEXELS;
            let (k, c) = (&s.key, &s.correction);
            let h = HueRange {
                center: limited(k.hue.center, 0.0, 360.0).rem_euclid(360.0),
                range: limited(k.hue.range, 0.0, 180.0),
                softness: 0.0,
            };
            let h = HueRange {
                softness: limited(k.hue.softness, 0.0, 180.0 - h.range),
                ..h
            };
            let soft = |r: &SoftRange| {
                let (a, b) = (unit(r.min), unit(r.max));
                SoftRange {
                    min: a.min(b),
                    max: a.max(b),
                    softness: limited(r.softness, 0.0, 0.5),
                }
            };
            let (sat, lum) = (soft(&k.saturation), soft(&k.luma));
            put(
                2,
                base,
                [h.center / 360.0, h.range / 180.0, h.softness / 180.0, 1.0],
            );
            put(
                2,
                base + 1,
                [sat.min, sat.max, sat.softness / 0.5, 0.0],
            );
            put(
                2,
                base + 2,
                [lum.min, lum.max, lum.softness / 0.5, 0.0],
            );
            put(
                2,
                base + 3,
                [
                    signed(limited(c.hue_shift, -180.0, 180.0), 180.0),
                    signed(limited(c.saturation, -1.0, 1.0), 1.0),
                    signed(limited(c.luma, -1.0, 1.0), 1.0),
                    signed(limited(c.temperature, -1.0, 1.0), 1.0),
                ],
            );
            put(
                2,
                base + 4,
                [signed(limited(c.tint, -1.0, 1.0), 1.0), 0.5, 0.5, 1.0],
            );
        }
        data
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texel(data: &[u8], row: usize, column: usize) -> [u8; 4] {
        let at = (row * CURVE_SIZE + column) * 4;
        data[at..at + 4].try_into().unwrap()
    }

    #[test]
    fn a_default_grade_has_no_table() {
        let grade: ColorGrade = serde_json::from_str("{}").unwrap();
        let r = grade.resolve(0.0);
        assert_eq!(r.intensity, 1.0);
        assert!(!r.rgb_curves && !r.hue_curves && r.secondaries == 0);
        assert!(r.advanced.is_empty());
        assert_eq!(r.vignette, [0.0, 0.5, 0.0, 0.65]);
        assert_eq!(r.grain[1..3], [0.25, 0.5]);
    }

    #[test]
    fn the_identity_curve_is_the_ramp() {
        let grade: ColorGrade = serde_json::from_str(
            r#"{"curves": {"master": [[0, 0], [0.5, 0.7], [1, 1]]}}"#,
        )
        .unwrap();
        let r = grade.resolve(0.0);
        assert!(r.rgb_curves);
        // The unset channels are straight ramps: byte(i / 1023).
        for i in [0, 1, 100, 511, 1022, 1023] {
            let want = byte(i as f64 / 1023.0);
            let t = texel(&r.advanced, 0, i);
            assert_eq!([t[0], t[1], t[2]], [want; 3]);
        }
        // The master curve passes through its control points and keeps its endpoints.
        assert_eq!(texel(&r.advanced, 0, 0)[3], 0);
        assert_eq!(texel(&r.advanced, 0, 1023)[3], 255);
        let mid = texel(&r.advanced, 0, 511)[3] as i32;
        assert!((mid - (0.7 * 255.0_f64).round() as i32).abs() <= 2, "{mid}");
    }

    #[test]
    fn a_flat_hue_curve_row_reads_as_zero() {
        let grade: ColorGrade = serde_json::from_str(
            r#"{"hueCurves": {"hueVsSaturation": [[0, 0.5], [120, 0.5], [240, 0.5]]}}"#,
        )
        .unwrap();
        let r = grade.resolve(0.0);
        assert!(r.hue_curves);
        let t = texel(&r.advanced, 1, 300);
        // hue vs hue has no points: signed(0) is the byte 128; saturation is a flat +0.5 (= 191.5 / 255).
        assert_eq!(t[0], 128);
        assert_eq!(t[1], byte(signed(0.5, 1.0)));
        assert_eq!(t[3], 255);
    }

    #[test]
    fn secondaries_count_only_when_one_corrects() {
        let none: ColorGrade = serde_json::from_str(
            r#"{"secondaries": [{"key": {}, "correction": {}}]}"#,
        )
        .unwrap();
        assert_eq!(none.resolve(0.0).secondaries, 0);
        let one: ColorGrade = serde_json::from_str(
            r#"{"secondaries": [{"key": {"hue": {"center": 120, "range": 30}}, "correction": {"saturation": -1}}]}"#,
        )
        .unwrap();
        let r = one.resolve(0.0);
        assert_eq!(r.secondaries, 1);
        assert_eq!(texel(&r.advanced, 2, 0), [85, 43, 0, 255]);
        assert_eq!(texel(&r.advanced, 2, 3)[1], byte(signed(-1.0, 1.0)));
    }

    #[test]
    fn the_effect_controls_sit_where_the_shader_and_the_compositor_read_them() {
        let at = |name: &str| EFFECT_KEYS.iter().position(|k| k.0 == name).unwrap();
        // shaders/color_grade.wgsl's E_* constants and compositor.rs's EFFECT_* constants.
        for (name, index) in [
            ("blur", 0),
            ("tapeDamage", 3),
            ("halftone", 8),
            ("ascii", 12),
            ("bloom", 20),
            ("bloomRadius", 21),
            ("monoScreen", 22),
            ("scanlines", 28),
            ("crtCurvature", 33),
            ("digitalGlitch", 34),
            ("engraving", 42),
            ("crosshatch", 51),
            ("kuwahara", 60),
            ("kuwaharaSaturation", 63),
        ] {
            assert_eq!(at(name), index, "{name}");
        }
    }

    #[test]
    fn effects_take_their_defaults_and_limits_and_the_palette_its_default() {
        let none = ColorGrade::default().resolve(2.0);
        assert_eq!(none.time, 2.0);
        assert_eq!(none.effects[0], 0.0);
        assert!((none.effects[13] - 5.0 / 76.0).abs() < 1e-6);
        assert_eq!(none.effects[5], 1.0);
        assert_eq!(none.palette_len, 2);
        assert_eq!(none.palette[0], [0.0; 3]);
        assert_eq!(none.palette[5], [1.0; 3]);
        let grade: ColorGrade = serde_json::from_str(
            r##"{"effects": {"bloom": 9, "bloomRadius": 0, "crosshatch": 1}, "time": 0.5}"##,
        )
        .unwrap();
        grade.validate("x").unwrap();
        let r = grade.resolve(2.0);
        assert_eq!(r.time, 0.5);
        assert_eq!((r.effects[20], r.effects[21]), (3.0, 1.0));
        // crosshatch (or engraving) draws dark ink on paper by default.
        assert_eq!(r.palette_len, 2);
        assert!((r.palette[1][2] - 220.0 / 255.0).abs() < 1e-6);
        let custom: ColorGrade =
            serde_json::from_str(r##"{"palette": ["#ff0000", "#00ff00", "#0000ff"]}"##).unwrap();
        let r = custom.resolve(0.0);
        assert_eq!(r.palette_len, 3);
        assert_eq!(r.palette[2], [0.0, 0.0, 1.0]);
        assert_eq!(r.palette[5], [0.0, 0.0, 1.0]);
    }

    #[test]
    fn an_unknown_effect_control_or_a_bad_palette_is_an_error() {
        let bad: ColorGrade = serde_json::from_str(r#"{"effects": {"halftoen": 1}}"#).unwrap();
        assert!(bad.validate("x").unwrap_err().to_string().contains("halftoen"));
        let bad: ColorGrade = serde_json::from_str(r##"{"palette": ["#fff", "#000000"]}"##).unwrap();
        assert!(bad.validate("x").is_err());
        let bad: ColorGrade = serde_json::from_str(r##"{"palette": ["#000000"]}"##).unwrap();
        assert!(bad.validate("x").is_err());
    }

    #[test]
    fn a_lut_needs_a_src() {
        let grade: ColorGrade = serde_json::from_str(r#"{"lut": {"src": " "}}"#).unwrap();
        assert!(grade.validate("x").is_err());
    }

    #[test]
    fn the_effect_is_a_scene_effect() {
        let scene = crate::Scene::from_json(
            r##"{"width": 64, "height": 64, "fps": 30, "durationInFrames": 1, "layers": [
                {"id": "a", "type": "shape", "shape": {"kind": "rect", "width": 10, "height": 10}, "fill": "#fff",
                 "effects": [{"type": "colorGrade", "adjust": {"exposure": 0.5}, "box": [0, 0, 10, 10],
                              "grain": {"amount": 0.1, "seed": 12}}]}]}"##,
            std::path::PathBuf::from("/nowhere"),
        )
        .unwrap();
        let crate::scene::Effect::ColorGrade(grade) = &scene.layers[0].effects[0] else {
            panic!("not a colour grade");
        };
        assert_eq!(grade.adjust.exposure, 0.5);
        assert_eq!(grade.resolve(0.0).grain[3], 12.0);
    }
}
