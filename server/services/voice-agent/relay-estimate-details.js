/**
 * The details of a written-estimate request on a Sandy call: what the caller
 * said, what an established customer confirmed from their account, where the
 * request is filed, and what the agent is told about it. capture_lead
 * (relay-tools) calls these in order; nothing here speaks to the caller.
 *
 * Three rules hold everything together.
 *
 * ⭐ THE CALL REMEMBERS ONLY WHAT THE CALLER SAID, PLUS THE YES. The account's
 * details are never stored with the call's fields: they are read fresh on
 * every capture and fill only what the caller has not stated by then. So
 * nothing borrowed can outlive a correction, and there is nothing to delete.
 *
 * ⭐ AN ADDRESS IS ONE THING. A stated part is never completed from another
 * source, and a part that replaces an earlier one replaces the whole address.
 *
 * ⭐ A PROMISE ALREADY SPOKEN STANDS. A later capture may correct where the
 * estimate goes; it never withdraws, re-times or rewords the promise.
 */

const logger = require('../logger');

const LOCATION = ['address_line1', 'city', 'zip'];
const REQUIRED = ['first_name', 'last_name', 'email', 'address_line1'];
const CARRIED = ['first_name', 'last_name', 'email', ...LOCATION, 'requested_service', 'pain_points'];
// Stored in place of a location part the caller replaced: the call's store
// only adds, and a reconnect rebuilds it by merging every leg's fields, so a
// replaced part is OVERWRITTEN with this marker (read back as empty) and the
// marker wins that merge like any later value.
const ESTIMATE_FIELD_REPLACED = '(replaced)';

// Whitespace-only is EMPTY (hook P1): a field must carry real text to count.
const nz = (v) => (v != null && String(v).trim() !== '' ? String(v).trim() : null);
const sameText = (x, y) => String(x).trim().toLowerCase() === String(y).trim().toLowerCase();
const note = (ctx, fields) => { if (typeof ctx.noteEstimateFields === 'function') ctx.noteEstimateFields(fields); };

/**
 * The account details a written estimate may use once the caller CONFIRMS
 * them (capture_lead `use_account_details`), or null. Only for a verified
 * full-tier caller (the calling number IS the account's own customers.phone)
 * who is an established customer speaking for themselves, on an account with
 * exactly one address to confirm. Fail-soft: an unanswerable read is null.
 */
async function accountDetailsForEstimate(ctx = {}, stated = {}) {
  if (!ctx.customerId || ctx.callerVerified !== true || ctx.customerTier !== 'full') return null;
  // The caller-context kill switch is read at execution time, like every
  // other account read: a call already in progress stops reading the moment
  // it is turned off, whatever tool list the session cached.
  if (!require('./relay-context').isContextEnabled()) return null;
  try {
    const db = require('../../models/db');
    const row = await db('customers').where({ id: ctx.customerId }).whereNull('deleted_at')
      .first('id', 'account_id', 'first_name', 'last_name', 'email', 'address_line1', 'city', 'zip', 'pipeline_stage');
    if (!row) return null;
    // A row still in the lead pipeline, or a caller who gave a different first
    // name, opens a LEAD under the lead writer's own rules: ordinary intake.
    const { isLeadStage, nameConflicts } = require('../lead-from-extraction');
    if (isLeadStage(row.pipeline_stage) || nameConflicts({ first_name: stated.first_name }, row)) return null;
    // An account can hold its properties as SIBLING customer profiles (one
    // account_id, one profile per property). Another live profile is another
    // address "on your account". Same predicate as booking's property match.
    const accountId = row.account_id || row.id;
    const sibling = await db('customers')
      .where(function () { this.where('account_id', accountId).orWhere('id', accountId); })
      .whereNot('id', row.id)
      .whereNull('deleted_at')
      .andWhere(function () { this.whereNull('active').orWhere('active', true); })
      .first('id');
    if (sibling) return null;
    // WHICH address: the customers row mirrors the primary property, which
    // can be retired while another stays active. Exactly one ACTIVE property
    // row → that row's own address (read directly; never matched through the
    // mirror). No property rows at all (a legacy account) → the mirror.
    // Several active, or none active but some retired, has no single address.
    const properties = await db('customer_properties').where({ customer_id: ctx.customerId })
      .select('address_line1', 'city', 'zip', 'active');
    const active = properties.filter((prop) => prop.active === true);
    if (active.length > 1) return null;
    if (active.length === 0) return properties.length === 0 ? row : null;
    return { ...row, address_line1: active[0].address_line1 || null, city: active[0].city || null, zip: active[0].zip || null };
  } catch (err) {
    logger.warn(`[voice-relay] account details for an estimate could not be read callSid=${ctx.callSid || 'n/a'}: ${err.message}`);
    return null;
  }
}

/**
 * How each account detail may complete a request, in one table. `values`
 * returns what the account can supply for that detail given the call so far
 * (null when it must not be used); `offer` says whether supplying it is worth
 * asking the caller the yes/no question (the question names the email and
 * the service address — a yes also takes the account holder's own name).
 */
const ACCOUNT_FILLS = [
  { tag: 'name', offer: false, values: (acct) => ({ first_name: nz(acct.first_name), last_name: nz(acct.last_name) }) },
  {
    tag: 'email',
    offer: true,
    // An email the caller gave but that could not be read is the caller
    // naming another address: the account's never stands in for it.
    values: (acct, call) => (!call.emailUnreadable && nz(acct.email) && call.isValidEmail(nz(acct.email)) ? { email: nz(acct.email) } : null),
  },
  {
    tag: 'address',
    offer: true,
    // Whole, and only when the caller stated no part of a location and the
    // account's is a full address.
    values: (acct, call) => (!call.statedLocation && nz(acct.address_line1) && (nz(acct.city) || nz(acct.zip))
      ? Object.fromEntries(LOCATION.map((k) => [k, nz(acct[k])])) : null),
  },
];

/** Fills `fields` from the account when `apply`; reports what it used and whether asking would help. */
function applyAccountFills(fields, acct, call, apply) {
  const used = [];
  let worthAsking = false;
  for (const fill of ACCOUNT_FILLS) {
    const missing = Object.entries(fill.values(acct, call) || {}).filter(([k, v]) => v && !fields[k]);
    if (!missing.length) continue;
    worthAsking = worthAsking || fill.offer;
    if (apply) {
      Object.assign(fields, Object.fromEntries(missing));
      used.push(fill.tag);
    }
  }
  return { used, worthAsking };
}

/** The call's remembered fields, with replaced location parts read back as empty. */
function rememberedFields(ctx) {
  const stored = typeof ctx.getEstimateFields === 'function' ? (ctx.getEstimateFields() || {}) : {};
  return Object.fromEntries(Object.entries(stored).filter(([, v]) => v !== ESTIMATE_FIELD_REPLACED));
}

/**
 * A location part that REPLACES one the caller gave earlier means a different
 * property: the earlier location goes, whole, and what this capture did not
 * restate is asked for — never an old street under a new city. A retry that
 * only ADDS a missing part, or restates the same one, still accumulates.
 */
function dropReplacedLocation(prior, extracted, ctx) {
  const replaced = LOCATION.some((k) => nz(extracted[k]) && nz(prior[k]) && !sameText(extracted[k], prior[k]));
  if (!replaced) return;
  for (const k of LOCATION) delete prior[k];
  note(ctx, Object.fromEntries(LOCATION.map((k) => [k, ESTIMATE_FIELD_REPLACED])));
}

/**
 * Resolves a capture's estimate details. Mutates nothing but the call's own
 * store (through ctx; it keeps only non-empty values). Returns:
 *   estimateFields       what the request has (stated, plus confirmed account details)
 *   detailsFromAccount   which of them are the account's ('name' | 'email' | 'address')
 *   estimateMissing      the required fields still absent ([] when not an estimate)
 *   offerAccountQuestion whether this capture's result should offer the one question
 *   callbackPhone        the number the caller chose, kept across captures
 */
async function resolveEstimateDetails({ input, extracted, emailNow, estimateRequested, callerPhone, callerPhoneValid, isValidEmail, ctx }) {
  const prior = rememberedFields(ctx);
  const emailUnreadable = !emailNow && (Boolean(nz(input.email)) || prior.email_unreadable === 'true');
  dropReplacedLocation(prior, extracted, ctx);
  // Fields accumulate across captures on this call (hook P1): a retry that
  // supplies only the missing piece keeps what earlier captures gave.
  const estimateFields = Object.fromEntries(CARRIED.map((k) => [k, (k === 'email' ? emailNow : nz(extracted[k])) || nz(prior[k])]));
  const stated = { ...estimateFields };
  // A yes only counts as the answer to a question the TOOL offered on an
  // earlier capture of this call: the flag on its own confirms nothing.
  const offered = prior.account_question_offered === 'true';
  const yesToOffer = input.use_account_details === true && offered;
  const confirmed = yesToOffer || prior.account_details_confirmed === 'true';
  const { used, worthAsking } = await accountFillsFor({ estimateRequested, estimateFields, stated, emailUnreadable, isValidEmail, confirmed, ctx });
  const estimateMissing = estimateRequested ? REQUIRED.filter((k) => !estimateFields[k]) : [];
  const chosenCallback = input.callback_phone && callerPhoneValid ? callerPhone : null;
  note(ctx, {
    ...stated,
    // Remembered until a readable email arrives.
    email_unreadable: emailUnreadable && !stated.email ? 'true' : null,
    // The callback number the caller chose is remembered too: a later
    // capture that omits it must not put the inbound number back on the card.
    callback_phone: chosenCallback,
    // The yes is remembered whether or not the account could be read just
    // now: eligibility is re-proven on every capture.
    account_details_confirmed: yesToOffer ? 'true' : null,
  });
  return {
    estimateFields,
    detailsFromAccount: used,
    estimateMissing,
    // ONE question means asked once, and only when it would help.
    offerAccountQuestion: worthAsking && !confirmed && !offered && estimateMissing.length > 0,
    callbackPhone: (input.callback_phone ? callerPhone : (nz(prior.callback_phone) || callerPhone)) || null,
  };
}

/** Reads the account only when the request still lacks something, and fills from it after a yes. */
async function accountFillsFor({ estimateRequested, estimateFields, stated, emailUnreadable, isValidEmail, confirmed, ctx }) {
  if (!estimateRequested || REQUIRED.every((k) => estimateFields[k])) return { used: [], worthAsking: false };
  const account = await accountDetailsForEstimate(ctx, stated);
  if (!account) return { used: [], worthAsking: false };
  const call = { emailUnreadable, isValidEmail, statedLocation: LOCATION.some((k) => stated[k]) };
  return applyAccountFills(estimateFields, account, call, confirmed);
}

/**
 * ⭐ A PROMISED ESTIMATE NEEDS AN ARTIFACT (codex #3569). A new lead IS the
 * artifact. A lifecycle customer gets no lead, so the estimate-request card
 * is filed — or, when the request is incomplete, a card an earlier capture on
 * this call queued is revised (revise-only: with none standing nothing is
 * filed). Returns `{ estimateQueued, cardRevised }`; estimateQueued is null
 * when no estimate was requested.
 */
async function fileEstimateRequest({ estimateRequested, estimateMissing, leadCreated, customerId, details, cardOpts }) {
  if (!estimateRequested) return { estimateQueued: null, cardRevised: false };
  const incomplete = estimateMissing.length > 0;
  if (leadCreated) return { estimateQueued: !incomplete, cardRevised: false };
  if (!customerId) return { estimateQueued: false, cardRevised: false };
  const { surfaceEstimateRequestForCustomer } = require('../lead-from-extraction');
  if (typeof surfaceEstimateRequestForCustomer !== 'function') return { estimateQueued: false, cardRevised: false };
  const written = await surfaceEstimateRequestForCustomer(customerId, details, incomplete ? { ...cardOpts, stillMissing: estimateMissing } : cardOpts);
  const persisted = Boolean(written && written.persisted === true);
  return { estimateQueued: !incomplete && persisted, cardRevised: incomplete && persisted };
}

const RETRY = 'Ask for what is missing and call capture_lead again with estimate_requested: true. ';
// What the agent is told, by outcome. `standing` = an estimate an earlier
// capture queued was already promised aloud on this call.
const ESTIMATE_NOTES = {
  queued: (s) => ` The estimate request IS on the office queue. ${s.expectationCopy}`,
  missing: (s) => ` IMPORTANT: the estimate request is NOT queued yet — still missing: ${s.estimateMissing.join(', ')}. `
    + 'Do NOT promise a written estimate yet; ask for what is missing and call capture_lead again with '
    + 'estimate_requested: true. If the caller declines to give it, respect that: call capture_lead again '
    + 'WITHOUT estimate_requested (the estimate is dropped), tell them a Waves team member will follow up, '
    + 'and end the call normally.',
  // The promise is still owed, so the caller is never told it was dropped.
  // The no-flag capture releases the keep-the-call-open hold and withdraws
  // nothing. The card is said to be marked only when that write persisted.
  standing_missing: (s) => ` IMPORTANT: the estimate request is NOT queued yet — still missing: ${s.estimateMissing.join(', ')}. `
    + (s.cardRevised
      ? 'The estimate already promised on this call stays on the office queue, marked that these details need confirming. '
      : 'The estimate already promised on this call is still owed, but this change could NOT be saved to the office queue. ')
    + RETRY
    + 'If the caller declines to give it, respect that: call capture_lead again WITHOUT estimate_requested '
    + '(that closes the collection; the estimate already promised stays owed), tell them a Waves '
    + 'team member will call you back to confirm where to send it, and end the call normally.',
  standing_unsaved: () => ' IMPORTANT: the estimate already promised on this call is still owed, but these corrected details '
    + 'could NOT be saved to the office queue. Do not repeat the promise with the new details: tell the '
    + 'caller a Waves team member will call you back to confirm where to send it.',
  unqueued: () => ' IMPORTANT: the estimate request could NOT be queued — do NOT promise a written estimate. Say a '
    + 'Waves team member will follow up, nothing stronger.',
};
const ACCOUNT_QUESTION = ' This caller is an established customer, so instead you may ask ONE question — "Should it go to '
  + 'the email and service address on your account?" — and on a YES call capture_lead again with '
  + 'estimate_requested: true and use_account_details: true. On a no, ask for the ones they want. '
  + 'Never read the account\'s details aloud.';

/** The estimate part of capture_lead's result ('' when no estimate was requested). */
function estimateResultNote(state, ctx = {}) {
  if (state.estimateQueued === null) return '';
  if (state.estimateQueued === true) return ESTIMATE_NOTES.queued(state);
  const incomplete = state.estimateMissing.length > 0;
  const outcome = `${state.promiseStands ? 'standing_' : ''}${incomplete ? 'missing' : 'unsaved'}`;
  const text = (ESTIMATE_NOTES[outcome] || ESTIMATE_NOTES.unqueued)(state);
  if (!(incomplete && state.offerAccountQuestion)) return text;
  // The offer is latched HERE, where the result that presents it is built: a
  // capture that failed earlier never showed it, so its retry still can.
  note(ctx, { account_question_offered: 'true' });
  return text + ACCOUNT_QUESTION;
}

module.exports = {
  ESTIMATE_FIELD_REPLACED, CARRIED, accountDetailsForEstimate, resolveEstimateDetails, fileEstimateRequest, estimateResultNote,
};
