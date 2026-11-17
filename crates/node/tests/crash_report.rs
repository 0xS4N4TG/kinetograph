//! The Windows crash report (`src/crash_report.rs`), tested on a process that crashes on purpose: this test binary runs
//! itself as a child that installs the handler and writes to an invalid address. The module is included as a file, so
//! that the addon (a `cdylib`) needs no test-only export.
#![cfg(windows)]

#[allow(dead_code)]
#[path = "../src/crash_report.rs"]
mod crash_report;

use std::process::Command;

const CHILD: &str = "KINETOGRAPH_CRASH_TEST_CHILD";
const TEST: &str = "a_fatal_exception_is_reported_and_still_kills_the_process";

#[test]
fn a_fatal_exception_is_reported_and_still_kills_the_process() {
    if std::env::var_os(CHILD).is_some() {
        crash_report::install();
        // Not null itself, so that a debug build's pointer check does not stop it before the CPU does.
        let near_null = std::ptr::without_provenance_mut::<u8>(0x10);
        // SAFETY: not safe, on purpose: this is the crash the parent checks the report of.
        unsafe { near_null.write_volatile(1) };
        unreachable!("the write to address 0x10 returned");
    }
    let out = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", TEST, "--nocapture", "--test-threads=1"])
        .env(CHILD, "1")
        .output()
        .unwrap();
    let report = String::from_utf8_lossy(&out.stderr);
    // The process still dies with the access violation.
    assert_eq!(out.status.code(), Some(0xC000_0005_u32 as i32), "{report}");
    assert_eq!(report.matches("kinetograph-crash: exception 0xC0000005 (access violation)").count(), 1, "{report}");
    assert!(report.contains("access violation: write of address 0x0000000000000010"), "{report}");
    // The place is a module file name and an offset, with no directory.
    let at = report.lines().find(|l| l.starts_with("kinetograph-crash: at ")).expect(&report);
    assert!(at.contains(".exe+0x") && !at.contains('\\'), "{at}");
    // At least the faulting frame.
    assert!(report.lines().any(|l| l.starts_with("kinetograph-crash: frame 0 ") && l.contains(".exe+0x")), "{report}");
}
