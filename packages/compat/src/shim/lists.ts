// NodeList and HTMLCollection as real classes, so `x instanceof NodeList` holds for what querySelectorAll, childNodes, children and
// getElementsBy* return (anime.js and Motion test for it). They stay Arrays underneath: code written for the old array return keeps working.

export class NodeList<T = unknown> extends Array<T> {
  static get [Symbol.species](): ArrayConstructor {
    return Array;
  }
  item(index: number): T | null {
    return this[index] ?? null;
  }
}

export class HTMLCollection<T = unknown> extends Array<T> {
  static get [Symbol.species](): ArrayConstructor {
    return Array;
  }
  item(index: number): T | null {
    return this[index] ?? null;
  }
  namedItem(name: string): T | null {
    const attr = (e: T, key: string): string | null => (e as { getAttribute?: (n: string) => string | null }).getAttribute?.(key) ?? null;
    return this.find((e) => attr(e, 'id') === name || attr(e, 'name') === name) ?? null;
  }
}

export const nodeListOf = <T>(items: readonly T[]): NodeList<T> => NodeList.from(items) as NodeList<T>;
export const collectionOf = <T>(items: readonly T[]): HTMLCollection<T> => HTMLCollection.from(items) as HTMLCollection<T>;
