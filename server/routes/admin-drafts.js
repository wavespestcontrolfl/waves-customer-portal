const express = require('express');
const router = express.Router();
const db = require('../models/db');

// The corrections view (migration 20261002110000) counts a revised or
// rejected draft only when a person's review wrote it: the campaign send guard
// and the Agent Ops duplicate sweep also write status rejected with
// approved_by. The two review endpoints stamp the status they set into
// flags.review_verdict; the view requires the stamp to match the row's status.
// flags is an object on some drafts and an ARRAY of tags on others (the
// house-voice drafter writes an array), and array || object is an array, so
// the stamp follows the row's shape: a 'review_verdict:<status>' tag on an
// array, a review_verdict key on an object, a fresh object when null.
const reviewVerdictStamp = (dbh, status) => dbh.raw(
  "CASE jsonb_typeof(flags) WHEN 'array' THEN flags || ?::jsonb WHEN 'object' THEN flags || ?::jsonb ELSE ?::jsonb END",
  [JSON.stringify([`review_verdict:${status}`]), JSON.stringify({ review_verdict: status }), JSON.stringify({ review_verdict: status })],
);
const logger = require('../services/logger');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const {
  sendManualCustomerSms,
  manualSmsDeliveryState,
} = require('../services/messaging/send-manual-customer-sms');
const { isEnabled } = require('../config/feature-gates');

router.use(adminAuthenticate, requireTechOrAdmin);
// 2026-08-25 role lockdown: every draft MUTATION (approve/send, revise,
// reject) is owner-only — approving a draft sends a customer SMS, and the
// owner sends all customer comms. The ONLY staff-wide read is the single-
// draft lookup the tech-visible Communications surface uses (GET /:id);
// list/enumeration reads are owner-only like the Agent Ops page they back.
const SINGLE_DRAFT_GET_RE = /^\/[A-Za-z0-9_-]+$/;
router.use((req, res, next) => (
  req.method === 'GET'
    && SINGLE_DRAFT_GET_RE.test(req.path)
    && req.path !== '/stats' // named GET siblings of /:id stay owner-only
    ? next()
    : requireAdmin(req, res, next)
));

function parseFlags(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_err) {
    return {};
  }
}

function normalizeE164(phone) {
  if (!phone) return null;
  const trimmed = String(phone).trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return trimmed.startsWith('+') ? trimmed : trimmed || null;
}

function samePhone(a, b) {
  const left = String(a || '').replace(/\D/g, '');
  const right = String(b || '').replace(/\D/g, '');
  return Boolean(left && right && left.slice(-10) === right.slice(-10));
}

// `preloaded` lets a page-sized caller (GET /) hand over the sms_log row
// and the draft's own customer row it already fetched in bulk, so a 50-row
// page costs a fixed number of queries instead of two per draft (Codex
// #3700 r9 P2). Keys present in `preloaded` are authoritative — a null
// means "looked up, not found".
async function resolveDraftRecipient(draft, preloaded = {}) {
  const flags = parseFlags(draft.flags);
  if (draft.sms_log_id) {
    const smsLog = 'smsLog' in preloaded
      ? preloaded.smsLog
      : await db('sms_log').where({ id: draft.sms_log_id }).first();
    if (smsLog?.from_phone) {
      return {
        toPhone: smsLog.from_phone,
        fromNumber: TWILIO_NUMBERS.findByNumber(smsLog.to_phone) ? smsLog.to_phone : undefined,
        customerId: draft.customer_id || smsLog.customer_id || null,
        identityTrustLevel: draft.customer_id || smsLog.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
        // Unverified pairing: approve / revise judge it in guardDraftRecipient.
        viaSmsLog: true,
        smsCustomerId: smsLog.customer_id,
      };
    }
  }

  const customer = !draft.customer_id ? null
    : 'customer' in preloaded ? preloaded.customer
      : await db('customers').where({ id: draft.customer_id }).select('id', 'phone').first();
  const metadataPhone = normalizeE164(flags.toPhone || flags.phone || flags.leadPhone);
  // A line pinned when the draft was written (seasonal win-back names it in
  // the body) — honored only if it is one of our numbers.
  const pinnedFrom = flags.fromNumber && TWILIO_NUMBERS.findByNumber(flags.fromNumber) ? flags.fromNumber : undefined;
  if (metadataPhone) {
    const customerMatches = customer?.phone && samePhone(metadataPhone, customer.phone);
    return {
      toPhone: metadataPhone,
      fromNumber: pinnedFrom,
      customerId: customerMatches ? customer.id : null,
      identityTrustLevel: customerMatches ? 'phone_matches_customer' : 'phone_provided_unverified',
    };
  }

  if (draft.customer_id) {
    if (customer?.phone) {
      return {
        toPhone: customer.phone,
        fromNumber: pinnedFrom,
        customerId: customer.id,
        identityTrustLevel: 'phone_matches_customer',
      };
    }
  }

  return { toPhone: null, customerId: draft.customer_id || null, identityTrustLevel: 'phone_provided_unverified' };
}

// Audit AG-01 (2026-10-30): an SMS-anchored draft goes out only while it
// still belongs to the customer it was written for. The branch above pairs
// the inbound sender's phone with the draft's own customer_id and asserts
// phone_matches_customer without checking either link, and the send
// validators accept that label. Judged at approve / revise, and again at the
// provider handoff (the SMS row can be re-linked while the pipeline awaits):
//  - the SMS row now linked to a different customer (a reassigned number or
//    a merge), or the customer row gone: the copy and the stored preferences
//    belong to the old customer, so the draft is refused, never relabeled;
//  - a reply number no longer on the customer's record: its own phone (a
//    property row without one uses the account primary's, the canonical
//    fallback) or a service-contact slot.
// A NULL link on either side is not a change: the drafter may have resolved
// the customer itself. A slot number sends as service_contact_authorized, so
// the provider boundary re-reads that contact's own choices.
const DRAFT_RECIPIENT_HOLDS = {
  customer_changed: {
    error: 'This draft was written for a different customer than the one this conversation now belongs to — reject it and reply from the conversation.',
    code: 'DRAFT_CUSTOMER_CHANGED',
  },
  phone_not_on_record: {
    error: "The number this draft replies to is no longer on the customer's record — reject it and reply from the conversation.",
    code: 'DRAFT_PHONE_NOT_ON_RECORD',
  },
  // Handoff only: the recheck passed for another customer or trust level
  // than the send was prepared with (its identity and consent context).
  changed_during_send: {
    error: 'The recipient changed while this draft was being sent — it was left pending; open it again before sending.',
    code: 'DRAFT_RECIPIENT_CHANGED',
  },
};
const DRAFT_RECIPIENT_UNAVAILABLE = {
  error: 'Recipient check unavailable — draft left pending, try again',
  code: 'DRAFT_RECIPIENT_CHECK_UNAVAILABLE',
};

async function smsDraftRecipientVerdict(draft, toPhone, smsCustomerId) {
  if (smsCustomerId && draft.customer_id && String(smsCustomerId) !== String(draft.customer_id)) {
    return { ok: false, hold: 'customer_changed' };
  }
  const customerId = draft.customer_id || smsCustomerId;
  if (!customerId) return { ok: true, customerId: null, identityTrustLevel: 'phone_provided_unverified' };
  const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first();
  if (!customer) return { ok: false, hold: 'customer_changed' };
  const { withAccountPrimaryContact, findServiceContactSlotByPhoneKey, phoneKeyOf } = require('../services/customer-contact');
  const own = await withAccountPrimaryContact(customer, { rethrow: true }); // an outage is a 503, not "not on record"
  if (samePhone(own.phone, toPhone)) {
    return { ok: true, customerId: customer.id, identityTrustLevel: 'phone_matches_customer' };
  }
  if (findServiceContactSlotByPhoneKey(customer, phoneKeyOf(toPhone))) {
    return { ok: true, customerId: customer.id, identityTrustLevel: 'service_contact_authorized' };
  }
  return { ok: false, hold: 'phone_not_on_record' };
}

// The provider-handoff form (preProviderCheck contract): the SMS row's link
// and the customer's numbers are re-read at the last await before Twilio,
// and the answer must name the same customer and trust level the send was
// prepared with (`prepared`, the route-level verdict) — a customer-less
// draft's SMS row re-linked from B to C mid-send must not pass as C while
// the send carries B's identity and preferences. `next` (a later hook, e.g.
// the photo-triage offer recheck) runs only on a pass. An outage answers a
// retryable code, never a raw exception message.
function draftRecipientLateCheck(draft, toPhone, prepared, next) {
  return async (ctx) => {
    let verdict;
    try {
      const smsRow = await db('sms_log').where({ id: draft.sms_log_id }).first('customer_id');
      verdict = await smsDraftRecipientVerdict(draft, toPhone, smsRow?.customer_id || null);
    } catch {
      return { ok: false, code: DRAFT_RECIPIENT_UNAVAILABLE.code, reason: DRAFT_RECIPIENT_UNAVAILABLE.error, retryable: true };
    }
    const holdKey = !verdict.ok ? verdict.hold
      : String(verdict.customerId || '') !== String(prepared.customerId || '')
        || verdict.identityTrustLevel !== prepared.identityTrustLevel ? 'changed_during_send' : null;
    if (holdKey) {
      const hold = DRAFT_RECIPIENT_HOLDS[holdKey];
      return { ok: false, code: hold.code, reason: hold.error };
    }
    return next ? next(ctx) : { ok: true };
  };
}

// Route-level form, run right after the recipient resolves and before any
// send work: a hold → 409 and an outage → 503, both with the claim released
// (the draft stays pending). A pass returns the recipient with the verified
// customer and trust level, and lateCheck(next) builds the handoff hook.
async function guardDraftRecipient(draft, recipient, res, releaseFields = {}) {
  if (!recipient.viaSmsLog) return { blocked: false, recipient, lateCheck: (next) => next };
  let verdict;
  try {
    verdict = await smsDraftRecipientVerdict(draft, recipient.toPhone, recipient.smsCustomerId);
  } catch (err) {
    logger.warn(`[admin-drafts] recipient check failed for draft ${draft.id} (code=${err?.code || 'none'})`);
    await releaseUndecidedClaim(draft, releaseFields);
    res.status(503).json(DRAFT_RECIPIENT_UNAVAILABLE);
    return { blocked: true };
  }
  if (!verdict.ok) {
    await releaseUndecidedClaim(draft, releaseFields);
    res.status(409).json(DRAFT_RECIPIENT_HOLDS[verdict.hold]);
    return { blocked: true };
  }
  return {
    blocked: false,
    recipient: { ...recipient, customerId: verdict.customerId, identityTrustLevel: verdict.identityTrustLevel },
    lateCheck: (next) => draftRecipientLateCheck(draft, recipient.toPhone, verdict, next),
  };
}

// The From number the send path will END UP using for a draft with no
// inbound sms_log anchor, resolved by the CANONICAL derivation
// (TwilioService.deriveOutboundNumber — the same code sendSMS runs), fed
// lane-exact inputs: only campaign approvals pass customerLocationId
// (nearest_location_id); every other anchorless draft sends with
// customerId alone (Codex #3700 r2-r5 P1s). Display-only: the deep link
// pins the number so the composer's hardcoded default cannot override
// routing; the send path itself is untouched.
async function derivedOfficeNumber(row, recipientCustomerId, preloadedCustomer = null) {
  try {
    const TwilioService = require('../services/twilio');
    // The preloaded row only stands in for the customer the send path
    // would look up — never for a different customer the sms_log thread
    // resolved to.
    const customer = preloadedCustomer && recipientCustomerId && preloadedCustomer.id === recipientCustomerId
      ? preloadedCustomer
      : undefined;
    return await TwilioService.deriveOutboundNumber({
      customerLocationId: row.campaign_type ? row.nearest_location_id : undefined,
      customerId: recipientCustomerId || undefined,
      customer,
    }) || null;
  } catch {
    return null;
  }
}

const immediateOnlyLinkInDraft = (label) => `${label} links cannot go out through draft approval — send them from the composer, where the link is re-checked at delivery.`;
// Presence only (customer-kind /secure links or a look-alike host, then the
// other per-row bearers — contract signing, card request, statement pay,
// expiring prep pages): the composer-links seams do the lookups; a draft
// never sends one at all (draft approve/revise dispatch straight into
// sendCustomerMessage — no delivery re-check). Returns the refusal
// message, or null.
async function draftImmediateOnlyLinkRefusal(body) {
  const { autopayLinkSendCheck, immediateOnlyLinkSendCheck } = require('../services/composer-customer-links');
  if ((await autopayLinkSendCheck(body, null)).present) return immediateOnlyLinkInDraft('Auto Pay setup');
  const immediateOnly = await immediateOnlyLinkSendCheck(body);
  return immediateOnly.present ? immediateOnlyLinkInDraft(immediateOnly.label) : null;
}

async function releaseDraftClaim(draftId, fields = {}) {
  await db('message_drafts').where({ id: draftId }).update({
    status: 'pending',
    approved_by: null,
    approved_at: null,
    ...fields,
  }).catch(() => {});
}

// Send-policy mapping for owner-approved drafts. Estimate-clarify drafts ride
// the transactional estimate rails (below); every other draft (campaign or
// legacy inbound-reply) rides draftSendPolicyFields' purpose passthrough.
function sendPolicyForDraft(draft, recipient) {
  if (draft.intent === 'estimate_clarify') {
    // Clarify asks answer the contact's OWN quote request, so they ride the
    // transactional estimate rails, never the conversational fallthrough.
    // Consent is only ASSERTED when the phone's recorded provenance
    // supports SMS contact — they texted us, called us, or self-submitted
    // the number on our quote form (the basis the form's SMS auto-reply
    // already sends under). An email-extracted phone asserts nothing:
    // consentBasis stays undefined and the messaging validator's
    // fail-closed path owns the verdict. Draft creation is never itself
    // consent evidence.
    const flags = parseFlags(draft.flags);
    const provenance = flags.channel_provenance || null;
    const smsProvenance = ['sms', 'voice', 'web_form'].includes(provenance);
    return {
      audience: recipient.customerId ? 'customer' : 'lead',
      purpose: 'estimate_followup',
      estimateId: flags.estimate_id || undefined,
      consentBasis: (recipient.customerId || !smsProvenance) ? undefined : {
        status: 'transactional_allowed',
        source: `estimate_clarify_${provenance}`,
        capturedAt: draft.created_at || new Date().toISOString(),
      },
    };
  }
  return draftSendPolicyFields(draft, recipient);
}

// Purposes whose policy row requires marketing-grade consent
// (policy.js requireConsent: 'marketing').
const MARKETING_GRADE_PURPOSES = new Set(['marketing', 'marketing_seasonal', 'retention']);

/**
 * Audience/purpose/consent fields for a draft send.
 *
 * Null-purpose drafts (the inbound-reply lane) keep the legacy behavior
 * exactly: audience 'lead', purpose 'conversational', no consentBasis.
 *
 * Drafts that carry a non-null `purpose` pass it through so the send
 * runs under the REAL policy row instead of bypassing consent as
 * 'conversational'. Marketing-grade purposes get the same stored-preference
 * consent basis the existing marketing senders assert (upsell-trigger /
 * retention agent: 'customer_marketing_preferences'); the
 * consent validator still enforces sms_enabled + seasonal_tips prefs,
 * customerId presence, and identity trust — this helper only stops the
 * bypass, it does not manufacture consent.
 */
function draftSendPolicyFields(draft, recipient) {
  if (!draft.purpose) {
    return { audience: 'lead', purpose: 'conversational' };
  }
  const fields = {
    audience: recipient.customerId ? 'customer' : 'lead',
    purpose: draft.purpose,
  };
  if (MARKETING_GRADE_PURPOSES.has(draft.purpose)) {
    fields.consentBasis = {
      status: 'opted_in',
      source: 'customer_marketing_preferences',
      capturedAt: new Date(draft.created_at || Date.now()).toISOString(),
    };
  }
  return fields;
}

/**
 * 422 body for a blocked/failed send. Surfaces the block code and — for
 * retryable provider failures — the nextAllowedAt timestamp. The draft has
 * already been released back to pending, so it can simply be approved again
 * later.
 */
function blockedSendResponse(res, smsResult) {
  // A late recheck's outage (photo-triage offer, draft recipient) is
  // transient — same retryable 503 contract as its route-level check
  // (codex #4810 r13).
  const status = ['PHOTO_TRIAGE_RECHECK_UNAVAILABLE', DRAFT_RECIPIENT_UNAVAILABLE.code].includes(smsResult.code) ? 503 : 422;
  return res.status(status).json({
    error: smsResult.reason || smsResult.code || 'SMS send blocked/failed',
    code: smsResult.code,
    nextAllowedAt: smsResult.nextAllowedAt,
  });
}

function uncertainSendResponse(res) {
  return res.status(409).json({
    error: 'The carrier did not confirm this text. It may still go out; check the thread and do not retry until it is reconciled.',
    code: 'SMS_DELIVERY_UNCERTAIN',
    mayHaveSent: true,
    retryable: false,
  });
}

function priorManualSendStillUnresolved(outcome) {
  return outcome?.code === 'MANUAL_REPLY_OUTCOME_UNRESOLVED'
    && manualSmsDeliveryState(outcome) === 'uncertain';
}

/**
 * Pre-send guard for campaign drafts (both approve and revise). Legacy
 * (null campaign_type) drafts pass straight through.
 *
 * The campaign draft generators (daily upsell, Monday win-back) and their
 * send gate are gone, so a draft that still carries a campaign_type is a
 * leftover. It must not send: the claim is released, the draft stays pending
 * and the 409 tells the operator to reject it.
 *
 * Sends the HTTP response itself when blocking. Returns
 *   { blocked: true }                    — response already sent, caller returns
 *   { blocked: false }                   — proceed
 */
// Clarify-ask drafts (services/estimate-clarify-asks.js): the writer's gate
// must hold at APPROVAL time too — GATE_ESTIMATE_CLARIFY_ASKS turned off
// while a draft sits pending means the owner shut the lane; the click must
// not send. And the QUESTION must still be needed: the answer can arrive,
// the linked estimate can move past draft, or the lead can close while the
// draft sits pending — approving then would text a stale question. Stale →
// draft retired (rejected) + 409; transient lookup failure → fail closed,
// claim released, 503. Suppression/consent are re-checked by
// sendCustomerMessage regardless. Narrowly scoped to
// intent='estimate_clarify'. The staleness rules themselves (closed-lead
// statuses, answer-arrived detection) live in claimClarifyDispatch.
// Clarify-only claim release: conditional on the claim still standing, so
// it can never overwrite a concurrent reject's verdict back to pending
// (the unlocked reject route can land at any moment; unconditional
// releaseDraftClaim would resurrect it).
async function releaseClarifyClaim(draftId, fields = {}) {
  await db('message_drafts').where({ id: draftId })
    .whereIn('status', ['approved', 'revised'])
    .update({
      status: 'pending',
      approved_by: null,
      approved_at: null,
      ...fields,
    }).catch(() => {});
}

// A claim taken before the clarify dispatch decision: a clarify draft's
// release is status-guarded (reject-safe), every other draft's is plain.
function releaseUndecidedClaim(draft, fields = {}) {
  return draft.intent === 'estimate_clarify'
    ? releaseClarifyClaim(draft.id, fields)
    : releaseDraftClaim(draft.id, fields);
}

async function guardClarifySend(draft, res, releaseFields = {}, { isRevision = false } = {}) {
  if (draft.intent !== 'estimate_clarify') return { blocked: false };
  if (!isEnabled('estimateClarifyAsks')) {
    await releaseClarifyClaim(draft.id, releaseFields);
    res.status(409).json({
      error: 'Clarify asks are disabled (GATE_ESTIMATE_CLARIFY_ASKS is off) — draft left pending',
      code: 'CLARIFY_GATE_OFF',
    });
    return { blocked: true };
  }

  // The staleness re-read, partial-answer rewrite, and claim re-verification
  // all commit atomically under the per-phone clarify lock (the same lock
  // every reply/park writer holds) — see claimClarifyDispatch. sent_at
  // stays provider-confirmed (finalizeDraftSend stamps it after a real
  // send). From the 'send' outcome on, the decision is committed: failures
  // downstream MUST reconcile via releaseFailedSendClaim, never plain
  // releaseDraftClaim.
  const { claimClarifyDispatch, clarifyPreDispatchCheck } = require('../services/estimate-clarify-asks');
  const verdict = await claimClarifyDispatch({ draft, isRevision, releaseFields });
  if (verdict.outcome === 'retired') {
    res.status(409).json({ error: verdict.message, code: 'CLARIFY_STALE' });
    return { blocked: true };
  }
  if (verdict.outcome === 'rewritten') {
    // The owner's revision was typed against the stale multi-question copy —
    // it must not go out as-is. The decision already released the claim in
    // its locked conditional write (an unconditional release here could
    // resurrect a concurrent reject); the queue now shows the rewritten
    // single question.
    res.status(409).json({
      error: 'The customer already supplied part of this — the draft was rewritten to what is still missing. Review the new copy and try again.',
      code: 'CLARIFY_UPDATED',
    });
    return { blocked: true };
  }
  if (verdict.outcome !== 'send') {
    await releaseClarifyClaim(draft.id, releaseFields);
    res.status(503).json({ error: 'Clarify staleness check unavailable — draft left pending, try again' });
    return { blocked: true };
  }
  draft.draft_response = verdict.body;
  draft.flags = JSON.stringify(verdict.flags);
  const dispatchedMissing = Array.isArray(verdict.flags.missing) ? verdict.flags.missing : [];
  return {
    blocked: false,
    dispatchCommitted: true,
    dispatchedMissing,
    // Final abort point, run by sendCustomerMessage as the last await
    // before the provider handoff — catches answers that land while the
    // send pipeline's own validators run.
    preDispatchCheck: clarifyPreDispatchCheck({
      draftId: draft.id,
      sourceRef: draft.source_ref,
      dispatchedMissing,
    }),
  };
}

// Photo-triage drafts (services/photo-text-triage.js): the opportunity
// gauge's ownership/offer check ran at CREATION; by approval the customer
// may have enrolled in the family, a plan rate may have landed, or the
// owner-only per-application figure may have drifted. Re-run the SAME
// check right before dispatch (codex #4810 r6): owned/unavailable → 409,
// claim released, draft left pending for the owner to rewrite; a quote
// whose figure moved → flags.quote refreshed, 409 so the owner re-reads it;
// lookup failure → 503 fail closed. Narrowly scoped to intent
// 'photo_triage'; the text itself never carries a price, and it is never
// parsed — photo-triage drafts are approve-as-written only (the /revise
// route refuses them), so the stored verdict describes what is sent.
// customerId: the RESOLVED recipient's customer (sms_log linkage included —
// a draft linked through its SMS row after creation must recheck against
// that customer, codex #4810 r7).
// Holds that leave the row exactly as it is — the copy itself is unusable,
// so nothing stored is patched: a pre-gauge draft (old universal copy,
// nothing to recheck — the owner revises it, still allowed for these, or
// rejects it) and an audience change (the copy was chosen for another
// customer or for a lead).
const PHOTO_TRIAGE_PLAIN_HOLDS = {
  pre_gauge: {
    error: 'This photo-triage draft predates the opportunity check — revise it before sending, or reject it.',
    code: 'PHOTO_TRIAGE_PRE_GAUGE',
  },
  recipient_changed: {
    error: 'This photo-triage draft was written before the sender was linked to this customer or became a customer — reject it and reply from the conversation.',
    code: 'PHOTO_TRIAGE_RECIPIENT_CHANGED',
  },
};

// Stale pitch holds: the no-pitch reason recorded on the downgraded verdict
// and the owner-facing explanation, per recheck answer.
const PHOTO_TRIAGE_STALE_HOLDS = {
  owned: { reason: 'already_owned', why: (family) => `the customer now has ${family} on their plan` },
  unavailable: { reason: 'offer_unavailable', why: (family) => `ownership of ${family} could not be confirmed (live plan rate or lookup failure)` },
  no_longer_priced: { reason: 'quote_needs_review', why: (family) => `${family} can no longer be priced for this customer` },
};

// The customer a photo-triage draft is going to NOW. The SMS row's current
// linkage wins: resolveDraftRecipient prefers the draft's own customer_id,
// which a later re-link of the SMS row never updates (codex #4810 r15). A
// NULL there is not an unlink signal — the draft's customer came from the
// phone lookup, not this column, so it may never have been set.
async function currentPhotoTriageCustomer(draft, customerId) {
  if (draft.sms_log_id) {
    const smsRow = await db('sms_log').where({ id: draft.sms_log_id }).first();
    if (smsRow?.customer_id) return smsRow.customer_id;
  }
  return customerId || draft.customer_id;
}

// The send-time hook form of the recheck (preDispatchCheck/preProviderCheck
// contract): stale → blocked; an outage → the same retryable code the
// route-level 503 uses, never a raw exception message.
// The customer is re-resolved on every call — the SMS row can be re-linked
// while the send pipeline awaits (codex #4810 r16).
function photoTriageLateCheck(recheckDraftOffer, draft, customerId, flags) {
  return async () => {
    try {
      const late = await recheckDraftOffer({ customerId: await currentPhotoTriageCustomer(draft, customerId), flags });
      return late.ok ? { ok: true } : { ok: false, code: 'PHOTO_TRIAGE_OFFER_STALE', reason: 'photo-triage offer changed before dispatch — draft left pending' };
    } catch {
      return { ok: false, code: 'PHOTO_TRIAGE_RECHECK_UNAVAILABLE', reason: 'Photo-triage offer recheck unavailable — draft left pending, try again', retryable: true };
    }
  };
}

async function guardPhotoTriageSend(draft, res, { customerId = draft.customer_id } = {}) {
  // Same predicate the /revise refusal claims on (intent), so the two
  // halves of the approve-as-written rule can never disagree on a draft.
  if (draft.intent !== 'photo_triage') return { blocked: false };
  const flags = parseFlags(draft.flags);
  let verdict;
  const { recheckDraftOffer, stripQuotePitch, priceContextSentence, replacePriceContext } = require('../services/photo-triage-opportunity');
  try {
    verdict = await recheckDraftOffer({ customerId: await currentPhotoTriageCustomer(draft, customerId), flags });
  } catch (err) {
    logger.warn(`[admin-drafts] photo-triage offer recheck failed for draft ${draft.id} (code=${err?.code || 'none'})`);
    await releaseDraftClaim(draft.id);
    res.status(503).json({ error: 'Photo-triage offer recheck unavailable — draft left pending, try again', code: 'PHOTO_TRIAGE_RECHECK_UNAVAILABLE' });
    return { blocked: true };
  }
  if (verdict.ok) {
    // Same recheck again at sendCustomerMessage's last await before the
    // provider handoff (codex #4810 r12): the manual-reply reservation and
    // validator pipeline run between here and the send, and the customer
    // can enroll meanwhile. A non-ok answer there blocks the send; the
    // failed-send path releases the claim, and the next approve lands in
    // the handling below.
    // Run at BOTH late hooks — preDispatchCheck (after the validators) and
    // preProviderCheck (at the Twilio handoff, after the provider's own
    // awaits; codex #4810 r13). An outage there answers the same retryable
    // code the route-level 503 uses, never a raw exception message.
    const lateCheck = photoTriageLateCheck(recheckDraftOffer, draft, customerId, flags);
    return { blocked: false, preDispatchCheck: lateCheck, preProviderCheck: lateCheck };
  }
  const plainHold = PHOTO_TRIAGE_PLAIN_HOLDS[verdict.blocked];
  if (plainHold) {
    await releaseDraftClaim(draft.id);
    res.status(409).json(plainHold);
    return { blocked: true };
  }
  if (verdict.repriced !== undefined) {
    const nextFlags = { ...flags, quote: { ...(flags.quote || {}), per_visit: verdict.repriced }, quote_repriced_at: new Date().toISOString() };
    await releaseDraftClaim(draft.id, {
      flags: JSON.stringify(nextFlags),
      // The owner-only price sentence is replaced, never left stale.
      context_summary: replacePriceContext(draft.context_summary, priceContextSentence(verdict.family, verdict.repriced)),
    });
    res.status(409).json({
      error: `The offer core now prices ${verdict.family} at $${verdict.repriced.toFixed(2)} per application — the draft's owner-only figure was refreshed; review and approve again.`,
      code: 'PHOTO_TRIAGE_REPRICED',
    });
    return { blocked: true };
  }
  // Downgrade the stored gauge verdict on the released row so the owner's
  // next click passes the recheck instead of being held forever (pre-push
  // audit r6): mode → advise, the no-pitch reason recorded, the stale
  // owner-only quote dropped, AND the pitch sentence replaced in the draft
  // text itself — a plain second Approve must not send the stale ask.
  const stale = PHOTO_TRIAGE_STALE_HOLDS[verdict.blocked];
  const heldReason = stale.reason;
  const priorReasons = Array.isArray(flags.opportunity_reasons) ? flags.opportunity_reasons : [];
  const heldFlags = {
    ...flags,
    opportunity_mode: 'advise',
    opportunity_reasons: priorReasons.includes(heldReason) ? priorReasons : [...priorReasons, heldReason],
    quote: null,
    offer_recheck_held_at: new Date().toISOString(),
  };
  const why = stale.why(verdict.family);
  await releaseDraftClaim(draft.id, {
    flags: JSON.stringify(heldFlags),
    draft_response: stripQuotePitch(draft.draft_response),
    context_summary: replacePriceContext(draft.context_summary, `Held at approve: ${why}; the quote ask was removed.`),
  });
  res.status(409).json({
    error: `Photo-triage draft held: ${why} — the quote ask was removed from the draft; review the new copy, then approve.`,
    code: 'PHOTO_TRIAGE_OFFER_STALE',
  });
  return { blocked: true };
}

// Post-guard failure release. A clarify draft past its dispatch decision
// must reconcile UNDER the clarify lock — plain releaseDraftClaim is
// unconditional, so it could resurrect a concurrently rejected draft and it
// can't honor answers a reply recorded during the send window. If the
// locked reconciliation itself fails, the draft is deliberately LEFT
// CLAIMED (the same stuck-claim surface every draft lane has on a
// double-failure) rather than force-released blind.
async function releaseFailedSendClaim(draft, clarifyGuard, releaseFields = {}) {
  if (draft.intent === 'estimate_clarify' && clarifyGuard?.dispatchCommitted) {
    const { reopenClarifyAfterFailedSend } = require('../services/estimate-clarify-asks');
    const result = await reopenClarifyAfterFailedSend({
      draftId: draft.id,
      dispatchedMissing: clarifyGuard.dispatchedMissing,
      releaseFields,
    });
    if (!result.reopened && !result.retired) {
      logger.warn(`[admin-drafts] clarify failed-send reconciliation unavailable — draft ${draft.id} left claimed for manual recovery`);
    }
    return;
  }
  await releaseDraftClaim(draft.id, releaseFields);
}

async function guardCampaignSend(draft, req, res, releaseFields = {}) {
  if (!draft.campaign_type) return { blocked: false };

  await releaseDraftClaim(draft.id, releaseFields);
  res.status(409).json({
    error: 'Campaign drafts are disabled (the campaign draft generators were removed) — draft left pending; reject it',
    code: 'CAMPAIGN_GATE_OFF',
  });
  return { blocked: true };
}

/** Finalize a draft after a REAL provider send. */
async function finalizeDraftSend(draft, updates) {
  await db('message_drafts').where({ id: draft.id }).update(updates);
}

// GET /api/admin/drafts — pending drafts
// Optional ?campaign_type= filter: 'reactivation' | 'upsell' scopes to that
// campaign; 'none' scopes to legacy non-campaign drafts (inbound-reply lane).
router.get('/', async (req, res, next) => {
  try {
    const { status = 'pending', campaign_type: campaignType } = req.query;
    // Cursor pagination over a LIVE set: an offset would shift under
    // concurrent inserts/approvals and could return overlapping pages
    // forever (Codex #3700 r2 P1). The cursor is the last row's ID; its
    // (created_at, id) position is re-read IN SQL via a subquery so the
    // timestamp round-trips at full PostgreSQL microsecond precision — a
    // JS Date cursor truncates to milliseconds and can skip rows inside
    // the truncated window (r3 P1). Ties on created_at break by id in
    // both the ORDER BY and the tuple comparison. Draft rows are never
    // deleted (status transitions only), so the anchor persists.
    let cursorId = null;
    if (req.query.before) {
      cursorId = String(req.query.before);
      // UUID-shape check BEFORE the lookup: binding a malformed value
      // against the uuid id column raises 22P02 and turns the intended 400
      // into a 500 (Codex #3700 r3 P2).
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursorId)) {
        return res.status(400).json({ error: 'Invalid before cursor' });
      }
      const anchor = await db('message_drafts').where({ id: cursorId }).first('id');
      if (!anchor) return res.status(400).json({ error: 'Invalid before cursor' });
    }
    let query = db('message_drafts')
      .where(status === 'all' ? {} : { status })
      .leftJoin('customers', 'message_drafts.customer_id', 'customers.id')
      .select('message_drafts.*', 'customers.first_name', 'customers.last_name',
        'customers.phone', 'customers.waveguard_tier', 'customers.pipeline_stage',
        'customers.nearest_location_id', 'customers.city',
        'customers.zip as customer_zip', 'customers.latitude as customer_latitude',
        'customers.longitude as customer_longitude',
        'customers.address_line1 as customer_address_line1', 'customers.address_line2 as customer_address_line2',
        'customers.home_line_location_id as customer_home_line_location_id',
        'customers.home_line_address_key as customer_home_line_address_key')
      .orderBy('message_drafts.created_at', 'desc')
      .orderBy('message_drafts.id', 'desc')
      .limit(50);
    if (cursorId) {
      query = query.whereRaw(
        '(message_drafts.created_at, message_drafts.id) < (SELECT md.created_at, md.id FROM message_drafts md WHERE md.id = ?)',
        [cursorId],
      );
    }
    if (campaignType === 'none') {
      query = query.whereNull('message_drafts.campaign_type');
    } else if (campaignType) {
      query = query.where('message_drafts.campaign_type', campaignType);
    }
    const drafts = await query;
    const last = drafts.length === 50 ? drafts[drafts.length - 1] : null;
    const nextCursor = last ? String(last.id) : null;

    // The list must promise the SAME recipient/from the approve path will
    // use (resolveDraftRecipient: sms_log thread first, then flags, then
    // customer) — the flags-only guess could name one number while Approve
    // texts another (Codex #3700 P1). Resolution failure falls back to the
    // legacy guess rather than dropping the row. Resolution is fed from
    // ONE sms_log batch read plus the customer columns the page query
    // already joined, so a full page stays at a fixed query count instead
    // of two lookups per draft (Codex #3700 r9 P2).
    const smsLogIds = drafts.map((d) => d.sms_log_id).filter(Boolean);
    const smsLogs = smsLogIds.length ? await db('sms_log').whereIn('id', smsLogIds) : [];
    const smsLogById = new Map(smsLogs.map((row) => [String(row.id), row]));
    const resolved = await Promise.all(drafts.map(async (d) => {
      const customer = d.customer_id ? {
        id: d.customer_id, phone: d.phone, city: d.city,
        zip: d.customer_zip, latitude: d.customer_latitude, longitude: d.customer_longitude,
        address_line1: d.customer_address_line1, address_line2: d.customer_address_line2,
        home_line_location_id: d.customer_home_line_location_id,
        home_line_address_key: d.customer_home_line_address_key,
      } : null;
      const preloaded = { customer, ...(d.sms_log_id ? { smsLog: smsLogById.get(String(d.sms_log_id)) || null } : {}) };
      const r = await resolveDraftRecipient(d, preloaded).catch(() => null);
      const fromNumber = r?.fromNumber || await derivedOfficeNumber(d, r?.customerId, customer);
      const fromLabel = fromNumber ? (TWILIO_NUMBERS.findByNumber(fromNumber)?.label || null) : null;
      return { r, fromNumber, fromLabel };
    }));

    res.json({
      drafts: drafts.map((d, i) => {
        const flags = parseFlags(d.flags);
        const { r, fromNumber, fromLabel } = resolved[i];
        return {
          id: d.id, smsLogId: d.sms_log_id,
          customerId: d.customer_id,
          customerName: d.first_name ? `${d.first_name} ${d.last_name}` : 'Unknown',
          customerPhone: d.phone || null,
          recipientPhone: r?.toPhone || flags.phone || flags.toPhone || flags.leadPhone || d.phone || null,
          resolvedFromNumber: fromNumber || null,
          resolvedFromLabel: fromLabel,
          tier: d.waveguard_tier, stage: d.pipeline_stage,
          inboundMessage: d.inbound_message,
          draftResponse: d.draft_response,
          revisedResponse: d.revised_response,
          finalResponse: d.final_response,
          intent: d.intent, intentConfidence: d.intent_confidence,
          contextSummary: d.context_summary,
          flags,
          campaignType: d.campaign_type || null,
          purpose: d.purpose || null,
          sourceRef: d.source_ref || null,
          status: d.status, responseTimeSeconds: d.response_time_seconds,
          createdAt: d.created_at, approvedAt: d.approved_at, sentAt: d.sent_at,
        };
      }),
      pendingCount: await db('message_drafts').where({ status: 'pending' }).count('* as count').first().then(r => parseInt(r.count)),
      nextCursor,
    });
  } catch (err) { next(err); }
});

// PUT /api/admin/drafts/:id/approve — approve and send as-is
router.put('/:id/approve', async (req, res, next) => {
  try {
    const requestedFromNumber = req.body?.fromNumber || null;
    if (requestedFromNumber && !TWILIO_NUMBERS.findByNumber(requestedFromNumber)) {
      return res.status(400).json({ error: 'fromNumber must be a Waves Twilio number' });
    }

    const claimTime = new Date();
    const [draft] = await db('message_drafts')
      .where({ id: req.params.id, status: 'pending' })
      .update({
        status: 'approved',
        approved_by: req.technicianId,
        approved_at: claimTime,
      })
      .returning('*');
    if (!draft) {
      const existing = await db('message_drafts').where({ id: req.params.id }).first();
      if (!existing) return res.status(404).json({ error: 'Draft not found' });
      return res.status(409).json({ error: 'Draft is no longer pending' });
    }

    // An Auto Pay setup link never rides draft approval: only the composer's
    // /sms carries the delivery seam (levers, liveness, ownership,
    // reclassification) — refuse and hand the claim back (GH Codex #3812 r3 P1).
    // The claim is already taken, so a lookup failure inside the check must
    // hand it back too (GH Codex #3812 r4 P2) — never strand the draft.
    let immediateOnlyRefusal = null;
    try {
      immediateOnlyRefusal = await draftImmediateOnlyLinkRefusal(draft.draft_response);
    } catch (checkErr) {
      logger.warn(`[drafts] Auto Pay link check failed for draft ${draft.id} — releasing claim: ${checkErr.message}`);
      await releaseUndecidedClaim(draft);
      return res.status(503).json({ error: 'Pre-send check unavailable - draft left pending, try again' });
    }
    if (immediateOnlyRefusal) {
      await releaseUndecidedClaim(draft);
      return res.status(409).json({ error: immediateOnlyRefusal });
    }

    // Leftover campaign drafts cannot be sent (guardCampaignSend).
    const campaignGuard = await guardCampaignSend(draft, req, res);
    if (campaignGuard.blocked) return;

    // Recipient + policy resolve BEFORE the clarify decision: both are
    // decision-invariant (toPhone, provenance, and estimate linkage never
    // change in the decision), and failures here happen pre-commitment — a
    // plain claim release suffices, nothing to reconcile.
    const recipientGuard = await guardDraftRecipient(draft, await resolveDraftRecipient(draft), res);
    if (recipientGuard.blocked) return;
    const { recipient } = recipientGuard;
    const toPhone = recipient.toPhone;
    const fromNumber = requestedFromNumber || recipient.fromNumber || undefined;

    if (!toPhone) {
      // Unreachable for clarify drafts by construction (park requires a
      // usable phone) — but if it ever fires, the release must still be
      // reject-safe.
      await releaseUndecidedClaim(draft);
      return res.status(400).json({ error: 'Cannot determine recipient phone' });
    }
    const sendPolicy = sendPolicyForDraft(draft, recipient);

    // Clarify dispatch decision runs LAST — there is no await between its
    // commit and the provider call below, so a reply can only land fully
    // before the decision (honored under the lock: rewrite/retire/abort)
    // or race the already-in-flight SMS, which no server-side ordering can
    // remove.
    const clarifyGuard = await guardClarifySend(draft, res);
    if (clarifyGuard.blocked) return;
    const photoTriageGuard = await guardPhotoTriageSend(draft, res, { customerId: recipient.customerId });
    if (photoTriageGuard.blocked) return;
    let smsResult;
    try {
      smsResult = await sendManualCustomerSms({
        to: toPhone,
        body: draft.draft_response,
        channel: 'sms',
        // Unified policy passthrough: clarify drafts ride the estimate
        // rails; campaign drafts pass their real purpose through
        // (marketing-grade purposes carry the stored-preference
        // consentBasis); legacy null-purpose drafts keep the conversational
        // shape exactly.
        ...sendPolicy,
        // At most one is set: clarify and photo-triage drafts are distinct intents.
        preDispatchCheck: clarifyGuard.preDispatchCheck || photoTriageGuard.preDispatchCheck,
        // Recipient recheck first; the photo-triage offer recheck runs on a pass.
        preProviderCheck: recipientGuard.lateCheck(photoTriageGuard.preProviderCheck),
        customerId: recipient.customerId || undefined,
        identityTrustLevel: recipient.identityTrustLevel,
        entryPoint: 'admin_draft_approve',
        metadata: {
          original_message_type: 'ai_approved',
          draft_id: draft.id,
          source_ref: draft.source_ref || undefined,
          adminUserId: req.technicianId,
          fromNumber,
        },
      });
    } catch (sendErr) {
      if (manualSmsDeliveryState(sendErr) === 'uncertain') {
        return uncertainSendResponse(res);
      }
      await releaseFailedSendClaim(draft, clarifyGuard);
      throw sendErr;
    }
    if (manualSmsDeliveryState(smsResult) === 'uncertain') {
      // This outcome describes an older wrapper reservation; this draft never
      // reached the provider. Keep the older reservation as the no-retry
      // fence, but hand back only this draft's newly-taken approval claim.
      if (priorManualSendStillUnresolved(smsResult)) {
        await releaseFailedSendClaim(draft, clarifyGuard);
      }
      return uncertainSendResponse(res);
    }
    if (!smsResult.sent) {
      await releaseFailedSendClaim(draft, clarifyGuard);
      return blockedSendResponse(res, smsResult);
    }
    // An approved REPLY draft delivered to the customer is a first response
    // for any open lead on this phone (SLA truth only; status/linkage
    // untouched). Gated on a real provider send: suppression paths report
    // sent:true with a sentinel id.
    // Fail-soft — bookkeeping never breaks the approval.
    try {
      const { isRealProviderSend } = require('../services/sms-auto-send');
      if (isRealProviderSend(smsResult)) {
        const { stampFirstResponseByContact } = require('../services/lead-estimate-link');
        await stampFirstResponseByContact({
          phone: toPhone,
          performedBy: req.technicianId ? `admin:${req.technicianId}` : 'admin',
        });
      }
    } catch (stampErr) {
      logger.warn(`[admin-drafts] first-response stamp failed: ${stampErr.message}`);
    }

    const responseTime = Math.round((Date.now() - new Date(draft.created_at)) / 1000);

    await finalizeDraftSend(draft, {
      final_response: draft.draft_response,
      sent_at: new Date(),
      response_time_seconds: responseTime,
    });

    res.json({ success: true, responseTimeSeconds: responseTime });
  } catch (err) { next(err); }
});

// PUT /api/admin/drafts/:id/revise — edit and send
router.put('/:id/revise', async (req, res, next) => {
  try {
    const { revisedResponse } = req.body;
    if (!revisedResponse) return res.status(400).json({ error: 'revisedResponse required' });
    const linkedVisitIds = require('../services/street-level-hold').linkedVisitIdsFrom(req.body?.linkedVisitIds);
    // Same rule as approve — judged before the claim, nothing to release.
    const reviseRefusal = await draftImmediateOnlyLinkRefusal(revisedResponse);
    if (reviseRefusal) return res.status(409).json({ error: reviseRefusal });
    const requestedFromNumber = req.body?.fromNumber || null;
    if (requestedFromNumber && !TWILIO_NUMBERS.findByNumber(requestedFromNumber)) {
      return res.status(400).json({ error: 'fromNumber must be a Waves Twilio number' });
    }

    const claimTime = new Date();
    const [draft] = await db('message_drafts')
      .where({ id: req.params.id, status: 'pending' })
      .update({
        status: 'revised',
        revised_response: revisedResponse,
        final_response: revisedResponse,
        approved_by: req.technicianId,
        approved_at: claimTime,
        // Review provenance: the corrections view counts a revised draft
        // only when this endpoint wrote it (the system also sets approved_by).
        flags: reviewVerdictStamp(db, 'revised'),
      })
      .returning('*');
    if (!draft) {
      const existing = await db('message_drafts').where({ id: req.params.id }).first();
      if (!existing) return res.status(404).json({ error: 'Draft not found' });
      return res.status(409).json({ error: 'Draft is no longer pending' });
    }

    // Photo-triage drafts are approve-as-written or reject (codex #4810
    // r7–r11): their dispatch recheck reads the stored gauge verdict, and
    // free operator wording is not something a text parser can hold to the
    // no-price / no-pitch-an-owned-family rules. Refused before any send
    // work; the claim goes back with the edit cleared.
    // Only gauge-written drafts (flags.gauge_version); an older or
    // hand-written photo-triage draft stays revisable (codex #4810 r14).
    const { isGaugedDraft } = require('../services/photo-triage-opportunity');
    if (draft.intent === 'photo_triage' && isGaugedDraft(parseFlags(draft.flags))) {
      await releaseDraftClaim(draft.id, { revised_response: null, final_response: null });
      return res.status(409).json({
        error: 'Photo-triage drafts can be approved as written or rejected, not revised — reject it and reply from the conversation.',
        code: 'PHOTO_TRIAGE_NOT_REVISABLE',
      });
    }

    // Leftover campaign drafts cannot be sent (guardCampaignSend).
    const campaignGuard = await guardCampaignSend(draft, req, res, { revised_response: null, final_response: null });
    if (campaignGuard.blocked) return;

    // Same order contract as the approve route: recipient + policy are
    // decision-invariant and resolve pre-commitment; the clarify decision
    // runs LAST with no await between its commit and the provider call.
    const recipientGuard = await guardDraftRecipient(draft, await resolveDraftRecipient(draft), res, { revised_response: null, final_response: null });
    if (recipientGuard.blocked) return;
    const { recipient } = recipientGuard;
    const toPhone = recipient.toPhone;
    const fromNumber = requestedFromNumber || recipient.fromNumber || undefined;

    if (!toPhone) {
      // Same reject-safe release rule as the approve route.
      await releaseUndecidedClaim(draft, { revised_response: null, final_response: null });
      return res.status(400).json({ error: 'Cannot determine recipient' });
    }
    const sendPolicy = sendPolicyForDraft(draft, recipient);

    const clarifyGuard = await guardClarifySend(draft, res, { revised_response: null, final_response: null }, { isRevision: true });
    if (clarifyGuard.blocked) return;
    let smsResult;
    try {
      smsResult = await sendManualCustomerSms({
        to: toPhone,
        body: revisedResponse,
        channel: 'sms',
        // Unified policy passthrough: clarify drafts ride the estimate
        // rails; campaign drafts pass their real purpose through
        // (marketing-grade purposes carry the stored-preference
        // consentBasis); legacy null-purpose drafts keep the conversational
        // shape exactly.
        ...sendPolicy,
        preDispatchCheck: clarifyGuard.preDispatchCheck,
        preProviderCheck: recipientGuard.lateCheck(),
        customerId: recipient.customerId || undefined,
        identityTrustLevel: recipient.identityTrustLevel,
        entryPoint: 'admin_draft_revise',
        metadata: {
          original_message_type: 'ai_revised',
          draft_id: draft.id,
          source_ref: draft.source_ref || undefined,
          adminUserId: req.technicianId,
          fromNumber,
          // The visits the revised text's reschedule / appointment links point at (the composer sends them):
          // the shared send step holds the text while any is a live street-level address hold.
          ...(linkedVisitIds.length ? { linked_scheduled_service_ids: linkedVisitIds } : {}),
        },
      });
    } catch (sendErr) {
      if (manualSmsDeliveryState(sendErr) === 'uncertain') {
        return uncertainSendResponse(res);
      }
      await releaseFailedSendClaim(draft, clarifyGuard, { revised_response: null, final_response: null });
      throw sendErr;
    }
    if (manualSmsDeliveryState(smsResult) === 'uncertain') {
      if (priorManualSendStillUnresolved(smsResult)) {
        await releaseFailedSendClaim(draft, clarifyGuard, { revised_response: null, final_response: null });
      }
      return uncertainSendResponse(res);
    }
    if (!smsResult.sent) {
      await releaseFailedSendClaim(draft, clarifyGuard, { revised_response: null, final_response: null });
      return blockedSendResponse(res, smsResult);
    }
    // Same first-response stamp as the approve route — an edited-and-sent
    // REPLY draft is still an operator reply; suppression sentinels don't
    // count as sends.
    try {
      const { isRealProviderSend } = require('../services/sms-auto-send');
      if (isRealProviderSend(smsResult)) {
        const { stampFirstResponseByContact } = require('../services/lead-estimate-link');
        await stampFirstResponseByContact({
          phone: toPhone,
          performedBy: req.technicianId ? `admin:${req.technicianId}` : 'admin',
        });
      }
    } catch (stampErr) {
      logger.warn(`[admin-drafts] first-response stamp failed: ${stampErr.message}`);
    }

    const responseTime = Math.round((Date.now() - new Date(draft.created_at)) / 1000);

    await finalizeDraftSend(draft, {
      sent_at: new Date(),
      response_time_seconds: responseTime,
    });

    res.json({ success: true, responseTimeSeconds: responseTime });
  } catch (err) { next(err); }
});

// PUT /api/admin/drafts/:id/reject
router.put('/:id/reject', async (req, res, next) => {
  try {
    // Pending-only, same as approve/revise: with a list surface, concurrent
    // owner sessions are real — an unconditional update-by-id would relabel
    // an already-SENT row as rejected and report success.
    const updated = await db('message_drafts')
      .where({ id: req.params.id, status: 'pending' })
      .update({
        status: 'rejected', approved_by: req.technicianId, approved_at: new Date(),
        // Review provenance, see /:id/revise.
        flags: reviewVerdictStamp(db, 'rejected'),
      });
    if (!updated) {
      const existing = await db('message_drafts').where({ id: req.params.id }).first();
      if (!existing) return res.status(404).json({ error: 'Draft not found' });
      return res.status(409).json({ error: 'Draft is no longer pending' });
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/admin/drafts/stats — response time analytics
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await db('message_drafts')
      .whereIn('status', ['approved', 'revised'])
      .where('created_at', '>', new Date(Date.now() - 30 * 86400000))
      .select(
        db.raw('AVG(response_time_seconds) as avg_seconds'),
        db.raw('MIN(response_time_seconds) as min_seconds'),
        db.raw('MAX(response_time_seconds) as max_seconds'),
        db.raw("COUNT(*) FILTER (WHERE response_time_seconds < 300) as under_5min"),
        db.raw("COUNT(*) FILTER (WHERE response_time_seconds < 900) as under_15min"),
        db.raw("COUNT(*) FILTER (WHERE response_time_seconds > 3600) as over_1hr"),
        db.raw('COUNT(*) as total'),
      ).first();

    res.json({
      avgMinutes: stats.avg_seconds ? Math.round(parseFloat(stats.avg_seconds) / 60 * 10) / 10 : 0,
      under5min: parseInt(stats.under_5min || 0),
      under15min: parseInt(stats.under_15min || 0),
      over1hr: parseInt(stats.over_1hr || 0),
      total: parseInt(stats.total || 0),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/drafts/:id — single draft for compose deep-links
router.get('/:id', async (req, res, next) => {
  try {
    const d = await db('message_drafts')
      .where('message_drafts.id', req.params.id)
      .leftJoin('customers', 'message_drafts.customer_id', 'customers.id')
      .select(
        'message_drafts.*',
        'customers.first_name',
        'customers.last_name',
        'customers.phone',
        'customers.waveguard_tier',
        'customers.pipeline_stage',
        'customers.nearest_location_id'
      )
      .first();
    if (!d) return res.status(404).json({ error: 'Draft not found' });
    // Technician scope (codex #5568 r3 P1): the draft carries the customer's
    // name, phone and both message bodies, so a technician reads only drafts
    // for customers on their own route; a customerless draft is office work.
    if (req.techRole !== 'admin') {
      if (!d.customer_id) return res.status(403).json({ error: 'Admin access required' });
      const { technicianServicesCustomer } = require('../services/technician-visit-scope');
      if (!(await technicianServicesCustomer(req, d.customer_id))) return res.status(404).json({ error: 'Draft not found' });
    }

    const flags = parseFlags(d.flags);
    // Same resolved recipient/from contract as the list (see GET / above).
    const r = await resolveDraftRecipient(d).catch(() => null);
    const singleFrom = r?.fromNumber || await derivedOfficeNumber(d, r?.customerId) || null;
    res.json({
      id: d.id,
      smsLogId: d.sms_log_id,
      customerId: d.customer_id,
      customerName: d.first_name ? `${d.first_name} ${d.last_name}` : 'Unknown',
      customerPhone: d.phone || null,
      recipientPhone: r?.toPhone || flags.phone || flags.toPhone || flags.leadPhone || d.phone || null,
      resolvedFromNumber: singleFrom,
      resolvedFromLabel: singleFrom ? (TWILIO_NUMBERS.findByNumber(singleFrom)?.label || null) : null,
      tier: d.waveguard_tier,
      stage: d.pipeline_stage,
      inboundMessage: d.inbound_message,
      draftResponse: d.draft_response,
      revisedResponse: d.revised_response,
      finalResponse: d.final_response,
      intent: d.intent,
      intentConfidence: d.intent_confidence,
      contextSummary: d.context_summary,
      flags,
      campaignType: d.campaign_type || null,
      purpose: d.purpose || null,
      sourceRef: d.source_ref || null,
      status: d.status,
      responseTimeSeconds: d.response_time_seconds,
      createdAt: d.created_at,
      approvedAt: d.approved_at,
      sentAt: d.sent_at,
    });
  } catch (err) { next(err); }
});

// Exposed for tests
router._internals = {
  draftSendPolicyFields, blockedSendResponse, finalizeDraftSend,
};

module.exports = router;
