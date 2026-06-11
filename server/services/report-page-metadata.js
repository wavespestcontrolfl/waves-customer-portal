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

function applyHtmlMetadata(html, metadata = {}) {
  let output = String(html || '');
  const title = metadata.title || 'Waves Customer Portal';
  const description = metadata.description || DEFAULT_PORTAL_DESCRIPTION;
  const themeColor = metadata.themeColor || DEFAULT_THEME_COLOR;
  const appleTitle = metadata.appleTitle || 'Waves';
  const escapedTitle = escapeHtml(title);
  const escapedDescription = escapeHtml(description);

  output = replaceOrInsert(output, /<title>[^<]*<\/title>/i, `<title>${escapedTitle}</title>`);
  output = replaceOrInsert(output, /<meta name="description" content="[^"]*"\s*\/?>/i, `<meta name="description" content="${escapedDescription}" />`);
  output = replaceOrInsert(output, /<meta name="theme-color" content="[^"]*"\s*\/?>/i, `<meta name="theme-color" content="${escapeHtml(themeColor)}" />`);
  output = replaceOrInsert(output, /<meta name="apple-mobile-web-app-title" content="[^"]*"\s*\/?>/i, `<meta name="apple-mobile-web-app-title" content="${escapeHtml(appleTitle)}" />`);
  output = replaceOrInsert(output, /<meta property="og:title" content="[^"]*"\s*\/?>/i, `<meta property="og:title" content="${escapedTitle}" />`);
  output = replaceOrInsert(output, /<meta property="og:description" content="[^"]*"\s*\/?>/i, `<meta property="og:description" content="${escapedDescription}" />`);
  output = replaceOrInsert(output, /<meta name="twitter:title" content="[^"]*"\s*\/?>/i, `<meta name="twitter:title" content="${escapedTitle}" />`);
  output = replaceOrInsert(output, /<meta name="twitter:description" content="[^"]*"\s*\/?>/i, `<meta name="twitter:description" content="${escapedDescription}" />`);
  return output;
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
  return metadataForServiceReport(service);
}

module.exports = {
  DEFAULT_PORTAL_DESCRIPTION,
  DEFAULT_THEME_COLOR,
  applyHtmlMetadata,
  formatReportDate,
  loadServiceReportPageMetadata,
  metadataForServiceReport,
  redactReportPath,
  reportTokenFromPath,
};
