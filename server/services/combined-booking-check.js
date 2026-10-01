/**
 * Combined-booking check (owner request 2026-09-29; narrowed to time and
 * technician by owner ruling 2026-10-01).
 *
 * Every time a customer accepts an estimate with MORE THAN ONE recurring
 * service (pest + lawn, pest + lawn + tree & shrub, pest + rodent, ...), this
 * verifies that every visit the booking created has a time and a technician,
 * and posts ONE admin bell when one does not. The 2026-09-28 defect it guards:
 * companion services were booked with no time and no technician.
 *
 * NOT THIS CHECK'S (each has its own owner, and a second bell would conflict):
 *   - prices and invoices (an unpriced visit is the watchdog's unpriced-series
 *     alert's; split first-application invoices are the sibling-split
 *     workflow's). Owner ruling 2026-10-01: price checks may come back later as
 *     their own change, not here.
 *   - whether the right number of visits exist: the shared accepted-plan
 *     classifier (recurring-schedule-audit's acceptedScheduleFindings), the
 *     source of the watchdog's `accepted-schedule:*` alerts. An estimate with
 *     such a gap is never declared OK, and its schedule shape is left to that
 *     alert.
 *   - a former customer's leftover work: the churned-live-work alert's.
 *
 * WHERE IT RUNS: inside the schedule-integrity watchdog (its daily tick, under
 * that job's runExclusive and GATE_SCHEDULE_INTEGRITY_WATCHDOG), over accepted
 * estimates that settled at least SETTLE_MINUTES ago — not a hook in the
 * accept route (a money path: a hook could only add latency or a new way to
 * fail it, and is lost if the process dies right after the commit). The sweep
 * derives everything from committed rows: a crash just means the next run
 * checks the estimate. No state is stored beyond the bells themselves.
 *
 * WHAT IS A COMBINED BOOKING: what the customer ACCEPTED, read through the
 * converter's own scheduling units (combineRecurringServicesForScheduling, the
 * same call the classifier makes; a legacy rodent supplement counts). A family
 * the classifier did not judge (an active plan hold, a stopped series) or the
 * duplicate-series guard kept on an older series leaves the check; the rest are
 * still checked, and with none left a standing bell is left as it is.
 *
 * ALERTS follow docs/admin-notifications.md through raiseAdminAlert: one
 * needs-you Schedule bell per estimate ("Schedule — fix <name>'s combined
 * booking", a one-sentence why, the customer link, subject = the estimate,
 * done when combined_booking_verified), ringing again only when a new service
 * family joins it. A fixed problem, a cancelled plan, or a customer / estimate
 * that left for good closes the bell as DONE. An OK result is an `fyi` fact and
 * writes no row. Rings share the watchdog run's budget (at most 10 a day):
 * past it a booking waits on ONE quiet overflow record, whose list the next
 * run re-reads (so nothing ages out unreported) and whose count is a standing
 * item in the dashboard Action Inbox (combined_bookings_owed). An estimate
 * with an open bell stays a candidate past the lookback, and a finding about
 * a service that went on hold stays on its bell until that service is judged
 * again.
 */

const db = require('../models/db');
const logger = require('./logger');

const OPS_KEY = 'combined-booking-check';
// needs-you bells ring under the emitter's own category; 'alert' is the one the
// schedule-integrity watchdog's own bells use.
const CATEGORY = 'alert';
const AREA = 'Schedule';
const DONE_WHEN = 'combined_booking_verified';
const RESOLVED_FIXED = 'Fixed: the combined booking now checks out';
const RESOLVED_GONE = 'Closed: the plan was cancelled, or the estimate or customer is no longer active or current';
// The standing count bell for problems past the ring budget (its itemKeys are
// the estimates still owed their own bell).
const OVERFLOW_ID = 'overflow';
// Without a caller's budget (a direct run), the same 10 a day the watchdog
// keeps (docs/admin-notifications.md, Budget).
const DEFAULT_RING_BUDGET = 10;

// Let the accept transaction and its follow-on writes settle before judging.
const SETTLE_MINUTES = 3;
// Estimates accepted longer ago than this are not newly checked: an old
// problem the office has lived with is not news, and a first run after deploy
// must not turn into a backlog scan. (A booking the overflow bell owes stays.)
const LOOKBACK_HOURS = 72;

const CANCELLED = new Set(['cancelled', 'canceled']);
const NOT_LIVE = new Set(['cancelled', 'canceled', 'rescheduled', 'skipped', 'no_show']);

const FAMILY_LABELS = {
  pest_control: 'Pest',
  lawn_care: 'Lawn',
  tree_shrub: 'Tree & Shrub',
  mosquito: 'Mosquito',
  rodent_bait: 'Rodent',
  rodent: 'Rodent',
  termite_bait: 'Termite',
  foam_recurring: 'Termite foam',
  palm_injection: 'Palm',
};

function familyLabel(family) {
  return FAMILY_LABELS[family] || String(family || 'service').replace(/_/g, ' ');
}
function lowerLabel(family) {
  const label = familyLabel(family);
  return label === 'Tree & Shrub' ? 'T&S' : label.toLowerCase();
}

const dateOnly = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};
function parseJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || fallback; } catch { return fallback; }
}

/**
 * The service families an accepted estimate auto-schedules, from the
 * converter's own scheduling units. null for a one-time accept or a plan the
 * converter does not auto-schedule. Pure.
 */
function acceptedFamilies(estimate) {
  const converter = require('./estimate-converter');
  const { acceptedRecurringBillingLines } = require('./plan-rate-ledger');
  const { inferFrequencyKeyFromEstimateData, legacyRodentRowPredicateFor } = require('./billing-cadence');
  const data = parseJson(estimate.estimate_data);
  if (estimate.accepted_service_mode === 'one_time') return null;
  // The converter's own service set: the termite station-rental rider folds
  // into the bait row, and legacy rodent rows leave the lines (they come back
  // below as a supplement unit), exactly as conversion does.
  const isLegacyRodentRow = legacyRodentRowPredicateFor(data);
  const lines = converter.foldTermiteRentalIntoBait(acceptedRecurringBillingLines(data))
    .filter((line) => !isLegacyRodentRow(line));
  if (converter.shouldSuppressRecurringConversion({
    monthlyRate: estimate.monthly_total, annualTotal: estimate.annual_total,
    oneTimeTotal: estimate.onetime_total, recurringServices: lines, estimateData: data,
  })) return null;
  const acceptedFrequency = data.customerSelection?.frequency || null;
  const fallback = acceptedFrequency || inferFrequencyKeyFromEstimateData(data);
  const { remaining, combos, standalone } = converter.combineRecurringServicesForScheduling(lines, {
    acceptFrequency: acceptedFrequency, supplementalCompanions: converter.supplementalCompanionLines(data),
  });
  return new Set([
    ...[...remaining, ...standalone.map((unit) => unit.service)].map((service) => [service, [service]]),
    ...combos.map((combo) => [combo.service, combo.combinedFrom]),
  ]
    // Commercial lines, billing riders and contradictory terms are scheduled
    // by the office; they have no auto-seeded cadence to verify here.
    .filter(([service]) => converter.converterFollowUpSeedingPattern(service, {}, fallback, acceptedFrequency))
    .flatMap(([, sources]) => sources.map((line) => converter.seedingFamilyKey(line))));
}

/** Service families a scheduled row performs (a combined route spans two). */
function rowFamilies(row) {
  const converter = require('./estimate-converter');
  const identity = row.catalog_service_key || row.service_key_snapshot;
  const families = converter.comboRouteFamiliesFromCatalogKey(identity);
  return families.length ? families
    : [converter.seedingFamilyKey({ service: identity, name: row.service_type })];
}

// Time + technician on every live row, except a SEASONAL mosquito series
// (catalog mosquito_seasonal, the Feb–Oct program) whose first visit rolled
// past the booking's first day: the converter books it unslotted on purpose
// until the office routes that season (estimate-converter.js, the
// seasonalMosquito promotion). A monthly mosquito series is checked like any
// other.
function checkTimeAndTech(dated, families, { firstDay, byId }) {
  const untimed = new Map();
  const seasonalUnslotted = (row) => {
    const root = byId.get(String(row.recurring_parent_id)) || row;
    return (root.catalog_service_key || root.service_key_snapshot) === 'mosquito_seasonal'
      && dateOnly(root.scheduled_date) > firstDay;
  };
  for (const row of dated) {
    if (row.window_start && row.technician_id) continue;
    if (seasonalUnslotted(row)) continue;
    for (const family of rowFamilies(row).filter((f) => families.has(f))) untimed.set(family, (untimed.get(family) || 0) + 1);
  }
  // In the booking's own service order, so the alert reads pest, lawn, T&S.
  return [...families].filter((family) => untimed.has(family)).map((family) => ({
    code: 'missing_time_tech', families: [family], text: `${untimed.get(family)} ${lowerLabel(family)} visits missing time/tech`,
  }));
}

/**
 * Pure verdict for one accepted estimate.
 *   ctx: { estimate, rows, excludedFamilies: Set, scheduleGaps,
 *          scheduleSkippedFamilies: Set, scheduleOnHoldFamilies: Set, scheduleUnjudged: bool }
 * Returns null when the accept is not a multi-service recurring accept, or
 * every row of the plan was cancelled (no alert at all); else
 * { ok, deferred, heldFamilies, problems: [{ code, families, text }], labels }.
 */
function evaluateCombinedBooking(ctx) {
  const {
    estimate, rows: allRows = [], excludedFamilies = new Set(),
    scheduleGaps = [], scheduleSkippedFamilies = new Set(), scheduleOnHoldFamilies = new Set(), scheduleUnjudged = false,
  } = ctx;
  const accepted = acceptedFamilies(estimate);
  if (!accepted || accepted.size < 2) return null;
  const isPlanRow = (row, scope) => !row.is_callback && !row.followup_included
    && !(row.is_recurring === false && row.recurring_parent_id)
    && rowFamilies(row).some((family) => scope.has(family));
  // Every row of the accepted plan cancelled (a cancelled plan, or every
  // series stopped for good): nothing left to verify, so nothing to say.
  const acceptedRows = allRows.filter((row) => isPlanRow(row, accepted));
  if (acceptedRows.length && acceptedRows.every((row) => CANCELLED.has(row.status))) return null;
  // Skipped by the classifier for an ACTIVE PLAN HOLD (the one temporary
  // reason): not judged now, and a standing finding about it is kept until it
  // is (the runner's heldProblems). A stopped series is skipped too, but for
  // good: its findings are not kept.
  const heldFamilies = [...accepted].filter((family) => scheduleOnHoldFamilies.has(family));
  const families = new Set([...accepted].filter((family) => !excludedFamilies.has(family) && !scheduleSkippedFamilies.has(family)));
  // Every family on hold / stopped / kept on an older series: nothing to judge
  // now. The runner keeps only the findings about families on hold.
  if (!families.size) return { ok: false, deferred: true, heldFamilies, problems: [], labels: [] };

  // The booking's first day comes from ALL its plan visits, before families on
  // hold or cancelled rows are filtered out (the seasonal exemption is judged
  // against the day the booking really started).
  const firstDay = acceptedRows.map((row) => dateOnly(row.scheduled_date)).sort()[0];
  const planRows = allRows.filter((row) => isPlanRow(row, families));
  const rows = planRows.filter((row) => !NOT_LIVE.has(row.status));
  // Rows were created and every one was cancelled: the customer or office
  // cancelled the plan. Nothing left to verify, so nothing to say.
  if (!rows.length && planRows.length && planRows.every((row) => CANCELLED.has(row.status))) {
    // The services still judged were cancelled; one on hold keeps the booking.
    return heldFamilies.length ? { ok: false, deferred: true, heldFamilies, problems: [], labels: [] } : null;
  }
  const labels = [...families].map(familyLabel);
  // No live rows: the schedule shape is the accepted-schedule alert's.
  if (!rows.length) return { ok: false, deferred: true, heldFamilies, problems: [], labels };

  const dated = rows.map((row) => ({ ...row, day: dateOnly(row.scheduled_date) })).sort((a, b) =>
    a.day.localeCompare(b.day) || String(a.id).localeCompare(String(b.id)));
  const byId = new Map(allRows.map((row) => [String(row.id), row]));
  const problems = checkTimeAndTech(dated, families, { firstDay, byId });
  // A schedule gap, or an estimate the classifier did not judge, is never OK.
  const deferred = scheduleGaps.length > 0 || scheduleUnjudged;
  return { ok: !problems.length && !deferred, deferred, heldFamilies, problems, labels };
}

function shortName(customer) {
  const first = String(customer?.first_name || '').trim();
  const last = String(customer?.last_name || '').trim();
  if (first && last) return `${first[0].toUpperCase()}. ${last}`;
  return last || first || 'Customer';
}

/**
 * The raiseAdminAlert spec for a verdict with problems (docs/admin-notifications.md:
 * Area, headline <= 60 "Area — what to do", one-sentence why <= 110, a record link,
 * subject, done-when, who). An OK result is an `fyi` fact and writes no row. Pure.
 */
function composeAlert(verdict, { customerName, customerId, estimateId }) {
  const { cutAtWord, MAX_HEADLINE_CHARS, MAX_WHY_CHARS } = require('./admin-alert-compose');
  const texts = verdict.problems.map((problem) => `${problem.text}${problem.held ? ' (on hold)' : ''}`);
  const why = `${texts.slice(0, 2).join('; ')}${texts.length > 2 ? ` (+${texts.length - 2} more)` : ''}`;
  return {
    area: AREA,
    action: cutAtWord(`fix ${customerName || 'Customer'}'s combined booking`, MAX_HEADLINE_CHARS - `${AREA} — `.length),
    why: cutAtWord(`${why.charAt(0).toUpperCase()}${why.slice(1)}.`, MAX_WHY_CHARS),
    severity: 'needs-you',
    link: `/admin/customers?customerId=${encodeURIComponent(customerId)}`,
    subject: { type: 'estimate', id: String(estimateId) },
    doneWhen: DONE_WHEN,
    who: 'person',
    detail: [`${customerName || 'Customer'}: ${verdict.labels.join(' + ')} booking needs a time and technician on every visit.`,
      ...verdict.problems.map((problem) => `- ${problem.text}${problem.held ? ' (service on hold; checked again when the hold ends)' : ''}`)].join('\n'),
  };
}

// --- database side ---------------------------------------------------------

async function loadContext(conn, estimate) {
  const estimateId = estimate.id;
  const customerId = estimate.customer_id;
  const skipped = await conn('activity_log')
    .where({ customer_id: customerId, action: 'recurring_series_skipped' }).select('metadata');
  // The duplicate-series guard keeps a customer's existing series instead of
  // seeding a second one; that family has no rows of THIS estimate by design.
  const retainedParentIds = skipped.map((event) => parseJson(event.metadata))
    .filter((meta) => String(meta.estimateId) === String(estimateId) && meta.existingParentId)
    .map((meta) => meta.existingParentId);
  const excludedFamilies = new Set();
  if (retainedParentIds.length) {
    const retained = await conn('scheduled_services as s').leftJoin('services as catalog', 'catalog.id', 's.service_id')
      .whereIn('s.id', retainedParentIds)
      .select('s.service_type', 's.service_key_snapshot', 'catalog.service_key as catalog_service_key');
    for (const row of retained) for (const family of rowFamilies(row)) excludedFamilies.add(family);
  }
  const rows = await conn('scheduled_services as s')
    .leftJoin('services as catalog', 'catalog.id', 's.service_id')
    .where('s.customer_id', customerId)
    .where(function linkedToEstimate() {
      this.where('s.source_estimate_id', estimateId).orWhereIn('s.recurring_parent_id', function parents() {
        this.select('id').from('scheduled_services').where({ source_estimate_id: estimateId, customer_id: customerId });
      });
    })
    .select('s.id', 's.status', 's.recurring_parent_id', 's.is_recurring', 's.is_callback', 's.followup_included',
      's.service_type', 's.service_key_snapshot', 's.window_start', 's.technician_id',
      'catalog.service_key as catalog_service_key', 'catalog.billing_type as catalog_billing_type',
      conn.raw("to_char(s.scheduled_date, 'YYYY-MM-DD') as scheduled_date"));
  const customer = await conn('customers').where({ id: customerId }).first('first_name', 'last_name');
  return {
    estimate,
    rows: rows.filter((row) => row.catalog_billing_type !== 'one_time'),
    excludedFamilies, customerName: shortName(customer),
  };
}

// `coverage` is the classifier's { skipped, onHold } for this estimate;
// undefined when it did not judge the estimate (never declared OK then).
async function checkEstimate(conn, estimate, { scheduleGaps = [], coverage } = {}) {
  const ctx = {
    ...await loadContext(conn, estimate),
    scheduleGaps,
    scheduleSkippedFamilies: coverage ? coverage.skipped : new Set(),
    scheduleOnHoldFamilies: coverage ? coverage.onHold : new Set(),
    scheduleUnjudged: !coverage,
  };
  const verdict = evaluateCombinedBooking(ctx);
  return verdict ? { verdict, ctx } : null;
}

function dedupeKeyFor(estimateId) {
  return `${OPS_KEY}:${estimateId}`;
}

// A problem's stable identities: one per affected service family, so a fixed
// lawn problem replaced by a new pest one rings.
function problemKeys(problem) {
  return (problem.families || []).map((family) => `${problem.code}:${family}`);
}

// A refresh rings only when a problem is new: an identity the standing row
// did not already carry.
function ringOnNewProblem(keys) {
  return (existing, existingMeta) => {
    const known = new Set(Array.isArray(existingMeta?.itemKeys) ? existingMeta.itemKeys : []);
    return keys.some((key) => !known.has(key));
  };
}

// Closes the standing bells for these estimates as DONE (docs/admin-notifications.md
// section 4: read is not done; a system close spreads doneColumns and selects
// openToCloser's rows). The dedupeKey is dropped, like resolveOpsDigest does, so a
// problem that comes back posts a fresh bell that rings instead of refreshing a
// closed one in silence.
async function retireStanding(conn, estimateIds, resolution) {
  if (!estimateIds.length) return 0;
  const { doneColumns, openToCloser } = require('./notification-service')._private;
  const query = conn('notifications').where({ recipient_type: 'admin', category: CATEGORY })
    .whereRaw("metadata->>'dedupeKey' = ANY(?)", [estimateIds.map(dedupeKeyFor)]);
  return openToCloser(query, OPS_KEY).update({
    ...doneColumns({ by: OPS_KEY, resolution, keepExisting: true, conn }),
    metadata: conn.raw("(COALESCE(metadata, '{}'::jsonb) - 'dedupeKey') || ?::jsonb", [JSON.stringify({
      resolved: true, resolvedAt: new Date().toISOString(), resolvedBy: OPS_KEY,
    })]),
  });
}

async function postAlert(estimate, verdict, ctx, { raise } = {}) {
  const raiseAdminAlert = raise || require('./admin-alert-compose').raiseAdminAlert;
  const { detail, ...spec } = composeAlert(verdict, {
    customerName: ctx.customerName, customerId: estimate.customer_id, estimateId: estimate.id,
  });
  const keys = [...new Set(verdict.problems.flatMap(problemKeys))];
  return raiseAdminAlert(CATEGORY, spec, {
    // Under GATE_ADMIN_BELL_POLICY the 'alert' category is denied unless the
    // call site tags it (the schedule-integrity watchdog's own bells do too).
    bell: true,
    detail,
    dedupeKey: dedupeKeyFor(estimate.id),
    refreshOnDedupe: true,
    ringOnRefresh: ringOnNewProblem(keys),
    metadata: {
      opsKey: OPS_KEY,
      alertClass: OPS_KEY,
      estimateId: estimate.id,
      customerId: estimate.customer_id,
      problemCodes: verdict.problems.map((problem) => problem.code),
      // The findings themselves, so a later run can keep one about a service
      // that went on hold (heldProblems).
      problems: verdict.problems.map(({ code, families, text }) => ({ code, families, text })),
      // count + itemKeys are the ring-stamps notifyAdmin compares on a
      // refresh, so a changed problem set is treated as a real change.
      count: keys.length,
      itemKeys: keys,
    },
  });
}

// Standing bells whose estimate has left the sweep for good (the customer was
// deactivated, deleted or moved to a former-customer stage, the estimate
// archived or no longer accepted): nothing is left to act on, so they close.
// A bell that only aged past the lookback stays open for a person.
async function retireAbandoned(conn) {
  const { FORMER_CUSTOMER_STAGES } = require('./customer-stages');
  const gone = await conn('notifications as n')
    .leftJoin('estimates as e', conn.raw("e.id::text = n.metadata->>'estimateId'"))
    .leftJoin('customers as c', 'c.id', 'e.customer_id')
    .where({ 'n.recipient_type': 'admin', 'n.category': CATEGORY })
    .whereRaw("starts_with(n.metadata->>'dedupeKey', ?)", [`${OPS_KEY}:`])
    .whereRaw("n.metadata->>'estimateId' IS NOT NULL")
    .where(function goneForGood() {
      this.whereNull('e.id').orWhereNot('e.status', 'accepted').orWhereNotNull('e.archived_at')
        .orWhereNot('c.active', true).orWhereNotNull('c.deleted_at').orWhereIn('c.pipeline_stage', FORMER_CUSTOMER_STAGES);
    })
    .select(conn.raw("n.metadata->>'estimateId' as estimate_id"));
  return retireStanding(conn, [...new Set(gone.map((row) => row.estimate_id))], RESOLVED_GONE);
}

// A standing bell's findings about a service now on hold: not re-judged
// this run, so they stay on the bell (marked) instead of closing as fixed.
function heldProblems(verdict, standingProblems = []) {
  const held = new Set(verdict.heldFamilies || []);
  return standingProblems.filter((problem) => (problem?.families || []).some((family) => held.has(family)))
    .map((problem) => ({ code: problem.code, families: problem.families, text: problem.text, held: true }));
}

// What a sweep does with one verdict, given the standing bell's findings:
//   skipped  — not a combined booking any more (the plan was cancelled): close
//   problems — post / refresh the bell (current findings plus held ones)
//   ok       — verified: close a standing bell as fixed
//   deferred — nothing of this check's own to say: close
// `onHold`: a service of this booking could not be judged for a plan hold.
function outcomeOf(verdict, standingProblems = []) {
  if (!verdict) return { outcome: 'skipped', problems: [], onHold: false };
  const problems = [...verdict.problems, ...heldProblems(verdict, standingProblems)];
  const onHold = verdict.heldFamilies.length > 0;
  if (problems.length) return { outcome: 'problems', problems, onHold };
  return { outcome: verdict.ok ? 'ok' : 'deferred', problems, onHold };
}

// The overflow record's entries: every estimate it keeps a candidate
// (`all`), and the subset waiting only for a service's hold to end (`held`),
// which has no known problem yet.
async function overflowEntries(conn) {
  const row = await conn('notifications').where({ recipient_type: 'admin', category: CATEGORY })
    .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKeyFor(OVERFLOW_ID)]).first('metadata');
  const list = (value) => (Array.isArray(value) ? value.map(String) : []);
  return { all: list(row?.metadata?.itemKeys), held: new Set(list(row?.metadata?.heldIds)) };
}

// The bookings owed their own alert: each has a known problem (the dashboard
// Action Inbox count, dashboard-alerts.js combined_bookings_owed).
async function owedEstimateIds(conn) {
  const { all, held } = await overflowEntries(conn);
  return all.filter((id) => !held.has(id));
}

// The estimates with an open bell of this check: they stay candidates past
// the lookback, so a bell is only ever closed by a run that judged it.
async function standingEstimateIds(conn) {
  const rows = await conn('notifications').where({ recipient_type: 'admin', category: CATEGORY })
    .whereRaw("starts_with(metadata->>'dedupeKey', ?)", [`${OPS_KEY}:`])
    .whereRaw("metadata->>'estimateId' IS NOT NULL")
    .select(conn.raw("metadata->>'estimateId' as estimate_id"));
  return rows.map((row) => String(row.estimate_id));
}

// Accepted multi-service estimates to judge: those accepted inside the
// lookback, plus any with an open bell or that the overflow row still owes a
// bell (so nothing open or owed ages out unjudged).
function candidateQuery(conn, { now, owed }) {
  const { FORMER_CUSTOMER_STAGES } = require('./customer-stages');
  const settled = new Date(now.getTime() - SETTLE_MINUTES * 60 * 1000);
  const since = new Date(now.getTime() - LOOKBACK_HOURS * 3600 * 1000);
  return conn('estimates as e')
    .join('customers as c', 'c.id', 'e.customer_id')
    .where('e.status', 'accepted').whereNull('e.archived_at')
    .where('e.accepted_at', '<=', settled)
    .where(function window() { this.where('e.accepted_at', '>', since).orWhereIn('e.id', owed); })
    .where('c.active', true).whereNull('c.deleted_at')
    // A former customer's leftover work is the churned-live-work alert's
    // (cancel it), never a repair bell here; the shared classifier skips the
    // same stages.
    .where(function currentCustomer() {
      this.whereNotIn('c.pipeline_stage', FORMER_CUSTOMER_STAGES).orWhereNull('c.pipeline_stage');
    })
    .where(function recurringAccept() {
      this.whereNull('e.accepted_service_mode').orWhereNot('e.accepted_service_mode', 'one_time');
    })
    .select('e.id', 'e.customer_id', 'e.property_id', 'e.estimate_data', 'e.accepted_service_mode', 'e.accepted_at',
      'e.monthly_total', 'e.annual_total', 'e.onetime_total')
    .orderBy('e.accepted_at', 'asc');
}

// The record of bookings past the ring budget: one row listing each (its
// itemKeys are what the next run re-reads), closed as done once nothing is
// owed. It is a standing condition (docs/admin-notifications.md section 1), so
// it never rings: it is always written quietly, and the count shows in the
// dashboard Action Inbox (dashboard-alerts.js, combined_bookings_owed).
async function postOverflow(conn, owed, { raise } = {}) {
  if (!owed.length) return retireStanding(conn, [OVERFLOW_ID], RESOLVED_FIXED);
  const raiseAdminAlert = raise || require('./admin-alert-compose').raiseAdminAlert;
  const ids = owed.map((entry) => entry.id);
  const heldIds = owed.filter((entry) => entry.held).map((entry) => entry.id);
  const toFix = ids.length - heldIds.length;
  const row = await raiseAdminAlert(CATEGORY, {
    area: AREA,
    action: toFix
      ? `fix ${toFix} more combined booking${toFix === 1 ? '' : 's'}`
      : `recheck ${ids.length} combined booking${ids.length === 1 ? '' : 's'} after a hold`,
    why: 'Past the daily alert budget, so these bookings are listed here until each gets its own alert.',
    severity: 'needs-you',
    link: '/admin/customers',
    subject: { type: 'check', id: OPS_KEY },
    doneWhen: 'combined_booking_overflow_cleared',
    who: 'person',
  }, {
    bell: true,
    detail: owed.map((entry) => `- ${entry.line}`).join('\n'),
    dedupeKey: dedupeKeyFor(OVERFLOW_ID),
    refreshOnDedupe: true,
    ringGate: async () => false,
    ringOnRefresh: () => false,
    metadata: { opsKey: OPS_KEY, alertClass: OPS_KEY, count: ids.length, itemKeys: ids, heldIds },
  });
  // This row is the only record of what is owed: a lost write fails the
  // sweep loudly (the watchdog logs COMBINED-BOOKING-CHECK-FAILED).
  if (!row) throw new Error(`overflow bell write failed; ${ids.length} owed booking(s) unrecorded`);
  return 0;
}

// A bell that actually rang this run (created, or a refresh that rang): what
// the budget counts. A silent refresh or a suppressed test row costs nothing.
const rang = (row) => !!row && !row.suppressed && (!row.deduped || row.rung === true);

/**
 * One sweep. Returns counts; never throws for a single bad estimate.
 * `conn` and `raise` are injectable for tests. `ringBudget` is what is left
 * of the run's shared budget (the watchdog passes its remainder); anything
 * that would ring past it goes on the overflow bell instead.
 */
async function runCombinedBookingCheck({ now = new Date(), conn = db, raise, ringBudget = DEFAULT_RING_BUDGET } = {}) {
  const result = { candidates: 0, checked: 0, ok: 0, problems: 0, deferred: 0, skipped: 0, failed: 0, closed: 0, overflow: 0 };
  result.closed += await retireAbandoned(conn);
  const owedBefore = new Set((await overflowEntries(conn)).all);
  // An internal test / demo customer never gets an admin artifact (the
  // notification service suppresses its bells); it is left out before any
  // budgeting, so it can never land on the overflow record either.
  const { isInternalTestCustomerId } = require('./internal-test-customers');
  const candidates = (await candidateQuery(conn, { now, owed: [...owedBefore, ...await standingEstimateIds(conn)] }))
    .filter((estimate) => !isInternalTestCustomerId(estimate.customer_id));
  result.candidates = candidates.length;

  // An OK verdict writes nothing (an `fyi` fact), so every candidate is judged
  // each run. A standing bell's itemKeys say what it already rang for.
  const standing = new Map((await conn('notifications')
    .where({ recipient_type: 'admin', category: CATEGORY })
    .whereRaw("metadata->>'dedupeKey' = ANY(?)", [candidates.map((estimate) => dedupeKeyFor(estimate.id))])
    .select(conn.raw("metadata->>'estimateId' as estimate_id"), conn.raw("metadata->'itemKeys' as item_keys"),
      conn.raw("metadata->'problems' as problems")))
    .map((row) => [String(row.estimate_id), {
      keys: new Set(Array.isArray(row.item_keys) ? row.item_keys : []),
      problems: Array.isArray(row.problems) ? row.problems : [],
    }]));
  // A booking that could not be judged, or whose bell could not be written,
  // goes on the overflow bell: it stays a candidate until it is.
  const owed = [];
  const owe = (estimate, why, { held = false } = {}) => owed.push({
    id: String(estimate.id), held, line: `estimate ${estimate.id} (customer ${estimate.customer_id}): ${why}`,
  });
  const work = candidates.filter((estimate) => {
    try {
      if ((acceptedFamilies(estimate)?.size || 0) >= 2) return true;
      result.skipped += 1;
    } catch (err) {
      result.failed += 1;
      owe(estimate, 'could not be read this run');
      logger.warn(`[combined-booking-check] estimate ${estimate.id} could not be read: ${err.message}`);
    }
    return false;
  });

  // The shared accepted-plan classifier, with no 24h wait: the same findings
  // the watchdog's accepted-schedule alerts are built from, plus which
  // estimates it judged and which families it skipped on each.
  const coverage = new Map();
  const gaps = work.length ? await require('./recurring-schedule-audit')
    .acceptedRecurringScheduleGaps(conn, { now, cutoff: now, estimateIds: work.map((estimate) => estimate.id), coverage }) : [];

  let rings = 0;
  for (const estimate of work) {
    const id = String(estimate.id);
    const known = standing.get(id);
    try {
      const checked = await checkEstimate(conn, estimate, {
        scheduleGaps: gaps.filter((gap) => String(gap.estimateId) === id),
        coverage: coverage.get(id),
      });
      const { outcome, problems, onHold } = outcomeOf(checked?.verdict, known?.problems);
      if (outcome !== 'problems') {
        result[outcome] += 1;
        if (known) result.closed += await retireStanding(conn, [id], outcome === 'skipped' ? RESOLVED_GONE : RESOLVED_FIXED);
        // A service on hold could not be judged: with no open bell to keep it
        // a candidate, the overflow record does (as `held`, no known problem),
        // so it is judged when the hold ends even past the lookback.
        if (onHold && !known) owe(estimate, 'a service is on hold; it is checked again when the hold ends', { held: true });
        continue;
      }
      result.checked += 1;
      const verdict = { ...checked.verdict, problems };
      const { ctx } = checked;
      // Anything that would ring (a new bell, or a standing one gaining a
      // family it did not carry) spends the budget; past it the booking waits
      // on the overflow record and rings on a later run, never refreshed into
      // a read bell in silence.
      const wouldRing = !known || problems.flatMap(problemKeys).some((key) => !known.keys.has(key));
      if (wouldRing && rings >= ringBudget) {
        owe(estimate, `${ctx.customerName}: ${problems.map((problem) => problem.text).join('; ')}`);
        continue;
      }
      const row = await postAlert(estimate, verdict, ctx, { raise });
      if (!row) {
        result.failed += 1;
        owe(estimate, 'its alert could not be written this run');
        logger.warn(`[combined-booking-check] alert write failed for estimate ${id}`);
        continue;
      }
      if (rang(row)) rings += 1;
      result.problems += 1;
    } catch (err) {
      result.failed += 1;
      owe(estimate, 'could not be checked this run');
      logger.warn(`[combined-booking-check] estimate ${id} check failed: ${err.message}`);
    }
  }
  result.overflow = owed.length;
  result.closed += await postOverflow(conn, owed, { raise });
  return result;
}

module.exports = {
  runCombinedBookingCheck,
  checkEstimate,
  evaluateCombinedBooking,
  composeAlert,
  postAlert,
  ringOnNewProblem,
  problemKeys,
  outcomeOf,
  heldProblems,
  owedEstimateIds,
  overflowEntries,
  acceptedFamilies,
  shortName,
  OPS_KEY,
  DONE_WHEN,
};
