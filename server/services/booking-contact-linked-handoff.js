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

// True when the draft named by pricingEstimateId is linked to a live customer
// row that is NOT a pre-customer prospect. Throws on a lookup error — callers
// decide (recovery and capture fail closed).
async function establishedContactLinkedDraft(conn, pricingEstimateId) {
  if (!pricingEstimateId) return false;
  const draft = await conn('estimates').where({ id: pricingEstimateId }).first('customer_id');
  if (!draft?.customer_id) return false;
  const customer = await conn('customers').where({ id: draft.customer_id }).whereNull('deleted_at').first('pipeline_stage');
  if (!customer) return false;
  return !PRE_CUSTOMER_PIPELINE_STAGES.has(String(customer.pipeline_stage || ''));
}

module.exports = { PRE_CUSTOMER_PIPELINE_STAGES, establishedContactLinkedDraft };
