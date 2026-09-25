'use strict';

const crypto = require('node:crypto');
const db = require('../models/db');
const ContactLedger = require('./collections/contact-ledger');
const { collectionsChannelPermitted } = require('./collections/rail-guard');

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
    const event = events.get(metadata.notificationEventKey) || { metadata, entries: [], delivered: new Set() };
    event.entries.push(row);
    if (metadata.delivered === true) {
      event.delivered.add(row.channel);
      if (!event.deliveredAt || new Date(row.occurred_at) > new Date(event.deliveredAt)) event.deliveredAt = row.occurred_at;
    }
    events.set(metadata.notificationEventKey, event);
  }
  return [...events.values()].map((event) => ({ ...event,
    complete: channels.every((channel) => event.delivered.has(channel)),
  }));
}

// Each selected method owns a keyed reservation before provider handoff.
// Completed methods never re-enter a provider; a reused ambiguous reservation
// is held, while a confirmed failed attempt can claim a retry atomically.
async function sendReminderChannels({ customerId, invoiceId, source, purpose, eventKey, channels, metadata = {}, send }) {
  const progress = await reminderProgress(customerId, source, channels);
  const existing = progress.find((event) => event.metadata.notificationEventKey === eventKey);
  const entries = existing?.entries || [];
  const delivered = new Set(existing?.delivered || []);
  const deliveredNow = [];
  const results = {};
  const pending = ['email', 'push', 'sms'].filter((channel) => channels.includes(channel) && !delivered.has(channel));
  const permitted = await Promise.all(pending.map((channel) => collectionsChannelPermitted({
    customerId, invoiceId, channel, purpose, excludeLedgerIds: entries.map((entry) => entry.id), logTag: 'billing-reminder',
  })));
  for (const [index, channel] of pending.entries()) {
    if (!permitted[index]) { results[channel] = { sent: false, blocked: true, code: 'COLLECTIONS_POLICY' }; continue; }
    const digest = crypto.createHash('sha256').update(`${customerId}:${eventKey}`).digest('hex');
    const entry = await ContactLedger.recordContact({
      customerId, channel, purpose, invoiceIds: [invoiceId], source,
      idempotencyKey: `billing-reminder:${digest}:${channel}`,
      metadata: { ...metadata, notificationEventKey: eventKey, selectedChannels: channels },
    });
    const claim = await ContactLedger.claimAttempt(entry);
    if (claim.delivered) { delivered.add(channel); continue; }
    if (!claim.allowed) { results[channel] = { sent: false, deliveryHeld: true, code: 'REMINDER_OUTCOME_UNCONFIRMED' }; continue; }
    let result;
    try {
      result = await send(channel);
    } catch (err) {
      result = err.providerOutcome || { sent: false, deliveryOutcome: 'uncertain', code: 'REMINDER_OUTCOME_UNCONFIRMED' };
    }
    results[channel] = result;
    const accepted = (result?.sent === true || result?.ok === true || result?.deliveryOutcome === 'accepted')
      && result?.deliveryOutcome !== 'uncertain';
    if (accepted) {
      if (!await ContactLedger.markDelivered(entry)) {
        results[channel] = { ...result, deliveryHeld: true, code: 'REMINDER_ACCEPTANCE_UNSTAMPED' };
        continue;
      }
      delivered.add(channel);
      if (!result.deduped) deliveredNow.push(channel);
    } else if (result?.deliveryOutcome !== 'uncertain') {
      if (!await ContactLedger.markSendFailed(entry, { code: result?.code || result?.reason || 'not_sent' })) {
        results[channel] = { ...result, deliveryHeld: true, code: 'REMINDER_OUTCOME_UNCONFIRMED' };
      }
    }
  }
  return { complete: channels.every((channel) => delivered.has(channel)), deliveredNow, results };
}

module.exports = { reminderProgress, sendReminderChannels };
