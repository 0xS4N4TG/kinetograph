//! Samplers as function parameters, for `glsl.rs`. GLSL lets a function take a `sampler2D`; naga does not (a
//! sampler is a texture and a sampler there, and the rewrite makes one from the two). Such a parameter becomes two
//! (`texture2D _k_pt_s, sampler _k_ps_s`), its uses in the body build the combined sampler again, and a call that
//! passes a sampler passes both halves. The texture types are written as placeholders (`_k_ptype_2D`), which
//! `finish` turns into the real ones once the rest of the rewrite, which would rename `texture2D`, is done.

use std::collections::{HashMap, HashSet};

use crate::glsl::{Kind, Tok, tokenize};

/// The sampler types: their texture type's placeholder.
const SAMPLERS: [(&str, &str); 7] = [
    ("sampler2D", "_k_ptype_2D"),
    ("sampler3D", "_k_ptype_3D"),
    ("samplerCube", "_k_ptype_Cube"),
    ("sampler2DArray", "_k_ptype_2DArray"),
    ("sampler2DShadow", "_k_ptype_2D"),
    ("samplerCubeShadow", "_k_ptype_Cube"),
    ("sampler2DArrayShadow", "_k_ptype_2DArray"),
];
const TEXTURES: [(&str, &str); 4] = [
    ("_k_ptype_2D", "texture2D"),
    ("_k_ptype_3D", "texture3D"),
    ("_k_ptype_Cube", "textureCube"),
    ("_k_ptype_2DArray", "texture2DArray"),
];

/// A sampler type as a word of the table, and its texture's placeholder.
fn sampler_type(word: &str) -> Option<(&'static str, &'static str)> {
    SAMPLERS.iter().find(|(s, _)| *s == word).copied()
}

/// A function with sampler parameters: the scope of its body, and the parameters.
struct Scope {
    body: (usize, usize),
    /// Each parameter's sampler type.
    params: HashMap<String, &'static str>,
}

/// Arrays of samplers (`uniform sampler2DShadow maps[2];`, which three.js uses for shadow maps), as separate samplers:
/// `_k_sa_maps_0` and `_k_sa_maps_1`. An element is read by a number (`maps[1]`, which three.js unrolls its loops to);
/// another index is left for naga to refuse. `glsl::sampler_unit` finds the unit of an element.
pub(crate) fn expand_sampler_arrays(src: &str) -> String {
    if !SAMPLERS.iter().any(|(s, _)| src.contains(s)) || !src.contains('[') {
        return src.to_string();
    }
    let toks = tokenize(src);
    let w = |i: usize| &src[toks[i].start..toks[i].end];
    let mut arrays: HashMap<&str, usize> = HashMap::new();
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for i in 1..toks.len().saturating_sub(5) {
        let declared = sampler_type(w(i)).is_some()
            && (i.saturating_sub(2)..i).any(|k| w(k) == "uniform")
            && toks[i + 1].kind == Kind::Ident
            && w(i + 2) == "["
            && toks[i + 3].kind == Kind::Number
            && w(i + 4) == "]";
        if !declared {
            continue;
        }
        let Ok(length) = w(i + 3).parse::<usize>() else { continue };
        let name = w(i + 1);
        arrays.insert(name, length);
        if length == 0 {
            // No sampler at all: the whole declaration goes.
            let start = (i.saturating_sub(2)..i).find(|k| w(*k) == "uniform").map_or(toks[i].start, |k| toks[k].start);
            let end = (i + 5..toks.len()).find(|k| w(*k) == ";").map_or(toks[i + 4].end, |k| toks[k].end);
            edits.push((start, end, String::new()));
        } else {
            let elements: Vec<String> = (0..length).map(|k| format!("_k_sa_{name}_{k}")).collect();
            edits.push((toks[i + 1].start, toks[i + 4].end, elements.join(", ")));
        }
    }
    if arrays.is_empty() {
        return src.to_string();
    }
    for i in 0..toks.len().saturating_sub(3) {
        if toks[i].kind == Kind::Ident
            && w(i + 1) == "["
            && toks[i + 2].kind == Kind::Number
            && w(i + 3) == "]"
            && arrays.contains_key(w(i))
            && !edits.iter().any(|e| toks[i].start >= e.0 && toks[i].end <= e.1)
        {
            if let Ok(k) = w(i + 2).parse::<usize>() {
                edits.push((toks[i].start, toks[i + 3].end, format!("_k_sa_{}_{k}", w(i))));
            }
        }
    }
    edits.sort_by_key(|e| e.0);
    let mut out = String::with_capacity(src.len() + 64);
    let mut last = 0;
    for (start, end, text) in edits {
        out.push_str(&src[last..start]);
        out.push_str(&text);
        last = end;
    }
    out.push_str(&src[last..]);
    out
}

/// `src` with the sampler parameters of its functions lowered; `src` itself when it has none.
pub(crate) fn lower_sampler_parameters(src: &str) -> String {
    if !SAMPLERS.iter().any(|(s, _)| src.contains(s)) {
        return src.to_string();
    }
    let toks = tokenize(src);
    let w = |i: usize| &src[toks[i].start..toks[i].end];
    let matching = |open: usize| -> Option<usize> {
        let (o, c) = match w(open) {
            "(" => ("(", ")"),
            _ => ("{", "}"),
        };
        let mut depth = 0;
        (open..toks.len()).find(|&k| {
            if w(k) == o {
                depth += 1;
            } else if w(k) == c {
                depth -= 1;
            }
            depth == 0
        })
    };

    // The global samplers: `uniform [highp] sampler2D a, b;`.
    let mut globals: HashSet<&str> = HashSet::new();
    for i in 0..toks.len() {
        if sampler_type(w(i)).is_some() && (0..i).rev().take(2).any(|k| w(k) == "uniform") {
            let mut k = i + 1;
            while k < toks.len() && w(k) != ";" {
                if toks[k].kind == Kind::Ident {
                    globals.insert(w(k));
                }
                k += 1;
            }
        }
    }

    // The functions with sampler parameters, and the edits their headers need.
    let mut functions: HashSet<&str> = HashSet::new();
    let mut headers: HashSet<usize> = HashSet::new();
    let mut scopes: Vec<Scope> = Vec::new();
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for i in 1..toks.len().saturating_sub(1) {
        if toks[i].kind != Kind::Ident || w(i + 1) != "(" || toks[i - 1].kind != Kind::Ident {
            continue;
        }
        let Some(close) = matching(i + 1) else { continue };
        // A header is a type, a name and parameters, then `{` or `;`.
        if !matches!(toks.get(close + 1).map(|t| &src[t.start..t.end]), Some("{" | ";")) {
            continue;
        }
        let mut params = HashMap::new();
        let mut k = i + 2;
        while k < close {
            if let (Some((word, texture)), true) = (sampler_type(w(k)), k + 1 < close && toks[k + 1].kind == Kind::Ident) {
                let name = w(k + 1);
                params.insert(name.to_string(), word);
                let kind = if word.ends_with("Shadow") { "_k_psamplerShadow" } else { "_k_psampler" };
                let sampler = format!("{texture} _k_pt_{name}, {kind} _k_ps_{name}");
                edits.push((toks[k].start, toks[k + 1].end, sampler));
                k += 1;
            }
            k += 1;
        }
        if params.is_empty() {
            continue;
        }
        functions.insert(w(i));
        headers.insert(i + 1);
        if w(close + 1) == "{" {
            if let Some(end) = matching(close + 1) {
                scopes.push(Scope {
                    body: (close + 1, end),
                    params,
                });
            }
        }
    }
    if functions.is_empty() {
        return src.to_string();
    }
    // The tokens a parameter edit covers are not edited again.
    let covered: Vec<(usize, usize)> = edits.iter().map(|e| (e.0, e.1)).collect();
    let in_header = |t: &Tok| covered.iter().any(|(a, b)| t.start >= *a && t.end <= *b);
    let scope_of = |i: usize| scopes.iter().find(|s| s.body.0 < i && i < s.body.1);

    // Calls that pass samplers, and bare uses of a parameter in its body.
    let mut done: HashSet<usize> = HashSet::new();
    for i in 0..toks.len().saturating_sub(1) {
        if toks[i].kind != Kind::Ident || w(i + 1) != "(" || !functions.contains(w(i)) || headers.contains(&(i + 1)) {
            continue;
        }
        let Some(close) = matching(i + 1) else { continue };
        let mut k = i + 2;
        while k < close {
            let single = toks[k].kind == Kind::Ident && matches!(w(k + 1), "," | ")") && (k == i + 2 || w(k - 1) == ",");
            if single {
                let name = w(k);
                if scope_of(k).is_some_and(|s| s.params.contains_key(name)) {
                    edits.push((toks[k].start, toks[k].end, format!("_k_pt_{name}, _k_ps_{name}")));
                    done.insert(k);
                } else if globals.contains(name) {
                    edits.push((toks[k].start, toks[k].end, format!("_k_t_{name}, _k_s_{name}")));
                    done.insert(k);
                }
            }
            // Past a nested call's arguments, so they are not read as this call's.
            if w(k) == "(" {
                k = matching(k).unwrap_or(k);
            }
            k += 1;
        }
    }
    for scope in &scopes {
        for k in scope.body.0 + 1..scope.body.1 {
            let Some(word) = (toks[k].kind == Kind::Ident).then(|| scope.params.get(w(k))).flatten() else {
                continue;
            };
            if done.contains(&k) || in_header(&toks[k]) || (k > 0 && w(k - 1) == ".") {
                continue;
            }
            let name = w(k);
            edits.push((toks[k].start, toks[k].end, format!("{word}(_k_pt_{name}, _k_ps_{name})")));
        }
    }

    edits.sort_by_key(|e| e.0);
    let mut out = String::with_capacity(src.len() + 64);
    let mut last = 0;
    for (start, end, text) in edits {
        out.push_str(&src[last..start]);
        out.push_str(&text);
        last = end;
    }
    out.push_str(&src[last..]);
    out
}

/// The placeholders of `lower_sampler_parameters` as the types naga reads.
pub(crate) fn finish(source: &mut String) {
    if !source.contains("_k_p") {
        return;
    }
    for (placeholder, texture) in TEXTURES {
        *source = source.replace(placeholder, texture);
    }
    *source = source.replace("_k_psamplerShadow", "samplerShadow").replace("_k_psampler", "sampler");
}
