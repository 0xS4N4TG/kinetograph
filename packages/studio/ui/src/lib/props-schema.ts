// Reads the JSON Schema a composition's zod schema becomes (`CompositionInfo.propsSchema`) into the kind of field the
// Props tab draws. Anything not recognised is `null`, and the panel falls back to inferring from the value.

export type JsonSchema = Record<string, unknown>;

export type FieldKind =
  | { kind: 'enum'; options: (string | number)[] }
  | { kind: 'slider'; min: number; max: number; integer: boolean }
  | { kind: 'boolean' }
  | { kind: 'color' }
  | { kind: 'textarea' }
  | { kind: 'group'; properties: [string, JsonSchema][] }
  | { kind: 'panel'; plugin: string };

const COLOR_MARKER = '__remotion-color';
const TEXTAREA_MARKER = '__remotion-textarea';
const MARKERS = [COLOR_MARKER, TEXTAREA_MARKER, '__remotion-matrix'];

const isRecord = (value: unknown): value is JsonSchema =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The fields of an object schema, in the schema's order. */
export function schemaProperties(schema: JsonSchema | undefined): [string, JsonSchema][] {
  if (!schema || !isRecord(schema.properties)) return [];
  return Object.entries(schema.properties).filter((entry): entry is [string, JsonSchema] => isRecord(entry[1]));
}

export function fieldKind(schema: JsonSchema | undefined): FieldKind | null {
  if (!schema) return null;
  if (typeof schema.kinetographPanel === 'string') return { kind: 'panel', plugin: schema.kinetographPanel };
  if (schema.description === COLOR_MARKER) return { kind: 'color' };
  if (schema.description === TEXTAREA_MARKER) return { kind: 'textarea' };
  if (
    Array.isArray(schema.enum) &&
    schema.enum.length > 0 &&
    schema.enum.every((v) => typeof v === 'string' || typeof v === 'number')
  ) {
    return { kind: 'enum', options: schema.enum as (string | number)[] };
  }
  if (schema.type === 'boolean') return { kind: 'boolean' };
  if (
    (schema.type === 'number' || schema.type === 'integer') &&
    typeof schema.minimum === 'number' &&
    typeof schema.maximum === 'number' &&
    schema.maximum > schema.minimum
  ) {
    return {
      kind: 'slider',
      min: schema.minimum,
      max: schema.maximum,
      integer: schema.type === 'integer',
    };
  }
  if (schema.type === 'object' && schemaProperties(schema).length > 0)
    return { kind: 'group', properties: schemaProperties(schema) };
  return null;
}

/** What an optional field with no value is drawn as: its schema's type, so it gets its own control and not a JSON box. */
export function unsetType(schema: JsonSchema | undefined): 'boolean' | 'number' | 'string' | null {
  const type = schema?.type;
  if (type === 'boolean' || type === 'string') return type;
  if (type === 'number' || type === 'integer') return 'number';
  return null;
}

/** The field's `description` as helper text; Remotion's markers are not text. */
export function helperText(schema: JsonSchema | undefined): string | null {
  const text = schema?.description;
  return typeof text === 'string' && text !== '' && !MARKERS.includes(text) ? text : null;
}
