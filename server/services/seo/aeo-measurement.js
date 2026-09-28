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

// A "recommended" answer is the bar above a bare mention: Waves is named,
// portrayed positively, and ranks in the top 3 brands the answer surfaces
// (rank_position is 1-indexed order of first appearance among Waves +
// COMPETITORS in llm-mention-prober.js's parse()). Denominator: measured
// answers, less the mentioned ones whose sentiment is not known — neither
// recommended nor not, so counted as `unclassified` rather than read as
// misses (Codex r4 on #5123).
function isRecommendedAnswer(row) {
  return row.waves_mentioned === true
    && row.sentiment === 'positive'
    && Number.isInteger(row.rank_position) && row.rank_position >= 1 && row.rank_position <= 3;
}

// A mentioned answer's sentiment is known when its row says it was
// classified. Rows from before sentiment_status existed are trusted only for
// a positive/negative label: the old writer stored 'neutral' on any failure
// (no key, provider error, off-contract reply), so an old 'neutral' may be an
// outage rather than a verdict (Codex r5 on #5123).
function hasKnownSentiment(row) {
  if (row.sentiment_status != null) return row.sentiment_status === 'classified';
  return row.sentiment === 'positive' || row.sentiment === 'negative';
}

function summarizeObservations(rows) {
  const measured = rows.filter(isMeasuredAnswer);
  const cited = measured.filter(row => ownedCitations(row).length > 0).length;
  const mentioned = measured.filter(row => row.waves_mentioned === true).length;
  const recommended = measured.filter(isRecommendedAnswer).length;
  const unclassified = measured.filter(row => row.waves_mentioned === true && !hasKnownSentiment(row)).length;
  const recommendable = measured.length - unclassified;
  return {
    total: rows.length,
    measured: measured.length,
    mentioned,
    cited,
    recommended,
    unclassified,
    mentionRate: measured.length ? Math.round(100 * mentioned / measured.length) : null,
    citationRate: measured.length ? Math.round(100 * cited / measured.length) : null,
    recommendedRate: recommendable ? Math.round(100 * recommended / recommendable) : null,
    legacy: rows.filter(row => row.measurement_version !== MEASUREMENT_VERSION).length,
    noAnswer: rows.filter(row => row.measurement_version === MEASUREMENT_VERSION && row.answer_available === false).length,
    unresolved: rows.filter(row => row.measurement_version === MEASUREMENT_VERSION
      && row.answer_available === true && row.citations_complete !== true).length,
  };
}

module.exports = { MEASUREMENT_VERSION, observationDate, asJsonArray, cleanUrls, isOwnedUrl, isMeasuredAnswer, ownedCitations, citationMatchesPage, isRecommendedAnswer, summarizeObservations };
