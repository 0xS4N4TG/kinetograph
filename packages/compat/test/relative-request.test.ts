import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sameOriginPath, setDomEnvironment } from '../src/environment.js';
import { installDomGlobals } from '../src/shim/index.js';

installDomGlobals();

describe('a Request for a relative URL', () => {
  const project = () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-request-'));
    mkdirSync(join(dir, 'assets/models'), { recursive: true });
    writeFileSync(join(dir, 'assets/models/a.glb'), 'glTF');
    setDomEnvironment({ baseDir: dir });
    return dir;
  };

  it('resolves against the document, as three.js FileLoader needs, and fetch reads the project file', async () => {
    project();
    const request = new Request('assets/models/a.glb', { headers: { accept: '*/*' } });
    expect(request.url).toBe('http://localhost/assets/models/a.glb');
    const response = await fetch(request);
    expect(await response.text()).toBe('glTF');
  });

  it('reads a file by the absolute path a composition\'s assetUrl() gives (http://localhost/<abs>)', async () => {
    const dir = project();
    writeFileSync(join(dir, 'data.json'), '{"msg":"abs"}');
    const response = await fetch(`http://localhost${join(dir, 'data.json')}`);
    expect((await response.json()).msg).toBe('abs');
    // A root-relative URL is still the project's file.
    expect(await (await fetch('/assets/models/a.glb')).text()).toBe('glTF');
  });

  it('keeps a Windows drive path inside the project as an absolute path', () => {
    setDomEnvironment({ baseDir: 'C:\\Users\\me\\proj' });
    expect(sameOriginPath('http://localhost/C:/Users/me/proj/assets/a.json')).toBe('C:/Users/me/proj/assets/a.json');
    expect(sameOriginPath('http://localhost/c:/users/me/proj/a.json')).toBe('c:/users/me/proj/a.json');
    expect(sameOriginPath('http://localhost/C:/Users/other/a.json')).toBe('C:/Users/other/a.json');
    expect(sameOriginPath('http://localhost/img/a.png')).toBe('img/a.png');
  });

  it('cannot leave the project by dots, and never reaches the network', async () => {
    project();
    expect(new Request('../../etc/passwd').url).toBe('http://localhost/etc/passwd');
    await expect(fetch(new Request('../../etc/passwd'))).rejects.toThrow(/no such file in the project/);
    await expect(fetch(new Request('https://example.com/a.glb'))).rejects.toThrow(/remote URLs are not available/);
  });

  it('leaves absolute URLs and Request objects as they are', () => {
    expect(new Request('https://example.com/x').url).toBe('https://example.com/x');
    expect(new Request('data:text/plain,hi').url).toBe('data:text/plain,hi');
    expect(new Request(new Request('http://localhost/b')).url).toBe('http://localhost/b');
  });
});
