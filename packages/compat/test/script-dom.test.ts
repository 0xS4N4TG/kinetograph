// What a classic page script sees of its own document: `document.currentScript` while it runs.

import { describe, expect, it } from 'vitest';
import { installDomGlobals, setPathMeasure, withCurrentScript } from '../src/shim/index.js';

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

describe('XMLSerializer', () => {
  const HTML = 'http://www.w3.org/1999/xhtml';
  const SVG = 'http://www.w3.org/2000/svg';
  it('is a global that writes an element as XML, with its namespaces', () => {
    const wrap = doc().createElement('div');
    wrap.className = 'a b';
    wrap.setAttribute('data-x', 'a&b "q"');
    wrap.innerHTML = '<p>1 &lt; 2 &amp; 3</p><br><img src="x.png"><span></span>';
    const xml = new (globalThis as any).XMLSerializer().serializeToString(wrap);
    expect(xml).toBe(`<div xmlns="${HTML}" class="a b" data-x="a&amp;b &quot;q&quot;"><p>1 &lt; 2 &amp; 3</p><br /><img src="x.png" /><span></span></div>`);
    // Read back through innerHTML it is the markup it came from.
    const back = doc().createElement('div');
    back.innerHTML = xml;
    expect(back.firstElementChild.children.length).toBe(4);
    expect(back.firstElementChild.lastElementChild.children.length).toBe(0);
  });

  it('declares a nested svg and the html inside a foreignObject once each', () => {
    const wrap = doc().createElement('div');
    wrap.innerHTML = '<svg viewBox="0 0 10 10"><rect width="5"/><foreignObject><div>t</div></foreignObject></svg>';
    const xml = new (globalThis as any).XMLSerializer().serializeToString(wrap);
    expect(xml).toBe(
      `<div xmlns="${HTML}"><svg xmlns="${SVG}" viewBox="0 0 10 10"><rect width="5"/><foreignObject><div xmlns="${HTML}">t</div></foreignObject></svg></div>`,
    );
  });

  it('writes a document as its root element, and a text node as its text', () => {
    const s = new (globalThis as any).XMLSerializer();
    expect(s.serializeToString(doc())).toMatch(/^<html xmlns="http:\/\/www.w3.org\/1999\/xhtml"/);
    expect(s.serializeToString(doc().createTextNode('a<b'))).toBe('a&lt;b');
  });
});
