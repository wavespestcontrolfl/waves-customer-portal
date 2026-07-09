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
const { formatAddress, normalizeStreetLine, UNIT_DESIGNATORS } = require('../utils/address-normalizer');

// Deliverable estimate states — mirrors SENDABLE_ESTIMATE_STATUSES in
// routes/admin-estimates.js (scheduled/sending/send_failed rows still produce
// customer-facing email/PDF content on their next attempt, so their snapshot
// must not go stale either). Terminal lead states mirror CLOSED_STATUSES in
// intelligence-bar/leads-tools.js.
// 'sending' is deliberately ABSENT even though it is sendable: a row in that
// state has an in-flight send holding the proposal PDF it already built —
// rewriting the snapshot under it would let the final send stamp
// proposalDelivery against an address the attached PDF never used. The row
// still matches the old address once it settles (sent/send_failed), so the
// next fan-out heals it.
const OPEN_ESTIMATE_STATUSES = ['draft', 'scheduled', 'sent', 'viewed', 'send_failed'];
const TERMINAL_LEAD_STATUSES = ['won', 'lost', 'disqualified', 'duplicate', 'unresponsive'];

// Lowercased alphanumerics only — spacing/punctuation/casing differences
// (including speech-to-text spacing like "Tober Morey") compare equal.
function addressMatchKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// A comma segment that is a secondary-unit designator ("Apt 2", "# 4",
// "Suite 200", "Floor 2", "Space 12") — a snapshot carrying one refers to a
// distinct unit even when its street segment matches the customer's unitless
// line. Built from the address normalizer's shared UNIT_DESIGNATORS so the
// two lists can't drift, EXCEPT "fl": every Florida address has an
// ", FL 34211" segment ("floor" spelled out still counts). trlr/rm are USPS
// designators the shared list doesn't carry.
const UNIT_SEGMENT_DESIGNATORS = [...UNIT_DESIGNATORS].filter((d) => d !== 'fl').concat(['trlr', 'rm']);
const UNIT_SEGMENT_RE = new RegExp(`^\\s*(?:${UNIT_SEGMENT_DESIGNATORS.join('|')}|#)\\.?\\s*#?\\s*[\\w-]+\\s*$`, 'i');

// A tail segment carrying no city information (state, zip, country) — used
// to find the city segment of a full single-line snapshot.
const NON_CITY_TAIL_RE = /^\s*(?:fl|florida)?\s*(?:\d{5}(?:-\d{4})?)?\s*(?:usa|united states)?\s*$/i;

// True when a stored snapshot refers to the given contact's address. The
// street line compares by EXACT key equality on the snapshot's first
// comma-segment (a prefix check would let "123 Main St" swallow "123 Main St
// Apt 2"), a later unit-designator segment ("..., Apt 2, ...") never matches
// a unitless line, and both sides pass through normalizeStreetLine so suffix
// spelling ("Street"/"St") compares equal.
//
// A FULL-string snapshot must also corroborate the PLACE, not just the street
// line — the same customer can have two properties on identically-named
// streets in different cities (addressKey identity elsewhere includes
// city/zip for the same reason). ZIP is the strong discriminator when both
// sides have one; postal-city names alias (Bradenton / Lakewood Ranch share
// 34211), so the city comparison only applies when no zip comparison is
// possible. Missing data on either side corroborates nothing and matches —
// skipping a genuine copy is safer than clobbering a different property, but
// only when the data actually says they differ.
function snapshotMatchesContact(snapshot, contact) {
  if (!contact) return false;
  const lineKey = addressMatchKey(normalizeStreetLine(contact.address_line1));
  if (!lineKey) return false;
  const segments = String(snapshot ?? '').split(',');
  if (segments.slice(1).some((seg) => UNIT_SEGMENT_RE.test(seg))) return false;
  const segKey = addressMatchKey(normalizeStreetLine(segments[0]));
  if (!segKey || segKey !== lineKey) return false;
  if (segments.length === 1) return true; // bare street line — nothing more to check

  return placeCorroborates(contact, snapshotTailPlace(snapshot) || {});
}

// The place evidence a full single-line snapshot carries in its comma tail
// (zip and/or a city segment); null for a bare street line. A tail like
// ", FL" carries NO evidence — callers with separate city/zip columns fall
// back to those.
function snapshotTailPlace(snapshot) {
  const segments = String(snapshot ?? '').split(',');
  if (segments.length === 1) return null;
  const tail = segments.slice(1).join(' ');
  const zip = (tail.match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1] || null;
  const citySeg = segments.slice(1).find((seg) => seg.trim() && !NON_CITY_TAIL_RE.test(seg)) || '';
  const city = citySeg.replace(/\b(?:fl|florida)\b/gi, '').replace(/\b\d{5}(?:-\d{4})?\b/g, '');
  return { zip, city };
}

// ZIP is the strong discriminator when both sides have one; postal-city names
// alias (Bradenton / Lakewood Ranch share 34211), so the city comparison only
// applies when no zip comparison is possible. Missing data on either side
// corroborates nothing and matches.
function placeCorroborates(contact, place) {
  const placeZip = (String(place.zip || '').match(/\d{5}/) || [])[0] || null;
  const contactZip = String(contact.zip || '').trim().slice(0, 5);
  const contactHasZip = /^\d{5}$/.test(contactZip);
  if (placeZip && contactHasZip) return placeZip === contactZip;
  const contactCityKey = addressMatchKey(contact.city);
  const placeCityKey = addressMatchKey(place.city);
  // A snapshot that NAMES a place cannot be corroborated by a contact that
  // offers none — a place-less customer row being filled in must not adopt a
  // same-street snapshot from a different city. (The reverse stays
  // permissive: a place-less snapshot has no evidence to contradict.)
  if ((placeZip || placeCityKey) && !contactHasZip && !contactCityKey) return false;
  if (!contactCityKey || !placeCityKey) return true;
  return placeCityKey === contactCityKey;
}

// Back-compat shape for callers/tests that only have a street line.
function snapshotMatchesLine1(snapshot, line1) {
  return snapshotMatchesContact(snapshot, { address_line1: line1 });
}

async function propagateCustomerAddressChange({ before, after }, conn = db) {
  const counts = { leads: 0, estimates: 0 };
  const customerId = (after && after.id) || (before && before.id);
  if (!customerId) return counts;
  // An address REMOVAL is not propagated — blanking a lead/estimate snapshot
  // would destroy the only remaining record of where service was requested.
  if (!addressMatchKey(after && after.address_line1)) return counts;

  const matchesCustomerAddress = (snapshot) =>
    snapshotMatchesContact(snapshot, before) || snapshotMatchesContact(snapshot, after);

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
    .select('id', 'address', 'city', 'zip');
  // A bare street-line lead keeps its place in the separate city/zip COLUMNS,
  // so those must corroborate the contact the same way a full snapshot's tail
  // does — a second property on an identically-named street in another
  // city/zip is never treated as a copy.
  const leadMatchesContact = (r, contact) => {
    if (!snapshotMatchesContact(r.address, contact)) return false;
    // Only a tail carrying REAL place evidence (zip or city) counts as
    // corroborated — "100 Main St, FL" names nothing, so the lead's separate
    // city/zip columns must still agree.
    const tail = snapshotTailPlace(r.address);
    if (tail && (tail.zip || addressMatchKey(tail.city))) return true;
    return placeCorroborates(contact, { city: r.city, zip: r.zip });
  };
  // Some intake paths store a FULL single-line address in leads.address (the
  // contact-normalization backfill deliberately left those untouched) —
  // rewriting one with just the street line would drop its embedded
  // city/state/zip. Full-string snapshots get the rebuilt full address (which
  // needs city+zip, same rule as estimates below); street-line snapshots get
  // the street line.
  const matched = leadRows.filter((r) => leadMatchesContact(r, before) || leadMatchesContact(r, after));
  const leadGroups = [
    { rows: matched.filter((r) => !String(r.address || '').includes(',')), address: after.address_line1 },
    // leads.address is varchar(255) (default knex string) — an oversized full
    // string would throw INSIDE the caller's transaction and roll back the
    // whole customer edit.
    { rows: hasCityZip ? matched.filter((r) => String(r.address || '').includes(',')) : [], address: fullAddress.slice(0, 255) },
  ];
  for (const group of leadGroups) {
    // city/zip are patched only when the customer row actually HAS them — a
    // street-only customer edit must not erase more complete location data
    // captured on the lead.
    const leadPatch = { address: group.address, updated_at: now };
    if (addressMatchKey(after.city)) leadPatch.city = after.city;
    if (addressMatchKey(after.zip)) leadPatch.zip = after.zip;
    // No-op rows are skipped entirely: fan-out runs on address-field PRESENCE
    // (resaves included), and bumping updated_at on an unchanged lead would
    // silently move it out of the staleness/follow-up queries keyed on it.
    const rowsToPatch = group.rows
      .filter((r) => addressMatchKey(r.address) !== addressMatchKey(group.address)
        || (leadPatch.city !== undefined && addressMatchKey(r.city) !== addressMatchKey(leadPatch.city))
        || (leadPatch.zip !== undefined && addressMatchKey(r.zip) !== addressMatchKey(leadPatch.zip)));
    // Per-row updates that re-assert ownership, open status, AND the exact
    // address the row was selected with: a concurrent relink (public-quote
    // writes leads.customer_id), a close, or an admin lead-address edit
    // landing between select and update must not be overwritten.
    for (const r of rowsToPatch) {
      // city/zip re-assert via IS NOT DISTINCT FROM (nullable columns): for a
      // bare-street row those columns are the place evidence that qualified
      // the match, so a concurrent city/zip edit must void the patch too.
      counts.leads += await conn('leads')
        .where({ id: r.id, customer_id: customerId, address: r.address })
        .whereRaw('city IS NOT DISTINCT FROM ?', [r.city ?? null])
        .whereRaw('zip IS NOT DISTINCT FROM ?', [r.zip ?? null])
        .where((q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_LEAD_STATUSES))
        .update(leadPatch);
    }
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
      // Same normalization as the matcher (suffix spelling, trailing USA) —
      // a raw-key compare would call '123 Main Street, …' stale against the
      // freshly formatted '123 Main St, …' and drop proposalDelivery on an
      // already-correct proposal.
      const proposalTargetKey = (value) => {
        const segs = String(value ?? '').replace(/,?\s*(?:USA|United States)\s*$/i, '').split(',');
        // State names normalize too ('Florida 34211' ≡ 'FL 34211') — the
        // matcher treats them as the same place by zip, so a spelled-out
        // state must not read as a stale proposal and drop proposalDelivery.
        return [normalizeStreetLine(segs[0]), ...segs.slice(1)]
          .map((x) => addressMatchKey(String(x).replace(/\bflorida\b/gi, 'fl')))
          .join('|');
      };
      const proposalTarget = fullAddress.slice(0, 200);
      const proposalAlreadyTarget = proposalTargetKey(proposalCurrent) === proposalTargetKey(proposalTarget);
      const patchPropertyAddress = !!(proposalCurrent && !proposalAlreadyTarget && matchesCustomerAddress(proposalCurrent));
      // Synthesized-fallback proposals also carry the address as a BUILDING
      // name (the PDF prints building.name) — patch those under the same
      // guard, leaving truly custom building names alone.
      const buildings = Array.isArray(data?.proposal?.buildings) ? data.proposal.buildings : null;
      const patchedBuildings = buildings
        ? buildings.map((b) => (
          b && typeof b.name === 'string'
            && matchesCustomerAddress(b.name)
            && proposalTargetKey(b.name) !== proposalTargetKey(proposalTarget)
            ? { ...b, name: proposalTarget }
            : b))
        : null;
      const patchBuildings = !!(patchedBuildings && JSON.stringify(patchedBuildings) !== JSON.stringify(buildings));
      if (patchPropertyAddress || patchBuildings) {
        let expr = "COALESCE(estimate_data, '{}'::jsonb)";
        const bindings = [];
        if (patchPropertyAddress) {
          expr = `jsonb_set(${expr}, '{proposal,propertyAddress}', to_jsonb(?::text))`;
          bindings.push(proposalTarget);
        }
        if (patchBuildings) {
          expr = `jsonb_set(${expr}, '{proposal,buildings}', ?::jsonb)`;
          bindings.push(JSON.stringify(patchedBuildings));
        }
        patch.estimate_data = conn.raw(`${expr} - 'proposalDelivery'`, bindings);
      }
      // Same no-op rule as leads: an already-at-target row with no proposal
      // patch gets no write (and no updated_at bump).
      if (!patch.estimate_data && String(row.address || '') === fullAddress) continue;
      if (patch.estimate_data) {
        // The proposal patch was decided from the SELECTed estimate_data — a
        // proposal save committing in between must not have its fresh content
        // rewritten (or its delivery marker dropped) from that stale read.
        // Revalidate the proposal address at update time; if it moved, apply
        // the address-column sync alone and leave the new proposal be.
        let guarded = conn('estimates')
          .where({ id: row.id, customer_id: customerId, address: row.address })
          .whereRaw("estimate_data #>> '{proposal,propertyAddress}' IS NOT DISTINCT FROM ?", [proposalCurrent ?? null])
          .whereIn('status', OPEN_ESTIMATE_STATUSES)
          .whereNull('archived_at');
        if (patchBuildings) {
          // The buildings array is part of the stale read too — a concurrent
          // proposal save that edits buildings/line-items WITHOUT moving the
          // property address must not have its fresh array overwritten.
          guarded = guarded.whereRaw("estimate_data #> '{proposal,buildings}' IS NOT DISTINCT FROM ?::jsonb", [JSON.stringify(buildings)]);
        }
        const n = await guarded.update(patch);
        counts.estimates += n;
        if (n) continue;
        delete patch.estimate_data;
        if (String(row.address || '') === fullAddress) continue;
      }
      counts.estimates += await conn('estimates')
        .where({ id: row.id, customer_id: customerId, address: row.address })
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

module.exports = { addressMatchKey, snapshotMatchesContact, snapshotMatchesLine1, propagateCustomerAddressChange };
