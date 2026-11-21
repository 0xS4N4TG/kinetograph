import { describe, expect, it } from 'vitest';
import { DOCUMENT_URL } from '../src/environment.js';
import { installDomGlobals } from '../src/shim/index.js';

installDomGlobals();

describe('location', () => {
  it('is on the document as well as the window, built from the document URL', () => {
    const url = new URL(DOCUMENT_URL);
    expect(document.location).toBe(window.location);
    expect(document.location.href).toBe(url.href);
    expect(document.location.origin).toBe(url.origin);
    expect(document.location.pathname).toBe(url.pathname);
    expect(`${document.location}`).toBe(url.href);
  });

  it('stays where it is when a script navigates', () => {
    document.location.assign('http://elsewhere/');
    document.location.href = 'http://elsewhere/';
    expect(document.location.href).toBe(DOCUMENT_URL);
  });

  it('changes nothing when a script sets a part of the URL', () => {
    const url = new URL(DOCUMENT_URL);
    const parts = ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'] as const;
    const values = { protocol: 'https:', host: 'elsewhere:81', hostname: 'elsewhere', port: '81', pathname: '/other', search: '?q=1', hash: '#top' };
    for (const part of parts) (document.location as unknown as Record<string, string>)[part] = values[part];
    for (const part of parts) expect(document.location[part]).toBe(url[part]);
    expect(document.location.href).toBe(url.href);
  });

  it('has no ancestor origins, as a DOMStringList', () => {
    const list = document.location.ancestorOrigins;
    expect(list.length).toBe(0);
    expect(list.item(0)).toBeNull();
    expect(list.contains(new URL(DOCUMENT_URL).origin)).toBe(false);
    expect([...(list as unknown as Iterable<string>)]).toEqual([]);
  });
});
