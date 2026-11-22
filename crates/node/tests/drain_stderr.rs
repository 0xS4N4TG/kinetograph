//! `drain` (`crates/cli/src/drain.rs`) on the stderr of a child that writes many small chunks with pauses between
//! them, as ffmpeg's progress does for a whole render. The pipe is std's overlapped one; `read_to_end` on it goes through
//! `synchronous_read`, which aborts the process if a read is still pending.
//!
//! This cannot prove the race away: it is rare per read and depends on timing, so a pass shows that `drain` collects
//! everything over a few seconds of reads without aborting, not that no schedule aborts. The module is included as a
//! file, as in `crash_report.rs`; the child is this test binary.
#![cfg(windows)]

#[path = "../../cli/src/drain.rs"]
mod drain;

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;

const CHILD: &str = "KINETOGRAPH_DRAIN_TEST_CHILD";
const TEST: &str = "a_child_that_writes_stderr_slowly_is_drained_whole";
const CHUNKS: usize = 60;
const LINE: &str = "frame=  123 fps= 30 q=-1.0 size=    1024kB time=00:00:04.10 bitrate=2048.0kbits/s speed=1.0x\r";

#[test]
fn a_child_that_writes_stderr_slowly_is_drained_whole() {
    if std::env::var_os(CHILD).is_some() {
        let mut err = std::io::stderr();
        for _ in 0..CHUNKS {
            err.write_all(LINE.as_bytes()).unwrap();
            std::thread::sleep(Duration::from_millis(80));
        }
        return;
    }
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", TEST, "--nocapture", "--test-threads=1"])
        .env(CHILD, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut err = child.stderr.take().unwrap();
    let mut raw = Vec::new();
    drain::drain(&mut err, &mut raw);
    assert!(child.wait().unwrap().success());
    let text = String::from_utf8_lossy(&raw);
    assert_eq!(text.matches(LINE).count(), CHUNKS, "{text}");
}
