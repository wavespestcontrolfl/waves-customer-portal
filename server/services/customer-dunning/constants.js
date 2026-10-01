'use strict';

/**
 * Customer-level overdue reminders (dunning consolidation) — shared constants
 * and key builders (the lock key and open statuses are shared with the
 * per-invoice engine, invoice-followups.js, which reads ownership with them).
 *
 * Identity of a touch is (schedule.id, episode, step id) EVERYWHERE — ledger
 * keys, notificationEventKey, email idempotency key, email trigger event id.
 * The invoice set is never part of a key: it is re-derived at send time and
 * persisted only in the ledger reservation for audit, so a set that changes
 * between a delivery and its retry can never mint a second identity, and
 * every key has a fixed length (Codex #5188 A-4: a UUID list overflowed
 * collections_contact_ledger.idempotency_key varchar(120)).
 */

// collections_contact_ledger.source / email entry point for every touch this
// engine sends (also one of dunning-spacing.js OVERDUE_SOURCES).
const SOURCE = 'invoice_followups_customer';

// A schedule in one of these statuses OWNS its customer's per-invoice
// sequences. Mirrors the partial unique index
// customer_dunning_schedules_open_uniq in the table migration.
const OPEN_STATUSES = Object.freeze(['active', 'held', 'paused', 'autopay_hold']);

// active | held | paused | autopay_hold | completed | released
const SCHEDULE_STATUSES = Object.freeze([...OPEN_STATUSES, 'completed', 'released']);

const CLOSED_REASONS = Object.freeze([
  'balance_cleared',
  'final_notice_delivered',
  'released_gate_off',
  'released_prereq_off',
  'released_admin',
  'customer_missing',
]);

// A claim (touch_claimed_at) older than this is a crashed sender — same
// 10-minute freshness window the per-invoice sequence claim uses.
const CLAIM_TTL_MS = 10 * 60 * 1000;

// Every id the caller interpolates is a uuid (36 chars) or a small integer
// episode; step ids are short config strings.
const eventKey = (schedule, stepId) => `customer-dunning:${schedule.id}:${schedule.episode}:${stepId}`;
const emailIdempotencyKey = (schedule, stepId) => `customer_dunning_email:${schedule.id}:${schedule.episode}:${stepId}`;
const triggerEventId = (schedule, stepId) => `customer_dunning:${schedule.id}:${schedule.episode}:${stepId}`;

// Advisory-lock key for pg_advisory_xact_lock(hashtext(?)) /
// pg_advisory_xact_lock_shared(hashtext(?)): serialises promotion, the
// schedule claim and release against a per-invoice send for one customer.
const lockKey = (customerId) => `customer-dunning:${customerId}`;

module.exports = {
  SOURCE,
  OPEN_STATUSES,
  SCHEDULE_STATUSES,
  CLOSED_REASONS,
  CLAIM_TTL_MS,
  eventKey,
  emailIdempotencyKey,
  triggerEventId,
  lockKey,
};
