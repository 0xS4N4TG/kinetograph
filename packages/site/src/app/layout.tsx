import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import '@fontsource-variable/dm-sans/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource-variable/sofia-sans-extra-condensed/wght.css'; // the display face
import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/newsreader/opsz-italic.css';
import '@/index.css';

export const metadata: Metadata = {
  title: 'Kinetograph',
  description:
    "Kinetograph is a video engine made for agents. Write a video in TypeScript with Remotion's API, or as an HTML page (HyperFrames projects render as they are). A Rust compositor draws every frame on the GPU, with no browser.",
};

export const viewport: Viewport = {
  themeColor: '#2238c4',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preload" href="/fonts/GeistSerifVF.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
      </head>
      <body>{children}</body>
    </html>
  );
}
