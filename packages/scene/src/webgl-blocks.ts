// Uniform blocks (WebGL 2): `layout(std140) uniform B { ... } instance;` read out of a shader and laid out as std140
// (OpenGL ES 3.0 §2.12.6.4), which is the one layout WebGL allows. The layout is made here once: the recording carries
// it (`GlslProgram.blocks`), the renderer reads a block's bytes where it says and does no layout of its own, and
// `getActiveUniforms` and `getActiveUniformBlockParameter` answer from it. Pure functions of the source.

import type { GlslBlock, GlslBlockMember } from './types.js';
import { WebGLUnsupportedError } from './webgl.js';

/** The fields of a struct the shader defines. */
export interface BlockStruct {
  name: string;
  type: string;
  length: number | null;
}

/** A uniform a block holds, as `getActiveUniform` lists it. */
export interface BlockUniform {
  /** `Block.member` (`member` for a block with no instance name), `[0]` after an array, `[i].field` in a struct. */
  name: string;
  type: string;
  length: number;
  offset: number;
  arrayStride: number;
  matrixStride: number;
}

export interface BlockInfo extends GlslBlock {
  /** It has an instance name (`uniform B { ... } b;`), which the uniforms' names then leave out for the block's. */
  named: boolean;
  uniforms: BlockUniform[];
}

const roundUp = (n: number, to: number): number => Math.ceil(n / to) * to;

interface Laid {
  align: number;
  size: number;
  fields?: GlslBlockMember[];
}

/** The std140 base alignment and size of one value of `type`. */
function layOut(type: string, structs: Map<string, BlockStruct[]>, depth: number): Laid {
  if (/^(float|int|uint|bool)$/.test(type)) return { align: 4, size: 4 };
  const vector = /^[biu]?vec([234])$/.exec(type);
  if (vector !== null) {
    const n = Number(vector[1]);
    return { align: n === 2 ? 8 : 16, size: 4 * n };
  }
  // A matrix is an array of its columns, each padded to a vec4.
  const matrix = /^mat([234])(?:x[234])?$/.exec(type);
  if (matrix !== null) return { align: 16, size: 16 * Number(matrix[1]) };
  const fields = structs.get(type);
  if (fields !== undefined && depth < 8) {
    const members: GlslBlockMember[] = [];
    let end = 0;
    let align = 16;
    for (const f of fields) {
      const laid = member(f.name, f.type, f.length, end, structs, depth + 1);
      members.push(laid.member);
      end = laid.end;
      align = Math.max(align, laid.align);
    }
    return { align, size: roundUp(end, align), fields: members };
  }
  if (/^[iu]?sampler/.test(type)) throw new WebGLUnsupportedError(`a ${type} in a uniform block; samplers are uniforms of their own`);
  throw new WebGLUnsupportedError(`the type \`${type}\` in a uniform block; use floats, ints, uints, booleans, vectors, matrices and structs of them`);
}

/** A member at the first offset from `cursor` its alignment allows: where it ends, and its alignment. */
function member(name: string, type: string, length: number | null, cursor: number, structs: Map<string, BlockStruct[]>, depth: number): { member: GlslBlockMember; end: number; align: number } {
  const laid = layOut(type, structs, depth);
  // An array's elements, and itself, are aligned to a vec4, each element padded to one.
  const align = length === null ? laid.align : roundUp(laid.align, 16);
  const stride = roundUp(laid.size, 16);
  const offset = roundUp(cursor, align);
  return {
    member: { name, type, ...(length === null ? {} : { length, stride }), offset, ...(laid.fields === undefined ? {} : { fields: laid.fields }) },
    end: offset + (length === null ? laid.size : length * stride),
    align,
  };
}

/** The uniforms of a member, named as WebGL names them: a struct is its fields, an array of structs each field of each element. */
function leaves(prefix: string, m: GlslBlockMember, base: number, out: BlockUniform[]): void {
  if (m.fields !== undefined) {
    for (let i = 0; i < (m.length ?? 1); i += 1) {
      const element = m.length === undefined ? `${prefix}${m.name}` : `${prefix}${m.name}[${i}]`;
      for (const f of m.fields) leaves(`${element}.`, f, base + m.offset + i * (m.stride ?? 0), out);
    }
    return;
  }
  out.push({
    name: `${prefix}${m.name}${m.length === undefined ? '' : '[0]'}`,
    type: m.type,
    length: m.length ?? 1,
    offset: base + m.offset,
    arrayStride: m.stride ?? 0,
    matrixStride: m.type.startsWith('mat') ? 16 : 0,
  });
}

const BLOCK = /(?:layout\s*\(([^)]*)\)\s*)?\buniform\s+(\w+)\s*\{([^}]*)\}\s*(?:(\w+)\s*(\[[^\]]*\])?\s*)?;/g;

/** The uniform blocks of a shader (its preprocessed `code`), in the order it declares them. */
export function parseBlocks(code: string, lengthOf: (text: string) => number | null, structs: Map<string, BlockStruct[]>): BlockInfo[] {
  const blocks: BlockInfo[] = [];
  for (const m of code.matchAll(BLOCK)) {
    const [, layout = '', name = '', body = '', instance, instanceArray] = m;
    for (const q of layout.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
      if (q === 'row_major') throw new WebGLUnsupportedError(`row_major on the uniform block ${name}; keep matrices column-major and transpose them when you fill the buffer`);
      if (q !== 'std140' && q !== 'column_major') throw new WebGLUnsupportedError(`layout(${q}) on the uniform block ${name}; WebGL allows std140 only`);
    }
    if (instanceArray !== undefined) throw new WebGLUnsupportedError(`the uniform block ${name} declared as an array of instances; declare one block, or several named blocks`);
    const members: GlslBlockMember[] = [];
    let end = 0;
    for (const statement of body.split(';')) {
      const f = /^\s*(?:layout\s*\(([^)]*)\)\s*)?(?:(?:highp|mediump|lowp|row_major|column_major)\s+)*(\w+)\s+([\s\S]+)$/.exec(statement);
      if (f === null) continue;
      if (/\brow_major\b/.test(statement) || /row_major/.test(f[1] ?? '')) throw new WebGLUnsupportedError(`row_major in the uniform block ${name}; keep matrices column-major and transpose them when you fill the buffer`);
      for (const declarator of f[3]!.split(',')) {
        const d = /^\s*(\w+)\s*(?:\[\s*([^\]]*?)\s*\])?\s*$/.exec(declarator);
        if (d === null) continue;
        const length = d[2] === undefined ? null : lengthOf(d[2]);
        if (d[2] !== undefined && length === null) throw new WebGLUnsupportedError(`the array length of ${name}.${d[1]} is not an integer expression of numbers and macros`);
        const laid = member(d[1]!, f[2]!, length, end, structs, 0);
        members.push(laid.member);
        end = laid.end;
      }
    }
    const block: BlockInfo = { name, named: instance !== undefined, size: end, members, uniforms: [] };
    for (const mem of members) leaves(instance === undefined ? '' : `${name}.`, mem, 0, block.uniforms);
    blocks.push(block);
  }
  return blocks;
}
