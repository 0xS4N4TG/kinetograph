//! Uniform blocks (WebGL 2) as the recording carries them. The recorder lays a block out as std140 and says where each
//! member is (`GlslProgram::blocks`) and which range of a recorded buffer a draw reads a block from (`GlslDraw::blocks`).

use serde::Deserialize;

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
