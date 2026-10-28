//! Why Skia's Graphite cannot start on a Vulkan device, as one sentence people can act on.
//!
//! Graphite's `make_vulkan` returns nothing when it refuses a device and says no more, so `vulkan.rs` collects what it
//! can learn about the device itself (`VulkanReport`) and this turns that into the reasons it can name. These checks
//! only *explain* a failure after Graphite has already refused: they never decide whether to start it, so a check that
//! is stricter than Graphite's own cannot switch the GPU off. The list is what Graphite is known to need (Vulkan 1.1,
//! the 1.1 core functions it loads, the two image formats it draws to as colour attachments that can also be sampled,
//! blitted and used as input attachments); what Graphite wants beyond it, the report cannot see.
//!
//! No Vulkan types are used, so the logic is tested on every platform; `vulkan.rs` fills the report in.

// Only the Vulkan backend (Linux, Windows) builds a report; the tests still run everywhere.
#![cfg_attr(target_os = "macos", allow(dead_code))]

/// `VkFormatFeatureFlagBits` Graphite needs of a format it draws to, by Vulkan's values.
const FORMAT_FEATURES: [(u32, &str); 6] = [
    (0x0000_0001, "SAMPLED_IMAGE"),
    (0x0000_0080, "COLOR_ATTACHMENT"),
    (0x0000_0100, "COLOR_ATTACHMENT_BLEND"),
    (0x0000_1000, "SAMPLED_IMAGE_FILTER_LINEAR"),
    (0x0000_4000, "TRANSFER_SRC"),
    (0x0000_8000, "TRANSFER_DST"),
];

/// The image usage a Skia target is made with (`vulkan.rs`'s `make_image`), for the message.
pub(super) const TARGET_USAGE: &str =
    "COLOR_ATTACHMENT | INPUT_ATTACHMENT | SAMPLED | TRANSFER_SRC | TRANSFER_DST";

/// A Vulkan version number as `major.minor.patch` (`VK_API_VERSION_*`'s encoding).
fn version(v: u32) -> String {
    format!("{}.{}.{}", v >> 22, (v >> 12) & 0x3ff, v & 0xfff)
}

/// `major.minor` of a Vulkan version number, as a number to compare (1.1 is 1_001).
fn major_minor(v: u32) -> u32 {
    (v >> 22) * 1000 + ((v >> 12) & 0x3ff)
}

/// What one image format can do on the device.
pub(super) struct FormatCaps {
    pub name: &'static str,
    /// `VkFormatProperties::optimalTilingFeatures`.
    pub features: u32,
    /// Whether a 2D optimal-tiling image with `TARGET_USAGE` can be created.
    pub target_usage_ok: bool,
}

/// What `vulkan.rs` learned about the device wgpu made.
pub(super) struct VulkanReport {
    pub device: String,
    /// The driver's name and info (`VK_KHR_driver_properties`), `""` if it would not say.
    pub driver: String,
    /// The version the device reports, the version of the instance (the loader's, capped as wgpu-hal caps it), and the
    /// one Skia is told it may use (the lower of those).
    pub device_api: u32,
    pub instance_api: u32,
    pub api_used: u32,
    /// Vulkan 1.1 core functions Skia loads that the device or instance did not resolve.
    pub missing_functions: Vec<String>,
    pub formats: Vec<FormatCaps>,
}

impl VulkanReport {
    /// The GPU and its driver, for a message: `Intel(R) Graphics (MTL), Mesa 24.2.1, Vulkan 1.3.274`.
    pub(super) fn describe(&self) -> String {
        let mut parts = vec![if self.device.is_empty() {
            "unnamed Vulkan device".to_string()
        } else {
            self.device.clone()
        }];
        if !self.driver.is_empty() {
            parts.push(self.driver.clone());
        }
        parts.push(format!("Vulkan {}", version(self.device_api)));
        parts.join(", ")
    }

    /// What is missing from what Graphite is known to need; empty if all of it is there.
    pub(super) fn problems(&self) -> Vec<String> {
        let mut out = Vec::new();
        if major_minor(self.api_used) < 1_001 {
            out.push(format!(
                "Vulkan {} is below the 1.1 Graphite needs (the device reports {}, the loader {})",
                version(self.api_used),
                version(self.device_api),
                version(self.instance_api)
            ));
        }
        for name in &self.missing_functions {
            out.push(format!(
                "the driver does not provide {name}, a Vulkan 1.1 function Graphite loads"
            ));
        }
        for format in &self.formats {
            let lacking: Vec<&str> = FORMAT_FEATURES
                .iter()
                .filter(|(bit, _)| format.features & bit == 0)
                .map(|(_, n)| *n)
                .collect();
            if !lacking.is_empty() {
                out.push(format!(
                    "{} images lack the format features {}",
                    format.name,
                    lacking.join(", ")
                ));
            }
            if !format.target_usage_ok {
                out.push(format!(
                    "{} images cannot be created with the usage {TARGET_USAGE} (Graphite needs INPUT_ATTACHMENT on every renderable image)",
                    format.name
                ));
            }
        }
        out
    }

    /// One sentence for why Graphite could not start on this device, at `step`.
    pub(super) fn explain(&self, step: &str) -> String {
        let problems = self.problems();
        if problems.is_empty() {
            format!(
                "Skia's Graphite would not start on {}: {step}. The Vulkan version, functions and image formats it is known to need are all present, so the driver is missing something Skia does not report (the Vulkan loader's VK_LOADER_DEBUG=all shows which layer or extension failed)",
                self.describe()
            )
        } else {
            format!(
                "Skia's Graphite cannot use the Vulkan device {}: {} ({step})",
                self.describe(),
                problems.join("; ")
            )
        }
    }
}

/// The reason when wgpu's device is not a Vulkan one at all (the GPU path runs on another API, or Vulkan found no GPU).
pub(super) fn not_vulkan() -> String {
    "wgpu is not running on a Vulkan device (no Vulkan driver or GPU was found, or wgpu chose another API), and Skia's GPU backend here is Vulkan".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn v(major: u32, minor: u32, patch: u32) -> u32 {
        (major << 22) | (minor << 12) | patch
    }

    const ALL: u32 = 0x1 | 0x80 | 0x100 | 0x1000 | 0x4000 | 0x8000;

    fn healthy() -> VulkanReport {
        VulkanReport {
            device: "Intel(R) Graphics (MTL)".into(),
            driver: "Mesa 24.2.1".into(),
            device_api: v(1, 3, 274),
            instance_api: v(1, 3, 280),
            api_used: v(1, 3, 274),
            missing_functions: Vec::new(),
            formats: vec![
                FormatCaps {
                    name: "R8G8B8A8_UNORM",
                    features: ALL,
                    target_usage_ok: true,
                },
                FormatCaps {
                    name: "R16G16B16A16_SFLOAT",
                    features: ALL,
                    target_usage_ok: true,
                },
            ],
        }
    }

    #[test]
    fn versions_read_as_major_minor_patch() {
        assert_eq!(version(v(1, 3, 274)), "1.3.274");
        assert_eq!(version(v(1, 0, 0)), "1.0.0");
        assert!(major_minor(v(1, 1, 0)) > major_minor(v(1, 0, 99)));
        assert!(major_minor(v(1, 4, 0)) > major_minor(v(1, 3, 281)));
    }

    #[test]
    fn a_device_with_everything_has_no_problems() {
        assert!(healthy().problems().is_empty());
        assert_eq!(
            healthy().describe(),
            "Intel(R) Graphics (MTL), Mesa 24.2.1, Vulkan 1.3.274"
        );
    }

    #[test]
    fn an_old_vulkan_is_named_with_the_loader_and_device_versions() {
        let mut r = healthy();
        r.device_api = v(1, 3, 274);
        r.instance_api = v(1, 0, 68);
        r.api_used = v(1, 0, 68);
        let problems = r.problems();
        assert_eq!(problems.len(), 1);
        assert!(
            problems[0].contains("1.0.68")
                && problems[0].contains("1.1")
                && problems[0].contains("loader"),
            "{problems:?}"
        );
    }

    #[test]
    fn missing_functions_are_named() {
        let mut r = healthy();
        r.missing_functions = vec![
            "vkBindImageMemory2".into(),
            "vkGetImageMemoryRequirements2".into(),
        ];
        let problems = r.problems();
        assert_eq!(problems.len(), 2);
        assert!(
            problems[0].contains("vkBindImageMemory2")
                && problems[1].contains("vkGetImageMemoryRequirements2"),
            "{problems:?}"
        );
    }

    #[test]
    fn a_format_lacking_features_names_each_of_them() {
        let mut r = healthy();
        // No blending and no linear filtering for the float format, as on some mobile GPUs.
        r.formats[1].features = ALL & !0x100 & !0x1000;
        let problems = r.problems();
        assert_eq!(problems.len(), 1);
        assert!(
            problems[0].starts_with("R16G16B16A16_SFLOAT images lack")
                && problems[0].contains("COLOR_ATTACHMENT_BLEND")
                && problems[0].contains("SAMPLED_IMAGE_FILTER_LINEAR")
                && !problems[0].contains("TRANSFER_SRC"),
            "{problems:?}"
        );
    }

    #[test]
    fn an_unusable_target_usage_names_the_usage() {
        let mut r = healthy();
        r.formats[0].target_usage_ok = false;
        let problems = r.problems();
        assert_eq!(problems.len(), 1);
        assert!(
            problems[0].contains("R8G8B8A8_UNORM") && problems[0].contains("INPUT_ATTACHMENT"),
            "{problems:?}"
        );
    }

    #[test]
    fn the_explanation_names_the_device_the_driver_and_every_problem() {
        let mut r = healthy();
        r.missing_functions = vec!["vkBindImageMemory2".into()];
        r.formats[0].target_usage_ok = false;
        let text = r.explain("Graphite refused to make a context");
        for want in [
            "Intel(R) Graphics (MTL)",
            "Mesa 24.2.1",
            "Vulkan 1.3.274",
            "vkBindImageMemory2",
            "INPUT_ATTACHMENT",
            "Graphite refused to make a context",
        ] {
            assert!(text.contains(want), "{want} missing from: {text}");
        }
    }

    #[test]
    fn when_every_check_passes_the_explanation_says_so_instead_of_inventing_a_cause() {
        let text = healthy().explain("Skia could not make a Vulkan context");
        assert!(
            text.contains("Intel(R) Graphics (MTL)") && text.contains("Mesa 24.2.1"),
            "{text}"
        );
        assert!(
            text.contains("known to need are all present") && text.contains("does not report"),
            "{text}"
        );
        assert!(
            text.contains("Skia could not make a Vulkan context"),
            "{text}"
        );
    }

    #[test]
    fn a_device_without_a_name_or_driver_still_reads() {
        let mut r = healthy();
        r.device.clear();
        r.driver.clear();
        assert_eq!(r.describe(), "unnamed Vulkan device, Vulkan 1.3.274");
    }

    #[test]
    fn a_non_vulkan_device_is_said_plainly() {
        assert!(not_vulkan().contains("not running on a Vulkan device"));
    }
}
