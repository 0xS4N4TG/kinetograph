import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import '@fontsource-variable/dm-sans/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource/caveat/latin-700.css';
import '@fontsource/shadows-into-light/latin-400.css';
import '@fontsource/indie-flower/latin-400.css';
import '@fontsource/gloria-hallelujah/latin-400.css';
import '@fontsource/patrick-hand/latin-400.css';
import '@fontsource/gochi-hand/latin-400.css';
import '@fontsource/archivo-black/latin-400.css';
import '@fontsource/abril-fatface/latin-400.css';
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
