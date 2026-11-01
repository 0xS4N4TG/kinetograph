//! One small HTML case per painted feature: the painted scene is rendered on
//! the GPU and compared with Chrome's rendering of the same HTML. The
//! pictures are in `target/paint-tests`.

mod common;
mod paintkit;

use paintkit::compare;

fn asset(name: &str) -> String {
    format!(
        "file://{}",
        paintkit::repo_root()
            .join("crates/dom/tests/assets")
            .join(name)
            .canonicalize()
            .unwrap()
            .display()
    )
}

macro_rules! case {
    ($name:ident, $w:expr, $h:expr, $body:expr) => {
        #[test]
        fn $name() {
            let body: String = $body;
            let (out, frame, diff) = compare(stringify!($name), &body, $w, $h);
            paintkit::check_golden(stringify!($name), &frame);
            if let Some(d) = diff {
                // Against Chrome: translucency, geometry and paint order must be close; text differs by design.
                assert!(d.mean < 30.0, "{}: {d:?}", stringify!($name));
            }
            let n = paintkit::count_layers(&out.layers);
            println!(
                "{}: layers {n}; unsupported {:?}; diff {:?}",
                stringify!($name),
                out.unsupported,
                diff
            );
        }
    };
}

case!(blend_modes, 300, 200, {
    format!(
        r#"<div style="position:absolute;left:0;top:0;width:300px;height:200px;background:#e8d9b0"></div>
<div style="position:absolute;left:20px;top:20px;width:120px;height:80px;background:linear-gradient(90deg,#f33,#36f);mix-blend-mode:multiply"></div>
<div style="position:absolute;left:160px;top:20px;width:120px;height:80px;background-color:#4a8;background-image:linear-gradient(0deg,#fff,#000);background-blend-mode:multiply"></div>
<div style="position:absolute;left:20px;top:120px;width:120px;height:60px;background-color:#c33;background-image:url({});background-blend-mode:multiply,normal"></div>
<div style="position:absolute;left:160px;top:120px;width:120px;height:60px;background:#39c;mix-blend-mode:screen"></div>"#,
        asset("tile.png")
    )
});

case!(tiled_backgrounds, 300, 220, {
    format!(
        r#"<div style="margin:10px;width:130px;height:90px;background:url({0})"></div>
<div style="position:absolute;left:160px;top:10px;width:130px;height:90px;background:url({0}) repeat-x"></div>
<div style="position:absolute;left:10px;top:120px;width:130px;height:90px;background:url({0}) 10px 10px / 48px 48px repeat;border:5px solid #333;border-radius:20px"></div>
<div style="position:absolute;left:160px;top:120px;width:130px;height:90px;background:url({0}) no-repeat center/contain, #ccd"></div>"#,
        asset("tile.png")
    )
});

case!(gradients, 320, 260, {
    r#"<div style="position:absolute;left:10px;top:10px;width:140px;height:70px;background:linear-gradient(135deg,#f36,#fc0 60%,#09f)"></div>
<div style="position:absolute;left:170px;top:10px;width:140px;height:70px;background:radial-gradient(ellipse 40% 90% at 30% 50%,#fff,#06c 70%,#003)"></div>
<div style="position:absolute;left:10px;top:95px;width:140px;height:70px;background:repeating-linear-gradient(45deg,#222 0 8px,#eee 8px 16px)"></div>
<div style="position:absolute;left:170px;top:95px;width:140px;height:70px;background:conic-gradient(from 20deg at 40% 60%,red,yellow,lime,aqua,blue,red)"></div>
<div style="position:absolute;left:10px;top:180px;width:140px;height:70px;background:radial-gradient(circle at 20% 20%,rgba(255,255,255,.9),transparent 50%),linear-gradient(#468,#135)"></div>
<div style="position:absolute;left:170px;top:180px;width:140px;height:70px;background:linear-gradient(to right,#000 0%,#fff 20%,#000 20%,#fff 60%,#f00 60.1%,#00f)"></div>"#
        .to_string()
});

case!(shadows, 320, 240, {
    r#"<div style="position:absolute;left:30px;top:30px;width:100px;height:60px;background:#fff;border-radius:16px;box-shadow:0 10px 24px rgba(0,0,0,.45),0 2px 4px rgba(0,0,0,.3)"></div>
<div style="position:absolute;left:180px;top:30px;width:100px;height:60px;background:#fc6;border:6px solid #a60;border-radius:10px 30px;box-shadow:inset 0 6px 12px rgba(0,0,0,.5),inset -4px -4px 0 rgba(255,255,255,.6)"></div>
<div style="position:absolute;left:30px;top:130px;width:100px;height:60px;background:#6af;box-shadow:12px 12px 0 #123,-6px -6px 0 4px rgba(255,0,0,.4)"></div>
<div style="position:absolute;left:180px;top:130px;width:100px;height:60px;background:#eee;border-radius:50%;box-shadow:0 0 30px 8px #f0f"></div>"#
        .to_string()
});

case!(text_features, 340, 220, {
    r#"<div style="margin:8px;font-size:20px;letter-spacing:3px">Letter spaced text</div>
<div style="margin:8px;font-size:18px;white-space:pre">pre   spaced
second line   here</div>
<div style="margin:8px;font-size:18px">before <span style="display:inline-block;width:40px;height:20px;background:#39f;vertical-align:middle"></span> after <span style="vertical-align:super;font-size:12px">sup</span> <span style="vertical-align:sub;font-size:12px">sub</span></div>
<div style="margin:8px;font-size:18px;color:#206;text-shadow:2px 2px 3px rgba(0,0,0,.5);text-decoration:underline">Shadow and underline</div>
<div style="margin:8px;font-size:18px"><span style="background:#fd8;padding:2px 6px;border-radius:6px;border:2px solid #a60">inline box</span> then <b>bold</b> <i>italic</i></div>"#
        .to_string()
});

case!(transforms, 340, 260, {
    r#"<div style="position:absolute;left:20px;top:20px;width:80px;height:50px;background:#f84;rotate:15deg;scale:1.2 .8;translate:20px 5px"></div>
<div style="position:absolute;left:150px;top:20px;width:80px;height:50px;background:#4a8;transform:skew(20deg,10deg)"></div>
<div style="position:absolute;left:250px;top:20px;width:60px;height:50px;background:#58f;transform:matrix(1,.2,-.3,1,5,5);transform-origin:0 0"></div>
<div style="position:absolute;left:20px;top:110px;width:120px;height:100px;perspective:300px"><div style="width:100px;height:80px;background:linear-gradient(90deg,#f36,#36f);transform:rotateY(40deg)"></div></div>
<div style="position:absolute;left:180px;top:120px;width:100px;height:80px;background:#c3c;transform:perspective(250px) rotateX(35deg) rotateZ(10deg)"></div>"#
        .to_string()
});

case!(clip_paths, 340, 200, {
    r#"<div style="position:absolute;left:10px;top:10px;width:90px;height:70px;background:#f63;clip-path:circle(40% at 50% 50%)"></div>
<div style="position:absolute;left:120px;top:10px;width:90px;height:70px;background:#36f;clip-path:polygon(50% 0,100% 100%,0 70%)"></div>
<div style="position:absolute;left:230px;top:10px;width:90px;height:70px;background:#3a6;clip-path:inset(10px 20px round 15px)"></div>
<div style="position:absolute;left:10px;top:100px;width:90px;height:70px;background:#a3c;clip-path:ellipse(50% 30% at 50% 50%)"></div>
<div style="position:absolute;left:120px;top:100px;width:90px;height:70px;background:#c93;clip-path:polygon(calc(50% - 20px) 0,calc(100% - 10px) 50%,50% calc(100% - 5px),10px 50%)"></div>
<div style="position:absolute;left:230px;top:100px;width:90px;height:70px;background:#09c;clip-path:path('M0 0 L90 0 L45 70 Z')"></div>"#
        .to_string()
});

case!(masks_and_overflow, 340, 200, {
    format!(
        r#"<div style="position:absolute;left:10px;top:10px;width:100px;height:70px;background:#f63;-webkit-mask-image:linear-gradient(90deg,#000,transparent);mask-image:linear-gradient(90deg,#000,transparent)"></div>
<div style="position:absolute;left:120px;top:10px;width:100px;height:70px;background:#36f;mask-image:radial-gradient(circle at 50% 50%,#000 30%,transparent 60%)"></div>
<div style="position:absolute;left:230px;top:10px;width:100px;height:70px;background:#3a6;mask-image:url({0});mask-size:32px 32px;mask-repeat:repeat"></div>
<div style="position:absolute;left:10px;top:100px;width:100px;height:70px;border:4px solid #333;border-radius:25px;overflow:hidden;background:#eee"><div style="width:140px;height:100px;background:linear-gradient(45deg,#f0c,#0cf)"></div></div>
<div style="position:absolute;left:130px;top:100px;width:100px;height:70px;overflow:hidden;"><img src="{1}" style="width:140px;height:100px;object-fit:cover"></div>
<div style="position:absolute;left:250px;top:100px;width:80px;height:70px;"><img src="{1}" style="width:80px;height:70px;object-fit:contain;object-position:0 100%;background:#cde"></div>"#,
        asset("tile.png"),
        asset("photo.png")
    )
});

case!(filters, 340, 220, {
    format!(
        r#"<div style="position:absolute;left:10px;top:10px;width:90px;height:60px;background:linear-gradient(90deg,#f33,#3f3);filter:blur(4px)"></div>
<div style="position:absolute;left:120px;top:10px;width:90px;height:60px;background:linear-gradient(90deg,#f33,#3f3);filter:grayscale(1) contrast(1.4)"></div>
<div style="position:absolute;left:230px;top:10px;width:90px;height:60px;background:linear-gradient(90deg,#f33,#3f3);filter:hue-rotate(90deg) saturate(1.5) brightness(1.1)"></div>
<div style="position:absolute;left:10px;top:100px;width:90px;height:60px;background:#fc3;border-radius:12px;filter:drop-shadow(6px 8px 6px rgba(0,0,0,.6))"></div>
<div style="position:absolute;left:120px;top:100px;width:90px;height:60px;background:#39f;filter:invert(.8) sepia(.5)"></div>
<div style="position:absolute;left:230px;top:100px;width:90px;height:60px;background:#39f;opacity:.5;filter:opacity(.5)"></div>
<img src="{}" style="position:absolute;left:10px;top:180px;width:60px;height:36px">"#,
        asset("photo.png")
    )
});

case!(paint_order, 340, 230, {
    r#"<div style="position:relative;width:320px;height:210px;margin:5px">
<div style="position:absolute;left:10px;top:10px;width:100px;height:80px;background:#f66;z-index:2"></div>
<div style="position:absolute;left:60px;top:40px;width:100px;height:80px;background:#6c6;z-index:1;opacity:.9"></div>
<div style="position:absolute;left:110px;top:70px;width:100px;height:80px;background:#66f;"></div>
<div style="float:left;width:70px;height:70px;background:#fc3;margin:120px 0 0 20px"></div>
<div style="margin:130px 0 0 60px;height:40px;background:#ccc;opacity:1;color:#000">block over float text</div>
<div style="position:absolute;left:220px;top:20px;width:90px;height:90px;background:#999;transform:rotate(10deg);z-index:-1"></div>
<div style="position:absolute;left:230px;top:140px;width:60px;height:50px;background:#c0c;outline:4px solid #306;outline-offset:3px"></div>
<div style="display:flex;position:absolute;left:10px;top:170px;gap:6px"><div style="width:30px;height:30px;background:#f90;order:2"></div><div style="width:30px;height:30px;background:#09f;order:1"></div><div style="width:30px;height:30px;background:#9c0;z-index:-1;margin-left:-20px"></div></div>
</div>"#
        .to_string()
});

case!(background_clip_text, 340, 120, {
    r#"<div style="margin:10px;font-size:48px;font-weight:700;background:linear-gradient(90deg,#f0c,#0cf);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent">Gradient</div>
<div style="margin:10px;font-size:30px;background:repeating-linear-gradient(45deg,#e33 0 6px,#fc3 6px 12px);background-clip:text;-webkit-text-fill-color:transparent">Stripes!</div>"#
        .to_string()
});

// `opacity` on inline elements (issue #73): the second span, a span with a background and a shadow, and a span that
// wraps are each dimmed as a whole, the block at 0.45 as before.
case!(inline_opacity, 360, 190, {
    r#"<div style="margin:6px 10px;font-size:34px;line-height:40px"><span>read </span><span style="opacity:.45">not yet read</span></div>
<div style="margin:6px 10px;font-size:30px;line-height:36px;width:200px"><span style="opacity:.5;background:#fc3;text-decoration:underline;text-shadow:3px 3px 0 #f00">wraps over two lines</span></div>
<div style="margin:6px 10px;font-size:26px;opacity:.45">whole line .45</div>"#
        .to_string()
});

case!(text_stroke, 460, 330, {
    r#"<div style="margin:6px 10px;font-size:64px;line-height:72px;font-weight:700;color:#fff;background:#6a9bd1;-webkit-text-stroke:12px #000;paint-order:stroke fill">MAKE KW</div>
<div style="margin:6px 10px;font-size:64px;line-height:72px;font-weight:700;color:#fff;background:#6a9bd1;-webkit-text-stroke:8px #000">MAKE KW</div>
<div style="margin:6px 10px;font-size:48px;line-height:60px;color:#fff;background:#6a9bd1;-webkit-text-stroke-width:2px;-webkit-text-stroke-color:#c00;text-shadow:5px 5px 0 #00f;transform:rotate(-3deg);opacity:.8">Shadow <span>inherits</span></div>
<div style="margin:6px 10px;font-size:56px;line-height:64px;background:#222;background-image:linear-gradient(90deg,#f0c,#0cf);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;-webkit-text-stroke:3px #000">Gradient</div>"#
        .to_string()
});

case!(lists_and_outline, 340, 200, {
    r#"<ul style="margin:0;padding-left:40px;font-size:22px;position:absolute;left:0;top:0"><li>Disc</li><li style="list-style:circle">Circle</li><li style="list-style:square">Square</li></ul>
<ol style="margin:0;padding-left:40px;font-size:22px;position:absolute;left:150px;top:0"><li>One</li><li>Two</li><li style="list-style:upper-alpha">Alpha</li></ol>
<div style="position:absolute;left:30px;top:130px;width:100px;height:40px;background:#fc9;outline:3px dashed #309;outline-offset:4px;border-radius:10px"></div>
<div style="position:absolute;left:190px;top:130px;width:100px;height:40px;background:#9cf;outline:5px solid rgba(200,0,80,.6)"></div>"#
        .to_string()
});

case!(preserve_3d, 360, 220, {
    r#"<div style="position:absolute;left:30px;top:30px;width:120px;height:120px;perspective:500px">
<div style="position:relative;width:120px;height:120px;transform-style:preserve-3d;transform:rotateY(35deg) rotateX(-15deg)">
<div style="position:absolute;width:80px;height:80px;left:20px;top:20px;background:#f66;transform:translateZ(-40px)"></div>
<div style="position:absolute;width:80px;height:80px;left:20px;top:20px;background:#6c6;transform:translateZ(40px)"></div>
<div style="position:absolute;width:80px;height:80px;left:20px;top:20px;background:#66f;transform:rotateY(90deg) translateZ(40px)"></div>
</div></div>
<div style="position:absolute;left:210px;top:30px;width:120px;height:120px;perspective:400px">
<div style="width:100px;height:100px;background:#fc3;transform:rotateY(180deg);backface-visibility:hidden"></div></div>
<div style="position:absolute;left:210px;top:140px;width:120px;height:70px;perspective:400px">
<div style="width:100px;height:60px;background:#3cf;transform:rotateY(160deg)"></div></div>"#
        .to_string()
});

// CSS Transforms 2 "grouping property values": each of these flattens a preserve-3d element, so the red plane
// (behind, later in the document) is painted over the green one (in front), as Chrome does.
case!(preserve_3d_flattened, 720, 280, {
    let extras = [
        "opacity:.7",
        "filter:hue-rotate(40deg)",
        "clip-path:inset(0 14px 0 0)",
        "mask-image:linear-gradient(#000,#0006)",
        "mix-blend-mode:multiply",
        "isolation:isolate",
        "overflow:hidden",
        "backdrop-filter:blur(2px)",
    ];
    extras
        .iter()
        .enumerate()
        .map(|(i, extra)| {
            format!(
                r#"<div style="position:absolute;left:{}px;top:{}px;width:170px;height:130px;perspective:400px">
<div style="position:relative;width:140px;height:110px;transform-style:preserve-3d;transform:rotateY(30deg);{extra}">
<div style="position:absolute;left:20px;top:15px;width:80px;height:80px;background:#6c6;transform:translateZ(60px)"></div>
<div style="position:absolute;left:20px;top:15px;width:80px;height:80px;background:#f66;transform:translateZ(-60px)"></div>
</div></div>"#,
                (i % 4) * 180,
                (i / 4) * 140
            )
        })
        .collect()
});

case!(border_images, 340, 220, {
    format!(
        r#"<div style="position:absolute;left:10px;top:10px;width:90px;height:60px;border:12px solid transparent;border-image:url({0}) 16 round"></div>
<div style="position:absolute;left:130px;top:10px;width:90px;height:60px;border:12px solid transparent;border-image:url({1}) 14 stretch"></div>
<div style="position:absolute;left:250px;top:10px;width:70px;height:60px;border:8px solid;border-image:linear-gradient(45deg,#f0c,#0cf) 1"></div>
<div style="position:absolute;left:10px;top:120px;width:90px;height:60px;border:10px solid transparent;border-image:url({0}) 10 / 10px 20px / 4px space;background:#eee"></div>
<div style="position:absolute;left:130px;top:120px;width:90px;height:60px;border:10px solid transparent;border-image:repeating-linear-gradient(90deg,#000 0 6px,#fc0 6px 12px) 10 fill / 10px"></div>"#,
        asset("tile.png"),
        asset("photo.png")
    )
});

case!(clipped_positioned, 340, 200, {
    r#"<div style="position:absolute;left:20px;top:20px;width:120px;height:80px;background:#cde;overflow:hidden;border-radius:16px">
<div style="position:absolute;left:90px;top:50px;width:60px;height:60px;background:#f63"></div>
<div style="position:absolute;left:-20px;top:-20px;width:60px;height:40px;background:#36f;z-index:3"></div></div>
<div style="position:absolute;left:180px;top:20px;width:120px;height:80px;background:#cde;overflow:hidden;opacity:.9">
<div style="position:absolute;left:80px;top:40px;width:80px;height:60px;background:#3a6;z-index:2"></div></div>
<div style="position:absolute;left:20px;top:120px;width:120px;height:60px;overflow:hidden"><div style="margin-left:80px;width:100px;height:60px;background:#c3c"></div></div>
<div style="position:absolute;left:180px;top:120px;width:120px;height:60px;overflow:hidden;background:#fed;position:absolute"><div style="position:absolute;left:100px;top:20px;width:100px;height:60px;background:#39c"></div></div>"#
        .to_string()
});

// Floats: margins, `clear`, drop caps, floats in floats, a line too narrow for any content moving below
// the floats, a BFC that contains its float.
case!(floats, 340, 410, {
    r#"<div style="position:absolute;left:10px;top:10px;width:150px;font-size:14px;line-height:18px;background:#eef"><div style="float:left;width:40px;height:40px;margin:10px 12px 8px 6px;background:#f66"></div>The quick brown fox jumps over the lazy dog and keeps running far away until the night falls and rises again</div>
<div style="position:absolute;left:180px;top:10px;width:150px;font-size:14px;line-height:18px;background:#efe"><div style="float:right;width:40px;height:40px;margin:4px 0 4px 10px;background:#66f"></div>The quick brown fox jumps over the lazy dog and keeps running far away until the night falls</div>
<div style="position:absolute;left:10px;top:130px;width:150px;font-size:14px;line-height:18px;background:#fee"><div style="float:left;width:30px;height:60px;background:#6c6"></div><div style="float:left;width:30px;height:30px;background:#c6c;margin-left:4px"></div><div style="float:left;width:30px;height:30px;background:#6cc;clear:left"></div>Wrapping text after several floats of different heights goes around them all</div>
<div style="position:absolute;left:180px;top:130px;width:150px;font-size:14px;line-height:18px;background:#ffe"><p style="margin:0"><span style="float:left;font-size:40px;line-height:34px;margin-right:4px">D</span>rop cap paragraph that wraps around the big first letter for some lines</p></div>
<div style="position:absolute;left:10px;top:240px;width:150px;background:#eef;font-size:13px;line-height:16px"><div style="float:left;width:50px;height:50px;background:#f66"></div><div style="clear:both;background:#aaf">cleared block</div><div style="margin-top:10px;background:#afa">after</div></div>
<div style="position:absolute;left:180px;top:240px;width:150px;background:#fee;font-size:13px;line-height:16px;display:flow-root"><div style="float:right;width:60px;height:60px;background:#c6c"></div>BFC container contains its float</div>
<div style="position:absolute;left:10px;top:330px;width:150px;background:#ffe;font-size:13px;line-height:16px"><div style="float:left;width:60px;height:30px;background:#9c6"></div><div style="float:right;width:60px;height:30px;background:#69c"></div><div style="text-align:center">centered line between two floats</div></div>
<div style="position:absolute;left:180px;top:330px;width:150px;background:#eff;font-size:13px;line-height:16px"><div style="float:left;width:120px;height:20px;background:#c93"></div><div style="float:left;width:120px;height:20px;background:#39c"></div>text after wide floats that cannot sit side by side</div>"#
        .to_string()
});

// Tables, separate borders: the backgrounds of rows, row groups, columns and column groups (under
// the cells', cut to them), spans, vertical alignment, captions above and below.
case!(tables, 340, 330, {
    r#"<table style="position:absolute;left:10px;top:10px;font-size:13px;border-spacing:3px;border:2px solid #666;background:#eef"><thead style="background:#fc9"><tr><th style="padding:3px 8px">Item</th><th style="padding:3px 8px">Qty</th><th style="padding:3px 8px">Price</th></tr></thead><tbody style="background:#cfc"><tr><td style="padding:3px 8px">Apple</td><td style="padding:3px 8px;text-align:right">12</td><td style="padding:3px 8px;text-align:right">1.20</td></tr><tr style="background:linear-gradient(90deg,#9cf,#fcf)"><td style="padding:3px 8px">Watermelon</td><td style="padding:3px 8px;text-align:right">3</td><td style="padding:3px 8px;text-align:right">4.50</td></tr></tbody><tfoot style="background:#ccc"><tr><td colspan="2" style="padding:3px 8px">Total</td><td style="padding:3px 8px;text-align:right">5.70</td></tr></tfoot></table>
<table style="position:absolute;left:10px;top:130px;font-size:13px;border-spacing:0;width:320px;table-layout:fixed"><colgroup style="background:#fdd"><col style="width:60px"><col style="background:#dfd;width:80px"></colgroup><col style="background:#ddf"><tr><td style="height:30px;padding:2px">a</td><td style="padding:2px;vertical-align:bottom">bottom</td><td rowspan="2" style="padding:2px;vertical-align:middle;background:#ff9">span 2 rows</td></tr><tr><td colspan="2" style="padding:2px;background:#fff;border:1px dashed #666">wide</td></tr></table>
<table style="position:absolute;left:10px;top:210px;font-size:13px;border-collapse:separate;border-spacing:2px"><caption style="background:#fdb;padding:3px;text-align:left">Top caption</caption><tr><td style="background:#cdf;padding:4px 20px">Wide cell</td><td style="background:#cfd;padding:4px">B</td></tr><caption style="caption-side:bottom;background:#dfc;text-align:center">Bottom</caption></table>
<table style="position:absolute;left:210px;top:210px;font-size:13px;border-spacing:0"><tr><td style="padding:6px;border:1px solid #333;background:#eee"></td><td style="padding:6px;border:1px solid #333;background:#eee">x</td></tr></table>"#
        .to_string()
});

// Tables, collapsed borders: the widest border wins a line, then the style, then the element; a
// cell's border is half in it; `hidden`, dashed and double, row and table borders.
case!(tables_collapsed, 340, 250, {
    r#"<style>td,th{border:1px solid #333;padding:4px 8px}</style><table style="position:absolute;left:10px;top:10px;border-collapse:collapse;font-size:13px"><tr><th style="background:#ddd">Name</th><th style="background:#ddd">Qty</th></tr><tr><td>Apple</td><td style="text-align:right">12</td></tr><tr><td>Watermelon</td><td style="text-align:right">3</td></tr></table>
<table style="position:absolute;left:190px;top:10px;border-collapse:collapse;font-size:13px;border:3px solid #a00"><tr><td style="border:2px solid #00a">A</td><td style="border:none">B</td></tr><tr><td style="border:1px dashed #0a0">C</td><td style="border-bottom:4px double #a0a">D</td></tr></table>
<table style="position:absolute;left:10px;top:120px;border-collapse:collapse;font-size:13px"><tr style="border-bottom:3px solid #06c"><td style="border:1px solid #999">1</td><td style="border:1px solid #999;border-right:hidden">2</td><td style="border:1px solid #999">3</td></tr><tr><td style="border:1px solid #999;background:#fed" colspan="2">span</td><td style="border:1px dotted #c00;border-width:2px">5</td></tr></table>
<table style="position:absolute;left:190px;top:120px;border-collapse:collapse;font-size:13px;border:2px groove #555"><colgroup><col style="border-left:3px solid #0a6"><col></colgroup><tr><td style="padding:6px 10px;border:1px solid #bbb">x</td><td style="padding:6px 10px;border:1px solid #bbb;background:#eef">y</td></tr><tr style="background:#fee"><td style="padding:6px 10px;border:1px inset #888">z</td><td style="padding:6px 10px;border:1px outset #888">w</td></tr></table>
<table style="position:absolute;left:10px;top:200px;width:320px;border-collapse:collapse;font-size:13px"><tr><td style="border:1px solid #333;padding:4px">width 100%</td><td style="border:1px solid #333;padding:4px;text-align:right">ends here</td></tr></table>"#
        .to_string()
});

// Tables, automatic column widths: extra width in proportion to what the columns want, spans, a given
// width, a percentage, nowrap, inline-table and display: table-cell on any element.
case!(tables_auto, 340, 260, {
    r#"<table style="position:absolute;left:10px;top:10px;width:320px;border-collapse:collapse;font-size:13px"><tr><td style="background:#eee;border:1px solid #666;padding:4px">short</td><td style="background:#ddd;border:1px solid #666;padding:4px">a considerably longer cell that wraps onto lines</td><td style="background:#ccc;border:1px solid #666;padding:4px;width:20%">20%</td></tr></table>
<table style="position:absolute;left:10px;top:90px;font-size:13px;border-spacing:2px"><tr><td style="background:#eee;padding:4px;white-space:nowrap">nowrap cell content</td><td style="background:#ddd;padding:4px">b</td></tr><tr><td colspan="2" style="background:#cdf;padding:4px">spans both columns of the table</td></tr></table>
<div style="position:absolute;left:230px;top:90px;display:inline-table;font-size:13px;background:#fed"><div style="display:table-row"><span style="display:table-cell;padding:3px">cell1</span><span style="display:table-cell;padding:3px">cell2</span></div></div>
<table style="position:absolute;left:10px;top:160px;width:320px;font-size:13px;border-spacing:0"><tr><td style="background:#fdd;padding:4px;width:60px">fixed 60</td><td style="background:#dfd;padding:4px">auto, short</td><td style="background:#ddf;padding:4px">auto and a lot longer text</td></tr></table>
<table style="position:absolute;left:10px;top:210px;width:320px;font-size:13px;border-spacing:0;table-layout:fixed"><tr><td style="background:#fdd;padding:4px">fixed layout</td><td style="background:#dfd;padding:4px;width:100px">100px</td><td style="background:#ddf;padding:4px">rest</td></tr></table>"#
        .to_string()
});

// `-webkit-line-clamp`: the height is the bottom of the Nth line, the ellipsis ends it.
case!(line_clamp, 340, 300, {
    r#"<div style="position:absolute;left:10px;top:10px;width:150px;font-size:16px;line-height:20px;background:#eef;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden">The quick brown fox jumps over the lazy dog and keeps running far away</div>
<div style="position:absolute;left:180px;top:10px;width:150px;font-size:16px;line-height:20px;background:#efe;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3">The quick brown fox jumps over the lazy dog and keeps running far away until night</div>
<div style="position:absolute;left:10px;top:80px;width:150px;font-size:16px;line-height:20px;background:#fee;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden">Short</div>
<div style="position:absolute;left:180px;top:80px;width:150px;font-size:16px;line-height:20px;background:#ffe;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;padding:4px">Antidisestablishmentarianism and other quite long words follow here</div>
<div style="position:absolute;left:10px;top:150px;width:150px;font-size:16px;line-height:20px;background:#eff;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden"><p style="margin:6px 0">The quick brown fox jumps</p><p style="margin:6px 0">over the lazy dog and keeps running far away</p></div>
<div style="position:absolute;left:180px;top:150px;width:150px;font-size:16px;line-height:20px;background:#fef;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden"><span style="display:inline-block;width:14px;height:34px;background:#39c;vertical-align:bottom"></span>The quick brown fox jumps over the lazy dog and keeps running</div>
<div style="position:absolute;left:10px;top:230px;width:150px;height:60px;font-size:16px;line-height:20px;background:#fed;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden">The quick brown fox jumps over the lazy dog and keeps running far away</div>
<div style="position:absolute;left:180px;top:230px;width:150px;font-size:16px;line-height:20px;background:#def;box-sizing:border-box;border:3px solid #369;padding:3px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;color:#036;text-overflow:ellipsis">The quick brown fox jumps over the lazy dog and keeps running far away</div>"#
        .to_string()
});

// `text-overflow: ellipsis` on a box that clips: a line that is too long ends with the ellipsis.
case!(text_overflow, 340, 140, {
    r#"<div style="position:absolute;left:10px;top:10px;width:120px;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#eef">A long line of text that overflows</div>
<div style="position:absolute;left:150px;top:10px;width:120px;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#efe">Short</div>
<div style="position:absolute;left:10px;top:50px;width:120px;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 8px;background:#fee;color:#a30">Supercalifragilistic expialidocious <b>bold tail</b> end</div>
<div style="position:absolute;left:150px;top:50px;width:150px;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:clip;background:#ffe">A long line of text that overflows</div>
<div style="position:absolute;left:10px;top:90px;width:200px;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-decoration:underline;text-shadow:1px 1px 2px #888">Underlined text with a shadow overflowing</div>"#
        .to_string()
});

// `@container`: Stylo matches the rules once layout has given each container its size, and the
// container units (`cqw`) and the `container` shorthand work as in Chrome.
case!(container_queries, 340, 350, {
    r#"<style>
.c{container-type:inline-size;position:absolute;background:#eee}
.i{padding:6px;background:#f66;color:#fff;font-size:14px}
@container (min-width:200px){.i{background:#36c}.i:after{content:' wide'}}
@container (max-width:199px){.i{background:#6a4}}
.card{container:card / inline-size;position:absolute;background:#eee;padding:6px}
.t{font-size:14px;padding:4px;background:#f66;color:#fff}
@container card (min-width:200px){.t{background:#36c;font-size:20px}}
@container card (width < 200px){.t:before{content:'narrow '}}
@container (400px > width >= 100px) and (min-height: 0px){.t{outline:2px solid #fc0}}
.cq{font-size:8cqw;background:#cfc;padding:2px;white-space:nowrap}
.size{container-type:size;position:absolute;background:#ddd}
.h{height:20px;background:#9c3}
@container (min-height:60px){.h{background:#c93}}
.outer{container-type:inline-size;position:absolute;background:#ccd;padding:4px}
.inner{container-type:inline-size;background:#dde;padding:4px}
.leaf{color:#060}
@container (min-width:250px){.leaf{color:#c00;font-weight:bold}}
</style>
<div class="c" style="left:10px;top:10px;width:120px"><div class="i">narrow</div></div>
<div class="c" style="left:150px;top:10px;width:180px"><div class="i">mid</div></div>
<div class="card" style="left:10px;top:50px;width:120px"><div class="t">narrow</div></div>
<div class="card" style="left:150px;top:50px;width:180px"><div class="t">wider</div></div>
<div class="card" style="left:10px;top:100px;width:300px"><div class="t">wide</div><div class="cq">cq 8cqw</div></div>
<div class="size" style="left:10px;top:190px;width:100px;height:40px"><div class="h"></div></div>
<div class="size" style="left:130px;top:190px;width:100px;height:80px"><div class="h"></div></div>
<div class="outer" style="left:10px;top:285px;width:320px"><div class="inner" style="width:150px"><span class="leaf">inner 150</span></div><span class="leaf">outer 320</span></div>"#
        .to_string()
});

case!(borders, 340, 260, {
    r#"<div style="position:absolute;left:10px;top:10px;width:90px;height:50px;border:3px solid;border-color:#f00 #0a0 #00f #fa0"></div>
<div style="position:absolute;left:120px;top:10px;width:90px;height:50px;border-style:solid;border-width:2px 8px 14px 4px;border-color:#234;border-radius:12px 30px 5px 20px"></div>
<div style="position:absolute;left:230px;top:10px;width:90px;height:50px;border:4px dashed #c30"></div>
<div style="position:absolute;left:10px;top:90px;width:90px;height:50px;border:5px dotted #306"></div>
<div style="position:absolute;left:120px;top:90px;width:90px;height:50px;border:9px double #036"></div>
<div style="position:absolute;left:230px;top:90px;width:90px;height:50px;border:8px groove #6a4"></div>
<div style="position:absolute;left:10px;top:170px;width:90px;height:50px;border:8px ridge #a64"></div>
<div style="position:absolute;left:120px;top:170px;width:90px;height:50px;border:8px inset #48c"></div>
<div style="position:absolute;left:230px;top:170px;width:90px;height:50px;border:8px outset #48c;border-radius:20px/10px"></div>"#
        .to_string()
});

/// Transitions: each box gets the class `go` half a second into a second-long transition, and the
/// frame is the one at 1 s. Chrome's page does the same with the Web Animations API (the
/// transitions are paused at 500 ms), ours replays two states (`IslandRequest::history`).
#[test]
fn transitions() {
    use serde_json::json;

    let (w, h) = (340, 230);
    let css = r#"
.t{position:absolute;width:60px;height:40px;transition:all 1s linear}
.a{left:10px;top:10px;background:#f00}
.a.go{background:#00f;opacity:.2}
.b{left:90px;top:10px;background:#0a0}
.b.go{transform:rotate(45deg) scale(1.5)}
.c{left:200px;top:10px;border-radius:0;background:#999}
.c.go{width:100px;height:60px;border-radius:20px;background:#fc0}
.d{left:10px;top:100px;background:#36c;transition:background-color 1s ease-in}
.d.go{background:#fc3}
.e{left:90px;top:100px;background:#639;transition:left 1s linear .25s}
.e.go{left:230px}
.f{left:10px;top:160px;background:#f90;transition:filter 1s linear}
.f.go{filter:blur(8px)}
.g{left:120px;top:160px;background:#3a9;transition:none}
.g.go{left:220px}
.h{left:230px;top:100px;background:#c06;border:0 solid #000;transition:border-width 1s linear}
.h.go{border-width:10px}
"#;
    let names = ["a", "b", "c", "d", "e", "f", "g", "h"];
    // Chrome: the same boxes, the class added, every transition paused at 500 ms.
    let boxes: String = names
        .iter()
        .map(|n| format!(r#"<div class="t {n}"></div>"#))
        .collect();
    let chrome_body = format!(
        r#"<style>{css}</style>{boxes}<script>
const boxes = [...document.querySelectorAll('.t')];
boxes.forEach(b => getComputedStyle(b).opacity);
boxes.forEach(b => b.classList.add('go'));
boxes.forEach(b => getComputedStyle(b).opacity);
document.getAnimations().forEach(a => {{ a.pause(); a.currentTime = 500; }});
</script>"#
    );
    let reference = paintkit::chrome("transitions", &chrome_body, w, h);

    // Ours: the boxes before (0 s), with `go` from 0.5 s, and at 1 s.
    let tree = |go: bool| {
        let class = |n: &&str| {
            if go {
                format!("t {n} go")
            } else {
                format!("t {n}")
            }
        };
        common::el(
            "div",
            "$0",
            "",
            names
                .iter()
                .enumerate()
                .map(|(i, n)| {
                    common::el_attrs(
                        "div",
                        &format!("$0.{i}"),
                        json!({ "class": class(n) }),
                        "",
                        vec![],
                    )
                })
                .collect(),
        )
    };
    let mut req = common::request(tree(true));
    req["viewport"] = json!({ "width": w, "height": h });
    req["stylesheets"] = json!([css]);
    req["time"] = json!(1.0);
    req["history"] = json!([
        { "time": 0.0, "root": tree(false) },
        { "time": 0.5, "root": tree(true) },
    ]);
    let request = common::parse(&req);
    let island = kinetograph_dom::document::resolve(&request).unwrap();
    let out = kinetograph_dom::paint::paint(&island.doc, &request);
    let frame = paintkit::render_output(&out, w, h);
    let dir = paintkit::out_dir();
    paintkit::save_frame(&frame, &dir.join("transitions-ours.png"));
    paintkit::check_golden("transitions", &frame);
    let diff = reference.map(|reference| {
        let ours = paintkit::frame_image(&frame);
        paintkit::diff_image(&ours, &reference)
            .save(dir.join("transitions-diff.png"))
            .unwrap();
        paintkit::diff(&ours, &reference)
    });
    if let Some(d) = diff {
        assert!(d.mean < 30.0, "transitions: {d:?}");
    }
    println!(
        "transitions: unsupported {:?}; diff {diff:?}",
        out.unsupported
    );
}

/// A case compared with Chrome more closely than `case!`: the mean difference
/// must be under `$mean` (of 255).
macro_rules! close_case {
    ($name:ident, $w:expr, $h:expr, $mean:expr, $body:expr) => {
        #[test]
        fn $name() {
            let body: String = $body;
            let (out, frame, diff) = compare(stringify!($name), &body, $w, $h);
            println!(
                "{}: layers {}; unsupported {:?}; diff {:?}",
                stringify!($name),
                paintkit::count_layers(&out.layers),
                out.unsupported,
                diff
            );
            paintkit::check_golden(stringify!($name), &frame);
            assert!(out.unsupported.is_empty(), "{:?}", out.unsupported);
            if let Some(d) = diff {
                assert!(d.mean < $mean, "{}: {d:?}", stringify!($name));
            }
        }
    };
}

// Two planes that cross, a cube and a card turned past edge-on, in one
// preserve-3d context each: drawn in pieces, back to front, as Chrome's BSP
// tree orders them.
close_case!(preserve_3d_crossing, 480, 200, 1.5, {
    r#"<div style="position:absolute;left:20px;top:20px;width:160px;height:160px;perspective:600px">
<div style="position:relative;width:160px;height:160px;transform-style:preserve-3d;transform:rotateY(25deg) rotateX(-20deg)">
<div style="position:absolute;left:20px;top:30px;width:120px;height:100px;background:rgba(220,40,40,.85)"></div>
<div style="position:absolute;left:20px;top:30px;width:120px;height:100px;background:rgba(40,90,220,.85);transform:rotateY(70deg)"></div>
<div style="position:absolute;left:20px;top:30px;width:120px;height:100px;background:rgba(40,170,60,.85);transform:rotateX(60deg)"></div>
</div></div>
<div style="position:absolute;left:200px;top:40px;width:120px;height:120px;perspective:500px">
<div style="position:relative;width:100px;height:100px;margin:10px;transform-style:preserve-3d;transform:rotateX(-25deg) rotateY(38deg)">
<div style="position:absolute;width:100px;height:100px;background:#e55;transform:translateZ(50px)"></div>
<div style="position:absolute;width:100px;height:100px;background:#5b5;transform:rotateY(90deg) translateZ(50px)"></div>
<div style="position:absolute;width:100px;height:100px;background:#55e;transform:rotateY(180deg) translateZ(50px)"></div>
<div style="position:absolute;width:100px;height:100px;background:#ee5;transform:rotateY(-90deg) translateZ(50px)"></div>
<div style="position:absolute;width:100px;height:100px;background:#5ee;transform:rotateX(90deg) translateZ(50px)"></div>
<div style="position:absolute;width:100px;height:100px;background:#e5e;transform:rotateX(-90deg) translateZ(50px)"></div>
</div></div>
<div style="position:absolute;left:340px;top:30px;width:120px;height:140px;perspective:400px">
<div style="position:relative;width:120px;height:140px;transform-style:preserve-3d;transform:rotateY(150deg)">
<div style="position:absolute;inset:0;background:#c63;backface-visibility:hidden">front</div>
<div style="position:absolute;inset:0;background:#36c;backface-visibility:hidden;transform:rotateY(180deg)">back</div>
</div></div>"#
        .to_string()
});

// A card lying flat, crossed by 20 standing cards side by side: pieces of the
// flat card collect more cuts than one warp takes, and are cut before the warp.
close_case!(preserve_3d_comb, 360, 260, 1.5, {
    let standing: String = (0..20)
        .map(|i| {
            format!(
                r#"<div style="position:absolute;left:{}px;top:0;width:100px;height:120px;background:hsl({},70%,55%);transform:rotateY(90deg)"></div>"#,
                i * 8,
                i * 18
            )
        })
        .collect();
    format!(
        r#"<div style="position:absolute;left:0;top:0;width:360px;height:260px;perspective:700px">
<div style="position:absolute;left:70px;top:70px;width:240px;height:120px;transform-style:preserve-3d;transform:rotateX(-35deg) rotateY(25deg)">
{standing}<div style="position:absolute;left:20px;top:10px;width:200px;height:100px;background:rgba(40,40,40,.9);transform:rotateX(90deg)"></div>
</div></div>"#
    )
});

// A star of 20 cards turned about one vertical axis: each crosses all the
// others along the axis.
close_case!(preserve_3d_star, 320, 240, 1.5, {
    let cards: String = (0..20)
        .map(|i| {
            format!(
                r#"<div style="position:absolute;left:0;top:0;width:160px;height:140px;background:hsl({},65%,55%);transform:rotateY({}deg)"></div>"#,
                i * 18,
                i * 9
            )
        })
        .collect();
    format!(
        r#"<div style="position:absolute;left:0;top:0;width:320px;height:240px;perspective:600px">
<div style="position:absolute;left:80px;top:50px;width:160px;height:140px;transform-style:preserve-3d;transform:rotateX(-20deg) rotateY(10deg)">
{cards}</div></div>"#
    )
});

// Parallel cards in a turned stack, where the middle of the farther card is
// nearer the eye than the middle of the nearer one: ordered by their planes.
close_case!(preserve_3d_tilted_stack, 480, 270, 1.0, {
    r#"<div style="position:absolute;left:0;top:0;width:480px;height:270px;perspective:700px">
<div style="position:absolute;left:115px;top:212px;width:0;height:0;transform-style:preserve-3d;transform:rotateX(24deg) rotateY(40deg)">
<div style="position:absolute;left:-44px;top:-19px;width:88px;height:54px;border-radius:8px;background:#f4a460;transform:translateZ(30px)"></div>
<div style="position:absolute;left:8px;top:-15px;width:88px;height:54px;border-radius:8px;background:#e8c76a;transform:translateZ(60px)"></div>
<div style="position:absolute;left:-10px;top:-37px;width:88px;height:54px;border-radius:8px;background:#e06050;transform:translateZ(-60px)"></div>
</div></div>"#
        .to_string()
});

// An inline-block that is a stacking context is painted once, from its line.
close_case!(inline_block_stacking_context, 320, 120, 1.0, {
    r#"<div style="font-size:40px">ab</div>
<div style="font-size:40px"><span style="display:inline-block;transform:scale(0.5);background:rgba(0,120,255,.5)">ab</span> <span style="display:inline-block;position:relative;left:10px;opacity:.6;background:#f80">cd</span></div>"#
        .to_string()
});

// `background-repeat: space` and `round` with thousands of gradient tiles,
// and `space` with thousands of picture tiles: one shape whose paint repeats
// the tile at its exact period.
close_case!(background_space_many_tiles, 640, 420, 4.0, {
    format!(
        r#"<div style="position:absolute;left:10px;top:10px;width:300px;height:200px;background-image:linear-gradient(red,blue);background-size:12px 12px;background-repeat:space"></div>
<div style="position:absolute;left:330px;top:10px;width:300px;height:200px;background-image:linear-gradient(90deg,#fc0,#063);background-size:13px 9px;background-repeat:space"></div>
<div style="position:absolute;left:10px;top:220px;width:300px;height:190px;background-image:radial-gradient(#000 40%,transparent 41%);background-size:11px 11px;background-repeat:round"></div>
<div style="position:absolute;left:330px;top:220px;width:300px;height:190px;background:url({}) 0 0 / 10px 10px space"></div>"#,
        asset("tile.png")
    )
});

// `backdrop-filter` reads only the backdrop inside the element's box,
// mirrored past its edges, as Chrome does: the box beside the black half
// stays white, the strip is mirrored at the box's left edge, and a blur of
// 300 px (wider than the old limit of 128) frosts a box at the canvas edge.
close_case!(backdrop_mirrored, 640, 320, 1.0, {
    r#"<div style="position:absolute;left:0;top:0;width:320px;height:320px;background:#000"></div>
<div style="position:absolute;left:470px;top:0;width:20px;height:320px;background:#c00"></div>
<div style="position:absolute;left:330px;top:20px;width:100px;height:100px;backdrop-filter:blur(20px)"></div>
<div style="position:absolute;left:200px;top:140px;width:240px;height:80px;backdrop-filter:blur(20px)"></div>
<div style="position:absolute;left:470px;top:20px;width:150px;height:150px;backdrop-filter:blur(12px)"></div>
<div style="position:absolute;left:0;top:240px;width:640px;height:80px;background:linear-gradient(90deg,#fc0,#06c)"></div>
<div style="position:absolute;left:0;top:250px;width:400px;height:70px;backdrop-filter:blur(300px)"></div>"#
        .to_string()
});

// Blurs wider than the old limits (128 for a shadow, 512 for a blur): a
// drop shadow of 300 px and a blur of 600 px.
close_case!(large_blurs, 640, 320, 2.0, {
    r#"<div style="position:absolute;inset:0;background:linear-gradient(90deg,#f00,#00f)"></div>
<div style="position:absolute;left:60px;top:60px;width:200px;height:200px;background:#fff;filter:drop-shadow(0 0 600px #0f0)"></div>
<div style="position:absolute;left:380px;top:60px;width:200px;height:200px;background:#ff0;filter:blur(600px)"></div>"#
        .to_string()
});
