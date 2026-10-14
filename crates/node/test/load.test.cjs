// CPU only: loads the addon and calls a function that needs no GPU.
const test = require('node:test');
const assert = require('node:assert/strict');
const native = require('..');

test('the addon loads and reports its version', () => {
  assert.match(native.version(), /^\d+\.\d+\.\d+/);
});
