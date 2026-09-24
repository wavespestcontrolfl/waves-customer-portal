/**
 * Source-order regression for GitHub Codex #4716 P1s (rounds 1 and 2): every
 * series-creator transaction that can insert/lock a scheduled_services row
 * for a customer must lock the `customers` row FOR UPDATE (or FOR NO KEY
 * UPDATE) BEFORE it takes any scheduled_services row lock, write, or the
 * 'recurring-series-create' advisory lock (checkActiveSeriesLocked /
 * acquireSeriesCreateLocks).
 *
 * Why this matters: executeMerge (customer-dedupe.js) locks the customer row
 * FOR UPDATE FIRST and only then sweeps scheduled_services (FK repoint,
 * address stamp) and waits on the recurring-series-create advisory lock.
 * Any creator path that takes its scheduled_services lock/write BEFORE the
 * customer row — or takes the advisory lock without ever locking the
 * customer row first — can hold what the merge is waiting for while
 * waiting for what the merge holds: an ABBA deadlock Postgres resolves by
 * aborting one side (and checkActiveSeriesLocked's fail-open-on-error
 * guard would then let the aborted side's own duplicate-series check
 * silently pass).
 *
 * r1 fixed: booking.js's post-commit pest follow-up seeding (missing the
 * row lock entirely) and estimate-converter.js's standalone runSeedingStep
 * path (same gap). r2 fixed two more, both already holding a
 * scheduled_services lock or advisory guard call BEFORE any customer row
 * lock in the same transaction:
 *   - admin-schedule.js PUT /:id/update-details: the customer row lock
 *     (originally added in r1, deep inside the make-recurring spawn block)
 *     ran AFTER this route had already FOR UPDATE-locked and written the
 *     edited scheduled_services row earlier in the same transaction. Moved
 *     to the transaction's existing comms-lock section, right after
 *     lockCustomerComms and before every scheduled_services touch.
 *   - booking.js activateWizardSeries: the parent scheduled_services row
 *     (lockedParent) was FOR UPDATE-locked BEFORE the customer row was
 *     ever locked (the existing bookedCustomerRow FOR UPDATE read, further
 *     down, only preceded the advisory guard — not the parent row lock).
 *     Added a customer row lock at the top of the function's own
 *     transaction, before lockedParent.
 *
 * This codebase's own established pattern for pinning ordering inside a
 * function too large to unit-test directly is a source `.indexOf()`
 * position assertion (see tests/setup-fee-followups-contracts.test.js for
 * the same technique against this same file) — a live-DB integration test
 * would be needed to prove the deadlock itself, but this pins the specific
 * code shape so a future edit cannot silently re-order the locks without
 * failing a test.
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

describe('booking.js activateWizardSeries — customer row lock before the parent row lock and the series-advisory guard (Codex #4716 r2)', () => {
  test('the customer row lock (new in r2) precedes lockedParent\'s scheduled_services FOR UPDATE, which precedes checkActiveSeriesLocked', () => {
    // Anchor on the function's own definition — it opens its OWN fresh
    // db.transaction, so this one fix covers every entry into it.
    const fnAt = booking.indexOf('const activateWizardSeries = async (seriesParentRow) => {');
    expect(fnAt).toBeGreaterThan(-1);
    const commsLockAt = booking.indexOf('await lockCustomerComms(trx, custId);', fnAt);
    expect(commsLockAt).toBeGreaterThan(fnAt);
    const rowLockAt = booking.indexOf(
      "await trx('customers').where({ id: custId }).forUpdate().first('id');",
      commsLockAt,
    );
    expect(rowLockAt).toBeGreaterThan(commsLockAt);
    const parentRowLockAt = booking.indexOf(
      "const lockedParent = await trx('scheduled_services')",
      rowLockAt,
    );
    expect(parentRowLockAt).toBeGreaterThan(rowLockAt);
    // ...and nothing between the comms lock and the customer row lock
    // already touched scheduled_services with a lock or write (the
    // planFollowUpSeedDates call above them is documented as plain reads).
    const gap = booking.slice(commsLockAt, rowLockAt);
    expect(gap).not.toMatch(/scheduled_services'\)[^;]*\.forUpdate\(/s);
    expect(gap).not.toMatch(/scheduled_services'\)[^;]*\.update\(/s);
    const seriesLockAt = booking.indexOf('RecurringAppointmentSeeder.checkActiveSeriesLocked(trx, {', parentRowLockAt);
    expect(seriesLockAt).toBeGreaterThan(parentRowLockAt);
  });

  test('regression: the customer row lock strictly precedes the parent scheduled_services FOR UPDATE inside activateWizardSeries', () => {
    const fnAt = booking.indexOf('const activateWizardSeries = async (seriesParentRow) => {');
    const rowLockAt = booking.indexOf(
      "await trx('customers').where({ id: custId }).forUpdate().first('id');",
      fnAt,
    );
    const parentRowLockAt = booking.indexOf("const lockedParent = await trx('scheduled_services')", fnAt);
    expect(rowLockAt).toBeGreaterThan(fnAt);
    expect(parentRowLockAt).toBeGreaterThan(rowLockAt);
  });

  test('both entries into activateWizardSeries (the primary path and the crash-retry replay path) share this one fix — there is exactly one function definition and both call sites reference it', () => {
    const definitions = booking.match(/const activateWizardSeries = async \(seriesParentRow\) => \{/g) || [];
    expect(definitions.length).toBe(1);
    expect(booking).toMatch(/const seriesOutcome = await activateWizardSeries\(serviceRow\);/);
    expect(booking).toMatch(/const replayActivation = await activateWizardSeries\(replayParent\);/);
  });
});

describe('other checkActiveSeriesLocked / acquireSeriesCreateLocks callers audited in the same round (#4716 r1)', () => {
  test('admin-schedule.js PUT /:id/update-details: the customer row lock sits in the comms-lock section, before the FIRST scheduled_services row lock/write and before the make-recurring spawn path\'s duplicate-series guard (Codex #4716 r2)', () => {
    // Anchor on this transaction's own start (the commsPeek provisional
    // read is unique to this route and always runs first).
    const txnStartAt = adminSchedule.indexOf("const commsPeek = await trx('scheduled_services')");
    expect(txnStartAt).toBeGreaterThan(-1);
    const commsLockAt = adminSchedule.indexOf('if (commsPeek) await lockCustomerComms(trx, commsPeek.customer_id);', txnStartAt);
    expect(commsLockAt).toBeGreaterThan(txnStartAt);
    const rowLockAt = adminSchedule.indexOf(
      "if (commsPeek) await trx('customers').where({ id: commsPeek.customer_id }).forUpdate().first('id');",
      commsLockAt,
    );
    expect(rowLockAt).toBeGreaterThan(commsLockAt);
    // The FIRST scheduled_services row lock/write in this transaction (the
    // occupancy re-check's occRow FOR UPDATE) must come strictly AFTER the
    // customer row lock, not before it.
    const firstScheduledServicesLockAt = adminSchedule.indexOf(
      "await trx('scheduled_services').where({ id: req.params.id }).forUpdate().first();",
      rowLockAt,
    );
    expect(firstScheduledServicesLockAt).toBeGreaterThan(rowLockAt);
    // ...and it is genuinely the FIRST one — nothing between the transaction
    // start and the customer row lock already touched scheduled_services
    // with a lock (a plain, unlocked commsPeek/provisional read is fine and
    // expected; a `.forUpdate()` or `.update(` between them would mean a
    // write/lock slipped in ahead of the customer row lock).
    const txnSlice = adminSchedule.slice(txnStartAt, rowLockAt);
    expect(txnSlice).not.toMatch(/scheduled_services'\)[^;]*\.forUpdate\(/s);
    expect(txnSlice).not.toMatch(/scheduled_services'\)[^;]*\.update\(/s);
    // The details write itself, and the make-recurring spawn block's own
    // duplicate-series guard, both still land well after the row lock.
    const detailsWriteAt = adminSchedule.indexOf(
      "await trx('scheduled_services').where({ id: req.params.id }).update(updates);",
      rowLockAt,
    );
    expect(detailsWriteAt).toBeGreaterThan(firstScheduledServicesLockAt);
    const spawnBlockAt = adminSchedule.indexOf('Spawn recurring children if requested', detailsWriteAt);
    expect(spawnBlockAt).toBeGreaterThan(detailsWriteAt);
    const seriesLockAt = adminSchedule.indexOf('RecurringAppointmentSeeder.checkActiveSeriesLocked(trx, {', spawnBlockAt);
    expect(seriesLockAt).toBeGreaterThan(spawnBlockAt);
    expect(seriesLockAt).toBeGreaterThan(rowLockAt);
  });

  // Regression: if the customer row lock is ever moved back into the spawn
  // block (or dropped from the comms-lock section), the assertions above
  // fail. This is an additional, independent pin that inspects only marker
  // order, so it survives unrelated edits to the block's internals.
  test('regression: admin-schedule.js update-details customer row lock strictly precedes the first scheduled_services forUpdate in that transaction', () => {
    const txnStartAt = adminSchedule.indexOf("const commsPeek = await trx('scheduled_services')");
    const rowLockAt = adminSchedule.indexOf(
      "if (commsPeek) await trx('customers').where({ id: commsPeek.customer_id }).forUpdate().first('id');",
      txnStartAt,
    );
    const firstScheduledServicesLockAt = adminSchedule.indexOf(
      "await trx('scheduled_services').where({ id: req.params.id }).forUpdate().first();",
      txnStartAt,
    );
    expect(rowLockAt).toBeGreaterThan(txnStartAt);
    expect(firstScheduledServicesLockAt).toBeGreaterThan(rowLockAt);
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
