/**
 * Annual-prepay invoice enrichment.
 *
 * An annual-prepay invoice is an ordinary invoice whose annual_prepay_term_id
 * points at the annual_prepay_terms row recording the coverage window. Without
 * a dedicated indicator the only hint the customer gets that they're paying for
 * a full year is the wording baked into the title + line item, so we surface an
 * explicit coverage callout on the pay page and the invoice PDF. This module
 * loads + normalizes the term for those surfaces.
 *
 * Imported by services/invoice.js (pay page JSON + downloadable PDF) and
 * services/invoice-email.js (emailed PDF).
 */

const db = require('../models/db');

const SETUP_FEE_WAIVED_RE = /setup fee waived|setup.*waiv/i;

// coverage_* columns were added after the original annual_prepay_terms table.
// Detect them once so an environment that has the table but not yet the
// coverage migration (rolling deploy / preview DB) still loads the base term
// instead of throwing and dropping the whole annual-prepay payload.
let coverageColsCache = null;
async function annualPrepayCoverageCols() {
  if (coverageColsCache) return coverageColsCache;
  try {
    const cols = await db('annual_prepay_terms').columnInfo();
    coverageColsCache = ['coverage_service_type', 'coverage_visit_count', 'coverage_cadence']
      .filter((c) => cols[c]);
  } catch {
    coverageColsCache = [];
  }
  return coverageColsCache;
}

function lineItemsArray(invoice) {
  const raw = invoice?.line_items;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Whether the invoice text tells the customer the one-time setup fee is waived.
// Derived from the invoice itself (line items + notes) rather than assumed, so a
// manually built prepay invoice that does charge setup won't claim otherwise.
function annualPrepaySetupFeeWaived(invoice) {
  // Explicit operator flag (set by the apply-credit "waive setup fee" toggle)
  // wins; otherwise fall back to detecting the waiver in line items / notes.
  if (invoice?.setup_fee_waived === true) return true;
  const texts = lineItemsArray(invoice).map((li) => li?.description || '');
  if (invoice?.notes) texts.push(invoice.notes);
  return texts.some((t) => SETUP_FEE_WAIVED_RE.test(String(t)));
}

// Date-only (YYYY-MM-DD) extraction that ignores the time component, so a
// timestamptz term boundary stored at UTC midnight doesn't slip a calendar day
// when formatted in ET.
function ymdOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return match ? match[1] : null;
}

// "June 2026" in ET for a date-only/timestamp value. Empty string when unparseable.
function monthYearLabel(value) {
  const ymd = ymdOnly(value);
  if (!ymd) return '';
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'America/New_York',
  });
}

// Cadence → adjective used in the coverage sentence ("4 quarterly visits").
// every_6_weeks intentionally has no single-word adjective, so it falls back to
// the plain "{count} visits" form.
const CADENCE_WORD = {
  monthly: 'monthly',
  bimonthly: 'bimonthly',
  quarterly: 'quarterly',
  triannual: 'tri-annual',
  semiannual: 'semi-annual',
  annual: 'annual',
};

// Human service label for the SMS — strips the cadence/program noise words from
// the stored coverage_service_type so "Quarterly Pest Control Service" reads as
// "pest control" (the cadence is already stated separately as "4 quarterly").
function cleanServiceLabel(serviceType) {
  const cleaned = String(serviceType || '')
    .replace(/\b(quarterly|monthly|bi-?monthly|tri-?annual|semi-?annual|annual|yearly|recurring|service|services|visit|visits|plan|program)\b/gi, ' ')
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.toLowerCase() : 'service';
}

// One-line coverage sentence for the annual-prepay invoice SMS, built from the
// normalized descriptor (loadInvoiceAnnualPrepay output). Returns null when the
// term has no visit count configured (display-only flag) so the caller can fall
// back to a generic phrase. Never includes a dollar amount — payment-link SMS
// bodies keep the amount on the pay page only.
function buildPrepayCoverageSummary(prepay) {
  if (!prepay) return null;
  const count = Number(prepay.coverageVisitCount);
  if (!Number.isInteger(count) || count <= 0) return null;
  const cadence = String(prepay.coverageCadence || '').toLowerCase();
  const word = CADENCE_WORD[cadence] || '';
  const visitNoun = count === 1 ? 'visit' : 'visits';
  const countPhrase = word ? `${count} ${word} ${visitNoun}` : `${count} ${visitNoun}`;
  const serviceLabel = cleanServiceLabel(prepay.coverageServiceType);
  // Coverage span is expressed as a duration, never as start/end month names:
  // the outbound SMS stale-month guard (services/sms-guard.js) blocks 'invoice'
  // sends whose body names a month >1 month from today, which a real partial-
  // term or future-dated renewal window legitimately does. The exact covered
  // dates still appear on the pay page + PDF coverage panel, which aren't
  // subject to the guard.
  const months = Number(prepay.coverageMonths);
  const fullYear = Number.isFinite(months) && months >= 11 && months <= 13;
  const spanPhrase =
    !fullYear && Number.isInteger(months) && months > 0 ? ` across ${months} months` : '';
  const coverageSummary = fullYear
    ? `your full year of ${serviceLabel}: ${countPhrase}`
    : `${countPhrase} of ${serviceLabel}${spanPhrase}`;
  return { serviceLabel, countPhrase, coverageSummary, coverageCount: count };
}

// The individual covered visit dates (canonical cadence schedule) with each
// visit's share of the prepay total. Computed from the term — not a
// scheduled_services join — so it's correct even before the invoice is paid and
// coverage rows are seeded. Empty array when coverage isn't configured.
function buildCoverageVisits(term, prepayAmount) {
  const visitCount = term?.coverage_visit_count != null ? Number(term.coverage_visit_count) : null;
  if (!term?.term_start || !Number.isInteger(visitCount) || visitCount <= 0) return [];
  try {
    const { coverageScheduleDates, inferCoverageCadence, splitCoverageAmount } =
      require('./annual-prepay-renewals')._private;
    const cadence = term.coverage_cadence || inferCoverageCadence(term);
    const dates = coverageScheduleDates(term.term_start, visitCount, cadence, term.term_end) || [];
    // Split by the sold visitCount so each displayed share equals the
    // prepaid_amount actually stamped on the covered scheduled_services
    // (applyPrepaidCoverageForTerm splits the total by coverage_visit_count) and
    // reconciles with the completion-billing ledger. A truncated custom term
    // (term_end before the full cadence) renders fewer rows than visitCount, so
    // the shown shares intentionally sum to less than the prepay total — they
    // mirror what each covered visit is actually credited. For a full term
    // dates.length === visitCount, so the rows sum to the total.
    const amounts = prepayAmount > 0 ? splitCoverageAmount(prepayAmount, visitCount) : [];
    return dates.map((date, index) => ({
      date,
      amount: amounts[index] != null ? amounts[index] : null,
    }));
  } catch {
    return [];
  }
}

// Whole months between two date-only values, rounded to nearest. Null if either
// date is missing/invalid. A standard annual term resolves to 12.
function coverageMonths(termStart, termEnd) {
  if (!termStart || !termEnd) return null;
  const start = termStart instanceof Date ? termStart : new Date(termStart);
  const end = termEnd instanceof Date ? termEnd : new Date(termEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const days = (end.getTime() - start.getTime()) / 86400000;
  if (days <= 0) return null;
  return Math.max(1, Math.round(days / 30.44));
}

// A completion invoice that collects at least this fraction of the term's full
// prepay amount is treated as the annual prepayment (anchor). A covered visit's
// add-on / uncovered-balance invoice is a small fraction and stays below it, so
// it never inherits the prepay framing. See resolveInvoiceTermId.
const ANCHOR_MIN_PREPAY_FRACTION = 0.5;

// Resolves the annual-prepay term id for an invoice — off the invoice's own tag
// when present, otherwise (gated) through its scheduled visit.
//
// A completion-billed first visit mints its invoice via
// InvoiceService.createFromService, which does NOT copy the term onto the
// invoice — the link lives on the visit (scheduled_services.annual_prepay_term_id),
// and the invoice only gets tagged later (on payment/term sync). But the pay-link
// SMS goes out seconds after completion (services/invoice.js sendViaSMS), while
// the row is still untagged — so keying only off invoice.annual_prepay_term_id
// sends the generic invoice_sent copy for what is really a full year prepaid up
// front. Resolving the term through the visit fixes the SMS, the pay page and the
// PDFs (all read loadInvoiceAnnualPrepay) in one place.
//
// ANCHOR GATE: every covered visit in a term is stamped with the term id
// (annual-prepay-renewals attachScheduledServices), so a bare "visit has a term"
// check would also paint an add-on / uncovered-balance invoice on a covered visit
// as the full annual plan. Accept the visit's term ONLY when this invoice is the
// term's registered anchor (prepay_invoice_id) or it collects ~the full prepay
// amount — never a small residual. Never throws; a lookup failure resolves to
// null (standard, non-prepay copy).
async function resolveInvoiceTermId(invoice, conn = db) {
  if (invoice?.annual_prepay_term_id) return invoice.annual_prepay_term_id;
  if (!invoice?.scheduled_service_id) return null;
  try {
    const visit = await conn('scheduled_services')
      .where({ id: invoice.scheduled_service_id })
      .first('annual_prepay_term_id');
    const termId = visit?.annual_prepay_term_id;
    if (!termId) return null;
    const term = await conn('annual_prepay_terms')
      .where({ id: termId })
      .first('id', 'prepay_invoice_id', 'prepay_amount');
    if (!term) return null;
    // If the term already registered a billing invoice, trust that identity
    // exactly: this invoice is the prepayment only when it IS that anchor. A
    // covered visit is stamped with the term too, so any OTHER invoice on the
    // visit — however large — is an add-on/residual and must stay generic.
    if (term.prepay_invoice_id) {
      return invoice.id && String(term.prepay_invoice_id) === String(invoice.id)
        ? termId
        : null;
    }
    // Anchor not yet registered (an untagged completion invoice at the moment its
    // pay-link SMS goes out): accept only an anchor-scale amount (~the whole
    // prepayment), never a small add-on/residual on an already-covered visit.
    const total = Number(invoice.total);
    const prepay = Number(term.prepay_amount);
    if (Number.isFinite(total) && Number.isFinite(prepay) && prepay > 0
        && total >= prepay * ANCHOR_MIN_PREPAY_FRACTION) {
      return termId;
    }
    return null;
  } catch {
    return null;
  }
}

// Loads + normalizes the annual-prepay term for an invoice, or null when the
// invoice isn't an annual prepayment. Shape matches the camelCase descriptor
// returned by /api/auth/me so the client can treat them the same.
async function loadInvoiceAnnualPrepay(invoice) {
  const termId = await resolveInvoiceTermId(invoice);
  if (!termId) return null;
  const hasTable = await db.schema.hasTable('annual_prepay_terms').catch(() => false);
  if (!hasTable) return null;
  const coverageCols = await annualPrepayCoverageCols();
  const term = await db('annual_prepay_terms')
    .where({ id: termId })
    .first(
      'id', 'status', 'renewal_decision', 'plan_label', 'monthly_rate', 'prepay_amount',
      'term_start', 'term_end',
      ...coverageCols,
    )
    .catch(() => null);
  if (!term) return null;
  const prepayAmount = term.prepay_amount != null ? Number(term.prepay_amount) : null;
  // A voided/refunded invoice flips its term to a terminal status but keeps the
  // link on the invoice, so an old pay link / PDF would otherwise still list the
  // covered visits as "Included". Drop them for terminal terms so a void/refund
  // never promises future visits — but NOT for a renewal lapse, which the
  // billing guard (annual-prepay-renewals.js coveredTermCustomerIds) treats as
  // still-active coverage: status='cancelled' WITH renewal_decision='cancel'
  // stays covered through term_end (a true refund has a NULL renewal_decision).
  const status = String(term.status || '').toLowerCase();
  const renewalDecision = String(term.renewal_decision || '').toLowerCase();
  const renewalLapseStillCovered = status === 'cancelled' && renewalDecision === 'cancel';
  const coverageActive = renewalLapseStillCovered
    || !['cancelled', 'canceled', 'refunded'].includes(status);
  return {
    id: term.id,
    status: term.status,
    renewalDecision: term.renewal_decision || null,
    coverageActive,
    planLabel: term.plan_label || null,
    monthlyRate: term.monthly_rate != null ? Number(term.monthly_rate) : null,
    prepayAmount,
    termStart: term.term_start,
    termEnd: term.term_end,
    coverageMonths: coverageMonths(term.term_start, term.term_end),
    coverageServiceType: term.coverage_service_type || null,
    coverageVisitCount: term.coverage_visit_count != null ? Number(term.coverage_visit_count) : null,
    coverageCadence: term.coverage_cadence || null,
    coverageVisits: coverageActive ? buildCoverageVisits(term, prepayAmount) : [],
    setupFeeWaived: annualPrepaySetupFeeWaived(invoice),
  };
}

module.exports = {
  loadInvoiceAnnualPrepay,
  resolveInvoiceTermId,
  annualPrepaySetupFeeWaived,
  coverageMonths,
  buildPrepayCoverageSummary,
  buildCoverageVisits,
  monthYearLabel,
};
