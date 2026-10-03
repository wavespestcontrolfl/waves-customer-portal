/**
 * Lawn expectations engine (lawn report rebuild, P10). Pure: no I/O, no DB,
 * no fetch, no gate. Ships DARK: the only customer-facing reader is P14's v6
 * copy (lawn-copy-v6.js, GATE_LAWN_REPORT_COPY_V6), which prints approved rows'
 * keyed `sentences` word for word; P16 will route the deterministic copy.
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
  LAWN_TARGET_CLASS,
  CURATIVE_ISSUE_KEYS,
  normalizeProductName,
} = require('../../config/lawn-expectations');
// Pure imports only (no models/db): the engine must never open a database.
const { validateCustomerCopy } = require('./customer-copy-forbidden');
const { etCalendarDayOf, etDateString, parseETDateTime } = require('../../utils/datetime-et');
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

// A calendar day as UTC-midnight ms, resolved on the America/New_York
// calendar. 'YYYY-MM-DD' strings and pg date values (Date at 00:00Z) are read literally;
// real timestamps (Date or ISO string with a time) convert to their ET day,
// and a naive timestamp string reads as ET wall-clock. So
// 2026-10-31T21:00:00-04:00 is October 31 even though it is November 1 UTC.
function parseDay(value) {
  if (!value) return null;
  const dateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  // A naive 'YYYY-MM-DDTHH:mm' string is ET wall-clock (parseETDateTime).
  const instant = dateOnly ? null : parseETDateTime(value);
  if (!dateOnly && !Number.isFinite(instant.getTime())) return null;
  // A timestamp STRING is an explicit instant, so even exactly 00:00Z converts
  // through the ET formatter (2026-11-01T00:00:00Z is October 31 ET). Only a
  // Date object keeps etCalendarDayOf's pg-date reading of UTC midnight
  // (codex P1 pre-push).
  const day = dateOnly ? value : (typeof value === 'string' ? etDateString(instant) : etCalendarDayOf(instant));
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
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
// Only the config's OWN keys count ("constructor" / "__proto__" are not
// issues). Duplicate entries merge conservatively: any isNew / worsening
// evidence on any copy survives, whatever the input order (terminal review).
function normalizeIssues(issues) {
  const entries = (Array.isArray(issues) ? issues : []).map((raw) => (typeof raw === 'string' ? { key: raw } : raw));
  const merged = new Map();
  for (const e of entries) {
    const key = String(e?.key || '').trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(ISSUE_ROWS, key)) continue;
    const prev = merged.get(key) || { key };
    merged.set(key, {
      ...prev,
      ...e,
      key,
      isNew: Boolean(prev.isNew || e?.isNew),
      worsening: Boolean(prev.worsening || e?.worsening),
    });
  }
  return merged;
}

// What a tagged target establishes: { family, cause } from the controlled
// lawn vocabulary, or null for an unknown tag or one with no curative row.
function targetClass(target) {
  return LAWN_TARGET_CLASS.get(normalizeProductName(target)) || null;
}

function appName(app) {
  return typeof app === 'string' ? app : app?.name;
}

function appTargets(app) {
  return (Array.isArray(app?.targets) ? app.targets : []).map(targetClass).filter(Boolean);
}

// ONE recognized-cause set from both inputs: named issues AND the causes the
// applications' target tags establish. Curative mode and the cause-specific
// wording overrides both read it, so a tagged "Large patch" and an
// issues: ['large_patch'] entry give the same output.
function recognizedCauses(applications, issueMap) {
  const fromTargets = applications.flatMap(appTargets).map((t) => t.cause).filter(Boolean);
  return new Set([...issueMap.keys(), ...fromTargets]);
}

function isCurative(family, app, causes, modeLock) {
  if (modeLock) return modeLock === 'curative';
  const tagged = appTargets(app).some((t) => t.family === family);
  return tagged || (CURATIVE_ISSUE_KEYS[family] || []).some((cause) => causes.has(cause));
}

function applyIssueOverrides(row, causes) {
  const hit = Object.keys(row.issueOverrides).find((cause) => causes.has(cause));
  if (!hit) return row;
  const o = row.issueOverrides[hit];
  return {
    ...row,
    ...o,
    windows: { ...row.windows, ...o.windows },
    byNextVisit: { ...row.byNextVisit, ...o.byNextVisit },
    overriddenBy: hit,
  };
}

// Which sentence a row says about the next visit, as {state, line} or null.
function nextVisitView(row, gapDays) {
  const state = nextVisitState(row, gapDays);
  const line = pickNextVisitLine(row.byNextVisit, state);
  return lineAllowed(line) ? { state, line } : null;
}

// The keys of a materialized row (everything the writer or preview reads).
const ROW_OUTPUT_KEYS = [
  'id', 'kind', 'family', 'mode', 'appliesTo', 'metric', 'transient', 'judgedByAbsence', 'behindEligible',
  'approved', 'windows', 'metricWindows', 'visibleChange', 'limits',
];

function materializeRow(base, { causes, gapDays, celsiusYtdCount }) {
  const row = applyIssueOverrides(base, causes);
  // At the Celsius year-to-date cap the second-application line swaps.
  const capped = Boolean(row.secondApp) && celsiusYtdCount >= row.secondApp.cap;
  const byNextVisit = nextVisitView(row, gapDays);
  const contactTrigger = lineAllowed(row.contactTrigger) ? row.contactTrigger : null;
  // Keyed so P14's writer can SELECT a sentence by (row id, key) and print its
  // text verbatim; the order here is the order a row reads in.
  const keyed = [
    ['visibleChange', row.visibleChange],
    ...row.limits.map((line, i) => [`limit${i + 1}`, line]),
    ['secondApp', row.secondApp && (capped ? row.secondApp.cappedLine : row.secondApp.line)],
    ['byNextVisit', byNextVisit?.line],
    ['contactTrigger', contactTrigger],
  ].filter(([, line]) => line);
  const candidates = keyed.map(([, line]) => line);
  return {
    ...Object.fromEntries(ROW_OUTPUT_KEYS.map((key) => [key, row[key]])),
    windowSources: [...new Set([row.windows.first, row.windows.full].filter(Boolean).map((w) => w.source))],
    secondApp: row.secondApp && { possible: row.secondApp.possible, capped },
    byNextVisit,
    contactTrigger,
    lines: candidates.filter(lineAllowed),
    sentences: keyed.filter(([, line]) => lineAllowed(line)).map(([key, text]) => ({ key, text })),
    droppedLines: candidates.filter((line) => !lineAllowed(line)),
  };
}

function resolveProductRows(applications, causes) {
  const mapped = applications.filter((app) => classifyLawnProductStatus(appName(app)) === 'mapped');
  const unmapped = applications
    .filter((app) => classifyLawnProductStatus(appName(app)) === 'unmapped')
    .map((app) => String(appName(app) ?? '').trim())
    .filter(Boolean);
  const familyCurative = new Map(); // family -> curative?
  for (const app of mapped) {
    const { family, modeLock } = classifyLawnProduct(appName(app));
    // One curative application is enough to make the family's row curative.
    familyCurative.set(family, familyCurative.get(family) || isCurative(family, app, causes, modeLock));
  }
  const rows = [...familyCurative].map(([family, curative]) => Object.values(PRODUCT_ROWS)
    .find((r) => r.family === family && (!r.mode || r.mode === (curative ? 'curative' : 'preventive'))));
  return { rows: rows.filter(Boolean), unmapped, families: new Set(familyCurative.keys()) };
}

// Issue rows are withheld for a reason that depends only on the visit.
const ISSUE_WITHHOLD_RULES = [
  { reason: 'out_of_season', applies: (row, entry, month) => row.months && !row.months.includes(month) },
  { reason: 'new_or_worsening', applies: (row, entry) => row.steadyOnly && (entry.isNew || entry.worsening) },
];

/**
 * Emission is decided FIRST (approved, or the caller asked for a preview);
 * only then are issue rows deduped against the product rows that will really
 * be emitted. So an approved issue row is never silenced by a product row
 * that is itself withheld.
 *
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
  const applications = Array.isArray(input?.applications) ? input.applications : [];
  const { visitDate = null, nextVisitDate = null, celsiusYtdCount = null } = input || {};
  const gapDays = visitGapDays({ visitDate, nextVisitDate, nextVisitGapDays: input?.nextVisitGapDays });
  const issueMap = normalizeIssues(input?.issues);
  const causes = recognizedCauses(applications, issueMap);
  const ctx = { causes, gapDays, celsiusYtdCount };

  const { rows: productRows, unmapped, families } = resolveProductRows(applications, causes);
  const month = visitMonth(visitDate);
  const issueRows = [];
  const withheld = [];
  for (const [key, entry] of issueMap) {
    const row = ISSUE_ROWS[key];
    const rule = ISSUE_WITHHOLD_RULES.find((r) => r.applies(row, entry, month));
    if (rule) withheld.push({ rowId: row.id, reason: rule.reason });
    // A herbicide applied today carries the weeds; the planned-treatment line would be wrong.
    const appliedHerbicide = row.onlyWithoutRows.some((family) => families.has(family));
    if (!rule && !appliedHerbicide) issueRows.push(row);
  }

  // 1. Decide emission. 2. Dedupe among what will be emitted.
  const candidates = [...productRows, ...issueRows];
  const emitted = (row) => row.approved || includeUnapproved;
  const emittedIds = new Set(candidates.filter(emitted).map((row) => row.id));
  const kept = candidates.filter((row) => !emittedIds.has(row.supersededBy));
  withheld.push(...kept.filter((row) => !emitted(row)).map((row) => ({ rowId: row.id, reason: 'not_approved' })));

  const rows = kept
    .filter(emitted)
    .sort((a, b) => ROW_PRIORITY.indexOf(a.id) - ROW_PRIORITY.indexOf(b.id))
    .map((row) => materializeRow(row, ctx))
    .filter((row) => row.lines.length);

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
// W5 progression rules for ONE metric of ONE row. `scoreDelta` is current
// minus prior for that metric. Each metric is judged against the window that
// belongs to IT (row.metricWindows[metric]): color against the color window,
// density against the density window, spread against the spread window. A
// metric with no window of its own is never judged here, and no verdict is
// "behind" until that metric's window has closed. Transient rows, rows judged
// by absence and site limits carry no windows, so they can never be behind.
//
//   too_early       before the metric's window opens
//   in_window       window open, not closed, no clear gain yet
//   ahead           a full band of gain before the full window opens
//   on_track        gained a band, or (hold mode) has stopped falling
//   behind          window closed with no gain (gain mode) or still falling
//                   (hold mode)
//   holding_steady  nothing to judge against for this metric
//   unclear         missing inputs
const PROGRESS_VERDICT = {
  gain: {
    gained_full: 'on_track', gained_early: 'ahead', closed_down: 'behind', closed_flat: 'behind', open: 'in_window',
  },
  hold: {
    gained_full: 'on_track', gained_early: 'on_track', closed_down: 'behind', closed_flat: 'on_track', open: 'in_window',
  },
};

// Where the score sits against one metric window.
function progressSituation(win, days, delta, band) {
  if (delta >= band) return days >= win.fullMinDays ? 'gained_full' : 'gained_early';
  if (days <= win.closeDays) return 'open';
  return delta <= -band ? 'closed_down' : 'closed_flat';
}

function judgeProgress(row, { metric, daysSinceApplication, scoreDelta, band = 8 } = {}) {
  const win = row?.metricWindows?.[metric || row.metric];
  if (![daysSinceApplication, scoreDelta].every(Number.isFinite)) return 'unclear';
  if (!win) return 'holding_steady';
  if (daysSinceApplication < win.startDays) return 'too_early';
  return PROGRESS_VERDICT[win.mode][progressSituation(win, daysSinceApplication, scoreDelta, band)];
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
