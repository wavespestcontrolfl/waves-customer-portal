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
// row plus every sibling property row on its account (account_id match, or the
// account's own id) — the same account membership routes/booking.js
// findAccountPropertyByAddress uses to bind a submitted address to a property
// row, but read WITHOUT its deleted/inactive filters. Confirmation,
// capture-intent and the recovery worker all classify through THIS list so
// they can never diverge — and the sibling read is deliberately UNCAPPED (a
// limit could drop the account's only blocking row): a handoff is blocked when
// ANY linked row is an established customer, ARCHIVED (deleted_at set — an
// archived customer is not a lead, and archiving must never re-open the
// handoff), or MISSING (the draft names a customer row that is gone). Fail
// closed throughout. opts.forShare share-locks the rows (confirmation, inside
// its transaction). Returns { root, rows } — root null when the row is gone.
async function loadContactLinkedAccountRows(conn, customerId, { forShare = false, columns = ['id', 'account_id', 'pipeline_stage', 'phone', 'email', 'deleted_at'] } = {}) {
  const rootQ = conn('customers').where({ id: customerId });
  if (forShare) rootQ.forShare();
  const root = await rootQ.first(...columns);
  if (!root) return { root: null, rows: [] };
  const accountId = root.account_id || root.id;
  const siblingQ = conn('customers')
    .where(function () {
      this.where('account_id', accountId).orWhere('id', accountId);
    })
    .whereNot('id', root.id)
    .orderBy('id');
  if (forShare) siblingQ.forShare();
  const siblings = await siblingQ.select(...columns);
  return { root, rows: [root, ...(Array.isArray(siblings) ? siblings : [])] };
}

const isEstablishedCustomerRow = (r) => !PRE_CUSTOMER_PIPELINE_STAGES.has(String(r?.pipeline_stage || ''));
// Established OR archived: either one means the row is not the quoter's own
// fresh lead, so the handoff must not act as (or message) that customer.
const isBlockingLinkedRow = (r) => !!r?.deleted_at || isEstablishedCustomerRow(r);

// True when the draft named by pricingEstimateId is contact-linked to a
// customer whose account is blocking (see above) or whose row is missing.
// Throws on a lookup error — callers fail closed.
async function establishedContactLinkedDraft(conn, pricingEstimateId) {
  if (!pricingEstimateId) return false;
  const draft = await conn('estimates').where({ id: pricingEstimateId }).first('customer_id');
  if (!draft?.customer_id) return false;
  const { root, rows } = await loadContactLinkedAccountRows(conn, draft.customer_id);
  if (!root) return true;
  return rows.some(isBlockingLinkedRow);
}

module.exports = {
  PRE_CUSTOMER_PIPELINE_STAGES, establishedContactLinkedDraft, loadContactLinkedAccountRows, isEstablishedCustomerRow, isBlockingLinkedRow,
};
