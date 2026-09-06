'use strict';

/**
 * Cancel-flow C1/C2 — executors for an ACCEPTED resolution card.
 *
 * The engine (resolve.js + templates.js) only ever DESCRIBES an action
 * ({ type, ...params }); nothing here runs until the customer accepts the
 * card and the accept route has minted a committed + accepted
 * cancellation_cases row. Every executor:
 *  - is deterministic and idempotent per case (dedupe keys carry the case id),
 *  - never creates a contract, term, or fee (ground rule §1.4),
 *  - returns { effects: [customer-facing sentences], ...data } and throws a
 *    coded error when the action cannot be honored — the accept route then
 *    reports a truthful failure instead of a false receipt.
 *
 * Money (retention_offer) is the last resort and goes through the ledger's
 * own fail-closed grant; fixes (re-service, preferences, owner contact,
 * transfer, Away Mode, hold) are cheap office/task writes or existing
 * mechanisms — never a parallel booking path.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { familyLabel } = require('./templates');

function codedError(code, message, extra = {}) {
  const err = new Error(message || code);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const labelOf = (key) => familyLabel(key) || String(key || '').replace(/_/g, ' ');

async function timelineNote(customerId, subject, body) {
  try {
    await db('customer_interactions').insert({ customer_id: customerId, interaction_type: 'note', subject, body });
  } catch (err) {
    logger.warn(`[cancel-actions] timeline note failed for ${customerId}: ${err.message}`);
  }
}

// Owner-facing task with a per-case dedupe key: accepting the same card
// twice (double tap, retry) never raises two bells.
async function ownerTask({ customerId, caseId, kind, title, body, link = null, metadata = {} }) {
  const { notifyAdmin } = require('../notification-service');
  const row = await notifyAdmin('customer_retention', title, body, {
    icon: 'user-check',
    bell: true,
    link: link || `/admin/customers/${customerId}`,
    dedupeKey: `cancel_resolution:${kind}:${caseId}`,
    metadata: { kind, customerId, cancellationCaseId: caseId, ...metadata },
  });
  if (!row || !row.id) throw codedError('owner_task_failed', 'Could not open the office task');
  return row;
}

/* ------------------------------------------------------------------ */
/* retention_offer                                                      */
/* ------------------------------------------------------------------ */
async function executeRetentionOffer({ customerId, caseRow, action }) {
  const { grantRetentionOffer } = require('./retention-offer');
  const familyKey = action.familyKey;
  if (!familyKey) throw codedError('retention_offer_family_missing', 'The offer is missing its service');
  const offer = await grantRetentionOffer({
    customerId, cancellationCaseId: caseRow.id, familyKey, reasonCode: caseRow.reason_code,
  });
  const pct = Number(offer.percent_off);
  return {
    offerId: offer.id,
    effects: [
      `${pct}% off your next ${offer.max_charges} ${labelOf(familyKey)} charges, up to $${Number(offer.cap_amount).toFixed(0)} total, taken off each invoice as its own line.`,
      'Nothing else changes: same visits, same WaveGuard level, no term, and you can still cancel any time.',
    ],
  };
}

/* ------------------------------------------------------------------ */
/* book_reservice — hand the customer the existing re-service picker    */
/* ------------------------------------------------------------------ */
async function executeBookReservice({ customerId, caseRow, action }) {
  const { reserviceStreamlineAccess } = require('../reservice-link');
  const lane = action.lane || null;
  const access = await reserviceStreamlineAccess(customerId);
  const laneOk = access && (!lane || access.lanes.some((l) => (typeof l === 'string' ? l : l?.lane) === lane));
  if (access && laneOk) {
    const url = `/reservice/${access.token}`;
    await timelineNote(customerId, `Re-service accepted from the cancel flow (${lane || 'plan'})`,
      `Case ${caseRow.id}. Customer sent to the re-service picker${action.programChange ? ' with a program change flagged for our owner' : ''}.`);
    if (action.programChange) {
      await ownerTask({
        customerId, caseId: caseRow.id, kind: 'program_change',
        title: 'Cancel flow: customer accepted a re-service with a program change',
        body: `Review the ${lane || 'pest'} program before the next visit — repeat callbacks drove this. Case ${caseRow.id}.`,
      });
    }
    return { reserviceUrl: url, effects: ['Pick your re-service time on the next screen — there is no charge for it.', 'Our owner reviews your visit history before coming out.'] };
  }
  // No self-serve lane available: file the request so the office books it.
  const category = lane === 'lawn' ? 'lawn_concern' : 'pest_issue';
  const [row] = await db('service_requests').insert({
    customer_id: customerId,
    category,
    subject: 'Re-service requested from the cancel flow',
    description: `Customer accepted the free re-service card (case ${caseRow.id}). Book the callback${action.programChange ? ' and review the program' : ''}.`,
    urgency: 'routine',
    status: 'new',
  }).returning('id');
  await ownerTask({
    customerId, caseId: caseRow.id, kind: 'book_reservice',
    title: 'Cancel flow: book a free re-service',
    body: `Customer accepted the re-service card. Service request ${row?.id || ''}.`,
  });
  return { serviceRequestId: row?.id || null, effects: ['We will text you within 1 business day to book the free re-service.'] };
}

/* ------------------------------------------------------------------ */
/* owner_call / owner_text / transfer_request / configure_services      */
/* ------------------------------------------------------------------ */
async function executeOwnerContact({ customerId, caseRow, action, params }) {
  const wantsText = action.type === 'owner_text';
  await ownerTask({
    customerId, caseId: caseRow.id, kind: action.type,
    title: wantsText ? 'Cancel flow: customer asked for a text from you' : 'Cancel flow: customer asked for a call from you',
    body: `Reason: ${caseRow.reason_code || 'not given'}. ${params?.note ? `Customer note: ${String(params.note).slice(0, 300)}` : ''}`.trim(),
    metadata: { configure: action.configure === true },
  });
  return { effects: [wantsText ? 'Our owner will text you personally — usually the same day.' : 'Our owner will call you before your next visit.'] };
}

async function executeTransferRequest({ customerId, caseRow, params }) {
  const address = String(params?.newAddress || '').trim().slice(0, 400);
  if (!address) throw codedError('transfer_address_required', 'We need the new address to transfer the plan');
  await ownerTask({
    customerId, caseId: caseRow.id, kind: 'transfer_request',
    title: 'Cancel flow: WaveGuard transfer request',
    body: `Customer is moving and wants to take WaveGuard along. New address: ${address}. Reprice before approving; tenure and setup-fee waiver carry.`,
    metadata: { newAddress: address },
  });
  await timelineNote(customerId, 'Transfer request from the cancel flow', `Case ${caseRow.id}. New address on the office task.`);
  return { effects: ['Transfer request received. We price the new home first, then confirm with you — nothing changes until you approve it.'] };
}

async function executeConfigureServices({ customerId, caseRow, action, params }) {
  const keep = Array.isArray(params?.keepFamilies) ? params.keepFamilies.filter(Boolean) : [];
  await ownerTask({
    customerId, caseId: caseRow.id, kind: 'configure_services',
    title: 'Cancel flow: customer wants to keep some services',
    body: `Keep: ${keep.length ? keep.map(labelOf).join(', ') : 'not specified'}${action.suggest ? ` (suggested: ${action.suggest})` : ''}. Reprice the remaining plan and confirm.`,
    metadata: { keepFamilies: keep },
  });
  return { effects: ['We will reprice the services you keep and text you the new total to approve before anything changes.'] };
}

/* ------------------------------------------------------------------ */
/* set_preferences — writes the same allowlisted fields the portal does  */
/* ------------------------------------------------------------------ */
// EXACTLY the property_preferences enums (migration 20260401000005): the
// column rejects anything else, so the card must never offer it (codex r2 P1).
const PREFERRED_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const PREFERRED_TIMES = ['early_morning', 'morning', 'midday', 'afternoon'];

async function executeSetPreferences({ customerId, caseRow, params }) {
  // Canonical scheduler vocabulary ONLY (codex r1 P1): auto-dispatch's
  // normalizePreferences hard-filters on these exact keys — free text like
  // "Friday" or "after 3 PM" would persist verbatim and constrain nothing
  // while the receipt claims it does.
  const preferredDay = String(params?.preferredDay || '').trim().toLowerCase();
  const preferredTime = String(params?.preferredTime || '').trim().toLowerCase();
  if (!preferredDay && !preferredTime) throw codedError('preferences_required', 'Pick a service day or time');
  if (preferredDay && !PREFERRED_DAYS.includes(preferredDay)) throw codedError('preferences_invalid', 'Pick a day from the list');
  if (preferredTime && !PREFERRED_TIMES.includes(preferredTime)) throw codedError('preferences_invalid', 'Pick a time from the list');
  const updates = { updated_at: new Date() };
  if (preferredDay) updates.preferred_day = preferredDay;
  if (preferredTime) updates.preferred_time = preferredTime;
  const existing = await db('property_preferences').where({ customer_id: customerId }).first('id');
  if (existing) await db('property_preferences').where({ id: existing.id }).update(updates);
  else await db('property_preferences').insert({ customer_id: customerId, ...updates, created_at: new Date() });
  await timelineNote(customerId, 'Service preferences updated from the cancel flow',
    `Case ${caseRow.id}. Preferred day: ${preferredDay || '—'}; time: ${preferredTime || '—'}.`);
  const dayLabel = preferredDay ? preferredDay.charAt(0).toUpperCase() + preferredDay.slice(1) : '';
  const timeLabels = { early_morning: '8-10 AM', morning: '9-11 AM', midday: '11 AM-1 PM', afternoon: '1-5 PM' };
  return { effects: [`Your visits will be scheduled ${[dayLabel ? `on ${dayLabel}s` : '', preferredTime ? timeLabels[preferredTime] : ''].filter(Boolean).join(', ')} from now on. Reply to any reminder if a date does not work.`] };
}

/* ------------------------------------------------------------------ */
/* away_mode / hold / away_pairing — C2 primitives live in ./holds      */
/* ------------------------------------------------------------------ */
async function executeAwayMode({ customerId, caseRow, params }) {
  const { startAwayMode } = require('./holds');
  const result = await startAwayMode({ customerId, caseId: caseRow.id, until: params?.resumeDate || null });
  return { ...result, effects: [
    `Exterior-only visits continue while you are away${result.until ? ` (through ${result.untilDisplay})` : ''} — nobody needs to be home, and every report still lands in your inbox.`,
    'Your price and WaveGuard level do not change.',
  ] };
}

async function executeHold({ customerId, caseRow, action, params, families, deferTechNotices = false }) {
  const { startHold, cancelHold, emitHoldTechNotices } = require('./holds');
  const holdable = families.filter((f) => ['lawn_care', 'mosquito', 'tree_shrub'].includes(f));
  if (!holdable.length) throw codedError('hold_family_required', 'Nothing on this plan can be held');
  // Multi-family holds commit ALL or NOTHING (codex P0): a later family's
  // failure compensates every hold this accept just created — component
  // restored, tier protection released, visits moved back.
  const results = [];
  try {
    for (const familyKey of holdable) {
      results.push(await startHold({
        customerId, caseId: caseRow.id, familyKey, resumeOn: params?.resumeDate, maxDays: action.holdMaxDays || 180,
      }));
    }
  } catch (err) {
    for (const done of results.reverse()) {
      try { await cancelHold(done.holdId, { compensateVisits: true }); } catch (undoErr) {
        logger.error(`[cancel-actions] hold compensation failed for ${done.holdId}: ${undoErr.message}`);
      }
    }
    throw err;
  }
  // The techs hear about the moves only now — every family stands and no
  // compensation can revert them (the compensating moves are silent). An
  // away pairing defers further, until its Away Mode write also stands.
  const techNotices = results.flatMap((r) => r.techNotices || []);
  if (!deferTechNotices) emitHoldTechNotices(techNotices);
  const first = results[0];
  return { holds: results.map((r) => r.holdId), effects: [
    `${holdable.map(labelOf).join(' and ')} on hold until ${first.resumeDisplay}: no visits and no charges for ${holdable.length > 1 ? 'them' : 'it'} until then.`,
    `Your WaveGuard level and prices stay locked; we text you 7 days before the restart so you can move the date or cancel.`,
  ], ...(deferTechNotices ? { techNotices } : {}) };
}

async function executeAwayPairing(ctx) {
  // Holds first (they can fail and fully compensate); Away Mode is a
  // single idempotent preference write, so nothing partial can linger.
  const { techNotices, ...hold } = await executeHold({ ...ctx, deferTechNotices: true });
  let away;
  try {
    away = await executeAwayMode(ctx);
  } catch (err) {
    // Nothing partial survives (codex r2 P1): undo every hold this accept
    // created before reporting the failure.
    const { cancelHold } = require('./holds');
    for (const holdId of hold.holds || []) {
      try { await cancelHold(holdId, { compensateVisits: true }); } catch (undoErr) {
        logger.error(`[cancel-actions] hold compensation failed for ${holdId}: ${undoErr.message}`);
      }
    }
    throw err;
  }
  // Holds and Away Mode both stand: the moved visits' techs hear now.
  require('./holds').emitHoldTechNotices(techNotices);
  return { ...away, ...hold, effects: [...away.effects, ...hold.effects] };
}

/* ------------------------------------------------------------------ */

const EXECUTORS = {
  retention_offer: executeRetentionOffer,
  book_reservice: executeBookReservice,
  owner_call: executeOwnerContact,
  owner_text: executeOwnerContact,
  transfer_request: executeTransferRequest,
  configure_services: executeConfigureServices,
  set_preferences: executeSetPreferences,
  away_mode: executeAwayMode,
  hold: executeHold,
  away_pairing: executeAwayPairing,
};

// Actions a card can carry but that are informational only — nothing to
// run, so nothing to accept.
const INFORMATIONAL_ACTIONS = new Set(['restart_note', 'none']);

function isAcceptableAction(action) {
  return !!action && typeof action.type === 'string' && !!EXECUTORS[action.type];
}

async function executeAcceptedAction({ customerId, caseRow, action, params = {}, families = [] }) {
  if (!isAcceptableAction(action)) throw codedError('action_not_acceptable', 'This option cannot be accepted');
  const run = EXECUTORS[action.type];
  const result = await run({ customerId, caseRow, action, params, families });
  return { actionType: action.type, ...result };
}

module.exports = {
  executeAcceptedAction,
  isAcceptableAction,
  INFORMATIONAL_ACTIONS,
  _internals: { EXECUTORS, ownerTask, labelOf },
};
