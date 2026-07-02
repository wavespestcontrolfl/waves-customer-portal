/**
 * Fan a customer address edit out to the rows that SNAPSHOT the address at
 * creation time instead of reading customers.* live:
 *
 *   - leads.address/city/zip — captured at lead intake; the Leads UI reads
 *     these columns directly, so a Customer 360 correction never showed there.
 *   - estimates.address — captured when the estimate is created; shown on the
 *     estimate list and baked into the proposal PDF/email at send time.
 *
 * A snapshot is only rewritten when it still matches the customer's OLD (or,
 * to self-heal partially-synced rows, NEW) street line under a normalized
 * compare — an intentionally different address (a lead about a second
 * property, an estimate for a rental) is never clobbered. The normalized key
 * strips everything but letters/digits so transcription variants of the same
 * street ("4867 Tober Morey Way" vs "4867 Tobermorey Way") still match.
 *
 * Projects are deliberately NOT fanned out: a report's property_address lives
 * inside the findings JSONB as a tech-owned Section-1 field (for WDO often a
 * legally distinct LOT address), so a customer-table edit must not rewrite it.
 *
 * Terminal rows are historical documents and stay untouched: leads won/lost,
 * estimates accepted/declined/expired or archived. Errors PROPAGATE so a
 * transactional caller rolls the whole edit back rather than leaving the
 * customer row and its copies half-synced.
 */

const db = require('../models/db');
const logger = require('./logger');
const { formatAddress } = require('../utils/address-normalizer');

// Deliverable estimate states — mirrors SENDABLE_ESTIMATE_STATUSES in
// routes/admin-estimates.js (scheduled/sending/send_failed rows still produce
// customer-facing email/PDF content on their next attempt, so their snapshot
// must not go stale either). Terminal lead states mirror CLOSED_STATUSES in
// intelligence-bar/leads-tools.js.
const OPEN_ESTIMATE_STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'viewed', 'send_failed'];
const TERMINAL_LEAD_STATUSES = ['won', 'lost', 'disqualified', 'duplicate', 'unresponsive'];

// Lowercased alphanumerics only — spacing/punctuation/casing differences
// (including speech-to-text spacing like "Tober Morey") compare equal.
function addressMatchKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// True when a stored snapshot refers to the given street line. The comparison
// is EXACT key equality on the snapshot's first comma-segment: whole-string
// equality covers street-line snapshots (leads.address); the first segment of
// a full single-line snapshot ("123 Main St, Bradenton, FL 34205" on
// estimates) is its street line. A prefix check would be wrong here — it
// would let "123 Main St" swallow "123 Main St Apt 2", clobbering an open
// lead/estimate for a distinct unit under the same customer.
function snapshotMatchesLine1(snapshot, line1) {
  const lineKey = addressMatchKey(line1);
  if (!lineKey) return false;
  const segKey = addressMatchKey(String(snapshot ?? '').split(',')[0]);
  return !!segKey && segKey === lineKey;
}

async function propagateCustomerAddressChange({ before, after }, conn = db) {
  const counts = { leads: 0, estimates: 0 };
  const customerId = (after && after.id) || (before && before.id);
  if (!customerId) return counts;
  // An address REMOVAL is not propagated — blanking a lead/estimate snapshot
  // would destroy the only remaining record of where service was requested.
  if (!addressMatchKey(after && after.address_line1)) return counts;

  const matchesCustomerAddress = (snapshot) =>
    snapshotMatchesLine1(snapshot, before && before.address_line1)
    || snapshotMatchesLine1(snapshot, after.address_line1);

  const now = new Date();
  const fullAddress = formatAddress({
    line1: after.address_line1, city: after.city, state: after.state, zip: after.zip,
  }).slice(0, 300);

  // The updates re-assert the open/terminal predicates from the selects: a
  // concurrent accept/archive/close landing between select and update must
  // not have its now-historical snapshot rewritten.
  const leadRows = await conn('leads')
    .where({ customer_id: customerId })
    .where((q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_LEAD_STATUSES))
    .select('id', 'address');
  const leadIds = leadRows.filter((r) => matchesCustomerAddress(r.address)).map((r) => r.id);
  if (leadIds.length) {
    counts.leads = await conn('leads')
      .whereIn('id', leadIds)
      .where((q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_LEAD_STATUSES))
      .update({
        address: after.address_line1,
        city: after.city || null,
        zip: after.zip || null,
        updated_at: now,
      });
  }

  const estimateRows = await conn('estimates')
    .where({ customer_id: customerId })
    .whereIn('status', OPEN_ESTIMATE_STATUSES)
    .whereNull('archived_at')
    .select('id', 'address', 'estimate_data');
  for (const row of estimateRows) {
    if (!matchesCustomerAddress(row.address)) continue;
    const patch = { address: fullAddress, updated_at: now };
    // An authored proposal snapshots its own copy (estimate_data.proposal.
    // propertyAddress) which normalizeProposal PREFERS over estimates.address
    // and the proposal PDF prints — patch it under the same guard or a resend
    // still attaches a PDF with the old address.
    const data = typeof row.estimate_data === 'string'
      ? (() => { try { return JSON.parse(row.estimate_data); } catch { return null; } })()
      : row.estimate_data;
    if (data?.proposal?.propertyAddress && matchesCustomerAddress(data.proposal.propertyAddress)) {
      data.proposal.propertyAddress = fullAddress.slice(0, 200);
      patch.estimate_data = JSON.stringify(data);
    }
    counts.estimates += await conn('estimates')
      .where({ id: row.id })
      .whereIn('status', OPEN_ESTIMATE_STATUSES)
      .whereNull('archived_at')
      .update(patch);
  }

  if (counts.leads || counts.estimates) {
    // Counts only — never the address values (PII stays out of logs).
    logger.info(`[address-fanout] customer ${customerId}: synced ${counts.leads} lead(s), ${counts.estimates} estimate(s)`);
  }
  return counts;
}

module.exports = { addressMatchKey, snapshotMatchesLine1, propagateCustomerAddressChange };
