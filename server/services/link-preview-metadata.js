/**
 * Per-link Open Graph preview metadata for the customer-portal token routes.
 *
 * Generalizes the report-page-metadata pattern (which stays as the single
 * source of truth for /report/:token — including its typedReportDelivery
 * suppression) to every other customer link route so a texted/emailed link
 * shows a branded card instead of the bare portal default.
 *
 * Every resolver below re-derives its own "is this token real and would the
 * actual page show it" verdict from the SAME table/column/gate the page's
 * own public route reads — never a second, drifting copy of that logic.
 * Anything ambiguous, expensive, or not cheaply/safely re-derivable (most
 * notably the estimate service-name blob) falls back to a GENERIC card for
 * that kind rather than guessing at DB-derived content (see resolveEstimate).
 *
 * NOTHING here ever puts a dollar amount, customer name, address, phone,
 * email, tech name, or finding/note text into a card or a meta tag.
 */

const db = require('../models/db');
const logger = require('./logger');
const { portalUrl } = require('../utils/portal-url');
const {
  formatReportDate,
  loadServiceReportCardContent,
  loadServiceReportPageMetadata,
} = require('./report-page-metadata');
const { arrivalWindowRange, formatSmsTimeRange } = require('../utils/sms-time-format');

const OG_IMAGE_WIDTH = 1200;
const OG_IMAGE_HEIGHT = 630;

// Token-shape gates bound query cost / weird input before it reaches knex;
// the DB lookup is the real gate.
const HEX64_RE = /^[a-f0-9]{64}$/i;
const HEX32_RE = /^[a-f0-9]{32}$/i;

// What the grey text under a texted link's preview reads (og:title), owner
// 2026-09-27: just the brand — the card image carries the rest.
const PREVIEW_TITLE = 'Waves';

function cleanText(value, max = 160) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

// scheduled_services.service_type / prep_template rows are usually already
// human-readable ("Pest Control"); a few legacy snake_case values
// ("pest_control") get title-cased. Never anything fancier — this must never
// become a second copy of the pricing engine's service-name logic.
function titleCaseServiceType(value) {
  const raw = cleanText(value, 80);
  if (!raw) return 'Waves service';
  if (!/^[a-z0-9]+(_[a-z0-9]+)+$/i.test(raw)) return raw;
  return raw.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

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

function matchLinkPreviewRoute(reqPath) {
  const p = String(reqPath || '');
  for (const { kind, re } of ROUTE_MATCHERS) {
    const m = re.exec(p);
    if (m) {
      let token = m[1];
      try { token = decodeURIComponent(token); } catch { /* keep raw */ }
      return { kind, token };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-kind card content resolvers. Each returns { eyebrow, headline, subline }
// or null (invalid / suppressed / gated off — caller falls back to the
// generic default card). Every DB read here is READ-ONLY — none of these
// may stamp a view, unlike the real page routes (a preview-card render, or
// the LRU cache refilling, must never count as a customer view).
// ---------------------------------------------------------------------------

async function resolveReportProject(token) {
  const { extractProjectReportTokenLookup } = require('./project-report-links');
  const lookup = extractProjectReportTokenLookup(token);
  if (!lookup) return null;
  let project = null;
  try {
    if (lookup.type === 'full') {
      project = await db('projects').where({ report_token: lookup.value })
        .first('project_type', 'project_date', 'created_at');
    } else {
      const rows = await db('projects').where('report_token', 'like', `${lookup.value}%`)
        .limit(2).select('project_type', 'project_date', 'created_at');
      project = rows.length === 1 ? rows[0] : null;
    }
  } catch (err) {
    logger.warn(`[link-preview] report-project lookup failed: ${err.message}`);
    return null;
  }
  if (!project) return null;
  let headline = project.project_type || 'Waves service';
  try {
    const { getProjectType } = require('./project-types');
    headline = getProjectType(project.project_type)?.label || headline;
  } catch { /* keep raw project_type */ }
  return {
    eyebrow: 'PROJECT REPORT',
    headline: cleanText(headline, 80),
    subline: formatReportDate(project.project_date || project.created_at) || null,
  };
}

async function resolveAppointment(token) {
  if (!process.env.GATE_APPOINTMENT_PAGE || process.env.GATE_APPOINTMENT_PAGE !== 'true') return null;
  if (!HEX64_RE.test(token)) return null;
  let svc;
  try {
    svc = await db('scheduled_services as s')
      .where('s.reschedule_token', token)
      .leftJoin('customers as c', 's.customer_id', 'c.id')
      .first(
        's.id', 's.status', 's.visit_id', 's.scheduled_date', 's.window_start', 's.service_type',
        'c.deleted_at as customer_deleted_at',
      );
  } catch (err) {
    logger.warn(`[link-preview] appointment lookup failed: ${err.message}`);
    return null;
  }
  if (!svc || svc.customer_deleted_at) return null;
  // The date/window only goes on the card when the page itself would render
  // this visit as upcoming — a cancelled, completed, past, or pending-rebook
  // row still carries its OLD slot, which must never preview as booked.
  let upcoming = false;
  try {
    const { pageStateForVisit } = require('../routes/appointment-public');
    upcoming = (await pageStateForVisit(svc)).state === 'upcoming';
  } catch (err) {
    logger.warn(`[link-preview] appointment state check failed: ${err.message}`);
  }
  const headline = titleCaseServiceType(svc.service_type);
  if (!upcoming) {
    return { eyebrow: 'APPOINTMENT', headline, subline: 'View your visit details' };
  }
  const date = formatReportDate(svc.scheduled_date);
  const range = arrivalWindowRange(svc.window_start);
  const window = range ? formatSmsTimeRange(range) : null;
  const subline = [date, window && window !== range ? window : null].filter(Boolean).join(' · ') || null;
  return { eyebrow: 'APPOINTMENT', headline, subline };
}

async function resolveReschedule(token) {
  if (!HEX64_RE.test(token)) return null;
  let svc;
  try {
    svc = await db('scheduled_services as s')
      .where('s.reschedule_token', token)
      .leftJoin('customers as c', 's.customer_id', 'c.id')
      .first('s.id', 's.service_type', 'c.deleted_at as customer_deleted_at');
  } catch (err) {
    logger.warn(`[link-preview] reschedule lookup failed: ${err.message}`);
    return null;
  }
  if (!svc || svc.customer_deleted_at) return null;
  return {
    eyebrow: 'RESCHEDULE',
    headline: titleCaseServiceType(svc.service_type),
    subline: 'Pick a time that works for you',
  };
}

// Read-only mirror of prep-public.js's resolvePrepSource — deliberately NOT
// the exported view-stamping path (that mutates prep_view_count /
// prep_first_viewed_at on every call, which an image LRU refill or a
// crawler retry must never do).
async function resolvePrep(token) {
  if (!HEX32_RE.test(token)) return null;
  const now = new Date();
  try {
    const project = await db('projects').where({ prep_token: token }).first('project_type', 'prep_expires_at');
    if (project) {
      if (project.prep_expires_at && new Date(project.prep_expires_at) < now) return null;
      let headline = project.project_type || 'Waves service';
      try {
        const { getProjectType } = require('./project-types');
        headline = getProjectType(project.project_type)?.label || headline;
      } catch { /* keep raw */ }
      return { eyebrow: 'PREP GUIDE', headline: cleanText(headline, 80), subline: 'How to get ready for your visit' };
    }
    const service = await db('scheduled_services').where({ prep_token: token })
      .whereNotNull('prep_template_key')
      .where((q) => q.whereNull('prep_expires_at').orWhere('prep_expires_at', '>=', now))
      .first('service_type');
    if (!service) return null;
    return {
      eyebrow: 'PREP GUIDE',
      headline: titleCaseServiceType(service.service_type),
      subline: 'How to get ready for your visit',
    };
  } catch (err) {
    logger.warn(`[link-preview] prep lookup failed: ${err.message}`);
    return null;
  }
}

// Cards whose words are the same for every customer. They read nothing from
// the database — so they can't leak whether a token is real — and their
// image URL carries no token (/og/<kind>.jpg). Estimates stay generic on
// purpose: no services or prices (prices-only-on-estimate-pages ruling).
const FIXED_CARDS = {
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

// Cards that show the link's own service and/or date — each re-checks that
// the page would actually show it before any of it reaches a card.
const RESOLVERS = {
  report: (token) => loadServiceReportCardContent(token),
  'report-project': resolveReportProject,
  appointment: resolveAppointment,
  reschedule: resolveReschedule,
  prep: resolvePrep,
};

// Resolves card CONTENT for a given (kind, token) — used both by the HTML
// metadata pass below and, independently, by the /og/:kind/:token.jpg image
// route (which re-resolves from the URL's own kind/token rather than ever
// trusting rendered card text passed as a query param).
async function resolveCardContent(kind, token) {
  if (FIXED_CARDS[kind]) return FIXED_CARDS[kind];
  const resolver = RESOLVERS[kind];
  if (!resolver || !token) return null;
  try {
    return await resolver(String(token));
  } catch (err) {
    logger.warn(`[link-preview] resolver for kind=${kind} failed: ${err.message}`);
    return null;
  }
}

function ogImageUrl(kind, token) {
  if (FIXED_CARDS[kind]) return portalUrl(`/og/${kind}.jpg`);
  return portalUrl(`/og/${encodeURIComponent(kind)}/${encodeURIComponent(token)}.jpg`);
}

function metadataFromCardContent(kind, token, content) {
  const headline = cleanText(content.headline, 140) || 'Waves Pest Control';
  const subline = cleanText(content.subline, 200);
  const eyebrow = cleanText(content.eyebrow, 60) || 'Waves Pest Control';
  return {
    title: `${headline} · Waves Pest Control`,
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

// Single entry point renderHTML calls per request. Tries the existing
// service-report loader first (unchanged behavior/suppression), then every
// other known kind; returns null when nothing matches (the caller's default
// og:image band, applied earlier, stands).
async function loadLinkPreviewMetadata(reqPath, knex = db) {
  try {
    const reportMetadata = await loadServiceReportPageMetadata(reqPath, knex);
    if (reportMetadata) return reportMetadata;
  } catch (err) {
    logger.warn(`[link-preview] report metadata failed for ${redactLinkPreviewPath(reqPath)}: ${err.message}`);
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
  matchLinkPreviewRoute,
  resolveCardContent,
  loadLinkPreviewMetadata,
  redactLinkPreviewPath,
  titleCaseServiceType,
};
