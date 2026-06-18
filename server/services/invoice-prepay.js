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

// Loads + normalizes the annual-prepay term for an invoice, or null when the
// invoice isn't an annual prepayment. Shape matches the camelCase descriptor
// returned by /api/auth/me so the client can treat them the same.
async function loadInvoiceAnnualPrepay(invoice) {
  if (!invoice?.annual_prepay_term_id) return null;
  const hasTable = await db.schema.hasTable('annual_prepay_terms').catch(() => false);
  if (!hasTable) return null;
  const term = await db('annual_prepay_terms')
    .where({ id: invoice.annual_prepay_term_id })
    .first(
      'id', 'status', 'plan_label', 'monthly_rate', 'prepay_amount', 'term_start', 'term_end',
      'coverage_service_type', 'coverage_visit_count', 'coverage_cadence',
    )
    .catch(() => null);
  if (!term) return null;
  return {
    id: term.id,
    status: term.status,
    planLabel: term.plan_label || null,
    monthlyRate: term.monthly_rate != null ? Number(term.monthly_rate) : null,
    prepayAmount: term.prepay_amount != null ? Number(term.prepay_amount) : null,
    termStart: term.term_start,
    termEnd: term.term_end,
    coverageMonths: coverageMonths(term.term_start, term.term_end),
    coverageServiceType: term.coverage_service_type || null,
    coverageVisitCount: term.coverage_visit_count != null ? Number(term.coverage_visit_count) : null,
    coverageCadence: term.coverage_cadence || null,
    setupFeeWaived: annualPrepaySetupFeeWaived(invoice),
  };
}

module.exports = {
  loadInvoiceAnnualPrepay,
  annualPrepaySetupFeeWaived,
  coverageMonths,
};
