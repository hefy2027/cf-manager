---
name: RevenuePulse AI
colors:
  surface: '#081425'
  surface-dim: '#081425'
  surface-bright: '#2f3a4c'
  surface-container-lowest: '#040e1f'
  surface-container-low: '#111c2d'
  surface-container: '#152031'
  surface-container-high: '#1f2a3c'
  surface-container-highest: '#2a3548'
  on-surface: '#d8e3fb'
  on-surface-variant: '#cbc3d7'
  inverse-surface: '#d8e3fb'
  inverse-on-surface: '#263143'
  outline: '#958ea0'
  outline-variant: '#494454'
  surface-tint: '#d0bcff'
  primary: '#d0bcff'
  on-primary: '#3c0091'
  primary-container: '#a078ff'
  on-primary-container: '#340080'
  inverse-primary: '#6d3bd7'
  secondary: '#adc6ff'
  on-secondary: '#002e6a'
  secondary-container: '#0566d9'
  on-secondary-container: '#e6ecff'
  tertiary: '#4edea3'
  on-tertiary: '#003824'
  tertiary-container: '#00a572'
  on-tertiary-container: '#00311f'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#e9ddff'
  primary-fixed-dim: '#d0bcff'
  on-primary-fixed: '#23005c'
  on-primary-fixed-variant: '#5516be'
  secondary-fixed: '#d8e2ff'
  secondary-fixed-dim: '#adc6ff'
  on-secondary-fixed: '#001a42'
  on-secondary-fixed-variant: '#004395'
  tertiary-fixed: '#6ffbbe'
  tertiary-fixed-dim: '#4edea3'
  on-tertiary-fixed: '#002113'
  on-tertiary-fixed-variant: '#005236'
  background: '#081425'
  on-background: '#d8e3fb'
  surface-variant: '#2a3548'
typography:
  display-lg:
    fontFamily: Hanken Grotesk
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Hanken Grotesk
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Hanken Grotesk
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  headline-md:
    fontFamily: Hanken Grotesk
    fontSize: 24px
    fontWeight: '500'
    lineHeight: 32px
  body-lg:
    fontFamily: Manrope
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Manrope
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: 0.05em
  meta-sm:
    fontFamily: Manrope
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 8px
  container-padding: 32px
  gutter: 24px
  card-gap: 24px
  section-margin: 64px
---

## Brand & Style
The design system for RevenuePulse AI is built upon the "Crystalline Glassmorphism" aesthetic, conveying a sense of high-end precision, transparency, and forward-thinking intelligence. The target audience consists of high-growth enterprise leaders and data scientists who require clarity amidst complexity.

The visual style leverages **Glassmorphism** and **Minimalism** to create a multi-layered, airy interface. In this dark-mode evolution, surfaces are treated as tinted refractive lenses that sit atop a deep, fluid background. The emotional response is one of "Technical Sophistication"—where the UI feels as fast and transparent as the AI insights it provides. Key characteristics include high-transparency dark panels, vibrant accent glows, and generous whitespace to allow data to breathe against the midnight canvas.

## Colors
The palette centers on a trio of high-energy vibrancies optimized for a deep "Slate" dark-mode foundation.

- **Vibrant Purple (#8B5CF6):** The primary brand color, used for core actions, AI-generated insights, and high-level branding.
- **Electric Blue (#3B82F6):** Used for interactive elements, links, and growth metrics.
- **Emerald Green (#10B981):** Reserved for positive performance indicators, "success" states, and revenue growth.
- **Neutral Surface (#1E293B):** The foundational dark canvas color, providing a sophisticated, low-strain base for glass layers.
- **Primary Text (#F1F5F9):** A light gray/white that ensures high legibility against dark semi-transparent backgrounds.

## Typography
The typography system uses a tiered approach to balance character with functionality. 

- **Headlines:** Hanken Grotesk provides a sharp, contemporary "tech" feel with its precise geometric construction. Use it for all major headings and display data.
- **Body:** Manrope is chosen for its exceptional readability and balanced proportions, ensuring that long-form data reports are comfortable to read against dark backgrounds.
- **Labels & Mono:** JetBrains Mono is used sparingly for technical values, API keys, and specialized data labels to reinforce the "AI/Technical" nature of the product.
- **Hierarchy:** Maintain clear contrast by using Off-White (#F1F5F9) for primary headers and Muted Slate (#94A3B8) for secondary metadata and captions.

## Layout & Spacing
The layout follows a **Fluid Grid** model with high-margin "Safe Zones" to preserve the crystalline aesthetic. 

- **Desktop (1440px+):** 12-column grid, 24px gutters, 64px side margins.
- **Tablet (768px - 1024px):** 8-column grid, 16px gutters, 32px side margins.
- **Mobile (<768px):** 4-column grid, 12px gutters, 16px side margins.

Spacing should be used to create groups of "floating" modules. Avoid cramped layouts; the dark glass effect requires surrounding whitespace to effectively "catch" the underlying glows and blurs. Elements should follow an 8px rhythmic scale.

## Elevation & Depth
In the dark mode environment, elevation is achieved through **Backdrop Blurs**, **Luminous Outlines**, and **Internal Glows**.

1.  **Low Elevation (Surface):** Default dark background (#1E293B). No shadow.
2.  **Medium Elevation (Cards/Panels):** 10% white (or primary) fill at low opacity, 20px backdrop-blur. A subtle 1px inner stroke of semi-transparent white on the top and left edges creates a "rim light" effect.
3.  **High Elevation (Modals/Popovers):** 15% white fill, 30px backdrop-blur. Deep, expansive shadows with a subtle purple or neutral tint (e.g., `rgba(0, 0, 0, 0.4)`) with a 40px blur radius.

Always ensure that glass layers have a subtle, light border (outline-variant) to define their edges against the dark background.

## Shapes
The shape language is "Softly Geometric." 

- **Standard Containers:** Use `rounded-lg` (1rem / 16px) for main dashboard cards and glass panels.
- **Interactive Elements:** Use `rounded` (0.5rem / 8px) for input fields and buttons to maintain a precise, professional look.
- **Decorative Elements:** Search bars and status chips may use `rounded-xl` (1.5rem / 24px) to provide visual variety and a "friendly" touch to the AI interface.

## Components

### Buttons
- **Primary:** Solid Gradient (Vibrant Purple to Electric Blue), white text, subtle outer glow in the primary color.
- **Secondary (Glass):** Semi-transparent dark background, 1px light border, primary color or white text.
- **Hover States:** Increase backdrop-blur intensity and scale element by 1.02x for a tactile, physical feel.

### Cards
- **Crystalline Panels:** Low-opacity dark fills, 20px blur, 1px subtle top-border light-catch. 
- **Content:** Headlines in Off-White (#F1F5F9), body in Off-White with 70% opacity.

### Input Fields
- **Style:** Deep slate background (#0F172A) with a 1px inset shadow to look "carved" into the surface.
- **Focus:** Transition to a 2px Electric Blue border with a soft blue outer glow.

### Chips & Badges
- **Metric Badges:** Use the tertiary Emerald Green for positive growth numbers, optimized for dark-mode contrast.
- **AI Tags:** Small, Purple-tinted glass capsules with a subtle "sparkle" icon.

### Icons
- **System Icons:** 2px stroke width, multi-colored (e.g., a "Pulse" icon with a Purple stroke and an Electric Blue glow). Icons should use high-vibrancy colors to pop against the dark theme.