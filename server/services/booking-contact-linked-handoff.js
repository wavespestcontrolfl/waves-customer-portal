/**
 * Shared definition for the contact-linked quote-wizard handoff rule (B11).
 *
 * public-quote links a wizard draft to any existing customer matching the
 * UNVERIFIED contact the anonymous quoter typed, so under the customers-only
 * booking gate a draft linked to an ESTABLISHED customer must never book
 * without the portal OTP (routes/booking.js) — and must never cause a
 * recovery message to the real customer (capture-intent + the recovery
 * worker both consult establishedContactLinkedDraft).
 */

// Pipeline stages that mark a row as a PROSPECT, not a current customer —
// the customers-only gate refuses these even after a successful phone verify
// (the quote wizard mints active 'new_lead' rows for anyone who runs it, and
// admin moves unconverted leads through the rest; 'lost' is a lost lead —
// 'churned' ex-customers are deliberately NOT here). Subset of
// admin-customers.js CUSTOMER_STAGES; keep the two in sync.
const PRE_CUSTOMER_PIPELINE_STAGES = new Set([
  'new_lead', 'contacted', 'estimate_sent', 'estimate_viewed', 'follow_up', 'negotiating', 'lost',
]);

// The ACCOUNT a contact-linked draft resolves to: the draft-linked customer
// row plus every live, active sibling property row on its account — the same
// account resolution routes/booking.js findAccountPropertyByAddress uses to
// bind a submitted address to a property row. Confirmation, capture-intent
// and the recovery worker all classify through THIS list so they can never
// diverge — and the sibling read is deliberately UNCAPPED (a limit could drop
// the account's only established row): a handoff is blocked when ANY of these rows is an established
// customer, even if the draft-linked row itself is still a lead (the address
// bind can land the booking on an established sibling). opts.forShare
// share-locks the rows (confirmation, inside its transaction). Returns
// { root, rows } — root null when the customer row is gone.
async function loadContactLinkedAccountRows(conn, customerId, { forShare = false, columns = ['id', 'account_id', 'pipeline_stage', 'phone', 'email'] } = {}) {
  const rootQ = conn('customers').where({ id: customerId }).whereNull('deleted_at');
  if (forShare) rootQ.forShare();
  const root = await rootQ.first(...columns);
  if (!root) return { root: null, rows: [] };
  const accountId = root.account_id || root.id;
  const siblingQ = conn('customers')
    .where(function () {
      this.where('account_id', accountId).orWhere('id', accountId);
    })
    .whereNot('id', root.id)
    .whereNull('deleted_at')
    .andWhere(function () {
      this.whereNull('active').orWhere('active', true);
    })
    .orderBy('id');
  if (forShare) siblingQ.forShare();
  const siblings = await siblingQ.select(...columns);
  return { root, rows: [root, ...(Array.isArray(siblings) ? siblings : [])] };
}

const isEstablishedCustomerRow = (r) => !PRE_CUSTOMER_PIPELINE_STAGES.has(String(r?.pipeline_stage || ''));

// True when the draft named by pricingEstimateId is contact-linked to a live
// customer whose ACCOUNT holds any established row. Throws on a lookup error
// — callers fail closed.
async function establishedContactLinkedDraft(conn, pricingEstimateId) {
  if (!pricingEstimateId) return false;
  const draft = await conn('estimates').where({ id: pricingEstimateId }).first('customer_id');
  if (!draft?.customer_id) return false;
  const { rows } = await loadContactLinkedAccountRows(conn, draft.customer_id);
  return rows.some(isEstablishedCustomerRow);
}

module.exports = {
  PRE_CUSTOMER_PIPELINE_STAGES, establishedContactLinkedDraft, loadContactLinkedAccountRows, isEstablishedCustomerRow,
};
