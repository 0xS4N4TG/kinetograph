//! Which ANGLE device draws WebGL: pure choices, made from the environment's values and from what a probe found, so they
//! are tested without a GPU. `angle.rs` supplies the probes.
//!
//! `KINETOGRAPH_ANGLE_BACKEND`: `swiftshader` forces ANGLE's software Vulkan driver; `native` forbids falling back to it.
//! Neither reads the clock or the order of a run: the choice is made once per process from files and the environment.

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
