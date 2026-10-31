import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Composition, getCompositions, propsSchemaOf, registerRoot, resetCompositions } from '../src/compositions.js';
import { zColor, zTextarea } from '../src/zod-types.js';

afterEach(resetCompositions);

const Noop = () => null;

describe('propsSchema', () => {
  it('turns a zod schema into JSON Schema, keeping descriptions and meta', () => {
    const schema = z.object({
      title: z.string().describe('The headline'),
      speed: z.number().min(0).max(10),
      mode: z.enum(['a', 'b']),
      tint: zColor(),
      note: zTextarea(),
      look: z.object({ seed: z.number() }).meta({ kinetographPanel: '@kinetographdev/hexed' }),
    });
    registerRoot(() => (
      <Composition id="A" component={Noop} width={10} height={10} fps={30} durationInFrames={5} schema={schema} />
    ));
    const [info] = getCompositions();
    const props = (info!.propsSchema as any).properties;
    expect(props.title.description).toBe('The headline');
    expect(props.speed).toMatchObject({ type: 'number', minimum: 0, maximum: 10 });
    expect(props.mode.enum).toEqual(['a', 'b']);
    expect(props.tint.description).toBe('__remotion-color');
    expect(props.note.description).toBe('__remotion-textarea');
    expect(props.look.kinetographPanel).toBe('@kinetographdev/hexed');
  });

  it('is absent without a schema, for a non-zod schema, and when conversion throws', () => {
    expect(propsSchemaOf(undefined)).toBeUndefined();
    expect(propsSchemaOf({ parse: () => 1 })).toBeUndefined();
    expect(propsSchemaOf({ _zod: {} })).toBeUndefined();
    registerRoot(() => <Composition id="A" component={Noop} width={10} height={10} fps={30} durationInFrames={5} />);
    expect('propsSchema' in getCompositions()[0]!).toBe(false);
  });
});
