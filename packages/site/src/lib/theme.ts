import type { ComponentProps } from 'react';
import type { RootProvider } from 'fumadocs-ui/provider/next';

/** next-themes options for the docs and the catalog: dark first, class based, and the inline script sets the class before paint. */
export const THEME: NonNullable<ComponentProps<typeof RootProvider>['theme']> = {
  attribute: 'class',
  defaultTheme: 'dark',
  enableSystem: true,
  disableTransitionOnChange: true,
};
