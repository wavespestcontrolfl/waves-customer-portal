// Waves Pest Control — Brand Kit Tokens mirrored from wavespestcontrol.com (Astro)
// Drop-in replacement for ../theme: same shape (COLORS/FONTS/BUTTON_BASE/TIER/HALFTONE_*),
// so any page that currently imports `{ COLORS as B, FONTS, BUTTON_BASE, ... } from '../theme'`
// can swap to `'../theme-brand'` without touching JSX.

export const COLORS = {
  // Primary Blues (from Astro @theme brand tokens, verified via live audit)
  wavesBlue: '#097ABD',    // --color-brand-blue
  blueDark: '#065A8C',     // --color-brand-blueDark
  blueDeeper: '#04395E',   // --color-brand-blueDeeper — headings on light bg
  blueLight: '#E3F5FD',    // --color-brand-blueLight — hover fills, soft wash
  sky: '#4DC9F6',          // --color-brand-sky — hero bg
  bluePale: '#4DC9F6',     // alias for sky
  blueSurface: '#F0F7FC',  // extra-light wash

  // Accents (gold pills are the primary CTA pattern)
  yellow: '#FFD700',       // --color-brand-gold — CTA pill fill
  yellowHover: '#FFF176',  // --color-brand-yellow — hover state for gold CTA
  red: '#C0392B',          // --color-brand-red — emergency/accent only
  redBright: '#C0392B',

  // Text hierarchy (Tailwind slate scale)
  navy: '#0F172A',         // slate-900 — strongest text, Astro html color
  textBody: '#334155',     // slate-700 — default body copy
  textCaption: '#64748B',  // slate-500 — muted / caption

  // Neutrals
  white: '#FFFFFF',
  offWhite: '#F1F5F9',     // slate-100 — alt backgrounds
  grayLight: '#CBD5E1',    // slate-300 — subtle borders
  grayMid: '#64748B',      // slate-500 — muted icons / secondary text
  grayDark: '#334155',     // slate-700 — body text
  slate200: '#E2E8F0',     // chip border default
  slate600: '#475569',     // slate-600 — body alt

  // Status
  green: '#16A34A',
  orange: '#F59E0B',
  teal: '#0EA5E9',
};

// Legacy aliases — keeps existing references working without mass find/replace
COLORS.navyLight = COLORS.blueDark;
COLORS.blueBright = COLORS.wavesBlue;
COLORS.blueSky = COLORS.bluePale;
COLORS.redDark = COLORS.red;
COLORS.orangeBright = '#FB923C';

// Font hierarchy mirrors wavespestcontrol.com global.css:
//   h1, h2 → Luckiest Guy (blocky "WAVES" van font) — heroes only
//   h3–h6 → Baloo 2 (rounded subhead)
//   body  → Nunito
//   mono  → JetBrains Mono
export const FONTS = {
  display: "'Luckiest Guy', 'Baloo 2', cursive",   // H1/H2 heroes only
  heading: "'Baloo 2', 'Nunito', sans-serif",      // H3–H6, card titles, buttons
  body: "'Nunito', sans-serif",                    // default body
  ui: "'Baloo 2', 'Nunito', sans-serif",           // buttons, labels (same as heading — kept for clarity)
  mono: "'JetBrains Mono', ui-monospace, monospace",
};

export const TIER = {
  Bronze: {
    color: '#CD7F32',
    gradientFrom: '#CD7F32',
    gradientTo: '#A0522D',
    discount: '0%',
  },
  Silver: {
    color: COLORS.blueLight,
    gradientFrom: COLORS.blueLight,
    gradientTo: COLORS.blueDark,
    discount: '10%',
  },
  Gold: {
    color: COLORS.yellow,
    gradientFrom: COLORS.yellow,
    gradientTo: '#F9A825',
    discount: '15%',
    darkText: true,
  },
  Platinum: {
    color: '#E5E4E2',
    gradientFrom: '#E5E4E2',
    gradientTo: '#8E8D8A',
    discount: '20%',
    darkText: true,
  },
};

export const BUTTON_BASE = {
  borderRadius: 9999,              // Astro uses rounded-full pills
  fontFamily: FONTS.ui,            // Baloo 2 — readable at button size
  fontWeight: 800,
  fontSize: 14,
  border: 'none',
  cursor: 'pointer',
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  letterSpacing: '0.02em',
  transition: 'all 0.15s cubic-bezier(0.4, 0, 0.2, 1)',  // Tailwind v4 default
};

// Border radius scale (matches Astro --radius-* tokens)
export const RADIUS = {
  md: 6,       // --radius-md  (0.375rem)
  lg: 8,       // --radius-lg  (0.5rem)
  xl: 12,      // --radius-xl  (0.75rem) — chip/card default
  '2xl': 16,   // --radius-2xl (1rem)    — card default
  '3xl': 24,   // --radius-3xl (1.5rem)  — hero card
  full: 9999,  // rounded-full
};

// Shadow scale (Tailwind ladder, verified via audit)
export const SHADOWS = {
  sm: '0 1px 3px 0 rgba(0,0,0,.1), 0 1px 2px -1px rgba(0,0,0,.1)',
  md: '0 4px 6px -1px rgba(0,0,0,.1), 0 2px 4px -2px rgba(0,0,0,.1)',
  lg: '0 10px 15px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1)',
  xl: '0 20px 25px -5px rgba(0,0,0,.1), 0 8px 10px -6px rgba(0,0,0,.1)',
  '2xl': '0 25px 50px -12px rgba(0,0,0,.25)',
  goldRing: '0 0 0 4px #FFD700, 0 25px 50px -12px rgba(0,0,0,.25)',
};

// Section rhythm — strict white ↔ #097ABD alternation, py-20 md:py-28
// Use via: <section style={SECTION_PAD}> etc. padding works both axes.
export const SECTION_PAD = {
  paddingTop: 'clamp(80px, 8vw, 112px)',
  paddingBottom: 'clamp(80px, 8vw, 112px)',
  paddingLeft: 24,
  paddingRight: 24,
};

// Primary CTA pill (gold → blueDeeper). Pass as `style={GOLD_CTA}` or spread.
export const GOLD_CTA = {
  ...BUTTON_BASE,
  background: COLORS.yellow,
  color: COLORS.blueDeeper,
  height: 40,
  paddingLeft: 20,
  paddingRight: 20,
  boxShadow: SHADOWS.md,
};

// Subtle brand-blue halftone texture (replaces old comic-book pattern)
export const HALFTONE_PATTERN = `radial-gradient(circle, ${COLORS.wavesBlue}0D 1px, transparent 1px)`;
export const HALFTONE_SIZE = '8px 8px';
