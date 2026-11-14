import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adaptersOf, describeExit, describeFailure, hintFor, interpret, lastStepStarted, parseProbeLines, parseStderr, probeInstall, relevantEnv } from '../src/doctor-probe.js';

const alive = { status: 0, signal: null, hung: false };

describe('describeExit', () => {
  it('names the Windows crash codes, signed or unsigned', () => {
    expect(describeExit(-1073741819, null)?.code).toBe('0xC0000005');
    expect(describeExit(3221225477, null)?.meaning).toContain('access violation');
    expect(describeExit(-1073740940, null)).toMatchObject({ code: '0xC0000374', meaning: expect.stringContaining('heap corruption') });
  });
  it('gives a signal as it is, and nothing for a clean exit', () => {
    expect(describeExit(null, 'SIGSEGV')).toEqual({ code: 'SIGSEGV' });
    expect(describeExit(0, null)).toBeUndefined();
  });
});

describe('parseProbeLines', () => {
  it('keeps the JSON objects and drops what a driver printed', () => {
    expect(parseProbeLines('{"stage":"addon"}\nVK_LAYER: loaded\n[1,2]\n\n{"stage":"renderer"}\n')).toEqual([{ stage: 'addon' }, { stage: 'renderer' }]);
  });
});

const TRACE = [
  'kinetograph-trace: 1 start create-instance backends=Backends(VULKAN) built=Backends(VULKAN | DX12)',
  'kinetograph-trace: 2 done create-instance backends=Backends(VULKAN)',
  'kinetograph-trace: 3 start enumerate-adapters backends=Backends(VULKAN)',
  'kinetograph-trace: 4 note adapter #0 name="Intel(R) UHD Graphics 620" backend=Vulkan type=IntegratedGpu vendor=0x8086 device=0x5917 driver="Intel" driver_info="31.0.101"',
  'kinetograph-trace: 5 done enumerate-adapters count=1',
  'kinetograph-trace: 6 start request-device features=CLEAR_TEXTURE max_vertex_buffers=16',
  'kinetograph-trace: 7 done request-device ok',
  'kinetograph-trace: 8 start skia-vk-context Graphite on the device',
];
const CRASH = ['kinetograph-crash: exception 0xC0000005 (access violation)', 'kinetograph-crash: frame 0 kinetograph.win32-x64-msvc.node+0x1a2b3c'];

describe('the addon trace and crash report in stderr', () => {
  it('are parsed from a child\'s stderr, and a driver\'s own lines are left out', () => {
    const { trace, crash } = parseStderr(['VK_LAYER: loaded', ...TRACE, ...CRASH, ''].join('\r\n'));
    expect(trace).toHaveLength(8);
    expect(trace[0]).toEqual({ n: 1, kind: 'start', step: 'create-instance', detail: 'backends=Backends(VULKAN) built=Backends(VULKAN | DX12)' });
    expect(crash).toEqual(['exception 0xC0000005 (access violation)', 'frame 0 kinetograph.win32-x64-msvc.node+0x1a2b3c']);
  });
  it('give the innermost step that began and did not end', () => {
    expect(lastStepStarted(parseStderr(TRACE.join('\n')).trace)).toEqual({ name: 'skia-vk-context', detail: 'Graphite on the device' });
    expect(lastStepStarted(parseStderr(TRACE.slice(0, 2).join('\n')).trace)).toBeUndefined();
  });
  it('list each adapter once', () => {
    const trace = parseStderr([...TRACE, ...TRACE].join('\n')).trace;
    expect(adaptersOf(trace)).toEqual(['name="Intel(R) UHD Graphics 620" backend=Vulkan type=IntegratedGpu vendor=0x8086 device=0x5917 driver="Intel" driver_info="31.0.101"']);
  });
  it('end up in a crash: the step, the report, the adapters and the trace', () => {
    const lines = [{ stage: 'addon' }, { stage: 'addon', done: true, version: '1.2.3' }, { stage: 'renderer' }];
    const r = interpret(lines, { status: -1073741819, signal: null, hung: false }, [...TRACE, ...CRASH].join('\n'));
    expect(r.failure).toMatchObject({ stage: 'renderer', kind: 'crash', code: '0xC0000005', step: { name: 'skia-vk-context' }, crash: CRASH.map((l) => l.slice(19)) });
    expect(r.adapters).toHaveLength(1);
    expect(r.trace?.at(-1)).toBe('8 start skia-vk-context Graphite on the device');
    const text = describeFailure(r.failure!, 'win32').join('\n');
    expect(text).toContain('last start-up step begun: skia-vk-context Graphite on the device');
    expect(text).toContain('  frame 0 kinetograph.win32-x64-msvc.node+0x1a2b3c');
  });
  it('give a hang the step too, but no crash report', () => {
    const r = interpret([{ stage: 'addon' }, { stage: 'addon', done: true, version: '1' }, { stage: 'renderer' }], { status: null, signal: 'SIGKILL', hung: true }, TRACE.join('\n'));
    expect(r.failure).toMatchObject({ kind: 'hang', step: { name: 'skia-vk-context' } });
    expect(r.failure?.crash).toBeUndefined();
  });
});

describe('interpret', () => {
  const loaded = [{ stage: 'addon' }, { stage: 'addon', done: true, version: '1.2.3' }];
  it('reports a renderer that started', () => {
    const r = interpret([...loaded, { stage: 'renderer' }, { stage: 'renderer', done: true, backend: 'Skia GPU (Vulkan)', reason: null }], alive);
    expect(r).toEqual({ addon: { loaded: true, version: '1.2.3' }, renderer: 'Skia GPU (Vulkan)', rendererReason: null });
  });
  it('says a crash in the renderer stage came after the addon loaded', () => {
    const r = interpret([...loaded, { stage: 'renderer' }], { status: -1073741819, signal: null, hung: false });
    expect(r.addon).toEqual({ loaded: true, version: '1.2.3' });
    expect(r.renderer).toBeNull();
    expect(r.failure).toMatchObject({ stage: 'renderer', kind: 'crash', code: '0xC0000005' });
  });
  it('says a crash while the addon loads', () => {
    const r = interpret([{ stage: 'addon' }], { status: null, signal: 'SIGSEGV', hung: false });
    expect(r.addon.loaded).toBe(false);
    expect(r.failure).toMatchObject({ stage: 'addon', kind: 'crash', code: 'SIGSEGV' });
  });
  it('says a hang, and where', () => {
    const r = interpret([...loaded, { stage: 'renderer' }], { status: null, signal: 'SIGKILL', hung: true });
    expect(r.failure).toEqual({ stage: 'renderer', kind: 'hang' });
  });
  it('keeps what the renderer threw, which is no crash', () => {
    const r = interpret([...loaded, { stage: 'renderer' }, { stage: 'renderer', error: 'no compatible GPU adapter found' }], alive);
    expect(r.failure).toEqual({ stage: 'renderer', kind: 'error', message: 'no compatible GPU adapter found' });
    // The reason is not null (it was, for `WGPU_BACKEND=gl`, in --json).
    expect(r.rendererReason).toBe('no compatible GPU adapter found');
  });
  it('does not blame the renderer for a crash at shutdown', () => {
    const r = interpret([...loaded, { stage: 'renderer' }, { stage: 'renderer', done: true, backend: 'Skia CPU (no GPU found)', reason: null }], { status: 3221225477, signal: null, hung: false });
    expect(r.renderer).toBe('Skia CPU (no GPU found)');
    expect(r.failure).toMatchObject({ stage: 'exit', kind: 'crash' });
  });
  it('says so when the child said nothing and died', () => {
    const r = interpret([], { status: 1, signal: null, hung: false });
    expect(r.addon).toMatchObject({ loaded: false });
    expect(r.failure).toMatchObject({ stage: 'addon', kind: 'crash' });
  });
});

describe('the report lines', () => {
  it('give the exit code and a hint with the env vars to try, on Windows', () => {
    const lines = describeFailure({ stage: 'renderer', kind: 'crash', code: '0xC0000005', meaning: 'access violation' }, 'win32');
    expect(lines[0]).toBe('crashed: 0xC0000005 (access violation)');
    expect(lines[1]).toContain('while starting the renderer');
    expect(lines[1]).toContain('WGPU_BACKEND=dx12');
    expect(lines[1]).toContain('KINETOGRAPH_SKIA_CPU=1');
  });
  it('say a hang as one', () => {
    expect(describeFailure({ stage: 'renderer', kind: 'hang' }, 'linux')[0]).toBe('hung');
    expect(hintFor({ stage: 'renderer', kind: 'hang' }, 'linux')).toContain('hung while starting the renderer');
  });
  it('give a thrown error without a hint', () => {
    expect(describeFailure({ stage: 'renderer', kind: 'error', message: 'no adapter' })).toEqual(['why it could not start: no adapter']);
  });
  it('list the env vars that steer the renderer, only those set', () => {
    expect(relevantEnv({ WGPU_BACKEND: 'gl', PATH: 'x', KINETOGRAPH_SKIA_CPU: '1' })).toEqual(['WGPU_BACKEND=gl', 'KINETOGRAPH_SKIA_CPU=1']);
  });
});

describe('probeInstall (a child process loads a stand-in addon)', () => {
  const addon = (body: string): string => {
    const file = join(mkdtempSync(join(tmpdir(), 'kinetograph-probe-')), 'addon.cjs');
    writeFileSync(file, body);
    return file;
  };
  const ok = `exports.version = () => '9.9.9'; exports.Renderer = class { backend() { return 'Skia CPU (no GPU found)'; } backendReason() { return null; } };`;

  it('reports an addon that loads and a renderer that starts, announcing each stage first', async () => {
    const stages: string[] = [];
    const r = await probeInstall(addon(ok), (s) => stages.push(s));
    expect(r).toEqual({ addon: { loaded: true, version: '9.9.9' }, renderer: 'Skia CPU (no GPU found)', rendererReason: null });
    expect(stages).toEqual(['addon', 'renderer']);
  });

  it('turns a native crash in the renderer into a reported failure', async () => {
    const r = await probeInstall(addon(`exports.version = () => '9.9.9'; exports.Renderer = class { constructor() { process.abort(); } };`), () => {});
    expect(r.addon).toEqual({ loaded: true, version: '9.9.9' });
    expect(r.renderer).toBeNull();
    expect(r.failure).toMatchObject({ stage: 'renderer', kind: 'crash' });
    expect(r.failure?.code).toBeTruthy();
  });

  it('stops a renderer that hangs', async () => {
    const r = await probeInstall(addon(`exports.version = () => '9.9.9'; exports.Renderer = class { constructor() { for (;;); } };`), () => {}, 1500);
    expect(r.failure).toEqual({ stage: 'renderer', kind: 'hang' });
  });

  it('reports what the renderer threw', async () => {
    const r = await probeInstall(addon(`exports.version = () => '9.9.9'; exports.Renderer = class { constructor() { throw new Error('no compatible GPU adapter found'); } };`), () => {});
    expect(r.failure).toEqual({ stage: 'renderer', kind: 'error', message: 'no compatible GPU adapter found' });
  });

  it('asks the child for the trace and the crash report, and reads the last step from its stderr', async () => {
    const body = `exports.version = () => '9.9.9'; exports.Renderer = class { constructor() {
      const on = process.env.KINETOGRAPH_TRACE_START === '1' && process.env.KINETOGRAPH_CRASH_REPORT === '1';
      process.stderr.write('kinetograph-trace: 1 start request-device ' + (on ? 'asked' : 'not asked') + '\\n');
      process.abort();
    } };`;
    const r = await probeInstall(addon(body), () => {});
    expect(r.failure).toMatchObject({ stage: 'renderer', kind: 'crash', step: { name: 'request-device', detail: 'asked' } });
  });

  it('reports an addon that fails to load', async () => {
    const r = await probeInstall(addon(`throw new Error('The specified module could not be found');`), () => {});
    expect(r.addon).toEqual({ loaded: false, error: 'The specified module could not be found' });
  });
});
