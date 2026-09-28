/**
 * Seven days between overdue-payment messages (owner ruling 2026-09-27,
 * GATE_DUNNING_SPACING). The one definition shared by the policy's
 * dunning_within_7d denial and the ledger's reservation-time re-check, so
 * the two never disagree about which message holds the next one.
 *
 * A full 7×24 hours from the moment a message went out (codex #5108 r2: a
 * calendar-week boundary let a late-evening message be followed after
 * about six and a half days). The daily runs are not timed to the second,
 * so a weekly step that comes due a few seconds short of the full week
 * goes out on the next run instead.
 *
 * A row holds only if the message may have reached the customer: not a
 * never_contacted row, a definite refusal (send_failed) or an episode
 * settled without delivery (resolved), unless delivery evidence arrived
 * after all (delivered), which always holds.
 *
 * Two sources are not overdue reminders, so they neither wait nor hold the
 * next one: the annual prepay renewal's payment reminder, and the pay link a
 * customer asks for during a collections call.
 */

const { dunningSpacingLive } = require('../../config/feature-gates');

const DAY_MS = 24 * 60 * 60 * 1000;
const SPACING_DAYS = 7;
const TEXT_CHANNELS = ['sms', 'email', 'push'];
const EXEMPT_SOURCES = new Set(['annual_prepay_payment_reminder', 'collections_voice_paylink']);

function metadataOf(row) {
  if (typeof row?.metadata !== 'string') return row?.metadata || {};
  try { return JSON.parse(row.metadata) || {}; } catch { return {}; }
}

// The instant a message sent at `occurredAt` stops holding the next one.
function spacingHeldUntil(occurredAt) {
  return new Date(new Date(occurredAt).getTime() + SPACING_DAYS * DAY_MS);
}

function holdsNextMessage(row, now) {
  if (!TEXT_CHANNELS.includes(row?.channel) || EXEMPT_SOURCES.has(row.source)) return false;
  const meta = metadataOf(row);
  if (String(meta.never_contacted) === 'true') return false;
  if (meta.delivered !== true && (meta.send_failed === true || meta.resolved === true)) return false;
  return now.getTime() < spacingHeldUntil(row.occurred_at).getTime();
}

// Whether a message from `source` on `channel` waits for the rule.
function spacingApplies({ channel, source = null }) {
  return dunningSpacingLive() && TEXT_CHANNELS.includes(channel) && !EXEMPT_SOURCES.has(source);
}

// The ledger's re-check runs only where the policy itself is enforced.
function spacingEnforced() {
  return process.env.GATE_COLLECTIONS_POLICY === 'true' && dunningSpacingLive();
}

function reservationGuarded({ channel, source = null }) {
  return spacingEnforced() && spacingApplies({ channel, source });
}

// Inside the caller's transaction: serializes one customer's overdue-message
// reservations until it commits, then returns another rail's message that
// still holds at `now`, or null. A rail's own rows are left to the policy's
// excludeLedgerIds, and runExclusive keeps a rail from racing itself.
async function lockedHoldingMessage(trx, { customerId, source = null, now = new Date() }) {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['dunning-spacing', String(customerId)]);
  const query = trx('collections_contact_ledger')
    .where({ customer_id: customerId })
    .whereIn('channel', TEXT_CHANNELS)
    .where('occurred_at', '>', new Date(now.getTime() - SPACING_DAYS * DAY_MS));
  if (source) query.whereNot('source', source);
  const rows = await query.orderBy('occurred_at', 'desc').select('id', 'channel', 'source', 'occurred_at', 'metadata');
  return (rows || []).find((row) => holdsNextMessage(row, now)) || null;
}

function spacingHeldError(row) {
  const err = new Error(`overdue message held: ledger row ${row.id} (${row.source}) went out within 7 days`);
  err.code = 'DUNNING_SPACING_HELD';
  err.nextEligibleAt = spacingHeldUntil(row.occurred_at);
  return err;
}

module.exports = {
  SPACING_DAYS, EXEMPT_SOURCES,
  spacingHeldUntil, holdsNextMessage, spacingApplies, spacingEnforced, reservationGuarded, lockedHoldingMessage,
  spacingHeldError,
};
