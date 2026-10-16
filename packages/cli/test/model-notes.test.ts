import { afterEach, describe, expect, it } from 'vitest';
import { modelNotes } from '../src/model-notes.js';
import { setNativeForTests, type Native } from '../src/native.js';

type Note = { feature: string; reason: string };

/** A stand-in addon that knows what `files` use and counts the files it reads. */
function stub(files: Record<string, Note[] | Error>): { reads: string[] } {
  const reads: string[] = [];
  setNativeForTests({
    modelUnsupported: (src: string, baseDir?: string) => {
      reads.push(`${baseDir}:${src}`);
      const notes = files[src];
      if (notes instanceof Error) throw notes;
      return notes ?? [];
    },
  } as unknown as Native);
  return { reads };
}

const clearcoat: Note = { feature: 'KHR_materials_clearcoat', reason: 'this glTF extension is not read' };
const normals: Note = { feature: 'normal textures', reason: 'the material is drawn without them' };

const scene = (layers: unknown[]) => JSON.stringify({ width: 1, height: 1, fps: 30, durationInFrames: 1, layers });

afterEach(() => setNativeForTests(undefined));

describe('modelNotes', () => {
  it('lists what each model a 3D layer draws uses that is not read, groups and nested layers included', () => {
    stub({ 'car.glb': [clearcoat, normals], 'tree.glb': [normals] });
    const notes = modelNotes('/work')(
      scene([
        {
          id: 'hero',
          type: 'scene3d',
          objects: [
            { type: 'model', src: 'car.glb' },
            { type: 'group', children: [{ type: 'model', src: 'tree.glb' }, { type: 'mesh', geometry: { kind: 'box' } }] },
          ],
        },
        { id: 'outer', type: 'group', children: [{ id: 'inner', type: 'scene3d', objects: [{ type: 'model', src: 'tree.glb' }] }] },
      ]),
    );
    expect(notes).toEqual([
      { path: 'hero <Model>', element: 'Model', property: 'KHR_materials_clearcoat', value: 'car.glb', reason: clearcoat.reason },
      { path: 'hero <Model>', element: 'Model', property: 'normal textures', value: 'car.glb', reason: normals.reason },
      { path: 'hero <Model>', element: 'Model', property: 'normal textures', value: 'tree.glb', reason: normals.reason },
      { path: 'inner <Model>', element: 'Model', property: 'normal textures', value: 'tree.glb', reason: normals.reason },
    ]);
  });

  it('reads each file once, from the scene directory, however many frames and uses', () => {
    const { reads } = stub({ 'a.glb': [normals] });
    const frame = scene([{ id: 's', type: 'scene3d', objects: [{ type: 'model', src: 'a.glb' }, { type: 'model', src: 'a.glb' }] }]);
    const notes = modelNotes('/work');
    notes(frame);
    notes(frame);
    expect(reads).toEqual(['/work:a.glb']);
  });

  it('says nothing, and reads nothing, for a scene with no model or a model that is fine', () => {
    const { reads } = stub({});
    const notes = modelNotes('/work');
    expect(notes(scene([{ id: 's', type: 'scene3d', objects: [{ type: 'mesh', geometry: { kind: 'box' } }] }]))).toEqual([]);
    expect(reads).toEqual([]);
    expect(notes(scene([{ id: 's', type: 'scene3d', objects: [{ type: 'model', src: 'fine.glb' }] }]))).toEqual([]);
  });

  it('leaves a file that cannot be read to the render, which fails on it', () => {
    stub({ 'gone.glb': new Error('cannot read model gone.glb') });
    const frame = scene([{ id: 's', type: 'scene3d', objects: [{ type: 'model', src: 'gone.glb' }] }]);
    expect(modelNotes('/work')(frame)).toEqual([]);
  });
});
