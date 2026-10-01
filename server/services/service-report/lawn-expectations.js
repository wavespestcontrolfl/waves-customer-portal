/**
 * Lawn expectations engine (lawn report rebuild, P10). Pure: no I/O, no DB,
 * no fetch, no gate. Ships DARK: nothing in customer output calls it yet (P14
 * wires the writer, P16 routes the deterministic copy), so there is no gate.
 *
 * Given today's applications, named issues, the visit date and the next-visit
 * date, it returns the approved expectation sentences and a byNextVisit view
 * (what should be visible by the next visit).
 *
 * Contract (owner rulings):
 *  - Rows are keyed by the EXACT catalog product name (server/config/
 *    lawn-expectations.js PRODUCT_CLASS). An unmapped name gets NO line, an
 *    explicitly-null name gets none by decision.
 *  - Unapproved rows (`approved: false`, the default for every row) are
 *    withheld unless the caller passes `includeUnapproved: true` (tests and
 *    the owner preview). In production nothing is surfaced until the owner
 *    flips a row's `approved`.
 *  - Short-lived products (`transient`) and site limits can never yield a
 *    "behind" progress state (judgeProgress).
 *  - If the year-to-date Celsius count is at the cap, the broadleaf row's
 *    "second application" line swaps to the "different product" line.
 *  - Nothing here depends on a plan tier or lawn program, and nothing names a
 *    county, ordinance, blackout or law.
 *  - Every emitted line is word-capped and passes the shared customer-copy
 *    guards; a line that fails is dropped (fail closed), never rewritten.
 */

const {
  ENGINE_VERSION,
  CELSIUS_YTD_CAP,
  MAX_LINE_WORDS,
  PRODUCT_CLASS,
  PRODUCT_ROWS,
  ISSUE_ROWS,
  ROW_PRIORITY,
  CURATIVE_TARGET_PATTERNS,
  CURATIVE_ISSUE_KEYS,
  normalizeProductName,
} = require('../../config/lawn-expectations');
const { validateCustomerCopy } = require('./premium-experience');
const { findBannedCustomerCopy } = require('./activity-indicators');

// ── Product classification ────────────────────────────────────────────────
// Returns { family, modeLock } for a mapped product, null for an explicit
// "no line" decision AND for an unmapped name. Use classifyLawnProductStatus
// to tell those two apart.
function classifyLawnProduct(product = {}) {
  const key = normalizeProductName(typeof product === 'string' ? product : product?.name);
  if (!key) return null;
  return PRODUCT_CLASS.get(key) || null;
}

// 'mapped' | 'explicit_null' | 'unmapped' (the audit script reports this).
function classifyLawnProductStatus(name) {
  const key = normalizeProductName(name);
  if (!key || !PRODUCT_CLASS.has(key)) return 'unmapped';
  return PRODUCT_CLASS.get(key) ? 'mapped' : 'explicit_null';
}

// ── Dates ─────────────────────────────────────────────────────────────────
const DAY_MS = 86400000;

function parseDay(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime())
      ? Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
      : null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// Whole days from the visit to the next visit, or null when unknown.
function visitGapDays({ visitDate, nextVisitDate, nextVisitGapDays } = {}) {
  if (Number.isFinite(nextVisitGapDays)) return nextVisitGapDays >= 0 ? Math.floor(nextVisitGapDays) : null;
  const from = parseDay(visitDate);
  const to = parseDay(nextVisitDate);
  if (from == null || to == null) return null;
  const gap = Math.round((to - from) / DAY_MS);
  return gap >= 0 ? gap : null;
}

function visitMonth(visitDate) {
  const day = parseDay(visitDate);
  return day == null ? null : new Date(day).getUTCMonth() + 1;
}

// ── byNextVisit state ─────────────────────────────────────────────────────
// too_early: the next visit lands before the first visible change.
// partial:   some change is due, the full result is not.
// visible:   inside the full window.
// complete:  past the full window.
// absence:   a row judged by the absence of a problem.
function nextVisitState(row, gapDays) {
  if (!row) return null;
  if (row.judgedByAbsence) return 'absence';
  if (!Number.isFinite(gapDays)) return null;
  const first = row.windows?.first || null;
  const full = row.windows?.full || null;
  const firstMin = Number.isFinite(first?.minDays) ? first.minDays : 0;
  if (gapDays < firstMin) return 'too_early';
  if (!full) return 'visible';
  if (!Number.isFinite(full.minDays)) return 'partial'; // qualitative full window
  if (gapDays < full.minDays) return 'partial';
  if (Number.isFinite(full.maxDays) && gapDays >= full.maxDays) return 'complete';
  return 'visible';
}

const STATE_FALLBACK = {
  too_early: ['too_early', 'partial', 'visible', 'complete', 'absence'],
  partial: ['partial', 'visible', 'complete', 'too_early', 'absence'],
  visible: ['visible', 'complete', 'partial', 'too_early', 'absence'],
  complete: ['complete', 'visible', 'partial', 'too_early', 'absence'],
  absence: ['absence', 'visible', 'complete', 'partial', 'too_early'],
};

function pickNextVisitLine(byNextVisit, state) {
  if (!byNextVisit || !state) return null;
  for (const key of STATE_FALLBACK[state] || []) {
    if (byNextVisit[key]) return byNextVisit[key];
  }
  return null;
}

// ── Line guards ───────────────────────────────────────────────────────────
function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function lineAllowed(text) {
  const line = String(text || '').trim();
  if (!line) return false;
  if (wordCount(line) > MAX_LINE_WORDS) return false;
  if (!validateCustomerCopy(line)) return false;
  return findBannedCustomerCopy(line).length === 0;
}

// ── Row resolution ────────────────────────────────────────────────────────
function normalizeIssues(issues) {
  const out = new Map();
  for (const raw of Array.isArray(issues) ? issues : []) {
    const entry = typeof raw === 'string' ? { key: raw } : raw;
    const key = String(entry?.key || '').trim().toLowerCase();
    if (key && ISSUE_ROWS[key]) out.set(key, entry);
  }
  return out;
}

function targetsOf(app) {
  return (Array.isArray(app?.targets) ? app.targets : [])
    .map((t) => String(t == null ? '' : t).trim())
    .filter(Boolean);
}

function isCurative(family, app, issueKeys, modeLock) {
  if (modeLock) return modeLock === 'curative';
  const pattern = CURATIVE_TARGET_PATTERNS[family];
  if (pattern && targetsOf(app).some((t) => pattern.test(t))) return true;
  return (CURATIVE_ISSUE_KEYS[family] || []).some((key) => issueKeys.has(key));
}

function applyIssueOverrides(row, issueKeys) {
  const overrides = row.issueOverrides || {};
  const hit = Object.keys(overrides).find((key) => issueKeys.has(key));
  if (!hit) return row;
  const o = overrides[hit];
  return {
    ...row,
    limits: o.limits || row.limits,
    windows: { ...row.windows, ...(o.windows || {}) },
    byNextVisit: { ...row.byNextVisit, ...(o.byNextVisit || {}) },
    overriddenBy: hit,
  };
}

function materializeRow(base, { issueKeys, gapDays, celsiusYtdCount }) {
  const row = applyIssueOverrides(base, issueKeys);
  const capped = !!(row.secondApp
    && row.secondApp.cappedBy === 'celsius'
    && Number.isFinite(celsiusYtdCount)
    && celsiusYtdCount >= (row.secondApp.cap || CELSIUS_YTD_CAP));
  const secondAppLine = row.secondApp
    ? (capped ? row.secondApp.cappedLine : row.secondApp.line)
    : null;
  const state = nextVisitState(row, gapDays);
  const nextLine = pickNextVisitLine(row.byNextVisit, state);

  const candidates = [
    row.visibleChange,
    ...(row.limits || []),
    secondAppLine,
    nextLine,
    row.contactTrigger,
  ];
  const lines = [];
  const dropped = [];
  for (const line of candidates) {
    if (!line) continue;
    if (lineAllowed(line)) lines.push(line);
    else dropped.push(line);
  }

  const sources = new Set(
    [row.windows?.first, row.windows?.full].filter(Boolean).map((w) => w.source),
  );
  return {
    id: row.id,
    kind: row.kind || 'product',
    family: row.family || null,
    mode: row.mode || null,
    appliesTo: row.appliesTo,
    metric: row.metric,
    transient: !!row.transient,
    judgedByAbsence: !!row.judgedByAbsence,
    behindEligible: judgeEligibility(row),
    approved: !!row.approved,
    windows: row.windows,
    windowSources: [...sources],
    visibleChange: row.visibleChange,
    limits: row.limits || [],
    secondApp: row.secondApp ? { possible: !!row.secondApp.possible, capped } : null,
    byNextVisit: state && nextLine && lineAllowed(nextLine) ? { state, line: nextLine } : null,
    contactTrigger: row.contactTrigger && lineAllowed(row.contactTrigger) ? row.contactTrigger : null,
    lines,
    droppedLines: dropped,
  };
}

function judgeEligibility(row) {
  if (row.transient || row.judgedByAbsence) return false;
  if (row.behindEligible === false) return false;
  return true;
}

function resolveProductRows(applications, issueKeys) {
  const unmapped = [];
  const familyCurative = new Map(); // family -> curative?
  for (const app of Array.isArray(applications) ? applications : []) {
    const name = typeof app === 'string' ? app : app?.name;
    const status = classifyLawnProductStatus(name);
    if (status === 'unmapped') {
      if (normalizeProductName(name)) unmapped.push(String(name).trim());
      continue;
    }
    if (status === 'explicit_null') continue;
    const { family, modeLock } = classifyLawnProduct(name);
    const curative = isCurative(family, typeof app === 'string' ? {} : app, issueKeys, modeLock);
    // One curative application is enough to make the family's row curative.
    familyCurative.set(family, Boolean(familyCurative.get(family)) || curative);
  }
  const rows = [];
  for (const [family, curative] of familyCurative) {
    const mode = curative ? 'curative' : 'preventive';
    const row = Object.values(PRODUCT_ROWS).find((r) => r.family === family && (!r.mode || r.mode === mode));
    if (row) rows.push(row);
  }
  return { rows, unmapped, families: new Set(familyCurative.keys()) };
}

// Why an issue row is skipped (null = keep it).
function issueSkipReason(key, entry, { productRowIds, families, month }) {
  const row = ISSUE_ROWS[key];
  // The product row already carries these; never say it twice.
  if (key === 'chinch' && productRowIds.has('insecticide_curative')) return { silent: true };
  if (key === 'large_patch' && productRowIds.has('fungicide_curative')) return { silent: true };
  if (row.onlyWithoutRows && row.onlyWithoutRows.some((fam) => families.has(fam))) return { silent: true };
  if (row.months && (month == null || !row.months.includes(month))) return { reason: 'out_of_season' };
  // A seasonal dip is never the explanation for a new or worsening problem.
  if (key === 'seasonal_dip' && (entry?.isNew === true || entry?.worsening === true)) return { reason: 'new_or_worsening' };
  return null;
}

/**
 * @param {object} input
 * @param {Array<{name:string, targets?:string[]}>} [input.applications] today's applied products
 * @param {Array<string|{key:string, isNew?:boolean, worsening?:boolean}>} [input.issues] named issue keys
 * @param {string|Date} [input.visitDate]
 * @param {string|Date} [input.nextVisitDate]
 * @param {number} [input.nextVisitGapDays] used instead of the two dates when given
 * @param {number} [input.celsiusYtdCount] year-to-date Celsius count INCLUDING this visit
 * @param {object} [opts]
 * @param {boolean} [opts.includeUnapproved=false] tests and owner preview only
 */
function buildLawnExpectations(input = {}, { includeUnapproved = false } = {}) {
  const { applications = [], issues = [], visitDate = null, nextVisitDate = null, celsiusYtdCount = null } = input || {};
  const gapDays = visitGapDays({ visitDate, nextVisitDate, nextVisitGapDays: input?.nextVisitGapDays });
  const issueMap = normalizeIssues(issues);
  const issueKeys = new Set(issueMap.keys());
  const ctx = { issueKeys, gapDays, celsiusYtdCount: Number.isFinite(celsiusYtdCount) ? celsiusYtdCount : null };

  // 1. Product rows. Unmapped and explicit-null names yield nothing.
  const { rows: candidateRows, unmapped, families } = resolveProductRows(applications, issueKeys);

  // 2. Issue rows.
  const productRowIds = new Set(candidateRows.map((r) => r.id));
  const month = visitMonth(visitDate);
  const withheld = [];
  for (const [key, entry] of issueMap) {
    const skip = issueSkipReason(key, entry, { productRowIds, families, month });
    if (skip?.reason) withheld.push({ rowId: ISSUE_ROWS[key].id, reason: skip.reason });
    if (!skip) candidateRows.push(ISSUE_ROWS[key]);
  }

  // 3. Approval, ordering, materialization.
  const ordered = candidateRows
    .slice()
    .sort((a, b) => ROW_PRIORITY.indexOf(a.id) - ROW_PRIORITY.indexOf(b.id));
  const rows = [];
  for (const base of ordered) {
    if (!base.approved && !includeUnapproved) {
      withheld.push({ rowId: base.id, reason: 'not_approved' });
      continue;
    }
    const row = materializeRow(base, ctx);
    if (row.lines.length) rows.push(row);
  }

  return {
    engineVersion: ENGINE_VERSION,
    primaryRowId: rows[0]?.id || null,
    gapDays,
    rows,
    lines: rows.flatMap((r) => r.lines),
    byNextVisit: rows
      .filter((r) => r.byNextVisit)
      .map((r) => ({ rowId: r.id, state: r.byNextVisit.state, line: r.byNextVisit.line })),
    unmapped,
    withheld,
  };
}

// ── Progress judgement ────────────────────────────────────────────────────
// W5 progression rules for ONE row. `scoreDelta` is current minus prior for
// the row's metric. A transient row, a row judged by absence and a site limit
// can never return 'behind'.
function judgeProgress(row, { daysSinceApplication, scoreDelta, band = 8 } = {}) {
  if (!row) return 'unclear';
  if (!Number.isFinite(daysSinceApplication) || !Number.isFinite(scoreDelta)) return 'unclear';
  const first = row.windows?.first || null;
  const full = row.windows?.full || null;
  const firstMin = Number.isFinite(first?.minDays) ? first.minDays : 0;
  const fullMin = Number.isFinite(full?.minDays) ? full.minDays : firstMin;
  const fullMax = Number.isFinite(full?.maxDays) ? full.maxDays : null;
  const behindEligible = row.behindEligible !== undefined ? row.behindEligible : judgeEligibility(row);

  let state;
  if (daysSinceApplication < firstMin) state = 'too_early';
  else if (scoreDelta >= band) state = daysSinceApplication >= fullMin ? 'on_track' : 'ahead';
  else if (scoreDelta <= -band) state = 'behind';
  else if (fullMax != null && daysSinceApplication > fullMax) state = 'behind';
  else state = 'in_window';

  if (state === 'behind' && !behindEligible) {
    return 'holding_steady';
  }
  return state;
}

module.exports = {
  ENGINE_VERSION,
  CELSIUS_YTD_CAP,
  classifyLawnProduct,
  classifyLawnProductStatus,
  buildLawnExpectations,
  judgeProgress,
  nextVisitState,
  visitGapDays,
  lineAllowed,
  wordCount,
};
