import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setDomEnvironment } from '../src/environment.js';
import { installDomGlobals } from '../src/shim/index.js';

installDomGlobals();
const dir = mkdtempSync(join(tmpdir(), 'kg-xml-'));
setDomEnvironment({ baseDir: dir });

const parse = (text: string, type = 'application/xml'): any => new DOMParser().parseFromString(text, type as DOMParserSupportedType);

const COLLADA =
  '<?xml version="1.0" encoding="utf-8"?><COLLADA version="1.4.1"><asset><up_axis>Z_UP</up_axis></asset>' +
  '<library_geometries><geometry id="g1" name="Cube"><float_array count="3">1 2 3</float_array></geometry></library_geometries></COLLADA>';

describe('XML through the network APIs', () => {
  it('XMLHttpRequest.responseXML is the parsed document of an XML reply', async () => {
    writeFileSync(join(dir, 'a.xml'), COLLADA);
    writeFileSync(join(dir, 'a.txt'), COLLADA);
    const get = (url: string, type: XMLHttpRequestResponseType = ''): Promise<XMLHttpRequest> =>
      new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.responseType = type;
        xhr.onloadend = () => resolve(xhr);
        xhr.open('GET', url);
        xhr.send();
      });
    const plain = await get('a.xml');
    expect((plain.responseXML as any).documentElement.nodeName).toBe('COLLADA');
    expect(plain.responseText).toBe(COLLADA);
    const asDocument = await get('a.xml', 'document');
    expect((asDocument.response as any).getElementsByTagName('geometry')[0].getAttribute('id')).toBe('g1');
    expect((asDocument.responseXML as any).documentElement.nodeName).toBe('COLLADA');
    expect((await get('a.txt')).responseXML).toBeNull();
    const text = await get('a.xml', 'text');
    expect(() => (text as any).responseXML).toThrow(/responseType/);
  });

  it('fetch(...).text() into DOMParser reads a project file', async () => {
    writeFileSync(join(dir, 'b.xml'), '<m><v id="1"/></m>');
    const text = await (await fetch('b.xml')).text();
    expect(parse(text, 'text/xml').getElementsByTagName('v')[0].getAttribute('id')).toBe('1');
  });
});
