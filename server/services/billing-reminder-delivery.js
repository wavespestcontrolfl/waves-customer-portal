'use strict';

const { billingLegDeliveryState, billingLegContactTime } = require('./messaging/billing-channel-routing');

const crypto = require('node:crypto');
const db = require('../models/db');
const ContactLedger = require('./collections/contact-ledger');
const BillingEmailReservation = require('./billing-email-reservation');
const { collectionsChannelPermitted } = require('./collections/rail-guard');

const TERMINAL_EMAIL_REFUSAL_CODES = new Set([
  'NO_EMAIL_RECIPIENT',
  'BILLING_EMAIL_NOT_SELECTED',
  'EMAIL_SUPPRESSED',
  // The billing Email authority's phone-keyed suppression recheck (#4962):
  // the same hard stops the provider-retry path resolves terminally, so a
  // fresh reminder settles the leg instead of re-claiming it until the
  // suppression happens to clear. A STOP text or a wrong-number flag never
  // stops a payment email (owner ruling 2026-09-27), so only these two can
  // refuse one. An unreadable store (SUPPRESSION_LOOKUP_FAILED) stays
  // retryable.
  'SUPPRESSED_MANUAL_DNC',
  'SUPPRESSED_OTHER',
]);

// A permanent Email refusal (no address, Email not selected, template
// unavailable, suppressed) can never succeed on retry. It resolves that leg
// without claiming delivery, so the episode is not held open forever.
function isTerminalEmailRefusal(result) {
  if (!result || result.retryable === true || result.deferred === true
      || result.held === true || result.deliveryHeld === true
      || result.deliveryOutcome === 'uncertain') return false;
  const legacy = result.ok === false && (
    (result.skipped === true && ['missing_email', 'billing_email_not_selected', 'template_unavailable'].includes(result.reason))
    || (result.blocked === true && /^Suppressed: /.test(result.reason || ''))
  );
  const canonical = result.sent === false && result.blocked === true
    && result.deliveryOutcome === 'not_sent' && TERMINAL_EMAIL_REFUSAL_CODES.has(result.code);
  return legacy || canonical;
}

// Readers for a rail-guard `detail: true` verdict that also accept the plain
// boolean the guard returns without it.
function verdictAllows(verdict) {
  return verdict === true || verdict?.allowed === true;
}
function verdictDurablyDenied(verdict) {
  return verdict?.allowed === false && verdict.durable === true;
}

// Every selected leg is delivered, terminally resolved, or was denied by the
// collections policy while a sibling delivered. A policy-denied leg is not
// owed (legacy skip) but can never settle an episode on its own.
function legsSettled(channels, delivered, resolved, waived) {
  return channels.every((channel) => delivered.has(channel) || resolved.has(channel)
    || (waived.has(channel) && delivered.size > 0));
}

function metadataOf(row) {
  return typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
}

async function persistPolicyWaivers(rowIds, waived) {
  const ids = [...rowIds].filter(Boolean);
  if (!ids.length) return false;
  try {
    const changed = await db('collections_contact_ledger').whereIn('id', ids).update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('policy_waived_channels', ?::jsonb)", [
        JSON.stringify([...waived]),
      ]),
    });
    return Number(changed) > 0;
  } catch {
    return false;
  }
}

// `repair: false` is a read-only view for a caller that must not write (the
// customer-dunning shadow run): accepted Email evidence still counts as
// delivered in the returned events, but no reservation is stamped, resolved or
// released. Every existing caller keeps the default (repair).
async function reminderProgress(customerId, source, channels, { repair = true } = {}) {
  const rows = await db('collections_contact_ledger').where({ customer_id: customerId, source })
    .where('occurred_at', '>', new Date(Date.now() - 90 * 86400000));
  const repaired = await BillingEmailReservation.repairAcceptedBillingEmailReservations(
    rows, db, repair ? undefined : { readOnly: true },
  );
  const events = new Map();
  for (const row of rows) {
    const metadata = metadataOf(row);
    if (!metadata.notificationEventKey) continue;
    const event = events.get(metadata.notificationEventKey)
      || { metadata, entries: [], delivered: new Set(), resolved: new Set(), waived: new Set() };
    event.entries.push(row);
    for (const channel of metadata.policy_waived_channels || []) event.waived.add(channel);
    if (metadata.resolved === true && metadata.delivered !== true) event.resolved.add(row.channel);
    if (metadata.delivered === true || repaired.has(String(row.id))) {
      event.delivered.add(row.channel);
      if (!event.deliveredAt || new Date(row.occurred_at) > new Date(event.deliveredAt)) event.deliveredAt = row.occurred_at;
    }
    events.set(metadata.notificationEventKey, event);
  }
  return [...events.values()].map((event) => ({ ...event,
    complete: legsSettled(channels, event.delivered, event.resolved, event.waived),
  }));
}

// The invoices and time a delivered reservation recorded, read straight from
// its row. A delivery restored from a reservation older than reminderProgress'
// 90-day window has no event to name them, and a caller that completes debt on
// the strength of it (a final notice) must never substitute today's membership.
// null fields = unreadable.
async function restoredDelivery(entry, channel) {
  try {
    const row = await db('collections_contact_ledger').where({ id: entry.id }).first('invoice_ids', 'occurred_at');
    let ids = row?.invoice_ids;
    if (typeof ids === 'string') ids = JSON.parse(ids);
    return {
      channel,
      invoiceIds: Array.isArray(ids) && ids.length ? ids.map(String) : null,
      deliveredAt: row?.occurred_at || null,
    };
  } catch {
    return { channel, invoiceIds: null, deliveredAt: null };
  }
}

// The keyed reservation of one leg of an episode: the ONE formula recordContact's idempotency key uses.
function reminderReservationKey(customerId, eventKey, channel) {
  const digest = crypto.createHash('sha256').update(`${customerId}:${eventKey}`).digest('hex');
  return `billing-reminder:${digest}:${channel}`;
}

// The standing row of a leg's keyed reservation, read by that key with no time window (reminderProgress
// drops rows older than 90 days; recordContact / claimAttempt do not). A READ: the customer-dunning shadow
// run asks it to judge a leg exactly as the live claim will. null = no reservation yet.
async function findReminderReservation(customerId, eventKey, channel) {
  const row = await db('collections_contact_ledger')
    .where({ idempotency_key: reminderReservationKey(customerId, eventKey, channel) })
    .first('id', 'metadata');
  if (!row) return null;
  let metadata = row.metadata;
  if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { metadata = {}; } }
  return { id: row.id, metadata: metadata || {} };
}

// The legs an episode still owes, and the collections-policy verdict for each. Both
// are READS (collectionsChannelPermitted consults the contact policy and writes
// nothing), shared with the customer-dunning shadow run so it judges a send by
// exactly what the live attempt will.
function pendingReminderChannels(channels, delivered, resolved) {
  return ['email', 'push', 'sms'].filter((channel) => channels.includes(channel)
    && !delivered.has(channel) && !resolved.has(channel));
}

function reminderPolicyVerdicts({
  customerId, invoiceId, invoiceIds, policyInvoiceIds, source, purpose, offLedgerBalanceCents, entries,
}, pending) {
  return Promise.all(pending.map((channel) => collectionsChannelPermitted({
    customerId, invoiceId, channel, purpose, offLedgerBalanceCents, excludeLedgerIds: entries.map((entry) => entry.id), source, logTag: 'billing-reminder',
    invoiceIds: policyInvoiceIds ?? invoiceIds,
    detail: true,
  })));
}

// `send` receives the leg's reservation so a producer can hand its ledger id
// to a deferred replay that must re-check the collections rail.
async function sendLeg(send, channel, entry) {
  try {
    return await send(channel, entry);
  } catch (err) {
    return err.providerOutcome || { sent: false, deliveryOutcome: 'uncertain', code: 'REMINDER_OUTCOME_UNCONFIRMED' };
  }
}

// Stamps one leg's provider outcome on its reservation and returns the state
// it reached: 'delivered', 'resolved' (terminal Email refusal, never counted
// as delivered), or null while it stays pending. An uncertain outcome keeps
// the reservation held; only a definite non-send becomes retryable.
async function recordLegOutcome(entry, channel, result, results) {
  const delivered = billingLegDeliveryState(channel, result || {});
  if (delivered) {
    const occurredAt = billingLegContactTime(result);
    const stamped = occurredAt
      ? await ContactLedger.markDelivered(entry, { occurredAt })
      : await ContactLedger.markDelivered(entry);
    if (stamped) return delivered;
    results[channel] = { ...result, deliveryHeld: true, code: 'REMINDER_ACCEPTANCE_UNSTAMPED' };
    return null;
  }
  if (result?.held === true || result?.deliveryHeld === true) return null;
  if (result?.deliveryOutcome === 'uncertain') return null;
  // A dispute hold that landed after the rail-guard consult refused this leg at the send boundary
  // (the ONE retryable COLLECTION_HOLD_DEFER outcome): a WAIT. Nothing reached the customer, so
  // the reservation is released rather than stamped failed or resolved; the episode stays
  // incomplete and the leg is re-reserved and sent on the first run after the release.
  if (require('./collections/collection-hold').isHoldSuppression(result)) {
    await ContactLedger.releaseHeldReservation(entry);
    return null;
  }
  const terminal = channel === 'email' && isTerminalEmailRefusal(result);
  const stamped = await ContactLedger.markSendFailed(entry, {
    code: result?.code || result?.reason || 'not_sent',
    ...(terminal ? { resolved: true, resolution: 'email_terminal_refusal' } : {}),
  });
  if (!stamped) results[channel] = { ...result, deliveryHeld: true, code: 'REMINDER_OUTCOME_UNCONFIRMED' };
  return stamped && terminal ? 'resolved' : null;
}

// Each selected method owns a keyed reservation before provider handoff.
// Completed methods never re-enter a provider; a reused ambiguous reservation
// is held, while a confirmed failed attempt can claim a retry atomically.
// The debts a reservation covers: an aggregate reminder (invoiceId null)
// passes the invoices it quotes as invoiceIds.
// A supplied list is used as-is, including an empty one (a dues-only
// reminder quotes no invoice, matching the legacy previsit ledger row).
function ledgerInvoiceIds(invoiceId, invoiceIds) {
  return Array.isArray(invoiceIds) ? invoiceIds : [invoiceId];
}

// offLedgerBalanceCents (rail-guard defaults it to 0): debt the ledger does not hold (e.g. late monthly dues
// on the previsit reminder) that the producer's own policy check counted; the
// per-leg recheck must count it too or a dues-only reminder reads as no debt.
// policyInvoiceIds pins a frozen collectible aggregate. It is separate from
// ledger invoiceIds: annual-prepay can record a draft invoice while the policy
// deliberately evaluates its amount as off-ledger debt.
// A leg whose keyed reservation is already settled (found by its key, past the progress window): delivered
// is restored with what the reservation recorded; a terminal resolution (a suppression refusal) is settled and
// never owed again - the per-invoice sender treats claim.resolved the same way.
async function restoreSettledLeg(claim, entry, channel, { delivered, resolved, restored }) {
  if (claim.delivered) { delivered.add(channel); restored.push(await restoredDelivery(entry, channel)); return true; }
  if (claim.resolved) { resolved.add(channel); return true; }
  return false;
}

async function sendReminderChannels({
  customerId, invoiceId, invoiceIds, policyInvoiceIds, source, purpose, eventKey, channels, metadata = {}, send, offLedgerBalanceCents,
}) {
  const progress = await reminderProgress(customerId, source, channels);
  // A missing episode has the same shape as restored progress. These sets
  // are private to this progress read, so delivery can update them directly.
  const { entries, delivered, resolved, waived: restoredWaived } = progress
    .find((event) => event.metadata.notificationEventKey === eventKey)
    || { entries: [], delivered: new Set(), resolved: new Set(), waived: new Set() };
  const deliveredNow = [];
  const restored = []; // legs found already delivered by the keyed reservation, with what it recorded
  const results = {};
  const pending = pendingReminderChannels(channels, delivered, resolved);
  const permitted = await reminderPolicyVerdicts({
    customerId, invoiceId, invoiceIds, policyInvoiceIds, source, purpose, offLedgerBalanceCents, entries,
  }, pending);
  // Partial debt evidence cannot authorize a leg or settle a restored waiver.
  // Keep the entire pending episode retryable before any delivery mutation.
  if (permitted.some((verdict) => verdict?.balanceIncomplete)) {
    for (const channel of pending) {
      results[channel] = { sent: false, deliveryHeld: true, retryable: true, code: 'COLLECTIONS_POLICY' };
    }
    return { complete: false, deliveredNow, results, delivered: [...delivered], restored };
  }
  // Only a durable denial waives its leg; a spacing window keeps it owed.
  // A later allowance revokes the old waiver. Persist that deletion before
  // retrying: claimAttempt refreshes reservation metadata with a JSON merge,
  // so merely omitting the key would leave the old waiver on the row.
  const waived = new Set([...restoredWaived,
    ...pending.filter((_channel, index) => verdictDurablyDenied(permitted[index]))]);
  for (const [index, channel] of pending.entries()) {
    if (verdictAllows(permitted[index])) waived.delete(channel);
  }
  const episodeRowIds = new Set(entries.map((entry) => entry.id));
  const revokedWaiver = [...restoredWaived].some((channel) => !waived.has(channel));
  if (revokedWaiver && !await persistPolicyWaivers(episodeRowIds, waived)) {
    for (const [index, channel] of pending.entries()) {
      if (verdictAllows(permitted[index])) {
        results[channel] = { sent: false, deliveryHeld: true, code: 'REMINDER_WAIVER_REFRESH_FAILED' };
      }
    }
    return { complete: false, deliveredNow, results, delivered: [...delivered], restored };
  }
  for (const [index, channel] of pending.entries()) {
    if (!verdictAllows(permitted[index])) { results[channel] = { sent: false, blocked: true, code: 'COLLECTIONS_POLICY' }; continue; }
    const reservation = {
      invoiceIds: ledgerInvoiceIds(invoiceId, invoiceIds),
      metadata: { ...metadata, notificationEventKey: eventKey, selectedChannels: channels,
        ...(waived.size ? { policy_waived_channels: [...waived] } : {}) },
    };
    const entry = await ContactLedger.recordContact({
      customerId, channel, purpose, invoiceIds: reservation.invoiceIds, source,
      idempotencyKey: reminderReservationKey(customerId, eventKey, channel), metadata: reservation.metadata,
    });
    episodeRowIds.add(entry?.id);
    // A retry under the same key re-quotes: its claim refreshes the debt snapshot.
    const claim = await ContactLedger.claimAttempt(entry, reservation);
    if (await restoreSettledLeg(claim, entry, channel, { delivered, resolved, restored })) continue;
    if (!claim.allowed) { results[channel] = { sent: false, deliveryHeld: true, code: 'REMINDER_OUTCOME_UNCONFIRMED' }; continue; }
    const result = await sendLeg(send, channel, entry);
    results[channel] = result;
    const state = await recordLegOutcome(entry, channel, result, results);
    if (state === 'resolved') resolved.add(channel);
    else if (state) {
      delivered.add(channel);
      if (state === 'delivered') deliveredNow.push(channel);
    }
  }
  const complete = await settleEpisode(channels, { delivered, resolved, waived }, episodeRowIds);
  return { complete, deliveredNow, results, delivered: [...delivered], restored };
}

// A waiver only settles the episode once it is durable: a reused row keeps
// its original metadata, and a denial that arrives after the sibling was
// delivered writes no new row at all.
async function settleEpisode(channels, { delivered, resolved, waived }, rowIds) {
  if (!legsSettled(channels, delivered, resolved, waived)) return false;
  const reliesOnWaiver = channels.some((channel) => waived.has(channel)
    && !delivered.has(channel) && !resolved.has(channel));
  if (!reliesOnWaiver) return true;
  return persistPolicyWaivers(rowIds, waived);
}

module.exports = {
  reminderProgress, sendReminderChannels, isTerminalEmailRefusal, verdictAllows, verdictDurablyDenied,
  pendingReminderChannels, reminderPolicyVerdicts, reminderReservationKey, findReminderReservation,
};
