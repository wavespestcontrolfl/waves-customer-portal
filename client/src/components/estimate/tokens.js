// Canonical estimate-surface palette (estimate audit 2026-07-07).
//
// Before this file, 13 estimate components each carried a copy-pasted local
// `const W = {...}` — same hexes re-typed with drifting key names, two greens,
// three different values all named `border`, and one file where `navy` meant
// a different color than everywhere else. This is the single source; values
// come from theme-customer/theme-brand where they exist there, and stay
// literal where the estimate surface is intentionally its own thing.
//
// Deliberately NOT merged (same-looking pairs with different meanings):
// - red: the estimate/customer alert red is #C8312F (matches the admin
//   Customers-V2 alert red); theme-brand's #C8102E (PMS 186) is the MARKETING
//   brand red — do not swap one for the other.
// - gold: the estimate accent gold is #F0A500 (stars, chips, glass CTA);
//   theme-brand's #FFD700 is the marketing CTA pill fill — different surfaces,
//   different golds, keep the split.
import { CUSTOMER_SURFACE } from '../../theme-customer';
import { COLORS } from '../../theme-brand';

// The one price size for the decision number (React canonical — the SSR page
// must match this, not its old 62–84px). Full 40px from ~380px viewports up;
// shrinks only on the narrowest phones.
export const PRICE_FONT = 'clamp(24px, 10.5vw, 40px)';

export const W = {
  // Blues
  blue: COLORS.blueDark,          // #065A8C
  blueDark: COLORS.blueDark,      // alias (Report/App showcase naming)
  blueBright: COLORS.wavesBlue,   // #009CDE
  blueDeeper: COLORS.blueDeeper,  // #1B2C5B — headings on light bg
  blueLight: COLORS.blueLight,    // #E3F5FD — soft wash
  navyDeep: '#04395E',            // glass brand navy (site-wide, owner-locked)
  navy: COLORS.navy,              // #0F172A — slate-900 strongest text

  // Text
  textBody: '#3F4A65',            // estimate body (between slate-600/700 on purpose)
  textCaption: CUSTOMER_SURFACE.muted, // #475569 — the one blessed gray

  // Accents
  gold: '#F0A500',
  yellow: '#F0A500',              // alias (legacy key name)
  starGold: '#F0A500',            // alias (GoogleProfilesCard name)
  yellowHover: COLORS.yellowHover, // #FFF176
  green: '#15803D',               // the ONE estimate green (was also #1E8E5A)
  greenDark: '#15803D',           // alias
  greenLight: COLORS.greenLight,  // #DCFCE7 — success wash
  red: '#C8312F',                 // alert red (see header note)

  // Surfaces
  white: '#FFFFFF',
  offWhite: COLORS.offWhite,      // #F1F5F9
  borderLight: COLORS.offWhite,   // alias — hairline on white cards
  sand: '#FEF7E0',                // scarcity/notice wash
  warmBg: CUSTOMER_SURFACE.chrome, // #F7F5EE

  // Borders — three real values, three names (do not collapse):
  border: COLORS.grayLight,       // #CBD5E1 slate-300 — card/control borders
  borderCool: COLORS.slate200,    // #E2E8F0 slate-200 — slot grid hairlines
  warmBorder: CUSTOMER_SURFACE.border, // #E7E2D7 — warm-surface hairlines

  // Washes
  badgeWash: '#EEF2FF',           // WaveGuard tier chip bg
  noticeText: '#92400E',          // amber quote-required notes
  successWash: CUSTOMER_SURFACE.successBg, // #F0FDF4
};
