import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/newsreader/opsz-italic.css';
import '@/index.css';

export const metadata: Metadata = {
  title: 'Kinetograph',
  description:
    "Kinetograph is a programmatic video engine with no browser in it. You write video in TypeScript with Remotion's API and it renders every frame on the GPU.",
};

export const viewport: Viewport = {
  themeColor: '#2238c4',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
