// Waves Pest Control — Brand Kit Tokens
// Mirror of wavespestcontrol.com (Astro) design tokens — source: wavespestcontrol-astro/docs/STYLE_GUIDE.md
// Last sync: 2026-04-18 — unified .btn system (primary/info/secondary/nav/utility/tertiary),
// uppercase default, section heading+subhead pattern, FAQ/review card/form-header tokens.
//
// Drop-in replacement for ../theme: same shape (COLORS/FONTS/BUTTON_BASE/TIER/HALFTONE_*),
// so any page that currently imports `{ COLORS as B, FONTS, BUTTON_BASE, ... } from '../theme'`
// can swap to `'../theme-brand'` without touching JSX.

// =============================================================================
// 1. COLORS — brand palette (van-wrap Pantone spec) + button system colors + slate neutrals
// =============================================================================
export const COLORS = {
  // Primary Blues (--color-brand-* in Astro @theme)
  wavesBlue: '#009CDE',    // PMS 2925 — van body, section bg, links
  blueDark: '#065A8C',     // interstitial
  blueDeeper: '#1B2C5B',   // PMS 2766 — headings on light bg, .btn border/shadow color
  blueLight: '#E3F5FD',    // hover fills, soft wash
  sky: '#4DC9F6',          // hero bg
  bluePale: '#4DC9F6',     // alias for sky
  blueSurface: '#F0F7FC',  // extra-light wash

  // Button system (non-tokenized in Astro — inline in @layer components)
  buttonInfo: '#2E7DB3',       // .btn-info background — secondary blue CTA
  buttonInfoHover: '#256BA0',  // .btn-info:hover

  // Accents — gold is the primary CTA fill
  yellow: '#FFD700',       // --color-brand-gold — CTA pill fill
  yellowHover: '#FFF176',  // --color-brand-yellow — hover state for gold CTA
  red: '#C8102E',          // --color-brand-red (PMS 186)
  redBright: '#C8102E',

  // Text hierarchy (Tailwind slate scale)
  navy: '#0F172A',         // slate-900 — strongest text, Astro html color
  textBody: '#334155',     // slate-700 — default body copy
  textCaption: '#64748B',  // slate-500 — muted / caption

  // Neutrals
  white: '#FFFFFF',
  offWhite: '#F1F5F9',     // slate-100 — alt backgrounds
  grayLight: '#CBD5E1',    // slate-300 — subtle borders
  grayMid: '#64748B',      // slate-500 — muted icons
  grayDark: '#334155',     // slate-700 — body text
  slate200: '#E2E8F0',
  slate600: '#475569',
  slate700: '#334155',     // explicit alias for FAQ/body answer color

  // Google Business Profile review-card tokens (intentionally non-brand)
  gbpAvatar: '#1a73e8',    // blue avatar circle
  gbpPrimary: '#202124',   // reviewer name
  gbpMuted: '#70757a',     // reviewer location
  gbpStars: '#fbbc04',     // yellow stars
  gbpBody: '#3c4043',      // review body text

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

// =============================================================================
// 2. FONTS — stacks mirror Astro global.css @theme
// =============================================================================
//   H1, H2            → Anton (condensed heavy display, van-wrap character)
//   H3, H4            → Montserrat (proportional geometric, step-down)
//   body / buttons    → Inter (neutral UI sans)
//   long-form / prose → Source Serif 4
//   mono              → JetBrains Mono
export const FONTS = {
  display: "'Anton', 'Burbank Big Condensed', 'Luckiest Guy', cursive",  // H1/H2 only
  heading: "'Montserrat', 'Inter', system-ui, sans-serif",               // H3/H4, card titles
  body: "'Inter', system-ui, sans-serif",                                // default body, H5/H6
  ui: "'Inter', system-ui, sans-serif",                                  // buttons, labels, forms
  sub: "'Inter', system-ui, sans-serif",                                 // font-sub alias (section subheads)
  serif: "'Source Serif 4', Georgia, 'Times New Roman', serif",          // long-form prose
  mono: "'JetBrains Mono', ui-monospace, monospace",
};

// =============================================================================
// 3. RADIUS — matches Astro --radius-* tokens
// =============================================================================
export const RADIUS = {
  md: 6,         // --radius-md  (0.375rem)
  lg: 8,         // --radius-lg  (0.5rem)
  xl: 12,        // --radius-xl  (0.75rem) — .btn default, chip/card
  '2xl': 16,     // --radius-2xl (1rem)    — card default
  '3xl': 24,     // --radius-3xl (1.5rem)  — hero card
  full: 9999,    // rounded-full
  button: 12,    // .btn uses var(--btn-radius) = 12px (Astro unified button)
};

// =============================================================================
// 4. SHADOWS — Tailwind ladder + .btn 3D-offset-shadow identity
// =============================================================================
export const SHADOWS = {
  sm: '0 1px 3px 0 rgba(0,0,0,.1), 0 1px 2px -1px rgba(0,0,0,.1)',
  md: '0 4px 6px -1px rgba(0,0,0,.1), 0 2px 4px -2px rgba(0,0,0,.1)',
  lg: '0 10px 15px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1)',
  xl: '0 20px 25px -5px rgba(0,0,0,.1), 0 8px 10px -6px rgba(0,0,0,.1)',
  '2xl': '0 25px 50px -12px rgba(0,0,0,.25)',
  goldRing: '0 0 0 4px #FFD700, 0 25px 50px -12px rgba(0,0,0,.25)',

  // Button offset-shadow identity (from Astro .btn system — navy block behind pill)
  btnRest:     `4px 4px 0 ${COLORS.blueDeeper}`,
  btnHover:    `6px 6px 0 ${COLORS.blueDeeper}`,
  btnActive:   `1px 1px 0 ${COLORS.blueDeeper}`,
  // Inverse (used on .btn-secondary — gold block behind navy pill)
  btnInverseRest:   `4px 4px 0 ${COLORS.yellow}`,
  btnInverseHover:  `6px 6px 0 ${COLORS.yellow}`,
  btnInverseActive: `1px 1px 0 ${COLORS.yellow}`,
  // Compact nav (.btn-nav — 3px offset)
  btnNavRest:   `3px 3px 0 ${COLORS.blueDeeper}`,
  btnNavHover:  `5px 5px 0 ${COLORS.blueDeeper}`,
  btnNavActive: `1px 1px 0 ${COLORS.blueDeeper}`,
};

// =============================================================================
// 5. BUTTON SYSTEM — unified .btn + 6 variants (lifted from Astro global.css)
// =============================================================================
// All buttons share: 2px navy border, 12px radius, 3D navy offset shadow,
// Inter font, uppercase text, hover translate(-2,-2), active translate(+2,+2).
// Variants differ only in color + size.

// Legacy BUTTON_BASE — pill shape, preserved so existing portal pages
// (LoginPage, PortalPage, OnboardingPage, EstimateViewPage, ReportViewPage)
// keep their current look when they spread `{...BUTTON_BASE, background, color, ...}`.
// For the unified .btn system, use the GOLD_CTA / INFO_CTA / NAVY_CTA named exports below.
export const BUTTON_BASE = {
  borderRadius: RADIUS.full,            // 9999 — pill (legacy portal convention)
  fontFamily: FONTS.ui,
  fontWeight: 800,
  fontSize: 14,
  border: 'none',
  cursor: 'pointer',
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  letterSpacing: '0.02em',
  transition: 'all 0.15s cubic-bezier(0.4, 0, 0.2, 1)',
};

// Unified .btn base — lifted verbatim from Astro global.css. Matches shape/border/shadow/uppercase.
// Use for new components built from the waves style guide.
export const BTN_BASE = {
  fontFamily: FONTS.ui,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  borderRadius: RADIUS.button,          // 12px
  border: `2px solid ${COLORS.blueDeeper}`,
  cursor: 'pointer',
  textDecoration: 'none',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
  boxShadow: SHADOWS.btnRest,
  transition: 'background-color 150ms ease-out, color 150ms ease-out, transform 150ms ease-out, box-shadow 150ms ease-out',
  WebkitTapHighlightColor: 'transparent',
  touchAction: 'manipulation',
};

// Variant styles — spread over BTN_BASE. e.g. `style={{ ...BTN_BASE, ...BUTTON_PRIMARY }}`
export const BUTTON_PRIMARY = {
  fontSize: 16,
  fontWeight: 800,
  letterSpacing: '0.01em',
  lineHeight: 1,
  padding: '16px 24px',
  minHeight: 48,
  background: COLORS.yellow,            // gold
  color: COLORS.blueDeeper,             // navy text
};

export const BUTTON_INFO = {
  fontSize: 16,
  fontWeight: 800,
  letterSpacing: '0.01em',
  lineHeight: 1,
  padding: '16px 24px',
  minHeight: 48,
  background: COLORS.buttonInfo,        // #2E7DB3 blue
  color: COLORS.white,
};

export const BUTTON_SECONDARY = {
  fontSize: 15,
  fontWeight: 700,
  lineHeight: 1,
  padding: '14px 22px',
  minHeight: 44,
  background: COLORS.blueDeeper,        // navy
  color: COLORS.yellow,                 // gold text
  borderColor: COLORS.yellow,           // gold border
  boxShadow: SHADOWS.btnInverseRest,    // gold block behind pill
};

export const BUTTON_NAV = {
  fontSize: 13,
  fontWeight: 800,
  letterSpacing: '0.04em',
  lineHeight: 1,
  padding: '10px 16px',
  minHeight: 40,
  background: COLORS.yellow,
  color: COLORS.blueDeeper,
  boxShadow: SHADOWS.btnNavRest,        // 3px offset (compact)
};

export const BUTTON_UTILITY = {
  fontSize: 13,
  fontWeight: 700,
  lineHeight: 1,
  padding: '8px 14px',
  minHeight: 36,
  background: 'transparent',
  color: COLORS.blueDeeper,
  border: `2px solid ${COLORS.blueDeeper}`,
  boxShadow: 'none',
};

export const BUTTON_TERTIARY = {
  fontSize: 15,
  fontWeight: 600,
  lineHeight: 1.2,
  padding: '8px 4px',
  minHeight: 44,
  background: 'transparent',
  color: COLORS.blueDeeper,
  border: 'none',
  boxShadow: 'none',
  borderRadius: 0,
  textUnderlineOffset: 4,
  textDecorationThickness: 2,
  textTransform: 'uppercase',           // keeps parity with other variants
};

// Convenience full objects — pass directly as style={GOLD_CTA}, etc.
// These use BTN_BASE (unified .btn system — 12px radius, navy border, offset shadow).
export const GOLD_CTA    = { ...BTN_BASE, ...BUTTON_PRIMARY };
export const INFO_CTA    = { ...BTN_BASE, ...BUTTON_INFO };
export const NAVY_CTA    = { ...BTN_BASE, ...BUTTON_SECONDARY };
export const NAV_CTA     = { ...BTN_BASE, ...BUTTON_NAV };
export const UTILITY_CTA = { ...BTN_BASE, ...BUTTON_UTILITY };
export const TEXT_LINK   = { ...BTN_BASE, ...BUTTON_TERTIARY };

// =============================================================================
// 6. TYPOGRAPHY PATTERNS — reusable style objects for section rhythm
// =============================================================================

// Section H2 on white bg — matches Astro pattern: font-heading text-3xl md:text-5xl font-bold text-brand-blueDeeper leading-tight
export const SECTION_HEADING = {
  fontFamily: FONTS.display,
  fontSize: 'clamp(30px, 4vw, 54px)',   // text-3xl → text-5xl
  fontWeight: 700,
  letterSpacing: '0.02em',
  lineHeight: 1.1,
  color: COLORS.blueDeeper,
};
export const SECTION_HEADING_ON_BLUE = { ...SECTION_HEADING, color: COLORS.white };

// Section subhead — matches Astro: font-sub text-slate-600 text-[20px] font-medium leading-relaxed
export const SECTION_SUBHEAD = {
  fontFamily: FONTS.sub,
  fontSize: 20,
  fontWeight: 500,
  lineHeight: 1.625,
  color: COLORS.slate600,
};
export const SECTION_SUBHEAD_ON_BLUE = { ...SECTION_SUBHEAD, color: COLORS.white };

// Service-card title — matches Astro: font-heading text-2xl font-extrabold text-brand-blueDeeper
export const CARD_TITLE = {
  fontFamily: FONTS.display,
  fontSize: 27,                          // text-2xl at 18px root
  fontWeight: 800,
  letterSpacing: '0.02em',
  lineHeight: 1.15,
  color: COLORS.blueDeeper,
};

// Card body — 16px slate-600 leading-relaxed
export const CARD_BODY = {
  fontFamily: FONTS.body,
  fontSize: 16,
  lineHeight: 1.625,
  color: COLORS.slate600,
};

// FAQ question — matches Astro: font-heading text-2xl font-extrabold text-brand-blueDeeper (same as CARD_TITLE)
export const FAQ_QUESTION = { ...CARD_TITLE };

// FAQ answer — matches Astro hero subhead style: font-sub text-[20px] font-medium leading-relaxed text-slate-700
export const FAQ_ANSWER = {
  fontFamily: FONTS.sub,
  fontSize: 20,
  fontWeight: 500,
  lineHeight: 1.625,
  color: COLORS.slate700,
};

// Form card header (SliderForm) — font-heading text-2xl md:text-3xl font-bold text-brand-blueDeeper uppercase
export const FORM_HEADER = {
  fontFamily: FONTS.display,
  fontSize: 'clamp(24px, 3vw, 30px)',    // text-2xl → text-3xl
  fontWeight: 700,
  letterSpacing: '0.02em',
  lineHeight: 1.15,
  textTransform: 'uppercase',
  color: COLORS.blueDeeper,
};

// Form card excerpt — font-sub text-slate-600 text-base leading-relaxed
export const FORM_EXCERPT = {
  fontFamily: FONTS.sub,
  fontSize: 16,
  fontWeight: 400,
  lineHeight: 1.625,
  color: COLORS.slate600,
};

// =============================================================================
// 7. REVIEW CARD — Google Business Profile style (not brand-tokenized by design)
// =============================================================================
export const REVIEW_CARD = {
  container: {
    background: COLORS.white,
    borderRadius: 8,
    boxShadow: SHADOWS.sm,
    padding: 20,
    fontFamily: "'Roboto', Arial, sans-serif",  // deliberately GBP-like
    display: 'flex',
    flexDirection: 'column',
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: '50%',
    background: COLORS.gbpAvatar,
    color: COLORS.white,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 500,
    fontSize: 16,
  },
  name: { fontSize: 14, fontWeight: 500, color: COLORS.gbpPrimary, lineHeight: 1.1 },
  location: { fontSize: 12, color: COLORS.gbpMuted, marginTop: 2 },
  stars: { fontSize: 14, lineHeight: 1, color: COLORS.gbpStars },
  body: { fontSize: 14, lineHeight: 1.5, color: COLORS.gbpBody },
};

// =============================================================================
// 8. MEMBERSHIP TIERS (Bronze/Silver/Gold/Platinum pricing tiers)
// =============================================================================
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

// =============================================================================
// 9. SECTION RHYTHM — strict white ↔ #009CDE alternation, py-20 md:py-28
// =============================================================================
export const SECTION_PAD = {
  paddingTop: 'clamp(80px, 8vw, 112px)',
  paddingBottom: 'clamp(80px, 8vw, 112px)',
  paddingLeft: 24,
  paddingRight: 24,
};

// =============================================================================
// 10. HALFTONE — subtle brand-blue pattern
// =============================================================================
export const HALFTONE_PATTERN = `radial-gradient(circle, ${COLORS.wavesBlue}0D 1px, transparent 1px)`;
export const HALFTONE_SIZE = '8px 8px';
