/**
 * Lawn report v6 copy (lawn report rebuild P14, GATE_LAWN_REPORT_COPY_V6).
 *
 * FIXED SENTENCES, no model (owner ruling 2026-10-02, #5604 Codex r1: word
 * checks cannot stop a model claiming a feed on an insect-only visit). Every
 * field is built from this visit's facts by a fixed pattern, so it is true by
 * construction:
 *
 *   field        source
 *   headline     snapshot.statusHeadline (the lawn's status and its top issue)
 *   whatWeDid    buildTreatmentSummary over the recorded products, with no
 *                timing clause (never the AI treatment narrative that later
 *                overwrites the snapshot's copy)
 *   whatToExpect owner-approved expectation rows matched to today's products,
 *                each row's visible-change sentence and, when the gap to the next
 *                lawn visit AT THIS PROPERTY is known, its by-next-visit sentence,
 *                printed word for word (at most 2 rows, 42 words). The gap comes
 *                from the same visit the report's "Next visit" line shows
 *                (report-data lawnNextVisitAtProperty), so they never disagree.
 *   watching     "We are also keeping an eye on <topics>." for the watched issues
 *                the headline does not already name
 *
 * Rows with approved:false are never used (the engine withholds them), so with
 * today's table whatToExpect is always null.
 *
 * Persistence: the fields FREEZE into
 * service_records.structured_notes.lawnCopyV6[assessmentId], first writer wins
 * per key, exactly like lawnWeekWeather / lawnVisitMemory (one atomic two-level
 * jsonb merge, the key's absence in the UPDATE predicate, a lost race adopts
 * the winner, a failure only marks the render uncacheable). A frozen entry
 * replays byte for byte, so a later product edit or row approval never changes
 * a sent report. A degraded read (any input read failed) creates no freeze.
 */

const logger = require('../logger');
const { buildTreatmentSummary } = require('./treatment-summary');
const { buildLawnExpectations } = require('./lawn-expectations');
const { CELSIUS_YTD_CAP } = require('../../config/lawn-expectations');

const COPY_VERSION = 'lawn_report_v6_fixed_1';
const FREEZE_KEY = 'lawnCopyV6';
const FREEZE_VERSION = 1;

const FIELD_CAPS = { whatToExpect: 42 };
const MAX_EXPECT_ROWS = 2;
const EXPECT_SENTENCE_KEYS = ['visibleChange', 'byNextVisit'];
const FIELD_NAMES = ['headline', 'whatWeDid', 'whatToExpect', 'watching'];
const MAX_WATCH_TOPICS = 3;

// The watched-issue topics, worded as the snapshot headline words them
// (lawn-report-v2.js ISSUE_TOPIC), so "watching" never names an area the
// headline would call something else.
const WATCH_TOPIC = {
  water: 'watering', weeds: 'weed pressure', damage: 'a few stress areas',
  coverage: 'thin areas', mowing: 'mowing height', customer_concern: 'what you flagged',
};

function countWords(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  return t ? t.split(/\s+/).length : 0;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

const emptyFields = () => ({ headline: null, whatWeDid: null, whatToExpect: null, watching: null });
const clean = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

function productsOf(reportV2) {
  const list = reportV2 && reportV2.treatment && Array.isArray(reportV2.treatment.products) ? reportV2.treatment.products : [];
  return list.filter((p) => p && p.name);
}

// Watched issues in the order the report ranks them (priority, then position).
function watchedIssues(reportV2) {
  const insights = Array.isArray(reportV2 && reportV2.insights) ? reportV2.insights : [];
  return insights
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => card && (card.status === 'needs_attention' || card.status === 'watch'))
    .sort((a, b) => (Number(a.card.priority) || a.index + 1) - (Number(b.card.priority) || b.index + 1))
    .map(({ card }) => card);
}

function joinTopics(topics) {
  if (topics.length <= 1) return topics[0] || '';
  return `${topics.slice(0, -1).join(', ')} and ${topics[topics.length - 1]}`;
}

// The topics after the first (the headline already names the top issue).
function buildWatching(reportV2) {
  const topics = [];
  for (const card of watchedIssues(reportV2).slice(1)) {
    const topic = WATCH_TOPIC[card.category];
    if (topic && !topics.includes(topic)) topics.push(topic);
  }
  if (!topics.length) return null;
  return `We are also keeping an eye on ${joinTopics(topics.slice(0, MAX_WATCH_TOPICS))}.`;
}

// Approved rows for today's products, in the engine's order; each row's own
// visible-change sentence, then its by-next-visit sentence (the engine only
// materializes one when the gap is known or the row is judged by absence),
// printed word for word. A sentence that would pass the cap is skipped whole.
function buildWhatToExpect(reportV2, ctx, deps) {
  const products = productsOf(reportV2);
  if (!products.length) return { text: null, rows: [], sentences: [] };
  const build = deps.buildExpectations || buildLawnExpectations;
  const built = build({
    applications: products.map((p) => ({ name: p.name, targets: Array.isArray(p.targets) ? p.targets : [] })),
    issues: [],
    visitDate: ctx.visitDate || null,
    nextVisitGapDays: Number.isFinite(ctx.nextVisitGapDays) ? ctx.nextVisitGapDays : undefined,
    // Not tracked for the report yet: the cap makes a Celsius row print its
    // "a different product may be used" line, true either way, rather than
    // promise a second application that may be capped.
    celsiusYtdCount: CELSIUS_YTD_CAP,
  });
  const rows = (Array.isArray(built && built.rows) ? built.rows : [])
    .filter((row) => row && row.approved === true && typeof row.id === 'string' && Array.isArray(row.sentences));
  const visitKnown = Number.isFinite(ctx.nextVisitGapDays);
  const pieces = [];
  const picked = [];
  // Each printed sentence, in order, with whether it was timed from the gap to
  // the next visit (a row judged by absence words its line without one).
  const sentences = [];
  let words = 0;
  for (const row of rows) {
    if (picked.length >= MAX_EXPECT_ROWS) break;
    const keys = [];
    for (const key of EXPECT_SENTENCE_KEYS) {
      // "By your next visit..." needs a visit the report shows: with no known
      // gap there is none, even for a row whose line is not timed by it.
      if (key === 'byNextVisit' && !visitKnown) continue;
      const sentence = row.sentences.find((s) => s && s.key === key && clean(s.text));
      if (!sentence) continue;
      const w = countWords(sentence.text);
      if (words + w > FIELD_CAPS.whatToExpect) continue;
      words += w;
      pieces.push(sentence.text.trim());
      keys.push(key);
      sentences.push({
        key, text: sentence.text.trim(), needsVisit: key === 'byNextVisit', gapBased: key === 'byNextVisit' && !row.judgedByAbsence,
      });
    }
    if (keys.length) picked.push({ id: row.id, keys });
  }
  return { text: pieces.length ? pieces.join(' ') : null, rows: picked, sentences };
}

/**
 * The v6 fields for one visit, from its facts alone.
 *
 * @param {object} reportV2 the deterministic lawn reportV2 (snapshot, treatment, insights)
 * @param {object} ctx { visitDate, nextVisitGapDays }
 * @param {object} deps { buildExpectations? } injectable for tests
 * @returns {{ fields: {headline, whatWeDid, whatToExpect, watching}, expectRows: Array<{id, keys}> }}
 */
function buildLawnCopyV6(reportV2, ctx = {}, deps = {}) {
  const fields = emptyFields();
  if (!reportV2 || typeof reportV2 !== 'object') return { fields, expectRows: [], expectSentences: [] };
  fields.headline = clean(reportV2.snapshot && reportV2.snapshot.statusHeadline);
  fields.whatWeDid = clean(buildTreatmentSummary(reportV2.treatment, { noTiming: true }));
  fields.watching = buildWatching(reportV2);
  let expectRows = [];
  let expectSentences = [];
  try {
    const expect = buildWhatToExpect(reportV2, ctx, deps);
    fields.whatToExpect = expect.text;
    expectRows = expect.rows;
    expectSentences = expect.sentences;
  } catch (err) {
    logger.warn(`[lawn-copy-v6] expectations failed: ${err.message}`);
  }
  return { fields, expectRows, expectSentences };
}

// ── Freeze (first writer wins, per assessment) ─────────────────────────────
function cleanFields(fields) {
  const src = fields && typeof fields === 'object' ? fields : {};
  const out = emptyFields();
  for (const f of FIELD_NAMES) out[f] = clean(src[f]);
  return out;
}

// "What to expect" with every by-next-visit sentence left out: what a cached
// PDF / static render prints. Those renders never carry live schedule fields
// (report-data stripLiveOnlyScheduleFields drops the "Next visit" line too),
// so a reschedule can never leave a stale sentence in a stored document.
function staticWhatToExpect(sentences, fallback) {
  if (!Array.isArray(sentences)) return fallback || null;
  const kept = sentences.filter((s) => s && !s.needsVisit && !s.gapBased && clean(s.text)).map((s) => s.text.trim());
  return kept.length ? kept.join(' ') : null;
}

// A frozen entry's fields for THIS render. Everything replays as frozen except
// the by-next-visit sentences, which follow the visit the report now shows:
// one TIMED from the gap is left out when that visit is on another day (a
// reschedule), and every one is left out when the report shows no next visit
// at all. Never re-chosen: the rest of the frozen copy stands.
// `whatToExpectStatic` rides along for non-live renders (staticWhatToExpect).
function replayFields(entry, ctx = {}) {
  const fields = cleanFields(entry.fields);
  const sentences = Array.isArray(entry.expectSentences) ? entry.expectSentences : null;
  const whatToExpectStatic = staticWhatToExpect(sentences, fields.whatToExpect);
  if (!sentences) return { ...fields, whatToExpectStatic };
  const shownIso = ctx.nextVisitIso || null;
  const moved = (entry.nextVisitIso || null) !== shownIso;
  const dropped = (s) => (s.gapBased && moved) || ((s.needsVisit || s.gapBased) && !shownIso);
  if (!sentences.some((s) => s && dropped(s))) return { ...fields, whatToExpectStatic };
  const kept = sentences.filter((s) => s && !dropped(s) && clean(s.text)).map((s) => s.text.trim());
  return { ...fields, whatToExpect: kept.length ? kept.join(' ') : null, whatToExpectStatic };
}

/** One assessment's frozen entry out of a record's structured_notes, or null. */
function storedLawnCopyV6For(structuredNotes, assessmentId) {
  if (!assessmentId) return null;
  const map = parseJsonObject(structuredNotes)[FREEZE_KEY];
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const entry = map[assessmentId];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  // An entry replays only for the assessment it was frozen for, in a shape this
  // code version understands (a later COPY_VERSION never invalidates it).
  if (entry.v !== FREEZE_VERSION || String(entry.assessmentId) !== String(assessmentId)) return null;
  if (!entry.fields || typeof entry.fields !== 'object') return null;
  return entry;
}

/**
 * Freeze this visit's entry. Copies freezeLawnVisitMemory exactly:
 * structured_notes.lawnCopyV6 is a MAP keyed by assessment id (A -> B -> A must
 * never destroy another assessment's entry); one atomic two-level jsonb merge;
 * first writer wins PER KEY with the guard (the key's absence) in the UPDATE
 * predicate and no preceding read; a lost race adopts the winner's entry.
 * Returns the entry the record is now frozen to, or null on failure.
 */
async function freezeLawnCopyV6(serviceRecordId, entry, knex) {
  if (!serviceRecordId || !entry || !entry.assessmentId || !knex) return null;
  const { assessmentId } = entry;
  try {
    const updated = await knex('service_records')
      .where({ id: serviceRecordId })
      .whereRaw(
        `COALESCE(structured_notes::jsonb, '{}'::jsonb) -> '${FREEZE_KEY}' -> ? IS NULL`,
        [assessmentId],
      )
      .update({
        structured_notes: knex.raw(
          `COALESCE(structured_notes::jsonb, '{}'::jsonb) || jsonb_build_object('${FREEZE_KEY}',`
          + ` COALESCE(COALESCE(structured_notes::jsonb, '{}'::jsonb) -> '${FREEZE_KEY}', '{}'::jsonb) || ?::jsonb)`,
          [JSON.stringify({ [assessmentId]: entry })],
        ),
      });
    if (updated > 0) return entry;

    // Lost the race for THIS key (or it was already frozen): adopt the winner.
    const row = await knex('service_records')
      .where({ id: serviceRecordId })
      .first('structured_notes');
    return storedLawnCopyV6For(row && row.structured_notes, assessmentId);
  } catch (err) {
    logger.warn(`[lawn-copy-v6] freeze failed for ${serviceRecordId}: ${err.message}`);
    return null;
  }
}

/**
 * The render-time orchestration: replay this visit's frozen entry if there is
 * one; otherwise (healthy read only) build the fields and freeze them, first
 * writer wins.
 *
 * Returns { copy, unfrozen }. `copy` is { headline, whatWeDid, whatToExpect,
 * watching, whatToExpectStatic } (each a string or null; the last is what a
 * non-live render prints) or null when there is nothing to carry.
 * `unfrozen` means this render is not reproducible (degraded read or the
 * freeze failed): the caller must not durably cache it.
 */
async function resolveLawnCopyV6ForRender({
  structuredNotes, serviceRecordId, assessmentId, reportV2, ctx = {}, degraded = false, knex, deps = {},
} = {}) {
  const stored = storedLawnCopyV6For(structuredNotes, assessmentId);
  if (stored) return { copy: replayFields(stored, ctx), unfrozen: false };
  if (!assessmentId || !serviceRecordId || !knex) return { copy: null, unfrozen: true };
  // A freeze may only be CREATED from a complete, healthy read (first writer
  // wins: a degraded entry could never be repaired).
  if (degraded) return { copy: null, unfrozen: true };

  const built = buildLawnCopyV6(reportV2, ctx, deps);
  const entry = {
    v: FREEZE_VERSION,
    copyVersion: COPY_VERSION,
    assessmentId: String(assessmentId),
    frozenAt: (deps.now ? deps.now() : new Date()).toISOString(),
    fields: built.fields,
    expectRows: built.expectRows,
    // What the by-next-visit sentences were timed for (replayFields).
    expectSentences: built.expectSentences,
    nextVisitIso: ctx.nextVisitIso || null,
  };
  const frozen = await freezeLawnCopyV6(serviceRecordId, entry, knex);
  if (!frozen) return { copy: replayFields(entry, ctx), unfrozen: true };
  return { copy: replayFields(frozen, ctx), unfrozen: false };
}

module.exports = {
  COPY_VERSION,
  FREEZE_KEY,
  FREEZE_VERSION,
  FIELD_CAPS,
  buildLawnCopyV6,
  resolveLawnCopyV6ForRender,
  storedLawnCopyV6For,
  freezeLawnCopyV6,
  _test: { buildWatching, buildWhatToExpect, watchedIssues, WATCH_TOPIC },
};
