//! Kept in its own file so that a test can include it (`crates/node/tests/drain_stderr.rs`).

use std::io::{ErrorKind, Read};

/// Reads `pipe` to its end into `raw`, through `read` and not `read_to_end`. On Windows std's `ChildStderr::read_to_end`
/// goes to `Handle::read_to_end`, which reads the overlapped pipe with `synchronous_read` (it aborts the process if the
/// read is still pending); `read` and `read_buf` use std's alertable `ReadFileEx` path for these pipes. Like
/// `read_to_end`, it retries `Interrupted` and stops at end of file or on any other error.
pub fn drain(pipe: &mut impl Read, raw: &mut Vec<u8>) {
    let mut chunk = [0u8; 4096];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => raw.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::drain;
    use std::io::{Error, ErrorKind, Read};

    /// Returns each step in turn: `None` is `Interrupted`, `Some(bytes)` is a read of `bytes`; then end of file.
    struct Steps(Vec<Option<&'static [u8]>>);

    impl Read for Steps {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.0.is_empty() {
                return Ok(0);
            }
            match self.0.remove(0) {
                None => Err(Error::from(ErrorKind::Interrupted)),
                Some(bytes) => {
                    buf[..bytes.len()].copy_from_slice(bytes);
                    Ok(bytes.len())
                }
            }
        }
    }

    #[test]
    fn an_interrupted_read_is_retried() {
        let mut raw = Vec::new();
        drain(&mut Steps(vec![None, Some(b"frame=1"), Some(b" frame=2")]), &mut raw);
        assert_eq!(raw, b"frame=1 frame=2");
    }
}
