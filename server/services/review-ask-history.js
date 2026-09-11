const db = require('../models/db');
const { publicPortalUrl } = require('../utils/portal-url');
const { ASK_TOUCH_SQL } = require('./review-outreach-templates');

const ASK_SPACING_MS = 72 * 3600000;
const REVIEW_LINK_RE = /g\.page\/(?:r\/)?[^\s/]+\/review\b|writereview|writeareview|facebook\.com\/[^\s/]+\/reviews\b/i;
const REVIEW_INTENT_RE = /\b(?:leave|write|post|submit|share|give|add|update|edit|(?:mind|consider|how\s+about)\s+(?:leaving|writing|posting|submitting|sharing|giving|adding|updating|editing))\s+(?:(?:us|me)\s+)?(?:(?:a|an|your|the)\s+)?(?:(?:quick|short|honest|online|public|five[- ]star|5[- ]star|google|yelp|facebook)\s+)*review\b|\breview\s+us\b|\bshare\s+your\s+experience\s+in\s+a\s+review\b/i;

// Conditional requests put the verb in the past tense ("if you left us a
// Google review"). Gating on the "if you" clause keeps acknowledgments
// ("thanks for the review you left us") out.
const REVIEW_CONDITIONAL_RE = /\bif\s+(?:you|y['’]all|ya)\s+(?:ever\s+|could\s+|would\s+|would\s+ever\s+|wouldn['’]t\s+mind\s+)?(?:left|leave|leaving|wrote|write|writing|posted|post|posting|shared|share|sharing|gave|give|giving|submitted|submit|submitting)\s+(?:(?:us|me)\s+)?(?:(?:a|an|your|the)\s+)?(?:(?:quick|short|honest|online|public|five[- ]star|5[- ]star|google|yelp|facebook)\s+)*review\b/i;

const REVIEW_INVITATION_RE = /\b(?:we|i)(?:['’]d|\s+would)\s+(?:(?:really|greatly)\s+)?(?:appreciate|love|be\s+(?:really\s+)?grateful\s+for)\s+(?:(?:a|an|your)\s+)?(?:(?:quick|short|honest|online|public|five[- ]star|5[- ]star|google|yelp|facebook)\s+)*review\b|\b(?:a|your)\s+(?:(?:quick|short|honest|online|public|five[- ]star|5[- ]star|google|yelp|facebook)\s+)*review\s+(?:would|could)\s+(?:really\s+)?(?:mean|help|support|make\s+(?:my|our)\s+day|be\s+(?:(?:greatly|really|much)\s+)?appreciated)\b|\b(?:a|your)\s+(?:(?:quick|short|honest|online|public|five[- ]star|5[- ]star|google|yelp|facebook)\s+)*review\s+(?:really\s+)?(?:means|helps|supports|makes\s+(?:my|our)\s+day|is\s+(?:(?:greatly|really|much)\s+)?appreciated)\b/i;

// Present-tense declarative asks with no textual link ("that review link one
// more time") — the repo's own soft_reminder/qr_followup wording — count on
// their own; they no longer need a co-occurring /l/ short link (see below).
// Only request/reminder framing counts ("here is that review link", "that
// review link one more time", "review link: <url>"). Support chatter about the
// link ("the review link is broken", "I fixed the review link") is not an ask.
const REVIEW_LINK_MENTION_RE = /\b(?:here(?:['’]s|\s+is)\s+(?:that|the|your)\s+review\s+link|(?:that|the|your)\s+review\s+link\s+(?:again|one\s+more\s+time|below|for\s+you)|review\s+link:\s*\S)/i;

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
  // Reviewing a document is different from reviewing the business. A noun
  // ("comments", "feedback", "notes") can sit between "review" and the
  // document preposition ("share your review comments on the attached
  // estimate") — tolerate up to two such words so the carve-out still fires.
  const intentText = text.replace(/\breview\s+(?:\w+\s+){0,2}(?:of|on|for)\s+(?:(?:the|your|our|my|attached|updated)\s+)*(?:estimate|invoice|agreement|contract|report|document|proposal)\b/gi, 'document assessment');
  return portalRate || REVIEW_LINK_RE.test(text) || REVIEW_INTENT_RE.test(intentText) || REVIEW_INVITATION_RE.test(intentText) || REVIEW_CONDITIONAL_RE.test(intentText)
    || /\b(?:could|can|may)\s+(?:i|we)\s+ask\s+(?:you\s+)?for\s+(?:(?:a|an|your)\s+)?(?:(?:quick|short|honest|online|public|five[- ]star|5[- ]star|google|yelp|facebook)\s+)*review\b/i.test(intentText)
    || (/maps\.app\.goo\.gl\/|goo\.gl\/maps|maps\.google\.[a-z.]+\//i.test(text)
      && /\b(?:share|leave|give)\s+(?:(?:us|me)\s+)?(?:(?:your|some)\s+)?feedback\b/i.test(text))
    || REVIEW_LINK_MENTION_RE.test(intentText)
    || (/\/l\/[A-Za-z0-9]{3,}\b/.test(text) && /\b(?:a|your|google|yelp|facebook)\s+(?:(?:quick|short|honest|online|public|five[- ]star|5[- ]star|google|yelp|facebook)\s+)*review\b/i.test(text));
}

// review_requests.followup_sent_at is NOT reliable delivery evidence: besides
// the genuine review_request_followup SMS (review-request.js ~3024),
// processFollowups also stamps it as a plain "handled" marker for
// soft-deleted customers, dedup'd siblings, no-consent contacts, and
// blocked/failed sends (review-request.js:2810,2875,2930,2953,3015) — none
// of those reached the customer. The real delivery timestamp instead lives
// in messaging_audit_log.sent_at (set only once the provider actually
// dispatches), correlated back to this row via the review_request_id the
// followup send stamps into its metadata.
const FOLLOWUP_DELIVERED_SUBQUERY = `(
  SELECT metadata->>'review_request_id' AS review_request_id, MAX(sent_at) AS followup_delivered_at
  FROM messaging_audit_log
  WHERE customer_id = ? AND entry_point = 'review_request_followup' AND sent_at IS NOT NULL
  GROUP BY metadata->>'review_request_id'
) followups`;

function deliveredAskRows(customerId, { since = null, excludeRequestId = null } = {}) {
  const q = db('review_requests')
    // Correlated to the customer so the derived table uses the audit log's
    // customer index instead of grouping every follow-up ever delivered.
    .joinRaw(`LEFT JOIN ${FOLLOWUP_DELIVERED_SUBQUERY} ON followups.review_request_id = review_requests.id::text`, [customerId])
    .where({ 'review_requests.customer_id': customerId })
    .whereRaw('(review_requests.sms_sent_at IS NOT NULL OR review_requests.sent_at IS NOT NULL OR followups.followup_delivered_at IS NOT NULL)')
    .whereRaw(ASK_TOUCH_SQL)
    .select('review_requests.id', 'review_requests.sequence_id', 'review_requests.template_key',
      'review_requests.sms_sent_at', 'review_requests.sent_at', 'followups.followup_delivered_at');
  if (since) q.whereRaw('GREATEST(review_requests.sms_sent_at, review_requests.sent_at, followups.followup_delivered_at) > ?', [since]);
  if (excludeRequestId) q.where('review_requests.id', '!=', excludeRequestId);
  return q;
}

// A retried email leg, or the genuinely delivered legacy follow-up SMS, can
// be later than the original ask's own sms_sent_at/sent_at on the same row.
function latestDeliveredAt(rows) {
  return rows.reduce((latest, row) => {
    const at = Math.max(...[row.sms_sent_at, row.sent_at, row.followup_delivered_at].map(value => value ? new Date(value).getTime() : 0));
    return Number.isFinite(at) && at > (latest?.getTime() || 0) ? new Date(at) : latest;
  }, null);
}

async function lastDeliveredAskAt(customerId, options) {
  return latestDeliveredAt(await deliveredAskRows(customerId, options));
}

// Lookups throw: dispatch callers must hold when evidence is unavailable.
// The enrollment standdown retains its explicit fail-open wrapper.
async function lastManualAskAt(customerId, { since, includeReservations = true } = {}) {
  const sinceAt = since ? new Date(since) : new Date(Date.now() - 30 * 86400000);
  const fetchFloor = new Date(sinceAt.getTime() - 90000);
  const outbound = await db('sms_log')
    .where({ customer_id: customerId, direction: 'outbound' })
    // Include correspondence just before the boundary so its timestamp
    // cannot instead be assigned to a manual ask just after the boundary.
    // A resolved review-ask reservation is fetched by EITHER timestamp:
    // Communications can open it (created_at) before a same-moment
    // enrollment misses it while still 'sending' (includeReservations:
    // false), and only confirm delivery (updated_at) afterward — the
    // confirmation must not be lost just because the placeholder predates
    // the boundary (codex P1, review-request.js:1476).
    .whereRaw('(created_at >= ? OR updated_at >= ?)', [fetchFloor, fetchFloor])
    .whereNotIn('status', ['scheduled', 'canceled', 'cancelled', 'failed', 'undelivered', 'blocked'])
    .orderBy('created_at', 'desc')
    .select('message_body', 'created_at', 'updated_at', 'status', 'metadata');
  const isReviewReservation = row => row.metadata?.review_ask_reservation === true;
  // An unresolved provider attempt conservatively holds the same 72-hour
  // window only when the caller includes reservations. A confirmed marker
  // belongs in candidates below: it is durable delivery evidence even when
  // its short-link body is not independently recognizable as a review ask,
  // and the normal request/log correlation must still distinguish an
  // automated pipeline send from a staff ask.
  const reservations = includeReservations
    ? outbound.filter(row => row.status === 'sending' && isReviewReservation(row))
    : [];
  const reservedAt = reservations.reduce((latest, row) => {
    const at = new Date(row.created_at);
    return at >= sinceAt && (!latest || at > latest) ? at : latest;
  }, null);
  const candidates = outbound.filter(row => row.status !== 'sending'
    && (isReviewReservation(row) || looksLikeReviewAsk(row.message_body)));
  // A resolved reservation's real ask-evidence time is its provider
  // confirmation (updated_at), not the placeholder's created_at: the
  // reservation is opened before the send, so its created_at can land
  // before a since-boundary (typically a sequence's started_at) that the
  // confirmation itself falls after. An ordinary manual send (never a
  // reservation) keeps created_at — it is typed and sent in the same
  // moment, so there is no earlier placeholder to anchor past.
  const effectiveAskAt = row => (row.status !== 'sending' && isReviewReservation(row) && row.updated_at
    ? new Date(Math.max(new Date(row.created_at).getTime(), new Date(row.updated_at).getTime()))
    : new Date(row.created_at));
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
  // The MAX effective time, not the first row in created_at order. A
  // resolved reservation's evidence time is its confirmation (updated_at),
  // which can be later than a plain candidate's created_at even though the
  // placeholder itself is older — .find() on a created_at-desc list would
  // return that plain row and understate the floor, letting the next touch
  // fire inside 72 h. Same reduce-to-max the reservation arm above uses.
  const manualAt = candidates.reduce((latest, row, index) => {
    if (matchedRows.has(index)) return latest;
    const at = effectiveAskAt(row);
    return at >= sinceAt && (!latest || at > latest) ? at : latest;
  }, null);
  return reservedAt && (!manualAt || reservedAt > manualAt) ? reservedAt : manualAt;
}

module.exports = { ASK_SPACING_MS, looksLikeReviewAsk, deliveredAskRows, latestDeliveredAt, lastDeliveredAskAt, lastManualAskAt };
