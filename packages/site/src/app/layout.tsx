import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';

import '@fontsource-variable/dm-sans/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/newsreader/opsz-italic.css';
import '@/index.css';

/** The display face, from the fontsource package's latin file, so Next preloads it and sizes the fallback to match. */
const display = localFont({
  src: '../../node_modules/@fontsource-variable/sofia-sans-extra-condensed/files/sofia-sans-extra-condensed-latin-wght-normal.woff2',
  weight: '1 1000',
  variable: '--kg-display-face',
  display: 'swap',
  adjustFontFallback: 'Arial',
});

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
    <html lang="en" className={display.variable}>
      <body>{children}</body>
    </html>
  );
}
