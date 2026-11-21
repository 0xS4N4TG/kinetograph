// A stand-in for dawn.node (KINETOGRAPH_DAWN_MODULE) on a Linux host with no Vulkan driver, whose Vulkan loader reads its variables later than
// the call that makes it enumerate: FAKE_DAWN_READS `later` reads them on a later tick of the first requestAdapter of an instance, `create` when
// the instance is made. Its one adapter is SwiftShader, when the variables name it then.
'use strict';

const swiftshader = (env) => [env.VK_DRIVER_FILES, env.VK_ICD_FILENAMES, env.VK_ADD_DRIVER_FILES].some((value) => /swiftshader/.test(value || ''));

class GPU {
  constructor() {
    if (process.env.FAKE_DAWN_READS === 'create') this.found = swiftshader(process.env);
  }
}
GPU.prototype.requestAdapter = async function () {
  if (this.found === undefined) {
    await new Promise((resolve) => setImmediate(resolve));
    this.found = swiftshader(process.env);
  }
  return this.found ? { info: { vendor: 'google', architecture: 'swiftshader', device: 'swiftshader-device-subzero', description: 'SwiftShader', isFallbackAdapter: true }, features: new Set() } : null;
};
class GPUDevice {}

exports.create = () => new GPU();
exports.globals = { GPU, GPUDevice };
