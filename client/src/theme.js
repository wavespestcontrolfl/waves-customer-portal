// Waves Pest Control — Brand Kit Tokens (Rebrand v2.0)

export const COLORS = {
  // Primary Blues
  wavesBlue: '#2196F3',
  blueDark: '#1565C0',
  blueDeeper: '#0D47A1',
  blueLight: '#90CAF9',
  bluePale: '#BBDEFB',
  blueSurface: '#E3F2FD',

  // Accent
  yellow: '#FDD835',
  red: '#A83B34',
  redBright: '#C0392B',

  // Text hierarchy
  navy: '#1E1E2B',        // Primary text: headers, card titles, amounts — ALWAYS dark
  textBody: '#455A64',    // Body text: descriptions, notes, dates — readable on white
  textCaption: '#90A4AE', // Captions ONLY: timestamps, file sizes, fine print

  // Neutrals
  white: '#FFFFFF',
  offWhite: '#F5F5F5',
  grayLight: '#E0E0E0',
  grayMid: '#757575',     // Secondary text: inactive tabs, labels
  grayDark: '#455A64',    // Alias for textBody — backward compat

  // Status
  green: '#4CAF50',
  orange: '#FF9800',
  teal: '#00BCD4',
};

// Legacy aliases — keeps existing references working without mass find/replace
COLORS.navyLight = COLORS.blueDark;
COLORS.blueBright = COLORS.wavesBlue;
COLORS.blueSky = COLORS.bluePale;
COLORS.redDark = COLORS.red;
COLORS.orangeBright = '#FFA726';

export const FONTS = {
  heading: "'Montserrat', sans-serif",
  body: "'Nunito Sans', sans-serif",
  ui: "'Poppins', sans-serif",
};

export const TIER = {
  Bronze: {
    color: '#CD7F32',
    gradientFrom: '#CD7F32',
    gradientTo: '#A0522D',
    discount: '10%',
  },
  Silver: {
    color: COLORS.blueLight,
    gradientFrom: COLORS.blueLight,
    gradientTo: COLORS.blueDark,
    discount: '15%',
  },
  Gold: {
    color: COLORS.yellow,
    gradientFrom: COLORS.yellow,
    gradientTo: '#F9A825',
    discount: '20%',
    darkText: true,
  },
  Platinum: {
    color: '#E5E4E2',
    gradientFrom: '#E5E4E2',
    gradientTo: '#8E8D8A',
    discount: '30%',
    darkText: true,
  },
};

export const BUTTON_BASE = {
  borderRadius: 12,
  fontFamily: FONTS.heading,
  fontWeight: 700,
  fontSize: 14,
  border: 'none',
  cursor: 'pointer',
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'all 0.3s ease',
};

// Halftone dot pattern as CSS background (comic-book texture)
export const HALFTONE_PATTERN = `radial-gradient(circle, ${COLORS.wavesBlue}0D 1px, transparent 1px)`;
export const HALFTONE_SIZE = '8px 8px';
