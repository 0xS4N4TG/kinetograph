// Wraps a VkImage that wgpu owns as a Graphite backend texture. skia-safe 0.153 binds the Graphite Vulkan context
// (`C_ContextFactory_MakeVulkan`) but not `BackendTextures::MakeVulkan`, so this one call is made here and linked
// against the libskia that skia-bindings built. See render/skia/vulkan.rs.

#include "include/gpu/graphite/BackendTexture.h"
#include "include/gpu/graphite/vk/VulkanGraphiteTypes.h"

#include <cstdint>
#include <new>

// Constructs a `skgpu::graphite::BackendTexture` in `out` (uninitialised memory of that size, which Rust owns and later
// destroys with skia-safe's own `C_BackendTexture_destruct`). `layout` is the VkImageLayout the image is in when the
// recording that uses it starts; Skia keeps its own record of it from then on. The image is borrowed: Skia never frees
// it and uses no VulkanAlloc.
extern "C" void kg_vk_backend_texture(
    void* out,
    int width,
    int height,
    uint32_t format,
    uint32_t usage,
    uint32_t layout,
    uint32_t queueFamilyIndex,
    uint64_t image) {
    using namespace skgpu::graphite;
    VulkanTextureInfo info(
        VK_SAMPLE_COUNT_1_BIT,
        skgpu::Mipmapped::kNo,
        /*flags=*/0,
        static_cast<VkFormat>(format),
        VK_IMAGE_TILING_OPTIMAL,
        static_cast<VkImageUsageFlags>(usage),
        VK_SHARING_MODE_EXCLUSIVE,
        VK_IMAGE_ASPECT_COLOR_BIT,
        skgpu::VulkanYcbcrConversionInfo());
    new (out) BackendTexture(BackendTextures::MakeVulkan(
        SkISize::Make(width, height),
        info,
        static_cast<VkImageLayout>(layout),
        queueFamilyIndex,
        reinterpret_cast<VkImage>(image),
        skgpu::VulkanAlloc()));
}
