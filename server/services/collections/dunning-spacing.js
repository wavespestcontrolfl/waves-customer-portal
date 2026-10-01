/**
 * Seven-day overdue-reminder spacing rule — OBSERVE ONLY (owner
 * re-sequencing 2026-09-27/28, GATE_DUNNING_SPACING_SHADOW). This is PR 1
 * of the dunning-unification spacing work, rebuilt NARROW and
 * shadow-only after the wide version (#5108: locks, a ledger
 * reservation-time re-check, retry re-arm, spacing episodes) drew five
 * review rounds. The ladder (#5126) and orphan adoption (#5179) remove
 * the handoffs behind most double contacts, so this PR only needs to
 * OBSERVE what the rule would have held — nothing here locks, holds,
 * denies, or changes what any rail sends. See contact-policy.js's shadow
 * evaluation and dunning-spacing-replay.js, the only two callers.
 *
 * An "overdue reminder" row is a specific narrow shape, not every
 * collections_contact_ledger row: one of the five automated dunning
 * rails' own sources (OVERDUE_SOURCES), carrying one of the three
 * overdue-reminder purposes those same rails write (OVERDUE_PURPOSES) —
 * a payment_link / payment_receipt / payment_verification / billing row
 * from one of those SAME sources is not an overdue reminder and is
 * excluded by the purpose filter. Two sources are never overdue
 * reminders even though today's OVERDUE_SOURCES allowlist already
 * excludes them: the pay link a customer asks for mid collections-call
 * (`collections_voice_paylink`), and the annual prepay renewal's own
 * payment reminder (`annual_prepay_payment_reminder`). Kept explicit for
 * parity with #5108 and as a guard against future drift in
 * OVERDUE_SOURCES.
 *
 * Strict 7×24 hours from the previous row's occurred_at — NOT calendar
 * days (codex #5108 r2 rejected a calendar-week boundary: a late-evening
 * message could otherwise be followed again after only ~6.5 days).
 *
 * A row counts as having (possibly) reached the customer unless it is a
 * confirmed failure that never delivered: `metadata.delivered === true`
 * counts even alongside `send_failed` (delivery evidence arrived after
 * all); `metadata.send_failed === true` with no delivered stamp does not
 * count; a row with neither flag set (sent, no delivery confirmation
 * tracked for that channel) counts — the safe direction is to
 * over-report, never under-report, what would have held (the same
 * doctrine contact-ledger.js documents for its own frequency windows).
 * `resolved` / `never_contacted` do not appear on these five sources'
 * rows today, so they are deliberately not modeled here — left for the
 * enforcing PR if that changes.
 */

const OVERDUE_SOURCES = new Set([
  'invoice_followups',
  // The follow-up rail's deferred SMS, delivered after the send window
  // (deferred-replay-registry.js; Codex #5189 r3).
  'invoice_followup_replay',
  'late_payment_checker',
  'previsit_balance_reminder',
  'balance_reminder_late_payment_check',
  'balance_reminder_workflow',
]);

const OVERDUE_PURPOSES = new Set(['late_payment', 'invoice_followup', 'balance_reminder']);

// Never overdue reminders — see module header.
const EXEMPT_SOURCES = new Set(['collections_voice_paylink', 'annual_prepay_payment_reminder']);

const DAY_MS = 24 * 60 * 60 * 1000;
const SPACING_DAYS = 7;
const SPACING_MS = SPACING_DAYS * DAY_MS;

function metadataOf(row) {
  const raw = row?.metadata;
  if (raw == null) return {};
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

// The row-shape filter: this source + this purpose is an overdue reminder.
// A deferred bank-verification re-nudge is stored with the follow-up
// replay's late_payment shape but flagged verification_renudge (Codex #5189
// r7); it is not an overdue reminder.
function isOverdueReminderRow(row) {
  return !!row && !EXEMPT_SOURCES.has(row.source) && OVERDUE_SOURCES.has(row.source)
    && OVERDUE_PURPOSES.has(row.purpose) && metadataOf(row).verification_renudge !== true
    && !isUnclassifiedLegacyReplay(row);
}

// A deferred follow-up SMS written before replays carried the touch's
// notificationEventKey (Codex #5189 r8): it cannot be told apart from a
// bank-verification re-nudge, nor grouped with its own email sibling, so
// it is left out of spacing evidence and counted separately by the replay.
// Every replay row written since carries the key, so these age out of the
// 30-day window on their own.
function isUnclassifiedLegacyReplay(row) {
  if (row?.source !== 'invoice_followup_replay') return false;
  const key = metadataOf(row).notificationEventKey;
  return !(typeof key === 'string' && key.trim());
}

// Whether the row counts as having reached the customer — see module header.
function countsAsSent(row) {
  const meta = metadataOf(row);
  if (meta.delivered === true) return true;
  if (meta.send_failed === true) return false;
  return true;
}

function compareReplayRows(a, b) {
  const customerOrder = String(a?.customer_id ?? '').localeCompare(String(b?.customer_id ?? ''));
  if (customerOrder) return customerOrder;
  const occurredOrder = new Date(a?.occurred_at).getTime() - new Date(b?.occurred_at).getTime();
  if (occurredOrder) return occurredOrder;
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

// One notification event may write a row per selected channel. For replay
// evidence it is one customer contact: discard confirmed undelivered attempts
// first, then use the latest sent row as the event's representative. Keyless
// rows group by customer + source + invoice set within SIBLING_WINDOW_MS.
// Sorting here makes the reducer
// deterministic even when it is exercised without the replay query.
// Keyless multi-channel legs (Codex #5189 r2/r3): every rail has written
// one ledger row per channel for a single touch without a shared
// notificationEventKey (invoice-followups before it stamped one, the
// late-payment checker, balance-reminder). Rows from the SAME customer,
// SAME source and SAME invoice set within SIBLING_WINDOW_MS of the event's
// first leg are one touch: a rail's channel legs land seconds apart, and no
// rail reminds about the same invoices twice from one source minutes apart.
const SIBLING_WINDOW_MS = 15 * 60 * 1000;

function invoiceSetOf(row) {
  let ids = row?.invoice_ids;
  if (typeof ids === 'string') {
    try { ids = JSON.parse(ids); } catch { ids = null; }
  }
  return Array.isArray(ids) ? ids.map(String).sort() : [];
}

function collapseDunningReminderEvents(rows) {
  const sent = [...(rows || [])]
    .filter((row) => countsAsSent(row) && metadataOf(row).verification_renudge !== true
      && !isUnclassifiedLegacyReplay(row))
    .sort(compareReplayRows);
  const events = [];
  const keyedEventIndexes = new Map();
  const keylessEvents = new Map();
  for (const row of sent) {
    const rawEventKey = metadataOf(row).notificationEventKey;
    const eventKey = typeof rawEventKey === 'string' && rawEventKey.trim() ? rawEventKey : null;
    if (!eventKey) {
      const siblingKey = JSON.stringify([String(row.customer_id), row.source, invoiceSetOf(row)]);
      const open = keylessEvents.get(siblingKey);
      const at = new Date(row.occurred_at).getTime();
      if (open && at - open.startedAt <= SIBLING_WINDOW_MS) {
        events[open.index] = row; // ascending order, so this is the latest leg
        continue;
      }
      keylessEvents.set(siblingKey, { index: events.length, startedAt: at });
      events.push(row);
      continue;
    }
    const key = JSON.stringify([String(row.customer_id), eventKey]);
    const existingIndex = keyedEventIndexes.get(key);
    if (existingIndex == null) {
      keyedEventIndexes.set(key, events.length);
      events.push(row);
      continue;
    }
    if (new Date(row.occurred_at).getTime() > new Date(events[existingIndex].occurred_at).getTime()) {
      events[existingIndex] = row;
    }
  }
  return events.sort(compareReplayRows);
}

// Pure replay reducer: includes pre-window events as possible predecessors,
// counts only current events inside the reported window, and keeps the strict
// (< 7×24h) boundary used by the live reader.
function summarizeDunningSpacingReplay(rows, { windowStart }) {
  const events = collapseDunningReminderEvents(rows);
  const byCustomer = new Map();
  for (const event of events) {
    const list = byCustomer.get(event.customer_id) || [];
    list.push(event);
    byCustomer.set(event.customer_id, list);
  }

  const spacingHits = [];
  let candidatesInWindow = 0;
  let customersAffected = 0;
  for (const list of byCustomer.values()) {
    let thisCustomerAffected = false;
    for (let i = 0; i < list.length; i += 1) {
      const current = list[i];
      const currentAt = new Date(current.occurred_at);
      if (currentAt < windowStart) continue;
      candidatesInWindow += 1;
      const previous = i > 0 ? list[i - 1] : null;
      if (!previous) continue;
      const hoursApart = (currentAt.getTime() - new Date(previous.occurred_at).getTime()) / (60 * 60 * 1000);
      if (hoursApart >= SPACING_MS / (60 * 60 * 1000)) continue;
      spacingHits.push({ previous, current, hoursApart });
      thisCustomerAffected = true;
    }
    if (thisCustomerAffected) customersAffected += 1;
  }
  return {
    events,
    spacingHits,
    candidatesInWindow,
    spacedWithin7d: spacingHits.length,
    customersAffected,
  };
}

// The instant a row sent at `occurredAt` stops holding the next one.
function spacingHeldUntil(occurredAt) {
  return new Date(new Date(occurredAt).getTime() + SPACING_MS);
}

function isWithin7d(row, now) {
  return now.getTime() - new Date(row.occurred_at).getTime() < SPACING_MS;
}

/**
 * The most recent overdue-reminder ledger row for `customerId`, from ANY
 * of the five sources, that is still inside its own 7-day window at
 * `now` — or null. READ-ONLY: no lock, no transaction, no write, and no
 * effect on any caller's verdict. `excludeLedgerIds` drops specific rows
 * (a caller's own same-run siblings) before the newest-first pick, same
 * convention as contact-policy.js's other frequency windows.
 */
async function lastOverdueReminderWithin7d(customerId, {
  now = new Date(), excludeLedgerIds = [], excludeIdempotencyKey = null, excludeEventKey = null, database,
} = {}) {
  if (!customerId || !database) return null;
  const windowStart = new Date(now.getTime() - SPACING_MS);
  const rows = await database('collections_contact_ledger')
    .where({ customer_id: customerId })
    .whereIn('source', [...OVERDUE_SOURCES])
    .whereIn('purpose', [...OVERDUE_PURPOSES])
    .where('occurred_at', '>', windowStart)
    // Closed at the evaluation time (Codex #5189 r3): a row another rail
    // commits after `now` was captured is not a previous reminder.
    .where('occurred_at', '<=', now)
    .orderBy('occurred_at', 'desc')
    .select('id', 'channel', 'source', 'purpose', 'occurred_at', 'metadata', 'idempotency_key');
  const excluded = new Set((excludeLedgerIds || []).map(String));
  return (rows || []).find((row) => {
    if (excluded.has(String(row.id))) return false;
    if (excludeIdempotencyKey && row.idempotency_key === excludeIdempotencyKey) return false;
    // The rest of the caller's own touch (e.g. a replay's delivered email leg).
    if (excludeEventKey && metadataOf(row).notificationEventKey === excludeEventKey) return false;
    // Belt & suspenders vs. the query's own source/purpose filter — a test
    // double or a future query change must not silently widen this.
    if (!isOverdueReminderRow(row)) return false;
    if (!countsAsSent(row)) return false;
    return isWithin7d(row, now);
  }) || null;
}

module.exports = {
  SPACING_DAYS,
  OVERDUE_SOURCES,
  OVERDUE_PURPOSES,
  EXEMPT_SOURCES,
  isOverdueReminderRow,
  isUnclassifiedLegacyReplay,
  countsAsSent,
  collapseDunningReminderEvents,
  summarizeDunningSpacingReplay,
  spacingHeldUntil,
  lastOverdueReminderWithin7d,
};
