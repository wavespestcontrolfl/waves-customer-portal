// pdf-tokens.js — print-document twin of client/src/theme-doc.js.
//
// PDFKit renders CommonJS-side and can't import the client ES module, so
// the literal values are mirrored here. Change values in BOTH files or the
// print documents drift from the web documents (this exact drift happened
// before: invoice-pdf's muted gray sat at #6B7280 while the portal used
// #475569).
//
// Navy: #04395E is the canonical customer ink (owner ruling 2026-07-05,
// glass rollout). Print documents carry the same ink so a downloaded
// invoice matches the page it came from.

const PDF_COLORS = {
  navy: '#04395E', // headings, header bar (canonical customer ink)
  ink: '#04395E', // strong text
  body: '#3F4A65', // running copy
  muted: '#475569', // supporting text (slate-600; the one blessed gray)
  blue: '#009CDE', // brand accent
  red: '#C8102E', // overdue / alert (PMS 186 — print/brand red)
  green: '#047857', // paid badge / success
  rule: '#E7E2D7', // hairlines
  soft: '#FAF8F3', // warm wash panels
  headerSub: '#B8D4EA', // reversed-out subtitle text on the navy bar
  white: '#FFFFFF',
};

// 4px-grid spacing for blocks/tables (points ≈ px at PDF 72dpi scale used
// in these templates).
const PDF_SPACE = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
};

// Fixed type scale (Helvetica built-ins; no embedded fonts).
const PDF_TYPE = {
  micro: 8,
  caption: 9,
  body: 10,
  lead: 11,
  h2: 14,
  h1: 20,
  display: 26,
};

module.exports = { PDF_COLORS, PDF_SPACE, PDF_TYPE };
