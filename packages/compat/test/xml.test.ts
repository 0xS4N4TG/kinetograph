import { describe, expect, it } from 'vitest';
import { installDomGlobals } from '../src/shim/index.js';

installDomGlobals();

const parse = (text: string, type = 'application/xml'): any => new DOMParser().parseFromString(text, type as DOMParserSupportedType);

const COLLADA =
  '<?xml version="1.0" encoding="utf-8"?><COLLADA version="1.4.1"><asset><up_axis>Z_UP</up_axis></asset>' +
  '<library_geometries><geometry id="g1" name="Cube"><float_array count="3">1 2 3</float_array></geometry></library_geometries></COLLADA>';

describe('an XML document is a tree', () => {
  it('holds every element, whatever its name, with the name as written', () => {
    for (const type of ['application/xml', 'text/xml', 'application/xhtml+xml']) {
      const doc = parse(COLLADA, type);
      expect(doc.contentType).toBe(type);
      expect(doc.nodeType).toBe(9);
      const root = doc.documentElement;
      expect([root.nodeName, root.tagName, root.localName]).toEqual(['COLLADA', 'COLLADA', 'COLLADA']);
      expect(root.childNodes).toHaveLength(2);
      expect(root.children.map((c: any) => c.nodeName)).toEqual(['asset', 'library_geometries']);
      expect(doc.getElementsByTagName('up_axis')[0].textContent).toBe('Z_UP');
    }
  });

  it('is case sensitive', () => {
    const doc = parse('<Root><Item/><item/></Root>');
    expect(doc.getElementsByTagName('Item')).toHaveLength(1);
    expect(doc.getElementsByTagName('item')).toHaveLength(1);
    expect(doc.getElementsByTagName('ITEM')).toHaveLength(0);
    expect(doc.getElementsByTagName('*')).toHaveLength(3);
  });

  it('walks the tree: parent, siblings, first and last child', () => {
    const doc = parse('<a><b/>text<c><d/></c></a>');
    const a = doc.documentElement;
    expect([a.firstChild.nodeName, a.firstElementChild.nodeName, a.lastElementChild.nodeName, a.childElementCount]).toEqual(['b', 'b', 'c', 2]);
    const c = a.lastElementChild;
    expect(c.parentNode).toBe(a);
    expect(c.parentElement).toBe(a);
    expect(a.parentNode).toBe(doc);
    expect(a.parentElement).toBeNull();
    expect(c.previousSibling.nodeType).toBe(3);
    expect(c.previousElementSibling.nodeName).toBe('b');
    expect(a.firstElementChild.nextElementSibling).toBe(c);
    expect(c.nextElementSibling).toBeNull();
    expect(a.contains(c.firstElementChild)).toBe(true);
    expect(c.ownerDocument).toBe(doc);
    expect(doc.body).toBeNull();
  });

  it('keeps text, CDATA, comments and processing instructions as nodes, and decodes entities', () => {
    const doc = parse('<?xml version="1.0"?><?pi go now?><!-- top --><r>a &amp; b &#65;&#x42;<![CDATA[<raw & text>]]><!--c--><?t d?></r>');
    expect(doc.childNodes.map((n: any) => n.nodeType)).toEqual([7, 8, 1]);
    const r = doc.documentElement;
    expect(r.childNodes.map((n: any) => [n.nodeType, n.nodeName])).toEqual([[3, '#text'], [4, '#cdata-section'], [8, '#comment'], [7, 't']]);
    expect(r.childNodes[0].data).toBe('a & b AB');
    expect(r.childNodes[1].nodeValue).toBe('<raw & text>');
    expect(r.textContent).toBe('a & b AB<raw & text>');
    expect(r.childNodes[3].data).toBe('d');
    expect(doc.childNodes[0].target).toBe('pi');
    expect(doc.textContent).toBeNull();
  });

  it('reads attributes by the name as written', () => {
    const el = parse('<m Target="x" id="a" data-n="1"/>').documentElement;
    expect([el.getAttribute('Target'), el.getAttribute('target'), el.getAttribute('id'), el.id]).toEqual(['x', null, 'a', 'a']);
    expect([el.hasAttribute('Target'), el.hasAttribute('target')]).toEqual([true, false]);
    expect(el.getAttributeNames()).toEqual(['Target', 'id', 'data-n']);
    expect(el.attributes).toHaveLength(3);
    expect([el.attributes[0].name, el.attributes[0].value, el.attributes.getNamedItem('id').value]).toEqual(['Target', 'x', 'a']);
    expect([el.attributes.id.value, el.attributes.Target.textContent, el.attributes.target, 'id' in el.attributes]).toEqual(['a', 'x', undefined, true]);
    expect(el.hasAttributes()).toBe(true);
    el.setAttribute('Target', 'y');
    el.removeAttribute('id');
    expect(el.getAttribute('Target')).toBe('y');
    expect(el.hasAttribute('id')).toBe(false);
  });

  it('finds elements by id, selector and tag, from the document or an element', () => {
    const doc = parse('<r><g id="a" class="x y"><p n="1"/><p n="2"/></g><p n="3"/></r>');
    expect(doc.getElementById('a').nodeName).toBe('g');
    expect(doc.getElementById('missing')).toBeNull();
    expect(doc.querySelectorAll('p')).toHaveLength(3);
    expect(doc.querySelectorAll('g > p[n="2"]')).toHaveLength(1);
    expect(doc.querySelector('#a').getAttribute('class')).toBe('x y');
    expect(doc.querySelector('r').nodeName).toBe('r');
    expect(doc.querySelector('nothing')).toBeNull();
    const g = doc.getElementById('a');
    expect(g.querySelectorAll('p')).toHaveLength(2);
    expect(g.getElementsByTagName('p')).toHaveLength(2);
    expect(g.matches('.y')).toBe(true);
    expect(g.closest('r').nodeName).toBe('r');
    expect(doc.getElementsByClassName('x')).toHaveLength(1);
  });
});

describe('XML namespaces', () => {
  const xml =
    '<d:doc xmlns:d="urn:d" xmlns="urn:default" xmlns:x="urn:x"><item x:a="1" b="2"/><d:item/><other xmlns="urn:inner"><deep/></other><plain xmlns=""/></d:doc>';
  it('gives every element its namespace, prefix and local name', () => {
    const doc = parse(xml);
    const root = doc.documentElement;
    expect([root.namespaceURI, root.prefix, root.localName, root.tagName]).toEqual(['urn:d', 'd', 'doc', 'd:doc']);
    const [item, prefixed, other, plain] = root.children;
    expect([item.namespaceURI, item.prefix, item.localName]).toEqual(['urn:default', null, 'item']);
    expect([prefixed.namespaceURI, prefixed.nodeName]).toEqual(['urn:d', 'd:item']);
    expect([other.namespaceURI, other.firstElementChild.namespaceURI]).toEqual(['urn:inner', 'urn:inner']);
    expect(plain.namespaceURI).toBeNull();
  });

  it('reads attributes and elements by namespace', () => {
    const doc = parse(xml);
    const item = doc.documentElement.firstElementChild;
    expect([item.getAttributeNS('urn:x', 'a'), item.getAttributeNS(null, 'a'), item.getAttributeNS(null, 'b'), item.hasAttributeNS('urn:x', 'a')]).toEqual(['1', null, '2', true]);
    expect(item.getAttribute('x:a')).toBe('1');
    expect(doc.getElementsByTagNameNS('urn:default', 'item')).toHaveLength(1);
    expect(doc.getElementsByTagNameNS('urn:d', 'item')).toHaveLength(1);
    expect(doc.getElementsByTagNameNS('*', 'item')).toHaveLength(2);
    expect(doc.getElementsByTagNameNS('urn:inner', '*')).toHaveLength(2);
    expect(doc.getElementsByTagNameNS(null, 'plain')).toHaveLength(1);
    expect(doc.getElementsByTagName('d:item')).toHaveLength(1);
  });

  it('gives the xml: and xmlns attributes their namespaces', () => {
    const el = parse('<a xml:lang="en" xmlns:q="urn:q"/>').documentElement;
    expect(el.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang')).toBe('en');
    expect(el.getAttributeNS('http://www.w3.org/2000/xmlns/', 'q')).toBe('urn:q');
  });
});

describe('an SVG document', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 4 4"><g fill="#00f" stroke-width="2"><path style="fill:#f00; stroke-width: 3px; opacity:0.5" d="M0 0L1 1" fill="#0f0"/><use xlink:href="#p"/></g></svg>';
  it('is made of SVG elements whose style and presentation attributes can be read', () => {
    const doc = parse(svg, 'image/svg+xml');
    expect(doc.documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg');
    const path = doc.getElementsByTagName('path')[0];
    expect([path.style.fill, path.style.strokeWidth, path.style['stroke-width'], path.style.opacity, path.style.stroke]).toEqual(['#f00', '3px', '3px', '0.5', '']);
    expect(path.style.getPropertyValue('fill')).toBe('#f00');
    expect([path.getAttribute('fill'), path.getAttribute('d'), path.parentNode.getAttribute('fill'), path.parentNode.style.fill]).toEqual(['#0f0', 'M0 0L1 1', '#00f', '']);
    expect(doc.documentElement.getAttribute('viewBox')).toBe('0 0 4 4');
    expect(doc.getElementsByTagName('use')[0].getAttribute('xlink:href')).toBe('#p');
    expect(doc.getElementsByTagName('use')[0].getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe('#p');
  });

  it('writes style back to the attribute', () => {
    const path = parse(svg, 'image/svg+xml').getElementsByTagName('path')[0];
    path.style.fill = '#123';
    path.style.removeProperty('opacity');
    expect(path.getAttribute('style')).toBe('fill: #123; stroke-width: 3px;');
  });

  it('has no style on an element of another namespace', () => {
    expect(parse('<a><b/></a>').documentElement.style).toBeUndefined();
  });
});

describe('a document that is not well formed', () => {
  it('is a parsererror document, not an exception', () => {
    const cases: [string, RegExp][] = [
      ['<a><b></a>', /mismatch: b and a/],
      ['<a>', /Premature end/],
      ['', /empty/],
      ['just text', /Start tag expected/],
      ['<a/><b/>', /Extra content/],
      ['<a x=1/>', /AttValue/],
      ['<a x="1" x="2"/>', /redefined/],
      ['<a>&nope;</a>', /not defined/],
      ['<p:a/>', /prefix p on p:a is not defined/],
      ['<a x="<"/>', /Unescaped/],
    ];
    for (const type of ['application/xml', 'text/xml', 'image/svg+xml']) {
      for (const [text, message] of cases) {
        const doc = parse(text, type);
        const root = doc.documentElement;
        expect([root.nodeName, root.namespaceURI]).toEqual(['parsererror', 'http://www.w3.org/1999/xhtml']);
        expect(root.textContent).toMatch(message);
        expect(doc.getElementsByTagName('parsererror')).toHaveLength(1);
      }
    }
    expect(parse('<a>\n<b></c>', 'text/xml').documentElement.textContent).toMatch(/line 2 at column 4/);
  });
});
