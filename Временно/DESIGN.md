---
name: Future Canvas
colors:
  surface: '#121316'
  surface-dim: '#121316'
  surface-bright: '#38393c'
  surface-container-lowest: '#0d0e11'
  surface-container-low: '#1a1c1e'
  surface-container: '#1e2022'
  surface-container-high: '#292a2c'
  surface-container-highest: '#333537'
  on-surface: '#e3e2e5'
  on-surface-variant: '#c3c7ce'
  inverse-surface: '#e3e2e5'
  inverse-on-surface: '#2f3033'
  outline: '#8d9198'
  outline-variant: '#43474e'
  surface-tint: '#aac9f0'
  primary: '#aac9f0'
  on-primary: '#0e3251'
  primary-container: '#7493b8'
  on-primary-container: '#032b4a'
  inverse-primary: '#416182'
  secondary: '#ffb956'
  on-secondary: '#462b00'
  secondary-container: '#c3841e'
  on-secondary-container: '#3d2500'
  tertiary: '#00dbe7'
  on-tertiary: '#00363a'
  tertiary-container: '#00a0a9'
  on-tertiary-container: '#002f32'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#d0e4ff'
  primary-fixed-dim: '#aac9f0'
  on-primary-fixed: '#001d35'
  on-primary-fixed-variant: '#294969'
  secondary-fixed: '#ffddb5'
  secondary-fixed-dim: '#ffb956'
  on-secondary-fixed: '#2a1800'
  on-secondary-fixed-variant: '#643f00'
  tertiary-fixed: '#74f5ff'
  tertiary-fixed-dim: '#00dbe7'
  on-tertiary-fixed: '#002022'
  on-tertiary-fixed-variant: '#004f54'
  background: '#121316'
  on-background: '#e3e2e5'
  surface-variant: '#333537'
typography:
  headline-lg:
    fontFamily: JetBrains Mono
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: JetBrains Mono
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: 0.05em
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  label-caps:
    fontFamily: JetBrains Mono
    fontSize: 10px
    fontWeight: '700'
    lineHeight: 12px
    letterSpacing: 0.1em
  data-mono:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
spacing:
  unit: 4px
  gutter: 16px
  margin-edge: 24px
  node-gap: 32px
---

## Brand & Style

The design system is engineered for high-performance decision-making, merging the clinical precision of a financial trading terminal with the expansive, navigational qualities of a star map. It targets professionals who manage complex, multi-dimensional data—ranging from personal health to market fluctuations—requiring a UI that feels like a mission-control dashboard.

The aesthetic follows a **Technical Minimalism** approach. It utilizes high data density, thin strokes, and purposeful light emissions to guide the eye without overwhelming the user. The atmosphere is quiet, focused, and immersive, evoking the feeling of looking through a telescope at a structured digital cosmos.

## Colors

The palette is anchored in a profound "Void" background (#0A0E14), ensuring maximum contrast for glowing elements.

- **Primary (Event Nodes):** A muted grey-blue (#5B7A9D) used for historical data and neutral state markers.
- **Secondary (Decision Nodes):** An amber-orange (#E8A33D) to highlight points of intervention or active choices.
- **Action/Now Line:** A piercing neon light blue (#00F2FF) to signify the immediate present.
- **Semantic Glows:** 
    - **Health:** Emerald green for vitality and biological metrics.
    - **Projects:** Deep purple for creative and structural milestones.
    - **Trading:** Electric blue for financial liquidity and market movements.
- **Connectors:** Semi-transparent thin lines that provide structural context without visual noise.

## Typography

This design system employs a dual-font strategy to balance technical utility with legibility.

- **JetBrains Mono** is the primary driver for data, headers, and UI labels. Its fixed-width nature ensures that numerical values and timestamps align perfectly in dense tables.
- **Inter** is used for descriptive body text and notes, providing a soft, human contrast to the rigid technical environment.
- **Uppercase Labels:** All functional UI labels (buttons, tab headers, axis titles) must be in uppercase with increased letter spacing to enhance the "terminal" aesthetic.

## Layout & Spacing

The layout follows a **Fixed Modular Grid** reminiscent of a trading station. 

- **The Canvas:** A non-linear, zoomable workspace where nodes are placed on a sub-grid of 4px increments.
- **Side Panels:** Fixed-width (280px - 320px) utility bars that house technical specs and metadata.
- **The 'Now' Line:** A vertical 1px neon blue line that stays centered or scrolls horizontally, acting as the temporal anchor.
- **Density:** Information is packed tightly. Margins within components are minimal (8px - 12px) to maximize the amount of visible data on a single screen.

## Elevation & Depth

Depth is conveyed through **Luminance and Opacity** rather than traditional shadows.

- **Background Layers:** The deepest layer is the solid hex #0A0E14. A subtle 10% opacity grid overlay provides a sense of scale.
- **Connectors:** Exist on the lowest interactive layer, often at 20-30% opacity, brightening only on hover.
- **Glow Effects:** Critical nodes utilize a `drop-shadow` with a 10px-15px blur of their respective category color to simulate light emission.
- **Borders:** UI panels use 1px solid borders (#1A1F26). No blurs or frosted glass are used; the interface is strictly opaque and "hard-surfaced."

## Shapes

The shape language is strictly **Geometric and Angular**. 

- **UI Elements:** Buttons, input fields, panels, and frames must have 0px corner radius.
- **Nodes:** The only exception to the sharp-corner rule. Nodes are circular to represent "celestial" points in the data map.
- **Indicators:** Use triangles or diamonds for directional shifts (e.g., market up/down) to maintain the technical, charting feel.

## Components

- **Nodes:** Circular elements. Event nodes have a 1px solid stroke; Goal nodes have a vibrant outer glow.
- **Buttons:** Rectangular, 0px radius. Default state is a ghost style (1px border). Active state is solid with the 'Now' Line blue.
- **Connectors:** 1px width. Use stepped (orthogonal) lines for logic flows or direct paths for the star map view.
- **Data Strips:** Horizontal rows of monochromatic data with JetBrains Mono, used in sidebars for quick scanning.
- **Input Fields:** Bottom-border only or 1px full-frame. The caret should be a solid block rather than a line.
- **Now Line:** A persistent 1px vertical stroke (#00F2FF) that cuts through the entire canvas height.
- **Tooltips:** Black backgrounds with a 1px primary-colored border. No transparency.