import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import '@fontsource-variable/dm-sans/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource/caveat/latin-700.css';
import '@fontsource/archivo-black/latin-400.css';
import '@fontsource-variable/geist'; // the footer's faces
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/newsreader/opsz-italic.css';
import '@/index.css';

export const metadata: Metadata = {
  title: 'Kinetograph',
  description:
    "Kinetograph is a blazingly fast programmatic video engine, made for agents. Write video in TypeScript with Remotion's API; it renders every frame on the GPU, with no browser in it.",
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
