//! `diag::line` on a stderr that is an overlapped pipe whose reader is slow, so a write is still pending when the call
//! returns from `NtWriteFile`. `eprintln!` aborts the process there ("operation failed to complete synchronously");
//! `diag::line` waits for the write.
#![cfg(windows)]

use std::io::Read;
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::ptr::null;
use std::thread;
use std::time::Duration;

use windows_sys::Win32::Foundation::{GENERIC_WRITE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, PIPE_ACCESS_INBOUND,
};
use windows_sys::Win32::System::Console::{STD_ERROR_HANDLE, SetStdHandle};
use windows_sys::Win32::System::Pipes::{CreateNamedPipeW, PIPE_TYPE_BYTE, PIPE_WAIT};

#[test]
fn a_line_is_written_whole_to_an_overlapped_stderr_with_a_slow_reader() {
    let name: Vec<u16> = format!(r"\\.\pipe\kinetograph-diag-{}", std::process::id())
        .encode_utf16()
        .chain([0])
        .collect();
    // A 4 KiB buffer: a 1 MiB line cannot be written until the reader drains it.
    let server = unsafe {
        CreateNamedPipeW(name.as_ptr(), PIPE_ACCESS_INBOUND, PIPE_TYPE_BYTE | PIPE_WAIT, 1, 4096, 4096, 0, null())
    };
    assert_ne!(server, INVALID_HANDLE_VALUE);
    let writer = unsafe {
        CreateFileW(name.as_ptr(), GENERIC_WRITE, 0, null(), OPEN_EXISTING, FILE_FLAG_OVERLAPPED, std::ptr::null_mut())
    };
    assert_ne!(writer, INVALID_HANDLE_VALUE);
    assert_ne!(unsafe { SetStdHandle(STD_ERROR_HANDLE, writer) }, 0);

    let mut server = unsafe { std::fs::File::from_raw_handle(server as RawHandle) };
    let reader = thread::spawn(move || {
        thread::sleep(Duration::from_millis(300));
        let mut seen = Vec::new();
        let mut buf = [0u8; 8192];
        // The line ends with a newline; stop at it.
        while !seen.ends_with(b"\n") {
            let n = server.read(&mut buf).unwrap();
            assert_ne!(n, 0, "the pipe closed early");
            seen.extend_from_slice(&buf[..n]);
        }
        seen
    });

    let message = "x".repeat(1 << 20);
    kinetograph_core::diag::line(format_args!("{message}"));
    let seen = reader.join().unwrap();
    assert_eq!(seen.len(), message.len() + 1);
}
