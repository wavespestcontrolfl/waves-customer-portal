/**
 * Ask-the-customer loop (GATE_ESTIMATE_CLARIFY_ASKS, default OFF).
 *
 * When automated quote drafting dead-ends on a MACHINE-READABLE missing
 * item (no service address, no concrete service), park ONE clarifying SMS
 * as a message_drafts row (status 'pending', intent 'estimate_clarify')
 * for the owner's one-click approval in the /admin/drafts queue. THIS
 * SERVICE NEVER SENDS ANYTHING — the draft row is the terminal artifact;
 * only the owner's approve/revise click in admin-drafts puts a message on
 * the wire, through the full sendCustomerMessage consent pipeline
 * (suppression, consent, compliance), with the clarify gate re-checked at
 * approval time.
 *
 * Copy is deterministic template text, not LLM — the asks are enumerable,
 * the owner can revise before sending, and boring copy can't hallucinate
 * claims. Dedupe is phone-scoped via source_ref ('clarify:<last10>'): one
 * OPEN clarify per phone, and no re-ask within RECENT_SENT_WINDOW_MS of a
 * sent one — a customer who didn't answer must not get nagged.
 *
 * Design note: the original scope named the dormant outbox_messages table,
 * but that table is a worker-drained AUTO-SEND outbox with no approval
 * concept — structurally opposed to "never auto-send". message_drafts +
 * /admin/drafts is the live owner-approval queue, so the loop rides it.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');

const RECENT_SENT_WINDOW_MS = 7 * 86400000;

// The only items an SMS can ask for. 'phone' is structurally unaskable
// here (no phone = no SMS), and free-text composer uncertainties are not a
// stable vocabulary — both stay operator-bell territory.
// 'bedroom_count' (GATE_UNIT_BAND_PRICING lane): a residential-unit quote
// with no unit sqft and no stated bedroom count — the one question that
// makes the band price real. The answer is not written to any row: the
// resumed SMS-thread composer reads it from the thread (intent
// unit_bedroom_count), so approval-time staleness treats it as still
// missing until the reply handler records it.
// 'unit_number' (call pipeline lane): the caller gave a building that
// validated as a real premise but no apartment/unit. The Triage Inbox card
// (missing_unit_number) stays human-verdict-only per AGENTS.md — this ask
// only collects the answer onto the lead/customer and stamps it on the
// card; it never resolves the card.
const ASKABLE_MISSING = new Set(['street_address', 'specific_service', 'bedroom_count', 'unit_number']);

function clarifyAsksEnabled() {
  return isEnabled('estimateClarifyAsks');
}
function unitWritebackEnabled() {
  return isEnabled('clarifyUnitWriteback');
}

function firstNameGreeting(firstName) {
  const name = String(firstName || '').trim().split(/\s+/)[0];
  return name && name.toLowerCase() !== 'unknown' ? `Hi ${name}, ` : 'Hi, ';
}

// Deterministic, neighborly, compliant: company name in full, one concrete
// question, no service claims. The owner can revise any of it before send.
const BEDROOM_ASK = 'how many bedrooms is the unit (studio, 1, 2, 3, or 4+)? That sets the price for your apartment or condo.';
// The building rides in from the missing_unit_number card's own payload
// (unit_ask_building), so the question names the address the caller gave.
function unitAsk(unitAskBuilding) {
  const street = String(unitAskBuilding?.street_line_1 || '').trim();
  return `what's the apartment or unit number${street ? ` at ${street}` : ''}?`;
}

function composeClarifyBody({ missing, firstName, unitAskBuilding = null }) {
  const greeting = firstNameGreeting(firstName);
  const wantsAddress = missing.includes('street_address');
  const wantsService = missing.includes('specific_service');
  const wantsBedrooms = missing.includes('bedroom_count');
  const wantsUnit = missing.includes('unit_number');
  if (wantsUnit && missing.length === 1) {
    return `${greeting}it's Waves Pest Control — one quick thing to finish your quote: ${unitAsk(unitAskBuilding)}`;
  }
  if (wantsUnit) {
    // Unit alongside another gap: the base ask plus one trailing question
    // (same shape as bedrooms below; a unit ask never rides with a
    // street-address ask — the building is what makes it a unit ask).
    const base = composeClarifyBody({ missing: missing.filter((m) => m !== 'unit_number'), firstName, unitAskBuilding });
    return `${base} Also, ${unitAsk(unitAskBuilding)}`;
  }
  if (wantsBedrooms && !wantsAddress && !wantsService) {
    return `${greeting}it's Waves Pest Control — one quick question to finish your quote: ${BEDROOM_ASK}`;
  }
  if (wantsBedrooms) {
    // Bedrooms alongside another gap: the base ask plus one trailing question.
    const base = composeClarifyBody({ missing: missing.filter((m) => m !== 'bedroom_count'), firstName, unitAskBuilding });
    return `${base} Also, ${BEDROOM_ASK}`;
  }
  if (wantsAddress && wantsService) {
    return `${greeting}it's Waves Pest Control — happy to get your quote started. Two quick things: what's the service address (street + city), and which service are you looking for (pest control, lawn care, mosquito, or something else)?`;
  }
  if (wantsAddress) {
    return `${greeting}it's Waves Pest Control — happy to put your quote together. What's the service address (street + city)?`;
  }
  return `${greeting}it's Waves Pest Control — glad to get you a quote. Which service are you looking for — pest control, lawn care, mosquito, or something else?`;
}

// Every flags mutation for one phone's clarify lifecycle serializes under
// an advisory transaction lock — merges, reply bookkeeping, and
// answer stamps all read-modify-write the same jsonb, and interleaving
// writers could drop each other's items. Same pattern as the estimator
// engine's per-call advisory lock.
function withClarifyLock(digits, callback) {
  return db.transaction(async (trx) => {
    await trx.raw(
      'select pg_advisory_xact_lock(hashtext(?), hashtext(?))',
      ['estimate_clarify', String(digits)],
    );
    return callback(trx);
  });
}

// Item-specific linkage for the unit ask: the call whose card it serves,
// the building it names, and the lead/customer the answer is written to
// (GATE_CLARIFY_UNIT_WRITEBACK; gate off = the card stamp only).
function unitAskFlags({ callLogId, unitAskBuilding, leadId, customerId }) {
  return {
    ...(callLogId ? { unit_call_log_id: String(callLogId) } : {}),
    ...(unitAskBuilding ? { unit_ask_building: unitAskBuilding } : {}),
    // Write-back targets bound to the unit item (a later merged ask for
    // another lead on the same phone cannot re-point them). ALWAYS emitted
    // — null when the producer has none — so a newer unit ask with a
    // deliberately-null customer (ambiguous shared phone) CLEARS a prior
    // ask's target instead of inheriting it (codex r1 P1 on #3785).
    unit_lead_id: leadId ? String(leadId) : null,
    unit_customer_id: customerId ? String(customerId) : null,
  };
}

// The asked building as ONE address line for the canonical matcher.
function buildingLine(unitAskBuilding) {
  const b = unitAskBuilding || {};
  return [b.street_line_1, b.city, b.postal_code ? `FL ${b.postal_code}` : null].filter(Boolean).join(', ');
}
// The stored line is compared on its STREET: a unit-first line ("Apt 9,
// 123 Main St, …") would otherwise read as another building — the shared
// leading-unit peel, not a parallel parser (codex r5 P1 on #3796).
function sameBuilding(addressLine, unitAskBuilding) {
  const raw = String(addressLine || '').trim();
  const asked = buildingLine(unitAskBuilding);
  if (!raw || !asked) return false;
  const { splitUnitFirstLine } = require('../utils/address-normalizer');
  const line = splitUnitFirstLine(raw)?.rest || raw;
  const { sameStreetAddress } = require('./estimator-engine/address-compare');
  return sameStreetAddress(line, asked);
}
// The matcher for a WRITE. sameStreetAddress is the duplicate guard: a
// stored line with no city/ZIP compares equal to the localized building
// on purpose (one missing locality is not proof of two properties). That
// conservative reading must not append the unit to a "123 Main St" record
// that belongs to another city (codex r5 P1 on #3785) — a mutation needs
// POSITIVE locality agreement whenever the asked building supplies one:
// the stored ZIP equals the building's, or (no stored ZIP) the stored
// line names the building's city.
function sameBuildingForWrite(addressLine, unitAskBuilding) {
  if (!sameBuilding(addressLine, unitAskBuilding)) return false;
  // Locality is parsed from the PEELED line too — on "Apt 204, 1048 Example
  // Lakes Cir, Sarasota" the unpeeled parse reads the street as the city
  // (codex r3 P2 on #3804).
  const { splitUnitFirstLine } = require('../utils/address-normalizer');
  const line = splitUnitFirstLine(String(addressLine || ''))?.rest || String(addressLine || '');
  const b = unitAskBuilding || {};
  const askedZip = String(b.postal_code || '').trim().slice(0, 5);
  const askedCity = String(b.city || '').trim();
  if (!askedZip && !askedCity) return true;
  const zipMatch = line.match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/);
  const storedZip = zipMatch && zipMatch.index > 0 ? zipMatch[1] : null;
  if (askedZip && storedZip) return storedZip === askedZip;
  if (askedCity) {
    // The stored line's LOCALITY segment only — "123 Venice Ave" with no
    // locality must not pass as Venice because the street names the city
    // (codex r1 P1 on #3788).
    const { parseRawAddress } = require('../utils/address-normalizer');
    const normCity = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((t) => t && t !== 'fl' && t !== 'florida' && !/^\d{5}(\d{4})?$/.test(t)).join(' ');
    const stored = normCity(parseRawAddress(line).city);
    return !!stored && stored === normCity(askedCity);
  }
  return false;
}
function customerAddressLine(row) {
  return [row?.address_line1, row?.city, row?.zip ? `FL ${row.zip}` : null].filter(Boolean).join(', ');
}

/**
 * GATE_CLARIFY_UNIT_WRITEBACK: put the customer's texted unit into the
 * record. Runs inside the reply handler's locked transaction, on the unit
 * item's OWN lead/customer (unit_* linkage) and ONLY at the asked building,
 * judged by the estimator's canonical street matcher (directional and
 * numbered-route aliases, locality) — never a parallel matcher.
 *  - lead: line 2 through the shared formatter when the lead's line is that
 *    building and carries no unit; a blank lead line is filled with the
 *    building + unit (the lead exists because the call was about it).
 *  - customer: line 2 (fill-only) + primary property sync when the
 *    customer's OWN address is that building; otherwise the building + unit
 *    is a SECOND property on the account (owner ruling 2026-09-03), through
 *    the same function the call pipeline uses — which also makes it the
 *    primary and mirrors it when the customer has no address yet.
 * Returns an audit object for the ask's flags.
 */
// Unit-item targets, with a tightly scoped fallback for asks parked by the
// pre-write-back build (#3775): those rows carry unit_call_log_id +
// unit_ask_building but no unit_lead_id / unit_customer_id — for a
// CALL-origin ask the generic lead_id and the row's customer_id ARE the
// call's own (the producer set both from the call), so they stand in.
// A legacy ask's targets come from THE UNIT'S OWN CALL ROW (its
// customer_id, and the lead that call minted — leads.twilio_call_sid), never
// from the generic linkage a later merged ask may have re-pointed (codex r2
// P1 on #3785).
// The unit call's CURRENT linkage — the source of truth for the reply's
// targets. `lock` takes the row FOR UPDATE (customers → call_log order).
async function unitCallLinkage(trx, callLogId, { lock = false } = {}) {
  let q = trx('call_log').where({ id: String(callLogId) });
  if (lock) q = q.forUpdate();
  const row = await q.first('customer_id', 'twilio_call_sid', 'metadata');
  if (!row) return null;
  const parse = (v) => { if (!v) return null; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } } return v; };
  const meta = parse(row.metadata);
  return {
    customerId: row.customer_id ? String(row.customer_id) : null,
    // The call's durable lead linkage is the metadata stamp — a call that
    // REUSED an existing lead leaves that lead's twilio_call_sid on its
    // original call (codex r3 P1; context-builder follows the stamp first).
    stampedLeadId: meta?.lead_id ? String(meta.lead_id) : null,
    twilioCallSid: row.twilio_call_sid || null,
    // PUT /calls/:id/customer stamps this on every operator relink/unlink.
    operatorOverride: !!(meta && meta.customer_link_override),
  };
}
// Whether the call still claims the cached lead. An operator UNLINK
// (PUT /calls/:id/customer with null) deliberately drops the call's lead
// stamp and clears the lead's twilio_call_sid arm — the lead is detached
// from this call, and a later reply must not write the unit into it
// (codex r4 P1 on #3788). Until an operator has touched the linkage the
// producer's own target stands; after one, the call must POSITIVELY claim
// the lead through either arm.
function leadStillLinked(leadRow, linkage) {
  if (!linkage || !linkage.operatorOverride) return true;
  const leadId = String(leadRow?.id || '');
  if (linkage.stampedLeadId && linkage.stampedLeadId === leadId) return true;
  return !!linkage.twilioCallSid && String(leadRow?.twilio_call_sid || '') === linkage.twilioCallSid;
}
async function legacyUnitTargets(trx, flags) {
  const callLogId = flags.unit_call_log_id ? String(flags.unit_call_log_id) : null;
  if (!callLogId) return { leadId: null, customerId: null, linkage: null };
  const linkage = await unitCallLinkage(trx, callLogId);
  if (!linkage) return { leadId: null, customerId: null, linkage: null };
  const leadRow = linkage.stampedLeadId
    ? await trx('leads').where({ id: linkage.stampedLeadId }).whereNull('deleted_at').first('id')
    : (linkage.twilioCallSid
      ? await trx('leads').where({ twilio_call_sid: linkage.twilioCallSid }).whereNull('deleted_at').first('id')
      : null);
  return {
    leadId: leadRow?.id ? String(leadRow.id) : null,
    customerId: linkage.customerId,
    linkage,
  };
}
// Unlocked targets: the candidate customer to lock and the cached lead.
// applyUnitWriteback re-reads the call FOR UPDATE and settles both.
async function unitTargets(trx, flags) {
  // A legacy row is recognized by its ABSENT target fields plus the unit
  // item's own call id — never by the generic call_origin flag, which a
  // later non-call merge on the same phone flips to false (codex r1 P0 on
  // #3788).
  const legacy = flags.unit_lead_id === undefined && flags.unit_customer_id === undefined && !!flags.unit_call_log_id;
  if (legacy) return legacyUnitTargets(trx, flags);
  // The cached customer target is REVALIDATED against the unit call's
  // current linkage: an operator relink/unlink (PUT /calls/:id/customer)
  // after the ask parked is the durable correction, and a later reply
  // must follow it, never write to the former customer (codex r2 P1 on
  // #3788). The call row is the source of truth when it exists.
  let customerId = flags.unit_customer_id || null;
  let linkage = null;
  if (flags.unit_call_log_id) {
    linkage = await unitCallLinkage(trx, flags.unit_call_log_id);
    if (linkage) customerId = linkage.customerId;
  }
  return {
    leadId: flags.unit_lead_id || null,
    customerId,
    linkage,
  };
}

// EVERY live unsent engine draft for the call AT THE ASKED BUILDING,
// newest first, taken FOR UPDATE: the reply HOLDS all of them for the
// operator (historical composer races can leave several rows carrying one
// callLogId, and holding only the newest leaves the rest sendable with the
// building-level address — codex r5 P1 on #3785). A same-call draft for
// ANOTHER property is outside this answer (the fence treats it the same
// way) and is left alone; an addressless row is held — it cannot be a
// different property's quote. A draft that ALREADY names the answered
// unit (an operator corrected it after the ask went out) is not stale and
// is left intact, flagged `alreadyCorrect`. Same predicate the engine's
// own existing-draft lookups use. Locked BEFORE the reply's
// customer/lead/call rows: the invalidation finalizer's order is estimates
// → leads → call_log, and the creators' is estimates → call_log (codex r4
// P1 on #3785).
async function unsentDraftsForCall(trx, callLogId, building, unitLine) {
  if (!callLogId) return [];
  const { dwellingUnitOnLine, unitLineValueKey } = require('../utils/address-normalizer');
  const answered = unitLineValueKey(String(unitLine || ''));
  const rows = await trx('estimates')
    .whereRaw("estimate_data #>> '{estimatorEngine,callLogId}' = ?", [String(callLogId)])
    .whereRaw("COALESCE(estimate_data->'estimatorEngine'->>'linkage_invalidated_at', '') = ''")
    // Every LIVE-unsent status the re-price guard covers — a scheduled
    // building-level draft is exactly the one that must not auto-send, and
    // a row already claimed 'sending' is still a guard target: the send
    // path re-checks the re-price marker immediately before the provider
    // call (codex r2 P1 on #3785).
    .whereIn('status', ['draft', 'scheduled', 'send_failed', 'sending'])
    .whereNull('sent_at')
    .whereNull('archived_at')
    .orderBy('created_at', 'desc')
    .forUpdate()
    .select('id', 'status', 'created_at', 'address');
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const line = String(row.address || '').trim();
    if (!line) return true;
    if (!sameBuilding(line, building)) return false;
    const lineUnit = dwellingUnitOnLine(line);
    if (lineUnit && answered && unitLineValueKey(lineUnit) === answered) row.alreadyCorrect = true;
    return true;
  });
}

// Guard (re-price marker + this reply's attempt token) every live unsent
// draft for the call that is not guarded yet. `hold.heldIds` is the FULL
// held set, newest first — the first is the one the operator bell names.
async function guardLiveDraftsForCall(trx, callLogId, hold) {
  const rows = await unsentDraftsForCall(trx, callLogId, hold.building, hold.unitLine);
  const at = new Date().toISOString();
  const ids = [];
  for (const row of rows) {
    const id = String(row.id);
    if (row.alreadyCorrect) { hold.alreadyCorrectId = hold.alreadyCorrectId || id; continue; }
    if (!hold.guardedIds.has(id)) {
      const ok = await setEstimateRepricePending(trx, id, at, hold.attempt);
      if (!ok) continue;
      hold.guardedIds.add(id);
    }
    ids.push(id);
  }
  hold.heldIds = ids;
  return ids;
}

// The write-back's CALL side: the call row taken FOR UPDATE (customers →
// call_log order, see applyUnitWriteback), the durable unit-answer fence
// stamped under that lock, and the hold's second pass. Returns the locked
// linkage (null when the ask has no unit call or the call row is gone) and
// whether the call was relinked away from the targeted customer.
async function lockUnitCallForWriteback(trx, { flags, customerId, unitLine, building, askDraftId, hold, out }) {
  if (!flags.unit_call_log_id) return { linkage: null, relinked: false };
  const linkage = await unitCallLinkage(trx, flags.unit_call_log_id, { lock: true });
  if (!linkage) return { linkage: null, relinked: false };
  const relinked = linkage.customerId !== (customerId ? String(customerId) : null);
  if (relinked) {
    out.customer = 'call_relinked';
    out.relinkedTo = linkage.customerId;
  }
  // The DURABLE call-level unit-answer fence, written under the call
  // row lock every draft creator also holds through its insert: a
  // composer that built a whole-building draft before this reply is
  // blocked at its insert, and a later composer (a reprocess, the
  // bedroom re-price, PR C2b's automatic re-draft) adopts the unit
  // (codex r5 P1 on #3785; estimate-claim-sql.callUnitAnswerFence).
  const { stampCallUnitAnswer } = require('../utils/estimate-claim-sql');
  out.fence = (await stampCallUnitAnswer(trx, flags.unit_call_log_id, { unit: unitLine, building, askDraftId })) ? 'stamped' : 'missing';
  if (hold) {
    // Second pass, now serialized against every creator: a draft a
    // composer committed between the first lookup and this lock is
    // seen here and held too, and nothing can be inserted after this
    // transaction commits without carrying the unit.
    await guardLiveDraftsForCall(trx, flags.unit_call_log_id, hold);
  }
  return { linkage, relinked };
}

// A lead line's street (with its place tail) and whatever unit it already
// carries, in EITHER position, for the unit_added rebuild.
function leadStreetForUnitRebuild(leadAddress) {
  const { splitUnitFirstLine, splitStreetLineUnitParts } = require('../utils/address-normalizer');
  const peeled = splitUnitFirstLine(leadAddress);
  if (peeled) return { existingUnit: peeled.unit, street: peeled.rest };
  const inline = splitStreetLineUnitParts(leadAddress);
  if (!inline?.unit) return { existingUnit: '', street: leadAddress };
  return { existingUnit: inline.unit, street: [inline.street, inline.tail].filter(Boolean).join(', ') };
}

// The write-back's LEAD side: fill an empty line, add the unit beside a
// unitless line at the asked building, or report why not. Returns the
// audit outcome for out.lead.
async function writeLeadUnit(trx, { leadId, linkage, building, unitLine }) {
  if (!leadId) return 'skipped';
  const { dwellingUnitOnLine, normalizeLeadAddress, structuralUnitPart } = require('../utils/address-normalizer');
  // Locked before the fill/append decision — an admin edit landing
  // between an unlocked read and the write would be overwritten (codex
  // r3 P2). Customer lock first (above), then the lead: fanout order.
  const leadRow = await trx('leads').where({ id: leadId }).whereNull('deleted_at').forUpdate().first();
  const leadAddress = String(leadRow?.address || '').trim();
  if (leadRow && !leadStillLinked(leadRow, linkage)) {
    // The operator detached this lead from the call after the ask parked.
    return 'call_unlinked';
  } else if (leadRow && !leadAddress) {
    const formatted = normalizeLeadAddress({ line1: building.street_line_1, line2: unitLine, city: building.city, state: 'FL', zip: building.postal_code });
    await trx('leads').where({ id: leadId }).whereNull('deleted_at').update({ address: formatted.fullAddress });
    return 'filled';
  } else if (leadRow && !dwellingUnitOnLine(leadAddress) && sameBuildingForWrite(leadAddress, building)) {
    // A unit-first line ("Bldg 9, 1048 Example Lakes Cir, Sarasota, …") is
    // rebuilt from its PEELED street — normalizeLeadAddress would read
    // "Bldg 9" as the street and the street as the city — with the
    // structural component kept beside the replied dwelling unit
    // (codex r4 P1 on #3804). A STREET-FIRST structural line ("1048
    // Example Lakes Cir, Bldg 9, Sarasota, …") is rebuilt the same way
    // from its street + place tail: handed whole, normalizeLeadAddress
    // reads "Bldg 9" as a unit that CONFLICTS with the replied apartment,
    // drops line 2, and the write would report unit_added while storing
    // the unitless line (codex r8 P1 on #3804).
    const { existingUnit, street } = leadStreetForUnitRebuild(leadAddress);
    const formatted = normalizeLeadAddress({ raw: street, line2: [structuralUnitPart(existingUnit), unitLine].filter(Boolean).join(' ') });
    await trx('leads').where({ id: leadId }).whereNull('deleted_at').update({ address: formatted.fullAddress || `${leadAddress}, ${unitLine}` });
    return 'unit_added';
  } else if (leadRow) {
    return dwellingUnitOnLine(leadAddress) ? 'already_has_unit' : 'different_building';
  }
  return 'skipped';
}

// The write-back's CUSTOMER side: line 2 on the mirror, the unit as its own
// property row, or the evidence that it is already on file. Mutates out
// (customer, propertyId, propertyCreated, primaryEnsuredId).
async function writeCustomerUnit(trx, { customerId, customerRow, building, unitLine, out }) {
  const { dwellingUnitOnLine } = require('../utils/address-normalizer');
  const { recordCallProperty, syncPrimaryAddress, ensurePrimaryProperty } = require('./customer-properties');
  const { unitLineValueKey } = require('../utils/address-normalizer');
  const ownAddress = String(customerRow.address_line1 || '').trim();
  // The customer's active property rows AT the asked building, read
  // under the customer lock taken above. A unit is either line 2 or
  // INLINE on line 1 (a legacy shape the property address_key
  // canonicalizes the same).
  const wanted = unitLineValueKey(unitLine);
  const props = await trx('customer_properties')
    .where({ customer_id: customerId, active: true })
    .select('id', 'is_primary', 'address_line1', 'address_line2', 'city', 'zip');
  const propUnit = (p) => String(p.address_line2 || '').trim() || dwellingUnitOnLine(String(p.address_line1 || '')) || '';
  const atBuilding = (props || []).filter((p) => sameBuildingForWrite(customerAddressLine(p), building));
  const unitAlreadyOnFile = atBuilding.some((p) => propUnit(p) && unitLineValueKey(propUnit(p)) === wanted);
  // The building + replied unit as its OWN property row on the account,
  // through the same function the call pipeline uses (which also makes
  // it the primary and mirrors it when the customer has no address
  // yet). An existing building-level row at the address is PRESERVED,
  // never rewritten into the unit: property rows carry no call linkage,
  // so a unitless row cannot be proven to be this call's placeholder
  // rather than a property manager's deliberate common-area property
  // whose id visits and estimates already point at — and a reprocessed
  // call would re-insert the building beside a rewritten row anyway
  // (codex r1 P0 + P1 on #3788; supersedes the #3785 r4 upgrade).
  const recordUnitProperty = async () => {
    if (ownAddress) {
      // A populated mirror with no primary row yet (lazy backfill):
      // recordCallProperty would otherwise make the replied unit the
      // primary while customers.address_* still points at the
      // customer's own address (codex r3 P2 on #3788). The mirror's
      // row is ensured first, so the unit lands as the secondary.
      const ensured = await ensurePrimaryProperty(customerRow, { conn: trx, source: 'clarify_unit_reply' });
      if (ensured?.created && ensured.propertyId) out.primaryEnsuredId = String(ensured.propertyId);
    }
    const rec = await recordCallProperty({
      customerId,
      address_line1: building.street_line_1,
      address_line2: unitLine,
      city: building.city || null,
      state: 'FL',
      zip: building.postal_code || null,
      source: 'clarify_unit_reply',
      conn: trx,
    });
    out.customer = rec?.created ? (ownAddress ? 'second_property' : 'primary_property') : 'property_exists';
    out.propertyId = rec?.propertyId || null;
    // A NEW row is enqueued for enrichment by the caller after commit
    // — the call-pipeline recovery sweep only covers its own source.
    out.propertyCreated = rec?.created === true;
  };
  if (ownAddress && sameBuildingForWrite(customerAddressLine(customerRow), building)) {
    // A legacy row may carry the unit INLINE on line 1 ("… Cir Apt 9")
    // with line 2 blank — that is a unit, never fill a second one
    // (codex r1 P1 on #3785; same guard as the lead branch).
    // The customer's own unit: line 2, INLINE on line 1, or — a
    // supported legacy mirror — only on the active primary property
    // row (syncPrimaryAddress preserves it for null-line2 callers).
    // Ignoring that last shape would overwrite Apt 9 with Apt 204 on
    // both the mirror and the primary (codex r1 P0 on #3788).
    const primaryAtBuilding = atBuilding.find((p) => p.is_primary);
    const ownUnit = String(customerRow.address_line2 || '').trim() || dwellingUnitOnLine(ownAddress)
      || (primaryAtBuilding ? propUnit(primaryAtBuilding) : '') || '';
    if (!ownUnit) {
      // A supported shape: unitless primary at the building PLUS an
      // active secondary property for this exact unit. Moving the
      // primary onto that unit would collide with the unique active
      // (customer_id, address_key) index and roll the whole reply back
      // (codex r1 P1 on #3785) — the unit is already on file; leave both
      // rows as they are.
      if (unitAlreadyOnFile) {
        out.customer = 'property_exists';
      } else {
        await trx('customers').where({ id: customerId }).update({ address_line2: unitLine });
        // A customer with no primary property row yet (lazy-backfill
        // model, or property persistence gated/failed at call time)
        // gets one from the mirror — WITH the unit — or the sync below
        // would silently have nothing to update (codex r1 P2 on #3788).
        const ensured = await ensurePrimaryProperty({ ...customerRow, address_line2: unitLine }, { conn: trx, source: 'clarify_unit_reply' });
        await syncPrimaryAddress({ ...customerRow, address_line2: unitLine }, trx, { explicitLine2: true, preserveCoords: true });
        out.customer = 'line2_filled';
        if (ensured?.created && ensured.propertyId) {
          // Created from a mirror that may lack coordinates/type —
          // enriched after commit like every other row this lane
          // creates (codex r2 P2 on #3788).
          out.propertyId = String(ensured.propertyId);
          out.propertyCreated = true;
        }
      }
    } else if (unitLineValueKey(ownUnit) === wanted || unitAlreadyOnFile) {
      out.customer = unitAlreadyOnFile && unitLineValueKey(ownUnit) !== wanted ? 'property_exists' : 'already_has_unit';
    } else {
      // The customer's own unit at the building is a DIFFERENT one
      // (Apt 9 on file, the call was about Apt 204 — an in-flight ask
      // from before the gate, or CRM edited after dispatch). Their
      // primary stays; the replied unit still enters the record as a
      // secondary property, or later booking and property linkage keep
      // resolving to the old unit (codex r5 P1 on #3785).
      await recordUnitProperty();
    }
  } else if (unitAlreadyOnFile) {
    out.customer = 'property_exists';
  } else {
    await recordUnitProperty();
  }
}

async function applyUnitWriteback(trx, { unitLine, flags, targets, askDraftId = null, hold = null }) {
  const building = flags.unit_ask_building || null;
  const out = { lead: 'skipped', customer: 'skipped', at: new Date().toISOString() };
  if (!building?.street_line_1) return { ...out, reason: 'no_building' };
  // Unit detection reads the DWELLING unit in EITHER supported position —
  // a record stored unit-first ("Apt 9, 1048 Example Lakes Cir, …") must
  // never be given a second unit (codex r6 P1 on #3796), while a structural
  // component alone ("Bldg 9, …") still lacks the apartment (pre-push
  // codex P1 on #3804).
  const { leadId, customerId } = targets;
  // Lock order: CUSTOMER row first, then the lead — the Customer 360
  // address edit takes customer → leads (customer-address-fanout), and the
  // opposite order here could deadlock and roll the whole reply back (codex
  // r2 P1 on #3785). Both write decisions read rows taken after that lock.
  let customerRow = customerId
    ? await trx('customers').where({ id: customerId }).whereNull('deleted_at').forUpdate().first()
    : null;
  // The targets came from an UNLOCKED read of the call row. With the
  // customer row (if any) now held, the call row is taken FOR UPDATE —
  // ALWAYS when the ask has a unit call, a null initial linkage included
  // (codex r4 P1 on #3788) — in customers → call_log order (the call
  // pipeline's claim-fence order, never the reverse) and held through the
  // writes, so a PUT /calls/:id/customer relink/unlink serializes against
  // this reply instead of landing between two reads. One that committed
  // first is the durable correction: the former (or absent) customer is
  // skipped, never raced (codex r3 P1). A customer the lock reveals is NOT
  // locked here — that would be call_log → customers, the reverse of the
  // route's and the pipeline's order, and a deadlock rolls the whole reply
  // back; the audit names them for the office instead.
  const { linkage, relinked } = await lockUnitCallForWriteback(trx, { flags, customerId, unitLine, building, askDraftId, hold, out });
  if (relinked) customerRow = null;
  out.lead = await writeLeadUnit(trx, { leadId, linkage, building, unitLine });
  if (customerId && customerRow) await writeCustomerUnit(trx, { customerId, customerRow, building, unitLine, out });
  return out;
}

// Approval-time evidence (gate ON): the unit is already on file AT THE
// ASKED BUILDING — the unit item's own lead line, the customer's own line 2
// when their address is that building, or an active property row at it.
// True only when the evidence resolves to ONE unit: a property manager or
// customer with several units at the building has not answered WHICH one
// the call was about, so the ask stands (codex r2 P1 on #3785).
async function unitOnFileAtBuilding(trx, flags) {
  const building = flags.unit_ask_building || null;
  if (!building?.street_line_1) return false;
  const { dwellingUnitOnLine, unitLineValueKey } = require('../utils/address-normalizer');
  const { leadId, customerId, linkage } = await unitTargets(trx, flags);
  const units = new Set();
  const add = (unit) => { const key = unitLineValueKey(String(unit || '')); if (key) units.add(key); };
  if (leadId) {
    const leadRow = await trx('leads').where({ id: leadId }).whereNull('deleted_at').first();
    const line = String(leadRow?.address || '').trim();
    // The unit item's OWN lead is definitive for this ask — a unit staff
    // entered there answers it regardless of a property manager's other
    // units on the account (codex r1 P2 on #3788) — unless an operator
    // has detached that lead from the call since (same rule as the write).
    if (leadRow && leadStillLinked(leadRow, linkage) && line && dwellingUnitOnLine(line) && sameBuildingForWrite(line, building)) return true;
  }
  if (customerId) {
    const customerRow = await trx('customers').where({ id: customerId }).whereNull('deleted_at').first();
    // Positive locality here as well: a lone "123 Main St Apt 4" row with
    // no city/ZIP is not evidence that THIS building's unit is on file
    // (codex r2 P1 on #3788).
    if (customerRow && sameBuildingForWrite(customerAddressLine(customerRow), building)) {
      const own = String(customerRow.address_line2 || '').trim() || dwellingUnitOnLine(String(customerRow.address_line1 || ''));
      if (own) add(own);
    }
    const props = await trx('customer_properties')
      .where({ customer_id: customerId, active: true })
      .select('address_line1', 'address_line2', 'city', 'zip');
    for (const p of props || []) {
      const unit = String(p.address_line2 || '').trim() || dwellingUnitOnLine(String(p.address_line1 || ''));
      if (unit && sameBuildingForWrite(customerAddressLine(p), building)) add(unit);
    }
  }
  return units.size === 1;
}

// Rewrite an unclaimed pending clarify with the union of missing items and
// the NEWEST request's linkage. Runs under the clarify lock (trx), so the
// flags read is serialized. Linkage is REPLACED, not backfilled: the
// newest request is authoritative, and a deliberately-null customerId
// (ambiguous shared phone) must not inherit the old draft's customer — a
// later reply would overwrite the wrong CRM record. Guarded on status so
// a claim landing before the lock wins.
async function mergePendingClarify(trx, existing, { askable, firstName, linkage }) {
  let existingFlags = {};
  try {
    existingFlags = typeof existing.flags === 'string' ? JSON.parse(existing.flags) : (existing.flags || {});
  } catch { existingFlags = {}; }
  const existingMissing = Array.isArray(existingFlags.missing) ? existingFlags.missing : [];
  const merged = [...new Set([...existingMissing, ...askable])];
  // The unit item binds to ITS call/lead/customer/building — refreshed
  // only by a request that asks for the unit, never by a later merged ask
  // for another lead on the same phone (codex r1 P1; same rule as
  // bedroom_estimate_id).
  const unitLinkage = askable.includes('unit_number') ? unitAskFlags(linkage) : {};
  const unitAskBuilding = unitLinkage.unit_ask_building || existingFlags.unit_ask_building || null;
  const changed = await trx('message_drafts')
    .where({ id: existing.id, status: 'pending' })
    .update({
      customer_id: linkage.customerId || null,
      draft_response: composeClarifyBody({ missing: merged, firstName, unitAskBuilding }),
      flags: JSON.stringify({
        ...existingFlags,
        missing: merged,
        lead_id: linkage.leadId || null,
        estimate_id: linkage.estimateId || null,
        // The NEWEST producer owns the origin: a call-origin ask's reply
        // is recorded and stamped, never auto-resumed (the SMS-thread
        // composer lacks the call context); a later SMS/web/email ask on
        // the same phone clears that and resumes as before.
        call_origin: String(linkage.source || '').startsWith('call_'),
        ...unitLinkage,
        // The bedroom item binds to ITS unit draft, independent of the
        // generic linkage a later merged ask may re-point.
        ...(askable.includes('bedroom_count') && linkage.estimateId ? { bedroom_estimate_id: String(linkage.estimateId) } : {}),
        source: linkage.source,
        channel_provenance: linkage.channelProvenance || null,
      }),
    });
  // 0 rows = the claim landed first; the caller must NOT report a merge
  // (the new item would silently vanish from flags.missing).
  return { changed: changed > 0, merged };
}

/**
 * Park one clarifying-question draft. Fail-soft by contract: callers sit on
 * quote dead-end paths that must never break because calibration/outreach
 * plumbing hiccupped. Returns { parked, draftId? , skipped? }.
 *
 * @param {object} args
 *   missing        — machine missing-items (only ASKABLE ones are used)
 *   phone          — customer/lead phone (required; SMS is the channel)
 *   firstName      — for the greeting (optional)
 *   customerId     — customers.id when one exists (optional)
 *   leadId         — leads.id linkage for the answer to resume against
 *   estimateId     — draft estimate id when one exists
 *   source         — producer tag ('estimator_engine_red' | 'lead_intake' |
 *                    'lead_webhook_blocked' | 'email_inquiry_not_ready')
 *   channelProvenance — how Waves got this phone ('sms' | 'voice' |
 *                    'web_form' | 'email'). The approve route only asserts
 *                    a transactional consentBasis for sms/voice/web_form;
 *                    an email-extracted phone asserts nothing and the
 *                    messaging validator's fail-closed path owns the
 *                    verdict.
 *   contextSummary — operator-facing "why this draft exists" line
 *   callLogId      — the call whose missing_unit_number card this ask
 *                    serves (a unit reply is stamped onto that card)
 *   unitAskBuilding — { street_line_1, city, postal_code } the unit belongs
 *                    to (the card's own payload) — names the building in
 *                    the question
 */
async function parkClarifyAsk({
  missing = [],
  phone,
  firstName = null,
  customerId = null,
  leadId = null,
  estimateId = null,
  source = 'unknown',
  channelProvenance = null,
  contextSummary = null,
  callLogId = null,
  unitAskBuilding = null,
}) {
  try {
    if (!clarifyAsksEnabled()) return { parked: false, skipped: 'gate_off' };
    const askable = missing.filter((item) => ASKABLE_MISSING.has(item));
    if (!askable.length) return { parked: false, skipped: 'nothing_askable' };
    // A REAL US destination or nothing: exactly 10 digits, or 11 with a
    // leading country 1. Shorter fragments, extensions ("… ext 9"), and
    // non-US lengths must not queue a draft that fails at Twilio after the
    // owner already approved it. toPhone derives from THESE digits, never a
    // normalizer's unvalidated passthrough.
    const allDigits = String(phone || '').replace(/\D/g, '');
    const digits = allDigits.length === 10
      ? allDigits
      : (allDigits.length === 11 && allDigits.startsWith('1') ? allDigits.slice(1) : null);
    if (!digits) return { parked: false, skipped: 'no_usable_phone' };

    const sourceRef = `clarify:${digits}`;
    const linkage = { customerId, leadId, estimateId, source, channelProvenance, callLogId, unitAskBuilding };
    // The whole dedupe→merge→insert sequence holds the clarify lock, so
    // producers for one phone serialize completely — no lost merges, no
    // 23505 recovery dance (the unique index remains as the DB backstop;
    // hitting it under the lock is a genuine anomaly and rolls back into
    // the outer fail-soft catch).
    const outcome = await withClarifyLock(digits, async (trx) => {
    // One OPEN clarify per phone; no re-ask soon after a sent one. "Open"
    // means sent_at IS NULL — the admin send path stamps sent_at but leaves
    // status 'approved'/'revised', so status alone would read a delivered
    // clarify as open forever. "Recently sent" keys on sent_at directly for
    // the same reason.
    const existing = await trx('message_drafts')
      .where({ intent: 'estimate_clarify', source_ref: sourceRef })
      .where(function openOrRecentlySent() {
        this.where(function stillOpen() {
          this.whereIn('status', ['pending', 'approved', 'revised']).whereNull('sent_at');
        }).orWhere('sent_at', '>=', new Date(Date.now() - RECENT_SENT_WINDOW_MS));
      })
      // An open draft (sent_at null) outranks sent ones for the merge
      // path; among sent rows the NEWEST governs the cooldown — judging by
      // an old consumed ask would bypass the no-nag window while a newer
      // ask sits unanswered.
      .orderByRaw('(sent_at is not null) asc, sent_at desc')
      .first();
    if (existing) {
      // Merge, don't discard: an unclaimed 'pending' draft is ALWAYS
      // rewritten on a dedupe hit — union of missing items (a new dead-end
      // can carry a question the draft doesn't ask yet) AND linkage
      // refreshed to the NEWEST request, so the approval guard judges
      // staleness against the request that still needs the question rather
      // than one whose lead closed. approved/revised are mid-send and a
      // recently-sent one is a cooldown — untouched.
      if (existing.status === 'pending') {
        const mergeResult = await mergePendingClarify(trx, existing, { askable, firstName, linkage });
        if (mergeResult.changed) {
          return {
            parked: false,
            skipped: 'merged_into_open_clarify',
            draftId: existing.id,
            covers: mergeResult.merged,
          };
        }
        // Claim landed mid-merge — the draft is being sent with its OLD
        // items; report a plain dedupe covering only those, so callers
        // don't assume the new item was asked (a later dead-end re-asks it
        // via the consumed-ask exception below).
        let claimedFlags = {};
        try {
          claimedFlags = typeof existing.flags === 'string' ? JSON.parse(existing.flags) : (existing.flags || {});
        } catch { claimedFlags = {}; }
        return {
          parked: false,
          skipped: 'open_or_recent_clarify',
          draftId: existing.id,
          covers: Array.isArray(claimedFlags.missing) ? claimedFlags.missing : [],
        };
      }
      // Recent-sent cooldown — with two exceptions: (a) the ask was
      // PARTIALLY answered and this request covers only what is still
      // unanswered (the other half must not be silenced for seven days);
      // (b) the ask was fully CONSUMED — the contact is responsive, and a
      // NEW dead-end's different question deserves a fresh ask.
      let sentFlags = {};
      try {
        sentFlags = typeof existing.flags === 'string' ? JSON.parse(existing.flags) : (existing.flags || {});
      } catch { sentFlags = {}; }
      const remaining = Array.isArray(sentFlags.missing) ? sentFlags.missing : [];
      const recordedItems = Array.isArray(sentFlags.answer_recorded) ? sentFlags.answer_recorded : [];
      const partiallyAnswered = recordedItems.length > 0;
      const consumed = !!sentFlags.answered_at;
      const asksOnlyRemaining = remaining.length > 0 && askable.every((item) => remaining.includes(item));
      if (!((partiallyAnswered && asksOnlyRemaining) || consumed)) {
        return {
          parked: false,
          skipped: 'open_or_recent_clarify',
          draftId: existing.id,
          // What that sent ask actually covered — remaining + answered.
          covers: [...new Set([...remaining, ...recordedItems])],
        };
      }
      // fall through: park a fresh ask (the partial unique index only
      // covers OPEN drafts, so the sent row won't conflict).
    }

    const [draft] = await trx('message_drafts')
      .insert({
        customer_id: customerId || null,
        draft_response: composeClarifyBody({ missing: askable, firstName, unitAskBuilding }),
        intent: 'estimate_clarify',
        status: 'pending',
        source_ref: sourceRef,
        context_summary: contextSummary
          || `Quote request is missing ${askable.join(' + ')} (${source}). Clarifying question drafted — review and approve to send.`,
        flags: JSON.stringify({
          estimate_clarify: true,
          missing: askable,
          toPhone: `+1${digits}`,
          lead_id: leadId || null,
          estimate_id: estimateId || null,
          call_origin: String(source || '').startsWith('call_'),
          ...(askable.includes('unit_number') ? unitAskFlags({ callLogId, unitAskBuilding, leadId, customerId }) : {}),
          // Item-specific target for the bedroom re-price (see mergePendingClarify).
          ...(askable.includes('bedroom_count') && estimateId ? { bedroom_estimate_id: String(estimateId) } : {}),
          source,
          channel_provenance: channelProvenance || null,
        }),
      })
      .returning(['id']);
    return { parked: true, draftId: draft.id, covers: askable };
    });

    // Bell OUTSIDE the lock/transaction — a slow or failing notification
    // must not hold the phone's lifecycle lock or roll back the draft.
    if (outcome.parked) {
      try {
        await require('./notification-service').notifyAdmin(
          'lead',
          'Clarifying question drafted — approve to send',
          `A quote request is missing ${askable.join(' and ').replace(/_/g, ' ')}. A clarifying text is waiting for your approval in the drafts queue.`,
          {
            link: '/admin/communications',
            metadata: { estimate_clarify: true, draftId: outcome.draftId, source, leadId, estimateId },
          },
        );
      } catch (bellErr) {
        logger.warn(`[estimate-clarify] bell failed (draft stands): ${bellErr.message}`);
      }
      logger.info('[estimate-clarify] clarify draft parked', { draftId: outcome.draftId, source, missing: askable });
    }
    return outcome;
  } catch (err) {
    logger.warn(`[estimate-clarify] park failed: ${err.message}`);
    return { parked: false, skipped: `error: ${err.message}` };
  }
}

// A KNOWN-service tail on a captured address ("123 Main St, pest control")
// is the service answer, not part of the address — bounded vocabulary,
// deterministic split. Returns { address, serviceTail }.
/**
 * True while an estimator draft carries the re-price marker. The marker
 * never lapses on its own: a draft whose dollars are KNOWN stale stays
 * unsendable until either the replacement lands (the row is archived by
 * the supersede) or the operator explicitly re-prices it (admin PUT /:id
 * → the revision's own locked write). A crash mid-re-draft therefore leaves
 * the draft blocked with the bell/409 pointing at it — never sendable at
 * the old price.
 */
function repricePendingActive(engineData) {
  const at = engineData && typeof engineData === 'object' ? engineData.reprice_pending_at : null;
  return typeof at === 'string' && at.length > 0;
}

// A failed re-price on a SCHEDULED draft: lifting the guard alone would
// let the scheduler claim the due row and send the stale fallback price
// — so the schedule is cancelled (inert draft, no due time) and the bell
// hands it to the operator.
// Whether an engine draft was composed from THIS call (estimator_engine
// .callLogId) — inside the caller's transaction.
async function estimateComposedFromCall(trx, estimateId, callLogId) {
  if (!estimateId || !callLogId) return false;
  const row = await trx('estimates').where({ id: estimateId }).first('estimate_data');
  if (!row) return false;
  let data = row.estimate_data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return false; } }
  return String(data?.estimatorEngine?.callLogId || '') === String(callLogId);
}

async function unscheduleForOperatorReprice(trx, estimateId, attempt) {
  const changed = await trx('estimates')
    .where({ id: estimateId, status: 'scheduled' })
    .whereNull('sent_at')
    .whereNull('archived_at')
    // Only while THIS attempt still owns the row — an operator's revision
    // (which may have re-scheduled a corrected price) deletes the token.
    .whereRaw("estimate_data->'estimatorEngine'->>'reprice_attempt' = ?", [String(attempt || '')])
    .update({ status: 'draft', scheduled_at: null, updated_at: new Date() });
  return Number(changed) > 0;
}

// Stamp (or clear, at=null) estimator_engine.reprice_pending_at on an
// UNSENT, LIVE draft — inside the caller's transaction, as an ATOMIC
// JSONB path update: only this one key changes, so a concurrent linkage
// reconciliation's markers (linkage_invalidated_at / invalidation_pending_at)
// can never be overwritten by a stale blob, and the predicate refuses an
// archived or invalidated row outright (codex pre-push P0).
async function setEstimateRepricePending(trx, estimateId, at, attempt = null) {
  // 'scheduled' rows are unsent drafts with a due time — the cron would
  // otherwise deliver the stale fallback price; the supersede path returns
  // them to an inert draft when the replacement lands. A row already in
  // 'sending' gets the marker too: the delivery verdict holds the row FOR
  // UPDATE so this write lands right after the claim, and the pre-handoff
  // check (estimateInvalidatedJustBeforeHandoff) then aborts delivery.
  const changed = await trx('estimates')
    .where({ id: estimateId })
    .whereIn('status', ['draft', 'scheduled', 'send_failed', 'sending'])
    .whereNull('sent_at')
    .whereNull('archived_at')
    .whereRaw("COALESCE(estimate_data->'estimatorEngine'->>'linkage_invalidated_at', '') = ''")
    .whereRaw("COALESCE(estimate_data->'estimatorEngine'->>'invalidation_pending_at', '') = ''")
    .update({
      // The attempt token ties THIS answer's detached re-draft to the row:
      // supersede/archive and unschedule require it, and the operator's
      // revision deletes it, so a stale attempt can never touch a draft
      // that was corrected while composition ran.
      estimate_data: at
        ? trx.raw(
          "jsonb_set(estimate_data, '{estimatorEngine}', COALESCE(estimate_data->'estimatorEngine', '{}'::jsonb) || jsonb_build_object('reprice_pending_at', ?::text, 'reprice_attempt', ?::text))",
          [at, attempt || ''],
        )
        : trx.raw(
          "jsonb_set(estimate_data, '{estimatorEngine}', COALESCE(estimate_data->'estimatorEngine', '{}'::jsonb) - 'reprice_pending_at' - 'reprice_attempt')",
        ),
      updated_at: new Date(),
    });
  return Number(changed) > 0;
}

// Merge a patch into the ask row's flags (read-modify-write; null values
// delete the key). Bookkeeping only — never touches status/copy.
async function stampClarifyFlags(digits, draftId, patch) {
  // UNDER the phone-scoped clarify lock every other flags mutation takes —
  // an unlocked read-modify-write could overwrite a concurrent reply's
  // committed missing/answered_at/linkage state.
  try {
    return await withClarifyLock(digits, async (trx) => {
      const row = await trx('message_drafts').where({ id: draftId }).first('flags');
      if (!row) return false;
      let current = {};
      try { current = typeof row.flags === 'string' ? JSON.parse(row.flags) : (row.flags || {}); } catch { current = {}; }
      const next = { ...current };
      for (const [k, v] of Object.entries(patch || {})) {
        if (v === null || v === undefined) delete next[k];
        else next[k] = v;
      }
      await trx('message_drafts').where({ id: draftId }).update({ flags: JSON.stringify(next) });
      return true;
    });
  } catch (err) {
    logger.warn(`[estimate-clarify] flag stamp failed: ${err.message}`);
    return false;
  }
}

// The call a VOICE-origin estimator draft was composed from, or null for
// SMS-thread drafts / non-engine estimates / a missing row.
async function voiceOriginCallLogId(estimateId) {
  try {
    const row = await db('estimates').where({ id: estimateId }).first('estimate_data');
    if (!row) return null;
    const data = typeof row.estimate_data === 'string' ? JSON.parse(row.estimate_data) : (row.estimate_data || {});
    const engine = data?.estimatorEngine || {};
    if (engine.origin && engine.origin !== 'call') return null;
    return engine.callLogId ? String(engine.callLogId) : null;
  } catch (err) {
    logger.warn(`[estimate-clarify] draft origin lookup failed: ${err.message}`);
    return null;
  }
}

const SERVICE_TAIL_RE = /[,\s]+((?:quarterly\s+|monthly\s+|recurring\s+|one[-\s]?time\s+)?(?:pest|lawn|mosquito(?:es)?|termites?|bed\s?bugs?|fleas?|ticks?|rodents?|mice|rats?|ants?|roach(?:es)?|wasps?|spiders?)(?:\s+(?:control|care|service|treatment|program|removal))?)\s*$/i;
function stripServiceTail(address) {
  let out = String(address || '').trim();
  let tailParts = [];
  let match;
  while ((match = out.match(SERVICE_TAIL_RE))) {
    tailParts.unshift(match[1]);
    out = out.slice(0, match.index).replace(/[,\s]+$/, '').trim();
  }
  return { address: out, serviceTail: tailParts.join(' ') || null };
}

// Local address heuristics (mirrors lead-intake's leniency; duplicated
// because lead-intake requires THIS module — importing back would cycle).
// "studio", "it's a 2 bedroom", "one-bedroom apartment", "3br", "2 bed 2 bath".
// A bare number is NOT accepted (it could answer anything); the word or
// abbreviation must be there. Studio/efficiency = 0.
const BEDROOM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const BEDROOM_COUNT_RE = /\b(\d{1,2}|one|two|three|four|five|six)\s*(\+|plus|or more)?\s*[-–]?\s*(?:br|bd|bdr|bdrm|bed|beds|bedroom|bedrooms)\b/i;
// "not a studio" / "isn't an efficiency" / "no studio" — the studio word
// under a negation is not an answer of zero.
const NEGATED_STUDIO_RE = /\b(?:not|no|isn'?t|ain'?t|wasn'?t|never)\s+(?:a\s+|an\s+|the\s+)?(?:studio|efficiency)\b/i;
const BARE_BEDROOM_NUMBER_RE = /^\s*(\d{1,2}|one|two|three|four|five|six)\s*(\+|or more|plus)?\s*[.!]?\s*$/i;
// Bands differ at every step up to 4 (3 = $99, 4+ = $109), so a
// lower-bound reply ("3+", "2 or more") is ambiguous BELOW 4 and rejected;
// "4+" collapses into the four_plus band exactly.
function boundedBedroomCount(rawToken, lowerBound) {
  const raw = String(rawToken).toLowerCase();
  const n = BEDROOM_WORDS[raw] ?? Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 20) return null;
  if (lowerBound && n < 4) return null;
  return n;
}
function extractBedroomReply(body, { bareNumberOk = false } = {}) {
  const text = String(body || '').trim();
  if (!text) return null;
  // A bare number answers ONLY a bedroom-only ask (combined asks keep the
  // stricter rule — "2" could answer anything there).
  if (bareNumberOk) {
    const bare = text.match(BARE_BEDROOM_NUMBER_RE);
    if (bare) return boundedBedroomCount(bare[1], !!bare[2]);
  }
  // An explicit count always wins ("not a studio, it's a 2 bedroom");
  // a lower-bound phrasing below 4 ("3+ bedrooms", "3 or more bedrooms")
  // is ambiguous across bands and is not an answer.
  const m = text.match(BEDROOM_COUNT_RE);
  if (m) return boundedBedroomCount(m[1], !!m[2]);
  if (NEGATED_STUDIO_RE.test(text)) return null;
  if (/\b(?:studio|efficiency)\b/i.test(text)) return 0;
  return null;
}

const CLARIFY_STREET_SUFFIX_RE = /\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|pl|place|ter|terrace|cir|circle|pkwy|parkway|trl|trail|hwy|highway|loop)\b/i;
function extractAddressReply(body) {
  const text = String(body || '').trim();
  if (!text) return null;
  // Whole-body address reply ("123 Main St, Sarasota 34239").
  if (/^\s*\d{1,6}\s+[A-Za-z]/.test(text) && text.length <= 160) {
    const clause = text.split(/[.;!?\n]/)[0];
    const cut = clause.split(/\s+(?:for|about|regarding|because|since|need|want|please|thanks)\b/i)[0].trim();
    // Suffix required even on whole-body replies — "2 dogs and pest
    // control" starts with digits but is not an address.
    if (cut.length >= 6 && CLARIFY_STREET_SUFFIX_RE.test(cut)) return cut;
  }
  // Embedded ("it's 123 Main St, Sarasota") — suffix required, latest wins.
  let best = null;
  for (const match of text.matchAll(/\d{1,6}\s+[A-Za-z]/g)) {
    // Clause boundary first, then service-introducing prose ("123 Main St
    // for pest control") — connector words end the address.
    const clause = text.slice(match.index).split(/[.;!?\n]/)[0];
    const candidate = clause.split(/\s+(?:for|about|regarding|because|since|need|want|please|thanks)\b/i)[0].trim();
    if (candidate.length >= 6 && candidate.length <= 160 && CLARIFY_STREET_SUFFIX_RE.test(candidate)) {
      best = candidate;
    }
  }
  return best;
}

// A unit reply: "Apt 204", "unit 12B", "#7", "Apt. 204, thanks". A BARE
// token ("204", "12B") is the natural answer to the one-question ask and
// is accepted only when the unit was the only thing asked AND the question
// was actually delivered (same rule as the bedroom ask). Returns the
// canonical unit line ("Apt 204" / "Apt 12B") or null.
// A unit VALUE: carries a digit ("204", "12B", "PH1", "TH12", "A-204",
// "204-B") or is a single letter ("B") — never a bare word, so "apt on
// the 3rd floor" cannot capture "on" (codex r1 P2: the normalizer's
// multi-letter and hyphenated forms are accepted).
const UNIT_VALUE = '(?:[a-z]{0,3}\\d{1,5}(?:-?[a-z0-9]{1,4})?|[a-z]{1,3}-\\d{1,5}(?:-?[a-z0-9]{1,4})?|[a-z])';
// Every DWELLING designator the normalizer knows (address-normalizer
// DWELLING_DESIGNATORS): a park customer answers "Lot 12" / "Space 7", an
// office "Suite 210" — the matched designator is KEPT so those stay their
// own keys (codex r16 P1 on #3804); a bare or hash reply is a plain unit.
const UNIT_REPLY_RE = new RegExp(`\\b(apt|apartment|unit|ste|suite|lot|spc|space)\\.?\\s*#?\\s*(${UNIT_VALUE})\\b`, 'i');
const UNIT_HASH_REPLY_RE = new RegExp(`#\\s*(${UNIT_VALUE})\\b`, 'i');
const BARE_UNIT_REPLY_RE = new RegExp(`^\\s*(?:it'?s\\s+|its\\s+|number\\s+)?(${UNIT_VALUE})\\s*[.!]?\\s*$`, 'i');
// A reply that names TWO different units ("Not Apt 204, it's Apt 205") or
// negates the one it names ("not unit 204") is a correction, not an
// answer — with the write-back gate on the value reaches the lead,
// customer, and property rows, so only exactly one unambiguous candidate
// counts; anything else stays on the card for a human (codex r5 P1 on
// #3785).
// Correction/negation vocabulary ANYWHERE in the text ("Apt 204 is wrong,
// it's 205" corrects after the designator), or ANY other unit-shaped
// value in the reply however it is introduced — "or 205", "and 205",
// "should be 205", "it's 205", "204/205" — fails closed: only a reply
// whose sole unit-shaped value is the designated one counts (codex r1 +
// r2 P1 on #3788). The one carve-out is a bedroom count riding on the
// same text ("Apt 204, 2 bedrooms"), which the bedroom item consumes.
const UNIT_NEGATION_RE = /\b(?:not|isn'?t|wasn'?t|wrong|incorrect|instead|actually|correction|should be|no longer|rather)\b/i;
const UNIT_SHAPED_TOKEN_RE = new RegExp(`(?<![a-z0-9#-])(${UNIT_VALUE})(?![a-z0-9-])(?!\\s*(?:-\\s*)?(?:bed|br\\b|bd\\b|bath))`, 'gi');
function unitReplyIsAmbiguous(text, normalizeUnitLine) {
  const norm = (v) => String(normalizeUnitLine(`apt ${v}`) || '').toLowerCase();
  if (UNIT_NEGATION_RE.test(text)) return true;
  const values = new Set();
  for (const m of text.matchAll(UNIT_SHAPED_TOKEN_RE)) {
    if (!/\d/.test(m[1])) continue; // a lone letter ("a", "in") is only a unit when designated
    const u = norm(m[1]); if (u) values.add(u);
  }
  const designated = [
    ...[...text.matchAll(new RegExp(UNIT_REPLY_RE.source, 'gi'))].map((m) => m[2]),
    ...[...text.matchAll(new RegExp(UNIT_HASH_REPLY_RE.source, 'gi'))].map((m) => m[1]),
  ].map(norm).filter(Boolean);
  for (const d of designated) values.add(d);
  return values.size > 1;
}
function extractUnitReply(body, { bareOk = false } = {}) {
  const text = String(body || '').trim();
  if (!text) return null;
  const { normalizeUnitLine } = require('../utils/address-normalizer');
  const worded = text.match(UNIT_REPLY_RE);
  const hashed = worded ? null : text.match(UNIT_HASH_REPLY_RE);
  if (worded || hashed) {
    if (unitReplyIsAmbiguous(text, normalizeUnitLine)) return null;
    // apt / apartment / unit are one interchangeable key and canonicalize to
    // Apt (as before); lot / space / suite are their own keys and are kept.
    const designator = worded ? (/^(?:apt|apartment|unit)$/i.test(worded[1]) ? 'apt' : worded[1]) : 'apt';
    return normalizeUnitLine(`${designator} ${worded ? worded[2] : hashed[1]}`) || null;
  }
  if (!bareOk) return null;
  const bare = text.match(BARE_UNIT_REPLY_RE);
  return bare ? normalizeUnitLine(`apt ${bare[1]}`) || null : null;
}

/**
 * Inbound reply routing for engine/email-originated asks (the intake state
 * machine routes its own replies). A text from a phone with a
 * recently-SENT clarify records the answered fields onto the linked
 * lead/customer rows — which is exactly what the approval-time staleness
 * guard re-derives from, so a stale re-send becomes impossible — and
 * resumes drafting through the SMS-thread engine with the intent gate and
 * cooldown bypassed (the thread now contains the answer). Never sends
 * anything itself; never blocks the webhook's normal handling (the message
 * still flows to the human inbox).
 *
 * Returns { handled } — handled=true means the reply answered a clarify
 * and the caller should skip its own general estimator trigger.
 */
async function handleClarifyReply({ phone, body }) {
  try {
    if (!clarifyAsksEnabled()) return { handled: false };
    const allDigits = String(phone || '').replace(/\D/g, '');
    const digits = allDigits.length === 10
      ? allDigits
      : (allDigits.length === 11 && allDigits.startsWith('1') ? allDigits.slice(1) : null);
    if (!digits || !String(body || '').trim()) return { handled: false };

    const awaiting = await db('message_drafts')
      .where({ intent: 'estimate_clarify', source_ref: `clarify:${digits}` })
      // Consumed asks (every item answered) leave reply routing — later
      // chit-chat ("thanks, sounds good") must not overwrite real answers
      // or re-trigger drafting. PENDING asks route too: a customer who
      // answers before the owner approves must have the answer recorded
      // and the stale question rewritten/retired.
      .whereRaw("(flags->>'answered_at') is null")
      .where(function pendingOrRecentlySent() {
        this.where(function pendingOpen() {
          this.where('status', 'pending').whereNull('sent_at');
        }).orWhere(function claimedUnsent() {
          // Mid-approval (claimed): the answer still records — stamp-only,
          // never touching the claimed row's copy or status. No stale send
          // can result: the dispatch decision (claimClarifyDispatch)
          // re-reads these flags under the same clarify lock and
          // rewrites/retires the question before committing, so this
          // bookkeeping either lands before the decision (and is honored)
          // or after it (the answer is recorded; at worst it crosses the
          // in-flight SMS, and the record prevents any re-ask).
          this.whereIn('status', ['approved', 'revised']).whereNull('sent_at');
        }).orWhere(function sentRecent() {
          this.whereNotNull('sent_at')
            .where('sent_at', '>=', new Date(Date.now() - RECENT_SENT_WINDOW_MS));
        });
      })
      .orderByRaw('(sent_at is not null) asc, sent_at desc')
      .first();
    if (!awaiting) return { handled: false };

    let flags = {};
    try {
      flags = typeof awaiting.flags === 'string' ? JSON.parse(awaiting.flags) : (awaiting.flags || {});
    } catch { flags = {}; }
    // flags.missing holds only the STILL-UNANSWERED items (recorded ones
    // are removed below), so partial-answer follow-ups route correctly.
    const missing = Array.isArray(flags.missing) ? flags.missing : [];
    if (!missing.length) return { handled: false };

    // PREP (unlocked): the snapshot decides what to ATTEMPT, and the slow
    // classifier runs outside the lock. The locked phase below re-reads
    // fresh state and only records what is STILL missing then — rapid
    // concurrent replies can't restore answered items or drop entries.
    const text = String(body).trim();
    const candidates = [];
    let capturedAddress = null;
    let rawCapturedAddress = null;
    let serviceTailFromAddress = null;
    if (missing.includes('street_address')) {
      rawCapturedAddress = extractAddressReply(text);
      if (rawCapturedAddress) {
        // "123 Main St, pest control" — a KNOWN-service tail is the
        // service answer, never part of the address.
        const stripped = stripServiceTail(rawCapturedAddress);
        if (stripped.address.length >= 6) {
          capturedAddress = stripped.address;
          serviceTailFromAddress = stripped.serviceTail;
          candidates.push('street_address');
        }
      }
    }
    let unitLine = null;
    if (missing.includes('unit_number')) {
      unitLine = extractUnitReply(text, { bareOk: missing.length === 1 && !!awaiting.sent_at });
      if (unitLine) candidates.push('unit_number');
    }
    let bedroomCount = null;
    if (missing.includes('bedroom_count')) {
      // The one-question ask offers "studio, 1, 2, 3 or more" — a bare
      // bounded number IS the natural answer when nothing else was asked.
      // …and only once the prompt was actually DELIVERED: an unsent
      // bedroom draft must not swallow an unrelated "2" from another
      // conversation.
      bedroomCount = extractBedroomReply(text, { bareNumberOk: missing.length === 1 && !!awaiting.sent_at });
      if (bedroomCount !== null) candidates.push('bedroom_count');
    }
    let serviceText = null;
    if (missing.includes('specific_service') && serviceTailFromAddress) {
      // Vocabulary-matched tail — no classifier round needed.
      serviceText = serviceTailFromAddress;
      candidates.push('specific_service');
    } else if (missing.includes('specific_service')) {
      // The classifier is the acceptance bar — length alone would record
      // "thanks, sounds good" as the requested service. The RAW text is
      // stored (label semantics preserved); the classifier only vouches
      // that it actually names a service.
      serviceText = rawCapturedAddress ? text.replace(rawCapturedAddress, ' ') : text;
      serviceText = serviceText.replace(/\s+/g, ' ').replace(/^[\s,\-–—:]+|[\s,\-–—:]+$/g, '').trim();
      if (serviceText.length >= 3 && serviceText.length <= 80) {
        const { classifyServiceIntent } = require('./sms-service-intent');
        // Webhook-safe bound: the classifier's LLM fallback carries no
        // timeout of its own, and this path runs before TwiML returns.
        // Timeout ⇒ fail closed (not a service answer).
        const cls = await Promise.race([
          classifyServiceIntent(serviceText),
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), 3500);
            if (typeof timer.unref === 'function') timer.unref();
          }),
        ]);
        if (cls?.interest) candidates.push('specific_service');
      }
    }
    if (!candidates.length) return { handled: false };

    // LOCKED phase: fresh re-read; CRM field writes and lifecycle
    // bookkeeping commit in one transaction. Recorded items leave the
    // missing set; the ask is consumed (answered_at) only when nothing
    // remains — a partial answer keeps the draft routable for its
    // remainder, and the park-time cooldown exception lets it be re-asked.
    let unitHold = null;
    const locked = await withClarifyLock(digits, async (trx) => {
      const fresh = await trx('message_drafts')
        .where({ id: awaiting.id })
        .whereRaw("(flags->>'answered_at') is null")
        .first();
      if (!fresh) return { recorded: [] };
      let freshFlags = {};
      try {
        freshFlags = typeof fresh.flags === 'string' ? JSON.parse(fresh.flags) : (fresh.flags || {});
      } catch { freshFlags = {}; }
      const freshMissing = Array.isArray(freshFlags.missing) ? freshFlags.missing : [];
      const recorded = candidates.filter((item) => freshMissing.includes(item));
      if (!recorded.length) return { recorded: [] };

      if (recorded.includes('street_address')) {
        if (freshFlags.lead_id) {
          await trx('leads').where({ id: freshFlags.lead_id }).whereNull('deleted_at')
            .update({ address: capturedAddress });
        }
        if (fresh.customer_id) {
          // Fill-only: the clarify ask exists because the QUOTE lacked an
          // address — an existing CRM address (e.g. a member's home while
          // they ask about another property) must never be clobbered by an
          // SMS-captured string; the lead row above still records it for
          // this quote (estimator audit 2026-07-24).
          await trx('customers').where({ id: fresh.customer_id })
            .where((q) => q.whereNull('address_line1').orWhere('address_line1', ''))
            .update({ address_line1: capturedAddress });
        }
      }
      if (recorded.includes('specific_service') && freshFlags.lead_id) {
        await trx('leads').where({ id: freshFlags.lead_id }).whereNull('deleted_at')
          .update({ service_interest: serviceText });
      }
      if (recorded.includes('unit_number')) {
        // The answer lands on the Triage Inbox card (which keeps its human
        // verdict — AGENTS.md: no auto-resolution for missing_unit_number)
        // and, gate ON, in the record; the call's live unsent
        // building-level draft(s) are HELD for the operator here. Nothing
        // re-drafts automatically yet (PR C2b of the #3775 split).
        let cardStamped = false;
        if (freshFlags.unit_call_log_id) {
          const stamped = await trx('triage_items')
            .where({ call_log_id: String(freshFlags.unit_call_log_id), reason_code: 'missing_unit_number' })
            .whereIn('status', ['open', 'in_progress'])
            .update({
              payload: trx.raw("COALESCE(payload, '{}'::jsonb) || jsonb_build_object('customer_reply_unit', ?::text, 'customer_reply_at', ?::text)", [unitLine, new Date().toISOString()]),
              updated_at: new Date(),
            });
          cardStamped = Number(stamped) > 0;
        }
        freshFlags.unit_number_answer = unitLine;
        if (unitWritebackEnabled()) {
          if (!cardStamped) {
            // The card is the human verdict (AGENTS.md: no auto-resolution
            // for missing_unit_number). A sent ask stays routable for days,
            // so a unit texted AFTER staff resolved or dismissed the card
            // — e.g. the whole building IS the service address — must not
            // mutate the record (codex r4 P1 on #3785): the answer is kept
            // on the ask for the audit only.
            freshFlags.unit_writeback = { lead: 'skipped', customer: 'skipped', at: new Date().toISOString(), reason: freshFlags.unit_call_log_id ? 'card_closed' : 'no_card' };
          } else {
            const targets = await unitTargets(trx, freshFlags);
            // HOLD every live-unsent draft for the call at the asked building
            // (the re-price guard the bedroom lane uses, stamped in THIS
            // locked phase so no stale draft can go out first). Looked up —
            // and row-locked — BEFORE the CRM rows below (finalizer and
            // creator lock order, see unsentDraftsForCall); a second pass runs
            // under the call-row lock inside applyUnitWriteback.
            if (freshFlags.unit_call_log_id && freshFlags.unit_ask_building?.street_line_1) {
              unitHold = {
                callLogId: String(freshFlags.unit_call_log_id),
                attempt: require('crypto').randomUUID(),
                unitLine,
                guardedIds: new Set(),
                heldIds: [],
                alreadyCorrectId: null,
                building: freshFlags.unit_ask_building,
              };
              await guardLiveDraftsForCall(trx, unitHold.callLogId, unitHold);
            }
            freshFlags.unit_writeback = await applyUnitWriteback(trx, { unitLine, flags: freshFlags, targets, askDraftId: fresh.id, hold: unitHold });
          }
        }
      }
      // bedroom_count has no row of its own: the resumed SMS-thread draft
      // reads the answer from the thread. The flag keeps the audit.
      if (recorded.includes('bedroom_count')) freshFlags.bedroom_count_answer = bedroomCount;

      // The bedroom re-price targets the unit draft the ASK was parked for
      // (bedroom_estimate_id) — never the generic estimate_id, which a
      // merged later ask may have re-pointed at an unrelated draft.
      const lockedEstimateId = freshFlags.bedroom_estimate_id ? String(freshFlags.bedroom_estimate_id) : null;
      // Estimate-level send guard, stamped in the SAME locked phase that
      // records the answer: the linked draft's dollars are about to be
      // replaced, so admin send / schedule / public accept refuse it
      // until the replacement lands (repricePendingActive — time-boxed so
      // a process restart can never strand a draft).
      let repriceGuarded = false;
      // A reply answering BOTH the unit and the bedroom count re-uses the
      // unit hold's attempt token: the bedroom re-run's supersede target is
      // excluded by id, but the call's other held drafts are excluded by
      // this token — a fresh one would make them duplicate_call_draft and
      // the corrected unit-and-bedroom replacement would never insert
      // (codex r4 P2 on #3804).
      // …but ONLY when the bedroom draft belongs to the unit hold's call: a
      // phone-scoped merge can pair call A's unit question with call B's
      // bedroom draft, and A's token on B's re-run would let B's
      // replacement pass A's held rows (codex r14 P2 on #3804).
      let repriceAttempt = null;
      if (recorded.includes('bedroom_count') && lockedEstimateId) {
        const sameCall = !!unitHold?.attempt && await estimateComposedFromCall(trx, lockedEstimateId, unitHold.callLogId);
        repriceAttempt = sameCall ? unitHold.attempt : require('crypto').randomUUID();
      }
      if (repriceAttempt) {
        repriceGuarded = await setEstimateRepricePending(trx, lockedEstimateId, new Date().toISOString(), repriceAttempt);
      }
      const remaining = freshMissing.filter((item) => !recorded.includes(item));
      const answeredFlagsObj = {
        ...freshFlags,
        missing: remaining,
        answer_recorded: [...(Array.isArray(freshFlags.answer_recorded) ? freshFlags.answer_recorded : []), ...recorded],
        ...(remaining.length ? {} : { answered_at: new Date().toISOString() }),
      };
      const answeredFlags = JSON.stringify(answeredFlagsObj);
      // Stamp-only writes on a CLAIMED-unsent row shrink missing without
      // touching the copy — copy_stale marks that mismatch so the dispatch
      // decision recomposes (and the pre-dispatch check aborts) instead of
      // sending the old multi-question text.
      const stampOnlyFlags = JSON.stringify({ ...answeredFlagsObj, copy_stale: true });
      if (!fresh.sent_at && fresh.status === 'pending') {
        // Answered before approval: rewrite the pending copy to the
        // remainder or retire it outright (status-guarded — a claim wins).
        const applied = await trx('message_drafts')
          .where({ id: fresh.id, status: 'pending' })
          .update(remaining.length
            ? { draft_response: composeClarifyBody({ missing: remaining, firstName: null, unitAskBuilding: freshFlags.unit_ask_building || null }), flags: answeredFlags }
            : { status: 'rejected', flags: answeredFlags });
        if (!applied) {
          // The UNLOCKED admin claim flipped pending→approved after our
          // read — the answer must not be silently lost. Stamp the flags
          // against the now-claimed row (status untouched); the dispatch
          // decision runs under this same lock afterward and honors them.
          await trx('message_drafts').where({ id: fresh.id }).update({ flags: stampOnlyFlags });
        }
      } else if (!fresh.sent_at) {
        // Claimed-unsent: copy untouched by design, so mark it stale.
        await trx('message_drafts').where({ id: fresh.id }).update({ flags: stampOnlyFlags });
      } else {
        await trx('message_drafts').where({ id: fresh.id }).update({ flags: answeredFlags });
      }
      // The LOCKED row's linkage is authoritative — a concurrent
      // mergePendingClarify may have re-pointed estimate_id since the
      // unlocked read above.
      return {
        recorded, estimateId: lockedEstimateId, repriceGuarded, repriceAttempt,
        callOrigin: freshFlags.call_origin === true,
        unitHold,
        unitWriteback: freshFlags.unit_writeback || null,
      };
    });
    if (!locked.recorded.length) return { handled: false };
    const recorded = locked.recorded;
    // A property row this reply CREATED is enriched exactly like a
    // call-pipeline insert — after commit, fire-and-forget (codex r4 P2 on
    // #3785): the recovery sweep only covers source 'call_pipeline', so
    // without this the row would never gain coordinates or a type.
    const createdPropertyIds = [
      locked.unitWriteback?.propertyCreated ? locked.unitWriteback.propertyId : null,
      locked.unitWriteback?.primaryEnsuredId || null,
    ].filter(Boolean);
    for (const propertyId of createdPropertyIds) {
      try {
        require('./call-property-lookup').enqueueCallPropertyLookup({ propertyId });
      } catch (enqErr) {
        logger.warn(`[estimate-clarify] property lookup enqueue failed: ${enqErr.message}`);
      }
    }

    // Held building-level draft(s) (gate ON): the guard is already on
    // each row from the locked phase; pull scheduled ones off the cron so
    // none can auto-send, record the hold on the ask, and give the
    // operator ONE bell naming the newest. A draft that already carries
    // the unit needs nothing. Exception-based (CLAUDE.md rule 14).
    if (locked.unitHold?.heldIds?.length) {
      const held = locked.unitHold.heldIds;
      await withClarifyLock(digits, async (trx) => {
        for (const id of held) await unscheduleForOperatorReprice(trx, id, locked.unitHold.attempt);
      }).catch((err) => logger.warn(`[estimate-clarify] unschedule (held drafts) failed: ${err.message}`));
      await stampClarifyFlags(digits, awaiting.id, {
        unit_hold: { estimate_id: held[0], estimate_ids: held, unit: unitLine, at: new Date().toISOString() },
      });
      logger.warn('[estimate-clarify] unit answer recorded — the call\'s building-level draft(s) are held for the operator', { draftId: awaiting.id, held });
      try {
        await require('./notification-service').notifyAdmin(
          'lead',
          'Unit number received — re-draft the estimate',
          `The customer texted their unit (${unitLine}). ${held.length === 1 ? 'The unsent estimate for this call' : `${held.length} unsent estimates for this call`} still describe${held.length === 1 ? 's' : ''} the whole building and ${held.length === 1 ? 'is' : 'are'} held — re-draft before sending.`,
          // The Estimates page's deep-link form (EstimatesPageV2 reads
          // ?estimateId=; /admin/estimates/<id> is not a mounted route —
          // codex r8 P2 on #3804).
          { link: `/admin/estimates?estimateId=${encodeURIComponent(held[0])}`, metadata: { estimate_clarify: true, reprice_pending: true, draftId: awaiting.id, estimateId: held[0], estimateIds: held, unit: unitLine } },
        );
      } catch (bellErr) {
        logger.warn(`[estimate-clarify] held-draft bell failed (guard stands): ${bellErr.message}`);
      }
    } else if (locked.unitHold?.alreadyCorrectId) {
      await stampClarifyFlags(digits, awaiting.id, { unit_draft_already_correct: locked.unitHold.alreadyCorrectId });
    }

    // A bedroom answer that must RE-PRICE a linked draft is durable state
    // on the ask row until a replacement is confirmed created: the
    // re-draft paths report failure by returning { created: false }
    // (red/blocked/skip), not by throwing, and the answer is already
    // recorded above — without this stamp a failed re-draft would leave
    // the fallback-priced draft standing with nothing pointing at it.
    const repriceTarget = recorded.includes('bedroom_count') && locked.estimateId
      ? locked.estimateId
      : null;
    if (repriceTarget) {
      await stampClarifyFlags(digits, awaiting.id, {
        reprice_pending: { estimate_id: repriceTarget, bedroom_count: bedroomCount, at: new Date().toISOString() },
      });
    }

    // The re-draft runs DETACHED: this handler sits on the Twilio inbound
    // webhook, and a voice re-run does property gathering plus a full
    // composition — awaiting it would hold the response open past
    // Twilio's timeout (the SMS path detaches for the same reason). The
    // answer and the reprice_pending stamp are already durable above.
    const repricePromise = (async () => {
      let repriceOutcome = null;
      // FAIL CLOSED when the guard could not be stamped (the draft already
      // sent / archived / invalidated / moved on): no re-draft — the bell
      // below hands it to the operator with the answer on the ask row.
      const guardMissing = !!repriceTarget && !locked.repriceGuarded;
      try {
        if (guardMissing) throw Object.assign(new Error('linked draft is no longer an unsent draft — bedroom re-price handed to the operator'), { expected: true });
        const { smsThreadDraftsEnabled, startSmsThreadDraft } = require('./estimator-engine/sms-thread');
        // A bedroom answer re-prices the draft it was asked FOR: the
        // fallback-priced yellow draft linked on the ask is superseded by
        // a re-draft (retired atomically with the replacement insert — a
        // red/skip outcome leaves it standing). A VOICE-origin draft re-runs
        // from its original call (the quote evidence — enriched extraction
        // + transcript — lives there; the SMS thread holds only the
        // question and the answer, so its composer would skip); an
        // SMS-origin draft re-drafts from the thread. Address/service
        // answers have no linked draft (red-path asks) and resume as before.
        const supersedeEstimateId = repriceTarget;
        const voiceCallLogId = supersedeEstimateId ? await voiceOriginCallLogId(supersedeEstimateId) : null;
        if (!supersedeEstimateId && locked.callOrigin) {
          // A completed-call ask: the answer is recorded, stamped on the
          // triage card, written to the record and — gate ON — the call's
          // building-level draft(s) are held with the operator belled
          // above; nothing re-drafts automatically (PR C2b of the #3775
          // split — the fence stamped in the locked phase is what a later
          // composer adopts).
          logger.info('[estimate-clarify] call-origin answer recorded — no automatic re-draft', { draftId: awaiting.id });
        } else if (voiceCallLogId) {
          const { estimatorEngineEnabled, maybeDraftEstimateForCall } = require('./estimator-engine');
          if (estimatorEngineEnabled()) {
            repriceOutcome = await maybeDraftEstimateForCall({
              callLogId: voiceCallLogId,
              quotePromised: true,
              supersedeEstimateId,
              supersedeReason: 'clarify_bedroom_reply',
              supersedeAttempt: locked.repriceAttempt,
              bedroomCountOverride: bedroomCount,
            });
          } else {
            logger.warn('[estimate-clarify] bedroom answer recorded but the estimator engine is gated off — the linked draft keeps its fallback price; re-price it from admin/estimates', { draftId: awaiting.id, estimateId: supersedeEstimateId });
          }
        } else if (smsThreadDraftsEnabled()) {
          const started = await startSmsThreadDraft({
            phone,
            triggerBody: body,
            skipIntentGate: true,
            skipCooldown: true,
            ...(supersedeEstimateId
              ? { supersedeEstimateId, supersedeReason: 'clarify_bedroom_reply', supersedeAttempt: locked.repriceAttempt, bedroomCountOverride: bedroomCount }
              : {}),
          });
          // The thread draft is itself detached — wait for its outcome only
          // when a re-price depends on it.
          repriceOutcome = supersedeEstimateId && started?.draftPromise ? await started.draftPromise : started;
        } else if (supersedeEstimateId) {
          logger.warn('[estimate-clarify] bedroom answer recorded but SMS-thread drafts are gated off — the linked draft keeps its fallback price; re-price it from admin/estimates', { draftId: awaiting.id, estimateId: supersedeEstimateId });
        }
      } catch (resumeErr) {
        if (resumeErr.expected) logger.info(`[estimate-clarify] ${resumeErr.message}`);
        else logger.warn(`[estimate-clarify] resume failed (answer recorded): ${resumeErr.message}`);
      }
      if (!repriceTarget) return repriceOutcome;
      if (repriceOutcome?.created === true) {
        // The superseded draft is archived by the replacement insert; its
        // guard is moot. The ask row records the outcome.
        await stampClarifyFlags(digits, awaiting.id, {
          reprice_pending: null,
          repriced_at: new Date().toISOString(),
          repriced_estimate_id: repriceOutcome.estimateId || null,
        });
      } else {
        // No replacement: the draft's dollars are KNOWN stale, so the send
        // guard STAYS (only the operator's explicit re-price clears it);
        // a scheduled row is pulled off the cron so it cannot auto-send.
        await withClarifyLock(digits, (trx) => unscheduleForOperatorReprice(trx, repriceTarget, locked.repriceAttempt))
          .catch((err) => logger.warn(`[estimate-clarify] unschedule for operator re-price failed: ${err.message}`));
        // Exception-based (CLAUDE.md rule 14): the pending stamp stays on
        // the ask row and the operator gets the one bell that names the
        // draft to re-price — the customer's answer is never lost silently.
        logger.warn('[estimate-clarify] bedroom answer recorded but the draft could not be re-priced automatically', {
          draftId: awaiting.id, estimateId: repriceTarget, outcome: repriceOutcome?.lane || repriceOutcome?.skipped || repriceOutcome?.reasons || 'no_outcome',
        });
        try {
          await require('./notification-service').notifyAdmin(
            'lead',
            'Bedroom count received — re-price the unit draft',
            `The customer answered the bedroom question (${bedroomCount === 0 ? 'studio' : `${bedroomCount} bedroom${bedroomCount === 1 ? '' : 's'}`}) but the automated re-draft did not produce a replacement. The draft still carries its fallback price — re-price it before sending.`,
            {
              link: `/admin/estimates/${repriceTarget}`,
              metadata: { estimate_clarify: true, reprice_pending: true, draftId: awaiting.id, estimateId: repriceTarget, bedroomCount },
            },
          );
        } catch (bellErr) {
          logger.warn(`[estimate-clarify] reprice-pending bell failed (stamp stands): ${bellErr.message}`);
        }
      }
      return repriceOutcome;
    })();
    repricePromise.catch((err) => logger.warn(`[estimate-clarify] detached re-draft failed: ${err.message}`));

    logger.info('[estimate-clarify] clarify reply recorded', { draftId: awaiting.id, recorded });
    // repricePromise is exposed for callers/tests that must observe the
    // detached outcome; the webhook never awaits it.
    return { handled: true, repricePromise };
  } catch (err) {
    logger.warn(`[estimate-clarify] reply handling failed: ${err.message}`);
    return { handled: false };
  }
}

/**
 * Bookkeeping-only stamp for flows that consume replies THEMSELVES (the
 * lead-intake state machine): when such a flow captures an item a sent
 * clarify asked for, the draft's lifecycle must reflect it — otherwise the
 * seven-day cooldown suppresses a later independent ask even though the
 * customer answered. Records nothing new on leads/customers and never
 * resumes anything; fail-soft.
 */
async function recordClarifyAnswer({ phone, items = [] }) {
  try {
    if (!clarifyAsksEnabled() || !items.length) return { recorded: false };
    const allDigits = String(phone || '').replace(/\D/g, '');
    const digits = allDigits.length === 10
      ? allDigits
      : (allDigits.length === 11 && allDigits.startsWith('1') ? allDigits.slice(1) : null);
    if (!digits) return { recorded: false };
    // Read + stamp under the clarify lock — same lost-update protection as
    // every other flags writer. PENDING asks resolve too: a customer who
    // volunteers the answer before the owner approves must not later be
    // texted the question they already answered.
    return await withClarifyLock(digits, async (trx) => {
      const awaiting = await trx('message_drafts')
        .where({ intent: 'estimate_clarify', source_ref: `clarify:${digits}` })
        .whereRaw("(flags->>'answered_at') is null")
        .where(function pendingOrRecentlySent() {
          this.where(function pendingOpen() {
            this.where('status', 'pending').whereNull('sent_at');
          }).orWhere(function claimedUnsent() {
            // Mid-approval rows count too — same contract as
            // handleClarifyReply: the stamp-only branch below records the
            // answer without touching the claimed row's copy or status, and
            // the dispatch decision's locked re-read honors it.
            this.whereIn('status', ['approved', 'revised']).whereNull('sent_at');
          }).orWhere(function sentRecent() {
            this.whereNotNull('sent_at')
              .where('sent_at', '>=', new Date(Date.now() - RECENT_SENT_WINDOW_MS));
          });
        })
        .orderByRaw('(sent_at is not null) asc, sent_at desc')
        .first();
      if (!awaiting) return { recorded: false };
      let flags = {};
      try {
        flags = typeof awaiting.flags === 'string' ? JSON.parse(awaiting.flags) : (awaiting.flags || {});
      } catch { flags = {}; }
      const missing = Array.isArray(flags.missing) ? flags.missing : [];
      const recorded = missing.filter((item) => items.includes(item));
      if (!recorded.length) return { recorded: false };
      const remaining = missing.filter((item) => !recorded.includes(item));
      const answeredFlagsObj = {
        ...flags,
        missing: remaining,
        answer_recorded: [...(Array.isArray(flags.answer_recorded) ? flags.answer_recorded : []), ...recorded],
        ...(remaining.length ? {} : { answered_at: new Date().toISOString() }),
      };
      const answeredFlags = JSON.stringify(answeredFlagsObj);
      // Same copy_stale contract as handleClarifyReply: a stamp-only write
      // on a claimed-unsent row leaves the copy behind the missing set.
      const stampOnlyFlags = JSON.stringify({ ...answeredFlagsObj, copy_stale: true });
      if (!awaiting.sent_at && awaiting.status === 'pending') {
        // Answered before approval: rewrite the pending copy down to the
        // remainder, or retire it outright when nothing remains. Guarded on
        // status — a claim landing before the lock wins.
        const applied = await trx('message_drafts')
          .where({ id: awaiting.id, status: 'pending' })
          .update(remaining.length
            ? { draft_response: composeClarifyBody({ missing: remaining, firstName: null, unitAskBuilding: flags.unit_ask_building || null }), flags: answeredFlags }
            : { status: 'rejected', flags: answeredFlags });
        if (!applied) {
          // The UNLOCKED admin claim won the race after our read — fall
          // back to stamp-only so the answer reaches the claimed row and
          // the dispatch decision (under this same lock) honors it.
          await trx('message_drafts').where({ id: awaiting.id }).update({ flags: stampOnlyFlags });
        }
      } else if (!awaiting.sent_at) {
        // Claimed-unsent: copy untouched by design, so mark it stale.
        await trx('message_drafts').where({ id: awaiting.id }).update({ flags: stampOnlyFlags });
      } else {
        await trx('message_drafts').where({ id: awaiting.id }).update({ flags: answeredFlags });
      }
      return { recorded: true, items: recorded };
    });
  } catch (err) {
    logger.warn(`[estimate-clarify] answer bookkeeping failed: ${err.message}`);
    return { recorded: false };
  }
}

function digitsFromClarifyRef(sourceRef) {
  const match = /^clarify:(\d{10})$/.exec(String(sourceRef || ''));
  return match ? match[1] : null;
}

// Statuses the staleness recheck retires with — kept byte-identical to the
// pre-lock guard so operator-facing 409 copy doesn't churn.
const CLOSED_LEAD_STATUSES = new Set(['won', 'lost', 'disqualified', 'duplicate', 'unresponsive']);

/**
 * The dispatch decision for a CLAIMED clarify draft (admin approve/revise
 * already flipped status to 'approved'/'revised'), made ATOMICALLY under the
 * same per-phone clarify lock every reply/park writer holds. Inside one
 * locked transaction: fresh re-read of the draft, CRM staleness checks,
 * partial-answer rewrite, and a claimed-status-conditional write that
 * atomically verifies the claim still stands. Serializing the DECISION (not
 * the Twilio HTTP call) closes the claim→dispatch race: a reply landing
 * before the lock commits is seen by the fresh re-read and rewrites/retires
 * the question; a reply landing after is stamp-only bookkeeping against the
 * claimed row (handleClarifyReply's claimed-unsent branch) — either way no
 * already-answered question dispatches. The only residue is an SMS
 * physically crossing a reply on the carrier network, which no server-side
 * ordering can remove.
 *
 * sent_at is PROVIDER-CONFIRMED state and is deliberately NOT written here —
 * only finalizeDraftSend stamps it, after a real send. A process crash
 * between this decision and the provider call therefore leaves an ordinary
 * claimed row (never a falsely-sent one): the open-slot unique index still
 * holds the phone's slot, the 7-day cooldown never keys on a send that
 * didn't happen, and recovery is the same stuck-claim surface every other
 * draft lane has.
 *
 * Outcomes: {outcome:'send', body, flags} (decision committed — the caller
 * dispatches this body, and failures reconcile via
 * reopenClarifyAfterFailedSend); {outcome:'retired', message} (stale — where
 * the staleness is OURS the status moved to rejected here; a concurrent
 * reject's verdict is respected without a write); {outcome:'rewritten'}
 * (isRevision only — copy rewritten to the remainder AND the claim released
 * to pending in the same conditional write, releaseFields applied);
 * {outcome:'error'} (transient — fail closed, nothing written).
 */
async function claimClarifyDispatch({ draft, isRevision = false, releaseFields = {} }) {
  const digits = digitsFromClarifyRef(draft && draft.source_ref);
  if (!digits) return { outcome: 'error' };
  try {
    return await withClarifyLock(digits, async (trx) => {
      const fresh = await trx('message_drafts').where({ id: draft.id }).first();
      if (!fresh) {
        return { outcome: 'retired', message: 'Clarify draft retired — it no longer exists.' };
      }
      let flags = {};
      try {
        flags = typeof fresh.flags === 'string' ? JSON.parse(fresh.flags) : (fresh.flags || {});
      } catch { flags = {}; }
      const missing = Array.isArray(flags.missing) ? flags.missing : [];
      const retire = async (message) => {
        await trx('message_drafts').where({ id: fresh.id }).update({ status: 'rejected' });
        return { outcome: 'retired', message };
      };
      // The admin reject route moves status WITHOUT the clarify lock — if it
      // won the race, respect its verdict: no status write, no stamp.
      if (!['approved', 'revised'].includes(fresh.status)) {
        return { outcome: 'retired', message: 'Clarify draft is no longer claimed — another action already resolved it.' };
      }
      // Already provider-confirmed sent (unreachable via the pending-only
      // claim, defensive) — never dispatch twice, and never relabel a
      // delivered ask as rejected.
      if (fresh.sent_at) {
        return { outcome: 'retired', message: 'Clarify draft already dispatched.' };
      }
      // A consumed ask (every item answered while the claim was in flight)
      // must never send.
      if (flags.answered_at || !missing.length) {
        return retire('Clarify draft retired — the customer already provided the missing details.');
      }
      // Sequential CRM reads — one trx = one connection, no Promise.all.
      const lead = flags.lead_id
        ? await trx('leads').where({ id: flags.lead_id }).whereNull('deleted_at').first()
        : null;
      const customer = fresh.customer_id
        ? await trx('customers').where({ id: fresh.customer_id }).whereNull('deleted_at').first()
        : null;
      const estimate = flags.estimate_id
        ? await trx('estimates').where({ id: flags.estimate_id }).first()
        : null;
      if (flags.lead_id && !lead) {
        return retire('Clarify draft retired — the linked lead no longer exists.');
      }
      if (fresh.customer_id && !customer) {
        return retire('Clarify draft retired — the linked customer no longer exists.');
      }
      if (lead && CLOSED_LEAD_STATUSES.has(String(lead.status || ''))) {
        return retire('Clarify draft retired — the linked lead is closed.');
      }
      if (flags.estimate_id && !estimate) {
        return retire('Clarify draft retired — the linked estimate no longer exists.');
      }
      if (estimate && (estimate.sent_at || estimate.status !== 'draft')) {
        return retire('Clarify draft retired — the linked estimate already moved past draft.');
      }
      // Answer-arrived recheck against CRM state. The linked draft
      // estimate's address counts — operators resolve missing addresses
      // directly on the estimate row. ONLY the lead row answers a service
      // ask: customers.lead_service_interest is leftover intake state.
      const hasAddressNow = [lead?.address, customer?.address_line1, estimate?.address]
        .some((value) => value && /\d/.test(String(value)));
      const { hasConcreteServiceInterest } = require('./lead-estimate-automation');
      const hasServiceNow = hasConcreteServiceInterest(lead?.service_interest);
      // The unit ask's ONLY staleness evidence is its Triage Inbox card: the
      // card is the authoritative human verdict on whether the unit is
      // still owed (AGENTS.md), and staff resolving/dismissing it — unit
      // collected by phone, or the whole building is the customer — retires
      // the ask. CRM address fields are deliberately not read: this lane
      // does not write them, and judging them needs the building matcher
      // the write-back lane owns.
      const unitCardClosed = missing.includes('unit_number') && flags.unit_call_log_id
        ? !(await trx('triage_items')
          .where({ call_log_id: String(flags.unit_call_log_id), reason_code: 'missing_unit_number' })
          .whereIn('status', ['open', 'in_progress'])
          .first('id'))
        : false;
      // Gate ON: a unit already on file AT THE ASKED BUILDING (entered by
      // the office, or a prior write-back) also answers the ask.
      const unitOnFile = missing.includes('unit_number') && !unitCardClosed && unitWritebackEnabled()
        ? await unitOnFileAtBuilding(trx, flags)
        : false;
      const stillMissing = missing.filter((item) => (item === 'street_address' && !hasAddressNow)
        || (item === 'specific_service' && !hasServiceNow)
        || (item === 'unit_number' && !unitCardClosed && !unitOnFile)
        // No row carries a bedroom count — only the reply handler can
        // retire it (it drops the item from `missing` when answered).
        || item === 'bedroom_count');
      if (!stillMissing.length) {
        return retire('Clarify draft retired — the customer already provided the missing details.');
      }
      if (stillMissing.length < missing.length || flags.copy_stale === true) {
        // Partial answer: never re-ask what the contact already supplied —
        // rewrite the copy down to what's STILL missing. copy_stale forces
        // this branch even when the missing set already matches: a
        // stamp-only writer shrank missing on the claimed row WITHOUT
        // touching the copy, so the stored text still asks the old
        // multi-question form.
        const rewritten = composeClarifyBody({
          missing: stillMissing,
          firstName: lead?.first_name || customer?.first_name || null,
          unitAskBuilding: flags.unit_ask_building || null,
        });
        const { copy_stale: _resolved, ...restFlags } = flags;
        const rewrittenFlags = { ...restFlags, missing: stillMissing };
        // Conditional writes: the unlocked reject route can still move the
        // row between our read and this statement — READ COMMITTED re-checks
        // the WHERE against the winner's row, so zero rows updated means the
        // claim is gone and nothing may dispatch.
        if (isRevision) {
          // The owner's revision was typed against the stale multi-question
          // copy — rewrite the stored draft, bounce the send, and release
          // the claim IN THIS SAME conditional write (releaseFields clears
          // the stale revision): a separate unconditional release outside
          // the lock could resurrect a concurrently rejected draft. The
          // queue now shows the single remaining question.
          const rewrote = await trx('message_drafts')
            .where({ id: fresh.id }).whereIn('status', ['approved', 'revised'])
            .update({
              draft_response: rewritten,
              flags: JSON.stringify(rewrittenFlags),
              status: 'pending',
              approved_by: null,
              approved_at: null,
              ...releaseFields,
            });
          if (!rewrote) {
            return { outcome: 'retired', message: 'Clarify draft is no longer claimed — another action already resolved it.' };
          }
          return { outcome: 'rewritten' };
        }
        const applied = await trx('message_drafts')
          .where({ id: fresh.id }).whereIn('status', ['approved', 'revised'])
          .update({
            draft_response: rewritten,
            flags: JSON.stringify(rewrittenFlags),
          });
        if (!applied) {
          return { outcome: 'retired', message: 'Clarify draft is no longer claimed — another action already resolved it.' };
        }
        return { outcome: 'send', body: rewritten, flags: rewrittenFlags };
      }
      // Sendable as-is. The approved_at refresh is not data anyone reads —
      // it is the conditional write that atomically re-verifies the claim
      // (zero rows = a reject won after our read; nothing may dispatch).
      const applied = await trx('message_drafts')
        .where({ id: fresh.id }).whereIn('status', ['approved', 'revised'])
        .update({ approved_at: new Date() });
      if (!applied) {
        return { outcome: 'retired', message: 'Clarify draft is no longer claimed — another action already resolved it.' };
      }
      return {
        outcome: 'send',
        body: isRevision ? (fresh.final_response || fresh.draft_response) : fresh.draft_response,
        flags,
      };
    });
  } catch (err) {
    logger.warn(`[estimate-clarify] dispatch decision failed: ${err.message}`);
    return { outcome: 'error' };
  }
}

/**
 * Final abort point for a committed clarify dispatch, built for
 * sendCustomerMessage's preDispatchCheck hook — the LAST await before the
 * provider handoff. Under the clarify lock: verify the claim still stands
 * and the asked items are still the ones the outbound copy asks for; any
 * answer recorded while the send pipeline's own validators ran (or a
 * concurrent reject) aborts the send, and the route's failed-send
 * reconciliation then rewrites/retires the draft. Fail closed on error —
 * an unverifiable ask must not go out.
 */
function clarifyPreDispatchCheck({ draftId, sourceRef, dispatchedMissing }) {
  return async () => {
    const digits = digitsFromClarifyRef(sourceRef);
    if (!digits) {
      return { ok: false, code: 'CLARIFY_SUPERSEDED', reason: 'unparseable clarify source_ref' };
    }
    try {
      return await withClarifyLock(digits, async (trx) => {
        const fresh = await trx('message_drafts').where({ id: draftId }).first();
        if (!fresh) {
          return { ok: false, code: 'CLARIFY_SUPERSEDED', reason: 'clarify draft no longer exists' };
        }
        if (!['approved', 'revised'].includes(fresh.status)) {
          return { ok: false, code: 'CLARIFY_SUPERSEDED', reason: 'clarify draft is no longer claimed' };
        }
        let flags = {};
        try {
          flags = typeof fresh.flags === 'string' ? JSON.parse(fresh.flags) : (fresh.flags || {});
        } catch { flags = {}; }
        const missing = Array.isArray(flags.missing) ? flags.missing : [];
        if (flags.answered_at || !missing.length) {
          return { ok: false, code: 'CLARIFY_SUPERSEDED', reason: 'customer answered while the send was validating' };
        }
        const changed = flags.copy_stale === true
          || (Array.isArray(dispatchedMissing)
            && (dispatchedMissing.length !== missing.length
              || missing.some((item) => !dispatchedMissing.includes(item))));
        if (changed) {
          return { ok: false, code: 'CLARIFY_SUPERSEDED', reason: 'customer answered part of this while the send was validating' };
        }
        // The unit card closes under the CALL-scoped triage lock, not this
        // phone-scoped one, so re-read it at the last await before the
        // provider handoff: a card staff resolved/dismissed while the
        // validators ran must not let the obsolete question out (codex
        // post-trim P2).
        if (missing.includes('unit_number') && flags.unit_call_log_id) {
          const cardOpen = await trx('triage_items')
            .where({ call_log_id: String(flags.unit_call_log_id), reason_code: 'missing_unit_number' })
            .whereIn('status', ['open', 'in_progress'])
            .first('id');
          if (!cardOpen) {
            return { ok: false, code: 'CLARIFY_SUPERSEDED', reason: 'the unit-number card was closed while the send was validating' };
          }
          // Gate ON: staff may have entered the unit while the validators
          // ran — same evidence the claim used, re-read here (codex r2 P2).
          if (unitWritebackEnabled() && await unitOnFileAtBuilding(trx, flags)) {
            return { ok: false, code: 'CLARIFY_SUPERSEDED', reason: 'the unit was recorded while the send was validating' };
          }
        }
        return { ok: true };
      });
    } catch (err) {
      return { ok: false, code: 'CLARIFY_RECHECK_FAILED', reason: err.message };
    }
  };
}

/**
 * Reconcile a clarify draft whose provider send FAILED after
 * claimClarifyDispatch committed the decision. Under the clarify lock: a
 * concurrent reject's status is respected (never resurrected to pending);
 * an ask consumed meanwhile (a reply's stamp-only bookkeeping) retires; a
 * rival open clarify for the phone retires ours — reopening would violate
 * the one-open-per-phone unique index; otherwise reopen to pending.
 * sent_at is cleared on every path as pure defense — the decision no longer
 * writes it, so it should already be null here. dispatchedMissing is the
 * missing set the outbound copy asked for: if a reply shrank the set during
 * the send window, the reopened copy is recomposed to match.
 */
async function reopenClarifyAfterFailedSend({ draftId, dispatchedMissing = null, releaseFields = {} }) {
  try {
    const row = await db('message_drafts').where({ id: draftId }).first();
    const digits = digitsFromClarifyRef(row && row.source_ref);
    if (!row || !digits) return { reopened: false, retired: false };
    return await withClarifyLock(digits, async (trx) => {
      const fresh = await trx('message_drafts').where({ id: draftId }).first();
      if (!fresh) return { reopened: false, retired: false };
      let flags = {};
      try {
        flags = typeof fresh.flags === 'string' ? JSON.parse(fresh.flags) : (fresh.flags || {});
      } catch { flags = {}; }
      const missing = Array.isArray(flags.missing) ? flags.missing : [];
      // A concurrent reject (unlocked route) already resolved the draft —
      // respect its status, but the false stamp must still go: the 7-day
      // cooldown would otherwise key on a send that never happened.
      if (!['approved', 'revised'].includes(fresh.status)) {
        await trx('message_drafts').where({ id: fresh.id })
          .update({ sent_at: null, ...releaseFields });
        return { reopened: false, retired: true };
      }
      if (flags.answered_at || !missing.length) {
        await trx('message_drafts').where({ id: fresh.id })
          .update({ status: 'rejected', sent_at: null, ...releaseFields });
        return { reopened: false, retired: true };
      }
      const rival = await trx('message_drafts')
        .where({ intent: 'estimate_clarify', source_ref: fresh.source_ref })
        .whereNot('id', fresh.id)
        .whereIn('status', ['pending', 'approved', 'revised'])
        .whereNull('sent_at')
        .first();
      if (rival) {
        await trx('message_drafts').where({ id: fresh.id })
          .update({ status: 'rejected', sent_at: null, ...releaseFields });
        return { reopened: false, retired: true };
      }
      const missingChanged = flags.copy_stale === true
        || (Array.isArray(dispatchedMissing)
          && (dispatchedMissing.length !== missing.length
            || missing.some((item) => !dispatchedMissing.includes(item))));
      const { copy_stale: _resolved, ...restFlags } = flags;
      // Conditional on the claim still standing — a reject interleaving
      // after the fresh read must not be resurrected to pending.
      const reopened = await trx('message_drafts')
        .where({ id: fresh.id }).whereIn('status', ['approved', 'revised'])
        .update({
          status: 'pending',
          approved_by: null,
          approved_at: null,
          sent_at: null,
          // Recompose only when a reply shrank the ask mid-flight (or a
          // stamp-only write left the copy behind the missing set) —
          // otherwise the parked copy (with its greeting) is still exactly
          // right. The recompose clears copy_stale: copy and flags match
          // again.
          ...(missingChanged
            ? {
              draft_response: composeClarifyBody({ missing, firstName: null, unitAskBuilding: flags.unit_ask_building || null }),
              flags: JSON.stringify({ ...restFlags, missing }),
            }
            : {}),
          ...releaseFields,
        });
      if (!reopened) {
        await trx('message_drafts').where({ id: fresh.id })
          .update({ sent_at: null, ...releaseFields });
        return { reopened: false, retired: true };
      }
      return { reopened: true, retired: false };
    });
  } catch (err) {
    logger.warn(`[estimate-clarify] failed-send reconciliation failed: ${err.message}`);
    return { reopened: false, retired: false };
  }
}

module.exports = {
  clarifyAsksEnabled,
  parkClarifyAsk,
  handleClarifyReply,
  recordClarifyAnswer,
  claimClarifyDispatch,
  clarifyPreDispatchCheck,
  reopenClarifyAfterFailedSend,
  repricePendingActive,
  _private: { composeClarifyBody, extractAddressReply, extractBedroomReply, extractUnitReply, applyUnitWriteback, unitOnFileAtBuilding, ASKABLE_MISSING, RECENT_SENT_WINDOW_MS },
};
