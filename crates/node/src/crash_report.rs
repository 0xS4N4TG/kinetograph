//! A crash report for Windows: a vectored exception handler that, on a fatal exception (an access violation, an illegal
//! instruction, ...), writes where it happened to stderr, then lets the process die with the same code. Installed by the
//! addon when `KINETOGRAPH_CRASH_REPORT` is set (`kinetograph doctor` sets it in its child process), so that a driver
//! that kills the renderer leaves more than an exit code.
//!
//! Lines are `kinetograph-crash: ...`:
//!
//! ```text
//! kinetograph-crash: exception 0xC0000005 (access violation)
//! kinetograph-crash: at 0x00007FFB12345678 in kinetograph.win32-x64-msvc.node+0x1a2b3c
//! kinetograph-crash: access violation: write of address 0x0000000000000010
//! kinetograph-crash: stack (unwound from the exception's CONTEXT with RtlVirtualUnwind)
//! kinetograph-crash: frame 0 kinetograph.win32-x64-msvc.node+0x1a2b3c
//! kinetograph-crash: frame 1 kinetograph.win32-x64-msvc.node+0x2c3d4e
//! ```
//!
//! Modules are named by file name only (no directories). The handler allocates nothing: it formats into stack buffers
//! and the one saved `CONTEXT` is a static, so it also works on a damaged heap. It does take the loader lock to name a
//! module (`GetModuleHandleExW`), so a crash while another thread holds it could hang; the parent's timeout covers that.
//!
//! It is called after the other vectored handlers (so a runtime that handles its own faults, as V8 does for
//! WebAssembly, is not reported), but before frame-based (`__try`) handlers, so a fault that is caught further down is
//! reported too; that is why up to `MAX_REPORTS` are printed instead of one. A report is never printed from inside a
//! report (a fault of the handler itself).

use core::fmt::{self, Write};
#[cfg(target_arch = "x86_64")]
use core::mem::MaybeUninit;
use core::ptr;
use core::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use windows_sys::Win32::Foundation::HMODULE;
use windows_sys::Win32::Storage::FileSystem::WriteFile;
use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE};
use windows_sys::Win32::System::Diagnostics::Debug::{
    AddVectoredExceptionHandler, CONTEXT, EXCEPTION_CONTINUE_SEARCH, EXCEPTION_POINTERS,
};
use windows_sys::Win32::System::LibraryLoader::{
    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    GetModuleFileNameW, GetModuleHandleExW,
};

/// The exceptions that end a process, by NTSTATUS, with what they mean.
const FATAL: [(u32, &str); 6] = [
    (0xC000_0005, "access violation"),
    (0xC000_001D, "illegal instruction"),
    (0xC000_0006, "in-page error"),
    (0xC000_00FD, "stack overflow"),
    (0xC000_0096, "privileged instruction"),
    (0xC000_0094, "integer divide by zero"),
];

/// Frames to print; a deeper stack is cut.
#[cfg(target_arch = "x86_64")]
const MAX_FRAMES: usize = 32;

/// Reports to print in all: a fatal-looking exception that something further down handles is reported too, and the one
/// that kills the process comes after it.
const MAX_REPORTS: u32 = 4;

/// Set while a report is being written: a fault inside the handler is not reported again (it would recurse).
static REPORTING: AtomicBool = AtomicBool::new(false);

/// How many reports were started.
static REPORTS: AtomicU32 = AtomicU32::new(0);

/// The context the stack is unwound in (the handler's own copy: unwinding changes it). A static, so that the handler
/// uses no stack for it; it is only touched by the thread that holds `REPORTING`.
#[cfg(target_arch = "x86_64")]
static mut UNWIND: MaybeUninit<CONTEXT> = MaybeUninit::uninit();

/// Installs the handler if `KINETOGRAPH_CRASH_REPORT` is set (not empty, not `0`).
pub fn install_if_asked() {
    if std::env::var("KINETOGRAPH_CRASH_REPORT").is_ok_and(|v| !v.is_empty() && v != "0") {
        install();
    }
}

/// Installs the handler (last among the vectored handlers), once.
pub fn install() {
    static INSTALLED: AtomicBool = AtomicBool::new(false);
    if !INSTALLED.swap(true, Ordering::SeqCst) {
        // SAFETY: `handler` has the signature Windows calls it with and lives as long as the process.
        unsafe { AddVectoredExceptionHandler(0, Some(handler)) };
    }
}

/// A fixed buffer that `write!` fills (what does not fit is dropped): a line is built here, then written whole.
struct Line {
    bytes: [u8; 384],
    len: usize,
}

impl Line {
    fn new() -> Line {
        Line { bytes: [0; 384], len: 0 }
    }
    /// Writes the line to stderr with a newline, and empties it.
    fn emit(&mut self) {
        if self.len == self.bytes.len() {
            self.len -= 1;
        }
        self.bytes[self.len] = b'\n';
        self.len += 1;
        // SAFETY: a plain handle lookup, and a write of `len` bytes from a buffer that holds that many.
        unsafe {
            let handle = GetStdHandle(STD_ERROR_HANDLE);
            let mut written = 0u32;
            WriteFile(handle, self.bytes.as_ptr(), self.len as u32, &mut written, ptr::null_mut());
        }
        self.len = 0;
    }
}

impl Write for Line {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        let room = self.bytes.len() - 1 - self.len;
        let take = s.len().min(room);
        self.bytes[self.len..self.len + take].copy_from_slice(&s.as_bytes()[..take]);
        self.len += take;
        Ok(())
    }
}

/// The file name (no directory) of the module that holds `address` and the offset of `address` inside it, if any.
/// The name is written as UTF-8 into `name`, which it returns the length of.
fn module_of(address: usize, name: &mut [u8; 128]) -> Option<(usize, usize)> {
    let mut module: HMODULE = ptr::null_mut();
    // SAFETY: `address` is only compared with the loaded modules' ranges (FROM_ADDRESS), and the refcount is not
    // changed, so nothing is kept.
    let found = unsafe {
        GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            address as *const u16,
            &mut module,
        )
    };
    if found == 0 || module.is_null() {
        return None;
    }
    let mut wide = [0u16; 260];
    // SAFETY: `wide` holds the 260 units that are given as its size.
    let n = unsafe { GetModuleFileNameW(module, wide.as_mut_ptr(), wide.len() as u32) } as usize;
    let n = n.min(wide.len());
    let file = wide[..n].iter().rposition(|&c| c == b'\\' as u16 || c == b'/' as u16).map_or(0, |i| i + 1);
    let mut len = 0;
    for c in char::decode_utf16(wide[file..n].iter().copied()) {
        let c = c.unwrap_or('?');
        if len + c.len_utf8() > name.len() {
            break;
        }
        len += c.encode_utf8(&mut name[len..]).len();
    }
    Some((len, address - module as usize))
}

/// Writes `where` as `module+0xoffset`, or the bare address when no module holds it.
fn write_place(line: &mut Line, address: usize) {
    let mut name = [0u8; 128];
    match module_of(address, &mut name) {
        // `module_of` wrote whole UTF-8 characters into the first `len` bytes.
        Some((len, offset)) => {
            let _ = write!(line, "{}+{offset:#x}", core::str::from_utf8(&name[..len]).unwrap_or("?"));
        }
        None => {
            let _ = write!(line, "{address:#018X} (no module)");
        }
    }
}

/// The handler: reports a fatal exception, once, and always declines it (`EXCEPTION_CONTINUE_SEARCH`), so that the
/// exception goes on to whoever else handles it and the process dies as it would have.
unsafe extern "system" fn handler(info: *mut EXCEPTION_POINTERS) -> i32 {
    // SAFETY: Windows gives a valid `EXCEPTION_POINTERS` to a vectored handler.
    let (record, context) = unsafe { ((*info).ExceptionRecord, (*info).ContextRecord) };
    if record.is_null() {
        return EXCEPTION_CONTINUE_SEARCH;
    }
    // SAFETY: checked non-null; the record is valid for the call.
    let record = unsafe { &*record };
    let code = record.ExceptionCode as u32;
    let Some(&(_, meaning)) = FATAL.iter().find(|(c, _)| *c == code) else {
        return EXCEPTION_CONTINUE_SEARCH;
    };
    if REPORTING.swap(true, Ordering::SeqCst) {
        return EXCEPTION_CONTINUE_SEARCH;
    }
    if REPORTS.fetch_add(1, Ordering::SeqCst) >= MAX_REPORTS {
        REPORTING.store(false, Ordering::SeqCst);
        return EXCEPTION_CONTINUE_SEARCH;
    }
    let mut line = Line::new();
    let _ = write!(line, "kinetograph-crash: exception {code:#010X} ({meaning})");
    line.emit();
    let at = record.ExceptionAddress as usize;
    let _ = write!(line, "kinetograph-crash: at {at:#018X} in ");
    write_place(&mut line, at);
    line.emit();
    if (code == 0xC000_0005 || code == 0xC000_0006) && record.NumberParameters >= 2 {
        let what = match record.ExceptionInformation[0] {
            0 => "read of",
            1 => "write of",
            8 => "execute (DEP) of",
            _ => "access of",
        };
        let _ = write!(line, "kinetograph-crash: {meaning}: {what} address {:#018X}", record.ExceptionInformation[1]);
        if code == 0xC000_0006 && record.NumberParameters >= 3 {
            let _ = write!(line, ", NTSTATUS {:#010X}", record.ExceptionInformation[2] as u32);
        }
        line.emit();
    }
    if !context.is_null() {
        // SAFETY: the one use of `UNWIND`, by the thread that holds `REPORTING`; `context` is valid for the call.
        unsafe { stack(&mut line, context) };
    } else {
        let _ = write!(line, "kinetograph-crash: frame 0 ");
        write_place(&mut line, at);
        line.emit();
    }
    REPORTING.store(false, Ordering::SeqCst);
    EXCEPTION_CONTINUE_SEARCH
}

/// The frames of the stack, from the exception's `context`: for each, the instruction address as `module+0xoffset`.
/// Walks with the unwind tables (`RtlLookupFunctionEntry`, `RtlVirtualUnwind`), as the system does; a function with
/// no table entry is a leaf, whose return address is on top of the stack.
///
/// # Safety
/// `context` is a valid `CONTEXT`, and nothing else uses `UNWIND`.
#[cfg(target_arch = "x86_64")]
unsafe fn stack(line: &mut Line, context: *const CONTEXT) {
    use windows_sys::Win32::System::Diagnostics::Debug::{RtlLookupFunctionEntry, RtlVirtualUnwind, UNW_FLAG_NHANDLER};
    let _ = write!(line, "kinetograph-crash: stack (unwound from the exception's CONTEXT with RtlVirtualUnwind)");
    line.emit();
    // SAFETY: `UNWIND` is written once, here, and read through this pointer only.
    let walk = unsafe {
        let slot = (&raw mut UNWIND).cast::<CONTEXT>();
        ptr::copy_nonoverlapping(context, slot, 1);
        &mut *slot
    };
    for i in 0..MAX_FRAMES {
        let pc = walk.Rip;
        let _ = write!(line, "kinetograph-crash: frame {i} ");
        write_place(line, pc as usize);
        line.emit();
        let mut base = 0u64;
        // SAFETY: a lookup in the loaded modules' unwind tables; a null history table is allowed.
        let entry = unsafe { RtlLookupFunctionEntry(pc, &mut base, ptr::null_mut()) };
        if entry.is_null() {
            // A leaf function: no frame of its own, the return address is on top of the stack.
            let sp = walk.Rsp as usize;
            if sp == 0 || sp % 8 != 0 {
                break;
            }
            // SAFETY: `sp` is the stack pointer of the faulting thread, which holds at least a return address.
            walk.Rip = unsafe { *(sp as *const u64) };
            walk.Rsp += 8;
        } else {
            let mut data = ptr::null_mut();
            let mut frame = 0u64;
            // SAFETY: `entry` and `base` come from the lookup above for `pc`; `walk` is a context of this thread.
            unsafe { RtlVirtualUnwind(UNW_FLAG_NHANDLER, base, pc, entry, walk, &mut data, &mut frame, ptr::null_mut()) };
        }
        if walk.Rip == 0 {
            break;
        }
    }
}

/// Other architectures: the faulting frame only (the unwind above is for x86-64's tables).
///
/// # Safety
/// `context` is a valid `CONTEXT`.
#[cfg(not(target_arch = "x86_64"))]
unsafe fn stack(line: &mut Line, _context: *const CONTEXT) {
    let _ = write!(line, "kinetograph-crash: stack: not walked on this architecture");
    line.emit();
}
