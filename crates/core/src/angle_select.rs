//! Which WebGL replay draws and, with ANGLE, which of its devices: pure choices, made from the environment's values and
//! from what a probe found, so they are tested without a GPU. `angle.rs` supplies the probes.
//!
//! `KINETOGRAPH_WEBGL`: unset or `auto` uses ANGLE when it loads and starts, else the built-in replay (one warning
//! saying why; never an error, as with the other backend fallbacks, `--strict` is about content); `angle` requires ANGLE
//! (a failure is an error at the first WebGL layer); anything else, `builtin` included, is the built-in replay.
//! `KINETOGRAPH_ANGLE_BACKEND`: `swiftshader` forces ANGLE's software Vulkan driver; `native` forbids falling back to it.
//! Neither reads the clock or the order of a run: the choice is made once per process from files and the environment.

/// The replay `KINETOGRAPH_WEBGL` asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Auto,
    Angle,
    Builtin,
}

pub fn mode(value: Option<&str>) -> Mode {
    match value {
        None | Some("") | Some("auto") => Mode::Auto,
        Some("angle") => Mode::Angle,
        Some(_) => Mode::Builtin,
    }
}

/// The replay in use and why, for `doctor` and the one warning.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub angle: bool,
    pub why: String,
    /// What to print once on stderr.
    pub warning: Option<String>,
}

/// `probe` starts ANGLE and says which device it got and why (`Err`: what failed).
pub fn decide(mode: Mode, probe: impl FnOnce() -> Result<String, String>) -> Decision {
    match mode {
        Mode::Builtin => Decision {
            angle: false,
            why: "KINETOGRAPH_WEBGL selects the built-in replay".into(),
            warning: None,
        },
        Mode::Angle => Decision {
            angle: true,
            why: "KINETOGRAPH_WEBGL=angle".into(),
            warning: None,
        },
        Mode::Auto => match probe() {
            Ok(why) => Decision { angle: true, why, warning: None },
            Err(e) => Decision {
                angle: false,
                why: format!("ANGLE is not usable here: {e}"),
                warning: Some(format!(
                    "kinetograph: WebGL uses the built-in replay, which draws less than ANGLE: {e} (KINETOGRAPH_WEBGL=builtin skips the ANGLE check)"
                )),
            },
        },
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Mac,
    Linux,
    Windows,
}

impl Os {
    pub fn this() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        }
    }
}

/// An ANGLE device.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Device {
    Metal,
    Vulkan,
    /// Direct3D 11 on a hardware device.
    D3D11,
    /// Direct3D 11 on WARP, Windows's software device.
    D3D11Warp,
    /// ANGLE's Vulkan backend on SwiftShader, the CPU rasteriser shipped beside libEGL.
    SwiftShader,
}

impl Device {
    pub fn name(self) -> &'static str {
        match self {
            Device::Metal => "Metal",
            Device::Vulkan => "Vulkan",
            Device::D3D11 => "D3D11",
            Device::D3D11Warp => "D3D11 (WARP, software)",
            Device::SwiftShader => "SwiftShader",
        }
    }
}

/// The devices to try, in order. A machine with no usable GPU device (no Vulkan driver, no D3D11 hardware) falls to
/// SwiftShader when its files are beside libEGL; Windows then still has WARP.
pub fn candidates(os: Os, backend: Option<&str>, swiftshader: bool) -> Vec<Device> {
    if backend == Some("swiftshader") {
        return vec![Device::SwiftShader];
    }
    let native = match os {
        Os::Mac => Device::Metal,
        Os::Linux => Device::Vulkan,
        Os::Windows => Device::D3D11,
    };
    let mut list = vec![native];
    if backend == Some("native") {
        return list;
    }
    if swiftshader && os != Os::Mac {
        list.push(Device::SwiftShader);
    }
    if os == Os::Windows {
        list.push(Device::D3D11Warp);
    }
    list
}

/// Tries each device with `start` until one works. Returns it, what it made and the reason, which names what the devices before it
/// said when it was not the first.
pub fn pick<T>(
    list: &[Device],
    backend: Option<&str>,
    mut start: impl FnMut(Device) -> Result<T, String>,
) -> Result<(Device, T, String), String> {
    let mut failed: Vec<String> = Vec::new();
    for &device in list {
        match start(device) {
            Ok(made) => {
                let why = if backend == Some("swiftshader") && device == Device::SwiftShader {
                    "forced by KINETOGRAPH_ANGLE_BACKEND=swiftshader".to_string()
                } else if failed.is_empty() {
                    format!("the platform's own device ({})", device.name())
                } else {
                    format!("{} so {}", failed.join("; "), device.name())
                };
                return Ok((device, made, why));
            }
            Err(e) => failed.push(format!("{} did not start ({e})", device.name())),
        }
    }
    Err(failed.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mode_names() {
        assert_eq!(mode(None), Mode::Auto);
        assert_eq!(mode(Some("")), Mode::Auto);
        assert_eq!(mode(Some("auto")), Mode::Auto);
        assert_eq!(mode(Some("angle")), Mode::Angle);
        assert_eq!(mode(Some("builtin")), Mode::Builtin);
        assert_eq!(mode(Some("wgpu")), Mode::Builtin);
    }

    #[test]
    fn auto_uses_angle_when_it_starts_and_warns_once_when_it_does_not() {
        let ok = decide(Mode::Auto, || Ok("Metal".into()));
        assert!(ok.angle && ok.warning.is_none());
        let bad = decide(Mode::Auto, || Err("no libEGL".into()));
        assert!(!bad.angle);
        assert!(bad.warning.unwrap().contains("no libEGL"));
    }

    #[test]
    fn builtin_and_angle_do_not_probe() {
        let never = || -> Result<String, String> { panic!("probed") };
        assert!(!decide(Mode::Builtin, never).angle);
        assert!(decide(Mode::Angle, never).angle);
    }

    #[test]
    fn candidates_by_platform() {
        use Device::*;
        assert_eq!(candidates(Os::Mac, None, true), [Metal]);
        assert_eq!(candidates(Os::Linux, None, false), [Vulkan]);
        assert_eq!(candidates(Os::Linux, None, true), [Vulkan, SwiftShader]);
        assert_eq!(candidates(Os::Windows, None, true), [D3D11, SwiftShader, D3D11Warp]);
        assert_eq!(candidates(Os::Windows, None, false), [D3D11, D3D11Warp]);
        assert_eq!(candidates(Os::Linux, Some("swiftshader"), false), [SwiftShader]);
        assert_eq!(candidates(Os::Windows, Some("native"), true), [D3D11]);
    }

    #[test]
    fn a_machine_without_a_gpu_device_falls_to_swiftshader() {
        let list = candidates(Os::Linux, None, true);
        let (device, _, why) = pick(&list, None, |d| match d {
            Device::Vulkan => Err("no Vulkan driver".to_string()),
            _ => Ok(()),
        })
        .unwrap();
        assert_eq!(device, Device::SwiftShader);
        assert!(why.contains("no Vulkan driver") && why.contains("SwiftShader"), "{why}");
    }

    #[test]
    fn the_first_device_that_starts_wins_and_none_is_an_error() {
        let list = candidates(Os::Windows, None, true);
        let (device, _, _) = pick(&list, None, |_| Ok(())).unwrap();
        assert_eq!(device, Device::D3D11);
        let err = pick(&list, None, |_| Err::<(), _>("x".to_string())).unwrap_err();
        assert!(err.contains("D3D11") && err.contains("SwiftShader"), "{err}");
    }
}
