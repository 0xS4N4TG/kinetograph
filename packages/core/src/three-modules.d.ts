// What `three.tsx` uses of the project's own `three` and `@react-three/fiber` (peer dependencies, not installed here): the
// project's real types replace these wherever it has them.
declare module '@react-three/fiber' {
  import type { ComponentType, CSSProperties, ReactNode } from 'react';
  export interface CanvasProps {
    children?: ReactNode;
    style?: CSSProperties;
    frameloop?: 'always' | 'demand' | 'never';
    resize?: { scroll?: boolean; debounce?: number | { scroll: number; resize: number } };
    [prop: string]: unknown;
  }
  export const Canvas: ComponentType<CanvasProps>;
  export function extend(objects: Record<string, unknown>): void;
  export function useThree<T>(selector: (state: { advance: (timestamp: number) => void }) => T): T;
}
declare module 'three' {
  export class Group {}
}
