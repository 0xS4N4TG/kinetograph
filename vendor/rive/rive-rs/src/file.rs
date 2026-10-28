use alloc::sync::Arc;
use core::{fmt, marker::PhantomData, ptr};

use crate::{
    ffi::{self},
    renderer::Renderer,
};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Error {
    /// Indicates that the Rive file is not supported by this runtime.
    UnsupportedVersion,
    /// Indicates that the there is a formatting problem in the file itself.
    Malformed,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::UnsupportedVersion => f.write_str("unsupported Rive version"),
            Error::Malformed => f.write_str("file is incorrectly encoded"),
        }
    }
}

impl core::error::Error for Error {}

#[derive(Debug)]
pub(crate) struct FileInner {
    pub raw_file: *const ffi::File,
    raw_factory: *mut ffi::Factory,
}

impl Drop for FileInner {
    fn drop(&mut self) {
        unsafe {
            ffi::rive_rs_file_release(self.raw_file, self.raw_factory);
        }
    }
}

unsafe impl Send for FileInner {}
unsafe impl Sync for FileInner {}

pub struct File<R: Renderer> {
    inner: Arc<FileInner>,
    _phantom: PhantomData<R>,
}

impl<R: Renderer> File<R> {
    #[inline]
    pub fn new(data: &[u8]) -> Result<Self, Error> {
        let mut result = ffi::FileResult::Success;
        let mut raw_factory = ptr::null_mut();

        let raw_file = unsafe {
            ffi::rive_rs_file_new(
                data.as_ptr(),
                data.len(),
                ffi::RendererEntries::<R>::ENTRIES as *const ffi::RendererEntries<R> as *const (),
                &mut result as *mut ffi::FileResult,
                &mut raw_factory as *mut *mut ffi::Factory,
            )
        };

        match result {
            ffi::FileResult::Success => Ok(Self {
                inner: Arc::new(FileInner {
                    raw_file,
                    raw_factory,
                }),
                _phantom: PhantomData,
            }),
            ffi::FileResult::UnsupportedVersion => Err(Error::UnsupportedVersion),
            ffi::FileResult::Malformed => Err(Error::Malformed),
        }
    }

    /// Kinetograph: imports the file with `load` deciding each asset. `load` is told the asset and its in-band bytes
    /// (empty for an asset outside the file) and answers the bytes to decode instead, or `None` to leave it to the
    /// runtime (which decodes in-band bytes and leaves the rest empty).
    pub fn new_with_assets(
        data: &[u8],
        load: &mut dyn FnMut(&AssetRequest<'_>) -> Option<alloc::vec::Vec<u8>>,
    ) -> Result<Self, Error> {
        struct Context<'a> {
            load: &'a mut dyn FnMut(&AssetRequest<'_>) -> Option<alloc::vec::Vec<u8>>,
            kept: alloc::vec::Vec<alloc::vec::Vec<u8>>,
        }
        unsafe extern "C" fn callback(
            context: *mut core::ffi::c_void,
            kind: u8,
            unique_filename: *const u8,
            unique_filename_len: usize,
            name: *const u8,
            name_len: usize,
            extension: *const u8,
            extension_len: usize,
            cdn_uuid: *const u8,
            cdn_uuid_len: usize,
            in_band: *const u8,
            in_band_len: usize,
            data: *mut *const u8,
            len: *mut usize,
        ) -> bool {
            let text = |ptr: *const u8, len: usize| unsafe {
                if ptr.is_null() || len == 0 {
                    ""
                } else {
                    core::str::from_utf8(core::slice::from_raw_parts(ptr, len)).unwrap_or("")
                }
            };
            let context = unsafe { &mut *(context as *mut Context<'_>) };
            let request = AssetRequest {
                kind: match kind {
                    0 => AssetKind::Image,
                    1 => AssetKind::Font,
                    2 => AssetKind::Audio,
                    _ => AssetKind::Other,
                },
                unique_filename: text(unique_filename, unique_filename_len),
                name: text(name, name_len),
                extension: text(extension, extension_len),
                cdn_uuid: text(cdn_uuid, cdn_uuid_len),
                in_band: if in_band.is_null() || in_band_len == 0 {
                    &[]
                } else {
                    unsafe { core::slice::from_raw_parts(in_band, in_band_len) }
                },
            };
            match (context.load)(&request) {
                Some(bytes) => {
                    // Kept until the import is over: the runtime copies what it decodes.
                    context.kept.push(bytes);
                    let kept = context.kept.last().unwrap();
                    unsafe {
                        *data = kept.as_ptr();
                        *len = kept.len();
                    }
                    true
                }
                None => false,
            }
        }

        let mut context = Context {
            load,
            kept: alloc::vec::Vec::new(),
        };
        let mut result = ffi::FileResult::Success;
        let mut raw_factory = ptr::null_mut();
        let raw_file = unsafe {
            ffi::rive_rs_file_new_with_assets(
                data.as_ptr(),
                data.len(),
                ffi::RendererEntries::<R>::ENTRIES as *const ffi::RendererEntries<R> as *const (),
                &mut result as *mut ffi::FileResult,
                &mut raw_factory as *mut *mut ffi::Factory,
                &mut context as *mut Context<'_> as *mut core::ffi::c_void,
                callback,
            )
        };
        match result {
            ffi::FileResult::Success => Ok(Self {
                inner: Arc::new(FileInner {
                    raw_file,
                    raw_factory,
                }),
                _phantom: PhantomData,
            }),
            ffi::FileResult::UnsupportedVersion => Err(Error::UnsupportedVersion),
            ffi::FileResult::Malformed => Err(Error::Malformed),
        }
    }

    /// Kinetograph: the artboards, with their animations, state machines and inputs, as JSON.
    pub fn describe(&self) -> alloc::string::String {
        unsafe extern "C" fn write(context: *mut core::ffi::c_void, text: *const u8, len: usize) {
            let out = unsafe { &mut *(context as *mut alloc::string::String) };
            let bytes = unsafe { core::slice::from_raw_parts(text, len) };
            out.push_str(core::str::from_utf8(bytes).unwrap_or(""));
        }
        let mut out = alloc::string::String::new();
        unsafe {
            ffi::rive_rs_file_describe(
                self.inner.raw_file,
                write,
                &mut out as *mut alloc::string::String as *mut core::ffi::c_void,
            );
        }
        out
    }

    pub(crate) fn as_inner(&self) -> &Arc<FileInner> {
        &self.inner
    }
}

impl<R: Renderer> fmt::Debug for File<R> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("File").finish()
    }
}

/// Kinetograph: what kind of asset a file names.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AssetKind {
    Image,
    Font,
    Audio,
    Other,
}

/// Kinetograph: an asset of a file being imported, as `File::new_with_assets` hands it to its loader.
#[derive(Debug)]
pub struct AssetRequest<'a> {
    pub kind: AssetKind,
    /// `name-id.ext`, the name the Rive editor gives a referenced asset's file.
    pub unique_filename: &'a str,
    pub name: &'a str,
    pub extension: &'a str,
    /// The asset's id on Rive's CDN, empty when it has none.
    pub cdn_uuid: &'a str,
    /// The bytes in the file; empty for an asset outside it.
    pub in_band: &'a [u8],
}
