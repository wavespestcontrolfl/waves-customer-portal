const db = require('../models/db');
const { publicPortalUrl } = require('../utils/portal-url');
const { ASK_TOUCH_SQL } = require('./review-outreach-templates');

const ASK_SPACING_MS = 72 * 3600000;
const REVIEW_LINK_RE = /g\.page\/(?:r\/)?[^\s/]+\/review\b|writereview|writeareview|facebook\.com\/[^\s/]+\/reviews\b/i;
const REVIEW_INTENT_RE = /\b(?:leave|write|post|submit|share|give|add|update|edit|(?:mind|consider|how\s+about)\s+(?:leaving|writing|posting|submitting|sharing|giving|adding|updating|editing))\s+(?:(?:us|me)\s+)?(?:(?:a|an|your|the)\s+)?(?:(?:quick|short|honest|online|public|five[- ]star|5[- ]star|google|yelp|facebook)\s+)*review\b|\breview\s+us\b|\bshare\s+your\s+experience\s+in\s+a\s+review\b/i;

const REVIEW_INVITATION_RE = /\b(?:we|i)(?:['’]d|\s+would)\s+(?:(?:really|greatly)\s+)?(?:appreciate|love)\s+(?:(?:a|an|your)\s+)?(?:(?:quick|short|honest|online|public|google|yelp|facebook)\s+)*review\b|\b(?:a|your)\s+(?:(?:quick|short|honest|online|public|google|yelp|facebook)\s+)*review\s+(?:would|could)\s+(?:really\s+)?(?:mean|help|support|be\s+(?:(?:greatly|really|much)\s+)?appreciated)\b/i;

// Link-library destinations and explicit requests count. Acknowledgments
// ("Thanks for your Google review") without a link/request do not.
function looksLikeReviewAsk(body) {
  const text = String(body || '');
  // A vendor's /rate/ page is not one of our review links. SMS URLs may
  // have their scheme stripped by the provider normalizer.
  const portalHosts = new Set(['portal.wavespestcontrol.com']);
  try { portalHosts.add(new URL(publicPortalUrl()).hostname.toLowerCase()); } catch { /* invalid configuration */ }
  const portalRate = (text.match(/(?:https?:\/\/)?[a-z0-9.-]+(?::\d+)?\/(?:api\/)?rate\/[A-Za-z0-9][^\s]*/gi) || [])
    .some(link => {
      try { return portalHosts.has(new URL(/^https?:/i.test(link) ? link : `https://${link}`).hostname.toLowerCase()); }
      catch { return false; }
    });
  // Reviewing a document is different from reviewing the business.
  const intentText = text.replace(/\breview\s+(?:of|on|for)\s+(?:(?:the|your|our|my|attached|updated)\s+)*(?:estimate|invoice|agreement|contract|report|document|proposal)\b/gi, 'document assessment');
  return portalRate || REVIEW_LINK_RE.test(text) || REVIEW_INTENT_RE.test(intentText) || REVIEW_INVITATION_RE.test(intentText)
    || /\b(?:could|can|may)\s+(?:i|we)\s+ask\s+(?:you\s+)?for\s+(?:(?:a|an|your)\s+)?(?:(?:quick|short|honest|online|public|google|yelp|facebook)\s+)*review\b/i.test(intentText)
    || (/maps\.app\.goo\.gl\/|goo\.gl\/maps|maps\.google\.[a-z.]+\//i.test(text)
      && /\b(?:share|leave|give)\s+(?:(?:us|me)\s+)?(?:(?:your|some)\s+)?feedback\b/i.test(text))
    || (/\/l\/[A-Za-z0-9]{3,}\b/.test(text) && /\b(?:a|your|google|yelp|facebook)\s+(?:(?:quick|short|honest|online|public|five[- ]star|5[- ]star|google|yelp|facebook)\s+)*review\b|\breview\s+link\b/i.test(text));
}

function deliveredAskRows(customerId, { since = null, excludeRequestId = null } = {}) {
  const q = db('review_requests')
    .where({ customer_id: customerId })
    .whereRaw('(sms_sent_at IS NOT NULL OR sent_at IS NOT NULL OR followup_delivered_at IS NOT NULL OR followup_reserved_at IS NOT NULL)')
    .whereRaw(ASK_TOUCH_SQL)
    .select('id', 'sequence_id', 'template_key', 'sms_sent_at', 'sent_at', 'followup_delivered_at', 'followup_reserved_at');
  if (since) q.whereRaw('GREATEST(sms_sent_at, sent_at, followup_delivered_at, followup_reserved_at) > ?', [since]);
  if (excludeRequestId) q.where('id', '!=', excludeRequestId);
  return q;
}

// An unresolved follow-up reservation conservatively holds spacing until its
// real outcome is recorded; it does not populate the delivery timestamp.
// A retried email leg can be later than the SMS of the same request.
function latestDeliveredAt(rows) {
  return rows.reduce((latest, row) => {
    const at = Math.max(...[row.sms_sent_at, row.sent_at, row.followup_delivered_at, row.followup_reserved_at].map(value => value ? new Date(value).getTime() : 0));
    return Number.isFinite(at) && at > (latest?.getTime() || 0) ? new Date(at) : latest;
  }, null);
}

async function lastDeliveredAskAt(customerId, options) {
  return latestDeliveredAt(await deliveredAskRows(customerId, options));
}

// Lookups throw: dispatch callers must hold when evidence is unavailable.
// The enrollment standdown retains its explicit fail-open wrapper.
async function lastManualAskAt(customerId, { since } = {}) {
  const sinceAt = since ? new Date(since) : new Date(Date.now() - 30 * 86400000);
  const outbound = await db('sms_log')
    .where({ customer_id: customerId, direction: 'outbound' })
    // Include correspondence just before the boundary so its timestamp
    // cannot instead be assigned to a manual ask just after the boundary.
    .where('created_at', '>=', new Date(sinceAt.getTime() - 90000))
    .where(q => q.whereNotIn('status', ['scheduled', 'canceled', 'cancelled', 'failed', 'undelivered', 'blocked'])
      // Finalize-only replay already delivered, even while bookkeeping retries.
      .orWhereRaw("metadata->>'finalize_only' = 'true'"))
    .orderBy('created_at', 'desc')
    .select('message_body', 'created_at', 'status', 'metadata');
  const metadata = row => {
    try { return typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {}; }
    catch { return {}; }
  };
  // Pre-send evidence survives provider-log and settlement failures.
  const reservations = outbound.filter(row => metadata(row).review_ask_reservation === true);
  const reservedAt = reservations.reduce((latest, row) => {
    const at = new Date(row.created_at);
    return at >= sinceAt && (!latest || at > latest) ? at : latest;
  }, null);
  const candidates = outbound.filter(row => {
    const meta = metadata(row);
    if (meta.review_ask_reservation === true || (row.status === 'sending' && !meta.finalize_only)) return false;
    return looksLikeReviewAsk(row.message_body) || !!(meta.bundled_review_request_id || meta.review_ask_delivered_at);
  });
  if (!candidates.length) return reservedAt;
  const sends = await db('review_requests')
    .where({ customer_id: customerId })
    .whereNotNull('sms_sent_at')
    .select('sms_sent_at');
  // Match the closest corresponding pipeline log FIRST. Newest-first
  // consumption let a newer manual ask steal an older automated row's stamp.
  // An orphan stamp cannot excuse a manual text several minutes later.
  const pairs = [];
  sends.forEach((send, sendIndex) => {
    const sentAt = new Date(send.sms_sent_at).getTime();
    candidates.forEach((row, rowIndex) => {
      const gap = Math.abs(new Date(row.created_at).getTime() - sentAt);
      if (gap <= 90000) pairs.push({ gap, sendIndex, rowIndex });
    });
  });
  pairs.sort((a, b) => a.gap - b.gap);
  const matchedSends = new Set();
  const matchedRows = new Set();
  for (const pair of pairs) {
    if (matchedSends.has(pair.sendIndex) || matchedRows.has(pair.rowIndex)) continue;
    matchedSends.add(pair.sendIndex);
    matchedRows.add(pair.rowIndex);
  }
  const manual = candidates.find((row, index) => !matchedRows.has(index)
    && new Date(row.created_at) >= sinceAt);
  const manualAt = manual ? new Date(manual.created_at) : null;
  return reservedAt && (!manualAt || reservedAt > manualAt) ? reservedAt : manualAt;
}

module.exports = { ASK_SPACING_MS, looksLikeReviewAsk, deliveredAskRows, latestDeliveredAt, lastDeliveredAskAt, lastManualAskAt };
