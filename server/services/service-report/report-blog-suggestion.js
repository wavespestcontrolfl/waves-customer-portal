/**
 * "Suggest a post" from the completion forms' blog search
 * (GATE_BLOG_SEARCH_SUGGEST, owner mockup approval 2026-10-03; owner ruling
 * 2026-10-02: straight into the autonomous blog queue, written and published
 * automatically, no approval step).
 *
 * When no live post holds every word of a search (report-blog-post.js
 * searchReportBlogPosts, `exact`), the office (an admin login) can send the
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
 * "near me" (transactional) phrase, a place out of the service area, one
 * holding personal data (a phone, an email, an address, a name), or one with a
 * letter outside a-z. A phrase
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
// What a topic is written in: the letters a-z, digits, spaces, and the
// punctuation a search box takes, a phone keyboard's curly quotes and dashes
// included. Any other letter ("李", "josé") is refused: the site-word rule
// reads only a-z and 0-9, so such a word would pass it unread into a published
// topic (GitHub Codex P1 on e8a1e9e876).
const PLAIN_PHRASE_RE = /^[a-z0-9 '‘’"“”\-–—.,?!&\/():;]+$/;

// The phrase as a query: trimmed, one space between words, lower case.
function normalizePhrase(phrase) {
  return String(phrase || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// The queue's dedupe key for a suggested phrase (at most 200 characters).
function dedupeKeyFor(phrase) {
  const slug = phrase.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 150);
  return `techsuggest:v1:${slug}`;
}

// A phrase that places a topic at someone's home or with someone ("ants at
// the wood home", "termites at smith's house", "roaches for mr jones"): a
// topic names a pest or a problem, never whose place it is. Words that make a
// building, not a person, stand ("the pool house", "the guest house").
const PLACE_WORDS = 'home|house|residence|place|property|yard|apartment|condo|unit|family';
const STRUCTURE_WORDS = new Set(['pool', 'guest', 'dog', 'tree', 'green', 'club', 'boat', 'bird', 'farm', 'beach', 'lake', 'ware', 'bath', 'out', 'hot', 'light', 'school', 'mobile', 'manufactured', 'model', 'town', 'open', 'new', 'old', 'my', 'our', 'your', 'their', 'his', 'her']);
const PLACE_CONTEXT_RE = new RegExp(`\\b(?:at|for|near|by|from|behind|outside|inside|around)\\s+(?:the\\s+|a\\s+)?((?:[a-z]+\\s+){0,2}?[a-z]+)(?:['’]s)?\\s+(?:${PLACE_WORDS})\\b`, 'i');
const POSSESSIVE_RE = new RegExp(`\\b[a-z]+['’]s\\s+(?:${PLACE_WORDS})\\b`, 'i');
const TITLE_RE = /\b(?:mr|mrs|ms|miss|dr)\b\.?\s+[a-z]+/i;
function personContext(text) {
  const place = PLACE_CONTEXT_RE.exec(text);
  if (place && !place[1].split(/\s+/).every((word) => STRUCTURE_WORDS.has(word.toLowerCase()))) return true;
  return POSSESSIVE_RE.test(text) || TITLE_RE.test(text);
}

// Why a phrase cannot be a topic, or null. `typed` is the phrase as the
// person typed it.
function phraseProblem(phrase, typed = phrase) {
  const { searchTerms } = require('./report-blog-post');
  if (phrase.length < MIN_CHARS || phrase.length > MAX_CHARS || !PLAIN_PHRASE_RE.test(phrase) || !searchTerms(phrase).length) return 'not_a_topic';
  const { isTransactionalQuery } = require('../content/scoring-config');
  if (isTransactionalQuery(phrase)) return 'not_a_topic';
  const { geoBlockReason } = require('../content/topic-targeting-gate');
  if (geoBlockReason(phrase, { allowStatewide: true })) return 'not_a_topic';
  // Personal data, read in the words as typed as well as normalized (the
  // redactor finds a name by its capitals: "ants at Summer Wood home"), and
  // any read it is unsure of. A capitalized topic ("Standing Water") can read
  // as a name and is refused with it: a suggestion publishes with no approval
  // step, so a false name costs far less than a real one (pre-push P1s on
  // 1aaeaa36ab and d1f230dfa2).
  const { redact } = require('../content/pii-redactor');
  for (const text of new Set([String(typed), phrase])) {
    const { findings = [], confidence } = redact(text);
    if (findings.length || confidence !== 'high') return 'not_a_topic';
  }
  // A name in lowercase, or one made of ordinary words, still reads as a
  // person by its place ("at the wood home", "smith's house", "mr jones").
  if (personContext(phrase)) return 'not_a_topic';
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
  // Only text is a phrase: an object or a list would read as "[object
  // Object]" or a comma list (GitHub Codex P2 on 45144528b8).
  if (typeof raw !== 'string') return { error: 'not_a_topic' };
  const phrase = normalizePhrase(raw);
  const problem = phraseProblem(phrase, raw);
  if (problem) return { error: problem };
  const { searchReportBlogPosts, wordsOnTheSite } = require('./report-blog-post');
  // Every word must be one the site's live posts already use, so a name the
  // checks above miss ("ants for john") or a stray word never becomes a
  // published topic (GitHub Codex P1 on 45144528b8).
  const { known } = await wordsOnTheSite(knex, phrase);
  if (!known.length || !known.every(Boolean)) return { error: 'not_a_topic' };
  if ((await searchReportBlogPosts(knex, phrase)).some((post) => post.exact)) return { status: 'covered' };
  // One suggestion at a time per person, so the day's cap holds when taps
  // race: the count, the held check and the write share one transaction
  // under the person's advisory lock (pre-push P1 on 1aaeaa36ab).
  return knex.transaction((trx) => writeSuggestion(trx, phrase, { actorId, scheduledServiceId }));
}

async function writeSuggestion(trx, phrase, { actorId, scheduledServiceId }) {
  if (actorId) await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`report-blog-suggestion:${actorId}`]);
  // A topic held already writes nothing, so it answers already_queued even
  // past the day's cap (GitHub Codex P2 on 45144528b8).
  const held = await trx('opportunity_queue')
    .where({ action_type: 'new_supporting_blog' })
    .whereRaw('lower(query) = ?', [phrase])
    .whereIn('status', HELD_STATUSES)
    .first('id');
  if (held) return { status: 'already_queued' };
  if (actorId) {
    const sent = await trx('opportunity_queue')
      .whereRaw("signal_metadata->>'source' = ?", [SOURCE])
      .whereRaw("signal_metadata->>'suggested_by' = ?", [String(actorId)])
      .whereRaw("mined_at > now() - interval '1 day'")
      .count('* as n')
      .first();
    if (Number(sent?.n) >= MAX_PER_DAY) return { error: 'too_many_suggestions' };
  }
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
