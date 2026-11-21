//! Kept in its own file so that a test can include it (`crates/node/tests/drain_stderr.rs`).

use std::io::Read;

/// Reads `pipe` to its end into `raw`, through `read` and not `read_to_end`. On Windows std's `ChildStderr::read_to_end`
/// goes to `Handle::read_to_end`, which reads the overlapped pipe with `synchronous_read` (it aborts the process if the
/// read is still pending); `read` and `read_buf` use std's alertable `ReadFileEx` path for these pipes.
pub fn drain(pipe: &mut impl Read, raw: &mut Vec<u8>) {
    let mut chunk = [0u8; 4096];
    while let Ok(n) = pipe.read(&mut chunk) {
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&chunk[..n]);
    }
}
