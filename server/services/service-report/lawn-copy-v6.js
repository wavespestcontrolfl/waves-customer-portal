/**
 * Lawn report v6 copy writer (lawn report rebuild P14, GATE_LAWN_REPORT_COPY_V6).
 *
 * STRUCTURAL, not a bigger regex (owner ruling 2026-10-01): expectation and
 * timing content reaches a customer ONLY by selecting approved expectation-row
 * sentences by id; the model never writes a number, a window or a date. What
 * the model does write is three short free-text fields under hard limits, and
 * any doubt about any of them falls back to the deterministic sentence the
 * lead uses today (or to null).
 *
 *   field        source                                   guard                                  fallback
 *   headline     model free text, cap 8                   free-text stack (below)                null -> lead uses snapshot.statusHeadline
 *   whatWeDid    model free text, cap 32, needs products  free-text stack                        null -> lead uses snapshot.treatmentSummary
 *   whatToExpect SELECTION of approved rows (ids + keys)  unknown/unapproved ids dropped,        null (nothing printed)
 *                printed verbatim by the server, cap 42   sentence-level cap, checkLawnModelCopy
 *                                                         over the printed text
 *   watching     model free text, cap 20, needs an issue  free-text stack                        null
 *
 * Free-text stack, in order: plain text only, word cap (never truncated), no
 * digit, lead WATERING_WORDS, findBannedCustomerCopy, P11 checkLawnModelCopy
 * (timing, numbers, water/mow, weekday/clock, progress coupling, re-entry,
 * overpromise, safety), no brand / product / ingredient name, no named cause
 * (namesUnpublishedCause with no published causes), and the caller's own
 * contradiction guard (report-data's treatment guard). P11 stays the second
 * layer; the selection design is the first.
 *
 * Rows with approved:false are never offered to the model (the engine withholds
 * them), so with today's table whatToExpect is always null.
 *
 * Persistence: the final fields FREEZE into
 * service_records.structured_notes.lawnCopyV6[assessmentId], first writer wins
 * per key, exactly like lawnWeekWeather / lawnVisitMemory (one atomic two-level
 * jsonb merge, the key's absence in the UPDATE predicate, a lost race adopts
 * the winner, a failure only marks the render uncacheable). A frozen entry
 * replays byte for byte and never calls the model. A degraded read (any input
 * read failed) neither calls the model nor creates a freeze; a model that was
 * unavailable creates none either, so the next render can retry.
 *
 * The model is the existing customer-copy tier through dispatchWithFallback
 * (config/models.js; no model ids here). The structured-output schema carries
 * no numeric bounds (Anthropic rejects minimum / maximum / minItems); counts
 * and caps are enforced in code.
 */

const crypto = require('crypto');
const MODELS = require('../../config/models');
const logger = require('../logger');
const { HUMAN_PROSE_RULES } = require('../llm/human-prose-rules');
const { dispatchWithFallback } = require('../llm/call');
const { findBannedCustomerCopy } = require('./activity-indicators');
const { checkLawnModelCopy } = require('./lawn-copy-guards');
const { WATERING_WORDS } = require('./lawn-report-lead');
const { LAWN_COPY_CORE, LAWN_V6_FIELDS_ADAPTER } = require('./lawn-report-copy-prompt');
const { buildLawnExpectations } = require('./lawn-expectations');
const { CELSIUS_YTD_CAP, PRODUCT_CLASS } = require('../../config/lawn-expectations');

const PROMPT_VERSION = 'lawn_report_v6_structural_1';
const FREEZE_KEY = 'lawnCopyV6';
const FREEZE_VERSION = 1;

// Visible-word caps (SCOPE section 3) and the model's total.
const FIELD_CAPS = { headline: 8, whatWeDid: 32, whatToExpect: 42, watching: 20 };
const MODEL_WORDS_TOTAL_CAP = 128;
// When the total would ever run over, fields are given up in this order.
const TOTAL_DROP_ORDER = ['watching', 'whatToExpect', 'whatWeDid', 'headline'];
const MAX_EXPECT_ROWS = 2;
const DEFAULT_SENTENCE_KEYS = ['visibleChange', 'byNextVisit'];
const FIELD_NAMES = ['headline', 'whatWeDid', 'whatToExpect', 'watching'];

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const MODEL_TIMEOUT_MS = 25000;
const _cache = new Map();

const SYSTEM_PROMPT = `# LAWN REPORT V6 (STRUCTURAL WRITER)

${HUMAN_PROSE_RULES}

${LAWN_COPY_CORE}

${LAWN_V6_FIELDS_ADAPTER}`;

const KIND_ROLE = {
  herbicide: 'selective weed control',
  pre_emergent: 'weed prevention before weeds sprout',
  insecticide: 'insect control',
  fungicide: 'turf disease protection',
  supplement: 'color and micronutrient support',
  fertilizer: 'feeding to support color and density',
};

// ── Small helpers ──────────────────────────────────────────────────────────
function countWords(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  return t ? t.split(/\s+/).length : 0;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

const emptyFields = () => ({ headline: null, whatWeDid: null, whatToExpect: null, watching: null });

// ── Brand / product / ingredient names the model must never print ──────────
// Full product names (today's and every mapped catalog name) plus each name's
// first word when it is a distinctive 5+ letters; ingredient words only when
// they are not plain nutrient words ("iron", "potassium" stay usable).
const GENERIC_FIRST_WORDS = new Set(['chelated', 'high', 'plant', 'liquid', 'granular', 'selective']);
const NUTRIENT_WORDS = new Set(['iron', 'potassium', 'nitrogen', 'magnesium', 'manganese', 'sulfur', 'sulphur', 'calcium', 'zinc', 'potash', 'ferrous']);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function brandRegex(products) {
  const terms = new Set();
  const addName = (raw) => {
    const name = String(raw || '').toLowerCase().replace(/[^a-z0-9+&' -]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name) return;
    if (name.length >= 4 && !/\d/.test(name)) terms.add(name);
    const first = name.split(/[\s(]/)[0].replace(/[^a-z-]/g, '');
    if (first.length >= 5 && !GENERIC_FIRST_WORDS.has(first)) terms.add(first);
  };
  for (const p of products) {
    addName(p && p.name);
    for (const token of String((p && p.activeIngredient) || '').toLowerCase().split(/[^a-z]+/)) {
      if (token.length >= 6 && !NUTRIENT_WORDS.has(token)) terms.add(token);
    }
  }
  for (const key of PRODUCT_CLASS.keys()) addName(key);
  if (!terms.size) return null;
  return new RegExp(`(?<![a-z0-9])(?:${[...terms].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![a-z0-9])`, 'i');
}

// ── Facts ──────────────────────────────────────────────────────────────────
function productsOf(reportV2) {
  const list = reportV2 && reportV2.treatment && Array.isArray(reportV2.treatment.products) ? reportV2.treatment.products : [];
  return list.filter((p) => p && p.name);
}

function issuesOf(reportV2) {
  const insights = Array.isArray(reportV2 && reportV2.insights) ? reportV2.insights : [];
  return insights
    .filter((i) => i && (i.status === 'needs_attention' || i.status === 'watch'))
    .map((i, index) => ({ category: String(i.category || 'lawn'), status: i.status, priority: Number(i.priority) || index + 1 }))
    .sort((a, b) => a.priority - b.priority);
}

// The approved rows the model may choose from. The engine withholds every row
// with approved:false, so an unapproved row is structurally unreachable here;
// the explicit filter below is belt and braces against an engine change.
// celsiusYtdCount is not tracked for the report yet: reporting the cap makes a
// Celsius row print its "a different product may be used" line, which is true
// either way, rather than promise a second application that may be capped.
function approvedRowsFor(reportV2, ctx, deps) {
  const products = productsOf(reportV2);
  if (!products.length) return [];
  const build = deps.buildExpectations || buildLawnExpectations;
  const built = build({
    applications: products.map((p) => ({ name: p.name, targets: Array.isArray(p.targets) ? p.targets : [] })),
    issues: [],
    visitDate: ctx.visitDate || null,
    nextVisitGapDays: Number.isFinite(ctx.nextVisitGapDays) ? ctx.nextVisitGapDays : undefined,
    celsiusYtdCount: CELSIUS_YTD_CAP,
  });
  const rows = Array.isArray(built && built.rows) ? built.rows : [];
  return rows
    .filter((row) => row && row.approved === true && typeof row.id === 'string' && Array.isArray(row.sentences))
    .map((row) => ({
      id: row.id,
      appliesTo: row.appliesTo || null,
      sentences: row.sentences.filter((s) => s && typeof s.key === 'string' && typeof s.text === 'string' && s.text.trim()),
    }))
    .filter((row) => row.sentences.length);
}

function buildFacts(reportV2, ctx, approvedRows) {
  const products = productsOf(reportV2);
  const issues = issuesOf(reportV2);
  // The since-last lane's lines: reportV2.lead.sinceLast (the lead, when it is
  // already derived) or its non-enumerable hand-off reportV2.sinceLastCopy
  // (report-data.js); both are { priorDate, lines }.
  const sinceBlock = (reportV2 && reportV2.lead && reportV2.lead.sinceLast) || (reportV2 && reportV2.sinceLastCopy) || null;
  const sinceLines = sinceBlock && Array.isArray(sinceBlock.lines)
    ? sinceBlock.lines.filter((l) => typeof l === 'string' && l.trim())
    : [];
  return {
    promptVersion: PROMPT_VERSION,
    grass: ctx.grassLabel || 'lawn',
    overall: { status: (reportV2 && reportV2.snapshot && reportV2.snapshot.status) || null },
    categories: (Array.isArray(reportV2 && reportV2.diagnosis) ? reportV2.diagnosis : []).map((d) => ({ label: d.label, status: d.status })),
    products: products.map((p) => ({
      role: KIND_ROLE[p.kind] || 'lawn treatment',
      how: p.method || null,
      tags: Array.isArray(p.targets) ? p.targets.slice(0, 3) : [],
    })),
    issuesExist: issues.length > 0,
    issues,
    // Another lane's "since last visit" lines (when present) are already on the
    // page: the model only learns not to repeat them.
    ...(sinceLines.length ? { doNotRestate: sinceLines } : {}),
    approvedExpectationRows: approvedRows.map((row) => ({ id: row.id, appliesTo: row.appliesTo, sentences: row.sentences })),
  };
}

function buildSchema(approvedRows) {
  const properties = {
    headline: { type: 'string' },
    whatWeDid: { type: 'string' },
    watching: { type: 'string' },
  };
  const required = ['headline', 'whatWeDid', 'watching'];
  if (approvedRows.length) {
    const keys = [...new Set(approvedRows.flatMap((row) => row.sentences.map((s) => s.key)))];
    properties.expectRows = {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'sentences'],
        properties: {
          id: { type: 'string', enum: approvedRows.map((row) => row.id) },
          sentences: { type: 'array', items: { type: 'string', enum: keys } },
        },
      },
    };
    required.push('expectRows');
  }
  return { type: 'object', additionalProperties: false, required, properties };
}

function buildUserMessage(facts) {
  return `FACTS for this visit. Write only the fields the schema names, inside the vocabulary limits.\n\n${JSON.stringify(facts, null, 2)}`;
}

// ── Guards ─────────────────────────────────────────────────────────────────
// A cause or species named with no published cause supplied: reject any
// governed term. Required lazily (it pulls the diagnostic report module); if
// it cannot load, that is guard doubt and the field falls back.
function namesAnyCause(text) {
  try {
    return require('../lawn-visit-customer-copy').namesUnpublishedCause(text, []);
  } catch {
    return true;
  }
}

const NOT_PLAIN_TEXT = /[<>{}[\]*_#`|\\"]|https?:|www\.|@|—/;

function p11Facts(ctx) {
  const progress = ctx.progress && typeof ctx.progress === 'object' ? ctx.progress : null;
  return {
    progress: progress && progress.overall && typeof progress.overall.direction === 'string' ? progress.overall.direction : 'unknown',
    progressStates: Array.isArray(progress && progress.items) ? progress.items.map((i) => i && i.state).filter(Boolean) : [],
    droughtFlagged: false,
    approvedSentences: [],
  };
}

function guardFreeText(raw, field, g) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (NOT_PLAIN_TEXT.test(text)) return null;
  if (countWords(text) > FIELD_CAPS[field]) return null;
  if (/\d/.test(text)) return null;
  if (WATERING_WORDS.test(text)) return null;
  if (findBannedCustomerCopy(text).length) return null;
  if (!checkLawnModelCopy(text, g.facts).ok) return null;
  if (g.brandRe && g.brandRe.test(text)) return null;
  if (namesAnyCause(text)) return null;
  if (typeof g.extraGuard === 'function' && g.extraGuard(text)) return null;
  return text;
}

// SELECTION: ids (and optional sentence keys) the model picked, rendered from
// the approved rows verbatim. Unknown, unapproved or duplicate ids are dropped
// and so are unknown keys; a sentence that would pass the cap is skipped whole,
// never cut. Returns { text, picks } or null.
function renderExpectations(selection, approvedRows, g = {}) {
  if (!Array.isArray(selection) || !approvedRows.length) return null;
  const byId = new Map(approvedRows.map((row) => [row.id, row]));
  const seen = new Set();
  const picks = [];
  const pieces = [];
  let words = 0;
  for (const raw of selection) {
    if (picks.length >= MAX_EXPECT_ROWS) break;
    const id = raw && typeof raw.id === 'string' ? raw.id.trim() : '';
    const row = byId.get(id);
    if (!row || seen.has(id)) continue;
    seen.add(id);
    const wanted = new Set(Array.isArray(raw.sentences) ? raw.sentences.filter((k) => typeof k === 'string') : []);
    let chosen = row.sentences.filter((s) => wanted.has(s.key));
    if (!chosen.length) chosen = row.sentences.filter((s) => DEFAULT_SENTENCE_KEYS.includes(s.key));
    if (!chosen.length) chosen = row.sentences.slice(0, 1);
    const keys = [];
    for (const sentence of chosen) {
      const w = countWords(sentence.text);
      if (words + w > FIELD_CAPS.whatToExpect) continue;
      // Second layer, sentence by sentence: approved text is exempt from the
      // timing / number / progress rules only; water, weekday, re-entry,
      // sub-day, banned and overpromise rules still read it. A sentence that
      // trips one is left out whole (P11's sub-day rule also reads "second
      // application"), never reworded; the row's other sentences stand alone.
      if (!approvedSentenceAllowed(sentence.text, g)) continue;
      words += w;
      pieces.push(sentence.text.trim());
      keys.push(sentence.key);
    }
    if (keys.length) picks.push({ id, keys });
  }
  if (!pieces.length) return null;
  const text = pieces.join(' ');
  // ... and once more over the PRINTED text as a whole.
  if (!approvedSentenceAllowed(text, g)) return null;
  return { text, picks };
}

function approvedSentenceAllowed(text, g = {}) {
  const approvedSentences = [text, ...text.split(/(?<=[.!?])\s+/)];
  if (findBannedCustomerCopy(text).length) return false;
  return checkLawnModelCopy(text, { ...(g.facts || {}), approvedSentences }).ok;
}

function applyTotalCap(fields) {
  const out = { ...fields };
  const total = () => FIELD_NAMES.reduce((sum, f) => sum + countWords(out[f]), 0);
  for (const field of TOTAL_DROP_ORDER) {
    if (total() <= MODEL_WORDS_TOTAL_CAP) break;
    out[field] = null;
  }
  return out;
}

// ── Model call ─────────────────────────────────────────────────────────────
function defaultCallModel(payload) {
  return dispatchWithFallback(
    MODELS.TEXT_POLICIES.customerCopy,
    {
      laneId: 'lawn_visit_narratives', jsonMode: true, maxTokens: 700, timeoutMs: MODEL_TIMEOUT_MS, promptVersion: PROMPT_VERSION, ...payload,
    },
  );
}

async function modelJson(facts, approvedRows, deps) {
  const cacheKey = crypto.createHash('sha256').update(`${PROMPT_VERSION}|${stableStringify(facts)}`).digest('hex');
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.at < (hit.json ? CACHE_TTL_MS : FAILURE_TTL_MS)) return hit.json;
  const callModel = deps.callModel || defaultCallModel;
  let json = null;
  try {
    const res = await callModel({ system: SYSTEM_PROMPT, text: buildUserMessage(facts), jsonSchema: buildSchema(approvedRows) });
    if (res && res.ok && res.json && typeof res.json === 'object' && !Array.isArray(res.json)) json = res.json;
    else logger.warn(`[lawn-copy-v6] model miss (${res && res.reason}); using deterministic copy`);
  } catch (err) {
    logger.warn(`[lawn-copy-v6] model failed: ${err.message}; using deterministic copy`);
  }
  _cache.set(cacheKey, { at: Date.now(), json });
  if (_cache.size > 300) _cache.delete(_cache.keys().next().value);
  return json;
}

/**
 * Write the v6 fields for one visit.
 *
 * @param {object} reportV2 the deterministic lawn reportV2 (treatment, insights, diagnosis, snapshot)
 * @param {object} ctx { grassLabel, visitDate, nextVisitGapDays, progress, extraGuard }
 * @param {object} deps { callModel?, buildExpectations? } injectable for tests
 * @returns {Promise<{ fields: {headline, whatWeDid, whatToExpect, watching},
 *   expectRows: Array<{id, keys}>, modelOk: boolean }>}
 *   `modelOk` is false when the model was unavailable (all fields null, nothing to freeze).
 */
async function writeLawnCopyV6(reportV2, ctx = {}, deps = {}) {
  const empty = { fields: emptyFields(), expectRows: [], modelOk: false };
  if (!reportV2 || typeof reportV2 !== 'object') return empty;
  let approvedRows = [];
  try { approvedRows = approvedRowsFor(reportV2, ctx, deps); } catch { approvedRows = []; }
  const facts = buildFacts(reportV2, ctx, approvedRows);
  const json = await modelJson(facts, approvedRows, deps);
  if (!json) return empty;

  const g = {
    facts: p11Facts(ctx),
    brandRe: brandRegex(productsOf(reportV2)),
    extraGuard: ctx.extraGuard,
  };
  const fields = emptyFields();
  fields.headline = guardFreeText(json.headline, 'headline', g);
  if (facts.products.length) fields.whatWeDid = guardFreeText(json.whatWeDid, 'whatWeDid', g);
  if (facts.issuesExist) fields.watching = guardFreeText(json.watching, 'watching', g);
  const expect = renderExpectations(json.expectRows, approvedRows, g);
  let expectRows = [];
  if (expect && !(typeof g.extraGuard === 'function' && g.extraGuard(expect.text))) {
    fields.whatToExpect = expect.text;
    expectRows = expect.picks;
  }
  const capped = applyTotalCap(fields);
  if (!capped.whatToExpect) expectRows = [];
  return { fields: capped, expectRows, modelOk: true };
}

// ── Freeze (first writer wins, per assessment) ─────────────────────────────
function cleanFields(fields) {
  const src = fields && typeof fields === 'object' ? fields : {};
  const out = emptyFields();
  for (const f of FIELD_NAMES) {
    const v = src[f];
    out[f] = typeof v === 'string' && v.trim() ? v : null;
  }
  return out;
}

/** One assessment's frozen entry out of a record's structured_notes, or null. */
function storedLawnCopyV6For(structuredNotes, assessmentId) {
  if (!assessmentId) return null;
  const map = parseJsonObject(structuredNotes)[FREEZE_KEY];
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const entry = map[assessmentId];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  // An entry replays only for the assessment it was frozen for, in a shape this
  // code version understands (a later PROMPT_VERSION never invalidates it).
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
 * one; otherwise (healthy read only) write the fields and freeze them, first
 * writer wins.
 *
 * Returns { copy, unfrozen }. `copy` is { headline, whatWeDid, whatToExpect,
 * watching } (each a string or null) or null when there is nothing to carry.
 * `unfrozen` means this render is not reproducible (degraded read, model
 * unavailable, or the freeze failed): the caller must not durably cache it.
 */
async function resolveLawnCopyV6ForRender({
  structuredNotes, serviceRecordId, assessmentId, reportV2, ctx = {}, degraded = false, knex, deps = {},
} = {}) {
  const stored = storedLawnCopyV6For(structuredNotes, assessmentId);
  if (stored) return { copy: cleanFields(stored.fields), unfrozen: false };
  if (!assessmentId || !serviceRecordId || !knex) return { copy: null, unfrozen: true };
  // A freeze may only be CREATED from a complete, healthy read (first writer
  // wins: a degraded entry could never be repaired). Facts built from a failed
  // read could also be wrong, so the model is not asked either.
  if (degraded) return { copy: null, unfrozen: true };

  const written = await writeLawnCopyV6(reportV2, ctx, deps);
  // The model was unavailable: serve the deterministic copy and let the next
  // render retry rather than freezing "nothing" forever.
  if (!written.modelOk) return { copy: null, unfrozen: true };

  const entry = {
    v: FREEZE_VERSION,
    promptVersion: PROMPT_VERSION,
    assessmentId: String(assessmentId),
    frozenAt: (deps.now ? deps.now() : new Date()).toISOString(),
    fields: written.fields,
    expectRows: written.expectRows,
  };
  const frozen = await freezeLawnCopyV6(serviceRecordId, entry, knex);
  if (!frozen) return { copy: written.fields, unfrozen: true };
  return { copy: cleanFields(frozen.fields), unfrozen: false };
}

module.exports = {
  PROMPT_VERSION,
  FREEZE_KEY,
  FREEZE_VERSION,
  FIELD_CAPS,
  MODEL_WORDS_TOTAL_CAP,
  writeLawnCopyV6,
  resolveLawnCopyV6ForRender,
  storedLawnCopyV6For,
  freezeLawnCopyV6,
  // exported for tests
  _test: {
    buildFacts, buildSchema, buildUserMessage, renderExpectations, guardFreeText, brandRegex, approvedRowsFor, applyTotalCap, countWords, SYSTEM_PROMPT, p11Facts, _cache,
  },
};
