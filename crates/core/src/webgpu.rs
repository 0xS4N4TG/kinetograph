//! WebGPU, native: the render passes a page submitted to its canvas, replayed on the shared wgpu device with the
//! page's own WGSL (packages/cli/skills/kinetograph/references/ENGINE.md, "WebGPU").
//!
//! The authoring side (`navigator.gpu` of `@kinetographdev/scene`) records what a frame drew as the `webgpu` part of
//! a `glsl` layer: modules, bind group layouts, pipelines, buffer contents at the time of the submit, bind groups and
//! the passes. Nothing here reads anything but that, so the layer is a pure function of its recording. This file is the
//! part that needs no GPU: the recording's types and `check`, which reads each module with naga so that a page's
//! mistake is reported when the frame is painted, not found by the GPU. The drawing is in `compositor/webgpu.rs`.

use std::collections::BTreeMap;

use serde::Deserialize;

/// What a WebGPU canvas drew: every id below is a key of the table of its kind.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebGpuContent {
    /// WGSL, by id.
    #[serde(default)]
    pub modules: BTreeMap<String, String>,
    #[serde(default)]
    pub layouts: BTreeMap<String, Vec<BindingLayout>>,
    #[serde(default)]
    pub pipelines: BTreeMap<String, Pipeline>,
    /// Base64 bytes, by id.
    #[serde(default)]
    pub buffers: BTreeMap<String, String>,
    #[serde(default)]
    pub bind_groups: BTreeMap<String, BindGroup>,
    #[serde(default)]
    pub passes: Vec<Pass>,
    /// Calls the page made that are not drawn.
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingLayout {
    pub binding: u32,
    /// `GPUShaderStage` bits.
    pub visibility: u32,
    /// `uniform`, `storage` or `read-only-storage`.
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(default)]
    pub dynamic_offset: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VertexAttribute {
    pub format: String,
    pub offset: u64,
    pub location: u32,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VertexLayout {
    pub stride: u64,
    #[serde(default)]
    pub step_mode: Option<String>,
    #[serde(default)]
    pub attributes: Vec<VertexAttribute>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlendComponent {
    pub operation: Option<String>,
    pub src_factor: Option<String>,
    pub dst_factor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlendState {
    pub color: BlendComponent,
    pub alpha: BlendComponent,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub format: String,
    #[serde(default)]
    pub blend: Option<BlendState>,
    #[serde(default)]
    pub write_mask: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VertexState {
    pub module: String,
    pub entry_point: Option<String>,
    #[serde(default)]
    pub buffers: Vec<VertexLayout>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FragmentState {
    pub module: String,
    pub entry_point: Option<String>,
    #[serde(default)]
    pub targets: Vec<Option<Target>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Primitive {
    pub topology: String,
    pub strip_index_format: Option<String>,
    pub front_face: String,
    pub cull_mode: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pipeline {
    /// Ids of `WebGpuContent::layouts`; none for `layout: 'auto'`.
    pub layout: Option<Vec<String>>,
    pub vertex: VertexState,
    pub fragment: Option<FragmentState>,
    pub primitive: Primitive,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindEntry {
    pub binding: u32,
    pub buffer: String,
    pub offset: u64,
    pub size: u64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindGroup {
    /// An id of `WebGpuContent::layouts`, or `auto:<pipeline>:<index>`.
    pub layout: String,
    #[serde(default)]
    pub entries: Vec<BindEntry>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "c", rename_all = "camelCase")]
pub enum Command {
    Pipeline {
        id: String,
    },
    Bind {
        index: u32,
        group: String,
        #[serde(default)]
        offsets: Vec<u32>,
    },
    Vertex {
        slot: u32,
        buffer: String,
        #[serde(default)]
        offset: u64,
        size: Option<u64>,
    },
    Index {
        buffer: String,
        format: String,
        #[serde(default)]
        offset: u64,
        size: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Draw {
        vertices: u32,
        instances: u32,
        first: u32,
        first_instance: u32,
    },
    #[serde(rename_all = "camelCase")]
    DrawIndexed {
        indices: u32,
        instances: u32,
        first: u32,
        base: i32,
        first_instance: u32,
    },
    #[serde(rename_all = "camelCase")]
    Viewport {
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        min_depth: f32,
        max_depth: f32,
    },
    Scissor {
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    },
    Blend {
        color: [f64; 4],
    },
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pass {
    /// The clear colour; none loads what the canvas holds.
    pub clear: Option<[f64; 4]>,
    #[serde(default)]
    pub commands: Vec<Command>,
}

/// Reads every module of the recording with naga. Returns what is wrong with each, as `module id: message`, for the
/// painter to report; a layer with a module that is wrong draws nothing.
pub fn check(content: &WebGpuContent) -> Vec<String> {
    let mut problems = Vec::new();
    for (id, code) in &content.modules {
        if let Err(message) = parse(code) {
            problems.push(format!("WGSL module {id}: {message}"));
        }
    }
    problems
}

/// A module read and validated.
pub fn parse(code: &str) -> Result<naga::Module, String> {
    let module = naga::front::wgsl::parse_str(code).map_err(|e| e.emit_to_string(code))?;
    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    )
    .validate(&module)
    .map_err(|e| e.emit_to_string(code))?;
    Ok(module)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRIANGLE: &str = "@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { \
        let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); } \
        @fragment fn fs() -> @location(0) vec4f { return vec4f(1, 0, 0, 1); }";

    #[test]
    fn a_valid_module_passes_and_a_broken_one_is_named() {
        let mut content = WebGpuContent::default();
        content.modules.insert("mgood".into(), TRIANGLE.into());
        assert!(check(&content).is_empty());
        content.modules.insert("mbad".into(), "fn x( { }".into());
        let problems = check(&content);
        assert_eq!(problems.len(), 1);
        assert!(problems[0].starts_with("WGSL module mbad:"), "{problems:?}");
    }

    #[test]
    fn the_recording_parses_from_the_page_side_json() {
        let json = r#"{"modules":{"m1":"x"},"layouts":{"l1":[{"binding":0,"visibility":7,"type":"uniform"}]},
            "pipelines":{"p1":{"layout":["l1"],"vertex":{"module":"m1","buffers":[]},
            "fragment":{"module":"m1","targets":[{"format":"rgba8unorm"}]},
            "primitive":{"topology":"triangle-list","frontFace":"ccw","cullMode":"none"}}},
            "buffers":{"b1":"AAAA"},"bindGroups":{"g1":{"layout":"l1","entries":[{"binding":0,"buffer":"b1","offset":0,"size":3}]}},
            "passes":[{"clear":[0,0,0,0],"commands":[{"c":"pipeline","id":"p1"},{"c":"bind","index":0,"group":"g1"},
            {"c":"draw","vertices":3,"instances":1,"first":0,"firstInstance":0}]}]}"#;
        let content: WebGpuContent = serde_json::from_str(json).unwrap();
        assert_eq!(content.passes[0].commands.len(), 3);
    }
}
