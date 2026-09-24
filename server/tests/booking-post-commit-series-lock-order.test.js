/**
 * Source-order regression for GitHub Codex #4716 r1 P1: the post-commit
 * recurring-follow-up seeding transaction in booking.js (and the other
 * checkActiveSeriesLocked/acquireSeriesCreateLocks callers audited in the
 * same round) must take the `customers` row FOR UPDATE lock BEFORE it
 * acquires the 'recurring-series-create' advisory lock.
 *
 * Why this matters: executeMerge (customer-dedupe.js) holds the customer's
 * row FOR UPDATE while it waits on the recurring-series-create advisory
 * lock (customer-dedupe.js's own fix, same round). This post-commit
 * transaction used to acquire the advisory lock (via checkActiveSeriesLocked)
 * WITHOUT first locking the customer row, then seedFollowUpsForParent
 * inserted child scheduled_services rows whose customer_id FK takes a
 * key-share lock on that customer row. With the merge holding FOR UPDATE
 * while waiting on the advisory lock, and this path holding the advisory
 * lock while waiting on the customer row, Postgres aborts one side
 * (deadlock detected) — exactly the ABBA class the merge's own row-lock-
 * first fix (pre-push audit on 4c3ff61175 / d5e0ad00a4) was written to
 * avoid on the OTHER side of this same race.
 *
 * This codebase's own established pattern for pinning ordering inside a
 * function too large to unit-test directly is a source `.indexOf()`
 * position assertion (see tests/setup-fee-followups-contracts.test.js for
 * the same technique against this same file) — a live-DB integration test
 * would be needed to prove the deadlock itself, but this pins the specific
 * code shape so a future edit cannot silently re-order the two locks
 * without failing a test.
 */
const fs = require('fs');
const path = require('path');

const booking = fs.readFileSync(path.join(__dirname, '..', 'routes', 'booking.js'), 'utf8');
const adminSchedule = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
const estimateConverter = fs.readFileSync(path.join(__dirname, '..', 'services', 'estimate-converter.js'), 'utf8');

describe('booking.js post-commit follow-up seeding — customer row lock before the series-advisory lock (Codex #4716 r1)', () => {
  test('the post-commit shouldSeedQuarterlyPestFollowUps transaction takes lockCustomerComms, THEN the customers forUpdate row lock, THEN checkActiveSeriesLocked, in that order', () => {
    // Anchor on the post-commit transaction's own guard comment (unique to
    // this block, not the earlier in-booking guard at ~2933 or the
    // wizard-series activation guard at ~3794) so this test tracks the
    // right occurrence even as unrelated code shifts line numbers.
    const blockAt = booking.indexOf('Duplicate-series guard: don\'t seed a SECOND active series');
    expect(blockAt).toBeGreaterThan(-1);
    const commsLockAt = booking.indexOf('await lockCustomerComms(trx, custId);', blockAt);
    expect(commsLockAt).toBeGreaterThan(blockAt);
    const rowLockAt = booking.indexOf(
      "await trx('customers').where({ id: custId }).forUpdate().first('id');",
      commsLockAt,
    );
    expect(rowLockAt).toBeGreaterThan(commsLockAt);
    const seriesLockAt = booking.indexOf('RecurringAppointmentSeeder.checkActiveSeriesLocked(trx, {', rowLockAt);
    expect(seriesLockAt).toBeGreaterThan(rowLockAt);
    // ...and the row lock is genuinely local to this block, not a stray
    // match from the in-booking (~2933) or wizard-series (~3794) guards,
    // which sit earlier in the file.
    const inBookingRowLockAt = booking.indexOf("await trx('customers').where({ id: custId }).forUpdate().first('id');");
    expect(inBookingRowLockAt).toBeGreaterThan(-1);
    expect(inBookingRowLockAt).toBeLessThan(blockAt);
  });

  // Regression: if this exact call sequence is ever reordered (advisory
  // lock reinstated before the row lock), the block above's assertions
  // fail. This second test independently confirms there is exactly ONE
  // `checkActiveSeriesLocked` call between the post-commit block's start
  // and its own row lock is impossible to find BEFORE that row lock —
  // i.e. no earlier, unlocked call sneaks in ahead of it in this block.
  test('no checkActiveSeriesLocked call inside the post-commit block precedes its own customers row lock', () => {
    const blockAt = booking.indexOf('Duplicate-series guard: don\'t seed a SECOND active series');
    const nextBlockMarker = booking.indexOf('duplicateSeriesKept = pestDuplicateKeptAtBooking;', blockAt);
    expect(nextBlockMarker).toBeGreaterThan(blockAt);
    const rowLockAt = booking.indexOf(
      "await trx('customers').where({ id: custId }).forUpdate().first('id');",
      blockAt,
    );
    const firstSeriesLockAfterBlock = booking.indexOf('RecurringAppointmentSeeder.checkActiveSeriesLocked(trx, {', blockAt);
    expect(rowLockAt).toBeGreaterThan(blockAt);
    expect(firstSeriesLockAfterBlock).toBeGreaterThan(rowLockAt);
  });
});

describe('other checkActiveSeriesLocked / acquireSeriesCreateLocks callers audited in the same round (#4716 r1)', () => {
  test('admin-schedule.js: the make-recurring spawn path locks the customer row before its duplicate-series guard', () => {
    const spawnBlockAt = adminSchedule.indexOf('Spawn recurring children if requested');
    expect(spawnBlockAt).toBeGreaterThan(-1);
    const rowLockAt = adminSchedule.indexOf(
      "await trx('customers').where({ id: parent.customer_id }).forUpdate().first('id');",
      spawnBlockAt,
    );
    expect(rowLockAt).toBeGreaterThan(spawnBlockAt);
    const seriesLockAt = adminSchedule.indexOf('RecurringAppointmentSeeder.checkActiveSeriesLocked(trx, {', rowLockAt);
    expect(seriesLockAt).toBeGreaterThan(rowLockAt);
  });

  test('admin-schedule.js: the POST creator already locked the customer row before its guard (pre-existing, unchanged)', () => {
    const rowLockAt = adminSchedule.indexOf("await trx('customers').where({ id: customerId }).forUpdate().first('id');");
    expect(rowLockAt).toBeGreaterThan(-1);
    const seriesLockAt = adminSchedule.indexOf('RecurringAppointmentSeeder.checkActiveSeriesLocked(trx, {', rowLockAt);
    expect(seriesLockAt).toBeGreaterThan(rowLockAt);
  });

  test('estimate-converter.js: the standalone (no caller transaction) seeding wrapper locks the customer row before fn(trx) can run its duplicate-series guard', () => {
    const wrapperAt = estimateConverter.indexOf('const runSeedingStep = (fn) => (seedsInOwnTransaction');
    expect(wrapperAt).toBeGreaterThan(-1);
    const commsLockAt = estimateConverter.indexOf('await lockCustomerComms(trx, customerId);', wrapperAt);
    expect(commsLockAt).toBeGreaterThan(wrapperAt);
    const rowLockAt = estimateConverter.indexOf(
      "await trx('customers').where({ id: customerId }).forUpdate().first('id');",
      commsLockAt,
    );
    expect(rowLockAt).toBeGreaterThan(commsLockAt);
    // ...and it precedes the `fn(trx)` call that runs the caller's
    // checkActiveSeriesLocked (three call sites all route through here).
    const fnCallAt = estimateConverter.indexOf('return fn(trx);', rowLockAt);
    expect(fnCallAt).toBeGreaterThan(rowLockAt);
  });

  test('estimate-converter.js: the caller-transaction path already locked the customer row earlier in the same function (pre-existing, unchanged)', () => {
    const callerRowLockAt = estimateConverter.indexOf(
      "const lockedCustomerRow = await database('customers')\n        .where({ id: customerId })\n        .forUpdate()",
    );
    expect(callerRowLockAt).toBeGreaterThan(-1);
    const prePassAt = estimateConverter.indexOf('RecurringAppointmentSeeder.acquireSeriesCreateLocks(lockTrx, lockUnits);');
    expect(prePassAt).toBeGreaterThan(callerRowLockAt);
  });
});
