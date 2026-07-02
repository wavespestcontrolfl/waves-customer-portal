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
const { formatAddress, normalizeStreetLine } = require('../utils/address-normalizer');

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

// A comma segment that is a secondary-unit designator ("Apt 2", "# 4",
// "Suite 200") — a snapshot carrying one refers to a distinct unit even when
// its street segment matches the customer's unitless line. "FL" (floor) is
// deliberately absent: every Florida address has an ", FL 34211" segment.
const UNIT_SEGMENT_RE = /^\s*(?:apt|apartment|unit|ste|suite|bldg|building|lot|trlr|rm|#)\s*#?\s*[\w-]+\s*$/i;

// True when a stored snapshot refers to the given street line. The comparison
// is EXACT key equality on the snapshot's first comma-segment: whole-string
// equality covers street-line snapshots (leads.address); the first segment of
// a full single-line snapshot ("123 Main St, Bradenton, FL 34205" on
// estimates) is its street line. A prefix check would be wrong here — it
// would let "123 Main St" swallow "123 Main St Apt 2" — and a snapshot whose
// LATER segment is a unit designator ("123 Main St, Apt 2, Bradenton") is a
// distinct unit too, so it never matches a unitless customer line.
function snapshotMatchesLine1(snapshot, line1) {
  // Both sides pass through normalizeStreetLine before keying so suffix
  // spelling differences compare equal — customer writes store abbreviated
  // suffixes ("123 Main St") while older lead/estimate snapshots may carry
  // the unabbreviated form ("123 Main Street").
  const lineKey = addressMatchKey(normalizeStreetLine(line1));
  if (!lineKey) return false;
  const segments = String(snapshot ?? '').split(',');
  if (segments.slice(1).some((seg) => UNIT_SEGMENT_RE.test(seg))) return false;
  const segKey = addressMatchKey(normalizeStreetLine(segments[0]));
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
  const hasCityZip = !!(addressMatchKey(after.city) && addressMatchKey(after.zip));

  const leadRows = await conn('leads')
    .where({ customer_id: customerId })
    .where((q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_LEAD_STATUSES))
    .select('id', 'address');
  // Some intake paths store a FULL single-line address in leads.address (the
  // contact-normalization backfill deliberately left those untouched) —
  // rewriting one with just the street line would drop its embedded
  // city/state/zip. Full-string snapshots get the rebuilt full address (which
  // needs city+zip, same rule as estimates below); street-line snapshots get
  // the street line.
  const matched = leadRows.filter((r) => matchesCustomerAddress(r.address));
  const leadGroups = [
    { ids: matched.filter((r) => !String(r.address || '').includes(',')).map((r) => r.id), address: after.address_line1 },
    { ids: hasCityZip ? matched.filter((r) => String(r.address || '').includes(',')).map((r) => r.id) : [], address: fullAddress },
  ];
  for (const group of leadGroups) {
    if (!group.ids.length) continue;
    // city/zip are patched only when the customer row actually HAS them — a
    // street-only customer edit must not erase more complete location data
    // captured on the lead.
    const leadPatch = { address: group.address, updated_at: now };
    if (addressMatchKey(after.city)) leadPatch.city = after.city;
    if (addressMatchKey(after.zip)) leadPatch.zip = after.zip;
    counts.leads += await conn('leads')
      .whereIn('id', group.ids)
      .where((q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_LEAD_STATUSES))
      .update(leadPatch);
  }

  // Estimates snapshot ONE full display string, so rebuilding it needs the
  // customer's city+zip — with either missing, a rewrite would produce a
  // less complete address than the snapshot already has. Skip instead.
  if (hasCityZip) {
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
      // still attaches a PDF with the old address. The write is a targeted
      // jsonb_set (mirroring the send path's merge discipline) so a concurrent
      // proposal save / send-snapshot merge is never clobbered by a full
      // estimate_data overwrite — and it drops proposalDelivery, because the
      // address change makes the prior "PDF emailed" claim stale (same rule as
      // clearStaleProposalDelivery on proposal re-authoring).
      const data = typeof row.estimate_data === 'string'
        ? (() => { try { return JSON.parse(row.estimate_data); } catch { return null; } })()
        : row.estimate_data;
      // Skip when the proposal already holds the target address — the callers
      // run on address-field PRESENCE (unchanged resaves included), and a
      // no-op rewrite here would still drop proposalDelivery, clearing the
      // "PDF emailed" marker on an already-sent proposal for nothing.
      const proposalCurrent = data?.proposal?.propertyAddress;
      const proposalAlreadyTarget = addressMatchKey(proposalCurrent) === addressMatchKey(fullAddress.slice(0, 200));
      if (proposalCurrent && !proposalAlreadyTarget && matchesCustomerAddress(proposalCurrent)) {
        patch.estimate_data = conn.raw(
          "jsonb_set(COALESCE(estimate_data, '{}'::jsonb), '{proposal,propertyAddress}', to_jsonb(?::text)) - 'proposalDelivery'",
          [fullAddress.slice(0, 200)],
        );
      }
      counts.estimates += await conn('estimates')
        .where({ id: row.id })
        .whereIn('status', OPEN_ESTIMATE_STATUSES)
        .whereNull('archived_at')
        .update(patch);
    }
  }

  if (counts.leads || counts.estimates) {
    // Counts only — never the address values (PII stays out of logs).
    logger.info(`[address-fanout] customer ${customerId}: synced ${counts.leads} lead(s), ${counts.estimates} estimate(s)`);
  }
  return counts;
}

module.exports = { addressMatchKey, snapshotMatchesLine1, propagateCustomerAddressChange };
