function parsedMetadata(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function sameId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

// Legacy claims predate unbooked_commercial_setup. The conversion activity is
// the immutable sale decision; the claim's scheduled_service_id is not (old
// booking paths could attach it later). Return only unanimous, well-formed
// evidence for the estimate which owns this term and claim.
async function legacyConversionEvidence(conn, claim, term, invoice) {
  if (claim.estimate_id && term.source_estimate_id
    && !sameId(claim.estimate_id, term.source_estimate_id)) return null;
  const estimateId = claim.estimate_id || term.source_estimate_id;
  if (!estimateId || !invoice?.created_at) return null;
  const saleCreatedAt = new Date(invoice.created_at).getTime();
  if (!Number.isFinite(saleCreatedAt)) return null;
  const rows = await conn('activity_log')
    .where({ customer_id: term.customer_id, action: 'estimate_converted' })
    .where('description', 'like', `Estimate #${estimateId} converted:%`)
    .orderBy('created_at', 'asc')
    .select('metadata', 'created_at');
  if (!rows.length) return null;
  const decisions = rows.map((row) => {
    const metadata = parsedMetadata(row.metadata);
    const evidenceCreatedAt = new Date(row.created_at).getTime();
    if (!metadata || !sameId(metadata.estimateId, estimateId)
      || !Number.isFinite(evidenceCreatedAt) || evidenceCreatedAt > saleCreatedAt
      || !Object.prototype.hasOwnProperty.call(metadata, 'firstScheduledServiceId')
      || !Object.prototype.hasOwnProperty.call(metadata, 'scheduledCount')
      || !Number.isInteger(metadata.scheduledCount)
      || metadata.scheduledCount < 0) return null;
    if (metadata.scheduledCount === 0 && metadata.firstScheduledServiceId === null) {
      return { kind: 'unbooked' };
    }
    if (metadata.scheduledCount > 0 && metadata.firstScheduledServiceId) {
      return { kind: 'booked', occurrenceId: String(metadata.firstScheduledServiceId) };
    }
    return null;
  });
  if (decisions.some((decision) => !decision)) return null;
  const first = decisions[0];
  if (!decisions.every((decision) => decision.kind === first.kind
    && decision.occurrenceId === first.occurrenceId)) return null;
  return first;
}

async function legacyConversionProvesNoBooking(conn, claim, term, invoice) {
  return (await legacyConversionEvidence(conn, claim, term, invoice))?.kind === 'unbooked';
}

async function isCommercialSale(conn, claim, term, invoice) {
  if (claim.unbooked_commercial_setup != null) return claim.unbooked_commercial_setup;
  if (!(await legacyConversionProvesNoBooking(conn, claim, term, invoice))) return false;

  const { recurringServiceKey, estimateRodentBaitIsCommercial } = require('./estimate-converter');
  if (recurringServiceKey({ name: term.coverage_service_type }) === 'commercial_rodent_bait') {
    return true;
  }
  const estimateId = claim.estimate_id || term.source_estimate_id;
  if (estimateId) {
    const estimate = await conn('estimates')
      .where({ id: estimateId, customer_id: term.customer_id })
      .first('estimate_data');
    if (estimateRodentBaitIsCommercial(estimate?.estimate_data)) return true;
  }

  return false;
}

// Identifies only the sale and the invoice that owns its setup fee. Payment
// state, receipt identity, refund state, and Dispatch reconciliation belong to
// their callers and deliberately are not part of this ownership classifier.
async function findOriginalCommercialPrepayInvoice(conn, invoiceId, { lock = false } = {}) {
  const claims = conn('setup_fee_claims')
    .where({ invoice_id: invoiceId, scheduled_service_id: null });
  if (lock) claims.forUpdate();
  const claim = await claims.first();
  if (!claim || claim.unbooked_commercial_setup === false || !(Number(claim.amount) > 0)) {
    return null;
  }

  const term = await conn('annual_prepay_terms')
    .where({ prepay_invoice_id: invoiceId })
    .first();
  if (!term) return null;

  const invoice = await conn('invoices')
    .where({ id: invoiceId, customer_id: term.customer_id })
    .first();
  if (!invoice || invoice.scheduled_service_id
    || !(await isCommercialSale(conn, claim, term, invoice))) return null;
  return { claim, term, invoice };
}

// A positive claim links the selling invoice to the booked series. Verify the
// service family and customer before treating that link as a coverage boundary.
async function bookedCommercialSetupRootId(conn, term, { readStored = false } = {}) {
  if (!term?.prepay_invoice_id || !term.customer_id) return null;
  const { recurringServiceKey } = require('./estimate-converter');
  const { authoritativeServiceKey, isRodentBaitProgramKey } = require('./secure-appointment-plans');
  const coverageKey = recurringServiceKey({ name: term.coverage_service_type });
  if (readStored && term.id && !Object.hasOwn(term, 'commercial_setup_series_root_id')) {
    // Read-only callers sometimes project a subset of the term columns.
    const stored = await conn('annual_prepay_terms').where({ id: term.id, customer_id: term.customer_id, prepay_invoice_id: term.prepay_invoice_id }).first();
    if (stored?.commercial_setup_series_root_id) return stored.commercial_setup_series_root_id;
  }
  // The stored appointment's catalog identity can disagree with a staff
  // display label. Check the financial claim and its actual invoice owner.
  const claim = await conn('setup_fee_claims').where({ invoice_id: term.prepay_invoice_id })
    .whereNotNull('scheduled_service_id').where('amount', '>', 0).first();
  if (!claim?.scheduled_service_id || claim.unbooked_commercial_setup === true) return null;
  const invoice = await conn('invoices').where({ id: term.prepay_invoice_id, customer_id: term.customer_id })
    .first('created_at');
  if (!invoice) return null;
  const anchor = await conn('scheduled_services')
    .where({ id: claim.scheduled_service_id, customer_id: term.customer_id })
    .first();
  if (!anchor) return null;
  const root = anchor.recurring_parent_id
    ? await conn('scheduled_services').where({ id: anchor.recurring_parent_id, customer_id: term.customer_id }).first()
    : anchor;
  if (!root) return null;
  if (claim.unbooked_commercial_setup == null) {
    const evidence = await legacyConversionEvidence(conn, claim, term, invoice);
    if (evidence?.kind !== 'booked') return null;
    const occurrence = await conn('scheduled_services')
      .where({ customer_id: term.customer_id })
      // Historical JSON is untrusted. Comparing text fails closed instead of
      // asking PostgreSQL to cast a malformed value to uuid.
      .whereRaw('id::text = ?', [evidence.occurrenceId])
      .first();
    if (!occurrence) return null;
    const occurrenceKey = await authoritativeServiceKey(conn, occurrence);
    if (!isRodentBaitProgramKey(occurrenceKey)) return null;
    const occurrenceRootId = occurrence.recurring_parent_id || occurrence.id;
    const saleCreatedAt = new Date(invoice.created_at).getTime();
    const occurrenceCreatedAt = new Date(occurrence.created_at).getTime();
    const rootCreatedAt = new Date(root.created_at).getTime();
    if (!sameId(occurrenceRootId, root.id)
      || dateOnly(occurrence.scheduled_date) !== dateOnly(term.term_start)
      || !Number.isFinite(saleCreatedAt) || !Number.isFinite(occurrenceCreatedAt)
      || !Number.isFinite(rootCreatedAt) || occurrenceCreatedAt > saleCreatedAt
      || rootCreatedAt > saleCreatedAt) return null;
  }
  const key = await authoritativeServiceKey(conn, root);
  if (key === 'commercial_rodent_bait') return root.id;
  if (key === 'rodent_bait' && coverageKey === 'commercial_rodent_bait') return root.id;
  return null;
}

module.exports = { findOriginalCommercialPrepayInvoice, bookedCommercialSetupRootId };
