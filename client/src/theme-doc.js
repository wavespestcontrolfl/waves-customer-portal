// theme-doc.js — the customer DOCUMENT-page design system.
//
// Single source of truth for the tokened document surfaces:
// /estimate/:token, /report/*, /prep, /receipt, /pay, /pay/statement,
// /contract, /service-outlines, /lawn-care.
//
// This module does NOT introduce a new palette — it composes the already
// blessed sources into one import for doc pages:
//   - glass runtime vars (brand-tokens.css :root, remapped by glass-theme.css
//     to the canonical glass navy #04395E while a scene is mounted). Color
//     roles here are CSS-var references ON PURPOSE: the same authored style
//     renders warm-brand in print/PDF mode (no glass) and glass-navy live.
//   - theme-brand.js FONTS/COLORS (the one Inter body stack; glassNavy for
//     chrome that must NOT shift under glass, e.g. DocumentActionBar fills).
//   - theme-customer.js CUSTOMER_SURFACE (warm literals for surfaces that
//     glass deliberately leaves alone).
//
// The estimate surface keeps its own components/estimate/tokens.js palette
// forks (gold #F0A500 / alert red #C8312F — documented intentional); it
// consumes only the SCALE tokens (type/space/radius/transition) from here.
//
// Server twin: server/services/pdf/pdf-tokens.js mirrors the literal values
// for PDFKit documents (CommonJS, can't import this ES module). Change
// values in BOTH places or the print documents drift.

import { COLORS as B, FONTS } from './theme-brand';
import { CUSTOMER_SURFACE } from './theme-customer';

// ---------- typography ----------

// The one customer body stack. Under a mounted glass scene, glass-theme.css
// forces the SF-clean family site-wide with !important; this is the
// matching authored value so print/PDF/non-glass renders stay coherent.
export const DOC_FONT = FONTS.body; // "'Inter', system-ui, sans-serif"
export const DOC_FONT_SERIF = FONTS.serif;

// Fixed type scale. 13px is banned on customer surfaces (glass ruling);
// 11 exists only for uppercase micro-labels/eyebrows.
export const FS = {
  micro: 11, // uppercase eyebrows, footnote labels ONLY
  caption: 12, // captions, legal, meta rows
  body: 14, // default body / buttons / table cells
  bodyLg: 15, // primary prose paragraphs
  lead: 16, // lead-ins, input text (16 = no iOS zoom)
  sub: 18, // sub-headings, intro lines
  h4: 16,
  h3: 20,
  h2: 24,
  h1: 34,
};

// Standard weights. Variable-font one-offs (650/750/850) snap to these.
export const FW = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  heavy: 800, // display/eyebrow emphasis only
};

export const LH = {
  solid: 1, // buttons, badges, single-line figures
  display: 1.1, // hero/h1 (mirrors glass h1 1.04–1.1)
  heading: 1.2, // h2–h4
  snug: 1.35, // dense meta rows, card labels
  body: 1.5, // all running prose
};

// Heading style factory for non-CSS-block pages. Values mirror what the
// glass theme forces at runtime so a page reads the same with and without
// a mounted scene (mode=pdf, print, ?glass=0 escapes).
export function docHeading(level) {
  const base = { margin: 0, fontFamily: DOC_FONT, color: DOC.ink };
  switch (level) {
    case 1:
      return { ...base, fontSize: FS.h1, fontWeight: FW.bold, lineHeight: LH.display, letterSpacing: '-0.035em' };
    case 2:
      return { ...base, fontSize: FS.h2, fontWeight: FW.semibold, lineHeight: LH.heading, letterSpacing: '-0.03em' };
    case 3:
      return { ...base, fontSize: FS.h3, fontWeight: FW.semibold, lineHeight: LH.heading, letterSpacing: '-0.02em' };
    default:
      return { ...base, fontSize: FS.h4, fontWeight: FW.semibold, lineHeight: LH.heading, letterSpacing: '-0.02em' };
  }
}

// Uppercase section eyebrow — the single spec, mirroring what the glass
// [data-gt="eyebrow"] rule forces at runtime (12px/700/0.11em/1.2). Author
// eyebrows as <div data-gt="eyebrow" style={DOC_EYEBROW}> so glass and
// non-glass renders agree. (ReportViewPage previously carried two
// conflicting .section-eyebrow rules; this replaces both.)
export const DOC_EYEBROW = {
  fontFamily: DOC_FONT,
  fontSize: FS.caption,
  fontWeight: FW.bold,
  lineHeight: LH.heading,
  letterSpacing: '0.11em',
  textTransform: 'uppercase',
  color: 'var(--text-muted, #3F4A65)',
  marginBottom: 8,
};

// ---------- spacing ----------

// 4px grid. ALL margins/paddings/gaps on doc pages come from this set.
export const SP = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  gap: 48, // page-level vertical rhythm
  giant: 64, // bottom-of-page breathing room
};

// ---------- layout ----------

// The 760px document column (owner ruling, PR #2527: "pay's cap is the
// standard"). Prefer className="waves-receipt-page" (index.css) which also
// carries the standard vertical margins; use these values when a page
// needs the width inline.
export const DOC_COLUMN = 'min(100% - 32px, 760px)';
export const DOC_COLUMN_MAX = 760;
export const DOC_PAGE_MARGIN = '28px auto 56px';

// ---------- color roles ----------

// Roles resolve through the glass var layer. Since the 2026-07-12 owner
// ruling both layers agree: brand-tokens.css :root and the mounted glass
// scene resolve to the canonical glass navy #04395E. Literal escape
// hatches are named *Literal.
export const DOC = {
  ink: 'var(--text, #04395E)',
  muted: 'var(--text-muted, #3F4A65)',
  supporting: CUSTOMER_SURFACE.muted, // #475569 — the one blessed gray
  brand: 'var(--brand, #04395E)',
  border: 'var(--border, #E7E2D7)',
  borderStrong: 'var(--border-strong, #D8D0C0)',
  surface: '#FFFFFF',
  page: CUSTOMER_SURFACE.page, // #FAF8F3 warm page (non-glass)
  soft: CUSTOMER_SURFACE.soft, // #F8FCFE input/selected wash
  softBorder: CUSTOMER_SURFACE.softBorder, // #CFE7F5
  danger: 'var(--danger, #C8102E)',
  success: 'var(--success, #047857)',
  successBg: CUSTOMER_SURFACE.successBg,
  successBorder: CUSTOMER_SURFACE.successBorder,
  navyLiteral: B.glassNavy, // #04395E — chrome pinned across themes (glass navy, owner 2026-07-12)
};

// ---------- radii / elevation / motion ----------

export const RADIUS = {
  tag: 6, // small badges/chips
  input: 8,
  button: 10,
  card: 12,
  modal: 16,
  pill: 999,
};

export const SHADOW = {
  card: '0 1px 3px rgba(0,0,0,0.04)',
  modal: '0 18px 50px rgba(0,0,0,0.25)',
  focusRing: '0 0 0 3px rgba(4,57,94,0.18)',
};

// One timing everywhere (150ms/160ms variants existed; 160 is dominant).
export const DOC_EASE = '160ms ease';
export function docTransition(...props) {
  return props.map((p) => `${p} ${DOC_EASE}`).join(', ');
}

// ---------- shared primitives ----------

// THE document button (canonical values shipped in DocumentActionBar,
// border-box fix PR #2532 — DocumentActionBar consumes this factory).
// kind: 'primary' (navy fill) | 'chip' (quiet outline).
export function docButton(kind = 'primary') {
  const base = {
    boxSizing: 'border-box',
    minHeight: 48,
    padding: '0 18px',
    borderRadius: RADIUS.button,
    fontFamily: DOC_FONT,
    fontWeight: FW.bold,
    fontSize: FS.body,
    lineHeight: LH.solid,
    cursor: 'pointer',
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SP.xs,
    boxShadow: 'none',
    textTransform: 'none',
    whiteSpace: 'nowrap',
  };
  if (kind === 'chip') {
    return {
      ...base,
      border: `1px solid ${DOC.border}`,
      background: DOC.surface,
      color: DOC.ink,
    };
  }
  return {
    ...base,
    border: `1px solid ${B.glassNavy}`,
    background: B.glassNavy,
    color: '#FFFFFF',
  };
}

// THE document text input (contract signing fields are the reference).
export function docInput() {
  return {
    boxSizing: 'border-box',
    width: '100%',
    minHeight: 48,
    padding: '0 12px',
    borderRadius: RADIUS.input,
    border: `1px solid ${DOC.borderStrong}`,
    background: DOC.surface,
    fontFamily: DOC_FONT,
    fontSize: FS.lead, // 16 — prevents iOS focus zoom
    color: DOC.ink,
    outline: 'none',
  };
}

// THE document card.
export function docCard() {
  return {
    background: DOC.surface,
    border: `1px solid ${DOC.border}`,
    borderRadius: RADIUS.card,
    padding: SP.xl,
    boxShadow: SHADOW.card,
  };
}
