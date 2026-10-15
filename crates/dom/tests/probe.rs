mod common;

fn band(img: &image::RgbaImage, y0: u32, y1: u32, xmax: u32) -> (u32, u32, u32, u32) {
    let (mut minx, mut maxx, mut miny, mut maxy) = (999, 0, 999, 0);
    for y in y0..y1 {
        for x in 0..xmax {
            if img.get_pixel(x, y).0[0] < 160 {
                minx = minx.min(x);
                maxx = maxx.max(x);
                miny = miny.min(y);
                maxy = maxy.max(y);
            }
        }
    }
    (minx, maxx, miny, maxy)
}

#[test]
fn probe() {
    for fs in [16u32, 24, 48] {
        let body = format!(r#"<ul style="margin:0;padding-left:60px;font-size:{fs}px"><li>Disc</li></ul>"#);
        let chrome = common::chrome(&format!("probe-list{fs}"), &body, 200, 100).unwrap();
        println!("fs {fs}: {:?}", band(&chrome, 0, 80, 60));
    }
}
