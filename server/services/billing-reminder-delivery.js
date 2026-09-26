'use strict';

const crypto = require('node:crypto');
const db = require('../models/db');
const ContactLedger = require('./collections/contact-ledger');
const { collectionsChannelPermitted } = require('./collections/rail-guard');

const TERMINAL_EMAIL_REFUSAL_CODES = new Set([
  'NO_EMAIL_RECIPIENT',
  'BILLING_EMAIL_NOT_SELECTED',
  'BILLING_EMAIL_DISABLED',
  'EMAIL_SUPPRESSED',
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

async function reminderProgress(customerId, source, channels) {
  const rows = await db('collections_contact_ledger').where({ customer_id: customerId, source })
    .where('occurred_at', '>', new Date(Date.now() - 90 * 86400000));
  const events = new Map();
  for (const row of rows) {
    const metadata = metadataOf(row);
    if (!metadata.notificationEventKey) continue;
    const event = events.get(metadata.notificationEventKey)
      || { metadata, entries: [], delivered: new Set(), resolved: new Set(), waived: new Set() };
    event.entries.push(row);
    for (const channel of metadata.policy_waived_channels || []) event.waived.add(channel);
    if (metadata.resolved === true && metadata.delivered !== true) event.resolved.add(row.channel);
    if (metadata.delivered === true) {
      event.delivered.add(row.channel);
      if (!event.deliveredAt || new Date(row.occurred_at) > new Date(event.deliveredAt)) event.deliveredAt = row.occurred_at;
    }
    events.set(metadata.notificationEventKey, event);
  }
  return [...events.values()].map((event) => ({ ...event,
    complete: legsSettled(channels, event.delivered, event.resolved, event.waived),
  }));
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
  const accepted = result?.deliveryOutcome === 'accepted'
    || (channel === 'email' && result?.ok === true && result.deliveryOutcome === undefined);
  if (accepted) {
    if (await ContactLedger.markDelivered(entry)) return 'delivered';
    results[channel] = { ...result, deliveryHeld: true, code: 'REMINDER_ACCEPTANCE_UNSTAMPED' };
    return null;
  }
  if (result?.held === true || result?.deliveryHeld === true) return null;
  if (result?.deliveryOutcome === 'uncertain') return null;
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
async function sendReminderChannels({ customerId, invoiceId, source, purpose, eventKey, channels, metadata = {}, send }) {
  const progress = await reminderProgress(customerId, source, channels);
  const existing = progress.find((event) => event.metadata.notificationEventKey === eventKey);
  const entries = existing?.entries || [];
  const delivered = new Set(existing?.delivered || []);
  const resolved = new Set(existing?.resolved || []);
  const deliveredNow = [];
  const results = {};
  const pending = ['email', 'push', 'sms'].filter((channel) => channels.includes(channel)
    && !delivered.has(channel) && !resolved.has(channel));
  const permitted = await Promise.all(pending.map((channel) => collectionsChannelPermitted({
    customerId, invoiceId, channel, purpose, excludeLedgerIds: entries.map((entry) => entry.id), logTag: 'billing-reminder',
    detail: true,
  })));
  const digest = crypto.createHash('sha256').update(`${customerId}:${eventKey}`).digest('hex');
  // Only a durable denial waives its leg; a spacing window keeps it owed.
  const waived = new Set([...(existing?.waived || []),
    ...pending.filter((_channel, index) => verdictDurablyDenied(permitted[index]))]);
  const episodeRowIds = new Set(entries.map((entry) => entry.id));
  for (const [index, channel] of pending.entries()) {
    if (!verdictAllows(permitted[index])) { results[channel] = { sent: false, blocked: true, code: 'COLLECTIONS_POLICY' }; continue; }
    const entry = await ContactLedger.recordContact({
      customerId, channel, purpose, invoiceIds: [invoiceId], source,
      idempotencyKey: `billing-reminder:${digest}:${channel}`,
      metadata: { ...metadata, notificationEventKey: eventKey, selectedChannels: channels,
        ...(waived.size ? { policy_waived_channels: [...waived] } : {}) },
    });
    episodeRowIds.add(entry?.id);
    const claim = await ContactLedger.claimAttempt(entry);
    if (claim.delivered) { delivered.add(channel); continue; }
    if (!claim.allowed) { results[channel] = { sent: false, deliveryHeld: true, code: 'REMINDER_OUTCOME_UNCONFIRMED' }; continue; }
    const result = await sendLeg(send, channel, entry);
    results[channel] = result;
    const state = await recordLegOutcome(entry, channel, result, results);
    if (state === 'delivered') {
      delivered.add(channel);
      if (!result.deduped) deliveredNow.push(channel);
    } else if (state === 'resolved') resolved.add(channel);
  }
  const complete = await settleEpisode(channels, { delivered, resolved, waived }, episodeRowIds);
  return { complete, deliveredNow, results };
}

// A waiver only settles the episode once it is durable: a reused row keeps
// its original metadata, and a denial that arrives after the sibling was
// delivered writes no new row at all.
async function settleEpisode(channels, { delivered, resolved, waived }, rowIds) {
  if (!legsSettled(channels, delivered, resolved, waived)) return false;
  const reliesOnWaiver = channels.some((channel) => waived.has(channel)
    && !delivered.has(channel) && !resolved.has(channel));
  if (!reliesOnWaiver) return true;
  const ids = [...rowIds].filter(Boolean);
  if (!ids.length) return false;
  try {
    await db('collections_contact_ledger').whereIn('id', ids).update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('policy_waived_channels', ?::jsonb)", [
        JSON.stringify([...waived]),
      ]),
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  reminderProgress, sendReminderChannels, isTerminalEmailRefusal, verdictAllows, verdictDurablyDenied,
};
