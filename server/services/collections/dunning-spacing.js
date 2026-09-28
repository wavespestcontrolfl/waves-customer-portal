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
function isOverdueReminderRow(row) {
  return !!row && !EXEMPT_SOURCES.has(row.source) && OVERDUE_SOURCES.has(row.source)
    && OVERDUE_PURPOSES.has(row.purpose);
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
// legacy rows remain independent contacts, except historical follow-up legs
// (legacyFollowupEventKey). Sorting here makes the reducer
// deterministic even when it is exercised without the replay query.
// Follow-up ledger rows written before invoice-followups stamped a shared
// notificationEventKey carry only metadata.step_id (Codex #5189 r2). One
// step of one invoice's sequence is one touch (the step advances once it
// sends), so source + invoice + step groups those historical legs.
function legacyFollowupEventKey(row) {
  if (row?.source !== 'invoice_followups') return null;
  const stepId = metadataOf(row).step_id;
  let invoiceIds = row.invoice_ids;
  if (typeof invoiceIds === 'string') {
    try { invoiceIds = JSON.parse(invoiceIds); } catch { invoiceIds = null; }
  }
  if (!stepId || !Array.isArray(invoiceIds) || invoiceIds.length !== 1) return null;
  return `invoice-followup-legacy:${invoiceIds[0]}:${stepId}`;
}

function collapseDunningReminderEvents(rows) {
  const sent = [...(rows || [])].filter(countsAsSent).sort(compareReplayRows);
  const events = [];
  const keyedEventIndexes = new Map();
  for (const row of sent) {
    const rawEventKey = metadataOf(row).notificationEventKey;
    const eventKey = typeof rawEventKey === 'string' && rawEventKey.trim() ? rawEventKey : legacyFollowupEventKey(row);
    if (!eventKey) {
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
async function lastOverdueReminderWithin7d(customerId, { now = new Date(), excludeLedgerIds = [], database } = {}) {
  if (!customerId || !database) return null;
  const windowStart = new Date(now.getTime() - SPACING_MS);
  const rows = await database('collections_contact_ledger')
    .where({ customer_id: customerId })
    .whereIn('source', [...OVERDUE_SOURCES])
    .whereIn('purpose', [...OVERDUE_PURPOSES])
    .where('occurred_at', '>', windowStart)
    .orderBy('occurred_at', 'desc')
    .select('id', 'channel', 'source', 'purpose', 'occurred_at', 'metadata');
  const excluded = new Set((excludeLedgerIds || []).map(String));
  return (rows || []).find((row) => {
    if (excluded.has(String(row.id))) return false;
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
  countsAsSent,
  collapseDunningReminderEvents,
  summarizeDunningSpacingReplay,
  spacingHeldUntil,
  lastOverdueReminderWithin7d,
};
