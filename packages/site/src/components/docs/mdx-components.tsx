import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { Steps } from 'fumadocs-ui/components/steps';
import defaultMdxComponents from 'fumadocs-ui/mdx';

import { Card, CardGroup, Note, Step, Tip, Warning } from '@/components/docs/blocks';
import { FilmGrid } from '@/components/docs/film-grid';
import { Terminal, TwoUp } from '@/components/docs/figures';
import { IconTabs, Tab } from '@/components/docs/icon-tabs';
import { InstallCard } from '@/components/docs/install-card';
import { LinkCard } from '@/components/docs/link-card';
import { Media } from '@/components/docs/media';
import { DocsPre, PromptBox } from '@/components/docs/mdx';
import { RouteGrid } from '@/components/docs/route-grid';
import { TasteGallery } from '@/components/docs/taste-gallery';
import { Video } from '@/components/docs/video';
import { EngineDiagram } from '@/components/engine-diagram';

/**
 * The MDX components of the docs, shared by the docs pages and the catalog's plugin pages. As written in a page:
 * - ```tsx title="src/MyComp.tsx"  a code block headed by its file name, with a copy button (DocsPre).
 * - ```txt with ├─ │ └─ branches  a file tree (DocsPre spots the branches): a trailing / marks a folder, text
 *   after two spaces is a comment. It copies as plain text. Add title="..." for a header.
 * - ```txt title="Suggested prompt"  a prompt box when the text starts with /skill-name; or write
 *   <Prompt skill="kinetograph-markup">Add motion blur to my text</Prompt>.
 * - <Media src="studio/window-light.webp" dark="studio/window-dark.webp" width={1600} height={1160} alt="..." />
 *   a picture from public/docs-media, or a looping clip for an .mp4 (components/docs/media.tsx).
 * - <Video name="first-video" label="..." caption="..." silent />  a hosted clip with a poster (components/docs/video.tsx;
 *   base URL in sections/links.ts).
 * - <FilmGrid /> / <LinkCard title icon href> / <Card> / <CardGroup cols> / <Steps><Step title> / <Tip> / <Note>:
 *   the HyperFrames-style blocks (components/docs/film-grid.tsx, link-card.tsx, blocks.tsx).
 * - <TasteGallery />  every taste of the catalog as a looping clip with its name (components/docs/taste-gallery.tsx).
 */
export const docsMdxComponents = {
  ...defaultMdxComponents,
  pre: DocsPre,
  Media,
  Video,
  FilmGrid,
  IconTabs,
  InstallCard,
  Terminal,
  TwoUp,
  RouteGrid,
  LinkCard,
  Card,
  CardGroup,
  Steps,
  Step,
  Tip,
  Note,
  TasteGallery,
  Prompt: PromptBox,
  Accordion,
  Accordions,
  AccordionGroup: Accordions,
  Warning,
  EngineDiagram,
  Tab,
};
