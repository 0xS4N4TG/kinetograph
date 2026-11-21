//! Lines on stderr that are safe on every kind of handle.
//!
//! Rust's `eprintln!` on Windows writes to a pipe or file with `NtWriteFile` and waits on the handle itself. If the
//! handle was opened for overlapped I/O (a pipe a Node parent made for its child, or one a wrapper handed down) and the
//! write cannot finish at once, std's `synchronous_write` finds the status still pending and aborts the process
//! ("fatal runtime error: I/O error: operation failed to complete synchronously"). Here the Windows write is a
//! `WriteFile` with its own `OVERLAPPED` and event, which both kinds of handle accept, and a pending write is waited for.
//! Elsewhere it is `std`'s stderr. A closed or broken stderr is no reason to stop rendering, so errors are dropped.

use std::fmt;

/// Writes `args` and a newline to stderr, whole.
pub fn line(args: fmt::Arguments) {
    let text = format!("{args}\n");
    write_stderr(text.as_bytes());
}

#[cfg(not(windows))]
fn write_stderr(bytes: &[u8]) {
    use std::io::Write;
    let _ = std::io::stderr().lock().write_all(bytes);
}

#[cfg(windows)]
fn write_stderr(bytes: &[u8]) {
    use std::io::Write;
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_IO_PENDING, GetLastError, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::WriteFile;
    use windows_sys::Win32::System::Console::{GetConsoleMode, GetStdHandle, STD_ERROR_HANDLE};
    use windows_sys::Win32::System::IO::{GetOverlappedResult, OVERLAPPED};
    use windows_sys::Win32::System::Threading::CreateEventW;

    // SAFETY: plain handle queries.
    let handle = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return;
    }
    let mut mode = 0;
    // SAFETY: `mode` is a live u32.
    if unsafe { GetConsoleMode(handle, &mut mode) } != 0 {
        // A console is written with `WriteConsoleW`, which std does without a pending state.
        let _ = std::io::stderr().lock().write_all(bytes);
        return;
    }
    // SAFETY: an unnamed manual-reset event, closed below.
    let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if event.is_null() {
        return;
    }
    let mut rest = bytes;
    while !rest.is_empty() {
        // SAFETY: an all-zero OVERLAPPED is valid; both offsets set to u32::MAX mean "at the end of the file" for a
        // file and are ignored by a pipe, so a handle shared with another writer is appended to, not overwritten.
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = event;
        overlapped.Anonymous.Anonymous.Offset = u32::MAX;
        overlapped.Anonymous.Anonymous.OffsetHigh = u32::MAX;
        let len = rest.len().min(u32::MAX as usize) as u32;
        let mut written = 0u32;
        // SAFETY: `rest` and `overlapped` live until the write has finished: a pending one is waited for below.
        let ok = unsafe { WriteFile(handle, rest.as_ptr(), len, &mut written, &mut overlapped) };
        if ok == 0 {
            // SAFETY: reads the thread's last error.
            if unsafe { GetLastError() } != ERROR_IO_PENDING
                // SAFETY: waits for the write that `overlapped` started on `handle`.
                || unsafe { GetOverlappedResult(handle, &overlapped, &mut written, 1) } == 0
            {
                break;
            }
        }
        if written == 0 {
            break;
        }
        rest = &rest[written as usize..];
    }
    // SAFETY: the event made above.
    unsafe { CloseHandle(event) };
}
