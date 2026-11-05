/**
 * The one advisory lock for payroll mutations that read or change year-to-date
 * figures or a paid week. Kept in its own module with no requires so the time
 * entry writers (time-tracking.js) can share it without loading the pay run
 * code (and without any chance of a require cycle).
 *
 * Exclusive: finalize and void of a pay run, every payroll time-off write and every SIMPLE IRA
 * election write (payroll-simple.js: finalize reads the election and freezes the checks).
 * Shared: a time entry edit or void (assertEntryMutable), so a finalize cannot
 * interleave with an entry moving into the week it pays, while entry edits do
 * not block each other. Same idiom as payment-method-lock.js:
 * pg_advisory_xact_lock(hashtext(ns), hashtext(key)), released when the
 * transaction ends. Take it before the first read it protects.
 */
const PAYROLL_LOCK_NS = 'payroll.mutation';
const PAYROLL_LOCK_KEY = 'pay-runs';

const lockPayrollMutations = (trx) => trx.raw(
  'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
  [PAYROLL_LOCK_NS, PAYROLL_LOCK_KEY],
);

const lockPayrollMutationsShared = (trx) => trx.raw(
  'SELECT pg_advisory_xact_lock_shared(hashtext(?), hashtext(?::text))',
  [PAYROLL_LOCK_NS, PAYROLL_LOCK_KEY],
);

module.exports = { PAYROLL_LOCK_NS, PAYROLL_LOCK_KEY, lockPayrollMutations, lockPayrollMutationsShared };
