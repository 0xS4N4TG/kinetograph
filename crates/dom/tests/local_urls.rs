//! CSS Values 4, "local URLs": a `url()` that is only a fragment (`url(#id)`) names an element of the document, so it is
//! never fetched as a file, and a page that uses one (a `mask-image` or `filter` reference) has nothing missing.

mod common;

use common::*;

fn missing(style: &str) -> Vec<String> {
    let root = el("div", "$0", "", vec![el("div", "$0.0", style, vec![])]);
    resolve(&request(root)).missing
}

#[test]
fn a_fragment_only_url_is_not_a_missing_file() {
    assert_eq!(missing("width:10px;height:10px;mask-image:url(#m)"), Vec::<String>::new());
}

#[test]
fn a_url_that_names_a_file_that_is_not_there_is_still_missing() {
    assert_eq!(missing("width:10px;height:10px;mask-image:url(nothing.png)").len(), 1);
}
