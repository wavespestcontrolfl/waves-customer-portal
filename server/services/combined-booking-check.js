/**
 * Combined-booking check (owner request 2026-09-29).
 *
 * Every time a customer accepts an estimate with MORE THAN ONE recurring
 * service (pest + lawn, pest + lawn + tree & shrub, pest + rodent, ...), this
 * verifies the resulting schedule and pricing and posts ONE short admin note.
 * The 2026-09-28 defect it guards: companion services were booked with no
 * time and no technician.
 *
 * WHERE IT RUNS: inside the schedule-integrity watchdog (its daily tick, under
 * that job's runExclusive and GATE_SCHEDULE_INTEGRITY_WATCHDOG), over accepted
 * estimates that settled at least SETTLE_MINUTES ago — not a hook in the
 * accept route (a money path: a hook could only add latency or a new way to
 * fail it, and is lost if the process dies right after the commit) and not a
 * second sweep beside the watchdog's own accepted-plan check. The sweep derives
 * everything from committed rows: a crash just means the next run checks the
 * estimate. No state is stored beyond the notification row itself (its
 * dedupeKey is the "already checked" marker).
 *
 * ONE CLASSIFIER FOR THE SCHEDULE SHAPE: whether the right number of visits
 * exist is decided by recurring-schedule-audit's acceptedScheduleFindings (via
 * findAcceptedRecurringScheduleGaps), the same function behind the watchdog's
 * `accepted-schedule:*` alerts. This check never re-derives it: an estimate
 * with such a gap is left to that alert (no second bell for the same problem)
 * and is not declared OK until the gap is gone.
 *
 * WHAT IT CHECKS (each live scheduled_services row from the estimate, its
 * series children included):
 *   1. time + technician: window_start AND technician_id on every row.
 *   2. price: every row after the first day carries an estimated_price > 0
 *      equal to that service's accepted per-visit price (+/- $0.02).
 *   3. first day: each first-day service is covered, either priced itself or
 *      stamped with ONE shared first_application_invoice_id whose
 *      first-application lines total the first-day per-visit prices.
 * The accepted per-visit price comes from the same lines and rule the
 * converter's own split uses (acceptedRecurringBillingLines +
 * lineAnnualPerVisitAmount). When the lines do not reconcile to the accepted
 * annual total (manual discount, plan credit, cadence change) there is no
 * price to compare against (the converter itself declines to split such a
 * plan), so the estimate is never declared OK: "priced $0", "no invoice" and
 * missing time/tech are still reported, and otherwise the check says nothing.
 * A family the shared classifier did not judge (an active plan hold, a
 * stopped series) is left out the same way the duplicate-series guard's
 * retained family is, and an estimate it did not judge at all is never OK.
 *
 * ALERTS reuse the admin ops_digest seam (notifyAdmin + the row shape
 * services/ops-digest.js writes): a <=60 char headline, a <=110 char summary,
 * the whole finding in `detail`, a deep link to the customer, dedupeKey per
 * estimate, ring-only-on-news. OK results go to the Activity feed quietly,
 * except the first OK ever, which rings once.
 */

const db = require('../models/db');
const logger = require('./logger');
const { parseETDateTime } = require('../utils/datetime-et');

const OPS_KEY = 'combined-booking-check';
const CATEGORY = 'ops_digest';
const HEADLINE_OK = 'Combined booking OK';
const HEADLINE_PROBLEM = 'Combined booking needs a look';
const MAX_SUMMARY_CHARS = 110;

// Let the accept transaction and its follow-on writes settle before judging.
const SETTLE_MINUTES = 3;
// Estimates accepted longer ago than this are never (re)checked: an old
// problem the office has lived with is not news, and a first run after
// deploy must not turn into a backlog scan.
const LOOKBACK_HOURS = 72;
// Cap on NEWLY posted rows per run; a standing problem being re-checked never
// counts against it, so it cannot starve a fresh accept.
const MAX_NEW_PER_RUN = 25;

const PRICE_TOLERANCE = 0.02;
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

const cents = (value) => Math.round(Number(value || 0) * 100);
const money = (value) => `$${(cents(value) / 100).toFixed(2)}`;
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
function truncateAtWord(text, max) {
  return require('./ops-digest').truncateAtWord(text, max);
}

function rowPrice(row) {
  const est = Number(row.estimated_price);
  if (est > 0) return est;
  const primary = Number(row.primary_line_price);
  return primary > 0 ? primary : 0;
}
// Prepaid coverage is proven by loadContext (prepaidCoverage): a positive
// out-of-band stamp, or an annual-prepay stamp annualPrepayCoversVisit
// validated against a live paid term. A term id alone proves nothing.
function isPrepaid(row) {
  return row.prepaid_covered === true;
}

/**
 * The accepted recurring programs of an estimate: one unit per seeded service
 * family, with the accepted per-visit price and visits per year when they can
 * be derived. Returns null for a one-time accept or a plan the converter does
 * not auto-schedule. Pure.
 */
function acceptedPrograms(estimate) {
  const converter = require('./estimate-converter');
  const { acceptedRecurringBillingLines } = require('./plan-rate-ledger');
  const { inferFrequencyKeyFromEstimateData, legacyRodentRowPredicateFor } = require('./billing-cadence');
  const data = parseJson(estimate.estimate_data);
  if (estimate.accepted_service_mode === 'one_time') return null;
  // The converter's own service set: the termite station-rental rider is
  // folded into the bait row's price, and legacy rodent rows are dropped,
  // exactly as conversion does before it schedules and prices anything.
  const isLegacyRodentRow = legacyRodentRowPredicateFor(data);
  const lines = converter.foldTermiteRentalIntoBait(acceptedRecurringBillingLines(data))
    .filter((line) => !isLegacyRodentRow(line));
  if (converter.shouldSuppressRecurringConversion({
    monthlyRate: estimate.monthly_total, annualTotal: estimate.annual_total,
    oneTimeTotal: estimate.onetime_total, recurringServices: lines, estimateData: data,
  })) return null;
  const acceptedFrequency = data.customerSelection?.frequency || null;
  const fallback = acceptedFrequency || inferFrequencyKeyFromEstimateData(data);

  const programs = new Map();
  for (const line of lines) {
    const family = converter.seedingFamilyKey(line);
    // Commercial lines, billing riders and contradictory terms are scheduled
    // by the office; they have no auto-seeded cadence to verify here.
    if (!converter.converterFollowUpSeedingPattern(line, {}, fallback, acceptedFrequency)) continue;
    const program = programs.get(family) || { family, perVisit: 0, visits: null, priced: true };
    const perVisit = converter.lineAnnualPerVisitAmount(line, acceptedFrequency);
    if (perVisit > 0) program.perVisit += perVisit; else program.priced = false;
    const visits = converter.acceptedPestSelectionVisits(line, acceptedFrequency)
      ?? converter.visitsPerYearForRecurringService(line);
    if (visits > 0) program.visits = Math.max(program.visits || 0, visits);
    programs.set(family, program);
  }
  // Dollar comparison only when the lines demonstrably add up to what the
  // customer accepted (a manual discount / plan credit / cadence change breaks
  // the equality, and a guessed price would page falsely).
  const annualFromLines = lines.reduce((sum, line) => sum + converter.recurringLineAnnualAmount(line), 0);
  const reconciles = Number(estimate.annual_total) > 0
    && Math.abs(annualFromLines - Number(estimate.annual_total)) <= 1;
  for (const program of programs.values()) {
    if (!reconciles || !program.priced) program.perVisit = null;
    else program.perVisit = Math.round(program.perVisit * 100) / 100;
  }
  return { programs, acceptedFrequency };
}

/** Service families a scheduled row performs (a combined route spans two). */
function rowFamilies(row) {
  const converter = require('./estimate-converter');
  const identity = row.catalog_service_key || row.service_key_snapshot;
  const families = converter.comboRouteFamiliesFromCatalogKey(identity);
  return families.length ? families
    : [converter.seedingFamilyKey({ service: identity, name: row.service_type })];
}

// The service dollars a combined first-application invoice bills: the base
// application lines (the shared invoice.js identity — client_id
// scheduled_<id>_primary, or the "First service application" line) plus the
// price discounts riding beside them. Setup-fee lines, add-ons and payment
// allocations (the deposit_credit line) are not service dollars. null when
// the invoice carries no readable base-application line at all.
function firstApplicationAmount(invoice) {
  const InvoiceService = require('./invoice');
  const items = InvoiceService._parseInvoiceLineItems(invoice.line_items);
  const amountOf = (item) => {
    const raw = item?.amount != null ? Number(item.amount) : Number(item?.unit_price) * Number(item?.quantity ?? 1);
    return Number.isFinite(raw) ? raw : 0;
  };
  const base = items.filter((item) => InvoiceService.lineIsBaseApplication(item) && amountOf(item) > 0);
  if (!base.length) return null;
  const discounts = items.filter((item) => item?.category !== 'deposit_credit' && amountOf(item) < 0);
  return Math.round([...base, ...discounts].reduce((sum, item) => sum + amountOf(item), 0) * 100) / 100;
}

function listFamilies(counts, programs) {
  return [...counts.entries()].map(([family, count]) => `${count} ${lowerLabel(family)}`).join(', ');
}

// Expected per-visit price of a row: the sum over the programs it performs,
// null when any of them has no derivable price.
function expectedFor(row, programs) {
  let total = 0;
  for (const family of rowFamilies(row).filter((f) => programs.has(f))) {
    const perVisit = programs.get(family).perVisit;
    if (perVisit == null) return null;
    total += perVisit;
  }
  return Math.round(total * 100) / 100;
}
function toleranceFor(row, programs) {
  if (row.recurring_parent_id) return PRICE_TOLERANCE;
  // A series parent absorbs the annual's remainder cents (anchored split).
  return PRICE_TOLERANCE + Math.max(...rowFamilies(row).map((f) => programs.get(f)?.visits || 1)) * 0.005;
}
const programRowFamilies = (row, programs) => rowFamilies(row).filter((f) => programs.has(f));
function expectedTotal(list, programs) {
  let total = 0;
  for (const row of list) {
    const expected = expectedFor(row, programs);
    if (expected == null) return null;
    total += expected;
  }
  return Math.round(total * 100) / 100;
}
function bump(map, families) {
  for (const family of families) map.set(family, (map.get(family) || 0) + 1);
}

// 1. time + technician on every live row.
function checkTimeAndTech(dated, programs) {
  const untimed = new Map();
  for (const row of dated) {
    if (!(row.window_start && row.technician_id)) bump(untimed, programRowFamilies(row, programs));
  }
  return untimed.size ? [{ code: 'missing_time_tech', text: `${listFamilies(untimed, programs)} visits missing time/tech` }] : [];
}

// 2. price on every row after the first day.
function checkLaterPrices(dated, programs, firstDay) {
  const zero = new Map();
  const off = new Map();
  const offDetail = [];
  for (const row of dated.filter((r) => r.day > firstDay)) {
    if (isPrepaid(row)) continue;
    // A parent stamped into a combined first-application invoice is covered
    // by it (the converter leaves such companions unpriced on purpose).
    if (row.first_application_invoice_id && !row.recurring_parent_id) continue;
    const price = rowPrice(row);
    const families = programRowFamilies(row, programs);
    if (!(price > 0)) { bump(zero, families); continue; }
    const expected = expectedFor(row, programs);
    if (expected != null && Math.abs(price - expected) > toleranceFor(row, programs)) {
      bump(off, families);
      offDetail.push(`${lowerLabel(families[0])} ${money(price)} vs ${money(expected)}`);
    }
  }
  const problems = [];
  if (zero.size) {
    problems.push({
      code: 'price_missing',
      text: zero.size === 1
        ? `${lowerLabel([...zero.keys()][0])} priced $0 on ${[...zero.values()][0]} visits`
        : `visits priced $0: ${listFamilies(zero, programs)}`,
    });
  }
  if (off.size) {
    problems.push({
      code: 'price_mismatch',
      text: off.size === 1 ? `${offDetail[0]} on ${[...off.values()][0]} visits` : `visit prices off the quote: ${listFamilies(off, programs)}`,
      detail: offDetail.slice(0, 6).join('; '),
    });
  }
  return problems;
}

// 3a. first-day rows stamped into a combined first-application invoice.
function checkStampedFirstDay(stamped, programs, invoices, facts) {
  const invoiceIds = new Set(stamped.map((row) => String(row.first_application_invoice_id)));
  if (invoiceIds.size > 1) {
    return [{ code: 'first_invoice_split', text: `covered services are on ${invoiceIds.size} different invoices` }];
  }
  const invoice = invoices.get([...invoiceIds][0]);
  // A refunded invoice no longer collects the first applications either.
  if (!invoice || ['void', 'voided', 'cancelled', 'canceled', 'refunded'].includes(String(invoice.status || '').toLowerCase())) {
    return [{ code: 'first_invoice_missing', text: 'first invoice is missing, void or refunded' }];
  }
  const billed = firstApplicationAmount(invoice);
  if (billed == null) {
    return [{ code: 'first_invoice_malformed', text: 'first invoice has no readable service lines' }];
  }
  const expected = expectedTotal(stamped, programs);
  facts.firstVisitTotal = expected ?? billed;
  if (expected != null && Math.abs(billed - expected) > PRICE_TOLERANCE) {
    return [{ code: 'first_invoice_mismatch', text: `first invoice ${money(billed)} \u2260 ${money(expected)}` }];
  }
  return [];
}

// 3b. first-day rows with no invoice stamp: priced themselves, or one row
// carrying the combined same-day total.
function checkUnstampedFirstDay(unstamped, programs, facts) {
  const priced = unstamped.filter((row) => rowPrice(row) > 0);
  const expected = expectedTotal(unstamped, programs);
  const paid = Math.round(unstamped.reduce((sum, row) => sum + rowPrice(row), 0) * 100) / 100;
  const sumTolerance = PRICE_TOLERANCE + 0.005 * 12;
  const sumMatches = expected != null && paid > 0 && Math.abs(paid - expected) <= sumTolerance;
  facts.firstVisitTotal = facts.firstVisitTotal ?? expected ?? (paid > 0 ? paid : null);
  if (priced.length < unstamped.length && !sumMatches) {
    const bare = new Set();
    for (const row of unstamped.filter((r) => !(rowPrice(r) > 0))) {
      programRowFamilies(row, programs).forEach((family) => bare.add(family));
    }
    const named = [...programs.keys()].filter((family) => bare.has(family)).map(lowerLabel);
    return [{ code: 'first_day_uncovered', text: `${named.join(' + ') || 'first-day'} first visit has no price or invoice` }];
  }
  const perRowOff = priced.length === unstamped.length && !sumMatches && unstamped.some((row) => {
    const rowExpected = expectedFor(row, programs);
    return rowExpected != null && Math.abs(rowPrice(row) - rowExpected) > toleranceFor(row, programs);
  });
  return perRowOff ? [{ code: 'first_day_price_mismatch', text: `first visit priced ${money(paid)} \u2260 ${money(expected)}` }] : [];
}

/**
 * Pure verdict for one accepted estimate.
 *   ctx: { estimate, rows, invoices: Map(id -> invoice), technicians: Map(id -> name),
 *          customerName, excludedFamilies: Set, scheduleGaps, scheduleSkippedFamilies: Set,
 *          scheduleUnjudged: bool }
 * Returns null when the accept is not a multi-service recurring accept (no
 * alert at all), else { ok, problems: [{ code, text }], facts }.
 */
function evaluateCombinedBooking(ctx) {
  const { estimate, invoices = new Map(), technicians = new Map(), excludedFamilies = new Set() } = ctx;
  const accepted = acceptedPrograms(estimate);
  if (!accepted) return null;
  // Families the shared classifier skipped (active plan hold, stopped series)
  // have no schedule evidence behind them: they leave the check entirely.
  const skipped = ctx.scheduleSkippedFamilies || new Set();
  const programs = new Map([...accepted.programs]
    .filter(([family]) => !excludedFamilies.has(family) && !skipped.has(family)));
  if (programs.size < 2) return null;

  const planRows = (ctx.rows || []).filter((row) => !row.is_callback && !row.followup_included
    && !(row.is_recurring === false && row.recurring_parent_id)
    && rowFamilies(row).some((family) => programs.has(family)));
  const rows = planRows.filter((row) => !NOT_LIVE.has(row.status));
  // Rows were created and every one was cancelled: the customer or office
  // cancelled the plan. Nothing left to verify, so nothing to say.
  if (!rows.length && planRows.length && planRows.every((row) => CANCELLED.has(row.status))) return null;
  const facts = {
    labels: [...programs.keys()].map(familyLabel),
    customerName: ctx.customerName || null,
    firstDate: null, firstTime: null, tech: null, firstVisitTotal: null,
  };
  // Whether the right visits exist at all is the shared accepted-plan
  // classifier's call (ctx.scheduleGaps, from findAcceptedRecurringScheduleGaps
  // — the source of the watchdog's accepted-schedule alerts). A gap there, or
  // no live rows to inspect, means this check says nothing about the schedule
  // shape and never declares the booking OK. Neither does an estimate the
  // classifier did not judge, nor one with no accepted per-visit price to
  // compare against (its problems below are still reported).
  const pricesUnverifiable = [...programs.values()].some((program) => program.perVisit == null);
  const deferred = !rows.length || (ctx.scheduleGaps || []).length > 0 || ctx.scheduleUnjudged === true
    || pricesUnverifiable;
  if (!rows.length) return { ok: false, deferred, problems: [], facts };

  const dated = rows.map((row) => ({ ...row, day: dateOnly(row.scheduled_date) })).sort((a, b) =>
    a.day.localeCompare(b.day) || String(a.id).localeCompare(String(b.id)));
  const firstDay = dated[0].day;
  const firstDayRows = dated.filter((row) => row.day === firstDay && !row.recurring_parent_id);
  const anchor = firstDayRows.find((row) => row.window_start) || firstDayRows[0] || dated[0];
  facts.firstDate = firstDay;
  facts.firstTime = anchor.window_start ? String(anchor.window_start).slice(0, 5) : null;
  facts.tech = anchor.technician_id ? technicians.get(anchor.technician_id) || null : null;

  // The converter stamps EVERY program a combined first-application invoice
  // covers, even a seasonal companion whose first visit lands on a later date,
  // so the invoice is judged against all live top-level rows carrying a stamp.
  const stamped = dated.filter((row) => !row.recurring_parent_id && row.first_application_invoice_id);
  const unstamped = firstDayRows.filter((row) => !row.first_application_invoice_id && !isPrepaid(row));
  const problems = [
    ...checkTimeAndTech(dated, programs),
    ...checkLaterPrices(dated, programs, firstDay),
    ...(stamped.length ? checkStampedFirstDay(stamped, programs, invoices, facts) : []),
    ...(unstamped.length ? checkUnstampedFirstDay(unstamped, programs, facts) : []),
  ];
  return { ok: problems.length === 0 && !deferred, deferred, problems, facts };
}

function shortName(customer) {
  const first = String(customer?.first_name || '').trim();
  const last = String(customer?.last_name || '').trim();
  if (first && last) return `${first[0].toUpperCase()}. ${last}`;
  return last || first || 'Customer';
}

function formatDay(day) {
  const date = parseETDateTime(`${day}T12:00`);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })
    .format(date).replace(',', '');
}

/** Headline / summary / detail text for a verdict. Pure. */
function composeAlert(verdict, { customerName }) {
  const name = customerName || 'Customer';
  const { facts } = verdict;
  if (verdict.ok) {
    const parts = [facts.labels.join(' + ')];
    if (facts.firstDate) parts.push([formatDay(facts.firstDate), facts.firstTime].filter(Boolean).join(' '));
    if (facts.tech) parts.push(String(facts.tech).split(/\s+/)[0]);
    if (facts.firstVisitTotal > 0) parts.push(`${money(facts.firstVisitTotal)} first visit`);
    return {
      headline: HEADLINE_OK,
      summary: truncateAtWord(`${name} — ${parts.join(' · ')}`, MAX_SUMMARY_CHARS),
      detail: `${name}: ${facts.labels.join(' + ')} booking verified. Every visit has a time and technician, prices match the accepted plan, the first day is covered and visit counts match the plan.`,
    };
  }
  const texts = verdict.problems.map((problem) => problem.text);
  return {
    headline: HEADLINE_PROBLEM,
    summary: truncateAtWord(`${name} — ${texts.slice(0, 2).join('; ')}${texts.length > 2 ? ` (+${texts.length - 2} more)` : ''}`, MAX_SUMMARY_CHARS),
    detail: [`${name}: ${facts.labels.join(' + ')} booking needs a look.`,
      ...verdict.problems.map((problem) => `- ${problem.text}${problem.detail ? ` (${problem.detail})` : ''}`)].join('\n'),
  };
}

// --- database side ---------------------------------------------------------

// Sets row.prepaid_covered from the same authorities the completion path
// trusts: a positive out-of-band stamp (cash/check/Zelle) or an annual-prepay
// stamp that annualPrepayCoversVisit validates against a live, paid term
// (fail-closed: an unverifiable stamp reads as not covered).
async function markPrepaidCoverage(conn, rows) {
  const { annualPrepayCoversVisit } = require('./annual-prepay-renewals');
  const { hasOutOfBandPrepaidStamp } = require('./schedule-integrity-watchdog');
  for (const row of rows) {
    row.prepaid_covered = false;
    if (hasOutOfBandPrepaidStamp(row)) { row.prepaid_covered = true; continue; }
    if (!row.annual_prepay_term_id && !(Number(row.prepaid_amount) > 0)) continue;
    try {
      row.prepaid_covered = await annualPrepayCoversVisit(row, conn) === true;
    } catch (err) {
      logger.warn(`[combined-booking-check] prepay coverage unverifiable for a visit: ${err.message}`);
    }
  }
}

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
    // Whole row: annualPrepayCoversVisit validates coverage from the row itself.
    .select('s.*', 'catalog.service_key as catalog_service_key', 'catalog.billing_type as catalog_billing_type',
      conn.raw("to_char(s.scheduled_date, 'YYYY-MM-DD') as scheduled_date"));
  await markPrepaidCoverage(conn, rows);
  const invoiceIds = [...new Set(rows.map((row) => row.first_application_invoice_id).filter(Boolean))];
  const invoices = new Map();
  if (invoiceIds.length) {
    for (const invoice of await conn('invoices').whereIn('id', invoiceIds).select('id', 'status', 'total', 'subtotal', 'line_items')) {
      invoices.set(String(invoice.id), invoice);
    }
  }
  const techIds = [...new Set(rows.map((row) => row.technician_id).filter(Boolean))];
  const technicians = new Map();
  if (techIds.length) {
    for (const tech of await conn('technicians').whereIn('id', techIds).select('id', 'name')) technicians.set(tech.id, tech.name);
  }
  const customer = await conn('customers').where({ id: customerId }).first('first_name', 'last_name');
  return {
    estimate,
    rows: rows.filter((row) => row.catalog_billing_type !== 'one_time'),
    invoices, technicians, excludedFamilies, customerName: shortName(customer),
  };
}

async function checkEstimate(conn, estimate, { scheduleGaps = [], scheduleSkippedFamilies = new Set(), scheduleUnjudged = false } = {}) {
  const ctx = { ...await loadContext(conn, estimate), scheduleGaps, scheduleSkippedFamilies, scheduleUnjudged };
  const verdict = evaluateCombinedBooking(ctx);
  return verdict ? { verdict, ctx } : null;
}

function dedupeKeyFor(estimateId) {
  return `${OPS_KEY}:${estimateId}`;
}

// A fresh OK result rings only if no OK was ever posted before: the first one
// after deploy shows the owner it is working, every later one is a quiet
// Activity-feed row.
function okRingGate() {
  return async (conn) => {
    const prior = await conn('notifications')
      .where({ recipient_type: 'admin', category: CATEGORY })
      .whereRaw("metadata->>'alertClass' = ?", [OPS_KEY])
      .whereRaw("metadata->>'checkResult' = 'ok'")
      .first('id');
    return !prior;
  };
}

// A refresh rings only when a problem is new: one the standing row did not
// already carry, or a problem coming back after the row had cleared.
function ringOnNewProblem(codes) {
  return (existing, existingMeta) => {
    if (existingMeta?.resolved === true || existingMeta?.checkResult !== 'problem') return true;
    const known = new Set(Array.isArray(existingMeta.problemCodes) ? existingMeta.problemCodes : []);
    return codes.some((code) => !known.has(code));
  };
}

// Retires a bell the way resolveOpsDigest retires a cleared finding: read plus
// a resolved stamp; the row stays in the Activity feed as history.
function resolvedPatch(conn) {
  return {
    read_at: conn.raw('COALESCE(read_at, NOW())'),
    metadata: conn.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({
      resolved: true, resolvedAt: new Date().toISOString(), resolvedBy: OPS_KEY,
    })]),
  };
}
const retireRow = (conn, id) => conn('notifications').where({ id }).update(resolvedPatch(conn));
const retireStanding = (conn, estimateId) => conn('notifications')
  .where({ recipient_type: 'admin', category: CATEGORY })
  .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKeyFor(estimateId)])
  .whereRaw("COALESCE(metadata->>'resolved', '') <> 'true'")
  .update(resolvedPatch(conn));

async function postAlert(conn, estimate, verdict, ctx, { notifier } = {}) {
  const notificationService = notifier || require('./notification-service');
  const { digestRowFields } = require('./ops-digest');
  const text = composeAlert(verdict, { customerName: ctx.customerName });
  const fields = digestRowFields({
    subject: `${verdict.ok ? 'FYI' : 'ACT'}: ${text.headline}`,
    text: text.detail, headline: text.headline, summary: text.summary, audience: 'owner',
  });
  const codes = verdict.problems.map((problem) => problem.code);
  const row = await notificationService.notifyAdmin(CATEGORY, fields.title, fields.body, {
    link: `/admin/customers?customerId=${encodeURIComponent(estimate.customer_id)}`,
    // Persist tag for GATE_ADMIN_BELL_POLICY, not a ring: bell visibility is
    // metadata.feed / quiet below (same as ops-digest.js's deliverOpsDigest).
    bell: true,
    detail: fields.detail,
    dedupeKey: dedupeKeyFor(estimate.id),
    refreshOnDedupe: true,
    ringGate: verdict.ok ? okRingGate() : async () => true,
    ringOnRefresh: verdict.ok ? () => false : ringOnNewProblem(codes),
    metadata: {
      opsKey: OPS_KEY,
      subject: `${verdict.ok ? 'FYI' : 'ACT'}: ${text.headline}`,
      alertClass: OPS_KEY,
      estimateId: estimate.id,
      customerId: estimate.customer_id,
      checkResult: verdict.ok ? 'ok' : 'problem',
      problemCodes: codes,
      // count + itemKeys are the ring-stamps notifyAdmin compares on a
      // refresh, so a changed problem set is treated as a real change.
      count: codes.length,
      itemKeys: codes,
      kind: fields.kind,
      audience: fields.audience,
      feed: fields.feed,
      quiet: false,
    },
  });
  // A problem that has since been fixed: the standing bell is retired the way
  // resolveOpsDigest retires a cleared finding (read + resolved stamp; the row
  // stays in the Activity feed as history).
  if (row && verdict.ok && row.refreshed) await retireRow(conn, row.id);
  return row;
}

/**
 * One sweep. Returns counts; never throws for a single bad estimate.
 * `conn` and `notifier` are injectable for tests.
 */
async function runCombinedBookingCheck({ now = new Date(), conn = db, notifier, maxNew = MAX_NEW_PER_RUN } = {}) {
  const settled = new Date(now.getTime() - SETTLE_MINUTES * 60 * 1000);
  const since = new Date(now.getTime() - LOOKBACK_HOURS * 3600 * 1000);
  const candidates = await conn('estimates as e')
    .join('customers as c', 'c.id', 'e.customer_id')
    .where('e.status', 'accepted').whereNull('e.archived_at')
    .where('e.accepted_at', '<=', settled).where('e.accepted_at', '>', since)
    .where('c.active', true).whereNull('c.deleted_at')
    .where(function recurringAccept() {
      this.whereNull('e.accepted_service_mode').orWhereNot('e.accepted_service_mode', 'one_time');
    })
    .select('e.id', 'e.customer_id', 'e.property_id', 'e.estimate_data', 'e.accepted_service_mode', 'e.accepted_at',
      'e.monthly_total', 'e.annual_total', 'e.onetime_total')
    .orderBy('e.accepted_at', 'asc');
  const result = { candidates: candidates.length, checked: 0, ok: 0, problems: 0, deferred: 0, skipped: 0, failed: 0 };
  if (!candidates.length) return result;

  // An OK verdict is final; a posted problem is re-checked each run (inside the
  // lookback window) so a fix clears the bell.
  const keys = candidates.map((estimate) => dedupeKeyFor(estimate.id));
  const standing = await conn('notifications')
    .where({ recipient_type: 'admin', category: CATEGORY })
    .whereRaw("metadata->>'dedupeKey' = ANY(?)", [keys])
    .select(conn.raw("metadata->>'dedupeKey' as dedupe_key"), conn.raw("metadata->>'checkResult' as check_result"));
  const finished = new Set(standing.filter((row) => row.check_result === 'ok').map((row) => row.dedupe_key));
  const standingProblems = new Set(standing.filter((row) => row.check_result === 'problem').map((row) => row.dedupe_key));

  // Multi-service accepts still to judge. Fresh accepts first (oldest first),
  // then standing problems: the cap below counts only rows newly posted, so
  // an old unresolved problem can never starve a newer accept.
  const work = [];
  for (const estimate of candidates) {
    if (finished.has(dedupeKeyFor(estimate.id))) continue;
    try {
      const accepted = acceptedPrograms(estimate);
      if (accepted && accepted.programs.size >= 2) work.push(estimate);
      else result.skipped += 1;
    } catch (err) {
      result.failed += 1;
      logger.warn(`[combined-booking-check] estimate ${estimate.id} could not be read: ${err.message}`);
    }
  }
  work.sort((a, b) => Number(standingProblems.has(dedupeKeyFor(a.id))) - Number(standingProblems.has(dedupeKeyFor(b.id))));
  if (!work.length) return result;

  // The shared accepted-plan classifier, with no 24h wait: the same findings
  // the watchdog's accepted-schedule alerts are built from, plus which
  // estimates it judged and which families it skipped on each.
  const coverage = new Map();
  const gaps = await require('./recurring-schedule-audit')
    .findAcceptedRecurringScheduleGaps({ now, settleMs: 0, estimateIds: work.map((estimate) => estimate.id), coverage }, conn);
  const gapsByEstimate = new Map();
  for (const gap of gaps) gapsByEstimate.set(String(gap.estimateId), [...(gapsByEstimate.get(String(gap.estimateId)) || []), gap]);

  let posted = 0;
  for (const estimate of work) {
    const key = dedupeKeyFor(estimate.id);
    const isNew = !standingProblems.has(key);
    if (isNew && posted >= maxNew) continue; // the rest post next run
    try {
      const judged = coverage.get(String(estimate.id));
      const checked = await checkEstimate(conn, estimate, {
        scheduleGaps: gapsByEstimate.get(String(estimate.id)) || [],
        scheduleSkippedFamilies: judged || new Set(),
        scheduleUnjudged: !judged,
      });
      if (!checked) {
        result.skipped += 1;
        // A standing problem bell for a plan that has since been cancelled has
        // nothing left to act on: retire it the way a fixed problem is.
        if (!isNew) await retireStanding(conn, estimate.id);
        continue;
      }
      const { verdict } = checked;
      if (!verdict.ok && !verdict.problems.length) {
        // Nothing of this check's own to say (the schedule shape belongs to the
        // accepted-schedule alert). A bell rung earlier for problems that have
        // since been fixed is retired.
        result.deferred += 1;
        if (!isNew) await retireStanding(conn, estimate.id);
        continue;
      }
      result.checked += 1;
      const row = await postAlert(conn, estimate, verdict, checked.ctx, { notifier });
      if (!row) { result.failed += 1; logger.warn(`[combined-booking-check] alert write failed for estimate ${estimate.id}`); continue; }
      if (isNew) posted += 1;
      if (verdict.ok) result.ok += 1; else result.problems += 1;
    } catch (err) {
      result.failed += 1;
      logger.warn(`[combined-booking-check] estimate ${estimate.id} check failed: ${err.message}`);
    }
  }
  return result;
}

module.exports = {
  runCombinedBookingCheck,
  checkEstimate,
  evaluateCombinedBooking,
  composeAlert,
  postAlert,
  markPrepaidCoverage,
  ringOnNewProblem,
  acceptedPrograms,
  firstApplicationAmount,
  shortName,
  OPS_KEY,
  HEADLINE_OK,
  HEADLINE_PROBLEM,
};
