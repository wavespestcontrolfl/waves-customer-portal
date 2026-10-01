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
 * estimate. No state is stored beyond a problem's bell; every accept inside
 * the lookback is judged again each run.
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
 * ALERTS follow docs/admin-notifications.md through raiseAdminAlert: a problem
 * is one needs-you Schedule bell per estimate ("Schedule — fix <name>'s
 * combined booking", a one-sentence why, the customer link, subject = the
 * estimate, done when combined_booking_verified), the whole finding in
 * `detail`, ringing again only when a new problem joins. A fixed problem, a
 * cancelled plan, or a customer / estimate that left for good closes the bell
 * as DONE. An OK result is an `fyi` fact and writes no row.
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
const RESOLVED_GONE = 'Closed: the plan was cancelled, or the estimate or customer is no longer active';

// Let the accept transaction and its follow-on writes settle before judging.
const SETTLE_MINUTES = 3;
// Estimates accepted longer ago than this are never (re)checked: an old
// problem the office has lived with is not news, and a first run after
// deploy must not turn into a backlog scan.
const LOOKBACK_HOURS = 72;

const PRICE_TOLERANCE = 0.02;
// Problems that need an accepted price to compare against: when that price
// cannot be verified (the verdict is deferred) they are not looked for, so a
// standing bell carrying one is left open rather than closed as fixed.
const COMPARISON_CODES = new Set(['price_mismatch', 'first_invoice_mismatch', 'split_invoice_mismatch', 'first_day_price_mismatch']);
const CANCELLED = new Set(['cancelled', 'canceled']);
const NOT_LIVE = new Set(['cancelled', 'canceled', 'rescheduled', 'skipped', 'no_show']);
// A visit parked as `rescheduled` (the legacy customer reschedule path) is out
// of the schedule checks but still billed on its original invoice.
const OFF_INVOICE = new Set(['cancelled', 'canceled', 'skipped', 'no_show']);

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

// The visit's own price exactly as completion bills it (billing-lane.js
// completionInvoiceAmount's first rule): estimated_price, nothing else. A
// primary_line_price with no estimated_price is never billed on its own.
function rowPrice(row) {
  const est = Number(row.estimated_price);
  return est > 0 ? est : 0;
}
// A visit needs no price of its own when it is prepaid (markPrepaidCoverage):
//  - an annual-prepay stamp annualPrepayCoversVisit validated against a live
//    paid term (prepaid_covered; a term id alone proves nothing);
//  - an out-of-band payment (prepaid_out_of_band) only when the visit carries
//    no price of its own AND the payment meets the ACCEPTED price; a visit
//    that is priced keeps its price check (completion bills the rest of a
//    partial payment, and the visit price is what this check verifies).
//    With no accepted price to compare, the payment proves nothing and the
//    visit stays visible as unpriced.
function isPrepaid(row, programs) {
  if (row.prepaid_covered === true) return true;
  const paid = Number(row.prepaid_out_of_band);
  if (!(paid > 0) || rowPrice(row) > 0) return false;
  const expected = expectedFor(row, programs);
  return expected != null && paid + 0.005 >= expected;
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
  // WHICH programs are scheduled comes from the converter's own scheduling
  // units (combineRecurringServicesForScheduling, the same call the
  // accepted-plan classifier makes): a legacy rodent program dropped from the
  // lines above rides back in as a supplement unit, exactly as conversion
  // schedules it. Their PRICES come from the accepted billing lines, never the
  // units (a standalone unit is a scheduling-only rewrite with no price); a
  // supplement counts only for a family no line already bills, the same
  // de-duplication the combiner applies.
  const family = (line) => converter.seedingFamilyKey(line);
  const supplements = converter.supplementalCompanionLines(data);
  const { remaining, combos, standalone } = converter.combineRecurringServicesForScheduling(lines, {
    acceptFrequency: acceptedFrequency, supplementalCompanions: supplements,
  });
  const scheduled = new Set([
    ...[...remaining, ...standalone.map((unit) => unit.service)].map((service) => [service, [service]]),
    ...combos.map((combo) => [combo.service, combo.combinedFrom]),
  ]
    // Commercial lines, billing riders and contradictory terms are scheduled
    // by the office; they have no auto-seeded cadence to verify here.
    .filter(([service]) => converter.converterFollowUpSeedingPattern(service, {}, fallback, acceptedFrequency))
    .flatMap(([, sources]) => sources.map(family)));
  const lineFamilies = new Set(lines.map(family));
  // A supplement is the legacy rodent plan, billed as MONTHLY DUES that cover
  // its visits (estimate-converter.js isPinnedLegacyRodentOnlyPlan): its
  // visits carry no per-visit price of their own, so it is expected at $0.
  const dues = new Set(supplements.map(family).filter((key) => !lineFamilies.has(key)));
  const billed = [...lines, ...supplements.filter((line) => dues.has(family(line)))];

  const programs = new Map();
  for (const key of scheduled) {
    if (dues.has(key)) { programs.set(key, { family: key, perVisit: 0, visits: null, dues: true }); continue; }
    const sources = billed.filter((line) => family(line) === key);
    const perVisits = sources.map((line) => converter.lineAnnualPerVisitAmount(line, acceptedFrequency));
    const visits = Math.max(0, ...sources.map((line) => converter.acceptedPestSelectionVisits(line, acceptedFrequency)
      ?? converter.visitsPerYearForRecurringService(line) ?? 0));
    programs.set(key, {
      family: key,
      perVisit: perVisits.length && perVisits.every((amount) => amount > 0) ? perVisits.reduce((a, b) => a + b, 0) : null,
      visits: visits || null,
    });
  }
  // Dollar comparison only when the billed lines demonstrably add up to what
  // the customer accepted (a manual discount / plan credit / cadence change
  // breaks the equality, and a guessed price would page falsely).
  const annualFromLines = billed.reduce((sum, line) => sum + converter.recurringLineAnnualAmount(line), 0);
  const reconciles = Number(estimate.annual_total) > 0
    && Math.abs(annualFromLines - Number(estimate.annual_total)) <= 1;
  for (const program of programs.values()) {
    if (program.dues) continue;
    program.perVisit = reconciles && program.perVisit != null ? Math.round(program.perVisit * 100) / 100 : null;
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
  // An invoice-mode recurring accept (estimate-public.js
  // buildEstimateInvoiceModeDraft, recognized by
  // isInvoiceModeRecurringAcceptInvoice) bills the first visit as one
  // "<services> (<cadence> recurring — first <visit>)" line with no
  // _primary client id; that line is the service dollars, and anything the
  // office added beside it is not.
  const { isInvoiceModeRecurringAcceptInvoice } = require('./estimate-first-application-invoice');
  const isBase = isInvoiceModeRecurringAcceptInvoice(invoice)
    ? (item) => /\brecurring\s+[\u2014-]\s+first\b/i.test(String(item?.description || ''))
    : (item) => InvoiceService.lineIsBaseApplication(item);
  const base = items.filter((item) => isBase(item) && amountOf(item) > 0);
  if (!base.length) return null;
  // A discount scoped to one line (discount_for = that line's client_id)
  // counts only when that line is a base application; an add-on's discount
  // is the add-on's. Unscoped discounts ride the whole invoice.
  const baseIds = new Set(base.map((item) => item?.client_id).filter(Boolean).map(String));
  const discounts = items.filter((item) => item?.category !== 'deposit_credit' && amountOf(item) < 0
    && (!item?.discount_for || baseIds.has(String(item.discount_for))));
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
// A row whose every program is billed as monthly dues has no visit price to check.
const duesOnly = (row, programs) => programRowFamilies(row, programs).every((f) => programs.get(f).dues);
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

// 2. price on every series child (whatever its date: with the first visits
// cancelled, a child can be the earliest live row) and every top-level row
// after the first day.
function checkLaterPrices(dated, programs, firstDay) {
  const zero = new Map();
  const off = new Map();
  const offDetail = [];
  for (const row of dated.filter((r) => r.recurring_parent_id || r.day > firstDay)) {
    if (isPrepaid(row, programs) || duesOnly(row, programs)) continue;
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
function checkStampedFirstDay(stamped, programs, invoices) {
  const invoiceIds = new Set(stamped.map((row) => String(row.first_application_invoice_id)));
  if (invoiceIds.size > 1) {
    return [{ code: 'first_invoice_split', text: `covered services are on ${invoiceIds.size} different invoices` }];
  }
  const invoice = invoices.get([...invoiceIds][0]);
  // A refunded invoice no longer collects the first applications either.
  if (!invoice || ['void', 'voided', 'cancelled', 'canceled', 'refunded'].includes(String(invoice.status || '').toLowerCase())) {
    return [{ code: 'first_invoice_missing', text: 'first invoice is missing, void or refunded' }];
  }
  if (invoice.unbacked_discount) return [];
  const billed = firstApplicationAmount(invoice);
  if (billed == null) {
    return [{ code: 'first_invoice_malformed', text: 'first invoice has no readable service lines' }];
  }
  const expected = expectedTotal(stamped, programs);
  if (expected != null && Math.abs(billed - expected) > PRICE_TOLERANCE) {
    return [{ code: 'first_invoice_mismatch', text: `first invoice ${money(billed)} \u2260 ${money(expected)}` }];
  }
  return [];
}

// 3c. members split off onto their own invoice: each bills its own accepted
// first-application price.
function checkSplitInvoices(split, programs) {
  const off = [];
  for (const row of split) {
    const expected = expectedFor(row, programs);
    const billed = row.own_first_invoice && !row.own_first_invoice.unbacked_discount
      ? firstApplicationAmount(row.own_first_invoice) : null;
    if (expected != null && billed != null && Math.abs(billed - expected) > PRICE_TOLERANCE) {
      off.push(`${lowerLabel(programRowFamilies(row, programs)[0])} ${money(billed)} vs ${money(expected)}`);
    }
  }
  return off.length ? [{ code: 'split_invoice_mismatch', text: `split first invoice ${off[0]}`, detail: off.join('; ') }] : [];
}

// 3b. first-day rows with no invoice stamp: priced themselves, or one row
// carrying the combined same-day total.
function checkUnstampedFirstDay(unstamped, programs) {
  const priced = unstamped.filter((row) => rowPrice(row) > 0);
  const expected = expectedTotal(unstamped, programs);
  const paid = Math.round(unstamped.reduce((sum, row) => sum + rowPrice(row), 0) * 100) / 100;
  const sumTolerance = PRICE_TOLERANCE + 0.005 * 12;
  const sumMatches = expected != null && paid > 0 && Math.abs(paid - expected) <= sumTolerance;
  if (priced.length < unstamped.length && !sumMatches) {
    const bare = new Set();
    for (const row of unstamped.filter((r) => !(rowPrice(r) > 0))) {
      programRowFamilies(row, programs).forEach((family) => bare.add(family));
    }
    const named = [...programs.keys()].filter((family) => bare.has(family)).map(lowerLabel);
    return [{ code: 'first_day_uncovered', text: `${named.join(' + ') || 'first-day'} first visit has no price or invoice` }];
  }
  // Every row priced itself: completion bills each row's own price, so each is
  // judged on its own (offsetting errors must not pass on a matching sum).
  if (priced.length < unstamped.length) return [];
  const off = unstamped.filter((row) => {
    const rowExpected = expectedFor(row, programs);
    return rowExpected != null && Math.abs(rowPrice(row) - rowExpected) > toleranceFor(row, programs);
  }).map((row) => `${lowerLabel(programRowFamilies(row, programs)[0])} ${money(rowPrice(row))} vs ${money(expectedFor(row, programs))}`);
  return off.length ? [{ code: 'first_day_price_mismatch', text: `first visit ${off[0]}`, detail: off.join('; ') }] : [];
}

/**
 * Pure verdict for one accepted estimate.
 *   ctx: { estimate, rows, invoices: Map(id -> invoice), customerName,
 *          excludedFamilies: Set, scheduleGaps, scheduleSkippedFamilies: Set,
 *          scheduleUnjudged: bool }
 * Returns null when the accept is not a multi-service recurring accept (no
 * alert at all), else { ok, deferred, problems: [{ code, text }], labels }.
 */
function evaluateCombinedBooking(ctx) {
  const {
    estimate, rows: allRows = [], invoices = new Map(), excludedFamilies = new Set(),
    scheduleGaps = [], scheduleSkippedFamilies = new Set(), scheduleUnjudged = false,
  } = ctx;
  const accepted = acceptedPrograms(estimate);
  if (!accepted) return null;
  // Families the shared classifier skipped (active plan hold, stopped series)
  // have no schedule evidence behind them: they leave the check entirely.
  const programs = new Map([...accepted.programs]
    .filter(([family]) => !excludedFamilies.has(family) && !scheduleSkippedFamilies.has(family)));
  if (programs.size < 2) return null;

  const isPlanRow = (row, scope) => !row.is_callback && !row.followup_included
    && !(row.is_recurring === false && row.recurring_parent_id)
    && rowFamilies(row).some((family) => scope.has(family));
  const planRows = allRows.filter((row) => isPlanRow(row, programs));
  const rows = planRows.filter((row) => !NOT_LIVE.has(row.status));
  // Rows were created and every one was cancelled: the customer or office
  // cancelled the plan. Nothing left to verify, so nothing to say.
  if (!rows.length && planRows.length && planRows.every((row) => CANCELLED.has(row.status))) return null;
  const labels = [...programs.keys()].map(familyLabel);
  // No live rows: the schedule shape is the accepted-schedule alert's.
  if (!rows.length) return { ok: false, deferred: true, pricesHidden: false, problems: [], labels };

  // A combined first-application invoice still bills a family left out above
  // (a held tree program's first visit stays on it), so the invoice is judged
  // against every accepted family it covers, not only the ones still checked.
  // A member the office has since split off onto its own invoice (the
  // sibling-split workflow's resolution evidence, has_own_live_invoice) is
  // covered by that invoice, not the combined one.
  const topLevel = allRows.filter((row) => !row.recurring_parent_id && !OFF_INVOICE.has(row.status));
  const stamped = topLevel.filter((row) => isPlanRow(row, accepted.programs)
    && row.first_application_invoice_id && !row.has_own_live_invoice);
  const split = topLevel.filter((row) => isPlanRow(row, programs) && row.has_own_live_invoice && !NOT_LIVE.has(row.status));
  // Prices are judged against the WHOLE accepted plan: a combined row (lawn +
  // tree) still bills a left-out family's share, and so does the shared
  // invoice. `programs` above scopes only which rows are checked.
  const priced = accepted.programs;
  const pricesUnverifiable = [...rows, ...stamped].flatMap(rowFamilies)
    .some((family) => priced.has(family) && priced.get(family).perVisit == null);
  // Whether the right visits exist at all is the shared accepted-plan
  // classifier's call (scheduleGaps, from findAcceptedRecurringScheduleGaps —
  // the source of the watchdog's accepted-schedule alerts). A gap there means
  // this check says nothing about the schedule shape and never declares the
  // booking OK. Neither does an estimate the classifier did not judge, nor one
  // with no accepted per-visit price to compare against (its problems below
  // are still reported).
  const unbackedDiscount = [...stamped.map((row) => invoices.get(String(row.first_application_invoice_id))),
    ...split.map((row) => row.own_first_invoice)].some((invoice) => invoice?.unbacked_discount);
  // pricesHidden: the price comparisons below were not looked for.
  const pricesHidden = pricesUnverifiable || unbackedDiscount;
  const deferred = scheduleGaps.length > 0 || scheduleUnjudged || pricesHidden;

  const dated = rows.map((row) => ({ ...row, day: dateOnly(row.scheduled_date) })).sort((a, b) =>
    a.day.localeCompare(b.day) || String(a.id).localeCompare(String(b.id)));
  const firstDay = dated[0].day;
  // The converter stamps EVERY program a combined first-application invoice
  // covers, even a seasonal companion whose first visit lands on a later date,
  // so the invoice is judged against all live top-level rows carrying a stamp
  // (`stamped`, above).
  const unstamped = dated.filter((row) => row.day === firstDay && !row.recurring_parent_id
    && !row.first_application_invoice_id && !row.has_own_live_invoice && !isPrepaid(row, priced) && !duesOnly(row, priced));
  const problems = [
    ...checkTimeAndTech(dated, programs),
    ...checkLaterPrices(dated, priced, firstDay),
    ...(stamped.length ? checkStampedFirstDay(stamped, priced, invoices) : []),
    ...(unstamped.length ? checkUnstampedFirstDay(unstamped, priced) : []),
    ...checkSplitInvoices(split, priced),
  ];
  return { ok: problems.length === 0 && !deferred, deferred, pricesHidden, problems, labels };
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
  const texts = verdict.problems.map((problem) => problem.text);
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
    detail: [`${customerName || 'Customer'}: ${verdict.labels.join(' + ')} booking needs a look.`,
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
    // An out-of-band payment is judged against the accepted price (isPrepaid).
    if (hasOutOfBandPrepaidStamp(row)) { row.prepaid_out_of_band = Number(row.prepaid_amount); continue; }
    if (!row.annual_prepay_term_id && !(Number(row.prepaid_amount) > 0)) continue;
    try {
      row.prepaid_covered = await annualPrepayCoversVisit(row, conn) === true;
    } catch (err) {
      logger.warn(`[combined-booking-check] prepay coverage unverifiable for a visit: ${err.message}`);
    }
  }
}

// Loads every stamped combined invoice and the live invoices on its members'
// own rows, then classifies them the way first-application-sibling-split.js
// does: the GOVERNING invoice (resolveGoverningInvoice — the stamped one, or a
// live base-application replacement on its anchor once it went void/refunded)
// is what the combined members are judged against, keyed by the stamped id;
// any OTHER live base-application invoice on a member's own row is that
// member's split-off invoice (flagOwnLiveInvoices' evidence:
// row.has_own_live_invoice + row.own_first_invoice).
async function loadFirstInvoices(conn, rows) {
  const invoices = new Map();
  const stamped = rows.filter((row) => row.first_application_invoice_id && !row.recurring_parent_id);
  if (!stamped.length) return invoices;
  const InvoiceService = require('./invoice');
  const { invoiceBillsBaseApplication } = require('./estimate-first-application-invoice');
  const { resolveGoverningInvoice } = require('./first-application-sibling-split');
  const columns = ['id', 'status', 'total', 'subtotal', 'discount_amount', 'line_items', 'notes', 'scheduled_service_id', 'created_at'];
  const stampedIds = [...new Set(stamped.map((row) => String(row.first_application_invoice_id)))];
  const stampedInvoices = await conn('invoices').whereIn('id', stampedIds).select(columns);
  const ownerIds = [...new Set([...stamped.map((row) => String(row.id)),
    ...stampedInvoices.map((invoice) => invoice.scheduled_service_id).filter(Boolean).map(String)])];
  const live = await conn('invoices').whereIn('scheduled_service_id', ownerIds)
    .whereNotIn('status', InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES).select(columns);
  const governingIds = new Set(stampedIds);
  for (const invoice of stampedInvoices) {
    const onAnchor = live.filter((other) => String(other.id) !== String(invoice.id)
      && String(other.scheduled_service_id) === String(invoice.scheduled_service_id));
    const governing = resolveGoverningInvoice(invoice, onAnchor);
    invoices.set(String(invoice.id), governing);
    governingIds.add(String(governing.id));
  }
  // A document-level discount (create()'s discountIds picks) is stored in
  // discount_amount with no negative line: the lines alone cannot give the
  // net application amount, so such an invoice is never certified.
  const { _invoiceHasUnbackedDocumentDiscount: unbacked } = InvoiceService;
  for (const invoice of [...stampedInvoices, ...live]) {
    invoice.unbacked_discount = await unbacked(invoice, invoice.line_items, conn);
  }
  const byRow = new Map(stamped.map((row) => [String(row.id), row]));
  for (const invoice of live) {
    const row = byRow.get(String(invoice.scheduled_service_id));
    if (row && !governingIds.has(String(invoice.id)) && invoiceBillsBaseApplication(invoice)) {
      row.has_own_live_invoice = true;
      row.own_first_invoice = invoice;
    }
  }
  return invoices;
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
  const invoices = await loadFirstInvoices(conn, rows);
  const customer = await conn('customers').where({ id: customerId }).first('first_name', 'last_name');
  return {
    estimate,
    rows: rows.filter((row) => row.catalog_billing_type !== 'one_time'),
    invoices, excludedFamilies, customerName: shortName(customer),
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

// A refresh rings only when a problem is new: one the standing row did not
// already carry.
function ringOnNewProblem(codes) {
  return (existing, existingMeta) => {
    const known = new Set(Array.isArray(existingMeta?.problemCodes) ? existingMeta.problemCodes : []);
    return codes.some((code) => !known.has(code));
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

async function postAlert(estimate, verdict, ctx, { raise, held = [] } = {}) {
  const raiseAdminAlert = raise || require('./admin-alert-compose').raiseAdminAlert;
  const { detail, ...spec } = composeAlert(verdict, {
    customerName: ctx.customerName, customerId: estimate.customer_id, estimateId: estimate.id,
  });
  // A held price finding stays on the bell's codes (see heldCodes).
  const codes = [...new Set([...verdict.problems.map((problem) => problem.code), ...held])];
  return raiseAdminAlert(CATEGORY, spec, {
    // Under GATE_ADMIN_BELL_POLICY the 'alert' category is denied unless the
    // call site tags it (the schedule-integrity watchdog's own bells do too).
    bell: true,
    detail,
    dedupeKey: dedupeKeyFor(estimate.id),
    refreshOnDedupe: true,
    ringOnRefresh: ringOnNewProblem(codes),
    metadata: {
      opsKey: OPS_KEY,
      alertClass: OPS_KEY,
      estimateId: estimate.id,
      customerId: estimate.customer_id,
      problemCodes: codes,
      // count + itemKeys are the ring-stamps notifyAdmin compares on a
      // refresh, so a changed problem set is treated as a real change.
      count: codes.length,
      itemKeys: codes,
    },
  });
}

// Standing bells whose estimate has left the sweep for good (the customer was
// deactivated or deleted, the estimate archived or no longer accepted): nothing
// is left to act on, so they close. A bell that only aged past the lookback
// stays open for a person.
async function retireAbandoned(conn) {
  const gone = await conn('notifications as n')
    .leftJoin('estimates as e', conn.raw("e.id::text = n.metadata->>'estimateId'"))
    .leftJoin('customers as c', 'c.id', 'e.customer_id')
    .where({ 'n.recipient_type': 'admin', 'n.category': CATEGORY })
    .whereRaw("starts_with(n.metadata->>'dedupeKey', ?)", [`${OPS_KEY}:`])
    .where(function goneForGood() {
      this.whereNull('e.id').orWhereNot('e.status', 'accepted').orWhereNotNull('e.archived_at')
        .orWhereNot('c.active', true).orWhereNotNull('c.deleted_at');
    })
    .select(conn.raw("n.metadata->>'estimateId' as estimate_id"));
  return retireStanding(conn, [...new Set(gone.map((row) => row.estimate_id))], RESOLVED_GONE);
}

// What a sweep does with one verdict:
//   skipped  — not a combined booking any more (the plan was cancelled): close
//   problems — post / refresh the bell
//   ok       — verified: close a standing bell as fixed
//   deferred — nothing of this check's own to say (the schedule shape is the
//              accepted-schedule alert's, or a price cannot be verified): close
//   held     — prices could not be verified, and the standing bell carries a
//              price comparison that was therefore not looked for: leave it
function outcomeOf(verdict, standingCodes = []) {
  if (!verdict) return 'skipped';
  if (verdict.problems.length) return 'problems';
  if (verdict.ok) return 'ok';
  return heldCodes(verdict, standingCodes).length ? 'held' : 'deferred';
}

// The standing bell's price comparisons this verdict could not re-judge (its
// prices were not verifiable): they stay on the bell until a verdict that
// can see them says otherwise.
function heldCodes(verdict, standingCodes = []) {
  if (!verdict.pricesHidden) return [];
  const now = new Set(verdict.problems.map((problem) => problem.code));
  return standingCodes.filter((code) => COMPARISON_CODES.has(code) && !now.has(code));
}

/**
 * One sweep. Returns counts; never throws for a single bad estimate.
 * `conn` and `raise` are injectable for tests.
 */
async function runCombinedBookingCheck({ now = new Date(), conn = db, raise } = {}) {
  const settled = new Date(now.getTime() - SETTLE_MINUTES * 60 * 1000);
  const since = new Date(now.getTime() - LOOKBACK_HOURS * 3600 * 1000);
  const result = { candidates: 0, checked: 0, ok: 0, problems: 0, deferred: 0, skipped: 0, failed: 0, closed: 0 };
  result.closed += await retireAbandoned(conn);
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
  result.candidates = candidates.length;

  // Multi-service accepts to judge. An OK verdict writes nothing (an `fyi`
  // fact), so every accept inside the lookback is judged each run, and every
  // problem gets its own bell: no per-run cap, so nothing waits its turn and
  // ages out of the lookback unreported.
  const standing = new Map((await conn('notifications')
    .where({ recipient_type: 'admin', category: CATEGORY })
    .whereRaw("metadata->>'dedupeKey' = ANY(?)", [candidates.map((estimate) => dedupeKeyFor(estimate.id))])
    .select(conn.raw("metadata->>'estimateId' as estimate_id"), conn.raw("metadata->'problemCodes' as problem_codes")))
    .map((row) => [String(row.estimate_id), Array.isArray(row.problem_codes) ? row.problem_codes : []]));
  const work = candidates.filter((estimate) => {
    try {
      if ((acceptedPrograms(estimate)?.programs.size || 0) >= 2) return true;
      result.skipped += 1;
    } catch (err) {
      result.failed += 1;
      logger.warn(`[combined-booking-check] estimate ${estimate.id} could not be read: ${err.message}`);
    }
    return false;
  });
  if (!work.length) return result;

  // The shared accepted-plan classifier, with no 24h wait: the same findings
  // the watchdog's accepted-schedule alerts are built from, plus which
  // estimates it judged and which families it skipped on each.
  const coverage = new Map();
  const gaps = await require('./recurring-schedule-audit')
    .acceptedRecurringScheduleGaps(conn, { now, cutoff: now, estimateIds: work.map((estimate) => estimate.id), coverage });

  for (const estimate of work) {
    const id = String(estimate.id);
    const isNew = !standing.has(id);
    try {
      const judged = coverage.get(id);
      const checked = await checkEstimate(conn, estimate, {
        scheduleGaps: gaps.filter((gap) => String(gap.estimateId) === id),
        scheduleSkippedFamilies: judged || new Set(),
        scheduleUnjudged: !judged,
      });
      const outcome = outcomeOf(checked?.verdict, standing.get(id));
      if (outcome !== 'problems') {
        result[outcome === 'held' ? 'deferred' : outcome] += 1;
        if (!isNew && outcome !== 'held') {
          result.closed += await retireStanding(conn, [id], outcome === 'skipped' ? RESOLVED_GONE : RESOLVED_FIXED);
        }
        continue;
      }
      result.checked += 1;
      const row = await postAlert(estimate, checked.verdict, checked.ctx, { raise, held: heldCodes(checked.verdict, standing.get(id)) });
      if (!row) { result.failed += 1; logger.warn(`[combined-booking-check] alert write failed for estimate ${id}`); continue; }
      result.problems += 1;
    } catch (err) {
      result.failed += 1;
      logger.warn(`[combined-booking-check] estimate ${id} check failed: ${err.message}`);
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
  outcomeOf,
  acceptedPrograms,
  firstApplicationAmount,
  shortName,
  OPS_KEY,
  DONE_WHEN,
};
