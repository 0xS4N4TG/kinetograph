//! ANGLE as a library: `libEGL` and `libGLESv2` loaded at run time, an offscreen OpenGL ES 3.0 context with ANGLE's
//! WebGL compatibility on, and the GL entry points a replay needs (`angle_replay.rs`): the only WebGL replay. When the
//! libraries do not load or start, a WebGL layer is an error saying why (`angle_select.rs` has the device rules);
//! `KINETOGRAPH_ANGLE_DIR` is the folder holding the two libraries.
//!
//! All `unsafe` of the ANGLE path is here. The invariants, once: the libraries are loaded for the life of the
//! process (a `Library` kept beside the pointers taken from it), every pointer is checked non-null when it is
//! loaded, a context is current on one thread only (it is a `thread_local`), and every wrapper that takes bytes
//! takes a slice and passes its length, so GL reads or writes within it.

use std::cell::RefCell;
use std::ffi::{CString, c_char, c_void};
use std::path::PathBuf;

use libloading::Library;

use crate::angle_select::{self as select, Device};

pub type Enum = u32;

// EGL
const EGL_PLATFORM_ANGLE_ANGLE: Enum = 0x3202;
const EGL_PLATFORM_ANGLE_TYPE: isize = 0x3203;
const EGL_PLATFORM_ANGLE_TYPE_METAL: isize = 0x3489;
const EGL_PLATFORM_ANGLE_TYPE_VULKAN: isize = 0x3450;
const EGL_PLATFORM_ANGLE_TYPE_D3D11: isize = 0x3208;
const EGL_NONE: i32 = 0x3038;
// Context attributes, with the values in the ANGLE extension specs (EGL_ANGLE_create_context_webgl_compatibility,
// _client_arrays, _extensions_enabled, EGL_ANGLE_robust_resource_initialization) and the EGL 1.5 headers.
const EGL_CONTEXT_MAJOR_VERSION: i32 = 0x3098;
const EGL_CONTEXT_MINOR_VERSION: i32 = 0x30FB;
const EGL_CONTEXT_WEBGL_COMPATIBILITY_ANGLE: i32 = 0x33AC;
const EGL_CONTEXT_CLIENT_ARRAYS_ENABLED_ANGLE: i32 = 0x3452;
const EGL_ROBUST_RESOURCE_INITIALIZATION_ANGLE: i32 = 0x3453;
const EGL_EXTENSIONS_ENABLED_ANGLE: i32 = 0x345F;
const EGL_OPENGL_ES_API: Enum = 0x30A0;

// GL, the ones the replay names.
pub mod gl {
    use super::Enum;
    pub const FALSE: u8 = 0;
    pub const DEPTH_BUFFER_BIT: Enum = 0x100;
    pub const STENCIL_BUFFER_BIT: Enum = 0x400;
    pub const COLOR_BUFFER_BIT: Enum = 0x4000;
    pub const POINTS: Enum = 0;
    pub const LINES: Enum = 1;
    pub const LINE_LOOP: Enum = 2;
    pub const LINE_STRIP: Enum = 3;
    pub const TRIANGLES: Enum = 4;
    pub const TRIANGLE_STRIP: Enum = 5;
    pub const TRIANGLE_FAN: Enum = 6;
    pub const BLEND: Enum = 0xBE2;
    pub const CULL_FACE: Enum = 0xB44;
    pub const DEPTH_TEST: Enum = 0xB71;
    pub const STENCIL_TEST: Enum = 0xB90;
    pub const SCISSOR_TEST: Enum = 0xC11;
    pub const POLYGON_OFFSET_FILL: Enum = 0x8037;
    pub const SAMPLE_ALPHA_TO_COVERAGE: Enum = 0x809E;
    pub const BYTE: Enum = 0x1400;
    pub const UNSIGNED_BYTE: Enum = 0x1401;
    pub const SHORT: Enum = 0x1402;
    pub const UNSIGNED_SHORT: Enum = 0x1403;
    pub const INT: Enum = 0x1404;
    pub const UNSIGNED_INT: Enum = 0x1405;
    pub const FLOAT: Enum = 0x1406;
    pub const HALF_FLOAT: Enum = 0x140B;
    pub const FRONT: Enum = 0x404;
    pub const BACK: Enum = 0x405;
    pub const FRONT_AND_BACK: Enum = 0x408;
    pub const DEPTH_COMPONENT: Enum = 0x1902;
    pub const RGBA: Enum = 0x1908;
    pub const RED: Enum = 0x1903;
    pub const RG: Enum = 0x8227;
    pub const DEPTH_STENCIL: Enum = 0x84F9;
    pub const UNSIGNED_INT_24_8: Enum = 0x84FA;
    pub const RGBA8: Enum = 0x8058;
    pub const SRGB8_ALPHA8: Enum = 0x8C43;
    pub const R8: Enum = 0x8229;
    pub const RG8: Enum = 0x822B;
    pub const R16F: Enum = 0x822D;
    pub const RG16F: Enum = 0x822F;
    pub const RGBA16F: Enum = 0x881A;
    pub const R32F: Enum = 0x822E;
    pub const RG32F: Enum = 0x8230;
    pub const RGBA32F: Enum = 0x8814;
    pub const DEPTH_COMPONENT24: Enum = 0x81A6;
    pub const DEPTH24_STENCIL8: Enum = 0x88F0;
    pub const STENCIL_INDEX8: Enum = 0x8D48;
    pub const TEXTURE_2D: Enum = 0xDE1;
    pub const TEXTURE_3D: Enum = 0x806F;
    pub const TEXTURE_2D_ARRAY: Enum = 0x8C1A;
    pub const TEXTURE_CUBE_MAP: Enum = 0x8513;
    pub const TEXTURE_CUBE_MAP_POSITIVE_X: Enum = 0x8515;
    pub const TEXTURE_WRAP_R: Enum = 0x8072;
    pub const TEXTURE0: Enum = 0x84C0;
    pub const TEXTURE_MAG_FILTER: Enum = 0x2800;
    pub const TEXTURE_MIN_FILTER: Enum = 0x2801;
    pub const TEXTURE_WRAP_S: Enum = 0x2802;
    pub const TEXTURE_WRAP_T: Enum = 0x2803;
    pub const TEXTURE_BASE_LEVEL: Enum = 0x813C;
    pub const TEXTURE_SWIZZLE_G: Enum = 0x8E43;
    pub const TEXTURE_SWIZZLE_B: Enum = 0x8E44;
    pub const TEXTURE_MAX_LEVEL: Enum = 0x813D;
    pub const TEXTURE_COMPARE_MODE: Enum = 0x884C;
    pub const TEXTURE_COMPARE_FUNC: Enum = 0x884D;
    pub const COMPARE_REF_TO_TEXTURE: i32 = 0x884E;
    pub const ARRAY_BUFFER: Enum = 0x8892;
    pub const ELEMENT_ARRAY_BUFFER: Enum = 0x8893;
    pub const UNIFORM_BUFFER: Enum = 0x8A11;
    pub const STATIC_DRAW: Enum = 0x88E4;
    pub const FRAGMENT_SHADER: Enum = 0x8B30;
    pub const VERTEX_SHADER: Enum = 0x8B31;
    pub const COMPILE_STATUS: Enum = 0x8B81;
    pub const LINK_STATUS: Enum = 0x8B82;
    pub const ACTIVE_UNIFORMS: Enum = 0x8B86;
    pub const ACTIVE_ATTRIBUTES: Enum = 0x8B89;
    pub const FRAMEBUFFER: Enum = 0x8D40;
    pub const READ_FRAMEBUFFER: Enum = 0x8CA8;
    pub const DRAW_FRAMEBUFFER: Enum = 0x8CA9;
    pub const RENDERBUFFER: Enum = 0x8D41;
    pub const COLOR_ATTACHMENT0: Enum = 0x8CE0;
    pub const DEPTH_ATTACHMENT: Enum = 0x8D00;
    pub const STENCIL_ATTACHMENT: Enum = 0x8D20;
    pub const DEPTH_STENCIL_ATTACHMENT: Enum = 0x821A;
    pub const FRAMEBUFFER_COMPLETE: Enum = 0x8CD5;
    pub const NONE: Enum = 0;
    pub const NEAREST: Enum = 0x2600;
}

macro_rules! entry_points {
    ($($name:ident = $gl:literal ($($arg:ident: $ty:ty),*) $(-> $ret:ty)?;)*) => {
        /// The GL entry points, by `eglGetProcAddress`.
        struct Raw { $($name: unsafe extern "C" fn($($ty),*) $(-> $ret)?,)* }
        impl Raw {
            fn load(lookup: &dyn Fn(&str) -> *const c_void) -> Result<Raw, String> {
                Ok(Raw { $($name: {
                    let p = lookup($gl);
                    if p.is_null() { return Err(format!("ANGLE has no {}", $gl)); }
                    // SAFETY: `p` is the address of the GL function `$gl`, which has this signature in the GL ES 3.0
                    // headers; a function pointer and a data pointer have the same size.
                    unsafe { std::mem::transmute::<*const c_void, unsafe extern "C" fn($($ty),*) $(-> $ret)?>(p) }
                },)* })
            }
        }
        impl Gl {
            $(
                #[allow(clippy::too_many_arguments, dead_code)]
                pub fn $name(&self, $($arg: $ty),*) $(-> $ret)? {
                    // SAFETY: a scalar-argument call into the current context (this thread's, see `with`).
                    unsafe { (self.raw.$name)($($arg),*) }
                }
            )*
        }
    };
}

/// The current context's GL. Methods are the GL functions with scalar arguments; the ones that take bytes are
/// written by hand below, over slices.
pub struct Gl {
    raw: Raw,
    ptr: RawPtr,
}

entry_points! {
    get_error = "glGetError"() -> Enum;
    enable = "glEnable"(cap: Enum);
    disable = "glDisable"(cap: Enum);
    viewport = "glViewport"(x: i32, y: i32, w: i32, h: i32);
    scissor = "glScissor"(x: i32, y: i32, w: i32, h: i32);
    clear_color = "glClearColor"(r: f32, g: f32, b: f32, a: f32);
    clear_depthf = "glClearDepthf"(d: f32);
    clear_stencil = "glClearStencil"(s: i32);
    clear = "glClear"(mask: u32);
    color_mask = "glColorMask"(r: u8, g: u8, b: u8, a: u8);
    depth_mask = "glDepthMask"(m: u8);
    depth_func = "glDepthFunc"(f: Enum);
    depth_rangef = "glDepthRangef"(n: f32, f: f32);
    stencil_func_separate = "glStencilFuncSeparate"(face: Enum, func: Enum, r: i32, mask: u32);
    stencil_op_separate = "glStencilOpSeparate"(face: Enum, fail: Enum, zfail: Enum, zpass: Enum);
    stencil_mask_separate = "glStencilMaskSeparate"(face: Enum, mask: u32);
    blend_func_separate = "glBlendFuncSeparate"(a: Enum, b: Enum, c: Enum, d: Enum);
    blend_equation_separate = "glBlendEquationSeparate"(a: Enum, b: Enum);
    blend_color = "glBlendColor"(r: f32, g: f32, b: f32, a: f32);
    cull_face = "glCullFace"(mode: Enum);
    front_face = "glFrontFace"(mode: Enum);
    polygon_offset = "glPolygonOffset"(factor: f32, units: f32);
    bind_buffer = "glBindBuffer"(target: Enum, buffer: u32);
    bind_vertex_array = "glBindVertexArray"(vao: u32);
    enable_vertex_attrib_array = "glEnableVertexAttribArray"(i: u32);
    disable_vertex_attrib_array = "glDisableVertexAttribArray"(i: u32);
    vertex_attrib_divisor = "glVertexAttribDivisor"(i: u32, d: u32);
    vertex_attrib4f = "glVertexAttrib4f"(i: u32, x: f32, y: f32, z: f32, w: f32);
    vertex_attrib_i4i = "glVertexAttribI4i"(i: u32, x: i32, y: i32, z: i32, w: i32);
    vertex_attrib_i4ui = "glVertexAttribI4ui"(i: u32, x: u32, y: u32, z: u32, w: u32);
    create_shader = "glCreateShader"(kind: Enum) -> u32;
    compile_shader = "glCompileShader"(s: u32);
    delete_shader = "glDeleteShader"(s: u32);
    create_program = "glCreateProgram"() -> u32;
    attach_shader = "glAttachShader"(p: u32, s: u32);
    link_program = "glLinkProgram"(p: u32);
    use_program = "glUseProgram"(p: u32);
    delete_program = "glDeleteProgram"(p: u32);
    uniform_block_binding = "glUniformBlockBinding"(p: u32, index: u32, binding: u32);
    bind_buffer_range = "glBindBufferRange"(target: Enum, index: u32, buffer: u32, offset: isize, size: isize);
    bind_texture = "glBindTexture"(target: Enum, texture: u32);
    active_texture = "glActiveTexture"(unit: Enum);
    tex_storage_2d = "glTexStorage2D"(target: Enum, levels: i32, format: Enum, w: i32, h: i32);
    tex_storage_3d = "glTexStorage3D"(target: Enum, levels: i32, format: Enum, w: i32, h: i32, d: i32);
    framebuffer_texture_layer = "glFramebufferTextureLayer"(target: Enum, attachment: Enum, texture: u32, level: i32, layer: i32);
    bind_sampler = "glBindSampler"(unit: u32, sampler: u32);
    sampler_parameteri = "glSamplerParameteri"(sampler: u32, name: Enum, v: i32);
    tex_parameteri = "glTexParameteri"(target: Enum, name: Enum, v: i32);
    generate_mipmap = "glGenerateMipmap"(target: Enum);
    bind_renderbuffer = "glBindRenderbuffer"(target: Enum, rb: u32);
    renderbuffer_storage_multisample = "glRenderbufferStorageMultisample"(target: Enum, samples: i32, format: Enum, w: i32, h: i32);
    bind_framebuffer = "glBindFramebuffer"(target: Enum, fb: u32);
    framebuffer_texture_2d = "glFramebufferTexture2D"(target: Enum, attachment: Enum, textarget: Enum, texture: u32, level: i32);
    framebuffer_renderbuffer = "glFramebufferRenderbuffer"(target: Enum, attachment: Enum, rbtarget: Enum, rb: u32);
    check_framebuffer_status = "glCheckFramebufferStatus"(target: Enum) -> Enum;
    read_buffer = "glReadBuffer"(src: Enum);
    blit_framebuffer = "glBlitFramebuffer"(sx0: i32, sy0: i32, sx1: i32, sy1: i32, dx0: i32, dy0: i32, dx1: i32, dy1: i32, mask: u32, filter: Enum);
    draw_arrays = "glDrawArrays"(mode: Enum, first: i32, count: i32);
    draw_arrays_instanced = "glDrawArraysInstanced"(mode: Enum, first: i32, count: i32, instances: i32);
    pixel_storei = "glPixelStorei"(name: Enum, v: i32);
    finish = "glFinish"();
}

/// Entry points whose arguments are pointers: the `Raw` fields are loaded by hand.
struct RawPtr {
    gen_buffers: unsafe extern "C" fn(i32, *mut u32),
    delete_buffers: unsafe extern "C" fn(i32, *const u32),
    buffer_data: unsafe extern "C" fn(Enum, isize, *const c_void, Enum),
    gen_vertex_arrays: unsafe extern "C" fn(i32, *mut u32),
    delete_vertex_arrays: unsafe extern "C" fn(i32, *const u32),
    vertex_attrib_pointer: unsafe extern "C" fn(u32, i32, Enum, u8, i32, usize),
    vertex_attrib_ipointer: unsafe extern "C" fn(u32, i32, Enum, i32, usize),
    shader_source: unsafe extern "C" fn(u32, i32, *const *const c_char, *const i32),
    get_shaderiv: unsafe extern "C" fn(u32, Enum, *mut i32),
    get_shader_info_log: unsafe extern "C" fn(u32, i32, *mut i32, *mut c_char),
    bind_attrib_location: unsafe extern "C" fn(u32, u32, *const c_char),
    get_programiv: unsafe extern "C" fn(u32, Enum, *mut i32),
    get_program_info_log: unsafe extern "C" fn(u32, i32, *mut i32, *mut c_char),
    get_attrib_location: unsafe extern "C" fn(u32, *const c_char) -> i32,
    get_uniform_location: unsafe extern "C" fn(u32, *const c_char) -> i32,
    get_uniform_block_index: unsafe extern "C" fn(u32, *const c_char) -> u32,
    get_active_uniform:
        unsafe extern "C" fn(u32, u32, i32, *mut i32, *mut i32, *mut Enum, *mut c_char),
    get_active_attrib:
        unsafe extern "C" fn(u32, u32, i32, *mut i32, *mut i32, *mut Enum, *mut c_char),
    uniform_fv: [unsafe extern "C" fn(i32, i32, *const f32); 4],
    uniform_iv: [unsafe extern "C" fn(i32, i32, *const i32); 4],
    uniform_matrix_fv: [unsafe extern "C" fn(i32, i32, u8, *const f32); 9],
    uniform_uiv: [unsafe extern "C" fn(i32, i32, *const u32); 4],
    gen_samplers: unsafe extern "C" fn(i32, *mut u32),
    delete_samplers: unsafe extern "C" fn(i32, *const u32),
    tex_image_3d:
        unsafe extern "C" fn(Enum, i32, i32, i32, i32, i32, i32, Enum, Enum, *const c_void),
    gen_textures: unsafe extern "C" fn(i32, *mut u32),
    delete_textures: unsafe extern "C" fn(i32, *const u32),
    tex_image_2d: unsafe extern "C" fn(Enum, i32, i32, i32, i32, i32, Enum, Enum, *const c_void),
    tex_sub_image_2d:
        unsafe extern "C" fn(Enum, i32, i32, i32, i32, i32, Enum, Enum, *const c_void),
    tex_sub_image_3d:
        unsafe extern "C" fn(Enum, i32, i32, i32, i32, i32, i32, i32, Enum, Enum, *const c_void),
    compressed_tex_image_2d:
        unsafe extern "C" fn(Enum, i32, Enum, i32, i32, i32, i32, *const c_void),
    compressed_tex_image_3d:
        unsafe extern "C" fn(Enum, i32, Enum, i32, i32, i32, i32, i32, *const c_void),
    compressed_tex_sub_image_2d:
        unsafe extern "C" fn(Enum, i32, i32, i32, i32, i32, Enum, i32, *const c_void),
    compressed_tex_sub_image_3d:
        unsafe extern "C" fn(Enum, i32, i32, i32, i32, i32, i32, i32, Enum, i32, *const c_void),
    gen_renderbuffers: unsafe extern "C" fn(i32, *mut u32),
    delete_renderbuffers: unsafe extern "C" fn(i32, *const u32),
    gen_framebuffers: unsafe extern "C" fn(i32, *mut u32),
    delete_framebuffers: unsafe extern "C" fn(i32, *const u32),
    draw_buffers: unsafe extern "C" fn(i32, *const Enum),
    read_pixels: unsafe extern "C" fn(i32, i32, i32, i32, Enum, Enum, *mut c_void),
    draw_elements: unsafe extern "C" fn(Enum, i32, Enum, usize),
    draw_elements_instanced: unsafe extern "C" fn(Enum, i32, Enum, usize, i32),
    request_extension: unsafe extern "C" fn(*const c_char),
    get_string: unsafe extern "C" fn(Enum) -> *const u8,
    /// `glGetDebugMessageLogKHR`, which names the rule a failed call broke; absent when ANGLE has no `GL_KHR_debug`.
    debug_log: Option<DebugLog>,
}

type DebugLog = unsafe extern "C" fn(
    u32,
    i32,
    *mut Enum,
    *mut Enum,
    *mut u32,
    *mut Enum,
    *mut i32,
    *mut c_char,
) -> u32;

/// A `fn` pointer of the GL entry point `name`.
macro_rules! load {
    ($lookup:expr, $name:literal) => {{
        let p = $lookup($name);
        if p.is_null() {
            return Err(format!("ANGLE has no {}", $name));
        }
        // SAFETY: `p` is the address of the GL function `$name`; the field it is stored in has the signature the
        // GL ES 3.0 headers give it.
        unsafe { std::mem::transmute(p) }
    }};
}

impl RawPtr {
    fn load(lookup: &dyn Fn(&str) -> *const c_void) -> Result<RawPtr, String> {
        Ok(RawPtr {
            gen_buffers: load!(lookup, "glGenBuffers"),
            delete_buffers: load!(lookup, "glDeleteBuffers"),
            buffer_data: load!(lookup, "glBufferData"),
            gen_vertex_arrays: load!(lookup, "glGenVertexArrays"),
            delete_vertex_arrays: load!(lookup, "glDeleteVertexArrays"),
            vertex_attrib_pointer: load!(lookup, "glVertexAttribPointer"),
            vertex_attrib_ipointer: load!(lookup, "glVertexAttribIPointer"),
            shader_source: load!(lookup, "glShaderSource"),
            get_shaderiv: load!(lookup, "glGetShaderiv"),
            get_shader_info_log: load!(lookup, "glGetShaderInfoLog"),
            bind_attrib_location: load!(lookup, "glBindAttribLocation"),
            get_programiv: load!(lookup, "glGetProgramiv"),
            get_program_info_log: load!(lookup, "glGetProgramInfoLog"),
            get_attrib_location: load!(lookup, "glGetAttribLocation"),
            get_uniform_location: load!(lookup, "glGetUniformLocation"),
            get_uniform_block_index: load!(lookup, "glGetUniformBlockIndex"),
            get_active_attrib: load!(lookup, "glGetActiveAttrib"),
            get_active_uniform: load!(lookup, "glGetActiveUniform"),
            uniform_fv: [
                load!(lookup, "glUniform1fv"),
                load!(lookup, "glUniform2fv"),
                load!(lookup, "glUniform3fv"),
                load!(lookup, "glUniform4fv"),
            ],
            uniform_iv: [
                load!(lookup, "glUniform1iv"),
                load!(lookup, "glUniform2iv"),
                load!(lookup, "glUniform3iv"),
                load!(lookup, "glUniform4iv"),
            ],
            uniform_matrix_fv: [
                load!(lookup, "glUniformMatrix2fv"),
                load!(lookup, "glUniformMatrix3fv"),
                load!(lookup, "glUniformMatrix4fv"),
                load!(lookup, "glUniformMatrix2x3fv"),
                load!(lookup, "glUniformMatrix2x4fv"),
                load!(lookup, "glUniformMatrix3x2fv"),
                load!(lookup, "glUniformMatrix3x4fv"),
                load!(lookup, "glUniformMatrix4x2fv"),
                load!(lookup, "glUniformMatrix4x3fv"),
            ],
            uniform_uiv: [
                load!(lookup, "glUniform1uiv"),
                load!(lookup, "glUniform2uiv"),
                load!(lookup, "glUniform3uiv"),
                load!(lookup, "glUniform4uiv"),
            ],
            gen_samplers: load!(lookup, "glGenSamplers"),
            delete_samplers: load!(lookup, "glDeleteSamplers"),
            tex_image_3d: load!(lookup, "glTexImage3D"),
            gen_textures: load!(lookup, "glGenTextures"),
            delete_textures: load!(lookup, "glDeleteTextures"),
            tex_image_2d: load!(lookup, "glTexImage2D"),
            tex_sub_image_2d: load!(lookup, "glTexSubImage2D"),
            tex_sub_image_3d: load!(lookup, "glTexSubImage3D"),
            compressed_tex_image_2d: load!(lookup, "glCompressedTexImage2D"),
            compressed_tex_image_3d: load!(lookup, "glCompressedTexImage3D"),
            compressed_tex_sub_image_2d: load!(lookup, "glCompressedTexSubImage2D"),
            compressed_tex_sub_image_3d: load!(lookup, "glCompressedTexSubImage3D"),
            gen_renderbuffers: load!(lookup, "glGenRenderbuffers"),
            delete_renderbuffers: load!(lookup, "glDeleteRenderbuffers"),
            gen_framebuffers: load!(lookup, "glGenFramebuffers"),
            delete_framebuffers: load!(lookup, "glDeleteFramebuffers"),
            draw_buffers: load!(lookup, "glDrawBuffers"),
            read_pixels: load!(lookup, "glReadPixels"),
            draw_elements: load!(lookup, "glDrawElements"),
            draw_elements_instanced: load!(lookup, "glDrawElementsInstanced"),
            request_extension: load!(lookup, "glRequestExtensionANGLE"),
            get_string: load!(lookup, "glGetString"),
            debug_log: {
                let p = lookup("glGetDebugMessageLogKHR");
                // SAFETY: the address of `glGetDebugMessageLogKHR`, which has this signature in the KHR_debug spec.
                (!p.is_null()).then(|| unsafe { std::mem::transmute::<*const c_void, DebugLog>(p) })
            },
        })
    }
}

/// An active uniform of a linked program.
pub struct ActiveUniform {
    pub name: String,
    pub size: i32,
    pub ty: Enum,
}

/// An active vertex shader input of a linked program.
pub struct ActiveAttrib {
    pub name: String,
    pub location: i32,
    pub ty: Enum,
}

/// The kinds of data a texture upload takes.
pub struct Texels<'a> {
    pub format: Enum,
    pub ty: Enum,
    pub bytes: &'a [u8],
}

/// The bytes one texel of `format` and `ty` takes with UNPACK_ALIGNMENT 1 (the replay sets it): the pairs GL ES 3.0
/// takes for an upload, with a type that packs the channels into one value taking its own size.
fn texel_bytes(format: Enum, ty: Enum) -> Option<usize> {
    match ty {
        // The channels are packed into one value.
        0x8363 | 0x8033 | 0x8034 => return Some(2), // UNSIGNED_SHORT_5_6_5, _4_4_4_4, _5_5_5_1
        0x8368 | 0x8C3B | 0x8C3E => return Some(4), // UNSIGNED_INT_2_10_10_10_REV, _10F_11F_11F_REV, _5_9_9_9_REV
        0x8DAD => return (format == gl::DEPTH_STENCIL).then_some(8), // FLOAT_32_UNSIGNED_INT_24_8_REV
        gl::UNSIGNED_INT_24_8 => return (format == gl::DEPTH_STENCIL).then_some(4),
        _ => {}
    }
    let components = match format {
        gl::RGBA | 0x8D99 => 4,                                        // RGBA_INTEGER
        0x1907 | 0x8D98 => 3,                                          // RGB, RGB_INTEGER
        gl::RG | 0x8228 | 0x190A => 2, // RG, RG_INTEGER, LUMINANCE_ALPHA
        gl::RED | 0x8D94 | 0x1909 | 0x1906 | gl::DEPTH_COMPONENT => 1, // RED, RED_INTEGER, LUMINANCE, ALPHA
        _ => return None,
    };
    let size = match ty {
        gl::UNSIGNED_BYTE | gl::BYTE => 1,
        gl::UNSIGNED_SHORT | gl::SHORT | gl::HALF_FLOAT => 2,
        gl::UNSIGNED_INT | gl::INT | gl::FLOAT => 4,
        _ => return None,
    };
    Some(components * size)
}

/// The bytes a `w x h x d` upload of `format` and `ty` reads; `None` for a negative size, a pair the replay does not
/// upload, or a product that does not fit.
fn upload_len(w: i32, h: i32, d: i32, format: Enum, ty: Enum) -> Option<usize> {
    let side = |n: i32| usize::try_from(n).ok();
    side(w)?
        .checked_mul(side(h)?)?
        .checked_mul(side(d)?)?
        .checked_mul(texel_bytes(format, ty)?)
}

/// A 3D texture or a 2D array: the targets whose uploads have a depth.
fn is_3d(target: Enum) -> bool {
    target == gl::TEXTURE_3D || target == gl::TEXTURE_2D_ARRAY
}

/// An error unless `texels` holds what a `w x h x d` upload reads.
fn check_upload(texels: &Texels, (w, h, d): (i32, i32, i32)) -> Result<(), String> {
    let need = upload_len(w, h, d, texels.format, texels.ty).ok_or_else(|| {
        format!(
            "an upload of {w} x {h} x {d} texels of format 0x{:x}, type 0x{:x} is not sized",
            texels.format, texels.ty
        )
    })?;
    if texels.bytes.len() < need {
        return Err(format!(
            "an upload of {w} x {h} x {d} texels needs {need} bytes and has {}",
            texels.bytes.len()
        ));
    }
    Ok(())
}

impl Gl {
    fn names(&self, make: unsafe extern "C" fn(i32, *mut u32), n: usize) -> Vec<u32> {
        let mut v = vec![0u32; n];
        // SAFETY: `v` has room for the `n` names GL writes.
        unsafe { make(n as i32, v.as_mut_ptr()) };
        v
    }
    fn one(&self, make: unsafe extern "C" fn(i32, *mut u32)) -> u32 {
        self.names(make, 1)[0]
    }
    pub fn gen_buffer(&self) -> u32 {
        self.one(self.ptr.gen_buffers)
    }
    pub fn gen_vertex_array(&self) -> u32 {
        self.one(self.ptr.gen_vertex_arrays)
    }
    pub fn gen_sampler(&self) -> u32 {
        self.one(self.ptr.gen_samplers)
    }
    pub fn delete_sampler(&self, n: u32) {
        // SAFETY: as `delete_buffer`.
        unsafe { (self.ptr.delete_samplers)(1, &n) }
    }
    pub fn gen_texture(&self) -> u32 {
        self.one(self.ptr.gen_textures)
    }
    pub fn gen_renderbuffer(&self) -> u32 {
        self.one(self.ptr.gen_renderbuffers)
    }
    pub fn gen_framebuffer(&self) -> u32 {
        self.one(self.ptr.gen_framebuffers)
    }
    pub fn delete_buffer(&self, n: u32) {
        // SAFETY: one name, read from a local.
        unsafe { (self.ptr.delete_buffers)(1, &n) }
    }
    pub fn delete_vertex_array(&self, n: u32) {
        // SAFETY: as `delete_buffer`.
        unsafe { (self.ptr.delete_vertex_arrays)(1, &n) }
    }
    pub fn delete_texture(&self, n: u32) {
        // SAFETY: as `delete_buffer`.
        unsafe { (self.ptr.delete_textures)(1, &n) }
    }
    pub fn delete_renderbuffer(&self, n: u32) {
        // SAFETY: as `delete_buffer`.
        unsafe { (self.ptr.delete_renderbuffers)(1, &n) }
    }
    pub fn delete_framebuffer(&self, n: u32) {
        // SAFETY: as `delete_buffer`.
        unsafe { (self.ptr.delete_framebuffers)(1, &n) }
    }

    pub fn buffer_data(&self, target: Enum, bytes: &[u8]) {
        // SAFETY: GL copies `bytes.len()` bytes from the slice.
        unsafe {
            (self.ptr.buffer_data)(
                target,
                bytes.len() as isize,
                bytes.as_ptr().cast(),
                gl::STATIC_DRAW,
            )
        }
    }
    /// `offset` is a byte offset into the bound `ARRAY_BUFFER`.
    pub fn vertex_attrib_pointer(
        &self,
        i: u32,
        size: i32,
        ty: Enum,
        normalized: bool,
        stride: i32,
        offset: usize,
    ) {
        // SAFETY: with a buffer bound the "pointer" is an offset into it, which GL validates against the buffer.
        unsafe {
            (self.ptr.vertex_attrib_pointer)(i, size, ty, u8::from(normalized), stride, offset)
        }
    }
    pub fn vertex_attrib_ipointer(&self, i: u32, size: i32, ty: Enum, stride: i32, offset: usize) {
        // SAFETY: as `vertex_attrib_pointer`.
        unsafe { (self.ptr.vertex_attrib_ipointer)(i, size, ty, stride, offset) }
    }
    /// Draws with indices read from the bound `ELEMENT_ARRAY_BUFFER` at byte `offset`.
    pub fn draw_elements(&self, mode: Enum, count: i32, ty: Enum, offset: usize) {
        // SAFETY: an element buffer is bound, so `offset` is an offset into it, which GL validates.
        unsafe { (self.ptr.draw_elements)(mode, count, ty, offset) }
    }
    pub fn draw_elements_instanced(
        &self,
        mode: Enum,
        count: i32,
        ty: Enum,
        offset: usize,
        instances: i32,
    ) {
        // SAFETY: as `draw_elements`.
        unsafe { (self.ptr.draw_elements_instanced)(mode, count, ty, offset, instances) }
    }

    /// Compiles `source`; the error is the info log.
    pub fn compile(&self, kind: Enum, source: &str) -> Result<u32, String> {
        let shader = self.create_shader(kind);
        let text = CString::new(source).map_err(|_| "a shader source holds a NUL".to_string())?;
        let ptr = text.as_ptr();
        let mut status = 0;
        // SAFETY: one NUL-terminated string, `text`, which outlives the call; GL copies it.
        unsafe {
            (self.ptr.shader_source)(shader, 1, &ptr, std::ptr::null());
        }
        self.compile_shader(shader);
        // SAFETY: `status` is one `i32`.
        unsafe { (self.ptr.get_shaderiv)(shader, gl::COMPILE_STATUS, &mut status) };
        if status == 0 {
            let mut log = vec![0u8; 4096];
            let mut len = 0;
            // SAFETY: GL writes at most `log.len()` bytes and reports how many.
            unsafe {
                (self.ptr.get_shader_info_log)(shader, 4096, &mut len, log.as_mut_ptr().cast())
            };
            self.delete_shader(shader);
            log.truncate(len.max(0) as usize);
            return Err(String::from_utf8_lossy(&log).into_owned());
        }
        Ok(shader)
    }

    pub fn bind_attrib_location(&self, program: u32, index: u32, name: &str) {
        let Ok(name) = CString::new(name) else { return };
        // SAFETY: a NUL-terminated string that outlives the call.
        unsafe { (self.ptr.bind_attrib_location)(program, index, name.as_ptr()) }
    }

    /// Links `program`; the error is the info log.
    pub fn link(&self, program: u32) -> Result<(), String> {
        self.link_program(program);
        let mut status = 0;
        // SAFETY: `status` is one `i32`.
        unsafe { (self.ptr.get_programiv)(program, gl::LINK_STATUS, &mut status) };
        if status == 0 {
            let mut log = vec![0u8; 4096];
            let mut len = 0;
            // SAFETY: GL writes at most `log.len()` bytes and reports how many.
            unsafe {
                (self.ptr.get_program_info_log)(program, 4096, &mut len, log.as_mut_ptr().cast())
            };
            log.truncate(len.max(0) as usize);
            return Err(String::from_utf8_lossy(&log).into_owned());
        }
        Ok(())
    }

    pub fn attrib_location(&self, program: u32, name: &str) -> i32 {
        let Ok(name) = CString::new(name) else {
            return -1;
        };
        // SAFETY: a NUL-terminated string that outlives the call.
        unsafe { (self.ptr.get_attrib_location)(program, name.as_ptr()) }
    }
    pub fn uniform_location(&self, program: u32, name: &str) -> i32 {
        let Ok(name) = CString::new(name) else {
            return -1;
        };
        // SAFETY: as `attrib_location`.
        unsafe { (self.ptr.get_uniform_location)(program, name.as_ptr()) }
    }
    pub fn uniform_block_index(&self, program: u32, name: &str) -> Option<u32> {
        let name = CString::new(name).ok()?;
        // SAFETY: as `attrib_location`.
        let i = unsafe { (self.ptr.get_uniform_block_index)(program, name.as_ptr()) };
        (i != u32::MAX).then_some(i)
    }

    pub fn active_uniforms(&self, program: u32) -> Vec<ActiveUniform> {
        let mut count = 0;
        // SAFETY: `count` is one `i32`.
        unsafe { (self.ptr.get_programiv)(program, gl::ACTIVE_UNIFORMS, &mut count) };
        (0..count.max(0) as u32)
            .map(|i| {
                let mut name = vec![0u8; 256];
                let (mut len, mut size, mut ty) = (0, 0, 0);
                // SAFETY: GL writes at most `name.len()` bytes and the three scalars.
                unsafe {
                    (self.ptr.get_active_uniform)(
                        program,
                        i,
                        256,
                        &mut len,
                        &mut size,
                        &mut ty,
                        name.as_mut_ptr().cast(),
                    );
                }
                name.truncate(len.max(0) as usize);
                ActiveUniform {
                    name: String::from_utf8_lossy(&name).into_owned(),
                    size,
                    ty,
                }
            })
            .collect()
    }

    /// The active attributes of a linked program, with their locations and GL types.
    pub fn active_attribs(&self, program: u32) -> Vec<ActiveAttrib> {
        let mut count = 0;
        // SAFETY: `count` is one `i32`.
        unsafe { (self.ptr.get_programiv)(program, gl::ACTIVE_ATTRIBUTES, &mut count) };
        (0..count.max(0) as u32)
            .filter_map(|i| {
                let mut name = vec![0u8; 256];
                let (mut len, mut size, mut ty) = (0, 0, 0);
                // SAFETY: GL writes at most `name.len()` bytes and the three scalars.
                unsafe {
                    (self.ptr.get_active_attrib)(
                        program,
                        i,
                        256,
                        &mut len,
                        &mut size,
                        &mut ty,
                        name.as_mut_ptr().cast(),
                    );
                }
                name.truncate(len.max(0) as usize);
                let name = String::from_utf8_lossy(&name).into_owned();
                // The built-ins (`gl_InstanceID` and the like) have no location.
                let location = self.attrib_location(program, &name);
                (location >= 0).then_some(ActiveAttrib { name, location, ty })
            })
            .collect()
    }

    /// `glUniform{1..4}fv` of `values.len() / components` elements.
    pub fn uniform_f(&self, location: i32, components: usize, values: &[f32]) {
        let n = (values.len() / components) as i32;
        // SAFETY: GL reads `n * components` floats, which is within `values`.
        unsafe { (self.ptr.uniform_fv[components - 1])(location, n, values.as_ptr()) }
    }
    pub fn uniform_i(&self, location: i32, components: usize, values: &[i32]) {
        let n = (values.len() / components) as i32;
        // SAFETY: as `uniform_f`.
        unsafe { (self.ptr.uniform_iv[components - 1])(location, n, values.as_ptr()) }
    }
    /// `which` indexes `2, 3, 4, 2x3, 2x4, 3x2, 3x4, 4x2, 4x3`; `floats` is the element size.
    pub fn uniform_matrix(&self, location: i32, which: usize, floats: usize, values: &[f32]) {
        let n = (values.len() / floats) as i32;
        // SAFETY: as `uniform_f`.
        unsafe { (self.ptr.uniform_matrix_fv[which])(location, n, gl::FALSE, values.as_ptr()) }
    }

    /// `glTexImage3D` of `target` (`TEXTURE_3D` or `TEXTURE_2D_ARRAY`).
    pub fn tex_image_3d(
        &self,
        target: Enum,
        internal: Enum,
        (w, h, d): (i32, i32, i32),
        texels: Texels,
    ) -> Result<(), String> {
        check_upload(&texels, (w, h, d))?;
        // SAFETY: `check_upload` found the slice holds the `w * h * d` texels GL reads.
        unsafe {
            (self.ptr.tex_image_3d)(
                target,
                0,
                internal as i32,
                w,
                h,
                d,
                0,
                texels.format,
                texels.ty,
                texels.bytes.as_ptr().cast(),
            )
        }
        Ok(())
    }
    pub fn uniform_u(&self, location: i32, components: usize, values: &[u32]) {
        let n = (values.len() / components) as i32;
        // SAFETY: as `uniform_f`.
        unsafe { (self.ptr.uniform_uiv[components - 1])(location, n, values.as_ptr()) }
    }
    pub fn tex_image_2d(
        &self,
        target: Enum,
        level: i32,
        internal: Enum,
        (w, h): (i32, i32),
        texels: Option<Texels>,
    ) -> Result<(), String> {
        let (format, ty, data) = match &texels {
            Some(t) => {
                check_upload(t, (w, h, 1))?;
                (t.format, t.ty, t.bytes.as_ptr().cast())
            }
            None => (gl::RGBA, gl::UNSIGNED_BYTE, std::ptr::null()),
        };
        // SAFETY: `check_upload` found the slice holds the `w * h` texels GL reads, or there is no data.
        unsafe {
            (self.ptr.tex_image_2d)(target, level, internal as i32, w, h, 0, format, ty, data)
        }
        Ok(())
    }
    pub fn tex_sub_image_2d(
        &self,
        level: i32,
        (x, y, w, h): (i32, i32, i32, i32),
        texels: Texels,
    ) -> Result<(), String> {
        check_upload(&texels, (w, h, 1))?;
        // SAFETY: as `tex_image_2d`.
        unsafe {
            (self.ptr.tex_sub_image_2d)(
                gl::TEXTURE_2D,
                level,
                x,
                y,
                w,
                h,
                texels.format,
                texels.ty,
                texels.bytes.as_ptr().cast(),
            )
        }
        Ok(())
    }
    /// `glTexImage2D` or `glTexImage3D` (by `target`) of any format and type, at `level`; no texels allocates the level
    /// empty. `depth` is the layers of a 3D or array texture.
    pub fn tex_image(
        &self,
        target: Enum,
        level: i32,
        internal: Enum,
        (w, h, d): (i32, i32, i32),
        texels: Option<Texels>,
    ) -> Result<(), String> {
        let three = is_3d(target);
        let (format, ty, data) = match &texels {
            Some(t) => {
                check_upload(t, (w, h, if three { d } else { 1 }))?;
                (t.format, t.ty, t.bytes.as_ptr().cast())
            }
            // The format and type of a null upload only have to agree with the internal format.
            None => (gl::RGBA, gl::UNSIGNED_BYTE, std::ptr::null()),
        };
        // SAFETY: `check_upload` found the slice holds the texels GL reads, or there is no data.
        unsafe {
            if three {
                (self.ptr.tex_image_3d)(
                    target,
                    level,
                    internal as i32,
                    w,
                    h,
                    d,
                    0,
                    format,
                    ty,
                    data,
                )
            } else {
                (self.ptr.tex_image_2d)(target, level, internal as i32, w, h, 0, format, ty, data)
            }
        }
        Ok(())
    }

    /// `glTexSubImage2D` or `glTexSubImage3D` (by `target`) of the box at `(x, y, z)` of `(w, h, d)` texels.
    pub fn tex_sub_image(
        &self,
        target: Enum,
        level: i32,
        (x, y, z): (i32, i32, i32),
        (w, h, d): (i32, i32, i32),
        texels: Texels,
    ) -> Result<(), String> {
        let three = is_3d(target);
        check_upload(&texels, (w, h, if three { d } else { 1 }))?;
        let data = texels.bytes.as_ptr().cast();
        // SAFETY: `check_upload` found the slice holds the `w * h * d` texels GL reads.
        unsafe {
            if three {
                (self.ptr.tex_sub_image_3d)(
                    target,
                    level,
                    x,
                    y,
                    z,
                    w,
                    h,
                    d,
                    texels.format,
                    texels.ty,
                    data,
                )
            } else {
                (self.ptr.tex_sub_image_2d)(
                    target,
                    level,
                    x,
                    y,
                    w,
                    h,
                    texels.format,
                    texels.ty,
                    data,
                )
            }
        }
        Ok(())
    }

    /// `glCompressedTexImage2D` or `3D` of the blocks in `bytes`; GL checks that they are the size the format and the
    /// dimensions make (ANGLE's validation reports it).
    pub fn compressed_tex_image(
        &self,
        target: Enum,
        level: i32,
        internal: Enum,
        (w, h, d): (i32, i32, i32),
        bytes: &[u8],
    ) -> Result<(), String> {
        let size =
            i32::try_from(bytes.len()).map_err(|_| "compressed texels over 2 GiB".to_string())?;
        // SAFETY: GL reads `size` bytes, which is the length of `bytes`.
        unsafe {
            if is_3d(target) {
                (self.ptr.compressed_tex_image_3d)(
                    target,
                    level,
                    internal,
                    w,
                    h,
                    d,
                    0,
                    size,
                    bytes.as_ptr().cast(),
                )
            } else {
                (self.ptr.compressed_tex_image_2d)(
                    target,
                    level,
                    internal,
                    w,
                    h,
                    0,
                    size,
                    bytes.as_ptr().cast(),
                )
            }
        }
        Ok(())
    }

    /// `glCompressedTexSubImage2D` or `3D`.
    pub fn compressed_tex_sub_image(
        &self,
        target: Enum,
        level: i32,
        (x, y, z): (i32, i32, i32),
        (w, h, d): (i32, i32, i32),
        format: Enum,
        bytes: &[u8],
    ) -> Result<(), String> {
        let size =
            i32::try_from(bytes.len()).map_err(|_| "compressed texels over 2 GiB".to_string())?;
        // SAFETY: as `compressed_tex_image`.
        unsafe {
            if is_3d(target) {
                (self.ptr.compressed_tex_sub_image_3d)(
                    target,
                    level,
                    x,
                    y,
                    z,
                    w,
                    h,
                    d,
                    format,
                    size,
                    bytes.as_ptr().cast(),
                )
            } else {
                (self.ptr.compressed_tex_sub_image_2d)(
                    target,
                    level,
                    x,
                    y,
                    w,
                    h,
                    format,
                    size,
                    bytes.as_ptr().cast(),
                )
            }
        }
        Ok(())
    }

    pub fn draw_buffers(&self, buffers: &[Enum]) {
        // SAFETY: GL reads `buffers.len()` enums.
        unsafe { (self.ptr.draw_buffers)(buffers.len() as i32, buffers.as_ptr()) }
    }
    /// RGBA8 rows from the bottom of the read framebuffer.
    pub fn read_pixels(&self, (w, h): (i32, i32), out: &mut [u8]) -> Result<(), String> {
        let need = upload_len(w, h, 1, gl::RGBA, gl::UNSIGNED_BYTE)
            .ok_or_else(|| format!("a read of {w} x {h} pixels is not sized"))?;
        if out.len() < need {
            return Err(format!(
                "a read of {w} x {h} pixels needs {need} bytes and the buffer has {}",
                out.len()
            ));
        }
        // SAFETY: the check above: GL writes `w * h * 4` bytes into `out`.
        unsafe {
            (self.ptr.read_pixels)(
                0,
                0,
                w,
                h,
                gl::RGBA,
                gl::UNSIGNED_BYTE,
                out.as_mut_ptr().cast(),
            )
        }
        Ok(())
    }
    /// The messages ANGLE logged since the last call (`GL_KHR_debug`), each with the rule it names.
    pub fn debug_messages(&self) -> Vec<String> {
        let Some(log) = self.ptr.debug_log else {
            return Vec::new();
        };
        let mut out = Vec::new();
        loop {
            let (mut source, mut ty, mut id, mut severity, mut len) = (0, 0, 0, 0, 0);
            let mut text = vec![0u8; 1024];
            // SAFETY: GL writes one message of at most `text.len()` bytes and the five scalars, all ours.
            let got = unsafe {
                log(
                    1,
                    1024,
                    &mut source,
                    &mut ty,
                    &mut id,
                    &mut severity,
                    &mut len,
                    text.as_mut_ptr().cast(),
                )
            };
            if got == 0 {
                return out;
            }
            text.truncate((len.max(1) - 1) as usize);
            out.push(String::from_utf8_lossy(&text).into_owned());
        }
    }
    /// The extensions this context can be asked for (`GL_REQUESTABLE_EXTENSIONS_ANGLE`), space separated.
    pub fn requestable_extensions(&self) -> String {
        // SAFETY: glGetString returns null or a NUL-terminated string owned by the context, read before the next GL call.
        let p = unsafe { (self.ptr.get_string)(0x93A8) };
        if p.is_null() {
            return String::new();
        }
        // SAFETY: `p` is the NUL-terminated string just checked.
        unsafe { std::ffi::CStr::from_ptr(p.cast()) }.to_string_lossy().into_owned()
    }

    /// Turns on an extension a WebGL-compatible context keeps off until asked.
    pub fn request_extension(&self, name: &str) {
        let Ok(name) = CString::new(name) else { return };
        // SAFETY: a NUL-terminated string that outlives the call.
        unsafe { (self.ptr.request_extension)(name.as_ptr()) }
    }
}

/// `Gl` holds both groups of entry points; `Raw` is built by `entry_points!` and `ptr` by hand.
struct Context {
    gl: Gl,
    display: *mut c_void,
    surface: *mut c_void,
    context: *mut c_void,
    make_current: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *mut c_void) -> u32,
    destroy_context: Destroy,
    destroy_surface: Destroy,
}

/// One thread at a time in ANGLE. Without this, a run of the cases on four threads failed in different cases each time
/// (a wrong picture, a failed draw): contexts of one Metal display used from several threads at once are not safe here.
/// Making, using and destroying a context all hold it.
static BUSY: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The contexts alive in the process: made by `create`, gone when their thread releases them or ends.
static LIVE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// A thread's contexts and their pbuffers are destroyed by `release_thread`, or else when the thread ends (its
/// `thread_local` is dropped), under the same lock as every other use of ANGLE. The libraries are never unloaded, so the
/// entry points stay valid.
impl Drop for Context {
    fn drop(&mut self) {
        let _one_at_a_time = BUSY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // SAFETY: the handles are the ones `create` made, destroyed once, here, on the thread that made them current; the
        // context is made not current first (EGL keeps a current context alive until then), and `EGL_NO_*` is null.
        unsafe {
            (self.make_current)(
                self.display,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            (self.destroy_context)(self.display, self.context);
            (self.destroy_surface)(self.display, self.surface);
        }
        LIVE.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

thread_local! {
    /// The contexts of this thread, one for each set of extensions a page can have enabled: an extension a page asks
    /// for stays on in an ANGLE context, so a page that did not ask must not draw in a context another page asked in.
    static CONTEXTS: RefCell<Vec<(Extensions, Context)>> = const { RefCell::new(Vec::new()) };
}

/// Destroys this thread's contexts, their pbuffers and what the replay keeps of them, and releases the thread from EGL:
/// what a thread that drew WebGL calls before it ends. Left to the thread's end, the destroying runs in a thread-local
/// destructor, which on Windows runs under the loader lock: a call into ANGLE there that waits on a thread starting or
/// ending, or loads a library, waits forever. A later `with` on the thread makes new contexts.
pub fn release_thread() {
    crate::angle_replay::forget_thread();
    let contexts = CONTEXTS.with(|cell| std::mem::take(&mut *cell.borrow_mut()));
    if contexts.is_empty() {
        return;
    }
    // Each is destroyed under BUSY (`Drop`).
    drop(contexts);
    let Ok(shared) = shared() else { return };
    let _one_at_a_time = BUSY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // SAFETY: eglReleaseThread takes no arguments; no context is current on this thread any more.
    unsafe { (shared.release_thread)() };
}

/// The diagnosis switches, read once. None of them changes a picture.
pub(crate) struct Settings {
    /// `KINETOGRAPH_ANGLE_TIME`: report the time of the stages of a replay (the only place the clock is read).
    pub time: bool,
    /// `KINETOGRAPH_ANGLE_DUMP=<op>:<path>`: write the colour attachment an op wrote as a PPM.
    pub dump: Option<(usize, PathBuf)>,
}

pub(crate) fn settings() -> &'static Settings {
    static SETTINGS: std::sync::OnceLock<Settings> = std::sync::OnceLock::new();
    SETTINGS.get_or_init(|| Settings {
        time: std::env::var_os("KINETOGRAPH_ANGLE_TIME").is_some(),
        dump: std::env::var("KINETOGRAPH_ANGLE_DUMP").ok().and_then(|v| {
            let (op, path) = v.split_once(':')?;
            Some((op.parse().ok()?, PathBuf::from(path)))
        }),
    })
}

/// What WebGL has here, for `doctor`: `("angle", Some(device), why)` when ANGLE loads and starts (it is started on the first
/// call and kept), `("none", None, why)` with what failed when it does not, and WebGL then draws nothing.
pub fn backend_report() -> (&'static str, Option<&'static str>, String) {
    match shared() {
        Ok(s) => ("angle", Some(s.device.name()), s.why.clone()),
        Err(e) => ("none", None, e),
    }
}

/// The extensions a page can enable that a context keeps on once asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Extensions {
    /// `OES_texture_float_linear`.
    pub float_linear: bool,
    /// `EXT_float_blend`.
    pub float_blend: bool,
}

/// Runs `f` with this thread's context for `ext`, made on first use and made current.
pub fn with<T>(ext: Extensions, f: impl FnOnce(&Gl) -> T) -> Result<T, String> {
    let _one_at_a_time = BUSY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    CONTEXTS.with(|cell| {
        let mut contexts = cell.borrow_mut();
        let at = match contexts.iter().position(|(k, _)| *k == ext) {
            Some(at) => at,
            None => {
                contexts.push((ext, create(ext)?));
                contexts.len() - 1
            }
        };
        let c = &contexts[at].1;
        // SAFETY: the handles are the ones `create` made this context and surface from, on this thread; making a context
        // current on the thread that owns it is allowed whichever other context was current.
        if unsafe { (c.make_current)(c.display, c.surface, c.surface, c.context) } == 0 {
            return Err("eglMakeCurrent failed".into());
        }
        Ok(f(&c.gl))
    })
}

/// `KINETOGRAPH_ANGLE_DIR` or the `angle/` folder of the addon's platform package: always an absolute path. The
/// libraries are loaded by full path and never by a bare name, so neither the system's search path nor the working
/// directory (a project folder could hold a planted `libEGL`) decides which ones are loaded.
fn library_dir() -> Result<PathBuf, String> {
    match std::env::var_os("KINETOGRAPH_ANGLE_DIR") {
        Some(dir) => checked_dir(PathBuf::from(dir)),
        None => addon_dir()
            .ok_or_else(|| "ANGLE is not available: set KINETOGRAPH_ANGLE_DIR to the folder holding libEGL and libGLESv2".to_string())
            .and_then(|d| find_angle(&d)),
    }
}

/// The npm platform package this build is, as `scripts/fetch-angle.mjs` names it.
const PLATFORM: &str = if cfg!(target_os = "macos") {
    "darwin-arm64"
} else if cfg!(windows) {
    "win32-x64-msvc"
} else {
    "linux-x64-gnu"
};

/// The `angle/` folder for an addon in `dir`: beside it when installed (the platform package holds the addon and
/// `angle/` together), or `npm/<platform>/angle` under `crates/node` when the addon runs from a source checkout.
fn find_angle(dir: &std::path::Path) -> Result<PathBuf, String> {
    let installed = dir.join("angle");
    let checkout = dir.join("npm").join(PLATFORM).join("angle");
    let has = |d: &PathBuf| d.join(library_file_name("EGL", cfg!(windows))).is_file();
    if has(&installed) {
        Ok(installed)
    } else if has(&checkout) {
        Ok(checkout)
    } else {
        Err(format!(
            "ANGLE is not available: no libEGL in {} (run `node scripts/fetch-angle.mjs {PLATFORM}` in a source checkout), or set KINETOGRAPH_ANGLE_DIR",
            installed.display()
        ))
    }
}

/// The path rule: absolute, and not empty.
fn checked_dir(dir: PathBuf) -> Result<PathBuf, String> {
    if dir.as_os_str().is_empty() || !dir.is_absolute() {
        return Err(format!(
            "KINETOGRAPH_ANGLE_DIR must be an absolute path, got {:?}",
            dir.display().to_string()
        ));
    }
    Ok(dir)
}

/// The folder of the file this code is loaded from (the addon), resolved from the module's own address and not from
/// the working directory.
#[cfg(unix)]
fn addon_dir() -> Option<PathBuf> {
    let mut info: libc::Dl_info = unsafe { std::mem::zeroed() };
    // SAFETY: `dladdr` reads the address of a function of this module and fills `info`, which is zeroed and ours;
    // `dli_fname` is a NUL-terminated path owned by the loader, copied before the call returns.
    let found = unsafe { libc::dladdr(addon_dir as *const c_void, &mut info) };
    if found == 0 || info.dli_fname.is_null() {
        return None;
    }
    // SAFETY: non-null and NUL-terminated, see above.
    let file = unsafe { std::ffi::CStr::from_ptr(info.dli_fname) }
        .to_string_lossy()
        .into_owned();
    let path = PathBuf::from(file);
    path.is_absolute()
        .then(|| path.parent().map(PathBuf::from))
        .flatten()
}

#[cfg(windows)]
fn addon_dir() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetModuleHandleExW(flags: u32, address: *const c_void, module: *mut *mut c_void) -> i32;
        fn GetModuleFileNameW(module: *mut c_void, buffer: *mut u16, size: u32) -> u32;
    }
    const FROM_ADDRESS: u32 = 0x4 | 0x2; // GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | ..._UNCHANGED_REFCOUNT
    let mut module = std::ptr::null_mut();
    let mut buffer = vec![0u16; 32768];
    // SAFETY: the address is of a function of this module; `module` and `buffer` are ours and `buffer` is as long as
    // the size passed.
    let len = unsafe {
        if GetModuleHandleExW(FROM_ADDRESS, addon_dir as *const c_void, &mut module) == 0 {
            return None;
        }
        GetModuleFileNameW(module, buffer.as_mut_ptr(), buffer.len() as u32)
    } as usize;
    let path = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..len]));
    path.parent().map(PathBuf::from)
}

/// The file ANGLE ships for `libEGL` or `libGLESv2`: `libEGL.dylib` and `libEGL.so` by the platform's rule, and
/// `libEGL.dll` on Windows, where ANGLE keeps the `lib` prefix (libloading would give `EGL.dll`).
fn library_file_name(name: &str, windows: bool) -> std::ffi::OsString {
    if windows {
        format!("lib{name}.dll").into()
    } else {
        libloading::library_filename(name)
    }
}

fn open(dir: &std::path::Path, name: &str) -> Result<Library, String> {
    let path = dir.join(library_file_name(name, cfg!(windows)));
    #[cfg(windows)]
    {
        use libloading::os::windows::{
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32, Library as Win,
        };
        // SAFETY: loading a shared library runs its initialisers, ANGLE's own. The flags make the loader look in the
        // library's own folder and System32 only, never in the working directory, for the libraries it names.
        return unsafe {
            Win::load_with_flags(
                &path,
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )
        }
        .map(Library::from)
        .map_err(|e| {
            format!(
                "ANGLE is not available: cannot load {}: {e}",
                path.display()
            )
        });
    }
    #[cfg(not(windows))]
    {
        // SAFETY: loading a shared library runs its initialisers, ANGLE's own, which only set up statics. `path` is absolute.
        unsafe { Library::new(&path) }.map_err(|e| {
            format!(
                "ANGLE is not available: cannot load {}: {e}",
                path.display()
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Extensions, LIVE, PLATFORM, Texels, check_upload, checked_dir, find_angle, gl,
        library_file_name, upload_len, with,
    };
    use std::path::PathBuf;

    #[test]
    fn the_library_folder_must_be_absolute() {
        assert!(checked_dir(PathBuf::new()).is_err());
        assert!(checked_dir(PathBuf::from("angle")).is_err());
        assert!(checked_dir(PathBuf::from("./angle")).is_err());
        assert!(checked_dir(PathBuf::from("../lib")).is_err());
        let abs = std::env::temp_dir();
        assert_eq!(checked_dir(abs.clone()).unwrap(), abs);
    }

    #[test]
    fn an_upload_is_sized_without_wrapping() {
        assert_eq!(upload_len(4, 4, 1, gl::RGBA, gl::UNSIGNED_BYTE), Some(64));
        assert_eq!(upload_len(2, 2, 3, gl::RGBA, gl::FLOAT), Some(192));
        // 32768 x 32768 x 4 wraps an i32 product to 0; as a usize it is 4 GiB, which a slice then fails to hold.
        assert_eq!(
            upload_len(32768, 32768, 1, gl::RGBA, gl::UNSIGNED_BYTE),
            Some(32768usize * 32768 * 4)
        );
        assert_eq!(
            upload_len(i32::MAX, i32::MAX, i32::MAX, gl::RGBA, gl::FLOAT),
            None
        );
        assert_eq!(upload_len(-1, 4, 1, gl::RGBA, gl::UNSIGNED_BYTE), None);
        assert_eq!(upload_len(4, 4, 1, 0x1234, gl::UNSIGNED_BYTE), None);
    }

    #[test]
    fn angle_is_found_beside_the_addon_or_in_the_platform_folder() {
        let root =
            std::env::temp_dir().join(format!("kinetograph-angle-find-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let file = library_file_name("EGL", cfg!(windows));
        assert!(find_angle(&root).is_err());
        let checkout = root.join("npm").join(PLATFORM).join("angle");
        std::fs::create_dir_all(&checkout).unwrap();
        std::fs::write(checkout.join(&file), b"").unwrap();
        assert_eq!(find_angle(&root).unwrap(), checkout);
        let installed = root.join("angle");
        std::fs::create_dir_all(&installed).unwrap();
        std::fs::write(installed.join(&file), b"").unwrap();
        assert_eq!(find_angle(&root).unwrap(), installed);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn angle_libraries_have_the_names_angle_ships() {
        assert_eq!(library_file_name("EGL", true), "libEGL.dll");
        assert_eq!(library_file_name("GLESv2", true), "libGLESv2.dll");
        let here = library_file_name("EGL", false)
            .to_string_lossy()
            .into_owned();
        assert!(here == "libEGL.dylib" || here == "libEGL.so", "{here}");
    }

    #[test]
    fn a_short_slice_is_refused() {
        let bytes = [0u8; 63];
        let short = Texels {
            format: gl::RGBA,
            ty: gl::UNSIGNED_BYTE,
            bytes: &bytes,
        };
        assert!(check_upload(&short, (4, 4, 1)).is_err());
        let exact = [0u8; 64];
        let ok = Texels {
            format: gl::RGBA,
            ty: gl::UNSIGNED_BYTE,
            bytes: &exact,
        };
        assert!(check_upload(&ok, (4, 4, 1)).is_ok());
    }

    /// The tests that make and end contexts on threads, one at a time: one counts `LIVE`.
    static THREADS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A thread's context and pbuffer are destroyed by `release_thread`, or else when the thread ends (needs ANGLE:
    /// skipped without it).
    #[test]
    fn a_threads_context_is_destroyed_when_the_thread_ends() {
        use std::sync::atomic::Ordering::SeqCst;
        let _one_at_a_time = THREADS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let ext = Extensions {
            float_linear: false,
            float_blend: false,
        };
        if std::thread::spawn(move || with(ext, |_| ()))
            .join()
            .unwrap()
            .is_err()
        {
            return;
        }
        let before = LIVE.load(SeqCst);
        std::thread::spawn(move || {
            with(ext, |_| ()).unwrap();
            assert!(LIVE.load(SeqCst) > before);
        })
        .join()
        .unwrap();
        assert_eq!(LIVE.load(SeqCst), before);
        // `release_thread` destroys them before the thread ends.
        std::thread::spawn(move || {
            with(ext, |_| ()).unwrap();
            super::release_thread();
            assert_eq!(LIVE.load(SeqCst), before);
        })
        .join()
        .unwrap();
    }

    /// Threads that draw and end at staggered times while others are drawing: in each round half release their contexts
    /// first (`release_thread`) and half leave them to the thread-local destructor (on Windows, under the loader lock). A
    /// hang fails the test instead of running into the CI step's limit (needs ANGLE: skipped without it).
    #[test]
    fn threads_ending_while_others_draw_do_not_hang() {
        let _one_at_a_time = THREADS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let ext = Extensions {
            float_linear: false,
            float_blend: false,
        };
        if std::thread::spawn(move || with(ext, |_| ()))
            .join()
            .unwrap()
            .is_err()
        {
            return;
        }
        let (done, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for round in 0..50u32 {
                let threads: Vec<_> = (0..4u32)
                    .map(|i| {
                        std::thread::spawn(move || {
                            // Thread i draws i + 1 times, so the threads end one after another while the rest draw.
                            for _ in 0..=i {
                                let px = with(ext, |gl| {
                                    gl.clear_color(0.0, 1.0, 0.0, 1.0);
                                    gl.clear(gl::COLOR_BUFFER_BIT);
                                    let mut px = [0u8; 4];
                                    gl.read_pixels((1, 1), &mut px).map(|()| px)
                                });
                                assert_eq!(px, Ok(Ok([0, 255, 0, 255])));
                            }
                            if (round + i) % 2 == 0 {
                                super::release_thread();
                            }
                        })
                    })
                    .collect();
                for thread in threads {
                    thread.join().unwrap();
                }
            }
            let _ = done.send(());
        });
        match finished.recv_timeout(std::time::Duration::from_secs(240)) {
            Ok(()) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                panic!("threads drawing and ending had not finished after 240 s: a hang")
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                panic!("a thread drawing failed")
            }
        }
    }
}

type GetProc = unsafe extern "C" fn(*const c_char) -> *const c_void;

type MakeCurrent = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *mut c_void) -> u32;
type CreateContext =
    unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *const i32) -> *mut c_void;
type CreatePbuffer = unsafe extern "C" fn(*mut c_void, *mut c_void, *const i32) -> *mut c_void;
/// `eglDestroyContext` and `eglDestroySurface`: a display and the handle.
type Destroy = unsafe extern "C" fn(*mut c_void, *mut c_void) -> u32;

/// ANGLE as the process has it: the two libraries (loaded once and never unloaded, so a thread that ends cannot take
/// them from the contexts of the others), the EGL entry points, and the initialised display and config (as addresses, so
/// the struct is `Sync`).
struct Shared {
    _egl: Library,
    _gles: Library,
    get_proc: GetProc,
    create_pbuffer: CreatePbuffer,
    create_context: CreateContext,
    make_current: MakeCurrent,
    destroy_context: Destroy,
    destroy_surface: Destroy,
    release_thread: unsafe extern "C" fn() -> u32,
    display: usize,
    config: usize,
    device: Device,
    /// Why this device: the platform's own, or what the ones before it lacked.
    why: String,
}

/// The process's ANGLE, made on first use; a failure to find it is kept, so a missing ANGLE is looked for once.
fn shared() -> Result<&'static Shared, String> {
    static SHARED: std::sync::OnceLock<Result<Shared, String>> = std::sync::OnceLock::new();
    SHARED.get_or_init(load).as_ref().map_err(Clone::clone)
}

/// An EGL display that would not start, with what is missing on the platform.
fn no_display(what: &str, device: Device) -> String {
    match device {
        Device::SwiftShader => format!(
            "{what}: the SwiftShader backend needs its driver library and ICD file beside libEGL (scripts/fetch-angle.mjs --swiftshader)"
        ),
        Device::Vulkan => format!("{what}: ANGLE's Vulkan backend found no Vulkan driver (Mesa lavapipe: mesa-vulkan-drivers and libvulkan1)"),
        Device::D3D11 => format!("{what}: ANGLE's Direct3D 11 backend found no hardware device"),
        Device::D3D11Warp => format!("{what}: ANGLE's Direct3D 11 backend found no device"),
        Device::Metal => what.to_string(),
    }
}

/// Whether the SwiftShader driver and its ICD file are beside libEGL in `dir`.
fn has_swiftshader(dir: &std::path::Path) -> bool {
    let driver = if cfg!(windows) {
        "vk_swiftshader.dll".into()
    } else {
        libloading::library_filename("vk_swiftshader")
    };
    dir.join(driver).is_file() && dir.join("vk_swiftshader_icd.json").is_file()
}

fn load() -> Result<Shared, String> {
    let dir = library_dir()?;
    // libGLESv2 first, by full path: libEGL then finds it already loaded instead of searching for it.
    let gles = open(&dir, "GLESv2")?;
    let egl = open(&dir, "EGL")?;
    macro_rules! sym {
        ($name:literal, $ty:ty) => {
            // SAFETY: the symbol is the EGL 1.5 function of this name with this signature.
            *unsafe { egl.get::<$ty>($name) }.map_err(|e| format!("libEGL: {e}"))?
        };
    }
    let get_platform_display = sym!(
        b"eglGetPlatformDisplay\0",
        unsafe extern "C" fn(Enum, *mut c_void, *const isize) -> *mut c_void
    );
    let initialize = sym!(
        b"eglInitialize\0",
        unsafe extern "C" fn(*mut c_void, *mut i32, *mut i32) -> u32
    );
    let get_error = sym!(b"eglGetError\0", unsafe extern "C" fn() -> i32);
    let bind_api = sym!(b"eglBindAPI\0", unsafe extern "C" fn(Enum) -> u32);
    let choose_config = sym!(
        b"eglChooseConfig\0",
        unsafe extern "C" fn(*mut c_void, *const i32, *mut *mut c_void, i32, *mut i32) -> u32
    );
    let create_pbuffer: CreatePbuffer = sym!(b"eglCreatePbufferSurface\0", CreatePbuffer);
    let create_context: CreateContext = sym!(b"eglCreateContext\0", CreateContext);
    let make_current: MakeCurrent = sym!(b"eglMakeCurrent\0", MakeCurrent);
    let destroy_context: Destroy = sym!(b"eglDestroyContext\0", Destroy);
    let destroy_surface: Destroy = sym!(b"eglDestroySurface\0", Destroy);
    let get_proc: GetProc = sym!(b"eglGetProcAddress\0", GetProc);
    let release_thread = sym!(b"eglReleaseThread\0", unsafe extern "C" fn() -> u32);

    // The device: the platform's own, else SwiftShader when its files are beside libEGL (a machine with no Vulkan
    // driver or no D3D11 hardware); `KINETOGRAPH_ANGLE_BACKEND` overrides (`angle_select.rs`).
    let backend = std::env::var("KINETOGRAPH_ANGLE_BACKEND").ok();
    let list = select::candidates(select::Os::this(), backend.as_deref(), has_swiftshader(&dir));
    let (device, (display, config), why) = select::pick(&list, backend.as_deref(), |device| {
        // EGL_PLATFORM_ANGLE_DEVICE_TYPE_ANGLE (0x3209) = HARDWARE (0x320A), WARP (0x320B) or SWIFTSHADER (0x3487).
        let (kind, device_type) = match device {
            Device::Metal => (EGL_PLATFORM_ANGLE_TYPE_METAL, EGL_NONE as isize),
            Device::Vulkan => (EGL_PLATFORM_ANGLE_TYPE_VULKAN, EGL_NONE as isize),
            Device::D3D11 => (EGL_PLATFORM_ANGLE_TYPE_D3D11, 0x320A),
            Device::D3D11Warp => (EGL_PLATFORM_ANGLE_TYPE_D3D11, 0x320B),
            Device::SwiftShader => (EGL_PLATFORM_ANGLE_TYPE_VULKAN, 0x3487),
        };
        let attribs: [isize; 5] = if device_type == EGL_NONE as isize {
            [EGL_PLATFORM_ANGLE_TYPE, kind, EGL_NONE as isize, EGL_NONE as isize, EGL_NONE as isize]
        } else {
            [EGL_PLATFORM_ANGLE_TYPE, kind, 0x3209, device_type, EGL_NONE as isize]
        };
        // SAFETY: each call below passes pointers to locals that outlive it and attribute lists ended by EGL_NONE; the
        // handles are the ones the previous calls returned and are checked before use.
        unsafe {
            let display = get_platform_display(EGL_PLATFORM_ANGLE_ANGLE, std::ptr::null_mut(), attribs.as_ptr());
            if display.is_null() {
                return Err("ANGLE gave no display".to_string());
            }
            let (mut major, mut minor) = (0, 0);
            if initialize(display, &mut major, &mut minor) == 0 {
                // ANGLE's own reason (a missing Vulkan extension, say) goes to stderr; the code says which EGL error it was.
                return Err(no_display(&format!("eglInitialize failed (EGL error {:#x})", get_error()), device));
            }
            bind_api(EGL_OPENGL_ES_API);
            // EGL_RENDERABLE_TYPE = ES3, SURFACE_TYPE = PBUFFER, 8 bits a channel.
            let config_attribs = [0x3040, 0x40, 0x3033, 1, 0x3024, 8, 0x3023, 8, 0x3022, 8, 0x3021, 8, EGL_NONE];
            let (mut config, mut n) = (std::ptr::null_mut(), 0);
            if choose_config(display, config_attribs.as_ptr(), &mut config, 1, &mut n) == 0 || n == 0 {
                return Err("no ES 3 pbuffer config".into());
            }
            Ok((display as usize, config as usize))
        }
    })?;
    Ok(Shared {
        _egl: egl,
        _gles: gles,
        get_proc,
        create_pbuffer,
        create_context,
        make_current,
        destroy_context,
        destroy_surface,
        release_thread,
        display,
        config,
        device,
        why,
    })
}

/// A context for `ext` on this thread, made current.
fn create(ext: Extensions) -> Result<Context, String> {
    let shared = shared()?;
    let (display, config) = (shared.display as *mut c_void, shared.config as *mut c_void);
    let get_proc = shared.get_proc;
    let make_current = shared.make_current;
    let (surface, context);
    // SAFETY: the display and config are the initialised ones of `load`; the attribute lists end with EGL_NONE and
    // outlive the calls; the handles are checked before use.
    unsafe {
        let pbuffer_attribs = [0x3057, 1, 0x3056, 1, EGL_NONE];
        surface = (shared.create_pbuffer)(display, config, pbuffer_attribs.as_ptr());
        // ES 3.0 with WebGL compatibility, client arrays and extensions off until requested, robust resource init.
        let context_attribs = [
            EGL_CONTEXT_MAJOR_VERSION,
            3,
            EGL_CONTEXT_MINOR_VERSION,
            0,
            EGL_CONTEXT_WEBGL_COMPATIBILITY_ANGLE,
            1,
            EGL_CONTEXT_CLIENT_ARRAYS_ENABLED_ANGLE,
            0,
            EGL_EXTENSIONS_ENABLED_ANGLE,
            0,
            EGL_ROBUST_RESOURCE_INITIALIZATION_ANGLE,
            1,
            EGL_NONE,
        ];
        context = (shared.create_context)(
            display,
            config,
            std::ptr::null_mut(),
            context_attribs.as_ptr(),
        );
        if context.is_null() {
            return Err("eglCreateContext failed".into());
        }
        if make_current(display, surface, surface, context) == 0 {
            return Err("eglMakeCurrent failed".into());
        }
    }
    let lookup = |name: &str| -> *const c_void {
        let Ok(c) = CString::new(name) else {
            return std::ptr::null();
        };
        // SAFETY: a NUL-terminated name; the current context is this thread's.
        unsafe { get_proc(c.as_ptr()) }
    };
    let gl = Gl {
        raw: Raw::load(&lookup)?,
        ptr: RawPtr::load(&lookup)?,
    };
    // A context made with WebGL compatibility keeps its extensions off until asked.
    for name in ["GL_EXT_color_buffer_float", "GL_KHR_debug"] {
        gl.request_extension(name);
    }
    if ext.float_blend {
        gl.request_extension("GL_EXT_float_blend");
    }
    if ext.float_linear {
        gl.request_extension("GL_OES_texture_float_linear");
    }
    // Asking for an extension this context cannot give leaves an error pending, which would be taken for the first
    // draw's: the context starts with none.
    for _ in 0..8 {
        if gl.get_error() == 0 {
            break;
        }
    }
    LIVE.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    Ok(Context {
        gl,
        display,
        surface,
        context,
        make_current,
        destroy_context: shared.destroy_context,
        destroy_surface: shared.destroy_surface,
    })
}

/// The compressed texture formats the raw texture calls can take on this machine, as the WebGL extensions that offer them: the
/// ones the ANGLE context can be asked for. Empty when ANGLE cannot start.
pub fn compressed_formats() -> Vec<&'static str> {
    let ext = Extensions { float_linear: false, float_blend: false };
    let Ok(have) = with(ext, |gl| gl.requestable_extensions()) else {
        return Vec::new();
    };
    let have: Vec<&str> = have.split_whitespace().collect();
    let all = |names: &[&str]| names.iter().all(|n| have.contains(n));
    let mut out = Vec::new();
    if all(&["GL_EXT_texture_compression_dxt1", "GL_ANGLE_texture_compression_dxt3", "GL_ANGLE_texture_compression_dxt5"]) {
        out.push("WEBGL_compressed_texture_s3tc");
    }
    if all(&["GL_EXT_texture_compression_bptc"]) {
        out.push("EXT_texture_compression_bptc");
    }
    if all(&["GL_EXT_texture_compression_rgtc"]) {
        out.push("EXT_texture_compression_rgtc");
    }
    if all(&["GL_ANGLE_compressed_texture_etc"]) {
        out.push("WEBGL_compressed_texture_etc");
    }
    if all(&["GL_KHR_texture_compression_astc_ldr"]) {
        out.push("WEBGL_compressed_texture_astc");
    }
    out
}

/// Asks the current context for every compressed texture extension it has (those it lacks leave nothing pending).
pub(crate) fn request_compressed(gl: &Gl) {
    for name in [
        "GL_EXT_texture_compression_dxt1",
        "GL_ANGLE_texture_compression_dxt3",
        "GL_ANGLE_texture_compression_dxt5",
        "GL_EXT_texture_compression_bptc",
        "GL_EXT_texture_compression_rgtc",
        "GL_ANGLE_compressed_texture_etc",
        "GL_KHR_texture_compression_astc_ldr",
    ] {
        gl.request_extension(name);
    }
    for _ in 0..16 {
        if gl.get_error() == 0 {
            break;
        }
    }
}
