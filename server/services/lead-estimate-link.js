const db = require('../models/db');
const { phoneMatchDigits } = require('../utils/phone');
const logger = require('./logger');
const leadAttribution = require('./lead-attribution');
const { resolveLeadSource } = require('./lead-source-resolver');
const { etDateString } = require('../utils/datetime-et');
const { bridgeLeadFunnelStage, stampLeadFunnelRow, FUNNEL_STAGE_RANK } = require('./lead-funnel-bridge');
const { OPEN_LEAD_STATUSES } = require('./lead-statuses');

const CLOSED_LEAD_STATUSES = new Set(['won', 'lost', 'unresponsive', 'disqualified', 'duplicate']);

// A DATE column comes back as a 'YYYY-MM-DD' string or a UTC-midnight Date — take
// its calendar day directly, without shifting it through a timezone.
function dateOnly(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return new Date(v).toISOString().slice(0, 10);
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits || null;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase() || null;
}

// A public-quote repeat run inserts its own lead row as status 'duplicate'
// with extracted_data.duplicate_of_lead_id naming the OPEN lead the customer
// is actually in the pipeline as (routes/public-quote.js). 'duplicate' is a
// CLOSED status here, so lifecycle events on the repeat run's estimate
// (sent / viewed / accepted) would otherwise advance nothing and an accepted
// rerun would credit no lead as won (pre-push P1 on #3834). This is the
// trusted linkage path — the estimate token, not the public route, drives
// it — and the link is followed one hop only; the caller still re-validates
// the target (open, unlinked, contact matches the estimate) exactly as it
// would the named lead.
// Follows the marker to the open root, hop by hop: two concurrent repeats
// of an existing open lead O can chain B → A → O when B picked A before A's
// own relabel landed (codex #3834 r10 P1), so one hop would stop on the
// closed duplicate A. Bounded and cycle-safe; a dead end (marker without a
// row) resolves to the named lead itself, as before. A soft-deleted row —
// the named one or any hop — is out of every live mutation path (admin
// delete contract), so it is never followed to a live original (codex
// #3834 r11 P1).
function extractedDataOf(lead) {
  let data = lead && lead.extracted_data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
  return data || null;
}

function duplicateMarkerOf(lead) {
  const data = extractedDataOf(lead);
  return (data && data.duplicate_of_lead_id) || null;
}

// The estimate a conversion closed, as markConverted persisted it on the
// won row — the settlement scope a replayed conversion without an estimate
// of its own must keep (codex #3834 r37 P1).
function wonEstimateOf(lead) {
  const data = extractedDataOf(lead);
  return (data && data.won_estimate_id) || null;
}

async function followDuplicateLink(database, lead) {
  const seen = new Set();
  let current = lead;
  while (current && current.status === 'duplicate' && !seen.has(current.id) && seen.size < 8) {
    if (current.deleted_at) return lead;
    seen.add(current.id);
    const originalId = duplicateMarkerOf(current);
    if (!originalId) return current;
    const original = await database('leads').where({ id: originalId }).first();
    if (!original || original.deleted_at) return lead;
    current = original;
  }
  return current;
}

// The identity a claimed write pins — customer link, phone, email, AND the
// estimate link — exactly as the row was read (codex #3834 r17 P1, r18 P1):
// a row staff linked to a different estimate after the read is that deal's
// lead, and this event's value hints must not land on it (codex r22 P1).
const identityOf = (row) => ({ customer_id: row.customer_id ?? null, phone: row.phone ?? null, email: row.email ?? null, estimate_id: row.estimate_id ?? null });
// Whether a re-read row still carries the contact identity it was read
// with (the estimate link is judged separately by every caller).
const sameContactIdentity = (read, current) => ['customer_id', 'phone', 'email'].every((key) => (current[key] ?? null) === (read[key] ?? null));

// Where a converted wizard repeat's win lands in the funnel when the bridge
// found no row on the repeat itself (/calculate dropped it when the row was
// filed as a repeat): its ROOT's row, advanced to booked, when the root — read
// NOW, after the conversion write, never from a check made before it (codex
// #3834 r27 P1) — is still this customer's open opportunity by the accept
// path's rule (positive open membership, same customer link or contact, not
// linked to a different estimate than the repeat); else the repeat's own row,
// rebuilt from its stored touch. One decision for every conversion path
// (accept fallback, self-booking stand-in, admin convert of a repeat whose
// root is still open — codex r27 P2), so a deal never books two rows.
// The rebuild is the settlement's own, under the same lock as every other
// write here (pre-push P1 on 28489d7); the root carries the win when it is
// advanced now, or already at booked / completed from an earlier settlement,
// so a replayed conversion never inserts a second row for the deal (codex
// r28 P1). A lead that is not a wizard repeat settles nothing: every other
// lead with no row has none on purpose (codex r22 P2 / r24 P1). Resolves
// null either way. The root's advance is conditioned
// in SQL on the root still being the row validated here — identity, status,
// estimate link — so a staff edit between the read and the write makes it
// lose and the repeat carries its own row (codex r29 P1); and once the root's
// row carries the win, a lead-stage row the repeat kept because /calculate's
// own delete failed is dropped, so the deal is never counted twice (r29 P2).
// `estimateId` is the estimate the conversion closed (deposit_paid, an
// acceptance): a root linked to a DIFFERENT estimate is that deal's lead —
// the resolver refused it as the keeper for exactly that reason (codex r22
// P1) — so its row must not be booked for this one. The event's scope is
// judged first; an unlinked repeat carries none of its own, and reading only
// the repeat's link let root A take the funnel row of a deposit on estimate
// B (pre-push P1 on 1ea5d47).
async function settleRepeatFunnelRow(database, leadId, { customerId: suppliedCustomerId = null, estimateId = null } = {}) {
  const repeat = await database('leads').where('id', leadId).first();
  if (!duplicateMarkerOf(repeat) || repeat.lead_type !== 'quote_wizard') return null;
  // The customer is the repeat's OWN, as read (and locked below) — the
  // conversion wrote it; a caller's argument is only the fallback for an
  // unlinked row. A stale argument (staff re-assigned the repeat after the
  // caller read it) would otherwise book the old customer's root and drop
  // the new customer's row (pre-push P1 on d511af9).
  const customerId = repeat.customer_id || suppliedCustomerId || null;
  const { root } = await resolveAncestry(database, repeat);
  // The event's scope first; then the scope the winning conversion
  // persisted (a replay carries none of its own); the repeat's link last.
  const scope = estimateId || wonEstimateOf(repeat) || repeat.estimate_id;
  // The root's side of the same rule: the scope ITS win persisted, else its
  // link — an unlinked root that won on estimate A is not the deal a
  // repeat's deposit on estimate B closed, exactly as SECOND_WIN_SQL judges
  // the pair (pre-push P1 on de469d9). Pinned on the lock below.
  const rootScope = root ? wonEstimateOf(root) || root.estimate_id || null : null;
  const sameOpportunity = !!root && !root.deleted_at
    && leadMatchesEstimateContact(root, { customer_id: customerId, customer_phone: repeat.phone, customer_email: repeat.email })
    && !(rootScope && scope && String(rootScope) !== String(scope));
  const rootOurs = sameOpportunity && OPEN_LEAD_STATUSES.includes(root.status);
  // A root of this opportunity that staff has since marked WON is the deal
  // closed: when its funnel row already carries the win (booked or beyond,
  // this customer's or unowned), a replayed conversion of the repeat is
  // settled — nothing is rebuilt beside it, and a row the repeat kept is
  // dropped (the r33 replay residual, fixed). Judged under the lock on the
  // root as won.
  const rootWon = sameOpportunity && root.status === 'won';
  const onlyIfLead = rootOurs || rootWon ? { ...identityOf(root), status: root.status } : null;
  // Every read or write on the root's row below carries the lead claim the
  // advance carried: the root, as validated, still open, not deleted.
  const rootStillOurs = function leadStillMatches() {
    this.select(1).from('leads').whereRaw('leads.id = ad_service_attribution.lead_id').where(onlyIfLead).whereNull('deleted_at');
  };
  // One transaction: the root's advance, its customer stamp and the drop of
  // the repeat's superseded row land together or not at all — a failure
  // between them would leave two rows counting one opportunity with no
  // caller left to retry (pre-push P1). The bridge nests a savepoint.
  // A repeat whose own row reached 'completed' (the revenue sync's sticky
  // terminal, carrying revenue attribution) IS the deal's row: nothing
  // settles beside it, and a row the sync completes UNDER this transaction
  // rolls the root's advance back rather than being deleted (pre-push P0).
  // Both leads are locked under their claims for the WHOLE transaction, so
  // nothing below judges a row that a concurrent admin edit can change
  // between the advance and the drop: the root as validated (identity +
  // status, not deleted — a staff edit to it waits for the commit, and a
  // claim that no longer holds settles nothing, codex #3834 r35 P1), and the
  // repeat still WON — a lost transition landing between the conversion's
  // commit and this settlement must not book its root or rebuild its row
  // (r35 P1). Both are SELECT ... FOR UPDATE, so a writer on either lead
  // blocks until this commits instead of racing it.
  // The repeat's own row, rebuilt from its stored touch at booked, when the
  // root cannot carry the win — inside the same transaction, so the won lock
  // above still holds when the row is inserted (pre-push P1 on 28489d7).
  const KEEP_OWN_ROW = Symbol('keep-own-row');
  const rebuild = async (trx) => { await stampLeadFunnelRow(trx, repeat, { customerId, funnelStage: 'booked' }); return null; };
  return database.transaction(async (trx) => {
    // ...on the identity and marker the settlement was judged with, not the
    // status alone: a repeat staff re-assigned, re-linked or re-pointed since
    // the read would otherwise book the OLD root (pre-push P1 on 0731ebb).
    const stillWon = await trx('leads').where({ id: repeat.id, status: 'won', ...identityOf(repeat) })
      .whereRaw("extracted_data->>'duplicate_of_lead_id' = ?", [duplicateMarkerOf(repeat)])
      .whereNull('deleted_at').forUpdate().first('id');
    if (!stillWon) return null;
    if (!rootOurs && !rootWon) return rebuild(trx);
    const rootHeld = await trx('leads').where({ id: root.id, ...onlyIfLead })
      .whereRaw("COALESCE(extracted_data->>'won_estimate_id', estimate_id::text) IS NOT DISTINCT FROM ?", [rootScope === null ? null : String(rootScope)])
      .whereNull('deleted_at').forUpdate().first('id');
    if (!rootHeld) return rebuild(trx);

    const own = await trx('ad_service_attribution').where({ lead_id: repeat.id }).first('funnel_stage');
    if (own && own.funnel_stage === 'completed') return null;
    // A root row still owned by ANOTHER customer (staff re-assigned the lead
    // after its row was stamped; the bridge preserves a non-null customer)
    // cannot carry this customer's win: booking it would credit the old
    // customer and leave this one with no acquisition row once the repeat's
    // is dropped. The repeat's own row carries the deal (codex #3834 r36 P1).
    const rootOwner = await trx('ad_service_attribution').where({ lead_id: root.id }).first('customer_id');
    if (customerId && rootOwner?.customer_id && String(rootOwner.customer_id) !== String(customerId)) return rebuild(trx);
    // A won root is never advanced (its lead is closed); it is settled only
    // when its row already carries the win — the claimed read below — and
    // then the same customer stamp and retained-row drop apply, so a row the
    // repeat rebuilt while the root was lost never stands beside the root's
    // (pre-push P1 on 795fcc3).
    const bridged = rootWon ? { updated: 0 } : await bridgeLeadFunnelStage(root.id, 'won', trx, { onlyIfLead });
    // A root row already at booked / completed counts as settled only under
    // the SAME lead claim the advance carried — the fallback read must not
    // accept an old stage on a root staff re-identified since (codex r30 P1).
    const rootRow = bridged.updated ? null : await trx('ad_service_attribution').where({ lead_id: root.id }).whereExists(rootStillOurs).first('funnel_stage');
    const settled = !!bridged.updated || (!!rootRow && FUNNEL_STAGE_RANK[rootRow.funnel_stage] >= FUNNEL_STAGE_RANK.booked);
    if (!settled) return rebuild(trx);
    // The root's row now carries this customer's win: an unlinked root
    // (matched by contact) leaves the bridge's COALESCE-from-lead customer
    // NULL, and the revenue sync loads rows by customer_id — so the accepting
    // customer is stamped onto it, never over one already there (codex #3834
    // r32 P1).
    if (customerId) await trx('ad_service_attribution').where({ lead_id: root.id }).whereNull('customer_id').whereExists(rootStillOurs).update({ customer_id: customerId, updated_at: new Date() });
    // IS DISTINCT FROM, not <>: a retained row with a NULL stage (the column
    // is nullable; the bridge ranks NULL as stage 0) is a non-completed row
    // to drop, and <> would leave it in place and read the 0-row delete as
    // a completed row (codex #3834 r33 P2).
    const dropped = await trx('ad_service_attribution').where({ lead_id: repeat.id }).whereRaw("funnel_stage IS DISTINCT FROM 'completed'").del();
    if (own && !dropped) throw KEEP_OWN_ROW;
    return null;
  }).catch((err) => {
    if (err === KEEP_OWN_ROW) return null;
    throw err;
  });
}

// The ancestry a repeat belongs to, for grouping repeats of one inquiry: the
// live non-duplicate root the marker chain reaches, or — when the chain
// dead-ends (a vanished or deleted hop) — the LAST recorded marker on it, so
// every repeat of the same dead end (B → A → O with O gone: A's marker O, and
// B's chain through A to that same O) shares one key instead of each falling
// back to its own immediate marker and reading as two opportunities (codex
// #3834 r17 P1). The same bounded, cycle-safe walk through live duplicate
// hops as followDuplicateLink. A chain that ends on a duplicate parent with
// NO marker (a shared parent staff closed as duplicate by hand) keys on that
// parent — the last row visited — so every repeat of it is one ancestry, not
// one per repeat (codex r28 P1).
async function resolveAncestry(database, repeat) {
  const seen = new Set([repeat.id]);
  let marker = duplicateMarkerOf(repeat);
  let last = repeat.id;
  while (marker && seen.size < 8) {
    const parent = await database('leads').where({ id: marker }).first();
    if (!parent || parent.deleted_at) return { root: null, key: marker };
    if (parent.status !== 'duplicate') return { root: parent, key: parent.id };
    if (seen.has(parent.id)) break;
    seen.add(parent.id);
    last = parent.id;
    marker = duplicateMarkerOf(parent);
  }
  return { root: null, key: marker || last };
}

function leadMatchesEstimateContact(lead, estimate) {
  if (!lead || !estimate) return false;
  if (lead.customer_id && estimate.customer_id) {
    return String(lead.customer_id) === String(estimate.customer_id);
  }

  const leadPhone = normalizePhone(lead.phone);
  const estimatePhone = normalizePhone(estimate.customer_phone);
  if (leadPhone && estimatePhone && leadPhone === estimatePhone) return true;

  const leadEmail = normalizeEmail(lead.email);
  const estimateEmail = normalizeEmail(estimate.customer_email);
  return !!(leadEmail && estimateEmail && leadEmail === estimateEmail);
}

function assertLeadCanAttachEstimate({ lead, estimate, estimateId, allowReplacingEstimateId = false }) {
  if (!lead) {
    const err = new Error('Lead not found');
    err.statusCode = 404;
    throw err;
  }
  if (CLOSED_LEAD_STATUSES.has(lead.status)) {
    const err = new Error('Lead is closed and cannot be linked to a new estimate');
    err.statusCode = 409;
    throw err;
  }
  if (
    lead.estimate_id
    && String(lead.estimate_id) !== String(estimateId)
    && !allowReplacingEstimateId
  ) {
    const err = new Error('Lead is already linked to another estimate');
    err.statusCode = 409;
    throw err;
  }
  if (!leadMatchesEstimateContact(lead, estimate)) {
    const err = new Error('Lead contact does not match estimate contact');
    err.statusCode = 409;
    throw err;
  }
}

function performedByFromTechnician(technician) {
  const name = [technician?.first_name, technician?.last_name].filter(Boolean).join(' ').trim();
  return name || 'system';
}

// respondedAt: when the response actually happened. Live callers leave it null
// (now); the one-off backfill passes the estimate's historical send time so an
// old send is timed from first_contact_at → sent_at, not first_contact_at → today
// (which would stamp a wildly inflated response_time_minutes onto the KPI).
async function recordFirstResponseIfNeeded(database, lead, performedBy = 'system', respondedAt = null) {
  if (!lead || lead.response_time_minutes != null || !lead.first_contact_at) return false;
  const firstContact = new Date(lead.first_contact_at);
  const respondedMs = respondedAt ? new Date(respondedAt).getTime() : Date.now();
  const minutes = Math.max(0, Math.round((respondedMs - firstContact.getTime()) / 60000));
  if (!Number.isFinite(minutes)) return false;

  // Atomic claim: the loaded row may be stale when two responses land
  // concurrently (Comms reply racing an estimate send) — condition on the
  // CURRENT null so exactly one caller stamps and writes the activity row.
  const updated = await database('leads')
    .where({ id: lead.id })
    .whereNull('response_time_minutes')
    .update({
      response_time_minutes: minutes,
      updated_at: new Date(),
    });
  if (!updated) return false;
  await database('lead_activities').insert({
    lead_id: lead.id,
    activity_type: 'first_response',
    description: `First response in ${minutes} minutes`,
    performed_by: performedBy,
  });
  return true;
}

async function attachLeadToEstimate({
  database = db,
  leadId,
  estimateId,
  estimate = null,
  technician,
  allowReplacingEstimateId = false,
}) {
  if (!leadId) return null;

  // Soft-deleted leads can't attach estimates — treat as not found (404).
  const lead = await database('leads').where({ id: leadId }).whereNull('deleted_at').first();

  const estimateForValidation = estimate || await database('estimates').where({ id: estimateId }).first();
  assertLeadCanAttachEstimate({
    lead,
    estimate: estimateForValidation,
    estimateId,
    allowReplacingEstimateId,
  });

  const performedBy = performedByFromTechnician(technician);
  const updates = {
    estimate_id: estimateId,
    updated_at: new Date(),
  };

  await database('leads').where({ id: leadId }).update(updates);
  await database('lead_activities').insert({
    lead_id: leadId,
    activity_type: 'estimate_created',
    description: `Estimate created from lead (${estimateId})`,
    performed_by: performedBy,
    metadata: JSON.stringify({ estimateId }),
  });

  return { ...lead, ...updates };
}

// Resolve which lead(s) an estimate "sent"/"viewed" event should advance.
//
// Primary: FK-linked leads (`leads.estimate_id`) — the authoritative tie, of
// which there may be several (re-sends, manually linked rows). Behavior for this
// case is unchanged.
//
// When NO FK-linked lead exists, rescue the originating lead so a STANDALONE
// estimate — one built outside the lead's "Create Estimate" button (e.g. from the
// Estimates tab, or after Convert to Customer), which never got `leads.estimate_id`
// — still advances its lead on send/view. This mirrors the fallbacks the
// acceptance path (`markLinkedLeadEstimateAccepted`) already uses, so the pipeline
// stays consistent: an estimate that can mark a lead "won" on acceptance can also
// mark it "estimate_sent"/"viewed".
//
// Rescue is deliberately conservative — it never guesses which deal an event
// belongs to:
//   1. the public-quote mirror (`estimate_data.lead_id`) — that lead carries a
//      customer_id, so the contact fallback's `customer_id IS NULL` guard misses it.
//   2. else a SINGLE unambiguous open, never-linked, never-converted lead matched
//      on normalized phone/email. 0 or 2+ matches → none.
// Every rescued candidate must still pass the contact-match check and be open and
// Backfill-safety: is this lead old enough to be the estimate's ORIGINATING lead?
// No cutoff → always true (the live path). With a cutoff, the lead must have been
// first contacted (else created) on/before it; an unknown timestamp fails closed
// (excluded), so we never advance a lead we can't prove pre-dates the estimate.
function leadOriginatedOnOrBefore(lead, cutoff) {
  if (!cutoff) return true;
  const t = lead.first_contact_at || lead.created_at;
  if (!t) return false;
  return new Date(t).getTime() <= new Date(cutoff).getTime();
}

// unlinked. Returns { leads, rescued, estimate }.
//
// opts.originatingNotAfter (Date|null): when set, the FUZZY contact fallback only
// matches a lead first-contacted on/before that instant — never the authoritative
// FK or public-quote-mirror paths. The live send/view callers leave it null (the
// event is happening now, so the matched lead is current by definition). The
// one-off backfill passes the estimate's send time so replaying an OLD estimate
// can't grab a NEWER same-contact inquiry that post-dates it (mirrors the
// `enforceOriginating` guard convertLeadFromEvent uses for its backfill).
async function resolveEstimateEventLeads(database, estimateId, { originatingNotAfter = null } = {}) {
  // The linkage check deliberately INCLUDES soft-deleted rows: any linkage row
  // — even a deleted one — means this estimate's originating lead is accounted
  // for, so we must not fall through to the fuzzy rescue tiers (same rationale
  // as the closed-lead rule in markLinkedLeadEstimateAccepted). Deleted rows
  // are then filtered out so they are never advanced.
  const linked = await database('leads').where({ estimate_id: estimateId });
  if (linked.length) return { leads: linked.filter((lead) => !lead.deleted_at), rescued: false };

  const estimate = await database('estimates').where({ id: estimateId }).first();
  if (!estimate) return { leads: [], rescued: false };

  // 1. Public-quote mirror — match the named lead by id, then re-validate it is
  //    open, not already linked to another estimate, and a genuine contact match.
  const dataLeadId = parseEstimateData(estimate.estimate_data)?.lead_id || null;
  if (dataLeadId) {
    const lead = await followDuplicateLink(database, await database('leads').where({ id: dataLeadId }).first());
    // A FOLLOWED root must be open by positive membership: linking the
    // estimate to a spam or cancelled root would hand acceptance the
    // authoritative FK branch, which converts unconditionally (codex #3834
    // r24 P1). The named row itself keeps the not-closed rule.
    const live = lead && (lead.id === dataLeadId ? !CLOSED_LEAD_STATUSES.has(lead.status) : OPEN_LEAD_STATUSES.includes(lead.status));
    if (
      live
      && !lead.deleted_at
      && !lead.estimate_id
      && leadMatchesEstimateContact(lead, estimate)
    ) {
      return { leads: [lead], rescued: true, estimate };
    }
    return { leads: [], rescued: false };
  }

  // 2. Contact fallback — a single open, never-linked, never-converted lead whose
  //    normalized phone/email matches the estimate's contact. `findUnconverted-
  //    LeadsByContact` already restricts to `customer_id IS NULL` + not-closed;
  //    the extra `!estimate_id` guard ensures we never steal a lead already tied
  //    to a different estimate.
  const matches = (await findUnconvertedLeadsByContact(database, estimate.customer_phone, estimate.customer_email))
    .filter((lead) => !lead.estimate_id && !CLOSED_LEAD_STATUSES.has(lead.status))
    .filter((lead) => leadOriginatedOnOrBefore(lead, originatingNotAfter));
  if (matches.length === 1) return { leads: matches, rescued: true, estimate };
  if (matches.length > 1) {
    logger.warn(`[lead-estimate-link] estimate ${estimateId} send/view: ambiguous contact match (${matches.length} open leads) — not advancing`, {
      estimateId,
      leadIds: matches.map((lead) => lead.id),
    });
    return { leads: [], rescued: false };
  }

  // 3. Customer-linked contact fallback — an OPEN lead that matches the estimate's
  //    contact but already carries a `customer_id` (so tier 2's `customer_id IS
  //    NULL` guard skips it). This is the common shape when the originating
  //    inquiry's estimate was built standalone AFTER a customer record was created
  //    for the lead (e.g. Convert-to-Customer, or an estimate flow that mints a
  //    customer) — the lead never got FK-linked and stayed open. Rescue it ONLY
  //    when it is unambiguously that customer's ORIGINATING deal, reusing the
  //    acceptance path's exact guards so we never advance an established customer's
  //    unrelated add-on inquiry: a single such lead, the customer has no prior WON
  //    lead, and the lead was first contacted on/before they became a customer.
  const linkedMatches = (await findCustomerLinkedLeadsByContact(database, estimate.customer_phone, estimate.customer_email))
    .filter((lead) => !lead.estimate_id && !CLOSED_LEAD_STATUSES.has(lead.status))
    .filter((lead) => leadOriginatedOnOrBefore(lead, originatingNotAfter))
    // These leads carry a customer_id, so when the estimate ALSO has one,
    // leadMatchesEstimateContact requires the two customers to be the SAME — a
    // shared phone/email between two customers (spouses, roommates) must never
    // let this estimate advance the OTHER customer's lead. (When the estimate has
    // no customer_id it falls back to the phone/email match the query already did.)
    .filter((lead) => leadMatchesEstimateContact(lead, estimate));
  if (linkedMatches.length === 1) {
    const lead = linkedMatches[0];
    const established = await customerHasWonLead(database, lead.customer_id);
    const originating = await isOriginatingLead(database, lead.customer_id, lead);
    if (!established && originating) return { leads: [lead], rescued: true, estimate };
    logger.warn(`[lead-estimate-link] estimate ${estimateId} send/view: customer-linked contact match ${lead.id} is not the originating deal (established=${established}, originating=${originating}) — not advancing`, {
      estimateId,
      leadId: lead.id,
      customerId: lead.customer_id,
    });
  } else if (linkedMatches.length > 1) {
    logger.warn(`[lead-estimate-link] estimate ${estimateId} send/view: ambiguous customer-linked contact match (${linkedMatches.length} open leads) — not advancing`, {
      estimateId,
      leadIds: linkedMatches.map((lead) => lead.id),
    });
  }
  return { leads: [], rescued: false };
}

// Stamp `leads.estimate_id` onto a lead rescued by contact/mirror match and log
// the link. Scoped to `estimate_id IS NULL` so a concurrent linker can't be
// clobbered, and to the identity the lead was read with — customer link,
// phone, email — so a root the resolver validated as this estimate's contact
// and staff then re-assigned or re-contacted loses the stamp instead of
// carrying another opportunity's estimate into acceptance, which treats the
// FK as authoritative (codex #3834 r27 P1). Returns one of:
//   'won'           — this call stamped the link (and logged the estimate_created
//                     activity); proceed.
//   'already_ours'  — the stamp touched 0 rows because a concurrent event (e.g.
//                     a simultaneous send + first view of the SAME standalone
//                     estimate) already linked the lead to THIS estimate. Proceed
//                     and record our side effect, but do NOT re-log the link.
//   'conflict'      — the lead is now linked to a DIFFERENT estimate; it isn't
//                     ours to advance. Skip.
async function linkRescuedLead(database, lead, estimate, performedBy) {
  // Stamp only while the lead is still UNLINKED and OPEN — by positive
  // membership (OPEN_LEAD_STATUSES), never NOT-closed: a root staff marked
  // spam or cancelled between the read and the stamp is not answerable, and
  // a not-closed predicate would still link it and hand acceptance the
  // authoritative FK branch (codex #3834 r31 P1). The claim closes the
  // read→stamp window: a lead converted (→ won) or otherwise closed after
  // resolveEstimateEventLeads read it no-ops rather than linking a
  // closed/converted lead to this standalone estimate and logging
  // estimate_created/sent for it (which would corrupt attribution).
  const linked = await database('leads')
    .where({ id: lead.id })
    .whereNull('estimate_id')
    .whereIn('status', OPEN_LEAD_STATUSES)
    .where(identityOf(lead))
    .update({ estimate_id: estimate.id, updated_at: new Date() });
  if (linked) {
    await database('lead_activities').insert({
      lead_id: lead.id,
      activity_type: 'estimate_created',
      description: `Estimate linked to lead by contact match (${estimate.id})`,
      performed_by: performedBy,
      metadata: JSON.stringify({ estimateId: estimate.id, linkedBy: 'contact_match' }),
    });
    return 'won';
  }
  // 0 rows — a concurrent stamp won the race. Re-read to see whether it landed on
  // THIS estimate (still ours → proceed) or a different one (not ours → skip).
  // The same-estimate winner must still carry the identity the lead was read
  // with: a write that re-identified the row AND linked it to this estimate
  // is another opportunity (codex r25 P1, r27 P1).
  const current = await database('leads').where({ id: lead.id }).first();
  return current && String(current.estimate_id) === String(estimate.id) && sameContactIdentity(lead, current) ? 'already_ours' : 'conflict';
}

// SLA truth, decoupled from attribution. An estimate or human reply delivered
// to a contact IS a first response to EVERY open lead carrying that phone or
// email — even when the strict linkage tiers refuse to link/advance
// (ambiguous match, non-originating add-on inquiry, prior won lead). Those
// guards protect funnel attribution; they must not leave answered leads
// counting as "still waiting" in the Speed-to-Lead backlog forever (52-lead
// pileup found in the 2026-07-30 audit — 6 of them had sent estimates).
// Stamps response_time_minutes only — never status, never estimate_id, never
// the funnel bridge.
async function stampFirstResponseByContact({ database = db, phone = null, email = null, performedBy = 'system', respondedAt = null, originatingNotAfter = null, failSoft = true }) {
  const normPhone = normalizePhone(phone);
  const normEmail = normalizeEmail(email);
  if (!normPhone && !normEmail) return 0;
  let stamped = 0;
  try {
    // Positive membership (OPEN_LEAD_STATUSES), not NOT-IN(closed): a
    // negative filter silently re-includes any status it forgot (cancelled /
    // spam leads are not closed-set members but are not answerable either).
    const query = database('leads')
      .whereNull('deleted_at')
      .whereNull('response_time_minutes')
      .whereNotNull('first_contact_at')
      .whereIn('status', OPEN_LEAD_STATUSES)
      .where(function contactMatch() {
        if (normPhone) {
          // normalizePhone yields 10 digits for NANP; anything longer is an
          // international E.164 tail — match the FULL digit string there, or
          // a +44 caller would stamp the US lead sharing its last ten digits.
          // The NANP branch guards the STORED side the same way: only
          // NANP-shaped rows (10 digits, or 11 leading with 1) suffix-match,
          // so a US reply can't stamp an international lead sharing its tail.
          if (normPhone.length === 10) {
            this.orWhereRaw(
              "(RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?"
              + " AND (char_length(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')) = 10"
              + " OR (char_length(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')) = 11"
              + " AND LEFT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 1) = '1')))",
              [normPhone],
            );
          } else {
            this.orWhereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?", [normPhone]);
          }
        }
        if (normEmail) this.orWhereRaw("LOWER(TRIM(COALESCE(email, ''))) = ?", [normEmail]);
      });
    // A response cannot precede the inquiry: on historical replays
    // (respondedAt from the backfill) only leads that already existed at the
    // response moment are answered by it. originatingNotAfter (the backfill's
    // cutoff) narrows the same way — a newer open inquiry sharing the contact
    // must keep its live SLA clock.
    if (respondedAt) query.where('first_contact_at', '<=', new Date(respondedAt));
    if (originatingNotAfter) query.where('first_contact_at', '<=', new Date(originatingNotAfter));
    const leads = await query;
    for (const lead of leads) {
      stamped += (await recordFirstResponseIfNeeded(database, lead, performedBy, respondedAt)) ? 1 : 0;
    }
  } catch (e) {
    // SLA bookkeeping must never break a live send — but repair jobs (the
    // backfill) pass failSoft:false so a swallowed failure can't report a
    // clean run while eligible leads stay unstamped.
    logger.warn(`[lead-estimate-link] first-response contact stamp failed: ${e.message}`);
    if (!failSoft) throw e;
  }
  return stamped;
}

async function markLinkedLeadEstimateSent({ estimateId, sendMethod, performedBy = 'system', database = db, originatingNotAfter = null, respondedAt = null, sentChannels = null }) {
  if (!estimateId) return;
  const { leads, rescued, estimate } = await resolveEstimateEventLeads(database, estimateId, { originatingNotAfter });
  for (const lead of leads) {
    // Advance a rescued lead only while it is linked to THIS estimate. A 'conflict'
    // means another estimate claimed it between resolution and now; 'already_ours'
    // means a concurrent same-estimate event linked it first — still ours, so we
    // record this event's side effect.
    if (rescued && estimate && (await linkRescuedLead(database, lead, estimate, performedBy)) === 'conflict') continue;
    // Gate the transition in SQL on the CURRENT status, not the stale loaded row:
    // a concurrent first-view may already have advanced the lead to estimate_viewed,
    // and this predicate prevents a stale 'new' read from downgrading it back to
    // estimate_sent. The status whitelist also subsumes the closed-status guard.
    const advanced = await database('leads')
      .where({ id: lead.id })
      .whereIn('status', ['new', 'contacted'])
      .update({ status: 'estimate_sent', updated_at: new Date() });
    // Mirror the transition onto the lead's ad_service_attribution funnel row —
    // but ONLY when the status update actually applied. A replayed send event
    // on a lead that is already won/lost updates 0 rows, and bridging anyway
    // would advance a closed deal's funnel row to an intermediate estimate
    // stage it should never re-enter (the won/lost transition already stamped
    // its terminal stage). The bridge's monotonic rank guards downgrades; this
    // guards phantom advances.
    if (advanced) await bridgeLeadFunnelStage(lead.id, 'estimate_sent', database);
    // Sending an estimate IS qualification. The extraction model's
    // lead_quality drives the auto-set flag, and a mislabelled "cold" on a
    // real buyer left the lead sitting unqualified while the customer was
    // reading the estimate (2026-08-31: nine open leads in that state, one
    // of them viewed within a minute of sending). Behavioural evidence
    // outranks the label: if the office judged the lead worth an estimate,
    // it is by definition workable. Scoped to open statuses so a replayed
    // send event can never re-qualify a lead a human explicitly
    // disqualified or closed, and IS DISTINCT FROM so never-judged (NULL)
    // rows qualify too — plain != TRUE is NULL for them and would skip
    // exactly the rows this exists to fix.
    // Current-state guards, not the stale loaded row: between the resolve
    // read and this write an admin can soft-delete the lead or move its
    // estimate link, and a send must not qualify (and log activity on) a
    // deleted or re-linked lead. estimate_id rides in the WHERE — the
    // FK-linked path resolved by it and the rescue path just stamped it, so
    // a mismatch means the link moved. deleted_at folds into the raw
    // predicate alongside the DISTINCT FROM guard.
    // Fault-isolated (codex r2): a failure anywhere in the qualify lane must
    // not skip the first-response stamp and estimate_sent activity below —
    // and if the flag committed but its audit insert failed, that gap is
    // LOGGED loudly, because the IS DISTINCT FROM guard means no replay will
    // ever re-attempt the activity for an already-true flag.
    // An explicitly EMPTY sentChannels array means every channel was
    // suppressed (gate/template/owner-kill sentinel) and nothing reached the
    // customer — no behavioural evidence, no qualification. A missing array
    // (historical callers) keeps the sendMethod fallback semantics the SLA
    // stamp below already uses.
    const nothingDelivered = Array.isArray(sentChannels) && sentChannels.length === 0;
    if (nothingDelivered) {
      logger.info(`[lead-estimate-link] qualify-on-send skipped for lead ${lead.id}: all channels suppressed`);
    } else try {
      // Flag and audit row commit or roll back TOGETHER (codex r4): the
      // IS DISTINCT FROM guard means no later send would ever re-attempt
      // the activity for an already-true flag, so a flag committed without
      // its audit row would be a permanent gap. database.transaction is a
      // real transaction on the root handle and a savepoint when the caller
      // already passed a trx.
      await database.transaction(async (trx) => {
        const qualifiedNow = await trx('leads')
          .where({ id: lead.id, estimate_id: estimateId })
          .whereIn('status', OPEN_LEAD_STATUSES)
          .whereRaw('is_qualified IS DISTINCT FROM TRUE AND deleted_at IS NULL')
          .update({ is_qualified: true, updated_at: new Date() });
        if (qualifiedNow) {
          await trx('lead_activities').insert({
            lead_id: lead.id,
            activity_type: 'qualified',
            description: `Marked qualified — estimate sent (${estimateId})`,
            performed_by: performedBy,
            metadata: JSON.stringify({ estimateId, via: 'estimate_sent' }),
          });
        }
      });
    } catch (qualErr) {
      // Fail-soft for the SEND (the estimate went out either way), but the
      // rollback means flag and audit can never diverge.
      logger.warn(`[lead-estimate-link] qualify-on-send skipped for lead ${lead.id}: ${qualErr.message}`);
    }
    await recordFirstResponseIfNeeded(database, lead, performedBy, respondedAt);
    await database('lead_activities').insert({
      lead_id: lead.id,
      activity_type: 'estimate_sent',
      description: `Estimate sent via ${sendMethod || 'both'} (${estimateId})`,
      performed_by: performedBy,
      metadata: JSON.stringify({ estimateId, sendMethod: sendMethod || 'both' }),
    });
  }
  // Loose SLA stamp for every OTHER open lead with this estimate's contact —
  // the strict loop above only reaches leads the attribution guards accepted.
  // recordFirstResponseIfNeeded no-ops on anything already stamped, so leads
  // handled above are not double-stamped. Fail-soft like the stamp itself:
  // SLA bookkeeping never breaks a send.
  try {
    const estimateRow = estimate || await database('estimates').where({ id: estimateId }).first();
    if (estimateRow) {
      // Only contacts a channel actually REACHED count as answered: an
      // SMS-only send (or a partial 'both' where the email leg failed) must
      // not stamp an email-only matching lead. Callers with per-channel
      // outcomes pass sentChannels — an EMPTY array means nothing real
      // delivered (e.g. a sentinel-suppressed sms leg) and stamps nothing;
      // only a missing array falls back to sendMethod.
      const channels = Array.isArray(sentChannels)
        ? sentChannels
        : (sendMethod === 'sms' ? ['sms'] : sendMethod === 'email' ? ['email'] : ['sms', 'email']);
      await stampFirstResponseByContact({
        database,
        phone: channels.includes('sms') ? estimateRow.customer_phone : null,
        email: channels.includes('email') ? estimateRow.customer_email : null,
        performedBy,
        respondedAt,
        // The backfill's cutoff rides through — a newer inquiry sharing this
        // contact must not be stamped by a historical replay.
        originatingNotAfter,
      });
    }
  } catch (e) {
    logger.warn(`[lead-estimate-link] post-send contact stamp lookup failed for estimate ${estimateId}: ${e.message}`);
  }
}

async function markLinkedLeadEstimateViewed({ estimateId, performedBy = 'system', database = db, originatingNotAfter = null }) {
  if (!estimateId) return;
  const { leads, rescued, estimate } = await resolveEstimateEventLeads(database, estimateId, { originatingNotAfter });
  for (const lead of leads) {
    // Advance only while linked to THIS estimate (see send path for the states).
    if (rescued && estimate && (await linkRescuedLead(database, lead, estimate, performedBy)) === 'conflict') continue;
    // Conditional in SQL on the current status (estimate_viewed is the terminal of
    // these three, so this is monotonic and races can't move the lead backward).
    const advanced = await database('leads')
      .where({ id: lead.id })
      .whereIn('status', ['new', 'contacted', 'estimate_sent'])
      .update({ status: 'estimate_viewed', updated_at: new Date() });
    // Funnel-row mirror, gated on the status actually transitioning — a
    // replayed view on a won/lost lead must not advance its funnel row
    // (see the send path).
    if (advanced) await bridgeLeadFunnelStage(lead.id, 'estimate_viewed', database);
    await database('lead_activities').insert({
      lead_id: lead.id,
      activity_type: 'estimate_viewed',
      description: `Estimate viewed by customer (${estimateId})`,
      performed_by: performedBy,
      metadata: JSON.stringify({ estimateId }),
    });
  }
}

function parseEstimateData(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// Tier 2 of markLinkedLeadEstimateAccepted — the wizard-origination
// acceptance, split out the way resolveCustomerLinkCandidates is from
// convertLeadFromEvent: the row `estimate_data.lead_id` names, its root via
// the one-hop duplicate marker, and the named-row fallback. `convert` is the
// caller's claimed stamp-and-convert.
async function acceptWizardNamedLead(database, { dataLeadId, estimate, estimateId, customerId, convert }) {
  const named = await database('leads').where({ id: dataLeadId }).first();
  // A named row that no longer exists is still "accounted for": never
  // fall through to the contact sweep on a wizard estimate.
  if (!named) return;
  // followDuplicateLink returns the original when the marker resolves and
  // the named row itself otherwise, so `lead` is always a row here.
  let lead = await followDuplicateLink(database, named);
  // An INDIRECTLY resolved original (via a duplicate marker) is validated
  // like the send/view path validates the named lead: its contact must
  // match the accepted estimate, it must not already belong to a different
  // customer (markConverted would overwrite an unrelated lead's customer
  // linkage — codex #3834 r2 P1), and it must not already be FK-linked to
  // a DIFFERENT estimate (the office may have built and sent one for the
  // original after the repeat was filed — converting it here would credit
  // the win to that estimate and leave the accepted one unlinked, codex
  // #3834 r4 P1). A named lead that is itself open converts as before.
  // Functions of the row AS IT IS NOW: `lead` is refreshed in full when a
  // claim loses (and re-pointed when the chain grew, below), and every
  // later judgement re-reads the identity (codex #3834 r16 P1) — not a
  // value computed before the race.
  const indirect = () => lead.id !== named.id;
  const sameOpportunity = () => indirect()
    && leadMatchesEstimateContact(lead, estimate)
    && (!lead.customer_id || !customerId || lead.customer_id === customerId)
    && (!lead.estimate_id || String(lead.estimate_id) === String(estimateId))
    // ...nor won on a different estimate than this one (the scope its
    // conversion persisted on an unlinked root — pre-push P1 on de469d9).
    && (!wonEstimateOf(lead) || String(wonEstimateOf(lead)) === String(estimateId));
  // An indirect root is eligible by POSITIVE open membership, as every
  // other resolved root in this module (r23 / r24): a spam or cancelled
  // root is not answerable, so it neither takes the win nor has its
  // funnel booked — the named repeat stands in (codex #3834 r26 P1). The
  // named row itself keeps the not-closed rule (an open named lead
  // converts as before; its own 'duplicate' label is closed here).
  const eligible = () => !lead.deleted_at && (indirect() ? OPEN_LEAD_STATUSES.includes(lead.status) && sameOpportunity() : !CLOSED_LEAD_STATUSES.has(lead.status));
  // A claim that lost because the original was relabelled IN FLIGHT — a
  // concurrent /calculate marked it a duplicate of an older root while
  // this acceptance was between its read and its stamp — is not a
  // closure: the refreshed row now carries a marker that reaches further,
  // so the hop follows it and claims the root it reaches, instead of
  // promoting the named repeat while that root stays open (codex #3834
  // r21 P1). Bounded like every marker walk; a dead or unchanged hop ends
  // it and the fallback below judges whatever `lead` is now.
  for (let hops = 0; eligible(); hops++) {
    if (await convert(lead, indirect() ? OPEN_LEAD_CLAIM : null)) return;
    // followDuplicateLink hands back the row itself unless it is a live
    // duplicate whose marker reaches further — exactly the relabel case.
    const next = hops < 2 ? await followDuplicateLink(database, lead) : lead;
    if (next.id === lead.id) break;
    lead = next;
  }
  // The hop could not land (original gone, another customer's, contact
  // mismatch, already FK-linked to a different estimate, or lost the
  // stamp race to a concurrent link). An accepted
  // estimate must still credit SOME lead (pre-push P1 on #3834): fall back
  // to the run's own named row — its 'duplicate' status was a dedupe label,
  // not a lost/won decision, and the acceptance is stronger evidence. It
  // converts with the accepted estimate stamped, so nothing on the
  // original is overwritten and the office still sees one open lead to
  // merge. A named row closed by any OTHER status stays closed, and an
  // original that is ALREADY won (the office closed the inquiry before
  // this acceptance) means the deal is credited once — a second won row
  // would double-count it in the raw lead KPIs (codex #3834 r6 P1) — but
  // only when that won original was validated as THIS opportunity: a won
  // root that failed the contact / customer / estimate checks is someone
  // else's closed deal (a shared household contact), and this customer's
  // accepted estimate still credits its own named row (codex #3834 r14
  // P1). Judged as the original IS NOW (the lost claim refreshed it): won
  // via a DIFFERENT estimate since the read is a different deal. When the
  // hop did not resolve, `lead` IS the named duplicate row, never won here.
  const creditedOnOriginal = lead.status === 'won' && sameOpportunity();
  // The duplicate row never got an ad_service_attribution row (/calculate
  // skips it for repeats), so the win's funnel row is markConverted's to
  // settle AFTER the conversion write (settleRepeatFunnelRow): the
  // original's row advances to booked only when the original, read at
  // that moment, is still this opportunity (funnel table only — its lead
  // row stays untouched, codex #3834 r8 P1; judged as it IS NOW, not at a
  // check made before the awaited conversion, r12 / r27 P1); otherwise
  // the named row gets the row its own run would have stamped, at booked
  // (r14 P2). One row either way.
  // ...and only an UNLINKED named row: a repeat staff linked to another
  // estimate since its run is that deal's lead (a link to THIS estimate
  // would have been the FK branch above), and converting it here would
  // write this acceptance's customer and value hints onto it (codex #3834
  // r29 P1). ...and only a row the SERVER filed as a repeat — one carrying
  // the duplicate marker: a 'duplicate' row staff closed by hand carries
  // none and is a deliberate closure, never reopened by its old estimate
  // (the customer-link resolver's r13 rule; pre-push P1 on 67dd818).
  // ...and only while the named row is still THIS customer's — linked to
  // them, or unlinked with a contact that matches the accepted estimate —
  // the rule the root is held to, so an old estimate never undoes a staff
  // reassignment (pre-push P1 on d3edd30).
  // An acceptance that carries no customer judges the contact, never a
  // linked row as automatically its own (codex #3883 r1 P1).
  const namedOurs = () => fallbackRowOurs(named, estimate, customerId);
  if (named.status === 'duplicate' && duplicateMarkerOf(named) && !named.deleted_at && !named.estimate_id && !creditedOnOriginal && namedOurs()) await convert(named, DUPLICATE_LEAD_CLAIM, fallbackConvertExtra(estimateId, customerId));
}

// Status sets the accept path's conditional stamps claim against (see
// `convert` below): the original must still be open; the fallback row must
// still carry the dedupe label.
const OPEN_LEAD_CLAIM = OPEN_LEAD_STATUSES;
const DUPLICATE_LEAD_CLAIM = ['duplicate'];
// Whether a wizard-fallback row (the named repeat; a stamped-but-never-
// converted repeat resumed on retry) is still this acceptance's: linked to
// its customer when both sides carry one, else — the row unlinked, or the
// acceptance without a customer — a contact that matches the accepted
// estimate. A linked row is never automatically its own on an acceptance
// that carries no customer (codex #3883 r1 P1).
const fallbackRowOurs = (row, estimate, customerId) => (row.customer_id && customerId
  ? String(row.customer_id) === String(customerId)
  : !!estimate && leadMatchesEstimateContact(row, estimate));
// The fallback conversion's overrides (see `convert`): it wins only as the
// sole live row of the estimate, and an acceptance without a customer
// leaves the row's own customer link untouched.
const fallbackConvertExtra = (estimateId, customerId) => ({ onlyIfSoleLinkedRow: estimateId, ...(customerId ? {} : { customerId: undefined }) });

async function markLinkedLeadEstimateAccepted({
  estimateId,
  customerId,
  monthlyValue,
  initialServiceValue,
  waveguardTier,
  leadAttributionService = leadAttribution,
  database = db,
}) {
  if (!estimateId) return;

  // Stamp the accepted estimate onto a rescued (previously unlinked) lead so
  // accepted-estimate reporting that joins on `leads.estimate_id`
  // (seo/conversion-feedback-miner) counts it, then convert it.
  // `claim` (the indirect duplicate→original hop and the named-row fallback)
  // closes the read→stamp window the same way linkRescuedLead does: stamp
  // only while the lead is still unlinked AND still in the state the caller
  // read (open for the original, 'duplicate' for the fallback row — a staff
  // lost/disqualified/won decision in between must not be overwritten,
  // pre-push P1 on #3834 r8); on 0 rows re-read and proceed only if the link
  // that won the race is THIS estimate. Returns false when another estimate
  // or a closure took the lead so the caller can decide what to credit. The
  // status write itself carries the same claim (markConverted's
  // onlyIfStatusIn), so a staff closure landing between the stamp and the
  // conversion is never overwritten (codex #3834 r11 P1). The direct path
  // keeps its unconditional stamp and conversion as before.
  // `extra` overrides the conversion's arguments for the fallback rows:
  // the sole-linked-row claim, and — when this acceptance carries no
  // customer (a manual acceptance of an estimate without one) — no
  // customer_id at all, so the row's existing link is preserved rather
  // than written NULL (codex #3883 r1 P1).
  const convert = async (lead, claim, extra = {}) => {
    let stamped = 0;
    if (!lead.estimate_id) {
      const stamp = database('leads').where({ id: lead.id });
      // ...and, for a claimed row, the identity it was read with (customer
      // link, phone, email): an original staff re-assigned or re-contacted
      // after the identity check but before the stamp is no longer this
      // opportunity, and the stamp must lose rather than let markConverted
      // overwrite the row's customer with this one (codex #3834 r17 P1).
      if (claim) stamp.whereNull('estimate_id').whereIn('status', claim).where(identityOf(lead));
      stamped = await stamp.update({ estimate_id: estimateId, updated_at: new Date() });
      // The row now carries this link, and the conversion's identity claim
      // below pins it (codex r22 P1).
      if (stamped) lead.estimate_id = estimateId;
      if (claim && !stamped) {
        // Refresh the caller's row from the re-read — the WHOLE row — so the
        // fallback judges the original AS IT IS NOW: its status (an original
        // the office closed as won between the read and the stamp must not
        // let the duplicate row record a second win — pre-push P1 on #3834
        // r8) and its identity (an original staff re-assigned or re-contacted
        // in the same window is no longer this opportunity — codex r16 P1).
        // A vanished row leaves the read as it was: unlinked, so it loses.
        // The link that won must be THIS estimate's on the identity the row
        // was read with: an admin edit that re-identified the row AND linked
        // it to this estimate in one write is another opportunity, and the
        // claim below would otherwise be built from that new identity and
        // hand the row to this customer (codex #3834 r25 P1).
        const read = identityOf(lead);
        Object.assign(lead, await database('leads').where({ id: lead.id }).first());
        if (!sameContactIdentity(read, lead) || String(lead.estimate_id) !== String(estimateId) || CLOSED_LEAD_STATUSES.has(lead.status)) return false;
      }
    }
    const converted = await leadAttributionService.markConverted(lead.id, {
      customerId,
      monthlyValue,
      initialServiceValue,
      waveguardTier,
      // The accepted estimate scopes the funnel settlement (see
      // settleRepeatFunnelRow): a root linked to another estimate is never
      // booked for this deal.
      estimateId,
      // The status write carries the same claim — status AND identity — so
      // nothing between the stamp and the conversion can hand the row to a
      // different customer (codex #3834 r11 P1, r18 P1).
      ...(claim ? { onlyIfStatusIn: claim, onlyIfIdentity: identityOf(lead) } : {}),
      ...extra,
    });
    if (claim && !converted) {
      // The stamp landed but the status claim lost (a closure in between):
      // a closed original must not stay linked to the accepted repeat
      // estimate, so the stamp THIS call made is reverted (pre-push P1) —
      // keyed on what the stamp wrote, never on updated_at: the competing
      // status write that made the claim lose is exactly the write that
      // bumps updated_at, so a timestamp key misses the very race it is
      // meant to repair (codex #3834 r21 P1). A link another writer made
      // since carries THAT estimate's id and is never erased. The one won
      // row that keeps the link is a concurrent acceptance of this same
      // estimate: won, linked to this customer, on the contact the row was
      // read with (pre-push P1 on r20) — a row an admin edit re-identified
      // AND won in the same write is someone else's deal, and the link comes
      // off so the fallback's win is the only one on this estimate (codex
      // r22 P1).
      if (stamped) {
        const identity = identityOf(lead);
        // ...judged on the customer THIS conversion wrote — the override
        // when the fallback carried one (an acceptance without a customer
        // preserves the row's own link), else the acceptance's — so a
        // concurrent no-customer retry that won with the row's customer
        // preserved keeps its link (codex #3883 r2 P1).
        const wrote = 'customerId' in extra ? extra.customerId : customerId;
        const wonByThisAcceptance = { ...identity, status: 'won', customer_id: wrote === undefined ? identity.customer_id : (wrote || null) };
        await database('leads').where({ id: lead.id }).where({ estimate_id: estimateId })
          .whereNot((q) => q.where(wonByThisAcceptance))
          .update({ estimate_id: null, updated_at: new Date() });
      }
      Object.assign(lead, await database('leads').where({ id: lead.id }).first());
      return false;
    }
    return true;
  };

  // 1. Directly FK-linked leads. If ANY linkage row exists — even one already
  //    closed (lost/duplicate) — the originating lead for this estimate is
  //    known, so convert the open ones and STOP. We must NOT fall through to
  //    fuzzy matching here: a previously-linked-then-lost lead means the deal's
  //    lead is accounted for, and contact matching could win an unrelated one.
  const linked = await database('leads').where({ estimate_id: estimateId });
  if (linked.length) {
    for (const lead of linked) {
      // Soft-deleted leads convert like closed ones don't — but their linkage
      // row still counts as "the lead is accounted for" (no fuzzy fallback).
      if (!CLOSED_LEAD_STATUSES.has(lead.status) && !lead.deleted_at) await convert(lead);
    }
    // A server-filed repeat the wizard fallback stamped with THIS estimate
    // but never converted — the process died between its stamp and its
    // status write — is that fallback mid-flight, not a closure: 'duplicate'
    // is closed above, so the retry would otherwise credit no lead for the
    // accepted estimate (codex #3834 r35 P1 / pre-push r33). Resumed under
    // the fallback's own rules — the marker (a hand-closed duplicate carries
    // none), still this customer's, and no other live row of this estimate
    // open or already won (that row is the deal's lead) — through the same
    // claimed conversion, which pins 'duplicate' and the identity read here.
    // The no-other-row rule is judged here on the rows read, and AGAIN in
    // the conversion's own statement (onlyIfSoleLinkedRow): a retry racing
    // another retry, or a link of the original to this estimate, converts
    // 0 rows instead of leaving two won rows on one estimate (codex #3883
    // r1 P1).
    const resumable = linked.filter((lead) => lead.status === 'duplicate' && duplicateMarkerOf(lead) && !lead.deleted_at);
    const otherRowStands = (lead) => linked.some((other) => other.id !== lead.id && !other.deleted_at && (other.status === 'won' || !CLOSED_LEAD_STATUSES.has(other.status)));
    if (resumable.length === 1 && !otherRowStands(resumable[0])) {
      const [lead] = resumable;
      const estimate = await database('estimates').where({ id: estimateId }).first();
      if (fallbackRowOurs(lead, estimate, customerId)) await convert(lead, DUPLICATE_LEAD_CLAIM, fallbackConvertExtra(estimateId, customerId));
    }
    return;
  }

  // No `leads.estimate_id` row exists at all — rescue the originating lead that
  // was never linked via the FK.
  const estimate = await database('estimates').where({ id: estimateId }).first();
  if (!estimate) return;

  // 2. Quote-wizard origination: public-quote stamps `leads.customer_id` and
  //    mirrors the lead id in `estimate_data.lead_id` (NOT `leads.estimate_id`).
  //    The contact fallback's `customer_id IS NULL` guard would miss it, so
  //    convert that exact lead by id — precise, no sweeping.
  const dataLeadId = parseEstimateData(estimate.estimate_data)?.lead_id;
  if (dataLeadId) {
    await acceptWizardNamedLead(database, { dataLeadId, estimate, estimateId, customerId, convert });
    return;
  }

  // 3. Standalone estimate (no lead linkage anywhere): match the accepted
  //    customer's contact to an open, never-converted lead. Acceptance of one
  //    estimate identifies at most ONE originating lead, so convert only when
  //    the match is unambiguous — skip (don't over-count wins) when 0 or 2+.
  if (!customerId) return;
  const customer = await database('customers').where({ id: customerId }).first();
  if (!customer) return;
  const matches = (await findUnconvertedLeadsByContact(database, customer.phone, customer.email))
    .filter((lead) => !CLOSED_LEAD_STATUSES.has(lead.status));
  if (matches.length === 1) {
    await convert(matches[0]);
  } else if (matches.length > 1) {
    logger.warn(`[lead-trigger] estimate ${estimateId} acceptance: ambiguous contact match (${matches.length} open leads) — skipping fallback`, {
      estimateId,
      customerId,
      leadIds: matches.map((lead) => lead.id),
    });
  }
}

// ---------------------------------------------------------------------------
// Shared lead resolver used by the one-off backfill (server/scripts/
// backfill-lead-acceptance-triggers.js). Resolves the originating lead by the
// strongest signal available — estimate link, then the customer's normalized
// phone/email among never-converted leads — and converts it. NEVER throws: a
// miss returns a reason instead of breaking the caller.
// ---------------------------------------------------------------------------

function estimateValueHints(estimate) {
  if (!estimate) return {};
  const money = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    monthlyValue: money(estimate.monthly_total),
    initialServiceValue: money(estimate.onetime_total),
    waveguardTier: estimate.waveguard_tier || null,
  };
}

// Contact fallback — only OPEN, NOT-yet-converted leads (customer_id IS NULL),
// matched on complete phone digits (NANP also accepts the domestic form) or a case-insensitive email. The
// `customer_id IS NULL` guard is deliberate: an existing customer can hold
// separate open leads already attached to them (e.g. public quote links stamp
// `leads.customer_id`), and we must never sweep those unrelated add-on leads.
// We only rescue the originating lead that was never linked to anyone.
async function findUnconvertedLeadsByContact(database, phone, email) {
  const phones = phoneMatchDigits(phone);
  const ne = normalizeEmail(email);
  if (!phones.length && !ne) return [];
  return database('leads')
    .whereNotIn('status', [...CLOSED_LEAD_STATUSES])
    .whereNull('customer_id')
    .whereNull('deleted_at')
    .andWhere((builder) => {
      if (phones.length) builder.orWhereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ANY (?::text[])", [phones]);
      if (ne) builder.orWhereRaw("LOWER(COALESCE(email, '')) = ?", [ne]);
    });
}

// Counterpart to findUnconvertedLeadsByContact for the customer-linked rescue
// tier: OPEN leads matching the contact that ALREADY carry a `customer_id` (the
// exact rows the `customer_id IS NULL` version excludes). Same complete-phone /
// case-insensitive-email match. Callers must still enforce the originating guards
// (single match + no prior won lead + isOriginatingLead) before advancing — this
// only widens the candidate set.
async function findCustomerLinkedLeadsByContact(database, phone, email) {
  const phones = phoneMatchDigits(phone);
  const ne = normalizeEmail(email);
  if (!phones.length && !ne) return [];
  return database('leads')
    .whereNotIn('status', [...CLOSED_LEAD_STATUSES])
    .whereNotNull('customer_id')
    .whereNull('deleted_at')
    .andWhere((builder) => {
      if (phones.length) builder.orWhereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ANY (?::text[])", [phones]);
      if (ne) builder.orWhereRaw("LOWER(COALESCE(email, '')) = ?", [ne]);
    });
}

// Backfill `estimates.customer_id` so a lead's quote becomes a customer estimate
// the moment the lead gets a customer (converted / booked / accepted). Until
// then a lead estimate carries `customer_id = NULL` and is invisible to the
// customer-keyed New Appointment "Estimate source" (which queries
// `estimates.customer_id`) — and EstimateConverter refuses to convert it
// ("has no linked customer"). Two PRECISE signals only, never a contact sweep
// (a shared phone/email must not re-home an unrelated quote): the lead's
// FK-linked estimate (`leads.estimate_id`), then estimates explicitly tagged
// with this lead's id in `estimate_data.lead_id` (the public-quote mirror).
// Always guarded to `customer_id IS NULL` so an estimate tied to another
// customer is never re-homed. Best-effort: a failure here never breaks the
// conversion. Returns the number of estimates attached.
async function linkLeadEstimatesToCustomer({ database = db, lead, customerId } = {}) {
  if (!customerId || !lead) return 0;
  try {
    // Primary: the lead's FK-linked estimate — deterministic, zero ambiguity.
    if (lead.estimate_id) {
      return await database('estimates')
        .where({ id: lead.estimate_id })
        .whereNull('customer_id')
        .update({ customer_id: customerId, updated_at: new Date() });
    }
    // Fallback: estimates explicitly mirroring THIS lead's id in estimate_data
    // (public-quote leads stamp `estimate_data.lead_id`, not `leads.estimate_id`).
    // estimate_data is stored as JSON text, so prefilter with a LIKE on the
    // lead-id substring (a UUID — no LIKE metacharacters) and confirm the exact
    // value in JS. No phone/email matching — precise lead-id only.
    const tagged = await database('estimates')
      .whereNull('customer_id')
      .whereRaw('estimate_data::text LIKE ?', [`%${lead.id}%`])
      .select('id', 'estimate_data');
    const ids = tagged
      .filter((e) => parseEstimateData(e.estimate_data)?.lead_id === lead.id)
      .map((e) => e.id);
    if (!ids.length) return 0;
    return await database('estimates')
      .whereIn('id', ids)
      .whereNull('customer_id')
      .update({ customer_id: customerId, updated_at: new Date() });
  } catch (err) {
    logger.warn(`[lead-estimate-link] backfill estimate.customer_id failed for lead ${lead?.id} → customer ${customerId}: ${err.message}`);
    return 0;
  }
}

// Customer-link match — an OPEN lead already attached to the EXACT customer the
// event is about. Tighter than the contact fallback above: the lead is
// explicitly tied to this customer (e.g. its `customer_id` was stamped when the
// customer record was created), not merely sharing a phone/email. The contact
// fallback can't see these (its `customer_id IS NULL` guard), which is why an
// originating lead that already carries a `customer_id` while still open never
// auto-converts. convertLeadFromEvent gates this (single open lead + the
// customer's FIRST close) so it can't sweep an established customer's add-on.
// Open by positive membership (OPEN_LEAD_STATUSES), never NOT-closed: a
// spam or cancelled row is not answerable, and read as "open" here it would
// silence its own repeats and then lose the open-status claim (codex #3834
// r24 P1).
async function findOpenLeadsForCustomer(database, customerId) {
  if (!customerId) return [];
  return database('leads')
    .where({ customer_id: customerId })
    .whereNull('deleted_at')
    .whereIn('status', OPEN_LEAD_STATUSES);
}

// First-close guard: if this customer already has a WON lead, a separate open
// lead is an add-on inquiry — not the originating deal — so it must not
// auto-convert on a routine invoice/visit. A genuinely-won add-on still
// converts through the authoritative estimate-link path when its estimate is
// accepted.
// For an estimate-scoped event, a lead won through a DIFFERENT estimate is a
// different deal (the rule every other scope check here applies) and does
// not make the customer established for this one (codex #3834 r24 P1).
async function customerHasWonLead(database, customerId, { estimateId = null } = {}) {
  if (!customerId) return false;
  const won = await database('leads')
    .where({ customer_id: customerId, status: 'won' })
    .whereNull('deleted_at')
    .modify((qb) => { if (estimateId) qb.where((q) => q.whereNull('estimate_id').orWhere('estimate_id', estimateId)); })
    .first('id');
  return !!won;
}

// Originating-lead test — the real first-close signal. A `status='won'` lead is
// NOT a reliable "established customer" marker: customers can be active (booked,
// invoiced, completed services) with no won lead at all, and add-on inquiry
// leads are stamped with `customer_id`. So gate on TIMING instead: the open lead
// is the originating deal only if it was first contacted on/before the customer
// became a customer; a lead created AFTER that is a later add-on. `member_since`
// (else the customer's created date) is the same "became a customer" date the
// KPI conversion windows use (server/services/customer-stages.js). Fail-closed:
// if either date is unknown, treat the lead as NOT originating (don't convert).
// `inquiryBeganAt` is the in-memory annotation a repeat keeper carries (see
// resolveCustomerLinkCandidates) — the ancestry's first contact, kept apart
// from the row's own first_contact_at so nothing downstream writes a
// synthetic date (codex #3834 r21 P2).
async function isOriginatingLead(database, customerId, lead) {
  const leadStart = lead.inquiryBeganAt || lead.first_contact_at || lead.created_at;
  if (!leadStart) return false;
  const customer = await database('customers')
    .where({ id: customerId })
    .first('member_since', 'created_at');
  if (!customer) return false;
  // Compare ET calendar days — the same conversion date customer-stages.js uses.
  // first_contact_at/created_at are timestamps → convert via the ET helper (a UTC
  // day would mis-bucket an evening-ET contact as the next day and wrongly skip).
  // member_since is a DATE column (already an ET calendar day) → read as-is.
  const leadDay = etDateString(new Date(leadStart));
  const becameDay = customer.member_since != null
    ? dateOnly(customer.member_since)
    : (customer.created_at != null ? etDateString(new Date(customer.created_at)) : null);
  if (!becameDay) return false;
  return leadDay <= becameDay;
}

// The day a repeat's inquiry began: the earliest first contact along its
// recorded ancestry — the original's, not the repeat's own filing day. A
// repeat is a later run of the SAME inquiry, and the customer row was
// created by the original's run, so testing the repeat's own date against
// member_since would fail every repeat filed a day later (codex #3834 r15
// P1). Walked hop by hop like followDuplicateLink but through every recorded
// row this customer owns — closed or deleted, the question is when the
// inquiry began, not whether its rows are live — and never past a row that
// is not ours (a shared-household root's date is not borrowed, so a later
// repeat of another customer's lead is still a later add-on). Bounded and
// cycle-safe; a dead marker ends the walk.
const earlierOf = (a, b) => (!a ? b : !b ? a : (new Date(b) < new Date(a) ? b : a));
async function ancestryFirstContactAt(database, repeat, ownedByUs) {
  let earliest = repeat.first_contact_at || repeat.created_at || null;
  const seen = new Set([repeat.id]);
  let current = repeat;
  while (seen.size < 8) {
    const parentId = duplicateMarkerOf(current);
    if (!parentId || seen.has(parentId)) break;
    const parent = await database('leads').where({ id: parentId }).first();
    if (!parent || !ownedByUs(parent)) break;
    seen.add(parent.id);
    earliest = earlierOf(earliest, parent.first_contact_at || parent.created_at);
    current = parent;
  }
  return earliest;
}

// Tier 2 of convertLeadFromEvent — the customer-link resolution. Catches an
// originating lead that already carries a `customer_id` (so the contact
// fallback can't see it) and folds the customer's auto-filed wizard repeats
// into that set (codex #3834 r11 P1): a repeat resolves to its open root
// when that root is this customer's — or unlinked and still matching the
// verified contact, since staff may have corrected it since the repeat was
// filed (r13 P1) — and stands in for the root itself when the root is not
// ours to convert (another customer's via a shared household contact,
// closed, deleted, vanished). Repeats are resolved ALONGSIDE the open rows
// (pre-push P1 on r12) so the single-candidate rule judges the combined
// set: two repeats of one root are one opportunity, an unrelated open lead
// plus a repeat are two; repeats of one VANISHED original group by their
// recorded marker (r13 P1). A row staff closed as 'duplicate' by hand
// carries no server marker and is a deliberate closure, never a candidate
// (r13 P1). Converts ONLY the customer's first close: exactly one candidate,
// no prior won lead, and that candidate is the originating deal — first
// contacted on/before they became a customer, where a repeat's inquiry
// began with its ancestry (r15 P1). Anything else is an add-on for an
// established customer — skip rather than guess which deal the event
// closed. Returns { candidates } (possibly empty) or { reason }.
// A lead is this customer's when it carries their link, or is unlinked and
// still matches the verified contact; for an estimate-scoped event a lead
// tied to a DIFFERENT estimate belongs to that deal (codex #3834 r22 P1).
const leadOwnedBy = (row, { customerId, phone, email }) => (row.customer_id
  ? String(row.customer_id) === String(customerId)
  : leadMatchesEstimateContact(row, { customer_phone: phone, customer_email: email }));
const inEstimateScope = (row, estimateId) => !estimateId || !row.estimate_id || row.estimate_id === estimateId;

// A customer-link claim that lost because a concurrent /calculate relabelled
// the open root as a repeat of an OLDER open lead is not a staff closure: the
// refreshed row carries a marker that reaches further, so the hop follows it
// — as acceptWizardNamedLead does on the accept path (r21 P1) — and returns
// the root it reaches when that root is ours to convert (open by positive
// membership, this customer's, in the event's estimate scope); null means the
// loss was a genuine transition and the event converts nothing (codex #3834
// r34 P1). One hop, on the identity the row was read with.
async function relabelledRootOf(database, lead, scope) {
  const now = await database('leads').where({ id: lead.id }).first();
  if (!now || now.status !== 'duplicate' || !sameContactIdentity(identityOf(lead), now)) return null;
  const marker = duplicateMarkerOf(now);
  if (!marker || marker === duplicateMarkerOf(lead)) return null;
  const root = await followDuplicateLink(database, now);
  const ours = root.id !== now.id && !root.deleted_at && OPEN_LEAD_STATUSES.includes(root.status)
    && leadOwnedBy(root, scope) && inEstimateScope(root, scope.estimateId);
  return ours ? root : null;
}

// One tier-2 conversion: the claimed write on the row as read, and — when
// the claim lost to a relabel rather than a closure — the same write on the
// root the new marker reaches. Returns the id that converted, or null.
async function convertCustomerLinkRow(database, leadAttributionService, lead, conversion, scope) {
  const claim = lead.status === 'duplicate' ? DUPLICATE_LEAD_CLAIM : OPEN_LEAD_CLAIM;
  if (await leadAttributionService.markConverted(lead.id, { ...conversion, onlyIfStatusIn: claim, onlyIfIdentity: identityOf(lead) })) return lead.id;
  const root = await relabelledRootOf(database, lead, scope);
  if (!root) return null;
  const converted = await leadAttributionService.markConverted(root.id, { ...conversion, onlyIfStatusIn: OPEN_LEAD_CLAIM, onlyIfIdentity: identityOf(root) });
  return converted ? root.id : null;
}

async function resolveCustomerLinkCandidates(database, { source, customerId, phone, email, estimateId }) {
  const ownedByUs = (row) => leadOwnedBy(row, { customerId, phone, email });
  const linked = await findOpenLeadsForCustomer(database, customerId);
  const skip = (reason, why, leadIds) => {
    logger.warn(`[lead-trigger] ${source} customer-link skip — ${why}`, { source, customerId, leadIds });
    return { reason };
  };
  // Newest by LATEST wizard submission (a rerun on a repeat's own token
  // bumps updated_at), not by insertion: the sibling the customer just
  // re-ran and booked from is the one the win and its stored touch belong
  // to (codex #3834 r31 P2).
  const repeats = await database('leads')
    .where({ customer_id: customerId, lead_type: 'quote_wizard', status: 'duplicate' })
    .whereNull('deleted_at')
    .orderByRaw('COALESCE(updated_at, created_at) DESC');
  // One keeper per ancestry: the open root when it is ours, else the newest
  // repeat (the query is newest-first) standing in for it. A repeat keeper
  // carries the ancestry's first contact for the origination test below —
  // and every OLDER sibling of the same ancestry folds its own inquiry date
  // in, since the sibling that created the customer row is the one that
  // says when this customer's inquiry began (codex #3834 r16 P1). It rides
  // on `inquiryBeganAt`, NOT the row's first_contact_at: the keeper is the
  // row the conversion stamps a funnel row for, and that row must date from
  // the repeat's real first contact, not a sibling's (codex r21 P2).
  // For an estimate-scoped event (deposit_paid), a lead tied to a DIFFERENT
  // estimate belongs to that deal — it is never converted, never carries
  // this estimate's value hints, and never stands as the root that silences
  // its repeats: the repeat stands in for it exactly as the accept path's
  // named-row fallback does (codex #3834 r22 P1). (Tier 1 already handled a
  // lead linked to THIS estimate.)
  const inScope = (row) => inEstimateScope(row, estimateId);
  const keepers = new Map(); // ancestry key → keeper
  let wonAncestry = false;
  for (const repeat of repeats) {
    if (!duplicateMarkerOf(repeat)) continue;
    const { root, key: ancestryKey } = await resolveAncestry(database, repeat);
    if (linked.some((l) => l.id === ancestryKey && inScope(l))) continue;
    // A root already WON as this customer's opportunity (linked to them, or
    // unlinked with a still-matching contact — the accept path's rule) is
    // the deal closed: its repeats are add-ons, never a stand-in, and the
    // customer is established even when that win carries no customer link
    // (customerHasWonLead cannot see it) — codex #3834 r17 P1. A root won
    // through a DIFFERENT estimate than this event's is a different deal, as
    // the accept path judges it, and the repeat stands in as before.
    // Open by positive membership (OPEN_LEAD_STATUSES), never NOT-closed: a
    // spam or cancelled root is not answerable and the open-status claim
    // would reject it, so the repeat stands in — as it does for a lost root
    // (codex #3834 r23 P1).
    if (root && ownedByUs(root) && inScope(root)) {
      if (root.status === 'won') {
        wonAncestry = true;
        continue;
      }
      if (OPEN_LEAD_STATUSES.includes(root.status)) {
        if (!keepers.has(ancestryKey)) keepers.set(ancestryKey, root);
        continue;
      }
    }
    const began = await ancestryFirstContactAt(database, repeat, ownedByUs);
    const keeper = keepers.get(ancestryKey);
    // The newest repeat stands in — unless it is tied to a different estimate
    // than this event's while an older sibling is not: the out-of-scope
    // sibling belongs to that deal, and keeping it as the keeper would leave
    // the ancestry with no candidate once the scope filter runs, so the
    // accepted estimate records no won lead (codex #3834 r27 P1). The folded
    // inquiry date carries over either way.
    if (!keeper) keepers.set(ancestryKey, { ...repeat, inquiryBeganAt: began });
    else if (!inScope(keeper) && inScope(repeat)) keepers.set(ancestryKey, { ...repeat, inquiryBeganAt: earlierOf(keeper.inquiryBeganAt, began) });
    else keeper.inquiryBeganAt = earlierOf(keeper.inquiryBeganAt, began);
  }
  linked.push(...keepers.values());
  const scoped = linked.filter(inScope);
  // A won ancestry with nothing else open IS the established customer, not
  // a customer with no lead (the reason the caller logs).
  if (!scoped.length) return wonAncestry ? { reason: 'customer_link_established' } : { candidates: [] };
  const leadIds = scoped.map((l) => l.id);
  if (scoped.length > 1) return skip('ambiguous_customer_link', `${scoped.length} open leads (ambiguous)`, leadIds);
  if (wonAncestry || await customerHasWonLead(database, customerId, { estimateId })) return skip('customer_link_established', 'established customer', leadIds);
  if (!(await isOriginatingLead(database, customerId, scoped[0]))) return skip('customer_link_not_originating', 'not the originating lead', leadIds);
  return { candidates: scoped };
}

async function convertLeadFromEvent({
  source,
  estimateId = null,
  customerId = null,
  phone = null,
  email = null,
  requireAcceptedEstimate = false,
  enforceOriginating = false,
  database = db,
  leadAttributionService = leadAttribution,
}) {
  try {
    let resolvedCustomerId = customerId || null;
    let resolvedPhone = phone || null;
    let resolvedEmail = email || null;
    let valueHints = {};
    let haveEstimateHints = false;

    if (estimateId) {
      const estimate = await database('estimates').where({ id: estimateId }).first();
      // requireAcceptedEstimate (deposit-paid trigger): a succeeded deposit PI is
      // NOT proof the deal closed — the customer can pay then abandon the accept,
      // and the estimate later declines/expires and the deposit is refunded. Only
      // convert once the estimate is genuinely `accepted`; a missing estimate
      // can't confirm acceptance, so it also does not convert.
      if (requireAcceptedEstimate && estimate?.status !== 'accepted') {
        return { converted: false, reason: 'estimate_not_accepted' };
      }
      if (estimate) {
        resolvedCustomerId = resolvedCustomerId || estimate.customer_id || null;
        resolvedPhone = resolvedPhone || estimate.customer_phone || null;
        resolvedEmail = resolvedEmail || estimate.customer_email || null;
        valueHints = estimateValueHints(estimate);
        haveEstimateHints = true;
      }
    }

    // Resolve the originating lead, most-authoritative first:
    //  1. estimate link (`leads.estimate_id`) — authoritative, convert all.
    //  2. customer-link — an open lead tied to the EXACT customer of this event,
    //     gated to the customer's FIRST close + a single open lead.
    //  3. contact fallback — an open, never-linked lead matched by phone/email.
    let candidates = [];
    let resolution = null; // 'estimate' | 'customer_link' | 'contact'
    if (estimateId) {
      candidates = await database('leads').where({ estimate_id: estimateId });
      if (candidates.length) resolution = 'estimate';
    }
    if (!candidates.length) {
      if (!resolvedPhone && !resolvedEmail && resolvedCustomerId) {
        const customer = await database('customers').where({ id: resolvedCustomerId }).first();
        resolvedPhone = customer?.phone || null;
        resolvedEmail = customer?.email || null;
      }

      // Tier 2 — customer-link (resolveCustomerLinkCandidates): the
      // customer's open leads plus their auto-filed wizard repeats resolved
      // through duplicate ancestry, gated to the customer's FIRST close.
      if (resolvedCustomerId) {
        const tier2 = await resolveCustomerLinkCandidates(database, {
          source, customerId: resolvedCustomerId, phone: resolvedPhone, email: resolvedEmail, estimateId,
        });
        if (tier2.reason) return { converted: false, reason: tier2.reason };
        if (tier2.candidates.length) {
          candidates = tier2.candidates;
          resolution = 'customer_link';
        }
      }

      // Tier 3 — contact fallback (never-linked, customer_id IS NULL).
      if (!candidates.length && (resolvedPhone || resolvedEmail)) {
        candidates = await findUnconvertedLeadsByContact(database, resolvedPhone, resolvedEmail);
        // enforceOriginating (backfill safety): the live triggers fire the moment
        // the deal closes, so a contact-matched open lead is the originating deal.
        // A backfill runs LATER, by which point the customer may have a newer,
        // unrelated add-on inquiry sharing their phone/email — converting that
        // would misattribute a closed deal to the wrong lead. Gate the fuzzy match
        // to leads first contacted on/before the customer became a customer (the
        // same originating-timing test Tier 2 already applies).
        if (enforceOriginating && candidates.length && resolvedCustomerId) {
          const originating = [];
          for (const lead of candidates) {
            if (await isOriginatingLead(database, resolvedCustomerId, lead)) originating.push(lead);
          }
          candidates = originating;
        }
        if (candidates.length) resolution = 'contact';
      }
    }

    // deleted_at covers the tier-1 estimate-link candidates (queried without a
    // guard so an all-deleted linkage still counts as "accounted for" and
    // blocks the fuzzy tiers); tiers 2/3 come pre-filtered by their finders.
    const open = (candidates || []).filter((lead) => lead && !lead.deleted_at
      && (!CLOSED_LEAD_STATUSES.has(lead.status) || (resolution === 'customer_link' && lead.status === 'duplicate')));
    if (!open.length) return { converted: false, reason: 'no_open_lead' };
    // FK-linked leads are authoritatively tied to THIS estimate, so convert them
    // all; tier 2 already enforced a single first-close lead. Only the fuzzy
    // contact fallback needs the ambiguity guard — 2+ open leads on one
    // phone/email can be distinct deals, and an event proves only ONE closed.
    if (resolution === 'contact' && open.length > 1) {
      logger.warn(`[lead-trigger] ${source} ambiguous contact match (${open.length} open leads) — skipping`, {
        source,
        estimateId,
        customerId: resolvedCustomerId,
        leadIds: open.map((lead) => lead.id),
      });
      return { converted: false, reason: 'ambiguous_contact' };
    }

    const convertedIds = [];
    for (const lead of open) {
      const conversion = { triggerSource: source };
      // An estimate-scoped event (deposit_paid) scopes the funnel settlement
      // too: the resolver refused a root linked to another estimate as the
      // keeper, and the settlement must refuse it as the row to book.
      if (estimateId) conversion.estimateId = estimateId;
      if (resolvedCustomerId) conversion.customerId = resolvedCustomerId;
      else if (lead.customer_id) conversion.customerId = lead.customer_id;
      // Pass revenue fields only when an estimate supplied them — otherwise
      // markConverted preserves whatever the lead already has.
      if (haveEstimateHints) {
        conversion.monthlyValue = valueHints.monthlyValue;
        conversion.initialServiceValue = valueHints.initialServiceValue;
        conversion.waveguardTier = valueHints.waveguardTier;
      }
      // A tier-2 row converts on the label it was read with — a repeat on
      // 'duplicate', an open row (direct or an ancestry-resolved root) on the
      // open statuses: a staff transition in between wins, and this event
      // converts nothing (pre-push P1, codex #3834 r14 P1; one rule for the
      // tier instead of tracking which rows came through ancestry, r15 P2).
      // ...and on the identity it was read with — customer link, phone,
      // email — so a row staff re-assigned or re-contacted in between is
      // never handed to this customer (codex #3834 r18 P1). A repeat taking
      // the win has no funnel row of its own (its root carried the prospect);
      // markConverted settles where the win lands after the write — the
      // root's row when it is still ours, else the repeat's own at booked
      // (r14 P2, r27 P1) — inside the conversion, so the backfill's dry-run
      // stub covers it (r18 P1). A claim lost to a concurrent relabel of the
      // root follows the new marker one hop (convertCustomerLinkRow, r34 P1).
      if (resolution !== 'customer_link') {
        await leadAttributionService.markConverted(lead.id, conversion);
        convertedIds.push(lead.id);
        continue;
      }
      const scope = { customerId: resolvedCustomerId, phone: resolvedPhone, email: resolvedEmail, estimateId };
      const wonId = await convertCustomerLinkRow(database, leadAttributionService, lead, conversion, scope);
      if (!wonId) return { converted: false, reason: 'customer_link_claim_lost' };
      convertedIds.push(wonId);
    }
    return { converted: true, count: convertedIds.length, leadIds: convertedIds };
  } catch (err) {
    logger.error(`[lead-trigger] convertLeadFromEvent failed (${source || 'unknown'}): ${err.message}`);
    return { converted: false, reason: 'error' };
  }
}

// ---------------------------------------------------------------------------
// Self-booking click-id attribution
//
// A public /book self-booking creates a customer + appointment but NO lead, and
// the offline-conversion pipeline (data-manager qualified_lead candidates + Meta
// CAPI) reads ad click ids ONLY off the `leads` table. So a cold ad click that
// books straight from the funnel — exactly the "book from the feed" flow — would
// reach Google/Meta only via a hashed-PII match, never the deterministic click
// id, weakening ad optimization and per-channel CAC.
//
// attributeSelfBooking closes that loop: when a booking is genuinely ad-tracked
// AND the booker has no lead of any kind on file, it mints a single already-won
// lead carrying the click ids plus the customer's phone/email match keys. Minting
// (not just converting) is required because the cold case has no lead to convert;
// won-on-create keeps it out of the open pipeline / new-lead auto-response so it
// only surfaces in attribution + LTV:CAC reporting. An existing lead is left
// untouched: a web lead already captured its own click ids, and stamping this
// booking's click id onto a call/manual-origin lead would mis-channel it.
//
// NON-PAID bookings (no deterministic click id) mint NOTHING — the paid-click +
// new-customer minting policy is unchanged — but they now DO get an
// ad_service_attribution funnel row (is_paid=false, lead_source classified by
// the same determineLeadSource semantics the lead webhook uses), so organic /
// referral / GBP self-bookings stop being invisible to channel attribution.
// PAID clicks from PRE-EXISTING customers (repeat bookers) likewise get a
// row-only record (is_paid=true, lead_source = the click's platform) — still
// no minted lead. Both no-lead rows carry lead_id NULL and dedupe per BOOKING
// via the unique self_booked_appointment_id (migration 20260705000201) — the
// lead_id unique index can't dedupe NULLs. Owned sources (recovery /
// estimate-originated links) skip ALL of this via the up-front
// bookingSourceSkipReason gate — same journey, already attributed.
// Best-effort + idempotent — never throws into the (already-committed) booking.
// ---------------------------------------------------------------------------

// gclid is varchar(200); wbraid/gbraid/fbclid/fbc/fbp are varchar(255).
const LEAD_CLICK_ID_MAX = { gclid: 200, wbraid: 255, gbraid: 255, fbclid: 255, fbc: 255, fbp: 255 };
const LEAD_CLICK_ID_COLUMNS = Object.keys(LEAD_CLICK_ID_MAX);

// A self-booking is minted as a paid lead ONLY on a deterministic paid click id:
// Google gclid/wbraid/gbraid or Meta fbclid/_fbc — these are appended only on an
// ad click. _fbc counts (Meta's persisted click id fb.1.<ts>.<fbclid>, the match
// key when the URL fbclid has fallen off by booking time). A bare UTM is NOT
// enough — newsletters/organic/referral links carry UTMs too — and the ambient
// _fbp cookie (Meta sets it on every pixel visit, organic included) is NEVER a
// trigger; it is kept only as an auxiliary CAPI match key alongside a real click
// id. Mirrors the paid-click rule in the lead-webhook's determineLeadSource.
function attributionHasPaidClickId(attribution) {
  if (!attribution || typeof attribution !== 'object') return false;
  return !!(attribution.gclid || attribution.wbraid || attribution.gbraid
    || attribution.fbclid || attribution.fbc);
}

function clickIdColumnsFromAttribution(attribution) {
  const out = {};
  if (!attribution || typeof attribution !== 'object') return out;
  for (const col of LEAD_CLICK_ID_COLUMNS) {
    const v = attribution[col];
    if (typeof v === 'string' && v.trim()) out[col] = v.trim().slice(0, LEAD_CLICK_ID_MAX[col]);
  }
  return out;
}

// Hostname for the same normalized comparison lead-source-resolver uses; null
// on garbage so a bad URL can never satisfy a host check.
function attributionHost(url) {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

// True only when the payload contains a REAL client-side capture: any UTM
// value, a click id (paid or Meta cookie), a referrer, or a landing URL. The
// ambient _fbp cookie alone does NOT count — it carries zero classification
// signal. Callers that never capture (the legacy BookingPage posts no
// attribution at all; createSelfBooking is shared by non-HTTP callers like the
// voice agent) must not fabricate a 'website' funnel row out of an empty
// object — those rows would later be completed by the revenue sync and
// pollute channel ROI.
function attributionHasCapture(attribution) {
  if (!attribution || typeof attribution !== 'object') return false;
  const utm = (attribution.utm && typeof attribution.utm === 'object') ? attribution.utm : {};
  return !!(
    Object.values(utm).some(Boolean)
    || attribution.gclid || attribution.wbraid || attribution.gbraid
    || attribution.fbclid || attribution.fbc
    || attribution.referrer || attribution.landing_url
  );
}

// Owned re-engagement booking sources — a booking that arrives through OUR
// OWN outbound recovery link (booking-abandon-recovery's BOOKING_URL sends
// /book?source=booking_recovery) is the SAME funnel journey completing, not a
// new acquisition touch. Its landing_url is an owned portal address, so
// classifying it would file the booking under waves_website and inflate
// website ROI; the customer's original capture (booking_intents.attribution /
// an existing lead row) already carries the true channel. Only the
// acquisition-row mint is suppressed — the raw capture still persists on
// self_booked_appointments.attribution (and the booking's source column
// labels it booking_recovery).
const NON_ACQUISITION_BOOKING_SOURCES = new Set(['booking_recovery']);

// Owned estimate-originated booking sources — bookings that arrive through OUR
// OWN follow-up/accept links (PublicBookingPage's estimate sources plus the
// admin one-time resend link). Those journeys already carry their originating
// attribution row (the public quote wizard inserts one when the estimate is
// created; the estimate lanes convert their own lead), and PublicBookingPage
// still posts a portal landing_url for them — so letting them through the
// capture check would insert a SECOND, lead_id-NULL row classified as generic
// website and double-count the journey. Same suppression contract as recovery:
// only the acquisition row is skipped; the raw capture still persists on
// self_booked_appointments.attribution.
const ESTIMATE_ORIGINATED_BOOKING_SOURCES = new Set([
  'quote-wizard', 'quote-wizard-onetime', 'estimate-accept', 'admin-manual-booking-resend',
]);

// The single up-front owned-source gate. attributeSelfBooking checks it BEFORE
// dispatching to ANY acquisition writer (paid-click mint, paid repeat row,
// organic row) — a recovered visitor's browser can still carry the original
// ad's _fbc, and gating only the organic recorder (round 3) let that click id
// re-mint the same completing journey as a brand-new won paid lead. Skip
// reasons stay distinct per source class so telemetry can tell a recovery
// rebooking from an estimate-originated booking.
function bookingSourceSkipReason(bookingSource) {
  const src = String(bookingSource || '').trim().toLowerCase();
  if (NON_ACQUISITION_BOOKING_SOURCES.has(src)) return 'recovery_rebooking';
  if (ESTIMATE_ORIGINATED_BOOKING_SOURCES.has(src)) return 'estimate_originated';
  return null;
}

// Organic (non-paid) self-booking → funnel row only, no lead. Classified with
// the shared determineLeadSource. This branch is only reachable WITHOUT a
// deterministic paid click id; is_paid comes from the classifier's channel —
// exactly like the lead webhook — so a paid Meta/Google click whose click id
// was stripped but whose cpc UTMs survived is still counted paid
// (splitFacebookByPaid would otherwise misfile it as facebook_organic).
//
// Embedded-iframe correction (booking context ONLY — lead-webhook semantics
// are untouched): PublicBookingPage captures landing_url = the PORTAL's own
// /book iframe URL while the real spoke/hub page arrives as document.referrer,
// so classifying the landing would file every embedded booking under the
// portal's host. The portal's own surface is attribution-neutral: when the
// landing host IS the portal (utils/portal-url), classify the referrer instead
// — kept only when it carries a real signal (not the generic 'website'
// fallback), so a google.com/opaque referrer never downgrades the landing
// classification. UTM/click-id branches short-circuit inside
// determineLeadSource before any URL handling, so they are unaffected.
//
// Requires the booking id — without it there is no per-booking dedupe key, so
// it fails closed rather than risking duplicate funnel rows. Requires a real
// capture (attributionHasCapture) — a no-capture booking writes no row, in
// parity with its self_booked_appointments.attribution staying NULL.
// Owned-source (recovery / estimate-originated) bookings never reach here —
// attributeSelfBooking's up-front bookingSourceSkipReason gate short-circuits
// them before ANY acquisition writer runs.
async function recordOrganicSelfBookingAttribution({
  customerId,
  attribution,
  serviceInterest,
  selfBookedAppointmentId,
  database,
}) {
  if (!selfBookedAppointmentId) return { attributed: false, reason: 'no_booking_id' };
  if (!attributionHasCapture(attribution)) return { attributed: false, reason: 'no_attribution_capture' };

  const attr = attribution;
  const utm = (attr.utm && typeof attr.utm === 'object') ? attr.utm : {};
  const { determineLeadSource } = require('./lead-source-classify');
  const classify = (url) => determineLeadSource(
    '', url || '',
    utm.source || '', utm.medium || '', utm.campaign || '', utm.content || '',
    attr.fbclid || '', attr.fbc || '', attr.gclid || '', attr.wbraid || '', attr.gbraid || '',
  );

  let classified = classify(attr.landing_url || attr.referrer);
  const { publicPortalUrl } = require('../utils/portal-url');
  const portalHost = attributionHost(publicPortalUrl());
  const landingHost = attributionHost(attr.landing_url);
  const referrerHost = attributionHost(attr.referrer);
  if (portalHost && landingHost === portalHost && referrerHost && referrerHost !== portalHost) {
    const viaReferrer = classify(attr.referrer);
    if (viaReferrer.source !== 'website') classified = viaReferrer;
  }

  const { inferServiceLine, inferSpecificService, inferServiceBucket } = require('../utils/service-line-infer');
  // _fbp is kept as an auxiliary CAPI match key (the webhook stores it on
  // organic rows too); it is never a paid signal.
  const fbp = (typeof attr.fbp === 'string' && attr.fbp.trim())
    ? attr.fbp.trim().slice(0, LEAD_CLICK_ID_MAX.fbp) : null;
  await database('ad_service_attribution').insert({
    customer_id: customerId,
    self_booked_appointment_id: selfBookedAppointmentId,
    service_line: inferServiceLine(serviceInterest),
    specific_service: inferSpecificService(serviceInterest),
    service_bucket: inferServiceBucket(serviceInterest),
    lead_date: etDateString(),
    lead_source: classified.source,
    lead_source_detail: classified.detail || null,
    fbp,
    utm_campaign: utm.campaign || null,
    utm_term: utm.term || null,
    // The booking is already COMMITTED when this runs, so the row is born at
    // the stage that actually occurred — 'booked', not 'lead' (buildLeadFunnel
    // counts booked/completed only; a 'lead' row would underreport organic
    // self-book conversions until the revenue sync). 'completed' stays the
    // sync's to write ('booked' is in its ADVANCEABLE_STAGES).
    funnel_stage: 'booked',
    // Paid flag from the classifier's channel — mirrors lead-webhook.js. A
    // cpc-UTM booking with a stripped click id classifies channel='paid' and
    // must count paid; everything genuinely organic classifies otherwise.
    is_paid: classified.channel === 'paid',
  }).onConflict('self_booked_appointment_id').ignore();

  return { attributed: true, organic: true, leadSource: classified.source };
}

// Paid click, PRE-EXISTING customer → per-booking attribution row ONLY, never
// a lead. A repeat booker arriving on a deterministic click id (gclid/_fbc/…)
// is the strongest-evidence paid conversion there is; before round 4 the paid
// branch returned existing_customer before inserting ANY row, so those
// bookings vanished from per-booking channel reporting while the weaker
// cpc-UTM-without-click-id case (organic recorder, is_paid from the
// classifier) WAS counted. Minting stays reserved for a customer the booking
// just created — this row carries lead_id NULL and dedupes per booking on the
// same unique self_booked_appointment_id the organic recorder uses (so it
// fails closed without a booking id, exactly like that path). lead_source is
// the click id's platform — the deterministic paid click IS the channel, so
// is_paid is true by construction (no classifier needed).
async function recordPaidRepeatBookingAttribution({
  customerId,
  attribution,
  clickIds,
  serviceInterest,
  selfBookedAppointmentId,
  database,
}) {
  if (!selfBookedAppointmentId) return { attributed: false, reason: 'no_booking_id' };
  const ppcSource = (clickIds.gclid || clickIds.wbraid || clickIds.gbraid) ? 'google_ads'
    : (clickIds.fbclid || clickIds.fbc) ? 'facebook' : null;
  // Unreachable behind attributionHasPaidClickId, but never guess a channel.
  if (!ppcSource) return { attributed: false, reason: 'no_click_ids' };

  // Read-only source resolution — reused only for the human-readable detail
  // string ('Google Ads click (gclid)' / 'Meta click (fbclid)').
  const { leadSourceDetail } = await resolveLeadSource(attribution);
  const { inferServiceLine, inferSpecificService, inferServiceBucket } = require('../utils/service-line-infer');
  const utm = (attribution && typeof attribution.utm === 'object' && attribution.utm) || {};
  await database('ad_service_attribution').insert({
    customer_id: customerId,
    self_booked_appointment_id: selfBookedAppointmentId,
    service_line: inferServiceLine(serviceInterest),
    specific_service: inferSpecificService(serviceInterest),
    service_bucket: inferServiceBucket(serviceInterest),
    lead_date: etDateString(),
    lead_source: ppcSource,
    lead_source_detail: leadSourceDetail || null,
    gclid: clickIds.gclid || null,
    wbraid: clickIds.wbraid || null,
    gbraid: clickIds.gbraid || null,
    fbclid: clickIds.fbclid || null,
    fbc: clickIds.fbc || null,
    fbp: clickIds.fbp || null,
    utm_campaign: utm.campaign || null,
    utm_term: utm.term || null,
    // Born at 'booked' — the booking is already committed when this runs
    // (same contract as the organic and minted-lead rows).
    funnel_stage: 'booked',
    is_paid: true,
  }).onConflict('self_booked_appointment_id').ignore();

  return { attributed: true, repeatPaid: true, leadSource: ppcSource };
}

async function attributeSelfBooking({
  customerId,
  attribution,
  serviceInterest = null,
  customerCreated = false,
  selfBookedAppointmentId = null,
  bookingSource = null,
  leadConverted = false,
  database = db,
}) {
  try {
    if (!customerId) return { attributed: false, reason: 'no_customer_id' };
    // Converted-lead gate FIRST: when this booking just converted an existing
    // open lead (convertLeadFromEvent → markConverted → funnel bridge), that
    // lead's ad_service_attribution row was advanced to booked — it IS the
    // journey's funnel entry. Minting a lead_id-NULL organic or repeat-paid
    // row here would make one booking count as two booked funnel entries.
    // Same rule for both paths: the lead is the canonical journey record.
    if (leadConverted) return { attributed: false, reason: 'lead_converted' };
    // Owned-source gate next — before the paid-click AND organic paths. A
    // recovery/estimate-originated booking is our own link completing an
    // already-attributed journey; its browser can still carry the original
    // ad's click id (_fbc/gclid), so gating only the organic recorder would
    // let that click id fall through to the mint below.
    const sourceSkip = bookingSourceSkipReason(bookingSource);
    if (sourceSkip) return { attributed: false, reason: sourceSkip };
    if (!attributionHasPaidClickId(attribution)) {
      // No deterministic paid click → organic funnel row, never a minted lead.
      return await recordOrganicSelfBookingAttribution({
        customerId, attribution, serviceInterest, selfBookedAppointmentId, database,
      });
    }
    const clickIds = clickIdColumnsFromAttribution(attribution);
    if (!Object.keys(clickIds).length) return { attributed: false, reason: 'no_click_ids' };

    // Only mint for a genuinely NEW acquisition — a customer this booking just
    // created. A pre-existing customer (resolved by phone/estimate) is a repeat
    // booker, not a fresh paid lead; minting a won/qualified lead for them would
    // feed the offline-conversion pipeline a synthetic "new qualified lead" and
    // inflate paid-channel conversions. (Legacy/admin customers can have prior
    // activity but no lead row, so an existing-lead check alone is insufficient.)
    // Their paid click still counts: record the per-booking row, mint nothing.
    if (!customerCreated) {
      return await recordPaidRepeatBookingAttribution({
        customerId, attribution, clickIds, serviceInterest, selfBookedAppointmentId, database,
      });
    }

    const customer = await database('customers').where({ id: customerId }).first();
    if (!customer) return { attributed: false, reason: 'no_customer' };

    // Belt-and-suspenders: even a just-created customer could already match a
    // lead created earlier without a customer link. An existing lead owns its own
    // channel attribution — never overwrite or duplicate it.
    const linkedLead = await database('leads').where({ customer_id: customerId }).whereNull('deleted_at').first('id');
    if (linkedLead) return { attributed: false, reason: 'existing_customer_lead' };
    const contactMatches = await findUnconvertedLeadsByContact(database, customer.phone, customer.email);
    if (contactMatches.length) return { attributed: false, reason: 'existing_contact_lead' };

    const { leadSourceId, leadSourceDetail } = await resolveLeadSource(attribution);
    const now = new Date();
    const [minted] = await database('leads').insert({
      customer_id: customerId,
      first_name: customer.first_name || null,
      last_name: customer.last_name || '',
      phone: customer.phone || null,
      email: customer.email || null,
      lead_source_id: leadSourceId,
      lead_type: 'self_booking',
      first_contact_channel: 'web',
      service_interest: serviceInterest || null,
      first_contact_at: now,
      converted_at: now,
      status: 'won',
      is_qualified: true,
      ...clickIds,
    }).returning('*');

    await database('lead_activities').insert({
      lead_id: minted.id,
      activity_type: 'converted',
      description: 'Self-booked from a tracked ad click — minted as a won lead to attribute the booking to its ad channel.',
      performed_by: 'system',
      metadata: JSON.stringify({ source: 'self_booking', clickIds: Object.keys(clickIds), leadSourceId: leadSourceId || null }),
    }).catch((e) => logger.warn(`[self-booking-attribution] activity log failed (non-blocking): ${e.message}`));

    // Mirror the web-lead PPC funnel row (routes/lead-webhook.js) so the minted
    // lead is visible in /admin ads CAC/ROAS reporting and revenue sync, not just
    // the offline-conversion upload. Source is the paid platform of the click id
    // (a minted lead always carries one); idempotent on lead_id.
    const ppcSource = (clickIds.gclid || clickIds.wbraid || clickIds.gbraid) ? 'google_ads'
      : (clickIds.fbclid || clickIds.fbc) ? 'facebook' : null;
    if (ppcSource) {
      try {
        const { inferServiceLine, inferSpecificService, inferServiceBucket } = require('../utils/service-line-infer');
        const utm = (attribution && typeof attribution.utm === 'object' && attribution.utm) || {};
        await database('ad_service_attribution').insert({
          customer_id: customerId,
          lead_id: minted.id,
          // Booking lineage + the same per-booking dedupe key the organic rows
          // use (unique; NULL for pre-column rows and non-booking writers).
          self_booked_appointment_id: selfBookedAppointmentId || null,
          service_line: inferServiceLine(serviceInterest),
          specific_service: inferSpecificService(serviceInterest),
          service_bucket: inferServiceBucket(serviceInterest),
          lead_date: etDateString(),
          lead_source: ppcSource,
          lead_source_detail: leadSourceDetail || null,
          gclid: clickIds.gclid || null,
          wbraid: clickIds.wbraid || null,
          gbraid: clickIds.gbraid || null,
          fbclid: clickIds.fbclid || null,
          fbc: clickIds.fbc || null,
          fbp: clickIds.fbp || null,
          utm_campaign: utm.campaign || null,
          utm_term: utm.term || null,
          // Born at 'booked': the booking is committed and the minted lead is
          // CREATED at status 'won' (a direct insert, so no status transition
          // ever fires the lead-funnel-bridge for it). A 'lead' row here would
          // sit at the bottom rung forever and underreport paid self-book
          // conversions. 'completed' stays the revenue sync's to write.
          funnel_stage: 'booked',
        }).onConflict('lead_id').ignore();
      } catch (attrErr) {
        logger.warn(`[self-booking-attribution] PPC funnel row failed (non-blocking): ${attrErr.message}`);
      }
    }

    logger.info(`[self-booking-attribution] minted won lead ${minted.id} for customer=${customerId} (${Object.keys(clickIds).join(',')})`);
    return { attributed: true, leadId: minted.id, minted: true };
  } catch (err) {
    logger.warn(`[self-booking-attribution] failed for customer=${customerId || 'unknown'}: ${err.message}`);
    return { attributed: false, reason: 'error' };
  }
}

module.exports = {
  attachLeadToEstimate,
  assertLeadCanAttachEstimate,
  leadMatchesEstimateContact,
  // The same contact normalization the lead-match rule uses, for callers that
  // need to apply the identical match semantics against other tables
  // (estimate revise validates the linked CUSTOMER's contact with these).
  normalizeContactPhone: normalizePhone,
  normalizeContactEmail: normalizeEmail,
  markLinkedLeadEstimateSent,
  markLinkedLeadEstimateViewed,
  markLinkedLeadEstimateAccepted,
  followDuplicateLink,
  settleRepeatFunnelRow,
  stampFirstResponseByContact,
  resolveEstimateEventLeads,
  convertLeadFromEvent,
  findUnconvertedLeadsByContact,
  findCustomerLinkedLeadsByContact,
  linkLeadEstimatesToCustomer,
  attributeSelfBooking,
  // Exported for the one-off leads-pipeline-audit cleanup script, which must
  // apply the SAME originating / prior-won guards as the live conversion path.
  isOriginatingLead,
  customerHasWonLead,
};
