/**
 * customer-insights-miner.js — clusters customer questions observed
 * across messages (inbound SMS), call_log (lead synopses), and
 * google_reviews into topic+city+service rows in
 * customer_insight_clusters.
 *
 * Reader, not ingestor — never mutates source tables. Persists ONLY
 * cluster aggregates, never raw transcripts or message bodies.
 *
 * Source-eligibility gate runs per record before clustering:
 *
 *   call_log
 *     - direction == 'inbound'
 *     - lead_synopsis or transcription not null
 *     - if `call_recording_consent_disclaimer_played` column exists →
 *         require true. If column absent → ALL calls excluded with
 *         reason 'consent_column_missing' (degrade closed). Operator
 *         task: add the column to call_log.
 *     - call_outcome not in {wrong_number, spam}
 *
 *   messages (SMS inbound)
 *     - direction == 'inbound', channel == 'sms', author_type == 'customer'
 *     - sender phone NOT in messaging_suppression (active=true)
 *     - body has business-context match (service keyword)
 *
 *   google_reviews
 *     - star_rating ≥ 3 (cherry-picking against complaints is bad faith
 *       and risks defamation; positive/neutral reviews only for content)
 *     - review_text non-empty and not a JSON blob (Step 0 found some
 *       review_text rows contain {"rating":N,...} metadata)
 *
 * Topic classification reuses the regex set the calibration script
 * uses, expanded.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { redact } = require('./pii-redactor');
const { CITIES, THRESHOLDS } = require('./scoring-config');

// ── topic classifier ─────────────────────────────────────────────────

const TOPICS = [
  { topic: 'pet-safety', re: /(safe for (dog|cat|pet)s?|toxic|harmful to (dog|cat|pet)s?)/i },
  { topic: 'rain-after-treatment', re: /(rain (after|ruin|wash)|wash off|raining|just rained)/i },
  { topic: 'same-day-service', re: /(today|same.?day|right now|asap|emergency|come out today)/i, urgency: 'high' },
  { topic: 'price-cost', re: /(how much|cost|price|estimate|quote|pricing)/i },
  { topic: 'termite-vs-flying-ants', re: /(termite|flying ants?|swarm)/i },
  { topic: 'rodent-attic-noise', re: /(scratching|attic.*(rats?|mice|rodent)|noise (at night|in (the )?attic|in the walls))/i },
  { topic: 'mosquito-timing', re: /(mosquit(o|oes)|skeeters|biting outside)/i },
  { topic: 'roach-identification', re: /(roach|palmetto bug|water bug|cockroach)/i },
  { topic: 'tiny-bugs', re: /(tiny bugs?|small bugs?|ants? in (kitchen|bathroom|sink))/i },
  { topic: 'leave-house-after-spray', re: /(leave (the )?house|when can i (come back|reenter)|airing out|how long after spray)/i },
  { topic: 'bugs-worse-after-spray', re: /(worse after|more bugs after|coming out after)/i },
  { topic: 'lawn-fungus-brown-spots', re: /(brown spots?|fungus|dollar spot|gray leaf|grey leaf|fairy ring)/i },
  { topic: 'chinch-bug-damage', re: /(chinch|st\.?\s*augustine dying)/i },
  { topic: 'fire-ants', re: /(fire ants?|ant mounds?|stinging ants?)/i },
  { topic: 'ant-trail-kitchen', re: /(ant trails?|ants? in (line|kitchen|sink))/i },
  { topic: 'spider-in-house', re: /(spider|web|brown recluse|black widow)/i },
  { topic: 'fertilizer-blackout', re: /(fertiliz|nitrogen|phosphorus|summer feed|blackout)/i },
  { topic: 'service-area-confirm', re: /(do you (service|cover|come to)|service area|deliver to)/i },
];

function classifyTopic(text) {
  if (!text) return null;
  for (const { topic, re, urgency } of TOPICS) {
    if (re.test(text)) return { topic, urgency: urgency || null };
  }
  return null;
}

function inferCity(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  for (const c of CITIES) {
    if (t.includes(c.toLowerCase())) return c;
  }
  return null;
}

function inferService(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  if (/\btermite|wdo\b/.test(t)) return 'termite';
  if (/\b(rodent|rat|mice|mouse)\b/.test(t)) return 'rodent';
  if (/\bmosquito\b/.test(t)) return 'mosquito';
  if (/\b(lawn|grass|fertiliz|chinch|aeration)\b/.test(t)) return 'lawn';
  if (/\b(tree|shrub|palm)\b/.test(t)) return 'tree-shrub';
  if (/\b(pest|exterminat|bug|roach|ant|spider)\b/.test(t)) return 'pest';
  return null;
}

function inferFunnelStage(source, text) {
  // Reviews are by definition post-service.
  if (source === 'review') return 'post-service';
  if (!text) return 'unknown';
  const t = String(text).toLowerCase();
  if (/\b(my next|next service|after my treatment|tech came|tech said|been a customer)\b/.test(t)) return 'active-customer';
  if (/\b(quote|estimate|how much|first time|new customer|interested|considering)\b/.test(t)) return 'pre-sale';
  if (/\b(after spray|after treatment|since (you|the tech))\b/.test(t)) return 'post-service';
  return 'unknown';
}

// ── eligibility gates ────────────────────────────────────────────────

async function hasCallConsentColumn() {
  try {
    const cols = await db('information_schema.columns')
      .where({ table_name: 'call_log', table_schema: 'public' })
      .pluck('column_name');
    return cols.includes('call_recording_consent_disclaimer_played');
  } catch { return false; }
}

async function loadSuppressedPhones() {
  try {
    const rows = await db('messaging_suppression').where('active', true).pluck('phone');
    return new Set(rows.map((p) => normalizePhone(p)));
  } catch { return new Set(); }
}

function normalizePhone(raw) {
  if (!raw) return '';
  return String(raw).replace(/\D/g, '').replace(/^1/, '');
}

function gateCallRecord(row, { consentColumnPresent }) {
  if (!consentColumnPresent) return { ok: false, reason: 'consent_column_missing' };
  if (row.call_recording_consent_disclaimer_played !== true) return { ok: false, reason: 'consent_not_played' };
  if (['wrong_number', 'spam'].includes(row.call_outcome)) return { ok: false, reason: 'non_service_call' };
  const text = row.lead_synopsis || row.transcription;
  if (!text) return { ok: false, reason: 'no_text' };
  return { ok: true, text };
}

function gateSmsRecord(row, { suppressedPhones }) {
  if (suppressedPhones.has(normalizePhone(row.from_phone))) {
    return { ok: false, reason: 'suppressed_sender' };
  }
  const text = row.body;
  if (!text) return { ok: false, reason: 'empty_body' };
  if (!hasBusinessContext(text)) return { ok: false, reason: 'no_business_context' };
  return { ok: true, text };
}

function gateReviewRecord(row) {
  if (!row.review_text) return { ok: false, reason: 'empty_text' };
  // Step 0 surfaced some review_text rows containing JSON metadata blobs.
  if (/^\s*\{[\s\S]*\}\s*$/.test(row.review_text)) return { ok: false, reason: 'json_blob_in_text' };
  if (typeof row.star_rating === 'number' && row.star_rating < 3) {
    return { ok: false, reason: 'low_star_complaint' };
  }
  return { ok: true, text: row.review_text };
}

const BUSINESS_KEYWORDS = /(pest|bug|ant|roach|spider|rat|mice|mouse|rodent|termite|mosquito|lawn|grass|fertiliz|spray|treatment|service|appointment|estimate|quote|cost|price|inspect|chinch|fungus|weed|aeration|exterminator)/i;
function hasBusinessContext(text) {
  return BUSINESS_KEYWORDS.test(text);
}

// ── cluster aggregation ─────────────────────────────────────────────

class CustomerInsightsMiner {
  async mineAll({ days = 90, persist = true } = {}) {
    const since = new Date(Date.now() - days * 86400_000);

    const consentColumnPresent = await hasCallConsentColumn();
    const suppressedPhones = await loadSuppressedPhones();
    if (!consentColumnPresent) {
      logger.warn('[insights-miner] call_log.call_recording_consent_disclaimer_played missing — calls excluded');
    }

    const eligibility = { records_seen: 0, records_admitted: 0, records_excluded: 0, exclusion_reasons: {} };
    const clusters = new Map();

    const bumpReason = (reason) => {
      eligibility.records_excluded++;
      eligibility.exclusion_reasons[reason] = (eligibility.exclusion_reasons[reason] || 0) + 1;
    };

    const admit = (source, text, createdAt, { city: cityHint } = {}) => {
      eligibility.records_admitted++;
      const topicMatch = classifyTopic(text);
      if (!topicMatch) return; // not a customer-question pattern we recognize
      const { topic, urgency } = topicMatch;
      const city = cityHint || inferCity(text);
      const service = inferService(text);
      const funnelStage = inferFunnelStage(source, text);
      const key = `${topic}::${city || '_'}::${service || '_'}`;
      const c = clusters.get(key) || {
        topic, city, service,
        source_counts: { sms: 0, call: 0, review: 0 },
        total_count: 0,
        first_seen: createdAt,
        last_seen: createdAt,
        example_records: [],
        urgency: urgency || 'low',
        funnel_stage_votes: {},
      };
      c.source_counts[source] = (c.source_counts[source] || 0) + 1;
      c.total_count++;
      if (createdAt < c.first_seen) c.first_seen = createdAt;
      if (createdAt > c.last_seen) c.last_seen = createdAt;
      c.example_records.push(text);
      c.funnel_stage_votes[funnelStage] = (c.funnel_stage_votes[funnelStage] || 0) + 1;
      if (urgency === 'high') c.urgency = 'high';
      clusters.set(key, c);
    };

    // ── calls ────────────────────────────────────────────────────
    try {
      const calls = await db('call_log')
        .where('direction', 'inbound')
        .where('created_at', '>=', since)
        .modify((qb) => {
          // Pluck whichever text columns exist; both are nullable so a
          // record may have neither and get gated out as no_text.
          qb.select('id', 'lead_synopsis', 'transcription', 'call_outcome', 'created_at');
          if (consentColumnPresent) qb.select('call_recording_consent_disclaimer_played');
        });
      for (const row of calls) {
        eligibility.records_seen++;
        const gate = gateCallRecord(row, { consentColumnPresent });
        if (!gate.ok) { bumpReason(gate.reason); continue; }
        admit('call', gate.text, row.created_at);
      }
    } catch (e) {
      logger.warn(`[insights-miner] call_log read failed: ${e.message}`);
    }

    // ── SMS ──────────────────────────────────────────────────────
    // Phone comes from either conversations.contact_phone (unknown
    // contact) or customers.phone via conversations.customer_id (known
    // contact). COALESCE picks whichever is populated; if neither is,
    // we degrade closed (suppression_lookup_unavailable).
    try {
      const sms = await db('messages')
        .where('messages.direction', 'inbound')
        .where('messages.channel', 'sms')
        .where('messages.author_type', 'customer')
        .where('messages.created_at', '>=', since)
        .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
        .leftJoin('customers', 'conversations.customer_id', 'customers.id')
        .select(
          'messages.id as message_id',
          'messages.body',
          'messages.created_at',
          db.raw('COALESCE(conversations.contact_phone, customers.phone) as from_phone')
        );
      for (const row of sms) {
        eligibility.records_seen++;
        if (!row.from_phone) { bumpReason('suppression_lookup_unavailable'); continue; }
        const gate = gateSmsRecord(row, { suppressedPhones });
        if (!gate.ok) { bumpReason(gate.reason); continue; }
        admit('sms', gate.text, row.created_at);
      }
    } catch (e) {
      logger.warn(`[insights-miner] messages read failed: ${e.message}`);
    }

    // ── reviews ──────────────────────────────────────────────────
    try {
      const reviews = await db('google_reviews')
        .where('review_created_at', '>=', since)
        .select('id', 'review_text', 'star_rating', 'review_created_at', 'location_id');
      for (const row of reviews) {
        eligibility.records_seen++;
        const gate = gateReviewRecord(row);
        if (!gate.ok) { bumpReason(gate.reason); continue; }
        const cityHint = locationIdToCity(row.location_id);
        admit('review', gate.text, row.review_created_at, { city: cityHint });
      }
    } catch (e) {
      logger.warn(`[insights-miner] google_reviews read failed: ${e.message}`);
    }

    // ── finalize: redact one example per cluster, drop raw text ──
    const finalized = [];
    for (const c of clusters.values()) {
      const example = pickExample(c.example_records);
      const redacted = redact(example);
      c.example_phrasing_anonymized = paraphrase(redacted.text);
      c.redaction_confidence = redacted.confidence;
      c.funnel_stage = topKey(c.funnel_stage_votes) || 'unknown';
      c.normalized_question = normalizedQuestionFor(c.topic);
      delete c.example_records;
      delete c.funnel_stage_votes;
      finalized.push(c);
    }

    finalized.sort((a, b) => b.total_count - a.total_count);

    // Drop single-mention noise: one customer saying something once is not an
    // insight. We intentionally do NOT gate at customerClusterMinSize (10) here
    // — clusters of 2-9 still feed the decision-router's partial customer-demand
    // credit and the quality gate's FAQ anchoring, both of which read persisted
    // rows. The minSize threshold remains the FULL-credit bar, applied downstream.
    let persisted = 0;
    if (persist) persisted = await this.persist(finalized.filter((c) => c.total_count >= 2));

    return {
      eligibility_summary: eligibility,
      cluster_count: finalized.length,
      qualifying_count: finalized.filter((c) => c.total_count >= THRESHOLDS.customerClusterMinSize).length,
      persisted,
      clusters: finalized,
    };
  }

  async persist(clusters) {
    if (!clusters.length) return 0;
    let count = 0;
    for (const c of clusters) {
      try {
        await db.raw(
          `INSERT INTO customer_insight_clusters
            (topic, normalized_question, city, service, funnel_stage, urgency,
             source_counts, total_count, first_seen, last_seen,
             example_phrasing_anonymized, redaction_confidence,
             eligibility_summary, mined_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?::jsonb, now(), now(), now())
           ON CONFLICT (topic, city, service) DO UPDATE
             SET normalized_question = EXCLUDED.normalized_question,
                 funnel_stage = EXCLUDED.funnel_stage,
                 urgency = EXCLUDED.urgency,
                 source_counts = EXCLUDED.source_counts,
                 total_count = EXCLUDED.total_count,
                 first_seen = LEAST(customer_insight_clusters.first_seen, EXCLUDED.first_seen),
                 last_seen = GREATEST(customer_insight_clusters.last_seen, EXCLUDED.last_seen),
                 example_phrasing_anonymized = EXCLUDED.example_phrasing_anonymized,
                 redaction_confidence = EXCLUDED.redaction_confidence,
                 eligibility_summary = EXCLUDED.eligibility_summary,
                 mined_at = EXCLUDED.mined_at,
                 updated_at = now()
          `,
          [
            c.topic, c.normalized_question, c.city || null, c.service || null,
            c.funnel_stage, c.urgency,
            JSON.stringify(c.source_counts), c.total_count,
            c.first_seen, c.last_seen,
            c.example_phrasing_anonymized, c.redaction_confidence,
            JSON.stringify({}),  // per-cluster eligibility summary unused for now
          ]
        );
        count++;
      } catch (err) {
        logger.warn(`[insights-miner] persist failed for cluster ${c.topic}/${c.city}/${c.service}: ${err.message}`);
      }
    }
    return count;
  }
}

// ── helpers ──────────────────────────────────────────────────────────

const LOCATION_TO_CITY = {
  'bradenton': 'Bradenton',
  'lakewood-ranch': 'Lakewood Ranch',
  'parrish': 'Parrish',
  'sarasota': 'Sarasota',
  'venice': 'Venice',
  'north-port': 'North Port',
  'palmetto': 'Palmetto',
  'port-charlotte': 'Port Charlotte',
};

function locationIdToCity(id) {
  return id ? LOCATION_TO_CITY[id.toLowerCase()] || null : null;
}

function pickExample(records) {
  if (!records?.length) return '';
  // Pick the shortest non-empty record — less likely to contain PII.
  const sorted = [...records]
    .filter((r) => r && String(r).trim().length > 8)
    .sort((a, b) => a.length - b.length);
  return sorted[0] || records[0] || '';
}

function paraphrase(text) {
  // Step 3 doesn't introduce an LLM. Paraphrasing here is a no-op:
  // we keep the redacted source phrasing, capped to 200 chars. The
  // engine never quotes this publicly anyway — it informs internal
  // brief building. If we later add LLM-based paraphrasing, swap here.
  return String(text || '').slice(0, 200);
}

function topKey(counts) {
  if (!counts || !Object.keys(counts).length) return null;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function normalizedQuestionFor(topic) {
  const MAP = {
    'pet-safety': 'Is the treatment safe for pets?',
    'rain-after-treatment': 'Does rain affect the treatment?',
    'same-day-service': 'Can a tech come out today?',
    'price-cost': 'How much does the service cost?',
    'termite-vs-flying-ants': 'How can I tell termites from flying ants?',
    'rodent-attic-noise': 'What is scratching in my attic at night?',
    'mosquito-timing': 'When is the best time to treat mosquitoes?',
    'roach-identification': 'Is this a roach or a palmetto bug?',
    'tiny-bugs': 'What are the tiny bugs in my kitchen / bathroom?',
    'leave-house-after-spray': 'How long should I stay out after a spray?',
    'bugs-worse-after-spray': 'Why are bugs worse right after a spray?',
    'lawn-fungus-brown-spots': 'What is causing the brown spots in my lawn?',
    'chinch-bug-damage': 'Is chinch bug damage killing my St. Augustine?',
    'fire-ants': 'How do I get rid of fire ant mounds?',
    'ant-trail-kitchen': 'How do I stop ant trails in my kitchen?',
    'spider-in-house': 'How do I get spiders out of the house?',
    'fertilizer-blackout': 'What can I apply during the summer fertilizer blackout?',
    'service-area-confirm': 'Do you service my city?',
  };
  return MAP[topic] || topic;
}

module.exports = new CustomerInsightsMiner();
module.exports.CustomerInsightsMiner = CustomerInsightsMiner;
module.exports._internals = {
  TOPICS,
  classifyTopic,
  inferCity,
  inferService,
  inferFunnelStage,
  gateCallRecord,
  gateSmsRecord,
  gateReviewRecord,
  hasBusinessContext,
  normalizePhone,
  pickExample,
  paraphrase,
  normalizedQuestionFor,
  locationIdToCity,
};
