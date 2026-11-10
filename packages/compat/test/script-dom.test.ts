// What a classic page script sees of its own document: `document.currentScript` while it runs.

import { describe, expect, it } from 'vitest';
import { installDomGlobals, withCurrentScript } from '../src/shim/index.js';

installDomGlobals();
const doc = (): any => (globalThis as any).document;

describe('document.currentScript', () => {
  it('is null outside a script', () => {
    expect(doc().currentScript).toBeNull();
  });

  it('is the running <script>, inside the element it sits in, and null again after', () => {
    const root = doc().createElement('div');
    root.id = 'root';
    root.innerHTML = '<p class="x">hi</p>';
    doc().body.appendChild(root);
    let seen: any = null;
    withCurrentScript(root, () => {
      seen = doc().currentScript;
      // The component idiom: the script finds its own root through `closest`.
      doc().currentScript.closest('#root').querySelector('.x').style.color = 'red';
    });
    expect(seen.tagName).toBe('SCRIPT');
    expect(root.querySelector('.x').style.color).toBe('red');
    expect(doc().currentScript).toBeNull();
    // The tree is as it was: the marker is not left behind.
    expect(root.children.length).toBe(1);
  });

  it('leaves the tree alone when the script replaced its parent\'s content', () => {
    const root = doc().createElement('div');
    root.id = 'root';
    doc().body.appendChild(root);
    withCurrentScript(root, () => {
      doc().currentScript.closest('#root').innerHTML = '<p>new</p>';
    });
    expect(root.innerHTML).toBe('<p>new</p>');
    expect(doc().currentScript).toBeNull();
  });

  it('is null again when the script throws', () => {
    expect(() =>
      withCurrentScript(null, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(doc().currentScript).toBeNull();
  });
});
