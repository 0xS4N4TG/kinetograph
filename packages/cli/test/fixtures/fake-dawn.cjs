// A stand-in for dawn.node (KINETOGRAPH_DAWN_MODULE) whose adapters are the drivers the Vulkan loader would find, read from the environment at the
// first requestAdapter of an instance and kept for it, as dawn.node does (its Vulkan instance is made then, not at create()). The host is FAKE_VULKAN_HOST (`gpu`, `gpu-dawn-refuses`: a GPU Dawn lists no adapter for,
// `lavapipe`; comma separated) and FAKE_VULKAN_LOADER `old` (1.3.204, Ubuntu 22.04: reads VK_ICD_FILENAMES only) or `new` (reads VK_DRIVER_FILES
// and puts VK_ADD_DRIVER_FILES first). Dawn's answers are the ones it gave in an Ubuntu container: a fallback request takes the first CPU
// adapter, any other request the first GPU's, else the first CPU adapter.
'use strict';

const ADAPTERS = {
  gpu: { info: { vendor: 'nvidia', architecture: 'ada', device: 'GeForce', description: '' }, cpu: false },
  lavapipe: { info: { vendor: 'mesa', architecture: 'software', device: 'llvmpipe', description: 'llvmpipe: Mesa' }, cpu: true },
  swiftshader: { info: { vendor: 'google', architecture: 'swiftshader', device: 'swiftshader-device-subzero', description: 'SwiftShader driver 5.0.0' }, cpu: true },
};

function drivers(env) {
  const newLoader = env.FAKE_VULKAN_LOADER !== 'old';
  const named = (value) => (value || '').split(':').filter(Boolean).map((file) => (/swiftshader/.test(file) ? 'swiftshader' : 'gpu'));
  const replaced = newLoader ? env.VK_DRIVER_FILES || env.VK_ICD_FILENAMES : env.VK_ICD_FILENAMES;
  const system = replaced ? named(replaced) : (env.FAKE_VULKAN_HOST || '').split(',').filter(Boolean);
  return [...(newLoader ? named(env.VK_ADD_DRIVER_FILES) : []), ...system];
}

class GPU {}
GPU.prototype.requestAdapter = function (options = {}) {
  this.found ??= drivers(process.env);
  return this.answer(options);
};
GPU.prototype.answer = async function (options) {
  const adapters = this.found.map((name) => ADAPTERS[name]).filter(Boolean);
  const cpu = adapters.find((a) => a.cpu);
  const chosen = options.forceFallbackAdapter ? cpu : adapters.find((a) => !a.cpu) ?? cpu;
  return chosen ? { info: { ...chosen.info, isFallbackAdapter: chosen.cpu }, features: new Set() } : null;
};
class GPUDevice {}

exports.create = () => new GPU();
exports.globals = { GPU, GPUDevice };
