//! Uniform blocks (WebGL 2), for `glsl.rs`. The recorder lays a block out as std140 and says where each member is
//! (`GlslProgram::blocks`); this reads the bytes there. naga lays a uniform block out by WGSL's rules, which are not
//! std140's for `mat2`, and Metal packs arrays of scalars tighter than a block's 16 bytes an element, so the block the
//! shader declares is not given to naga. It becomes a carrier, `uvec4 _k_ub<n>[..]`, the bytes as the buffer holds
//! them, and the members are private globals of their real types that `main` fills from the words before the page's
//! own `main` runs: the same road the loose `mat2` and arrays of scalars take. A block with an instance name (`b`)
//! has no struct of its own, which naga could not hold for a `mat2`: `b.member` is read as the global
//! `_k_bi<n>_member` (`instance_member`). The carrier is bound at
//! `BLOCK_BINDING + slot`, the slot being the block's index in the program (GL's block index).

use serde::Deserialize;

/// The first binding of a block in the program's bind group: below it are the loose uniforms (0, 1) and the samplers.
pub const BLOCK_BINDING: u32 = 512;

/// A uniform block as the recorder read it from the shaders.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslBlock {
    pub name: String,
    /// The bytes the members take (`UNIFORM_BLOCK_DATA_SIZE`).
    pub size: u32,
    pub members: Vec<GlslBlockMember>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslBlockMember {
    pub name: String,
    /// A GLSL scalar, vector or matrix type, or the name of a struct (then `fields`).
    #[serde(rename = "type")]
    pub ty: String,
    pub length: Option<u32>,
    /// Bytes from the start of the block, or of the struct element that holds it.
    pub offset: u32,
    /// Bytes between the elements of an array.
    pub stride: Option<u32>,
    pub fields: Option<Vec<GlslBlockMember>>,
}

/// The range of a recorded buffer a draw reads a block from.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslBlockRange {
    pub buffer: String,
    pub offset: u32,
    /// The bytes the binding holds from `offset`; the block reads its own size of them.
    pub size: u32,
}

/// A block a shader declares: its index in the program, and the instance name it gave (`uniform B { .. } b;`).
#[derive(Clone, Debug)]
pub struct UsedBlock {
    pub slot: usize,
    pub instance: Option<String>,
}

impl UsedBlock {
    /// The private variable that holds a member: the member itself, or `b.member` for a block with an instance name.
    fn global(&self, member: &str) -> String {
        match &self.instance {
            Some(_) => format!("_k_bi{}_{member}", self.slot),
            None => member.to_string(),
        }
    }

    /// What `instance.` is read as in the shader's code, when `name` is this block's instance name.
    pub fn instance_prefix(&self, name: &str) -> Option<String> {
        (self.instance.as_deref() == Some(name)).then(|| format!("_k_bi{}_", self.slot))
    }
}

impl GlslBlock {
    /// The bytes of the carrier: the block's size rounded up to a `uvec4`.
    pub fn carrier_size(&self) -> u32 {
        self.size.div_ceil(16).max(1) * 16
    }
}

/// The declarations that stand for `block`: its carrier and the private variables of the members.
pub fn prelude(block: &GlslBlock, used: &UsedBlock) -> String {
    let slot = used.slot;
    let mut text = format!(
        "layout(set=0, binding={}) uniform _KB{slot} {{ uvec4 _k_ub{slot}[{}]; }}; \
         uint _k_w{slot}(int o) {{ return _k_ub{slot}[o / 16][(o % 16) / 4]; }} ",
        BLOCK_BINDING + slot as u32,
        block.carrier_size() / 16
    );
    for m in &block.members {
        let array = m.length.map(|n| format!("[{n}]")).unwrap_or_default();
        text.push_str(&format!("{} {}{array}; ", m.ty, used.global(&m.name)));
    }
    text
}

/// The statements of `main` that fill the block's variables from the carrier.
pub fn loader(block: &GlslBlock, used: &UsedBlock) -> std::result::Result<String, String> {
    let mut out = String::new();
    for m in &block.members {
        assign(used.slot, m, &used.global(&m.name), "0", 0, &mut out)
            .map_err(|e| format!("the uniform block `{}`: {e}", block.name))?;
    }
    Ok(out)
}

/// `dest = ...` for the member at `base` (the start of what holds it): a loop over the elements of an array.
fn assign(
    slot: usize,
    m: &GlslBlockMember,
    dest: &str,
    base: &str,
    depth: usize,
    out: &mut String,
) -> std::result::Result<(), String> {
    let at = format!("{base} + {}", m.offset);
    let Some(n) = m.length else {
        return element(slot, m, dest, &format!("({at})"), depth, out);
    };
    let i = format!("_k_i{depth}");
    let stride = m.stride.unwrap_or(16);
    out.push_str(&format!("for (int {i} = 0; {i} < {n}; {i}++) {{ "));
    element(
        slot,
        m,
        &format!("{dest}[{i}]"),
        &format!("({at} + {i} * {stride})"),
        depth + 1,
        out,
    )?;
    out.push_str("} ");
    Ok(())
}

/// One element of a member, at the byte offset expression `at`: a struct is its fields, anything else a value.
fn element(
    slot: usize,
    m: &GlslBlockMember,
    dest: &str,
    at: &str,
    depth: usize,
    out: &mut String,
) -> std::result::Result<(), String> {
    match &m.fields {
        Some(fields) => {
            for f in fields {
                assign(slot, f, &format!("{dest}.{}", f.name), at, depth, out)?;
            }
        }
        None => out.push_str(&format!("{dest} = {}; ", value(slot, &m.ty, at)?)),
    }
    Ok(())
}

/// A word of the carrier, as a number of the scalar kind (`f`, `i`, `u`, or `b` for a boolean).
fn scalar(slot: usize, kind: char, at: &str, k: u32) -> String {
    let word = format!("_k_w{slot}({at} + {})", 4 * k);
    match kind {
        'f' => format!("uintBitsToFloat({word})"),
        'i' => format!("int({word})"),
        'b' => format!("({word} != 0u)"),
        _ => word,
    }
}

/// The GLSL expression of a value of `ty` at the byte offset expression `at`, std140: a vector's components follow
/// one another, a matrix's columns are 16 bytes apart.
fn value(slot: usize, ty: &str, at: &str) -> std::result::Result<String, String> {
    let kind = |prefix: &str| match prefix {
        "" => 'f',
        "i" => 'i',
        "u" => 'u',
        _ => 'b',
    };
    match ty {
        "float" => return Ok(scalar(slot, 'f', at, 0)),
        "int" => return Ok(scalar(slot, 'i', at, 0)),
        "uint" => return Ok(scalar(slot, 'u', at, 0)),
        "bool" => return Ok(scalar(slot, 'b', at, 0)),
        _ => {}
    }
    for prefix in ["", "i", "u", "b"] {
        let Some(n) = ty
            .strip_prefix(prefix)
            .and_then(|t| t.strip_prefix("vec"))
            .and_then(|n| n.parse::<u32>().ok())
            .filter(|n| (2..=4).contains(n))
        else {
            continue;
        };
        let parts: Vec<String> = (0..n)
            .map(|k| scalar(slot, kind(prefix), at, k))
            .collect();
        return Ok(format!("{ty}({})", parts.join(", ")));
    }
    if let Some(shape) = ty.strip_prefix("mat") {
        let (columns, rows) = match shape.split_once('x') {
            Some((c, r)) => (c.parse::<u32>(), r.parse::<u32>()),
            None => (shape.parse::<u32>(), shape.parse::<u32>()),
        };
        if let (Ok(columns @ 2..=4), Ok(rows @ 2..=4)) = (columns, rows) {
            let cols: Vec<String> = (0..columns)
                .map(|c| {
                    let parts: Vec<String> = (0..rows)
                        .map(|k| scalar(slot, 'f', &format!("({at} + {})", 16 * c), k))
                        .collect();
                    format!("vec{rows}({})", parts.join(", "))
                })
                .collect();
            return Ok(format!("{ty}({})", cols.join(", ")));
        }
    }
    Err(format!("the type `{ty}` has no layout"))
}
