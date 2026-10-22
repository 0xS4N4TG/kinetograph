# Design Themes & Inspirations

This document captures all the references, links, themes, visual inspirations, and components requested for the Kinetograph landing site and studio UI.

---

## 1. Visual Style & Theme Inspirations

### Cobalt Toile Aesthetic
- **Reference URL / Source:**
  - Demo: [21st.dev Workshop — Cobalt Toile Landing](https://21stdev-my-components-one.vercel.app/#cobalt-toile-landing) by [@kedhareswer](https://21st.dev/@kedhareswer)
- **Palette & Tokens:**
  - Ink: Cobalt Blue (`#2238c4` / `oklab(...)`)
  - Paper: Warm Cream (`#f7f4ec`)
  - Deep / Night: Dark Navy (`#05060b` / `color-mix(...)`)
  - Warm Highlight: Gold (`#ffcd3c`)
- **Key Motifs:**
  - Classical architectural archway & pediments
  - Fine 18th-century French toile copperplate linework & engravings
  - Hand-drawn foliage, scrolling stems, leaves, moons, and stars
  - Editorial serif typography (`Iowan Old Style`, `Baskerville`, `Palatino`, `Georgia`)

### Hermes Agent Landing Page
- **Reference URL:** [https://hermes-agent.nousresearch.com/](https://hermes-agent.nousresearch.com/)
- **Inspirations:**
  - Minimalist terminal command bars with immediate one-click copy feedback (`$ npx ...`)
  - Clean typographic hierarchy and bold contrast
  - Technical, AI-agent native positioning

---

## 2. Component Systems & UI Libraries

### Coss UI (Base UI + Tailwind CSS + shadcn)
- **Documentation:** [https://coss.com/ui/docs](https://coss.com/ui/docs)
- **LLMs Guide:** [https://coss.com/llms.txt](https://coss.com/llms.txt)
- **Registry Endpoint:** `https://coss.com/ui/r/{name}.json`
- **Installed Packages:**
  - `@base-ui/react`
  - `@coss/ui` & `@coss/colors-neutral` via `shadcn@latest add @coss/ui`
- **Components Used:**
  - `Button`, `Tabs`, `Card`, `Badge`, `Accordion`, `Separator`, `CodeBlock`, `CommandBar`

### 21st.dev Component Ecosystem
- **Platform:** [https://21st.dev/](https://21st.dev/)
- **Featured Components & Creators:**
  - **Halftone Wordmark Footer** by [@kedhareswer](https://21st.dev/@kedhareswer):
    - Physics-based interactive 2D canvas
    - Area-true halftone dot grid rendering large typography (`"kinetograph"`)
    - Spring displacement on mouse hover with warm color shifting and shockwave ring on click
  - **Exploded Assembly Scroll:** [https://21st.dev/r/kedhareswer/exploded-assembly-scroll](https://21st.dev/r/kedhareswer/exploded-assembly-scroll)
  - **Spotlight Cards, Marquees & Shimmering Gradients**

---

## 3. Interactive Canvas Illustration

### The First Kinetograph (1891)
- **Historical Subject:** Thomas Edison & William Kennedy Dickson's 1891 prototype motion-picture camera.
- **Implementation (`src/art/`):** procedural SVG engravings, no image assets. `engrave.tsx` holds the
  primitives (seeded leaves, canopies, vines, rosettes, moons, hatching); `hero-plate.tsx` is the hero plate (a film
  strip across a cobalt engraving, with a muted loop of the launch film, `public/film/loop.mp4`, in the gate);
  `landscape.tsx` is the footer frieze with the Black Maria studio.

---

## 4. Studio UI Inspirations

### EffectCraft & FilmCraft (ArtCraft / Storytold)
- **EffectCraft (After Effects in Rust):** [https://github.com/storytold/effectcraft](https://github.com/storytold/effectcraft)
- **FilmCraft (Premiere Pro NLE in Rust):** [https://github.com/storytold/filmcraft](https://github.com/storytold/filmcraft)
- **Design Elements Adopted in Kinetograph Studio (`packages/studio/ui`):**
  - Docked NLE/Compositor panel architecture separated by `#0d0d0f` dark gutters and `#2680eb` active panel borders
  - Top Application Menu + Tool Bar (Selection, Hand, Zoom, Rotation, Anchor Point, Shape, Pen, Text, Snapping) + Workspace Switcher (`Default`, `Animation`, `Color & Inspect`, `Export`)
  - **Project Bin (`Project ≡`):** Top selected composition preview card, search filter, color swatches, and read-only bin status bar
  - **Composition Viewer / Program Monitor:** Active composition pill bar, Layer Transform bounding box & anchor reticle overlay, Title/Action Safe zones toggle, and NLE transport deck with blue digital timecode (`#4da3ff`)
  - **Properties & Effect Controls (`Scene` tab):** Collapsible property sections (`Layer Transform`, `Compositing & Effects`, `Text & Typography`, `Geometry & Bounds`) with AE stopwatch icons (`⏱`) and sky-blue numeric readouts
  - **Multi-Track Timeline:** AE switches column (`👁`, `🔒`, `#`, color swatch, layer name, type), work-area bracket bar with emerald cache line, color-coded layer/sequence bars (`text` crimson, `shape` indigo, `group` rose, `sequence` sandstone), and pentagon blue playhead

### snapcn Video Editor
- **Reference Image:** Uploaded snapcn studio screenshot
- **Design Elements:**
  - Precision dark theme using shadcn neutral black palette (`oklch(0.145 0 0)`)
  - Glowing playhead with frame-accurate cursor indicator
  - Gradient timeline clip bars with clear hierarchy for sequences and layers
  - Minimalist frame-tick ruler with zoom controls
