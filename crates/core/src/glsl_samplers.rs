//! Samplers as function parameters, for `glsl.rs`. GLSL lets a function take a `sampler2D`; naga does not (a
//! sampler is a texture and a sampler there, and the rewrite makes one from the two). Such a parameter becomes two
//! (`texture2D _k_pt_s, sampler _k_ps_s`), its uses in the body build the combined sampler again, and a call that
//! passes a sampler passes both halves. The texture types are written as placeholders (`_k_ptype_2D`), which
//! `finish` turns into the real ones once the rest of the rewrite, which would rename `texture2D`, is done.

use std::collections::{HashMap, HashSet};

use crate::glsl::{Kind, Tok, tokenize};
use crate::glsl_cpp::Cpp;

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
/// `_k_sa_maps_0` and `_k_sa_maps_1`. The length is a constant expression (a number, a macro, a `const int`), and so is
/// the index of an element (`maps[1]`, which three.js unrolls its loops to; `maps[I]` with a `const int I`); an index
/// that is not one is refused, naming it. `glsl::sampler_unit` finds the unit of an element.
pub(crate) fn expand_sampler_arrays(src: &str) -> Result<String, String> {
    if !SAMPLERS.iter().any(|(s, _)| src.contains(s)) || !src.contains('[') {
        return Ok(src.to_string());
    }
    let toks = tokenize(src);
    let w = |i: usize| &src[toks[i].start..toks[i].end];
    let mut arrays: HashMap<&str, usize> = HashMap::new();
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    // The macros, and the `const int`s (as macros of their own), of the point a token stands at: the directives are
    // followed up to its line, so a length or an index written with a macro is read as the shader reads it.
    let mut cpp = Cpp::new();
    let mut line_end = 0;
    let (mut depth, mut consts): (usize, Vec<(String, usize)>) = (0, Vec::new());
    for i in 0..toks.len() {
        while line_end <= toks[i].start {
            let line_start = line_end;
            line_end = src[line_start..].find('\n').map_or(src.len(), |n| line_start + n + 1);
            if let Some(directive) = src[line_start..line_end].trim_start().strip_prefix('#') {
                let _ = cpp.directive(directive.trim_end());
            }
        }
        if !cpp.active() {
            continue;
        }
        match w(i) {
            "{" => depth += 1,
            "}" => {
                depth = depth.saturating_sub(1);
                while let Some((name, _)) = consts.pop_if(|(_, d)| *d > depth) {
                    let _ = cpp.directive(&format!("undef {name}"));
                }
            }
            // `const int N = 2 * M;` is a number the index or the length may be written with.
            "const" => {
                let mut k = i + 1;
                while k < toks.len() && matches!(w(k), "highp" | "mediump" | "lowp") {
                    k += 1;
                }
                if k + 3 < toks.len() && matches!(w(k), "int" | "uint") && toks[k + 1].kind == Kind::Ident && w(k + 2) == "=" {
                    if let Some(end) = (k + 3..toks.len()).find(|&e| w(e) == ";") {
                        if end > k + 3 {
                            let name = w(k + 1).to_string();
                            let value = &src[toks[k + 3].start..toks[end - 1].end];
                            if cpp.directive(&format!("define {name} ({value})")).is_ok() {
                                consts.push((name, depth));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        // A declaration: `uniform sampler2D name[length];`.
        if sampler_type(w(i)).is_some()
            && (i.saturating_sub(2)..i).any(|k| w(k) == "uniform")
            && i + 4 < toks.len()
            && toks[i + 1].kind == Kind::Ident
            && w(i + 2) == "["
        {
            let Some(close) = (i + 3..toks.len()).find(|&k| w(k) == "]") else { continue };
            let name = w(i + 1);
            let written = src[toks[i + 3].start..toks[close.max(i + 4) - 1].end].trim();
            let Some(length) = (close > i + 3).then(|| cpp.length(written).parse::<usize>().ok()).flatten() else {
                return Err(format!(
                    "unsupported: the length of the sampler array `{name}` is `{written}`, which is not a constant (a number, a macro or a `const int`)"
                ));
            };
            arrays.insert(name, length);
            if length == 0 {
                // No sampler at all: the whole declaration goes.
                let start = (i.saturating_sub(2)..i).find(|k| w(*k) == "uniform").map_or(toks[i].start, |k| toks[k].start);
                let end = (close..toks.len()).find(|k| w(*k) == ";").map_or(toks[close].end, |k| toks[k].end);
                edits.push((start, end, String::new()));
            } else {
                let elements: Vec<String> = (0..length).map(|k| format!("_k_sa_{name}_{k}")).collect();
                edits.push((toks[i + 1].start, toks[close].end, elements.join(", ")));
            }
            continue;
        }
        // An element: `name[index]`.
        if toks[i].kind != Kind::Ident || i + 1 >= toks.len() || w(i + 1) != "[" || !arrays.contains_key(w(i)) || edits.iter().any(|e| toks[i].start >= e.0 && toks[i].end <= e.1) {
            continue;
        }
        let Some(close) = (i + 2..toks.len()).find(|&k| w(k) == "]") else { continue };
        if close == i + 2 || (i + 2..close).any(|k| w(k) == "[") {
            continue;
        }
        let (name, written) = (w(i), src[toks[i + 2].start..toks[close - 1].end].trim());
        let length = arrays[name];
        match cpp.length(written).parse::<usize>() {
            Ok(k) if k < length => edits.push((toks[i].start, toks[close].end, format!("_k_sa_{name}_{k}"))),
            Ok(k) => return Err(format!("unsupported: `{name}[{k}]` reads past the sampler array `{name}`, which has {length} elements")),
            Err(_) => {
                return Err(format!(
                    "unsupported: the sampler array `{name}` is read with `[{written}]`, which is not a constant (a number, a macro or a `const int`); \
                     GLSL ES 3.00 only reads a sampler array at a constant index, so write the loop out"
                ))
            }
        }
    }
    if arrays.is_empty() {
        return Ok(src.to_string());
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
    Ok(out)
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
