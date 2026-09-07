const twilioNumbers = require('../../config/twilio-numbers');

// V1 mixed search results, prose URLs and citations. It cannot be backfilled
// into a citation benchmark because provider attribution was not retained.
const MEASUREMENT_VERSION = 2;
const OWNED_DOMAINS = new Set([
  'wavespestcontrol.com',
  ...(twilioNumbers.domainTracking || []).map(d => d.domain),
  ...(twilioNumbers.lawnDomainTracking || []).map(d => d.domain),
].filter(Boolean).map(d => d.toLowerCase().replace(/^www\./, '')));

// Postgres DATE may be returned as a date-only string or a driver Date object.
function observationDate(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function asJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function cleanUrls(value) {
  const urls = new Set();
  for (const input of asJsonArray(value)) {
    if (typeof input !== 'string') continue;
    try {
      const url = new URL(input);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
      urls.add(url.href);
    } catch { /* malformed provider source */ }
  }
  return [...urls];
}

function isOwnedUrl(value) {
  const [safe] = cleanUrls([value]);
  if (!safe) return false;
  const host = new URL(safe).hostname.toLowerCase().replace(/^www\./, '');
  return [...OWNED_DOMAINS].some(domain => host === domain || host.endsWith(`.${domain}`));
}

function isMeasuredAnswer(row) {
  return row.measurement_version === MEASUREMENT_VERSION
    && row.answer_available === true && row.citations_complete === true;
}

function ownedCitations(row) {
  return isMeasuredAnswer(row) ? cleanUrls(row.waves_cited_urls).filter(isOwnedUrl) : [];
}

function citationMatchesPage(citation, page) {
  if (!page || !isOwnedUrl(citation)) return false;
  try {
    const cited = new URL(citation);
    const target = new URL(page, 'https://www.wavespestcontrol.com');
    return cited.hostname.replace(/^www\./, '') === target.hostname.replace(/^www\./, '')
      && cited.pathname.replace(/\/$/, '') === target.pathname.replace(/\/$/, '');
  } catch { return false; }
}

function summarizeObservations(rows) {
  const measured = rows.filter(isMeasuredAnswer);
  const cited = measured.filter(row => ownedCitations(row).length > 0).length;
  const mentioned = measured.filter(row => row.waves_mentioned === true).length;
  return {
    total: rows.length,
    measured: measured.length,
    mentioned,
    cited,
    mentionRate: measured.length ? Math.round(100 * mentioned / measured.length) : null,
    citationRate: measured.length ? Math.round(100 * cited / measured.length) : null,
    legacy: rows.filter(row => row.measurement_version !== MEASUREMENT_VERSION).length,
    noAnswer: rows.filter(row => row.measurement_version === MEASUREMENT_VERSION && row.answer_available === false).length,
    unresolved: rows.filter(row => row.measurement_version === MEASUREMENT_VERSION
      && row.answer_available === true && row.citations_complete !== true).length,
  };
}

module.exports = { MEASUREMENT_VERSION, observationDate, asJsonArray, cleanUrls, isOwnedUrl, isMeasuredAnswer, ownedCitations, citationMatchesPage, summarizeObservations };
