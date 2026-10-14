//! Custom WGSL effects: the module the engine builds around a scene's
//! `effect` function, and the CPU check that it is valid.
//!
//! The scene supplies `fn effect(px: vec2<f32>) -> vec4<f32>`. The engine
//! puts a prelude before it (the layer texture, the frame clock, the named
//! uniforms) and the entry points after it. docs/SCENE.md describes what the
//! prelude gives the user's code.

use naga::{Module, Scalar, TypeInner, VectorSize};

use crate::error::{Error, Result};

/// The names the engine declares around the user's code.
const PRELUDE: &str = "\
struct Globals {
    canvas: vec2<f32>,
    frame: f32,
    time: f32,
    margin: f32,
}
@group(0) @binding(0) var kg_layer_tex: texture_2d<f32>;
@group(0) @binding(1) var kg_layer_smp: sampler;
@group(0) @binding(2) var<uniform> globals: Globals;
@group(0) @binding(3) var<uniform> u: U;
fn layer(px: vec2<f32>) -> vec4<f32> {
    let uv = (px + vec2<f32>(globals.margin)) / vec2<f32>(textureDimensions(kg_layer_tex));
    if any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0)) {
        return vec4<f32>(0.0);
    }
    return textureSampleLevel(kg_layer_tex, kg_layer_smp, uv, 0.0);
}
";

const ENTRY_POINTS: &str = "\
@vertex
fn kg_vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32(i32(i) / 2) * 4.0 - 1.0;
    let y = f32(i32(i) % 2) * 4.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}
@fragment
fn kg_fs(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    return effect(p.xy - vec2<f32>(globals.margin));
}
";

/// The prelude for a shader with these uniforms: `PRELUDE` and the `U`
/// struct, which has one `f32` per name, in the order given, on one line.
/// `U` cannot be empty in WGSL, so a shader with no uniforms gets a field
/// nobody names.
fn prelude(names: &[&str]) -> String {
    let fields = if names.is_empty() {
        "kg_unused: f32".to_string()
    } else {
        names
            .iter()
            .map(|n| format!("{n}: f32"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    format!("struct U {{ {fields} }}\n{PRELUDE}")
}

/// The whole WGSL module for a shader: prelude, the user's `code`, then the
/// vertex and fragment entry points. `names` are the uniform names in the
/// order their values are packed.
pub fn compose(code: &str, names: &[&str]) -> String {
    format!("{}{code}\n{ENTRY_POINTS}", prelude(names))
}

/// Checks a scene's shader the way the GPU driver will, on the CPU. The
/// error names the layer, and for WGSL errors gives `line:column` within
/// `code`.
pub fn validate(id: &str, code: &str, names: &[&str]) -> Result<()> {
    let bad = |msg: String| Err(Error::Scene(format!("layer {id:?}: shader {msg}")));
    for name in names {
        if !is_identifier(name) {
            return bad(format!(
                "uniform name {name:?} is not a valid WGSL identifier (letters, digits and \
                 underscores, not starting with a digit, and not a WGSL keyword)"
            ));
        }
    }

    // The user's code and what comes before it; the entry points come after
    // `effect` has been found, so a missing `effect` is reported as that and
    // not as an undefined name in code the user did not write.
    let prelude = prelude(names);
    let source = format!("{prelude}{code}");
    let first_line = prelude.matches('\n').count();
    let at = |line: u32, column: u32| match (line as usize).checked_sub(first_line) {
        Some(line) if line > 0 => format!("code {line}:{column}"),
        _ => "prelude".to_string(),
    };

    let module = naga::front::wgsl::parse_str(&source).map_err(|e| {
        let place = e
            .location(&source)
            .map(|l| at(l.line_number, l.line_position));
        wgsl_error(id, place, e.message().to_string())
    })?;
    let mut validator = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::default(),
    );
    validator.validate(&module).map_err(|e| {
        let place = e
            .location(&source)
            .map(|l| at(l.line_number, l.line_position));
        wgsl_error(id, place, error_chain(&e))
    })?;
    if !module.entry_points.is_empty() {
        return bad(
            "must not declare entry points (@vertex, @fragment, @compute); the engine adds them"
                .into(),
        );
    }
    let own_binding = module.global_variables.iter().any(|(_, v)| {
        let engines = ["kg_layer_tex", "kg_layer_smp", "globals", "u"];
        v.binding.is_some() && !v.name.as_deref().is_some_and(|n| engines.contains(&n))
    });
    if own_binding {
        return bad(
            "must not declare bindings of its own (@group, @binding); the engine's are \
                    listed in docs/SCENE.md"
                .into(),
        );
    }
    check_effect_function(&module).or_else(bad)?;

    // With the entry points on, as the GPU gets it. Nothing here can fail
    // unless the engine's own text is wrong.
    let full = compose(code, names);
    let module = naga::front::wgsl::parse_str(&full)
        .map_err(|e| Error::Scene(format!("layer {id:?}: shader module: {}", e.message())))?;
    validator
        .validate(&module)
        .map_err(|e| Error::Scene(format!("layer {id:?}: shader module: {}", error_chain(&e))))?;
    Ok(())
}

fn wgsl_error(id: &str, place: Option<String>, message: String) -> Error {
    match place {
        Some(place) => Error::Scene(format!("layer {id:?}: shader {place}: {message}")),
        None => Error::Scene(format!("layer {id:?}: shader: {message}")),
    }
}

/// An error and the errors under it, which naga splits across `source()`.
fn error_chain(error: &(dyn std::error::Error + 'static)) -> String {
    let mut text = error.to_string();
    let mut next = error.source();
    while let Some(inner) = next {
        text.push_str(": ");
        text.push_str(&inner.to_string());
        next = inner.source();
    }
    text
}

/// A letter or underscore, then letters, digits and underscores, that WGSL
/// accepts as a struct member name (so not a keyword or reserved word).
fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    let shape = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    shape && naga::front::wgsl::parse_str(&format!("struct T {{ {name}: f32 }}")).is_ok()
}

/// `effect` must exist and take one `vec2<f32>` and return a `vec4<f32>`.
fn check_effect_function(module: &Module) -> std::result::Result<(), String> {
    const WANT: &str = "`fn effect(px: vec2<f32>) -> vec4<f32>`";
    let vector = |ty, size| {
        matches!(
            module.types[ty].inner,
            TypeInner::Vector { size: s, scalar: Scalar::F32 } if s == size
        )
    };
    let Some(effect) = module
        .functions
        .iter()
        .map(|(_, f)| f)
        .find(|f| f.name.as_deref() == Some("effect"))
    else {
        return Err(format!(
            "must define {WANT}, and there is no function named effect"
        ));
    };
    let takes_vec2 = matches!(&effect.arguments[..], [a] if vector(a.ty, VectorSize::Bi));
    let returns_vec4 = effect
        .result
        .as_ref()
        .is_some_and(|r| vector(r.ty, VectorSize::Quad));
    if !(takes_vec2 && returns_vec4) {
        return Err(format!(
            "has the wrong signature for effect: it must be {WANT}, taking one vec2<f32> and \
             returning a vec4<f32>"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY: &str = "fn effect(px: vec2<f32>) -> vec4<f32> {\n    return layer(px);\n}";

    fn message(code: &str, names: &[&str]) -> String {
        match validate("fx", code, names) {
            Ok(()) => panic!("expected an error for {code:?}"),
            Err(e) => e.to_string(),
        }
    }

    #[test]
    fn a_valid_shader_passes() {
        validate("fx", IDENTITY, &[]).unwrap();
        let code = "fn effect(px: vec2<f32>) -> vec4<f32> {\n\
                    let t = globals.time + globals.frame + globals.canvas.x + u.strength;\n\
                    return layer(px + vec2<f32>(t, u.amount)) * 0.5;\n}";
        validate("fx", code, &["amount", "strength"]).unwrap();
    }

    #[test]
    fn compose_puts_the_uniforms_in_the_given_order() {
        let module = compose(IDENTITY, &["b", "a"]);
        assert!(module.starts_with("struct U { b: f32, a: f32 }\n"));
        assert!(module.contains(IDENTITY));
        assert!(module.ends_with(ENTRY_POINTS));
        // No uniforms still leaves the struct non-empty.
        assert!(compose(IDENTITY, &[]).starts_with("struct U { kg_unused: f32 }"));
    }

    #[test]
    fn syntax_errors_say_where_in_the_users_code() {
        // The error is on line 2 of the user's code, not of the module.
        let code = "fn effect(px: vec2<f32>) -> vec4<f32> {\n    return vec4<f32>(1.0, 0.0;\n}";
        let msg = message(code, &[]);
        assert!(msg.contains("layer \"fx\""), "{msg}");
        assert!(msg.contains("shader code 2:"), "{msg}");
    }

    #[test]
    fn type_errors_say_where_in_the_users_code() {
        let code = "fn effect(px: vec2<f32>) -> vec4<f32> {\n\n    let c: f32 = vec3<f32>(1.0);\n    return layer(px);\n}";
        let msg = message(code, &[]);
        assert!(
            msg.contains("layer \"fx\"") && msg.contains("shader code 3:"),
            "{msg}"
        );
    }

    #[test]
    fn an_unknown_name_is_reported_with_its_position() {
        let code = "fn effect(px: vec2<f32>) -> vec4<f32> {\n    return missing(px);\n}";
        let msg = message(code, &[]);
        assert!(msg.contains("shader code 2:"), "{msg}");
        // Uniforms that were not declared are unknown too.
        let code = "fn effect(px: vec2<f32>) -> vec4<f32> {\n    return layer(px) * u.nope;\n}";
        assert!(message(code, &["strength"]).contains("shader code 2:"));
    }

    #[test]
    fn a_missing_effect_function_is_named() {
        let msg = message(
            "fn other(px: vec2<f32>) -> vec4<f32> { return layer(px); }",
            &[],
        );
        assert!(msg.contains("layer \"fx\""), "{msg}");
        assert!(
            msg.contains("fn effect(px: vec2<f32>) -> vec4<f32>"),
            "{msg}"
        );
        assert!(msg.contains("no function named effect"), "{msg}");
    }

    #[test]
    fn a_wrong_signature_is_named() {
        for code in [
            "fn effect() -> vec4<f32> { return vec4<f32>(0.0); }",
            "fn effect(px: vec2<f32>) -> vec3<f32> { return vec3<f32>(0.0); }",
            "fn effect(px: vec3<f32>) -> vec4<f32> { return vec4<f32>(0.0); }",
            "fn effect(px: vec2<f32>, t: f32) -> vec4<f32> { return vec4<f32>(0.0); }",
            "fn effect(px: vec2<f32>) { }",
            "fn effect(px: vec2<i32>) -> vec4<f32> { return vec4<f32>(0.0); }",
        ] {
            let msg = message(code, &[]);
            assert!(msg.contains("wrong signature"), "{code}: {msg}");
            assert!(msg.contains("layer \"fx\""), "{msg}");
        }
        // vec2f and vec4f are the same types.
        validate(
            "fx",
            "fn effect(px: vec2f) -> vec4f { return layer(px); }",
            &[],
        )
        .unwrap();
    }

    #[test]
    fn bad_uniform_names_are_rejected() {
        for name in [
            "",
            "two words",
            "9lives",
            "a-b",
            "fn",
            "let",
            "x: f32, y",
            "naïve",
            "_",
        ] {
            let msg = message(IDENTITY, &[name]);
            assert!(
                msg.contains("layer \"fx\"") && msg.contains("uniform name"),
                "{name:?}: {msg}"
            );
        }
        validate("fx", IDENTITY, &["_under", "camelCase", "a1"]).unwrap();
    }

    #[test]
    fn entry_points_are_the_engines() {
        let code = "@fragment\nfn main() -> @location(0) vec4<f32> { return vec4<f32>(0.0); }\n\
                    fn effect(px: vec2<f32>) -> vec4<f32> { return layer(px); }";
        assert!(message(code, &[]).contains("entry points"));
    }

    #[test]
    fn bindings_are_the_engines() {
        let code = format!("@group(0) @binding(4) var<uniform> extra: vec4<f32>;\n{IDENTITY}");
        assert!(message(&code, &[]).contains("bindings of its own"));
        // Private globals and constants are fine.
        let code = format!("var<private> counter: f32;\nconst K: f32 = 2.0;\n{IDENTITY}");
        validate("fx", &code, &[]).unwrap();
    }

    #[test]
    fn errors_name_what_the_user_redeclared() {
        // `layer` is the prelude's; redefining it is an error in the user's code.
        let code = format!(
            "fn layer(px: vec2<f32>) -> vec4<f32> {{ return vec4<f32>(0.0); }}\n{IDENTITY}"
        );
        let msg = message(&code, &[]);
        assert!(msg.contains("shader code 1:"), "{msg}");
    }
}
