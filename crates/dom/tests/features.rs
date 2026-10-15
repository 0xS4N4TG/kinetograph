//! One small HTML case per painted feature: the painted scene is rendered on
//! the GPU and compared with Chrome's rendering of the same HTML. The
//! pictures are in `target/paint-tests`.

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
            let (out, _frame, diff) = compare(stringify!($name), &body, $w, $h);
            println!(
                "{}: unsupported {:?}; diff {:?}",
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
