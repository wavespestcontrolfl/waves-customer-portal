/**
 * Per-link Open Graph preview metadata for the customer-portal token routes,
 * so a texted/emailed link shows a branded card instead of the bare portal
 * default.
 *
 * Owner 2026-09-28: only the service report card shows link-specific detail
 * (its service and date, through report-page-metadata's own lookup and
 * typedReportDelivery suppression). Every other link gets a fixed card for
 * its kind: re-deriving each page's own eligibility rules (payment holds,
 * prep template versions, reschedule eligibility, grouped labels, archived
 * WDO dates) in a second place kept drifting from the page.
 *
 * NOTHING here ever puts a dollar amount, customer name, address, phone,
 * email, tech name, or finding/note text into a card or a meta tag.
 */

const db = require('../models/db');
const logger = require('./logger');
const { portalUrl } = require('../utils/portal-url');
const { isEnabled, leadInspectionLinkLive } = require('../config/feature-gates');
const {
  loadServiceReportCardContent,
  loadServiceReportPageMetadata,
} = require('./report-page-metadata');
const { isServiceReportPath } = require('../utils/sensitive-spa-headers');

const OG_IMAGE_WIDTH = 1200;
const OG_IMAGE_HEIGHT = 630;

// What the grey text under a texted link's preview reads (og:title), owner
// 2026-09-27: just the brand — the card image carries the rest.
const PREVIEW_TITLE = 'Waves';

function cleanText(value, max = 160) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

// Knex error messages embed the SQL with its bound values — the token — so
// failures here log only the error code, never err.message.

// Redacts a long token-shaped path segment before it reaches a log line —
// same intent as report-page-metadata's redactReportPath, generalized to
// every kind here (tokens are bearer secrets).
function redactLinkPreviewPath(reqPath = '') {
  return String(reqPath || '').replace(/[A-Za-z0-9_-]{16,}/g, '[redacted]');
}

// ---------------------------------------------------------------------------
// Route matching — mirrors client/src/App.jsx's customer routes. Order
// matters only where one path is a strict prefix of another
// (/pay/statement/:token vs /pay/:token); every pattern requires the token
// to be the FINAL path segment so that ordering is actually unambiguous.
// ---------------------------------------------------------------------------
// /recap/, /review/ and /book/ are the client's own redirects to /report/,
// /rate/ and /estimate/ — a crawler never runs them, so they map here.
const ROUTE_MATCHERS = [
  { kind: 'report-project', re: /^\/report\/project\/([^/]+)\/?$/i },
  { kind: 'report', re: /^\/recap\/([^/]+)\/?$/i },
  { kind: 'pay-statement', re: /^\/pay\/statement\/([^/]+)\/?$/i },
  { kind: 'estimate', re: /^\/(?:estimate|book)\/([^/]+)\/?$/i },
  { kind: 'appointment', re: /^\/appointment\/([^/]+)\/?$/i },
  { kind: 'reschedule', re: /^\/reschedule\/([^/]+)\/?$/i },
  { kind: 'reservice', re: /^\/reservice\/([^/]+)\/?$/i },
  { kind: 'inspection', re: /^\/inspection\/([^/]+)\/?$/i },
  { kind: 'secure', re: /^\/secure\/([^/]+)\/?$/i },
  { kind: 'track', re: /^\/track\/([^/]+)\/?$/i },
  { kind: 'visit', re: /^\/visit\/([^/]+)\/?$/i },
  { kind: 'lawn-report', re: /^\/lawn-report\/([^/]+)\/?$/i },
  { kind: 'pest-report', re: /^\/pest-report\/([^/]+)\/?$/i },
  { kind: 'service-outline', re: /^\/service-outlines\/([^/]+)\/?$/i },
  { kind: 'contract', re: /^\/contract\/([^/]+)\/?$/i },
  { kind: 'price-change', re: /^\/price-change\/([^/]+)\/?$/i },
  { kind: 'prep', re: /^\/prep\/([^/]+)\/?$/i },
  { kind: 'pay', re: /^\/pay\/([^/]+)\/?$/i },
  { kind: 'receipt', re: /^\/receipt\/([^/]+)\/?$/i },
  { kind: 'rate', re: /^\/(?:rate|review)\/([^/]+)\/?$/i },
  { kind: 'card', re: /^\/card\/([^/]+)\/?$/i },
  { kind: 'interview', re: /^\/careers\/interview\/([^/]+)\/?$/i },
];

// The report card looks its token up, so it only matches a path the
// privacy-header set (sensitive-spa-headers.js) also covers. Tokens are never
// URL-decoded: an encoded form (/recap/%61…) fails the gate instead of
// slipping past the raw-path limiter and header checks.
function matchLinkPreviewRoute(reqPath) {
  const p = String(reqPath || '');
  for (const { kind, re } of ROUTE_MATCHERS) {
    const m = re.exec(p);
    if (m) {
      if (kind === 'report' && !isServiceReportPath(p)) return null;
      return { kind, token: m[1] };
    }
  }
  return null;
}

// Cards whose words are the same for every customer. They read nothing from
// the database — so they can't leak whether a token is real — and their
// image URL carries no token (/og/<kind>.jpg). Estimates stay generic on
// purpose: no services or prices (prices-only-on-estimate-pages ruling).
const FIXED_CARDS = {
  'report-project': { eyebrow: 'PROJECT REPORT', headline: 'Your project report', subline: 'See your report online' },
  appointment: { eyebrow: 'APPOINTMENT', headline: 'Your appointment', subline: 'See your visit details' },
  reschedule: { eyebrow: 'RESCHEDULE', headline: 'Change your visit', subline: 'See your options online' },
  prep: { eyebrow: 'PREP GUIDE', headline: 'Get ready for your visit', subline: 'What to do before we arrive' },
  estimate: { eyebrow: 'ESTIMATE', headline: 'Your estimate', subline: 'See your options and book online' },
  reservice: { eyebrow: 'RE-SERVICE', headline: 'Book your re-service', subline: 'Pick a time that works for you' },
  inspection: { eyebrow: 'FREE ASSESSMENT', headline: 'Pick a time', subline: 'Book a free Waves assessment' },
  secure: { eyebrow: 'APPOINTMENT', headline: 'Secure your visit', subline: 'Save a card for your appointment' },
  track: { eyebrow: 'LIVE TRACKING', headline: 'Track your visit', subline: 'See when we will arrive' },
  visit: { eyebrow: 'VISIT SUMMARY', headline: 'Your visit summary', subline: 'See what we did today' },
  'lawn-report': { eyebrow: 'LAWN REPORT', headline: 'Your lawn report', subline: 'See how your lawn is doing' },
  'pest-report': { eyebrow: 'PEST REPORT', headline: 'Your pest report', subline: 'See what we found' },
  'service-outline': { eyebrow: 'SERVICE OUTLINE', headline: 'Your service outline', subline: 'What your service includes' },
  contract: { eyebrow: 'AGREEMENT', headline: 'Review and sign', subline: 'Your service agreement' },
  'price-change': { eyebrow: 'PRICE NOTICE', headline: 'Price update', subline: 'Details about your service price' },
  pay: { eyebrow: 'INVOICE', headline: 'Your invoice', subline: 'View and pay securely online' },
  'pay-statement': { eyebrow: 'STATEMENT', headline: 'Your statement', subline: 'View and pay securely online' },
  receipt: { eyebrow: 'RECEIPT', headline: 'Payment received', subline: 'Thank you for your payment' },
  rate: { eyebrow: 'HOW DID WE DO?', headline: 'Rate your visit', subline: 'Tell us how your visit went' },
  card: { eyebrow: 'WAVES CARD', headline: 'Waves Pest Control', subline: 'Text or call your Waves team' },
  interview: { eyebrow: 'CAREERS', headline: 'Schedule your interview', subline: 'Pick a time that works for you' },
};

// A surface that is dark serves a uniform 404, so its card must not exist
// either: while its gate is off the link gets the default card. Each entry
// reads the same gate the surface's own public route reads.
const CARD_GATES = {
  appointment: () => process.env.GATE_APPOINTMENT_PAGE === 'true',
  'pay-statement': () => isEnabled('payerStatements'),
  reservice: () => require('./reservice-scheduler').reserviceSelfServeEnabled(),
  inspection: () => leadInspectionLinkLive(),
  interview: () => isEnabled('recruitingComms'),
};

function fixedCard(kind) {
  if (!Object.prototype.hasOwnProperty.call(FIXED_CARDS, kind)) return null;
  const gate = CARD_GATES[kind];
  try {
    if (gate && !gate()) return null;
  } catch (err) {
    logger.warn(`[link-preview] gate check failed for kind=${kind}: ${err.code || err.name}`);
    return null;
  }
  return FIXED_CARDS[kind];
}

// Resolves card CONTENT for (kind, token) — used by the HTML metadata pass
// below and, independently, by the /og image route (which re-resolves from
// its own URL rather than trusting any rendered text).
async function resolveCardContent(kind, token) {
  if (kind === 'report') {
    if (!token) return null;
    try {
      return await loadServiceReportCardContent(String(token));
    } catch (err) {
      logger.warn(`[link-preview] report lookup failed: ${err.code || err.name}`);
      return null;
    }
  }
  return fixedCard(kind);
}

function ogImageUrl(kind, token) {
  if (Object.prototype.hasOwnProperty.call(FIXED_CARDS, kind)) return portalUrl(`/og/${kind}.jpg`);
  return portalUrl(`/og/${encodeURIComponent(kind)}/${encodeURIComponent(token)}.jpg`);
}

function metadataFromCardContent(kind, token, content) {
  const subline = cleanText(content.subline, 200);
  const eyebrow = cleanText(content.eyebrow, 60) || 'Waves Pest Control';
  // No `title`: applyHtmlMetadata would write it into the page's own
  // <title>, and only the link-preview title changes (the browser tab keeps
  // the page's existing title). The headline lives in the card image.
  return {
    previewTitle: PREVIEW_TITLE,
    description: subline || 'View your Waves service details online.',
    image: {
      url: ogImageUrl(kind, token),
      width: OG_IMAGE_WIDTH,
      height: OG_IMAGE_HEIGHT,
      alt: `${eyebrow} — Waves Pest Control`,
    },
  };
}

// Preview tags for a server-rendered page that doesn't go through the SPA's
// renderHTML (the legacy /estimate/:token view): only og:/twitter: tags for
// a fixed card, leaving the page's own <title> and other head tags alone.
function fixedCardHeadTags(kind) {
  const content = fixedCard(kind);
  if (!content) return '';
  const { image, previewTitle } = metadataFromCardContent(kind, null, content);
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    `<meta property="og:title" content="${esc(previewTitle)}">`,
    `<meta property="og:image" content="${esc(image.url)}">`,
    `<meta property="og:image:width" content="${image.width}">`,
    `<meta property="og:image:height" content="${image.height}">`,
    `<meta property="og:image:alt" content="${esc(image.alt)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(previewTitle)}">`,
    `<meta name="twitter:image" content="${esc(image.url)}">`,
  ].join('\n');
}

// Single entry point renderHTML calls per request. Tries the existing
// service-report loader first (unchanged behavior/suppression), then every
// other known kind; returns null when nothing matches (the caller's default
// og:image band, applied earlier, stands).
async function loadLinkPreviewMetadata(reqPath, knex = db) {
  try {
    const reportMetadata = await loadServiceReportPageMetadata(reqPath, knex);
    if (reportMetadata) return reportMetadata;
  } catch (err) {
    logger.warn(`[link-preview] report metadata failed for ${redactLinkPreviewPath(reqPath)}: ${err.code || err.name}`);
  }

  const match = matchLinkPreviewRoute(reqPath);
  if (!match) return null;
  const content = await resolveCardContent(match.kind, match.token);
  if (!content) return null;
  return metadataFromCardContent(match.kind, match.token, content);
}

module.exports = {
  OG_IMAGE_WIDTH,
  OG_IMAGE_HEIGHT,
  FIXED_CARDS,
  PREVIEW_TITLE,
  fixedCard,
  fixedCardHeadTags,
  matchLinkPreviewRoute,
  resolveCardContent,
  loadLinkPreviewMetadata,
  redactLinkPreviewPath,
};
