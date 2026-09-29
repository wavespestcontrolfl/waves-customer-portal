/**
 * Combined-booking check (owner request 2026-09-29).
 *
 * Every time a customer accepts an estimate with MORE THAN ONE recurring
 * service (pest + lawn, pest + lawn + tree & shrub, pest + rodent, ...), this
 * verifies the resulting schedule and pricing and posts ONE short admin note.
 * The 2026-09-28 defect it guards: companion services were booked with no
 * time and no technician.
 *
 * WHERE IT RUNS: a scheduler sweep (scheduler.js, every 5 minutes, under
 * runExclusive) over accepted estimates that settled at least SETTLE_MINUTES
 * ago, not a hook in the accept route. The accept route is a money path — a
 * hook there could only add latency or a new way to fail it — and a
 * post-commit hook is lost if the process dies right after the commit. The
 * sweep derives everything from committed rows: a crash just means the next
 * tick checks the estimate. No new state is stored beyond the notification
 * row itself (its dedupeKey is the "already checked" marker).
 *
 * WHAT IT CHECKS (each live scheduled_services row from the estimate, its
 * series children included):
 *   1. time + technician: window_start AND technician_id on every row.
 *   2. price: every row after the first day carries an estimated_price > 0
 *      equal to that service's accepted per-visit price (+/- $0.02).
 *   3. first day: each first-day service is covered, either priced itself or
 *      stamped with ONE shared first_application_invoice_id whose
 *      first-application lines total the first-day per-visit prices.
 *   4. visit counts: live visits per service over the 12 months from the
 *      first day match the plan's visits per year (+/- 1).
 * The accepted per-visit price comes from the same lines and rule the
 * converter's own split uses (acceptedRecurringBillingLines +
 * lineAnnualPerVisitAmount). When the lines do not reconcile to the accepted
 * annual total (manual discount, plan credit, cadence change) the exact dollar
 * comparison is skipped for that estimate rather than guessed; "priced $0"
 * and "no invoice" are still reported.
 *
 * ALERTS reuse the admin ops_digest seam (notifyAdmin + the row shape
 * services/ops-digest.js writes): a <=60 char headline, a <=110 char summary,
 * the whole finding in `detail`, a deep link to the customer, dedupeKey per
 * estimate, ring-only-on-news. See OK_RESULT_RINGS to change how OK results
 * surface.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const OPS_KEY = 'combined-booking-check';
const CATEGORY = 'ops_digest';
const HEADLINE_OK = 'Combined booking OK';
const HEADLINE_PROBLEM = 'Combined booking needs a look';
const MAX_SUMMARY_CHARS = 110;

// How OK results surface (the owner's open design choice, one line to flip):
//   'first'  - the first OK result ever rings once (so the owner sees it
//              working after deploy); every later OK goes to the Activity
//              feed quietly. DEFAULT.
//   'always' - every OK result rings the bell.
//   'never'  - OK results are always quiet (Activity feed only).
// Problems always ring; a re-check that finds the same problems stays quiet.
const OK_RESULT_RINGS = 'first';

// Let the accept transaction and its follow-on writes settle before judging.
const SETTLE_MINUTES = 3;
// Estimates accepted longer ago than this are never (re)checked: an old
// problem the office has lived with is not news, and a first run after
// deploy must not turn into a backlog scan.
const LOOKBACK_HOURS = 72;
const MAX_PER_RUN = 25;

const PRICE_TOLERANCE = 0.02;
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
function isPrepaid(row) {
  return Number(row.prepaid_amount) > 0 || !!row.annual_prepay_term_id;
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
  const { inferFrequencyKeyFromEstimateData } = require('./billing-cadence');
  const data = parseJson(estimate.estimate_data);
  if (estimate.accepted_service_mode === 'one_time') return null;
  const lines = acceptedRecurringBillingLines(data);
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

function firstApplicationAmount(invoice) {
  const items = parseJson(invoice.line_items, []);
  if (!Array.isArray(items) || !items.length) return null;
  return Math.round(items.reduce((sum, item) => {
    if (/set-?up fee/i.test(String(item?.description || ''))) return sum;
    const amount = item?.amount ?? (Number(item?.unit_price) * Number(item?.quantity ?? 1));
    return sum + (Number.isFinite(Number(amount)) ? Number(amount) : 0);
  }, 0) * 100) / 100;
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
    return [{ code: 'first_invoice_split', text: `first-day services are on ${invoiceIds.size} different invoices` }];
  }
  const invoice = invoices.get([...invoiceIds][0]);
  if (!invoice || ['void', 'voided', 'cancelled', 'canceled'].includes(String(invoice.status || '').toLowerCase())) {
    return [{ code: 'first_invoice_missing', text: 'first invoice is missing or void' }];
  }
  const billed = firstApplicationAmount(invoice);
  const expected = expectedTotal(stamped, programs);
  facts.firstVisitTotal = expected ?? billed;
  if (expected != null && billed != null && Math.abs(billed - expected) > PRICE_TOLERANCE) {
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

// 4. live visits over the 12 months from the first day match visits per year.
function checkVisitCounts(dated, programs, firstDay) {
  const yearEnd = etDateString(addETDays(parseETDateTime(`${firstDay}T12:00`), 365));
  const counts = new Map();
  for (const row of dated.filter((r) => r.day < yearEnd)) bump(counts, programRowFamilies(row, programs));
  const off = [];
  for (const [family, program] of programs) {
    if (!(program.visits > 0)) continue;
    const have = counts.get(family) || 0;
    if (Math.abs(have - program.visits) > 1) off.push(`${lowerLabel(family)} ${have} of ${program.visits}`);
  }
  return off.length ? [{ code: 'visit_count', text: `visits off plan: ${off.join(', ')}` }] : [];
}

/**
 * Pure verdict for one accepted estimate.
 *   ctx: { estimate, rows, invoices: Map(id -> invoice), technicians: Map(id -> name),
 *          customerName, excludedFamilies: Set }
 * Returns null when the accept is not a multi-service recurring accept (no
 * alert at all), else { ok, problems: [{ code, text }], facts }.
 */
function evaluateCombinedBooking(ctx) {
  const { estimate, invoices = new Map(), technicians = new Map(), excludedFamilies = new Set() } = ctx;
  const accepted = acceptedPrograms(estimate);
  if (!accepted) return null;
  const programs = new Map([...accepted.programs].filter(([family]) => !excludedFamilies.has(family)));
  if (programs.size < 2) return null;

  const rows = (ctx.rows || []).filter((row) => !NOT_LIVE.has(row.status)
    && !row.is_callback && !row.followup_included
    && !(row.is_recurring === false && row.recurring_parent_id)
    && rowFamilies(row).some((family) => programs.has(family)));
  const facts = {
    labels: [...programs.keys()].map(familyLabel),
    customerName: ctx.customerName || null,
    firstDate: null, firstTime: null, tech: null, firstVisitTotal: null,
  };
  if (!rows.length) return { ok: false, problems: [{ code: 'no_visits', text: 'no visits scheduled' }], facts };

  const dated = rows.map((row) => ({ ...row, day: dateOnly(row.scheduled_date) })).sort((a, b) =>
    a.day.localeCompare(b.day) || String(a.id).localeCompare(String(b.id)));
  const firstDay = dated[0].day;
  const firstDayRows = dated.filter((row) => row.day === firstDay && !row.recurring_parent_id);
  const anchor = firstDayRows.find((row) => row.window_start) || firstDayRows[0] || dated[0];
  facts.firstDate = firstDay;
  facts.firstTime = anchor.window_start ? String(anchor.window_start).slice(0, 5) : null;
  facts.tech = anchor.technician_id ? technicians.get(anchor.technician_id) || null : null;

  const stamped = firstDayRows.filter((row) => row.first_application_invoice_id);
  const unstamped = firstDayRows.filter((row) => !row.first_application_invoice_id && !isPrepaid(row));
  const problems = [
    ...checkTimeAndTech(dated, programs),
    ...checkLaterPrices(dated, programs, firstDay),
    ...(stamped.length ? checkStampedFirstDay(stamped, programs, invoices, facts) : []),
    ...(unstamped.length ? checkUnstampedFirstDay(unstamped, programs, facts) : []),
    ...checkVisitCounts(dated, programs, firstDay),
  ];
  return { ok: problems.length === 0, problems, facts };
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
    .select('s.id', 's.status', 's.window_start', 's.technician_id', 's.estimated_price', 's.primary_line_price',
      's.prepaid_amount', 's.annual_prepay_term_id', 's.first_application_invoice_id', 's.is_callback',
      's.followup_included', 's.is_recurring', 's.recurring_parent_id', 's.service_type', 's.service_key_snapshot',
      'catalog.service_key as catalog_service_key', 'catalog.billing_type as catalog_billing_type',
      conn.raw("to_char(s.scheduled_date, 'YYYY-MM-DD') as scheduled_date"));
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

async function checkEstimate(conn, estimate) {
  const ctx = await loadContext(conn, estimate);
  const verdict = evaluateCombinedBooking(ctx);
  return verdict ? { verdict, ctx } : null;
}

function dedupeKeyFor(estimateId) {
  return `${OPS_KEY}:${estimateId}`;
}

// A fresh OK result rings only per OK_RESULT_RINGS.
function okRingGate() {
  if (OK_RESULT_RINGS === 'always') return async () => true;
  if (OK_RESULT_RINGS === 'never') return async () => false;
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
  if (row && verdict.ok && row.refreshed) {
    await conn('notifications').where({ id: row.id }).update({
      read_at: conn.raw('COALESCE(read_at, NOW())'),
      metadata: conn.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({
        resolved: true, resolvedAt: new Date().toISOString(), resolvedBy: OPS_KEY,
      })]),
    });
  }
  return row;
}

/**
 * One sweep. Returns counts; never throws for a single bad estimate.
 * `conn` and `notifier` are injectable for tests.
 */
async function runCombinedBookingCheck({ now = new Date(), conn = db, notifier } = {}) {
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
  const result = { candidates: candidates.length, checked: 0, ok: 0, problems: 0, skipped: 0, failed: 0 };
  if (!candidates.length) return result;

  // An OK verdict is final; a problem is re-checked each sweep (inside the
  // lookback window) so a fix clears the bell.
  const keys = candidates.map((estimate) => dedupeKeyFor(estimate.id));
  const standing = await conn('notifications')
    .where({ recipient_type: 'admin', category: CATEGORY })
    .whereRaw("metadata->>'dedupeKey' = ANY(?)", [keys])
    .select(conn.raw("metadata->>'dedupeKey' as dedupe_key"), conn.raw("metadata->>'checkResult' as check_result"));
  const finished = new Set(standing.filter((row) => row.check_result === 'ok').map((row) => row.dedupe_key));

  for (const estimate of candidates) {
    if (result.checked >= MAX_PER_RUN) break;
    if (finished.has(dedupeKeyFor(estimate.id))) continue;
    try {
      const checked = await checkEstimate(conn, estimate);
      if (!checked) { result.skipped += 1; continue; }
      result.checked += 1;
      const row = await postAlert(conn, estimate, checked.verdict, checked.ctx, { notifier });
      if (!row) { result.failed += 1; logger.warn(`[combined-booking-check] alert write failed for estimate ${estimate.id}`); continue; }
      if (checked.verdict.ok) result.ok += 1; else result.problems += 1;
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
  ringOnNewProblem,
  acceptedPrograms,
  firstApplicationAmount,
  shortName,
  OK_RESULT_RINGS,
  OPS_KEY,
  HEADLINE_OK,
  HEADLINE_PROBLEM,
};
