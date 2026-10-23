// Shader groups (packages/cli/skills/kinetograph/references/SCENE.md, "Shader groups"): a group with a `glsl` pass samples its children. A texture of the pass
// may name a layer that is somewhere else in the tree (a shader transition mixes the scene going out, which another
// `<Sequence>` holds, with the one coming in); this moves such a layer in as a child of the group, so the renderer finds
// every texture among the group's own children.

import type { LayerJson } from '@kinetograph/scene';

type Group = Extract<LayerJson, { type: 'group' }>;
type ShaderGroup = Group & { glsl: NonNullable<Group['glsl']> };

function isShaderGroup(layer: LayerJson): layer is ShaderGroup {
  return layer.type === 'group' && layer.glsl !== undefined;
}

function groupsIn(layers: LayerJson[], out: ShaderGroup[] = []): ShaderGroup[] {
  for (const layer of layers) {
    if (isShaderGroup(layer)) out.push(layer);
    if (layer.type === 'group') groupsIn(layer.children, out);
  }
  return out;
}

/** The list `id` is in, and its place there. */
function locate(layers: LayerJson[], id: string): { list: LayerJson[]; index: number } | null {
  for (const [index, layer] of layers.entries()) {
    if (layer.id === id) return { list: layers, index };
    const inside = layer.type === 'group' ? locate(layer.children, id) : null;
    if (inside !== null) return inside;
  }
  return null;
}

/** A copy of `layer` and everything in it with `suffix` after every id, and the references to them. */
function renamed(layer: LayerJson, suffix: string): LayerJson {
  const copy = structuredClone(layer);
  const rename = (l: LayerJson): void => {
    l.id += suffix;
    if (l.matte !== undefined) l.matte = { ...l.matte, layer: l.matte.layer + suffix };
    if (l.type !== 'group') return;
    for (const texture of Object.values(l.glsl?.textures ?? {})) {
      if (texture.layer !== undefined) texture.layer += suffix;
    }
    l.children.forEach(rename);
  };
  rename(copy);
  return copy;
}

/**
 * Moves the layers that the textures of the shader groups in `layers` name into those groups. A layer that two groups
 * name is moved into the first and copied, under new ids, into the others. A texture that names no layer in the tree
 * gets an empty group, which is a transparent picture.
 */
export function gatherShaderInputs(layers: LayerJson[]): void {
  const taken = new Map<string, LayerJson>();
  for (const group of groupsIn(layers)) {
    for (const [key, texture] of Object.entries(group.glsl.textures ?? {})) {
      const id = texture.layer;
      if (id === undefined || group.children.some((child) => child.id === id)) continue;
      const earlier = taken.get(id);
      if (earlier === undefined) {
        const found = locate(layers, id);
        if (found === null) {
          group.children.push({ id, type: 'group', children: [] });
          continue;
        }
        const [layer] = found.list.splice(found.index, 1) as [LayerJson];
        taken.set(id, layer);
        group.children.push(layer);
        continue;
      }
      let copy = 1;
      while (locate(layers, `${id}~${copy}`) !== null) copy += 1;
      const suffix = `~${copy}`;
      // The recording may be shared with its author, so it is replaced rather than changed.
      group.glsl = { ...group.glsl, textures: { ...group.glsl.textures, [key]: { ...texture, layer: id + suffix } } };
      group.children.push(renamed(earlier, suffix));
    }
  }
}
