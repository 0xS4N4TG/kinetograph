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
});
