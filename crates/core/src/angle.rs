//! ANGLE as a library: `libEGL` and `libGLESv2` loaded at run time, an offscreen OpenGL ES 3.0 context with ANGLE's
//! WebGL compatibility on, and the GL entry points a replay needs (`angle_replay.rs`). Opt in with
//! `KINETOGRAPH_WEBGL=angle`; `KINETOGRAPH_ANGLE_DIR` is the folder holding the two libraries.
//!
//! All `unsafe` of the ANGLE path is here. The invariants, once: the libraries are loaded for the life of the
//! process (a `Library` kept beside the pointers taken from it), every pointer is checked non-null when it is
//! loaded, a context is current on one thread only (it is a `thread_local`), and every wrapper that takes bytes
//! takes a slice and passes its length, so GL reads or writes within it.

use std::cell::RefCell;
use std::ffi::{CString, c_char, c_void};
use std::path::PathBuf;

use libloading::Library;

pub type Enum = u32;

// EGL
const EGL_PLATFORM_ANGLE_ANGLE: Enum = 0x3202;
const EGL_PLATFORM_ANGLE_TYPE: isize = 0x3203;
const EGL_PLATFORM_ANGLE_TYPE_METAL: isize = 0x3489;
const EGL_PLATFORM_ANGLE_TYPE_VULKAN: isize = 0x3450;
const EGL_PLATFORM_ANGLE_TYPE_D3D11: isize = 0x3208;
const EGL_NONE: i32 = 0x3038;
const EGL_OPENGL_ES_API: Enum = 0x30A0;

// GL, the ones the replay names.
pub mod gl {
    use super::Enum;
    pub const FALSE: u8 = 0;
    pub const TRUE: u8 = 1;
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
    get_string: unsafe extern "C" fn(Enum) -> *const u8,
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
    gen_renderbuffers: unsafe extern "C" fn(i32, *mut u32),
    delete_renderbuffers: unsafe extern "C" fn(i32, *const u32),
    gen_framebuffers: unsafe extern "C" fn(i32, *mut u32),
    delete_framebuffers: unsafe extern "C" fn(i32, *const u32),
    draw_buffers: unsafe extern "C" fn(i32, *const Enum),
    read_pixels: unsafe extern "C" fn(i32, i32, i32, i32, Enum, Enum, *mut c_void),
    draw_elements: unsafe extern "C" fn(Enum, i32, Enum, usize),
    draw_elements_instanced: unsafe extern "C" fn(Enum, i32, Enum, usize, i32),
    request_extension: unsafe extern "C" fn(*const c_char),
}

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
            get_string: load!(lookup, "glGetString"),
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
            gen_renderbuffers: load!(lookup, "glGenRenderbuffers"),
            delete_renderbuffers: load!(lookup, "glDeleteRenderbuffers"),
            gen_framebuffers: load!(lookup, "glGenFramebuffers"),
            delete_framebuffers: load!(lookup, "glDeleteFramebuffers"),
            draw_buffers: load!(lookup, "glDrawBuffers"),
            read_pixels: load!(lookup, "glReadPixels"),
            draw_elements: load!(lookup, "glDrawElements"),
            draw_elements_instanced: load!(lookup, "glDrawElementsInstanced"),
            request_extension: load!(lookup, "glRequestExtensionANGLE"),
        })
    }
}

/// An active uniform of a linked program.
pub struct ActiveUniform {
    pub name: String,
    pub size: i32,
    pub ty: Enum,
}

/// The kinds of data a texture upload takes.
pub struct Texels<'a> {
    pub format: Enum,
    pub ty: Enum,
    pub bytes: &'a [u8],
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

    pub fn string(&self, name: Enum) -> String {
        // SAFETY: `glGetString` returns a NUL-terminated string owned by the context, or null.
        unsafe {
            let p = (self.ptr.get_string)(name);
            if p.is_null() {
                String::new()
            } else {
                std::ffi::CStr::from_ptr(p.cast())
                    .to_string_lossy()
                    .into_owned()
            }
        }
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
    ) {
        // SAFETY: GL reads `w * h * d` texels of the format from the slice (the caller sizes it so).
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
    ) {
        let (format, ty, data) = match &texels {
            Some(t) => (t.format, t.ty, t.bytes.as_ptr().cast()),
            None => (gl::RGBA, gl::UNSIGNED_BYTE, std::ptr::null()),
        };
        // SAFETY: GL reads `w * h` texels of `format` and `ty` from the slice (the caller sizes it so), or none.
        unsafe {
            (self.ptr.tex_image_2d)(target, level, internal as i32, w, h, 0, format, ty, data)
        }
    }
    pub fn tex_sub_image_2d(&self, level: i32, (x, y, w, h): (i32, i32, i32, i32), texels: Texels) {
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
    }
    pub fn draw_buffers(&self, buffers: &[Enum]) {
        // SAFETY: GL reads `buffers.len()` enums.
        unsafe { (self.ptr.draw_buffers)(buffers.len() as i32, buffers.as_ptr()) }
    }
    /// RGBA8 rows from the bottom of the read framebuffer.
    pub fn read_pixels(&self, (w, h): (i32, i32), out: &mut [u8]) {
        assert!(out.len() >= (w * h * 4) as usize, "a read buffer too small");
        // SAFETY: the assert above: GL writes `w * h * 4` bytes into `out`.
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
    // The libraries stay loaded as long as the context.
    _egl: Library,
    _gles: Library,
}

thread_local! {
    /// One context for each thread that paints: ANGLE contexts are current on one thread at a time.
    static CONTEXT: RefCell<Option<Context>> = const { RefCell::new(None) };
}

/// Whether `KINETOGRAPH_WEBGL=angle` asks for the ANGLE replay.
pub fn enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("KINETOGRAPH_WEBGL").is_ok_and(|v| v == "angle"))
}

/// Runs `f` with this thread's context, made on first use.
pub fn with<T>(f: impl FnOnce(&Gl) -> T) -> Result<T, String> {
    CONTEXT.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(create()?);
        }
        Ok(f(&slot.as_ref().expect("made above").gl))
    })
}

/// `KINETOGRAPH_ANGLE_DIR` or the folder beside the addon: always an absolute path. The libraries are loaded by full
/// path and never by a bare name, so neither the system's search path nor the working directory (a project folder
/// could hold a planted `libEGL`) decides which ones are loaded.
fn library_dir() -> Result<PathBuf, String> {
    match std::env::var_os("KINETOGRAPH_ANGLE_DIR") {
        Some(dir) => checked_dir(PathBuf::from(dir)),
        None => addon_dir()
            .map(|d| d.join("angle"))
            .ok_or_else(|| "ANGLE is not available: set KINETOGRAPH_ANGLE_DIR to the folder holding libEGL and libGLESv2".to_string()),
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

fn open(dir: &std::path::Path, name: &str) -> Result<Library, String> {
    let path = dir.join(libloading::library_filename(name));
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
    use super::checked_dir;
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
}

type GetProc = unsafe extern "C" fn(*const c_char) -> *const c_void;

fn create() -> Result<Context, String> {
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
    let bind_api = sym!(b"eglBindAPI\0", unsafe extern "C" fn(Enum) -> u32);
    let choose_config = sym!(
        b"eglChooseConfig\0",
        unsafe extern "C" fn(*mut c_void, *const i32, *mut *mut c_void, i32, *mut i32) -> u32
    );
    let create_pbuffer = sym!(
        b"eglCreatePbufferSurface\0",
        unsafe extern "C" fn(*mut c_void, *mut c_void, *const i32) -> *mut c_void
    );
    let create_context = sym!(
        b"eglCreateContext\0",
        unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *const i32) -> *mut c_void
    );
    let make_current = sym!(
        b"eglMakeCurrent\0",
        unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *mut c_void) -> u32
    );
    let get_proc: GetProc = sym!(b"eglGetProcAddress\0", GetProc);

    let backend = if cfg!(target_os = "macos") {
        EGL_PLATFORM_ANGLE_TYPE_METAL
    } else if cfg!(windows) {
        EGL_PLATFORM_ANGLE_TYPE_D3D11
    } else {
        EGL_PLATFORM_ANGLE_TYPE_VULKAN
    };
    let display_attribs: [isize; 3] = [EGL_PLATFORM_ANGLE_TYPE, backend, EGL_NONE as isize];
    // SAFETY: each call below passes pointers to locals that outlive it and attribute lists ended by EGL_NONE; the
    // handles are the ones the previous calls returned and are checked before use.
    unsafe {
        let display = get_platform_display(
            EGL_PLATFORM_ANGLE_ANGLE,
            std::ptr::null_mut(),
            display_attribs.as_ptr(),
        );
        if display.is_null() {
            return Err("ANGLE gave no display".into());
        }
        let (mut major, mut minor) = (0, 0);
        if initialize(display, &mut major, &mut minor) == 0 {
            return Err("eglInitialize failed".into());
        }
        bind_api(EGL_OPENGL_ES_API);
        // EGL_RENDERABLE_TYPE = ES3, SURFACE_TYPE = PBUFFER, 8 bits a channel.
        let config_attribs = [
            0x3040, 0x40, 0x3033, 1, 0x3024, 8, 0x3023, 8, 0x3022, 8, 0x3021, 8, EGL_NONE,
        ];
        let (mut config, mut n) = (std::ptr::null_mut(), 0);
        if choose_config(display, config_attribs.as_ptr(), &mut config, 1, &mut n) == 0 || n == 0 {
            return Err("no ES 3 pbuffer config".into());
        }
        let pbuffer_attribs = [0x3057, 1, 0x3056, 1, EGL_NONE];
        let surface = create_pbuffer(display, config, pbuffer_attribs.as_ptr());
        // ES 3.0; EGL_CONTEXT_WEBGL_COMPATIBILITY_ANGLE; EGL_CONTEXT_OPENGL_ROBUST_ACCESS-free; extensions off until
        // requested (EGL_EXTENSIONS_ENABLED_ANGLE); EGL_ROBUST_RESOURCE_INITIALIZATION_ANGLE.
        let context_attribs = [
            0x3098, 3, 0x30FB, 0, 0x33AC, 1, 0x3459, 0, 0x3453, 1, EGL_NONE,
        ];
        let context = create_context(
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
    Ok(Context {
        gl,
        _egl: egl,
        _gles: gles,
    })
}
