/**
 * Estimator Engine — call context assembly.
 *
 * Gathers everything the composer + arbitration need for one call: the raw
 * transcript, the enriched extraction (NEVER the v1 extraction alone — v1
 * invalid-JSON failures are a known live failure mode while the enriched
 * pass parses fine), the caller's SMS thread, any matching lead/customer
 * profile, and their prior estimates. Every sub-load is fail-open: a missing
 * signal narrows the draft (or drops it to yellow/red) — it never throws out
 * of the engine.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { firstExternalPhone, last10 } = require('../external-phone');

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// Enriched extraction first (schema-versioned, validated); the raw v1 text
// blob only as a fallback parse. Either may be null — the composer always
// gets the raw transcript regardless. The processor persists schema_failed
// V2 payloads in ai_extraction_enriched for AUDIT — only status 'valid' may
// drive behavior (same contract as the processor's canonical-write rule).
function extractionFromCall(call) {
  if (call.v2_extraction_status === 'valid') {
    const enriched = parseMaybeJson(call.ai_extraction_enriched);
    if (enriched && typeof enriched === 'object' && enriched.property) {
      return { extraction: enriched, source: 'enriched' };
    }
  }
  const v1 = parseMaybeJson(call.ai_extraction);
  if (v1 && typeof v1 === 'object') return { extraction: v1, source: 'v1' };
  return { extraction: null, source: 'none' };
}

// Shared lines are real (property managers, family numbers): when several
// customer rows match the last-10, prefer the one whose name matches the
// caller established on the call, and mark the match ambiguous otherwise so
// the lane classifier forces a review instead of silently quoting the wrong
// profile's address.
function pickCustomerMatch(rows, extraction) {
  if (!rows.length) return { customer: null, ambiguous: false };
  if (rows.length === 1) return { customer: rows[0], ambiguous: false };
  const callerLast = String(extraction?.caller?.last_name || '').trim().toLowerCase();
  const callerFirst = String(extraction?.caller?.first_name || '').trim().toLowerCase();
  // FULL-name agreement: the last name must match, and when both sides carry
  // a first name it must match too — a same-first-name-different-last-name
  // row on a shared line is a different person, not a confident match.
  // MULTIPLE rows matching the same full name (one customer, several
  // properties) are still ambiguous — picking the newest would green-draft
  // the wrong property.
  const byName = rows.filter((r) => {
    const last = String(r.last_name || '').trim().toLowerCase();
    const first = String(r.first_name || '').trim().toLowerCase();
    if (!callerLast || last !== callerLast) return false;
    return !callerFirst || !first || first === callerFirst;
  });
  if (byName.length === 1) return { customer: byName[0], ambiguous: false };
  return { customer: byName[0] || rows[0], ambiguous: true };
}

// How fresh a row must be to count as the Twilio webhook's first-contact
// shell. The webhook inserts it seconds before the estimator runs in the
// same request; the generous window only has to survive queue/retry delay,
// while staying far short of any real lead's age.
const WEBHOOK_SHELL_MAX_AGE_MS = 15 * 60 * 1000;

// opts (both consumed by the scope-guards triage; composer callers omit
// them and keep today's behavior exactly):
//  - timeoutMs: knex cancel-timeout so the triage deadline bounds the WORK.
//  - includeServiceContacts: also match the configured service-contact
//    phone slots — a spouse/tenant/manager texting from
//    service_contact*_phone is an established customer identity elsewhere
//    (customer-contact.js, call-spam-classifier.js) and must ground.
async function loadCustomerByPhone(phone, extraction, { timeoutMs = null, includeServiceContacts = false } = {}) {
  const digits = last10(phone);
  if (!digits) return { customer: null, ambiguous: false };
  try {
    let q = db('customers')
      .select('id', 'first_name', 'last_name', 'phone', 'email', 'address_line1', 'city', 'state', 'zip',
        'pipeline_stage', 'waveguard_tier', 'member_since', 'lawn_type', 'property_sqft', 'lot_sqft',
        // active: consumed by the scope-guards triage (an inactive/former
        // customer texting a NEW quote must read as a prospect there).
        // created_at: the webhook-shell recency marker below.
        // created_via: the webhook shell's PROVENANCE stamp (below).
        'property_type', 'company_name', 'active', 'created_at', 'created_via')
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc')
      .limit(5);
    const like = `%${digits}`;
    if (includeServiceContacts) {
      q = q.where(function orPhones() {
        this.whereRaw("regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE ?", [like])
          .orWhereRaw("regexp_replace(coalesce(service_contact_phone, ''), '\\D', '', 'g') LIKE ?", [like])
          .orWhereRaw("regexp_replace(coalesce(service_contact2_phone, ''), '\\D', '', 'g') LIKE ?", [like])
          .orWhereRaw("regexp_replace(coalesce(service_contact3_phone, ''), '\\D', '', 'g') LIKE ?", [like]);
      });
    } else {
      q = q.whereRaw("regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE ?", [like]);
    }
    if (timeoutMs) q = q.timeout(timeoutMs, { cancel: true });
    const rows = await q;
    // Prospect-shell resolution — includeServiceContacts callers ONLY (the
    // scope-guards triage and the gate-on SMS context build; the call path
    // and every ungated caller skip this entirely and keep today's
    // behavior byte-for-byte). When an on-file service contact first texts
    // a domain/van tracking number, the Twilio webhook does not recognize
    // contact-slot phones and mints a NEW primary-phone row. The combined
    // lookup then returns that shell alongside the real customer's
    // contact-slot match, pickCustomerMatch calls it ambiguous, and the SMS
    // build red-lanes a perfectly valid add-on request.
    //
    // The shortcut applies ONLY to rows the webhook itself STAMPED as that
    // placeholder (customers.created_via, written by the domain/van
    // tracking branch moments before this runs). Row shape is not proof: a
    // phone can legitimately carry an established customer AND a real
    // separate lead, and silently handing that lead's quote the
    // established customer's id, saved property, and membership pricing is
    // exactly the failure this guard must not create. Anything unstamped
    // keeps today's ambiguity.
    if (includeServiceContacts && rows.length > 1) {
      const { CUSTOMER_STAGES, CREATED_VIA } = require('../customer-stages');
      const isReal = (r) => r.active === true && CUSTOMER_STAGES.includes(r.pipeline_stage);
      // PROVENANCE, not row shape. The shell is identified by the stamp the
      // Twilio webhook writes on the row it mints (customers.created_via —
      // see routes/twilio-webhook.js domain/van branch and the CREATED_VIA
      // constant). Shape cannot carry this decision: routes/lead-webhook.js
      // creates an active new_lead with a blank address_line1 AND blank zip
      // when a form arrives without an address, so an address-less recent
      // new_lead is NOT proof of a webhook shell — and misreading a genuine
      // lead as one discards real ambiguity and attaches the established
      // customer's id, property, and membership pricing to the lead's quote.
      // The remaining conditions are not provenance tests, they are
      // conservatism: an unstamped row (created before the stamp shipped,
      // or by any other path) never qualifies, a row that has since become
      // a real customer or acquired an address/ZIP is no longer a bare
      // placeholder, and the recency window keeps the shortcut to the
      // webhook's own request. Anything else keeps today's ambiguity, which
      // red-lanes for a human.
      const isWebhookShell = (r) => r.created_via === CREATED_VIA.TWILIO_TRACKING_SHELL
        && !isReal(r)
        && !CUSTOMER_STAGES.includes(r.pipeline_stage)
        && !String(r.address_line1 || '').trim()
        && !String(r.zip || '').trim()
        && !!r.created_at
        && Date.now() - new Date(r.created_at).getTime() <= WEBHOOK_SHELL_MAX_AGE_MS;
      const real = rows.filter(isReal);
      const others = rows.filter((r) => !isReal(r));
      if (real.length === 1 && others.every(isWebhookShell)) {
        return { customer: real[0], ambiguous: false };
      }
    }
    return pickCustomerMatch(rows, extraction);
  } catch (err) {
    logger.warn(`[estimator-engine] customer load failed: ${err.message}`);
    // A failed query is NOT a no-match — an existing member could be hiding
    // behind the error, so callers that gate member pricing on this result
    // must be able to fail closed instead of quoting them as a new prospect.
    return { customer: null, ambiguous: false, unavailable: true };
  }
}

// Address-grounded customer load (SMS scope-guards path only): triage
// confirmed the thread names exactly one existing customer's property, but
// the sender's phone is off file. Load that customer BY ID with the same
// real-customer gates triage applied (not deleted, active === true,
// established pipeline stage) and the same column set as loadCustomerByPhone
// so downstream consumers see an identical shape. Returns null on a genuine
// no-match / gate failure (draft proceeds as a prospect); a QUERY error
// returns { unavailable: true } — same contract as loadCustomerByPhone. A
// transient DB error is NOT a no-match: the grounded customer's membership
// could be hiding behind it, so callers must be able to fail closed instead
// of silently drafting a prospect with the wrong (or absent) customer.
async function loadGroundedCustomerById(customerId) {
  try {
    const row = await db('customers')
      .select('id', 'first_name', 'last_name', 'phone', 'email', 'address_line1', 'city', 'state', 'zip',
        'pipeline_stage', 'waveguard_tier', 'member_since', 'lawn_type', 'property_sqft', 'lot_sqft',
        'property_type', 'company_name', 'active')
      .where({ id: customerId })
      .whereNull('deleted_at')
      .first();
    const { CUSTOMER_STAGES } = require('../customer-stages');
    if (row && row.active === true && CUSTOMER_STAGES.includes(row.pipeline_stage)) return row;
    return null;
  } catch (err) {
    logger.warn(`[estimator-engine] grounded customer load failed: ${err.message}`);
    return { unavailable: true };
  }
}

// Lead for THIS call first (leads created/reused by the processor carry the
// call's twilio_call_sid); the phone fallback is bounded to leads that
// existed by ~the time this call processed — a NEWER unrelated lead on a
// shared/long-lived number must not supply the address or notification link.
async function loadLeadForCall(call, phone, { phoneFallback = true } = {}) {
  // twilio_call_sid is load-bearing for the foreign-call attribution guard
  // below — omit it and every reused row reads as sid-less, silently
  // skipping the concurrent-call check.
  const LEAD_COLS = ['id', 'first_name', 'last_name', 'phone', 'email', 'address', 'city', 'zip',
    'service_interest', 'urgency', 'is_commercial', 'status', 'created_at', 'updated_at',
    'twilio_call_sid'];
  try {
    if (call?.twilio_call_sid) {
      const byCall = await db('leads')
        .select(LEAD_COLS)
        .where({ twilio_call_sid: call.twilio_call_sid })
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc')
        .first();
      if (byCall) return { lead: byCall, forThisCall: true };
    }
    // Phone-less reuse linkage: when a phone-less caller's later call reuses
    // a prior lead, the processor stamps call_log.metadata.lead_id instead
    // of restamping the lead's sid (the lead keeps its ORIGINAL call's sid —
    // rolling it would destroy that call's identity). Follow the stamp
    // before the phone fallback; with no phone there is nothing else to
    // follow, and without this the current call's estimator draft could not
    // link to its lead (codex P1, PR #3275).
    const stampedLeadId = (() => {
      try {
        const md = typeof call?.metadata === 'string' ? JSON.parse(call.metadata) : (call?.metadata || {});
        return md?.lead_id || null;
      } catch { return null; }
    })();
    // NO settled-stamp (processing_token) condition here, deliberately —
    // unlike the out-of-band consumers (admin card, bridge, agent pack).
    // The estimator draft runs IN-PIPELINE from the call processor while
    // this call's own token is still set: its Step 4b just wrote this
    // stamp, and gating on token-null would skip it for exactly the
    // phone-less reused-lead case the stamp exists for — the draft would
    // lose the lead link entirely, since a phone-less call has no
    // last-10 fallback (codex P1, PR #3304). A stamp later cleared or
    // repointed by a retry re-runs the draft with the corrected linkage.
    if (stampedLeadId) {
      const byStamp = await db('leads')
        .select(LEAD_COLS)
        .where({ id: stampedLeadId })
        .whereNull('deleted_at')
        .first();
      if (byStamp) return { lead: byStamp, forThisCall: true };
    }
    const digits = last10(phone);
    if (!digits) return { lead: null, forThisCall: false };
    // A REUSED open lead (the processor updates it without restamping
    // twilio_call_sid) is THIS call's lead: it was touched at/after the call
    // started. It outranks any newer-by-created_at stale/foreign lead on the
    // same last-10 — and on an AMBIGUOUS shared line it is the ONLY
    // phone-matched lead trusted at all. BOUNDED at the call's processing
    // window: on a retried/backfilled old call, an open-ended >= start would
    // claim any lead touched in the days since — a later unrelated
    // interaction's lead would get current-call priority AND be mutated via
    // leads.estimate_id. Outside the window the lead falls to the byPhone
    // path (forThisCall=false), which is the conservative direction.
    // A lead sid-stamped for a DIFFERENT call AND created inside this
    // call's window is provably a CONCURRENT call's creation (the processor
    // stamps twilio_call_sid only on insert), so it must not be claimed
    // here: on a shared line it would otherwise supply the address,
    // customer_email, and leads.estimate_id linkage for the WRONG caller.
    // But a different-sid lead created BEFORE this call is the normal
    // reuse case — the processor reuses prior leads without restamping the
    // sid while refreshing updated_at — so it keeps current-call priority.
    // This call's own sid was already claimed by the byCall branch above.
    if (call?.created_at) {
      const processedBy = new Date(new Date(call.created_at).getTime() + 2 * 3600 * 1000);
      const reused = await db('leads')
        .select(LEAD_COLS)
        .whereRaw("regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`])
        .whereNull('deleted_at')
        .where('updated_at', '>=', call.created_at)
        .where('updated_at', '<=', processedBy)
        .where((qb) => {
          qb.whereNull('twilio_call_sid')
            .orWhere('created_at', '<', call.created_at);
          if (call?.twilio_call_sid) qb.orWhere('twilio_call_sid', call.twilio_call_sid);
        })
        .orderBy('updated_at', 'desc')
        .first();
      if (reused) {
        const ownSid = reused.twilio_call_sid && call?.twilio_call_sid
          && reused.twilio_call_sid === call.twilio_call_sid;
        if (ownSid) return { lead: reused, forThisCall: true };
        // ANY reused row not stamped with THIS call's sid — an older
        // foreign-sid lead or an unstamped web/manual lead — was most
        // likely touched by this call's processing, but on a shared line a
        // CONCURRENT call could have reused it instead, and updated_at
        // cannot say who. Attribute it to this call only when no other
        // call from this line overlaps the window. The overlap check looks
        // back 2h before this call's start: a call that began earlier can
        // still be live or processing inside this call's window. On
        // ambiguity the lead falls through to the byPhone path as prior
        // history (the conservative direction — never current-call
        // address/email/estimate-linkage trust on ambiguous attribution).
        const lookback = new Date(new Date(call.created_at).getTime() - 2 * 3600 * 1000);
        let concurrentQ = db('call_log')
          .select('id')
          .where((qb) => {
            qb.whereRaw("regexp_replace(coalesce(from_phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`])
              .orWhereRaw("regexp_replace(coalesce(to_phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`]);
          })
          .where('created_at', '>=', lookback)
          .where('created_at', '<=', processedBy);
        if (call?.twilio_call_sid) concurrentQ = concurrentQ.whereNot('twilio_call_sid', call.twilio_call_sid);
        if (call?.id) concurrentQ = concurrentQ.whereNot('id', call.id);
        const concurrentCall = await concurrentQ.first();
        if (!concurrentCall) return { lead: reused, forThisCall: true };
        // Ambiguous attribution on an actively-shared line: demoting the
        // lead to the byPhone fallback is not enough — addressFromContext
        // still lets a history lead supply the quote address for a new
        // caller, so the wrong caller's parcel could still be priced. With
        // overlapping calls on one line, no phone-matched lead is
        // trustworthy at all: return none, and let the call transcript
        // establish the address itself (or the draft red-lanes).
        return { lead: null, forThisCall: false };
      }
    }
    if (!phoneFallback) return { lead: null, forThisCall: false };
    let q = db('leads')
      .select(LEAD_COLS)
      .whereRaw("regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`])
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc');
    if (call?.created_at) {
      const cutoff = new Date(new Date(call.created_at).getTime() + 2 * 3600 * 1000);
      q = q.where('created_at', '<=', cutoff);
      // A lead sid-stamped for ANOTHER call but created inside this call's
      // window is a concurrent caller's lead on a shared line — known
      // foreign, and by created_at desc it would win this fallback and hand
      // the composer the wrong address/contact. Exclude it entirely. Leads
      // sid-stamped by OLDER calls remain legitimate prior phone history.
      q = q.where((qb) => {
        qb.whereNull('twilio_call_sid')
          .orWhere('created_at', '<', call.created_at);
        if (call?.twilio_call_sid) qb.orWhere('twilio_call_sid', call.twilio_call_sid);
      });
    }
    const byPhone = await q.first();
    // Touched-since-call leads were already claimed above — anything left is
    // prior phone history.
    return { lead: byPhone || null, forThisCall: false };
  } catch (err) {
    logger.warn(`[estimator-engine] lead load failed: ${err.message}`);
    // `unavailable` distinguishes a FAILED lookup from an established
    // absence (pre-push P1 r2): the existing-draft reconciliation clears
    // a draft's lead links when the call has no current linkage, and a
    // transient DB error must not masquerade as that verdict.
    return { lead: null, forThisCall: false, unavailable: true };
  }
}

// Two-way SMS with this caller UP TO THE END of the call — service requests
// arrive across channels ("I texted you the photos"), and the thread often
// carries the address or sqft the call lacked. Bounded to the call's end so
// a reprocessed old call (or a later text about a different property) can't
// leak post-call messages into the composer's evidence.
async function loadSmsThread(phone, { limit = 20, before = null, since = null } = {}) {
  const digits = last10(phone);
  if (!digits) return [];
  try {
    let q = db('sms_log')
      .select('from_phone', 'to_phone', 'message_body', 'created_at')
      .where(function whereEitherDirection() {
        this.whereRaw("regexp_replace(coalesce(from_phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`])
          .orWhereRaw("regexp_replace(coalesce(to_phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`]);
      })
      .orderBy('created_at', 'desc')
      .limit(limit);
    if (before) q = q.where('created_at', '<=', before);
    // Lookback floor: with only an upper bound, a light texter's "latest 20"
    // reaches months into the past and stale texts about another property
    // get labeled as this call's RECENT SMS THREAD for the composer.
    if (since) q = q.where('created_at', '>=', since);
    const rows = await q;
    return rows.reverse().map((r) => ({
      direction: last10(r.from_phone) === digits ? 'inbound' : 'outbound',
      body: String(r.message_body || '').slice(0, 500),
      at: r.created_at,
    }));
  } catch (err) {
    logger.warn(`[estimator-engine] sms thread load failed: ${err.message}`);
    return [];
  }
}

async function loadPriorEstimates(phone, { limit = 5 } = {}) {
  const digits = last10(phone);
  if (!digits) return [];
  try {
    return await db('estimates')
      .select('id', 'status', 'source', 'category', 'service_interest', 'monthly_total',
        'annual_total', 'onetime_total', 'created_at', 'sent_at')
      .whereRaw("regexp_replace(coalesce(customer_phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`])
      .orderBy('created_at', 'desc')
      .limit(limit);
  } catch (err) {
    logger.warn(`[estimator-engine] prior estimates load failed: ${err.message}`);
    return [];
  }
}

// An open automated draft for this exact call means a retried processing run
// — never draft twice off one call.
async function existingDraftForCall(callLogId) {
  try {
    return await db('estimates')
      .whereRaw("estimate_data->'estimatorEngine'->>'callLogId' = ?", [String(callLogId)])
      .first();
  } catch (err) {
    logger.warn(`[estimator-engine] existing-draft check failed: ${err.message}`);
    return null;
  }
}

async function buildCallContext(callLogId) {
  const call = await db('call_log').where({ id: callLogId }).first();
  if (!call) return { error: 'call_not_found' };
  if (!call.transcription || String(call.transcription).trim().length < 40) {
    return { error: 'no_usable_transcript', call };
  }

  const { extraction, source: extractionSource } = extractionFromCall(call);
  // On OUTBOUND calls from_phone is the Waves line and the customer is the
  // dialed party; forwarded INBOUND calls can carry a Waves/DNI line in
  // from_phone too — internal numbers never key the context loads (mirrors
  // resolveCallContactPhone in the call processor).
  const outbound = String(call.direction || '').toLowerCase() === 'outbound';
  // v1 extraction stores the caller phone at top-level `phone` (the enriched
  // shape uses caller.phone_e164) — on forwarded-call artifacts where both
  // legs are internal, the extracted number is the only real caller signal.
  const extractedPhone = extraction?.caller?.phone_e164 || extraction?.phone || null;
  const phone = outbound
    ? firstExternalPhone(call.to_phone, extractedPhone, call.from_phone)
    : firstExternalPhone(call.from_phone, extractedPhone, call.to_phone);

  // The processor's own shared-phone/slot/address disambiguation already ran
  // — when it resolved a customer for this call, that beats a phone rematch.
  let customerMatch = { customer: null, ambiguous: false };
  let resolvedLoadFailed = false;
  if (call.customer_id) {
    try {
      const resolved = await db('customers')
        .select('id', 'first_name', 'last_name', 'phone', 'email', 'address_line1', 'city', 'state', 'zip',
          'pipeline_stage', 'waveguard_tier', 'member_since', 'lawn_type', 'property_sqft', 'lot_sqft',
          'property_type', 'company_name')
        .where({ id: call.customer_id })
        .whereNull('deleted_at')
        .first();
      if (resolved) {
        customerMatch = { customer: resolved, ambiguous: false };
      } else {
        // The processor DID resolve a customer but the row is gone (deleted
        // or stale reference). A phone rematch could select another
        // shared-line profile or price the known caller as a prospect —
        // same exposure as a thrown query, so it fails closed the same way.
        resolvedLoadFailed = true;
        logger.warn(`[estimator-engine] resolved customer ${call.customer_id} not found — failing closed`);
      }
    } catch (err) {
      // The processor DID resolve a customer; a failed load means we cannot
      // honor that resolution — falling through to a phone rematch here
      // would price a known customer as whoever the phone happens to match.
      resolvedLoadFailed = true;
      logger.warn(`[estimator-engine] resolved-customer load failed: ${err.message}`);
    }
  }

  if (!customerMatch.customer && !resolvedLoadFailed) {
    customerMatch = await loadCustomerByPhone(phone, extraction);
  }
  // Email identity guard (codex P1 ×3, PR #3275): the stated email is
  // checked against REAL, active customers whenever the extraction carries
  // one — not only when phone resolution found nobody. The failure modes it
  // closes: (a) blocked caller ID with no usable number, (b) a stated
  // new/spouse callback number that matches NO account (phone truthy but
  // unmatched), and (c) a callback number that matches a DIFFERENT
  // customer — where drafting would link and price against the phone
  // owner's property and membership instead of the stated email's owner.
  // The email is matched against EVERY customer email slot — primary plus
  // service_contact{,2,3}_email — because a blocked-ID spouse, tenant or
  // property manager stating a slot email is just as much an existing
  // account's caller (codex P1 r18). This guard only ever fails CLOSED to
  // identity review; it never links a customer, so the call path's
  // phone-slot exclusion is untouched.
  // "Real, active" = the canonical whereLiveCustomer predicate
  // (customer-stages.js) — stage and active are independently editable,
  // and a deactivated former customer calling as a new prospect must stay
  // draft-eligible, matching the grounded-customer loader's own
  // active===true requirement (codex P2). Lead-stage rows are NOT members
  // and stay draft-eligible. Lookup failure fails closed like the phone
  // path.
  {
    // ENRICHED (V2 valid) extractions only (codex P1, PR #3304): the V1
    // fallback blob is unvalidated — a stale or hallucinated V1 email that
    // happens to match an active customer's contact would red-lane an
    // otherwise draftable call. A V1-only call keeps its normal review
    // path; the transcript still carries the address for a human read.
    // (Within V2, caller.email is the shape — reading only the top level
    // made this guard a no-op for every valid extraction; codex P1, PR
    // #3275.)
    const extractionEmailLc = extractionSource === 'enriched'
      ? String(extraction?.caller?.email || '').trim().toLowerCase()
      : '';
    if (extractionEmailLc) {
      try {
        // EVERY customer email slot, not just the primary (codex P1 r18):
        // service_contact{,2,3}_email are established contacts on the
        // account (see customer-contact.js), so a blocked-ID spouse, tenant
        // or property manager stating one of them is an existing customer's
        // caller — matching on `email` alone let that call draft a
        // prospect-priced estimate for a live account.
        // Two EXACT questions instead of a capped owner list (codex P2, PR
        // #3275): "does anyone own this email" and, separately, "does the
        // phone match own it". One email legitimately sits on many accounts
        // (a property manager in the service-contact slots of every building
        // they run), so a bounded, unordered fetch could omit the very owner
        // the phone matched and raise a phantom conflict against a
        // legitimate draft. Scoping the second query by id keeps both cheap
        // however many accounts share the address.
        // The CANONICAL live-customer predicate (codex P1, PR #3304) —
        // active=true + not-deleted + the canonical stage list, one
        // definition with every other estimator guard, so a lifecycle
        // change can never make this veto classify a different
        // population than its siblings.
        const { whereLiveCustomer } = require('../customer-stages');
        const emailOwnerQuery = () => whereLiveCustomer(db('customers'))
          .whereRaw(
            '(LOWER(TRIM(email)) = ? OR LOWER(TRIM(service_contact_email)) = ?'
            + ' OR LOWER(TRIM(service_contact2_email)) = ? OR LOWER(TRIM(service_contact3_email)) = ?)',
            [extractionEmailLc, extractionEmailLc, extractionEmailLc, extractionEmailLc],
          );
        const anyEmailOwner = await emailOwnerQuery().first('id');
        if (anyEmailOwner && !customerMatch.customer) {
          logger.warn('[estimator-engine] unidentified call states an active customer\'s email — failing closed to identity review');
          return { error: 'email_matches_existing_customer', call };
        }
        if (anyEmailOwner && customerMatch.customer) {
          const matchOwnsEmail = await emailOwnerQuery()
            .where('id', customerMatch.customer.id)
            .first('id');
          if (!matchOwnsEmail) {
            logger.warn('[estimator-engine] stated email belongs to a DIFFERENT active customer than the phone match — failing closed to identity review');
            return { error: 'email_identity_conflict', call };
          }
        }
      } catch (emailErr) {
        logger.warn(`[estimator-engine] email-owner check failed — failing closed: ${emailErr.code || emailErr.name || 'db_error'}`);
        return { error: 'customer_lookup_unavailable', call };
      }
    }
  }
  // Fail CLOSED on lookup failure, exactly like the SMS-origin path: a
  // failed query is not a no-match — an existing member could be hiding
  // behind the error, and continuing would quote them as a new prospect
  // (dropping membership discounts/fee waivers) while loading phone-scoped
  // history whose shared-line safety cannot be established. The red-lane
  // bell in maybeDraftEstimateForCall owns the manual path.
  if (resolvedLoadFailed || customerMatch.unavailable) {
    return { error: 'customer_lookup_unavailable', call };
  }
  const customer = customerMatch.customer;

  // Bound the SMS thread at the call's END, not its start — call_log rows
  // are created when the inbound call first rings, so a start bound would
  // exclude exactly the during-call texts ("just texted you the address")
  // this loader exists to capture. Unknown duration degrades to the start
  // bound; a reprocessed old call still can't leak later messages.
  const callDurationSeconds = Number(
    call.recording_duration_seconds || call.duration_seconds || call.duration || 0
  ) || 0;
  const callEndsAt = new Date(new Date(call.created_at).getTime() + callDurationSeconds * 1000);
  // 30-day lookback floor relative to THIS call — see loadSmsThread.
  const smsSince = new Date(new Date(call.created_at).getTime() - 30 * 86400000);

  const [leadMatch, smsThread, priorEstimates] = await Promise.all([
    loadLeadForCall(call, phone, { phoneFallback: !customerMatch.ambiguous }),
    // A shared line with MULTIPLE profiles carries texts, estimates, and
    // leads for other people/properties — none of that history may steer
    // the composer on an ambiguous match.
    customerMatch.ambiguous ? Promise.resolve([]) : loadSmsThread(phone, { before: callEndsAt, since: smsSince }),
    customerMatch.ambiguous ? Promise.resolve([]) : loadPriorEstimates(phone),
  ]);
  const lead = leadMatch.lead;

  return {
    call,
    transcript: String(call.transcription),
    extraction,
    extractionSource,
    phone,
    customer: customer || null,
    customerPhoneAmbiguous: customerMatch.ambiguous,
    lead: lead || null,
    // Distinguishes THIS call's lead (sid-matched or touched by this call's
    // processing) from prior phone history — the current lead's address
    // outranks the saved profile for second-property quotes.
    leadIsForThisCall: leadMatch.forThisCall,
    // The lead lookup FAILED (as opposed to finding nothing) — reconcilers
    // that treat absence as a verdict must skip (pre-push P1 r2).
    leadLookupUnavailable: leadMatch.unavailable === true,
    smsThread,
    priorEstimates,
    // An AMBIGUOUS shared-phone match must never unlock member pricing
    // (setup-fee waiver, combined-tier discounts) for whoever happens to be
    // rows[0] — ambiguous profiles inform the composer but price as a lead.
    isExistingCustomer: !!(customer
      && !customerMatch.ambiguous
      && ['active_customer', 'won', 'at_risk'].includes(customer.pipeline_stage)),
  };
}

// SMS-origin context: the thread IS the conversation, so it becomes the
// transcript (and smsThread stays empty — duplicating it would double-weight
// the same evidence in the composer prompt). Ambiguous shared-phone lines
// error out entirely: unlike a call, there is no independent transcript —
// the thread history itself cannot be attributed to one profile, and no
// caller-name extraction exists to disambiguate.
async function buildSmsThreadContext({
  phone, triggerAt = new Date(), triggerBody = '',
  groundedCustomerId = null, groundedConflict = false, groundedScope = null,
  groundedMultiScope = false, groundedOvercap = false,
  groundedUnverifiableLocality = false,
}) {
  if (!last10(phone)) return { error: 'no_usable_phone' };
  // SMS path only: a service-contact sender (spouse/tenant/manager on the
  // configured contact slots) is an established identity — without the
  // contact-slot match their DRAFT context loses the customer and the
  // estimate persists customer_id null even though triage grounded them.
  // Gated behind GATE_ESTIMATOR_SCOPE_GUARDS (lazy require avoids a module
  // cycle) so gate-off behavior stays byte-identical. Call-path
  // loadCustomerByPhone callers are intentionally unchanged.
  const { scopeGuardsEnabled, VETO_BURST_MINUTES } = require('./scope-guards');
  const guardsOn = scopeGuardsEnabled();
  // AMBIGUOUS GROUNDING is a red lane, never a guess. Two shapes reach
  // here, and both mean the thread named more than one candidate answer:
  //  - groundedConflict: the matches span MORE than one customer (the
  //    sender's phone is customer A while the text names B's property, or
  //    an off-file sender names an address that two active customers
  //    share — the latter has no phone customer at all, so the earlier
  //    "downgrade the phone profile" posture silently drafted an UNLINKED
  //    prospect on an existing customer's parcel);
  //  - groundedMultiScope: one customer, but the text named several of
  //    their confirmed properties — linking them would price the primary
  //    parcel and silently pick one of the properties named;
  //  - groundedOvercap: too many same-street rows to attribute the named
  //    address to one of them (a large condo, a prefix spanning cities);
  //  - groundedUnverifiableLocality: a same-street row whose city/ZIP could
  //    not be checked against the locality the sender stated (blank stored
  //    locality) — the street alone cannot prove it is the same parcel, so
  //    linking that customer could hand a stranger's id, parcel data and
  //    membership pricing to the draft.
  // One unified exit for all three: a machine-readable error the caller
  // bells red on (runThreadDraft red-lanes any context.error and names it
  // in the bell body), so a human resolves which property/customer is
  // meant. Gate off, no signal ever flows and this is unreachable.
  if (guardsOn && (groundedConflict === true || groundedMultiScope === true
    || groundedOvercap === true || groundedUnverifiableLocality === true)) {
    return { error: 'ambiguous_grounding' };
  }
  const customerMatch = await loadCustomerByPhone(
    phone, null, guardsOn ? { includeServiceContacts: true } : {},
  );
  if (customerMatch.ambiguous) return { error: 'ambiguous_phone' };
  // A FAILED lookup is not a no-match: an existing member could be hiding
  // behind the error, and pricing them as a prospect would drop membership
  // discounts and fee waivers. Red out; the bell owns the manual path.
  if (customerMatch.unavailable) return { error: 'customer_lookup_unavailable' };
  let customer = customerMatch.customer;
  // Triage grounding fallback (gate-on only): the thread provably named
  // exactly one existing customer's property — link that customer so the
  // draft carries membership context and persists customer_id, with a
  // provenance flag so review can see the link came from the address, not
  // the phone. It applies when the phone lookup found nothing, AND when it
  // found only a NON-real customer: the Twilio webhook mints an active
  // pipeline_stage='new_lead' customers row for first contacts BEFORE this
  // build runs, so a first-contact coordinator's prospect shell would
  // otherwise win over the real customer triage matched — persisting the
  // prospect's customer_id and losing the membership context. A REAL
  // phone-matched customer (active, established stage — the same gates
  // triage applies) always wins; a distinct-customer conflict never
  // grounds; gate off, groundedCustomerId never flows here at all.
  const { CUSTOMER_STAGES } = require('../customer-stages');
  const isRealCustomer = (c) => !!c && c.active === true && CUSTOMER_STAGES.includes(c.pipeline_stage);
  // The triage match carries WHICH property the thread is about. When it
  // is not the primary profile address, or names a unit, keeping the
  // profile's address would price the WRONG parcel (Apt 6 quoting as
  // Apt 1; the rental quoting as the primary home) — and the later
  // address-compare treats explicit-unit vs unitless as conservatively
  // equal, so no re-gather would catch it. Override the address with the
  // matched property's stamp and NULL the profile measurements:
  // property_sqft/lot_sqft describe the primary parcel, and nulling forces
  // the property-facts lookup to gather the quoted property instead. A
  // primary-scope match without a unit keeps the profile as-is.
  const applyGroundedScope = (profile) => {
    if (!groundedScope || !(groundedScope.isPrimary === false || groundedScope.line2)) return profile;
    // The unit rides INSIDE address_line1, not only in address_line2: every
    // downstream consumer builds the address from line1 + city + zip and
    // ignores line2 — addressFromContext (index.js customerAddress), the
    // composer profile block (intent-composer buildUserContent), and the
    // customerSavedAddress comparison that decides whether the profile's
    // saved measurements may backfill. A line2-only unit leaves all three
    // holding a UNITLESS street, and sameStreetAddress treats
    // known-vs-unknown units as conservatively equal — so the composer's
    // explicit "Apt 6" would match the unitless profile address and skip
    // the re-gather this override exists to force. line2 is still set (the
    // schema-correct home for the unit) for any consumer that reads it.
    const line1 = groundedScope.address || profile.address_line1;
    const unit = groundedScope.line2 || null;
    const line1WithUnit = unit && line1
      && !String(line1).toLowerCase().includes(String(unit).toLowerCase())
      ? `${line1} ${unit}`
      : line1;
    return {
      ...profile,
      address_line1: line1WithUnit,
      address_line2: unit,
      city: groundedScope.city || null,
      zip: groundedScope.zip || null,
      // EVERY parcel-descriptive column on the customers select is cleared,
      // not just the measurements. Rewriting the address makes
      // profileDescribesQuotedProperty (index.js) read TRUE for the quoted
      // property, and draft-builder then falls back to these fields — so a
      // retained primary-parcel property_type re-prices a condo as detached
      // and a retained lawn_type feeds the composer the wrong turf. Audited
      // against the selected columns in loadCustomerByPhone /
      // loadGroundedCustomerById: address_line1/city/zip (rewritten above),
      // property_sqft, lot_sqft, property_type, lawn_type describe the
      // PARCEL; state is locality-invariant ('FL'). No other parcel traits
      // (bed_sqft, linear_ft_perimeter, palm_count, canopy_type) are
      // selected, so none reach the context. Person-level fields — name,
      // phone, email, waveguard_tier, member_since, company_name — stay:
      // they describe the customer, not the property.
      property_sqft: null,
      lot_sqft: null,
      property_type: null,
      lawn_type: null,
    };
  };
  // Ambiguous grounding already returned above, so every branch here is
  // working from a SINGLE candidate customer/property.
  let customerGroundedByAddress = false;
  if (guardsOn && groundedCustomerId && !isRealCustomer(customer)) {
    const grounded = await loadGroundedCustomerById(groundedCustomerId);
    // Fail CLOSED on a transient reload error, exactly like the phone
    // lookup above — the grounded customer's membership could be hiding
    // behind the error; the red bell owns the manual path.
    if (grounded?.unavailable) return { error: 'customer_lookup_unavailable' };
    if (grounded) {
      customer = applyGroundedScope(grounded);
      customerGroundedByAddress = true;
    }
  } else if (guardsOn && customer && customer.id === groundedCustomerId) {
    // A REAL phone-matched customer texting about their OWN secondary
    // property/unit (triage matched the same customer by address): the
    // identity needs no grounding, but the quoted PROPERTY still does —
    // without the override their primary profile's address and
    // measurements would price the wrong parcel.
    customer = applyGroundedScope(customer);
  }
  // Phone-scoped history belongs to whoever OWNS the sending number, so it
  // is only this draft's history when the customer link came from that
  // number. On the ADDRESS-GROUNDED path an off-file coordinator texts
  // about customer B, yet the coordinator's own number can still carry a
  // stale lead and prior estimates for ANOTHER client — exposing that
  // client's address (via addressFromContext) and services to the composer
  // on B's draft. Suppress both; the SMS thread stays, it IS the
  // conversation being answered. (The distinct-customer conflict that used
  // to share this suppression now red-lanes before any of this runs.)
  const suppressPhoneHistory = customerGroundedByAddress;
  const before = new Date(triggerAt);
  // Transcript scope follows the customer-link provenance. A phone-matched
  // customer's 30-day thread is THEIR OWN history. An ADDRESS-GROUNDED
  // draft is built off a coordinator's number, and that number's 30-day
  // thread can carry OTHER clients' conversations — handing it wholesale
  // to the composer leaks them into customer B's estimate. Grounded
  // transcripts scope to the CURRENT exchange — the same VETO_BURST_MINUTES
  // window triage grounded from — and when that burst alone is unreadable
  // the short-transcript floor below red-errors (no_usable_thread), which
  // is the wanted outcome: a human reads the thread instead.
  const smsSince = customerGroundedByAddress
    ? new Date(before.getTime() - VETO_BURST_MINUTES * 60 * 1000)
    : new Date(before.getTime() - 30 * 86400000);
  const [leadMatch, smsThread, priorEstimates] = await Promise.all([
    // call=null: skips the sid + reused-lead branches; pure phone fallback.
    suppressPhoneHistory
      ? Promise.resolve({ lead: null, forThisCall: false })
      : loadLeadForCall(null, phone, { phoneFallback: true }),
    loadSmsThread(phone, { limit: 40, before, since: smsSince }),
    suppressPhoneHistory ? Promise.resolve([]) : loadPriorEstimates(phone),
  ]);
  // The webhook records the TRIGGERING inbound message to sms_log after the
  // handlers run, so the thread read here can miss exactly the text that
  // asked for the quote (or supplied the address). Append it when the
  // thread doesn't already end with it.
  const trigger = String(triggerBody || '').trim().slice(0, 500);
  if (trigger && smsThread[smsThread.length - 1]?.body !== trigger) {
    smsThread.push({ direction: 'inbound', body: trigger, at: before });
  }
  const transcript = smsThread
    .map((m) => `[${m.direction === 'inbound' ? 'Customer' : 'Waves'}] ${m.body}`)
    .join('\n');
  if (transcript.trim().length < 40) return { error: 'no_usable_thread' };
  return {
    call: null,
    transcript,
    // The joined transcript is for the composer PROMPT; evidence
    // verification needs the per-message boundaries or a fabricated quote
    // could pass by stitching words across two texts (verifyEvidenceQuotes
    // prefers transcriptRecords when present).
    transcriptRecords: smsThread.map((m) => m.body),
    extraction: null,
    // 'none' keeps the lane classifier's non-enriched flag — an SMS draft
    // can never land green, which is the right floor for text-only evidence.
    extractionSource: 'none',
    phone,
    customer: customer || null,
    // Ambiguous grounding red-lanes above, so anything reaching here has a
    // single unambiguous candidate.
    customerPhoneAmbiguous: false,
    lead: leadMatch.lead || null,
    leadIsForThisCall: false,
    smsThread: [],
    priorEstimates,
    ...(customerGroundedByAddress ? { customerGroundedByAddress: true } : {}),
    // Gate on, mirror triage's posture: an inactive former customer (matched
    // via the contact-slot lookup or otherwise) keeps their profile as
    // history but must not unlock existing-customer pricing context —
    // active === true is required, same as the triage grounding gates. The
    // legacy stage-only predicate is preserved byte-identical gate-off.
    isExistingCustomer: !!(customer
      && ['active_customer', 'won', 'at_risk'].includes(customer.pipeline_stage)
      && (!guardsOn || customer.active === true)),
  };
}

module.exports = {
  buildCallContext,
  buildSmsThreadContext,
  existingDraftForCall,
  // Origin-specific context builders reuse these reads so call, web-lead,
  // and SMS sessions all resolve contacts/history with the same shared-line
  // safeguards. They are reads only; callers still own temporal bounds.
  loadCustomerByPhone,
  loadPriorEstimates,
  loadSmsThread,
  _private: {
    extractionFromCall,
    firstExternalPhone,
    last10,
    loadLeadForCall,
    pickCustomerMatch,
  },
};
