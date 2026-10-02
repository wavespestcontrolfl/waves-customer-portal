/**
 * Lawn treatment memory (lawn report rebuild P12, GATE_LAWN_VISIT_MEMORY).
 *
 * One "since last visit" store: structured_notes.lawnVisitMemory[assessmentId],
 * first writer wins, no migration. Each entry is what THIS visit applied and
 * what it said it would keep watching, frozen at the first render so a
 * permanent report token never changes and the NEXT visit has something
 * reproducible to read back (the progress engine reads it; the Fast Complete
 * recheck work writes into it later).
 *
 * The entry also carries this visit's own `sinceLast` block, built from the
 * PRIOR visit's frozen entry at the first render and replayed verbatim after,
 * so a later render never restates it when history moves underneath.
 *
 * Pure builders plus one DB function (the freezer, with the knex handle
 * injected). Nothing here reads the clock or the database otherwise.
 */
const logger = require('../logger');
const { isSupportProduct } = require('./treatment-summary');

const VISIT_MEMORY_VERSION = 1;
const MAX_APPLIED = 8;
const MAX_TARGETS = 3;
const MAX_CHECKS = 3;
const MAX_TEXT = 80;
// A product name is an IDENTITY (the expectations engine matches the exact
// catalog name), so it is never cut at MAX_TEXT: the longest lawn catalog
// names run past 100 characters.
const MAX_NAME = 200;

// classifyProduct's focus tag per kind (lawn-report-v2.js). Pinned against
// classifyProduct itself in the tests so the two cannot drift apart.
const TAG_BY_KIND = {
  fungicide: 'fungus protection',
  pre_emergent: 'weed prevention',
  herbicide: 'weed control',
  insecticide: 'pest control',
  supplement: 'color support',
  fertilizer: 'color & growth',
  other: 'lawn treatment',
};

// Insight categories that can become something we said we would watch. The
// customer's own concern is excluded (no objective signal to recheck it
// against) and so is 'overall' (it is the all-clear card).
const CHECK_CATEGORIES = ['water', 'weeds', 'damage', 'coverage', 'mowing'];
const CHECK_STATUSES = new Set(['watch', 'needs_attention']);

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Postgres jsonb stores object keys in its own order, so the same block read
// back from the record and the one just built in memory serialize differently.
// Everything the render hands out passes through here, so every render of a
// frozen visit is byte for byte the same whichever path produced it.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => { out[key] = canonical(value[key]); return out; }, {});
  }
  return value;
}

function ymd(value) {
  if (!value) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  const s = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

const text = (value, max = MAX_TEXT) => {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

/**
 * "What we applied", shaped exactly as it is frozen: support products dropped,
 * at most MAX_APPLIED products and MAX_TARGETS targets each. Shared with the
 * P13 calibration replay so it judges what production would have frozen.
 * @param {Array<{name, activeIngredient?, kind?, targets?}>} products
 */
function appliedFromProducts(products) {
  const applied = [];
  for (const p of Array.isArray(products) ? products : []) {
    if (!p || !text(p.name, MAX_NAME)) continue;
    // Surfactants, wetting agents and growth regulators make no treatment
    // claim; remembering them as "what we applied" would restate one.
    if (isSupportProduct(p)) continue;
    const kind = Object.prototype.hasOwnProperty.call(TAG_BY_KIND, p.kind) ? p.kind : 'other';
    applied.push({
      name: text(p.name, MAX_NAME),
      activeIngredient: text(p.activeIngredient),
      kind,
      tag: TAG_BY_KIND[kind],
      targets: (Array.isArray(p.targets) ? p.targets : []).map((t) => text(t)).filter(Boolean).slice(0, MAX_TARGETS),
    });
    if (applied.length >= MAX_APPLIED) break;
  }
  return applied;
}

/**
 * The entry for one visit, from the deterministic reportV2 (built BEFORE any
 * narrative overlay, so the frozen "what we said" is the engine's, not a
 * model's rewrite).
 * @returns {{v:1, assessmentId:string, serviceDate:string, applied:object[], checks:object[]}|null}
 */
function buildVisitMemory({ reportV2, assessmentId, serviceDate } = {}) {
  if (!reportV2 || typeof reportV2 !== 'object' || !assessmentId) return null;
  const date = ymd(serviceDate);
  if (!date) return null;

  const applied = appliedFromProducts(reportV2.treatment?.products);

  const insights = Array.isArray(reportV2.insights) ? reportV2.insights : [];
  const ranked = insights
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => card && CHECK_CATEGORIES.includes(card.category) && CHECK_STATUSES.has(card.status))
    .sort((a, b) => {
      const pa = Number.isFinite(Number(a.card.priority)) ? Number(a.card.priority) : Infinity;
      const pb = Number.isFinite(Number(b.card.priority)) ? Number(b.card.priority) : Infinity;
      return pa - pb || a.index - b.index;
    });
  const checks = [];
  const seen = new Set();
  for (const { card } of ranked) {
    // Several water cards can fire in one visit; remember the topic once.
    if (seen.has(card.category)) continue;
    seen.add(card.category);
    checks.push({ key: card.category, status: card.status });
    if (checks.length >= MAX_CHECKS) break;
  }

  // Named issues confirmed at this visit (keys the expectations engine knows,
  // e.g. large_patch, chinch): a fungicide or insecticide with no tagged target
  // is judged curative when the visit named its cause, so that evidence is
  // frozen with the application. reportV2.namedIssues is the slot the photo
  // read / tech confirmation PRs (P19, P27) fill; absent today, so the key is
  // omitted and existing frozen entries keep their exact shape.
  // Keys only (no expectations vocabulary here: that engine ships dark and
  // drops any key it does not know when it reads them).
  const issues = [...new Set((Array.isArray(reportV2.namedIssues) ? reportV2.namedIssues : [])
    .map((key) => text(String(key || '').toLowerCase()))
    .filter((key) => key && /^[a-z0-9_]+$/.test(key)))].sort().slice(0, MAX_CHECKS);
  return {
    v: VISIT_MEMORY_VERSION, assessmentId: String(assessmentId), serviceDate: date, applied, checks,
    ...(issues.length ? { issues } : {}),
  };
}

/**
 * Which earlier visit is "the last visit". Pure over the history rows the
 * report already resolved (property-scoped by lawn-assessment-history when
 * GATE_LAWN_PROPERTY_HISTORY is live, capped at this visit). Defense in depth
 * on top of that: only a row whose own date is STRICTLY before this visit's can
 * qualify, wherever it sits in the list, so a later-dated or same-day row is
 * never the prior; ties on date resolve to the later row in list order. A
 * current visit that is not in the rows (or has no date) has no prior.
 * @returns {{assessmentId:string, serviceRecordId:string, date:string}|null}
 */
function selectPriorVisit(historyRows, currentAssessmentId) {
  const rows = Array.isArray(historyRows) ? historyRows : [];
  if (!currentAssessmentId) return null;
  const current = rows.find((row) => row && String(row.id) === String(currentAssessmentId));
  const currentDate = ymd(current?.service_date);
  if (!currentDate) return null;
  let best = null;
  for (const row of rows) {
    if (!row || String(row.id) === String(currentAssessmentId)) continue;
    const date = ymd(row.service_date);
    const recordId = row.history_record_id || row.service_record_id || null;
    if (!date || date >= currentDate || !recordId) continue;
    if (!best || date >= best.date) best = { assessmentId: String(row.id), serviceRecordId: String(recordId), date };
  }
  return best;
}

/** One assessment's frozen entry out of a record's structured_notes, or null. */
function storedVisitMemoryFor(structuredNotes, assessmentId) {
  if (!assessmentId) return null;
  const map = parseJsonObject(structuredNotes).lawnVisitMemory;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const entry = map[assessmentId];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  // An entry replays only for the assessment it was frozen for, and only in a
  // shape this code version understands.
  if (entry.v !== VISIT_MEMORY_VERSION || String(entry.assessmentId) !== String(assessmentId)) return null;
  return entry;
}

/**
 * "Since last visit" from the PRIOR visit's frozen entry. Data only: what we
 * applied then and what we said we would watch. State words (clear / still
 * watching) come from the progress engine and are not decided here.
 * @returns {object|null} null when there is no prior or it recorded nothing
 */
function buildSinceLast({ priorVisit, priorMemory } = {}) {
  if (!priorVisit || !priorMemory || typeof priorMemory !== 'object') return null;
  if (priorMemory.v !== VISIT_MEMORY_VERSION) return null;
  if (String(priorMemory.assessmentId) !== String(priorVisit.assessmentId)) return null;
  const applied = Array.isArray(priorMemory.applied) ? priorMemory.applied : [];
  const checks = Array.isArray(priorMemory.checks) ? priorMemory.checks : [];
  if (!applied.length && !checks.length) return null;
  return {
    v: VISIT_MEMORY_VERSION,
    priorAssessmentId: String(priorVisit.assessmentId),
    priorDate: ymd(priorMemory.serviceDate) || ymd(priorVisit.date) || null,
    applied,
    checks,
    ...(Array.isArray(priorMemory.issues) && priorMemory.issues.length ? { issues: priorMemory.issues } : {}),
  };
}

/**
 * Freeze this visit's entry. Copies the lawnWeekWeather freeze exactly:
 * structured_notes.lawnVisitMemory is a MAP keyed by assessment id (A → B → A
 * must never destroy another assessment's entry); one atomic two-level jsonb
 * merge; first writer wins PER KEY with the guard (the key's absence) in the
 * UPDATE predicate and no preceding read; a lost race adopts the winner's
 * entry. Returns the entry the record is now frozen to, or null on failure
 * (the caller marks the render uncacheable).
 */
async function freezeLawnVisitMemory(serviceRecordId, entry, knex) {
  if (!serviceRecordId || !entry || !entry.assessmentId || !knex) return null;
  const { assessmentId } = entry;
  try {
    const updated = await knex('service_records')
      .where({ id: serviceRecordId })
      .whereRaw(
        "COALESCE(structured_notes::jsonb, '{}'::jsonb) -> 'lawnVisitMemory' -> ? IS NULL",
        [assessmentId],
      )
      .update({
        structured_notes: knex.raw(
          "COALESCE(structured_notes::jsonb, '{}'::jsonb) || jsonb_build_object('lawnVisitMemory',"
          + " COALESCE(COALESCE(structured_notes::jsonb, '{}'::jsonb) -> 'lawnVisitMemory', '{}'::jsonb) || ?::jsonb)",
          [JSON.stringify({ [assessmentId]: entry })],
        ),
      });
    if (updated > 0) return entry;

    // Lost the race for THIS key (or it was already frozen): adopt the winner.
    const row = await knex('service_records')
      .where({ id: serviceRecordId })
      .first('structured_notes');
    return storedVisitMemoryFor(row?.structured_notes, assessmentId);
  } catch (err) {
    logger.warn(`[lawn-visit-memory] freeze failed for ${serviceRecordId}: ${err.message}`);
    return null;
  }
}

/**
 * The render-time orchestration: replay this visit's frozen entry if there is
 * one, otherwise build it (and its sinceLast from the prior visit's frozen
 * entry) and freeze it, first writer wins.
 *
 * Prior fallback: when the prior visit has NO frozen entry, sinceLast is null.
 * A live read of the prior record's service_products was considered and
 * rejected: it is a different pipeline from the one that built the frozen
 * "applied" shape (catalog enrichment, support-product rules and report
 * facts are all mutable), it carries no "checks", and it would freeze that
 * drifted reading permanently into this visit's entry. No block beats a
 * block that disagrees with what the prior report actually said.
 *
 * `degraded` (the caller's product load, catalog enrichment or other inputs
 * this visit's entry is built from were not read cleanly): replay still works,
 * but nothing is written and the render is unfrozen.
 *
 * Returns { sinceLast, unfrozen }. `unfrozen` means this render is not
 * reproducible (the prior read blipped, or the freeze failed): the caller
 * must not durably cache it.
 */
async function resolveVisitMemoryForRender({
  structuredNotes, serviceRecordId, customerId, reportV2, assessmentId, serviceDate, priorVisit, knex, degraded = false,
} = {}) {
  const stored = storedVisitMemoryFor(structuredNotes, assessmentId);
  if (stored) return { sinceLast: canonical(stored.sinceLast || null), unfrozen: false };

  const memory = buildVisitMemory({ reportV2, assessmentId, serviceDate });
  if (!memory) return { sinceLast: null, unfrozen: false };

  let priorMemory = null;
  if (priorVisit?.serviceRecordId && priorVisit.assessmentId) {
    try {
      const row = await knex('service_records')
        .where({ id: priorVisit.serviceRecordId, customer_id: customerId })
        .first('structured_notes');
      priorMemory = storedVisitMemoryFor(row?.structured_notes, priorVisit.assessmentId);
    } catch (err) {
      // Unknown, not absent: freezing "no prior" now would be permanent.
      logger.warn(`[lawn-visit-memory] prior read failed for ${priorVisit.serviceRecordId}: ${err.message}`);
      return { sinceLast: null, unfrozen: true };
    }
  }
  const sinceLast = buildSinceLast({ priorVisit, priorMemory });
  // A freeze may only be CREATED from a complete, healthy read (first writer
  // wins: a degraded entry could never be repaired). The prior's frozen block
  // does not depend on this visit's inputs, so it is still served, read-only.
  if (degraded) return { sinceLast: canonical(sinceLast), unfrozen: true };
  const frozen = await freezeLawnVisitMemory(serviceRecordId, { ...memory, sinceLast }, knex);
  if (!frozen) return { sinceLast: canonical(sinceLast), unfrozen: true };
  return { sinceLast: canonical(frozen.sinceLast || null), unfrozen: false };
}

module.exports = {
  VISIT_MEMORY_VERSION,
  appliedFromProducts,
  TAG_BY_KIND,
  buildVisitMemory,
  selectPriorVisit,
  storedVisitMemoryFor,
  buildSinceLast,
  freezeLawnVisitMemory,
  resolveVisitMemoryForRender,
};
