//! One small HTML case per painted feature: the painted scene is rendered on
//! the GPU and compared with Chrome's rendering of the same HTML. The
//! pictures are in `target/paint-tests`.

mod common;

use common::compare;

fn asset(name: &str) -> String {
    format!(
        "file://{}",
        common::repo_root()
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
            println!("{}: unsupported {:?}; diff {:?}", stringify!($name), out.unsupported, diff);
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
