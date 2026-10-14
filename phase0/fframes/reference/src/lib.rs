//! Reference (rajz-reference.mp4, 21 s .. 26 s): card rail with fake perspective, "gets better",
//! "you ... create", whip into a gradient. fframes has no 3D, so each card is cut into vertical
//! strips and every strip is scaled in height to fake a yawed quad.
use fframes::{
    AudioMap, Color, Duration, FFramesContext, FontQuery, Frame, Svgr, Video, include_media_dir,
};

include_media_dir!(pub struct ReferenceMedia, "media");

pub const WIDTH: usize = 1920;
pub const HEIGHT: usize = 1080;
const FONT: &str = "DM Sans";
const WEIGHT: u16 = 500;

/// (photo, time it becomes the front card, seconds from the start of the clip = 21.0 s)
const CARDS: [(&str, f32); 12] = [
    ("p4.jpg", -3.0),
    ("p1.jpg", -1.4),
    ("p2.jpg", -0.9),
    ("p6.jpg", -0.4),
    ("p5.jpg", 0.1),
    ("p8.jpg", 0.45),
    ("p9.jpg", 0.75),
    ("p4.jpg", 1.2),
    ("p7.jpg", 1.4),
    ("p3.jpg", 1.7),
    ("p2.jpg", 2.0),
    ("p10.jpg", 2.4),
];

fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}
fn ease_out(x: f32) -> f32 {
    1.0 - (1.0 - clamp01(x)).powi(3)
}
fn ease_in_out(x: f32) -> f32 {
    let x = clamp01(x);
    x * x * (3.0 - 2.0 * x)
}
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Progress of the rail: how many cards have been pushed in, with a smooth step each.
fn rail_progress(t: f32) -> f32 {
    CARDS.iter().skip(1).map(|(_, t0)| ease_out((t - t0) / 0.32)).sum::<f32>()
}

pub struct ReferenceVideo<'a> {
    pub media: &'a ReferenceMedia,
}

impl<'a> ReferenceVideo<'a> {
    pub fn new(media: &'a ReferenceMedia, _title: &str) -> Self {
        Self { media }
    }
}

impl std::fmt::Debug for ReferenceVideo<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReferenceVideo").finish()
    }
}

impl Video for ReferenceVideo<'_> {
    const FPS: usize = 25;
    const WIDTH: usize = WIDTH;
    const HEIGHT: usize = HEIGHT;
    const BACKGROUND_COLOR: Color = Color::WHITE;

    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(5.0)
    }

    fn audio(&self) -> AudioMap<'_> {
        AudioMap::none()
    }

    fn render_frame<'a>(&'a self, mut frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        let a_front = rail_progress(t);

        // camera-ish parameters over time
        let front_h = lerp(540.0, 700.0, ease_in_out((t - 0.4) / 2.0)) - 40.0 * ease_in_out((t - 2.5) / 0.6);
        let gap0 = lerp(340.0, 190.0, ease_in_out((t - 1.0) / 2.2)); // first-step spacing of the rail
        let yaw = 0.16 * (1.0 - ease_in_out((t - 1.5) / 1.5)); // left edge taller than right by this fraction
        let (cx0, cy0) = (1000.0 - 40.0 * ease_in_out((t - 2.0) / 1.0), 520.0);
        let rail_k = ease_in_out((t - 1.0) / 2.2);
        let r = lerp(0.95, 0.76, rail_k);
        let sr = lerp(0.93, 0.84, rail_k);

        let mut cards: Vec<Svgr<'a>> = Vec::new();
        for (k, (photo, _)) in CARDS.iter().enumerate() {
            let a = a_front - k as f32;
            if a < -1.0 {
                continue;
            }
            let Some(img) = ctx.get_image(photo) else { continue };
            let (x, y, s, alpha) = if a >= 0.0 {
                let geo = (1.0 - r.powf(a)) / (1.0 - r);
                (cx0 - gap0 * geo, cy0 + 55.0 * geo, sr.powf(a), 1.0)
            } else {
                // entering from the right and slightly larger
                (cx0 + 260.0 * -a, cy0 + 130.0 * -a, 1.0 + 0.06 * -a, if a > -0.75 { 1.0 } else { 0.0 })
            };
            if cx0 - x > 2600.0 || s < 0.05 {
                continue;
            }
            let h = front_h * s;
            let w = h * 0.75;
            let (hl, hr) = (h * (1.0 + yaw / 2.0), h * (1.0 - yaw / 2.0));
            let n: usize = if w > 260.0 { 32 } else { 4 };
            let mut strips: Vec<Svgr<'a>> = Vec::with_capacity(n);
            for i in 0..n {
                let um = (i as f32 + 0.5) / n as f32;
                let hs = lerp(hl, hr, um);
                let sx = w / 300.0;
                let sy = hs / 400.0;
                // image drawn in a 300x400 box; map its centre to (x + (um-0.5)*w .. )
                let tx = x - w / 2.0;
                let ty = y - hs / 2.0;
                let tr = format!("matrix({sx} 0 0 {sy} {tx} {ty})");
                let clip = format!("url(#s{n}_{i})");
                strips.push(fframes::svgr!(
                    <g transform={tr}>
                        <image href={img.href()} x="0" y="0" width="300" height="400"
                            preserveAspectRatio="xMidYMid slice" clip-path={clip} />
                    </g>
                ));
            }
            cards.push(fframes::svgr!(<g opacity={alpha}>{strips}</g>));
        }

        // words
        let font = |size: usize| FontQuery { family: FONT, size, weight: WEIGHT as _, ..Default::default() };
        let _ = font;
        let gets_o = ease_out((t - 1.15) / 0.2) * (1.0 - ease_out((t - 1.75) / 0.2));
        let front_top = cy0 - front_h / 2.0;
        let front_bot = cy0 + front_h / 2.0;
        let you_x = lerp(-120.0, 84.0, ease_out((t - 2.35) / 1.0));
        let create_x = lerp(1440.0, 1320.0 - 40.0 * ease_in_out((t - 2.0) / 1.0), ease_out((t - 2.35) / 1.0));
        let yc_o = if t > 2.3 { 1.0_f32 } else { 0.0 };
        let words = fframes::svgr!(
            <g fill="#111" font-family={FONT} font-size="80" font-weight={WEIGHT}>
                <g opacity={gets_o}>
                    <text x={cx0 - 65.0} y={front_top - 26.0 + 30.0 * (1.0 - gets_o)}>"gets"</text>
                    <text x={cx0 - 100.0} y={front_bot + 90.0 - 30.0 * (1.0 - gets_o)}>"better"</text>
                </g>
                <g opacity={yc_o}>
                    <text x={you_x} y={cy0 + 36.0} font-size="96">"you"</text>
                    <text x={create_x} y={cy0 + 36.0} font-size="96">"create"</text>
                </g>
            </g>
        );

        // whip: blur + gradient-map the content, then fade it out while the gradient rises
        let blur = 36.0 * ease_in((t - 3.0) / 0.6);
        let map_mix = 0.7 * ease_in_out((t - 3.1) / 0.45);
        let content_o = 1.0 - ease_in_out((t - 3.5) / 0.45);
        let grad_y = lerp(640.0, -170.0, ease_out((t - 3.05) / 1.1));
        let shift = -120.0 * ease_in((t - 3.0) / 0.9);

        // tail text
        let line: &'static str = "The AI powered platform for modern creatives";
        let chars = (((t - 4.05).max(0.0) * 38.0) as usize).min(line.len());
        let shown: &'static str = &line[..chars];
        let tw = frame
            .text_width(ctx, FontQuery { family: FONT, size: 46, weight: WEIGHT as _, ..Default::default() }, shown)
            .unwrap_or(0) as f32;
        let box_o = ease_out((t - 3.9) / 0.3);
        let (bl, br) = (960.0 - 420.0 - 14.0, 960.0 - 420.0 + tw + 8.0);

        fframes::svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width={WIDTH} height={HEIGHT}>
                <defs>
                    {strip_clips(32)}
                    {strip_clips(4)}
                    <filter id="whip" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
                        <feGaussianBlur in="SourceGraphic" stdDeviation={blur.max(0.01)} result="b" />
                        <feColorMatrix in="b" type="matrix" values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 1 0" result="lum" />
                        <feComponentTransfer in="lum" result="map">
                            <feFuncR type="table" tableValues="0.15 0.9 1.0 1.0" />
                            <feFuncG type="table" tableValues="0.05 0.35 0.65 0.9" />
                            <feFuncB type="table" tableValues="0.45 0.85 0.5 0.8" />
                        </feComponentTransfer>
                        <feComposite in="map" in2="b" operator="arithmetic" k1="0" k2={map_mix} k3={1.0 - map_mix} k4="0" />
                    </filter>
                    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
                        <feGaussianBlur stdDeviation="80" />
                    </filter>
                    <linearGradient id="haze" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stop-color="#e6e6e8" />
                        <stop offset="0.35" stop-color="#dcdbea" />
                        <stop offset="1" stop-color="#e7a9d8" />
                    </linearGradient>
                </defs>
                <rect width="1920" height="1080" fill="#e8e8e8" />
                <g opacity={if t > 2.95 { 1.0 } else { 0.0 }} transform={format!("translate(0 {grad_y})")}>
                    <g filter="url(#soft)">
                        <rect x="-200" y="560" width="2400" height="1400" fill="url(#haze)" />
                        <ellipse cx="300" cy="960" rx="620" ry="420" fill="#f5a030" />
                        <ellipse cx="1200" cy="700" rx="420" ry="300" fill="#e07be0" />
                        <ellipse cx="1750" cy="900" rx="560" ry="460" fill="#ef3048" />
                        <ellipse cx="900" cy="1120" rx="520" ry="260" fill="#f0405a" />
                    </g>
                </g>
                <g opacity={content_o} transform={format!("translate({shift} 0)")} filter={if t > 3.0 { "url(#whip)" } else { "none" }}>
                    {cards}
                    {words}
                </g>
                <g opacity={box_o}>
                    <text x="540" y="555" font-family={FONT} font-size="46" font-weight={WEIGHT} fill="#fff">{shown}</text>
                    <rect x={bl} y="500" width="7" height="7" fill="#111" />
                    <rect x={bl} y="568" width="7" height="7" fill="#111" />
                    <rect x={br} y="500" width="7" height="7" fill="#111" />
                    <rect x={br} y="568" width="7" height="7" fill="#111" />
                </g>
            </svg>
        )
    }
}

fn ease_in(x: f32) -> f32 {
    clamp01(x).powi(2)
}

fn strip_clips<'a>(n: usize) -> Vec<Svgr<'a>> {
    (0..n)
        .map(|i| {
            let id = format!("s{n}_{i}");
            let x = i as f32 / n as f32;
            let w = 1.0 / n as f32 + 0.03;
            fframes::svgr!(
                <clipPath id={id} clipPathUnits="objectBoundingBox">
                    <rect x={x} y="0" width={w} height="1" />
                </clipPath>
            )
        })
        .collect()
}
