/**
 * "Suggest a post" from the completion forms' blog search
 * (GATE_BLOG_SEARCH_SUGGEST, owner mockup approval 2026-10-03; owner ruling
 * 2026-10-02: straight into the autonomous blog queue, written and published
 * automatically, no approval step).
 *
 * When no live post holds every word of a search (report-blog-post.js
 * searchReportBlogPosts, `exact`), the technician or the office can send the
 * search as a topic. It becomes one opportunity_queue row the existing
 * autonomous chain claims, writes, gates and publishes:
 *  - bucket 'operator_intercept' with signal_metadata.operator_pinned: the
 *    one bucket the chain takes without search-traffic evidence (the router
 *    pin, the brief builder, the quality gate's SERP/GSC exemption and the
 *    runner's skipSerp all key on it); any other bucket would be written and
 *    then skipped for having no GSC or SERP signal;
 *  - action new_supporting_blog, the phrase as its query, no page, no city
 *    (the facts gate is then not applicable), the service and specialty
 *    topic inferred from the phrase as the GSC miner infers them (the FAQ
 *    policy reads them);
 *  - score 79: ahead of the mined topics (73 at most), citability backfills
 *    (75) and refresh audits (78), behind the owner's own seeded briefs (80
 *    and up); it expires after 45 days unclaimed, as seeded rows do.
 * The chain's own gates (topic targeting, uniqueness, guardrails, fact check,
 * publish caps) still run on every post; no approval step is added.
 *
 * A phrase that is no topic is refused before anything is written: a
 * "near me" (transactional) phrase, a place out of the service area, or one
 * holding personal data (a phone, an email, an address, a name). A phrase
 * already queued from any source (the same query on a live or finished
 * new-blog row) or suggested before answers already_queued; a suggestion
 * that expired unclaimed is revived; one the chain tried and skipped stays
 * as it is. Each person sends at most MAX_PER_DAY a day. The phrase is never
 * logged (ids only).
 */

const MIN_CHARS = 3;
const MAX_CHARS = 80;
const SCORE = 79;
const EXPIRES_DAYS = 45;
const MAX_PER_DAY = 10;
const SOURCE = 'tech_blog_search';
// The statuses a new-blog row keeps its topic in (any source).
const HELD_STATUSES = ['pending', 'claimed', 'pending_review', 'done'];

// The phrase as a query: trimmed, one space between words, lower case.
function normalizePhrase(phrase) {
  return String(phrase || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// The queue's dedupe key for a suggested phrase (at most 200 characters).
function dedupeKeyFor(phrase) {
  const slug = phrase.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 150);
  return `techsuggest:v1:${slug}`;
}

// Why a phrase cannot be a topic, or null. `typed` is the phrase as the
// person typed it, for the personal-data check.
function phraseProblem(phrase, typed = phrase) {
  const { searchTerms } = require('./report-blog-post');
  if (phrase.length < MIN_CHARS || phrase.length > MAX_CHARS || !searchTerms(phrase).length) return 'not_a_topic';
  const { isTransactionalQuery } = require('../content/scoring-config');
  if (isTransactionalQuery(phrase)) return 'not_a_topic';
  const { geoBlockReason } = require('../content/topic-targeting-gate');
  if (geoBlockReason(phrase, { allowStatewide: true })) return 'not_a_topic';
  // Personal data, read in the words as typed as well as normalized:
  // lowercasing hides a capitalized name from the redactor ("ants at John
  // Smith home"), and a phrase it is unsure of (confidence below high) is
  // refused too. A capitalized topic ("Standing Water") can read as a name
  // and is refused with it: the redactor's own rule is that a false name costs
  // far less than a real one reaching a published post (pre-push P1 on
  // 1aaeaa36ab).
  const { redact } = require('../content/pii-redactor');
  for (const text of new Set([String(typed || ''), phrase])) {
    const { findings = [], confidence } = redact(text);
    if (findings.length || confidence !== 'high') return 'not_a_topic';
  }
  return null;
}

// The queue row for a phrase.
function suggestionRow(phrase, { actorId = null, scheduledServiceId = null, now = new Date() } = {}) {
  const { inferServiceFromQuery, extractSpecialtyTopic } = require('../seo/gsc-opportunity-miner');
  return {
    bucket: 'operator_intercept',
    action_type: 'new_supporting_blog',
    query: phrase,
    page_url: null,
    service: inferServiceFromQuery(phrase) || null,
    city: null,
    score: SCORE,
    score_breakdown: { base: SCORE, source: SOURCE },
    signal_metadata: {
      source: SOURCE,
      operator_pinned: true,
      specialty_topic: extractSpecialtyTopic([phrase]) || null,
      suggested_at: now.toISOString(),
      suggested_by: actorId,
      scheduled_service_id: scheduledServiceId,
    },
    status: 'pending',
    expires_at: new Date(now.getTime() + EXPIRES_DAYS * 24 * 60 * 60 * 1000),
    dedupe_key: dedupeKeyFor(phrase),
  };
}

/**
 * Suggest a phrase as a new post. Answers { status: 'queued' } when a row was
 * written (or an expired suggestion revived), { status: 'already_queued' }
 * when the topic is held already, { status: 'covered' } when a live post now
 * holds every word, and { error } for a phrase that is no topic or a person
 * over the day's limit.
 */
async function suggestReportBlogPost(knex, { phrase: raw, actorId = null, scheduledServiceId = null }) {
  const phrase = normalizePhrase(raw);
  const problem = phraseProblem(phrase, raw);
  if (problem) return { error: problem };
  const { searchReportBlogPosts } = require('./report-blog-post');
  if ((await searchReportBlogPosts(knex, phrase)).some((post) => post.exact)) return { status: 'covered' };
  // One suggestion at a time per person, so the day's cap holds when taps
  // race: the count, the held check and the write share one transaction
  // under the person's advisory lock (pre-push P1 on 1aaeaa36ab).
  return knex.transaction((trx) => writeSuggestion(trx, phrase, { actorId, scheduledServiceId }));
}

async function writeSuggestion(trx, phrase, { actorId, scheduledServiceId }) {
  if (actorId) {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`report-blog-suggestion:${actorId}`]);
    const sent = await trx('opportunity_queue')
      .whereRaw("signal_metadata->>'source' = ?", [SOURCE])
      .whereRaw("signal_metadata->>'suggested_by' = ?", [String(actorId)])
      .whereRaw("mined_at > now() - interval '1 day'")
      .count('* as n')
      .first();
    if (Number(sent?.n) >= MAX_PER_DAY) return { error: 'too_many_suggestions' };
  }
  const held = await trx('opportunity_queue')
    .where({ action_type: 'new_supporting_blog' })
    .whereRaw('lower(query) = ?', [phrase])
    .whereIn('status', HELD_STATUSES)
    .first('id');
  if (held) return { status: 'already_queued' };
  const row = suggestionRow(phrase, { actorId: actorId == null ? null : String(actorId), scheduledServiceId });
  const columns = Object.keys(row);
  const values = columns.map((column) => (column === 'score_breakdown' || column === 'signal_metadata' ? JSON.stringify(row[column]) : row[column]));
  // A new key writes the row; an expired suggestion of the same phrase is
  // revived; any other held or skipped one stays as it is.
  const result = await trx.raw(
    `INSERT INTO opportunity_queue (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
     ON CONFLICT (dedupe_key) DO UPDATE SET status = 'pending', attempt_count = 0, skip_reason = NULL,
       mined_at = now(), expires_at = EXCLUDED.expires_at, signal_metadata = EXCLUDED.signal_metadata, updated_at = now()
     WHERE opportunity_queue.status = 'expired'
     RETURNING id`,
    values,
  );
  return (result?.rows || []).length ? { status: 'queued' } : { status: 'already_queued' };
}

module.exports = {
  suggestReportBlogPost,
  suggestionRow,
  phraseProblem,
  normalizePhrase,
  dedupeKeyFor,
  MAX_PER_DAY,
  SCORE,
  SOURCE,
};
