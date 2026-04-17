// Waves Pest Control — Brand Kit Tokens mirrored from wavespestcontrol.com (Astro)
// Drop-in replacement for ../theme: same shape (COLORS/FONTS/BUTTON_BASE/TIER/HALFTONE_*),
// so any page that currently imports `{ COLORS as B, FONTS, BUTTON_BASE, ... } from '../theme'`
// can swap to `'../theme-brand'` without touching JSX.

export const COLORS = {
  // Primary Blues (from Astro @theme brand tokens)
  wavesBlue: '#097ABD',    // was #2196F3
  blueDark: '#065A8C',
  blueDeeper: '#04395E',
  blueLight: '#E3F5FD',
  bluePale: '#4DC9F6',     // brand-sky
  blueSurface: '#F0F7FC',

  // Accents
  yellow: '#FFD700',       // brand-gold — CTA pills
  red: '#C0392B',          // brand-red
  redBright: '#C0392B',

  // Text hierarchy (Astro uses slate scale)
  navy: '#0F172A',         // slate-900 (Astro html color)
  textBody: '#334155',     // slate-700
  textCaption: '#64748B',  // slate-500

  // Neutrals
  white: '#FFFFFF',
  offWhite: '#F1F5F9',     // slate-100
  grayLight: '#CBD5E1',    // slate-300
  grayMid: '#64748B',      // slate-500
  grayDark: '#334155',     // slate-700

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

export const FONTS = {
  heading: "'Luckiest Guy', 'Baloo 2', cursive",
  body: "'Nunito', sans-serif",
  ui: "'Baloo 2', 'Nunito', sans-serif",
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
  fontFamily: FONTS.ui,            // Baloo 2 — readable at button size (Luckiest Guy is too aggressive)
  fontWeight: 800,
  fontSize: 14,
  border: 'none',
  cursor: 'pointer',
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  letterSpacing: '0.02em',
  transition: 'all 0.2s ease',
};

// Subtle brand-blue halftone texture (replaces old comic-book pattern)
export const HALFTONE_PATTERN = `radial-gradient(circle, ${COLORS.wavesBlue}0D 1px, transparent 1px)`;
export const HALFTONE_SIZE = '8px 8px';
