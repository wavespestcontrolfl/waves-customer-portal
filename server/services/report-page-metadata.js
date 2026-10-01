const db = require('../models/db');

const DEFAULT_PORTAL_DESCRIPTION = 'Your Waves service reports, billing, and account — view past visits, track action items, and schedule the next service.';
const DEFAULT_THEME_COLOR = '#111111';
const SERVICE_REPORT_TIME_ZONE = 'America/New_York';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function reportTokenFromPath(reqPath = '') {
  const match = String(reqPath).match(/^\/report\/([a-f0-9]{32})\/?$/i);
  return match ? match[1] : null;
}

function redactReportPath(reqPath = '') {
  const path = String(reqPath || '');
  const token = reportTokenFromPath(path);
  return token ? path.replace(token, '[redacted]') : path;
}

function serviceDateToNoonUtc(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 12));
  }
  const raw = String(value);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (dateOnly) {
    return new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12));
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatReportDate(value) {
  const date = serviceDateToNoonUtc(value);
  if (!date) return '';
  return date.toLocaleDateString('en-US', {
    timeZone: SERVICE_REPORT_TIME_ZONE,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function cleanServiceType(value) {
  const raw = String(value || '').trim();
  return raw || 'Waves service';
}

function metadataForServiceReport(service = {}) {
  const serviceType = cleanServiceType(service.service_type || service.serviceType);
  const serviceDate = formatReportDate(service.service_date || service.serviceDate);
  const titleParts = ['Service report', serviceDate, serviceType].filter(Boolean);
  const description = serviceDate
    ? `Waves service report for ${serviceDate}: ${serviceType}. View visit details, action items, and next service.`
    : `Waves service report: ${serviceType}. View visit details, action items, and next service.`;

  return {
    title: titleParts.join(' · '),
    description,
    themeColor: DEFAULT_THEME_COLOR,
    appleTitle: 'Waves',
  };
}

function replaceOrInsert(html, pattern, replacement) {
  if (pattern.test(html)) return html.replace(pattern, replacement);
  return html.replace('</head>', `    ${replacement}\n  </head>`);
}

// Inject a class onto the <html ...> tag (idempotent). Lets a section serve
// its scoping class (e.g. html.admin-app for /admin form/font rules) on
// first paint instead of waiting for a React effect — the class a Safari
// home-screen install captures. Appends to an existing class attribute
// without double-adding; adds one when absent.
function addHtmlClass(html, className) {
  return html.replace(/<html\b([^>]*)>/i, (tag, attrs) => {
    const existing = /\bclass="([^"]*)"/i.exec(attrs);
    if (!existing) return `<html${attrs} class="${escapeHtml(className)}">`;
    const classes = existing[1].split(/\s+/).filter(Boolean);
    if (classes.includes(className)) return tag;
    return `<html${attrs.replace(
      existing[0],
      `class="${existing[1]} ${escapeHtml(className)}"`,
    )}>`;
  });
}

function applyHtmlMetadata(html, metadata = {}) {
  let output = String(html || '');
  const title = metadata.title || 'Waves Customer Portal';
  const description = metadata.description || DEFAULT_PORTAL_DESCRIPTION;
  const themeColor = metadata.themeColor || DEFAULT_THEME_COLOR;
  const appleTitle = metadata.appleTitle || 'Waves';
  const escapedTitle = escapeHtml(title);
  // previewTitle overrides only the link-preview title (og:/twitter:), never
  // the page's own <title>.
  const escapedPreviewTitle = escapeHtml(metadata.previewTitle || title);
  const escapedDescription = escapeHtml(description);

  output = replaceOrInsert(output, /<title>[^<]*<\/title>/i, `<title>${escapedTitle}</title>`);
  output = replaceOrInsert(output, /<meta name="description" content="[^"]*"\s*\/?>/i, `<meta name="description" content="${escapedDescription}" />`);
  output = replaceOrInsert(output, /<meta name="theme-color" content="[^"]*"\s*\/?>/i, `<meta name="theme-color" content="${escapeHtml(themeColor)}" />`);
  output = replaceOrInsert(output, /<meta name="apple-mobile-web-app-title" content="[^"]*"\s*\/?>/i, `<meta name="apple-mobile-web-app-title" content="${escapeHtml(appleTitle)}" />`);
  output = replaceOrInsert(output, /<meta property="og:title" content="[^"]*"\s*\/?>/i, `<meta property="og:title" content="${escapedPreviewTitle}" />`);
  output = replaceOrInsert(output, /<meta property="og:description" content="[^"]*"\s*\/?>/i, `<meta property="og:description" content="${escapedDescription}" />`);
  output = replaceOrInsert(output, /<meta name="twitter:title" content="[^"]*"\s*\/?>/i, `<meta name="twitter:title" content="${escapedPreviewTitle}" />`);
  output = replaceOrInsert(output, /<meta name="twitter:description" content="[^"]*"\s*\/?>/i, `<meta name="twitter:description" content="${escapedDescription}" />`);
  if (metadata.htmlClass) output = addHtmlClass(output, metadata.htmlClass);
  // Per-link preview image (link-preview-cards): og:image + twitter:image,
  // and twitter:card upgrades to summary_large_image only when an image is
  // actually supplied — a caller that never passes `image` (most existing
  // metadata objects) leaves whatever card size the page already had.
  if (metadata.image && metadata.image.url) {
    const { url, width, height, alt } = metadata.image;
    const escapedUrl = escapeHtml(url);
    output = replaceOrInsert(output, /<meta property="og:image" content="[^"]*"\s*\/?>/i, `<meta property="og:image" content="${escapedUrl}" />`);
    if (width) {
      output = replaceOrInsert(output, /<meta property="og:image:width" content="[^"]*"\s*\/?>/i, `<meta property="og:image:width" content="${escapeHtml(String(width))}" />`);
    }
    if (height) {
      output = replaceOrInsert(output, /<meta property="og:image:height" content="[^"]*"\s*\/?>/i, `<meta property="og:image:height" content="${escapeHtml(String(height))}" />`);
    }
    if (alt) {
      output = replaceOrInsert(output, /<meta property="og:image:alt" content="[^"]*"\s*\/?>/i, `<meta property="og:image:alt" content="${escapeHtml(alt)}" />`);
    }
    output = replaceOrInsert(output, /<meta name="twitter:image" content="[^"]*"\s*\/?>/i, `<meta name="twitter:image" content="${escapedUrl}" />`);
    output = replaceOrInsert(output, /<meta name="twitter:card" content="[^"]*"\s*\/?>/i, '<meta name="twitter:card" content="summary_large_image" />');
  }
  return output;
}

// Absolute og:image for a service report — same suppression the metadata
// itself already went through (this is only ever attached to a metadata
// object loadServiceReportPageMetadata is about to return, i.e. AFTER the
// typedReportDelivery check below has cleared it).
function reportOgImage(token, service) {
  const { portalUrl } = require('../utils/portal-url');
  const serviceType = cleanServiceType(service?.service_type || service?.serviceType);
  return {
    url: portalUrl(`/og/report/${encodeURIComponent(token)}.jpg`),
    width: 1200,
    height: 630,
    alt: `Waves Pest Control service report — ${serviceType}`,
  };
}

async function loadServiceReportPageMetadata(reqPath, knex = db) {
  const token = reportTokenFromPath(reqPath);
  if (!token) return null;
  const service = await knex('service_records')
    .where({ report_view_token: token })
    .first('service_type', 'service_date', 'structured_notes');
  if (!service) return null;
  // Suppressed typed reports (internal_only shadow / disabled) must not
  // leak existence or service type/date through the unauthenticated SSR
  // HTML / link previews — mirror reports-public.js suppression and fall
  // back to the generic portal metadata.
  let notes = service.structured_notes;
  if (typeof notes === 'string') {
    try { notes = JSON.parse(notes); } catch { notes = null; }
  }
  const deliveryMode = notes && typeof notes === 'object' ? notes.typedReportDelivery : null;
  if (deliveryMode && deliveryMode !== 'auto_send') return null;
  const metadata = metadataForServiceReport(service);
  metadata.image = reportOgImage(token, service);
  metadata.previewTitle = 'Waves';
  return metadata;
}

// Same lookup + typedReportDelivery suppression as loadServiceReportPageMetadata,
// shaped for the /og/report/:token.jpg image renderer (eyebrow/headline/subline)
// instead of full HTML <head> metadata — used when the caller already has a
// bare token (the image route) rather than a request path to extract one from.
async function loadServiceReportCardContent(token, knex = db) {
  if (!token || !/^[a-f0-9]{32}$/i.test(String(token))) return null;
  const service = await knex('service_records')
    .where({ report_view_token: token })
    .first('service_type', 'service_date', 'structured_notes');
  if (!service) return null;
  let notes = service.structured_notes;
  if (typeof notes === 'string') {
    try { notes = JSON.parse(notes); } catch { notes = null; }
  }
  const deliveryMode = notes && typeof notes === 'object' ? notes.typedReportDelivery : null;
  if (deliveryMode && deliveryMode !== 'auto_send') return null;
  return {
    eyebrow: 'SERVICE REPORT',
    headline: cleanServiceType(service.service_type || service.serviceType),
    subline: formatReportDate(service.service_date || service.serviceDate) || null,
  };
}

module.exports = {
  DEFAULT_PORTAL_DESCRIPTION,
  DEFAULT_THEME_COLOR,
  applyHtmlMetadata,
  formatReportDate,
  loadServiceReportCardContent,
  loadServiceReportPageMetadata,
  metadataForServiceReport,
  redactReportPath,
  reportOgImage,
  reportTokenFromPath,
};
