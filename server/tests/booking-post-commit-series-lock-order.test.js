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

describe('admin-schedule.js PUT /:id/update-details — combined-payment lock before the customer row lock (#4716 pre-push)', () => {
  // executeMerge (customer-dedupe.js) takes pay.combined.customer
  // UNCONDITIONALLY before its `customers` FOR UPDATE, and the customer
  // editors (admin-customers.js) follow the same order for a payer change.
  // The r2 commit moved this route's customer row lock into the comms-lock
  // section, but left the combined-payment lock (taken only when the save
  // touches payer_id/self_pay_override) AFTER it — the exact inversion this
  // pin guards against.
  test('the payer/self_pay_override combined-payment lock precedes the customers FOR UPDATE row lock', () => {
    const txnStartAt = adminSchedule.indexOf("const commsPeek = await trx('scheduled_services')");
    expect(txnStartAt).toBeGreaterThan(-1);
    const commsLockAt = adminSchedule.indexOf('if (commsPeek) await lockCustomerComms(trx, commsPeek.customer_id);', txnStartAt);
    expect(commsLockAt).toBeGreaterThan(txnStartAt);
    const combinedLockAt = adminSchedule.indexOf(
      "await require('../services/pay-combined').lockCombinedCustomers(trx, [String(provCust.customer_id)]);",
      commsLockAt,
    );
    expect(combinedLockAt).toBeGreaterThan(commsLockAt);
    const rowLockAt = adminSchedule.indexOf(
      "if (commsPeek) await trx('customers').where({ id: commsPeek.customer_id }).forUpdate().first('id');",
      combinedLockAt,
    );
    expect(rowLockAt).toBeGreaterThan(combinedLockAt);
  });

  test('regression: the combined-payment lock block sits strictly between the comms lock and the customer row lock, with no scheduled_services lock/write in between', () => {
    const txnStartAt = adminSchedule.indexOf("const commsPeek = await trx('scheduled_services')");
    const commsLockAt = adminSchedule.indexOf('if (commsPeek) await lockCustomerComms(trx, commsPeek.customer_id);', txnStartAt);
    const rowLockAt = adminSchedule.indexOf(
      "if (commsPeek) await trx('customers').where({ id: commsPeek.customer_id }).forUpdate().first('id');",
      commsLockAt,
    );
    const gap = adminSchedule.slice(commsLockAt, rowLockAt);
    expect(gap).toMatch(/lockCombinedCustomers\(trx, \[String\(provCust\.customer_id\)\]\)/);
    expect(gap).not.toMatch(/scheduled_services'\)[^;]*\.forUpdate\(/s);
    expect(gap).not.toMatch(/scheduled_services'\)[^;]*\.update\(/s);
  });
});

describe('booking.js activateWizardSeries — no combined-payment lock in this transaction (#4716 pre-push, confirmed no-op)', () => {
  // activateWizardSeries never requires pay-combined or calls
  // lockCombinedCustomers, and never writes payer_id/self_pay_override — it
  // only creates/activates a recurring series. There is no combined-payment
  // advisory lock in this function for the customer-row lock (added in r2)
  // to invert against.
  test('activateWizardSeries never references pay-combined or lockCombinedCustomers', () => {
    const fnAt = booking.indexOf('const activateWizardSeries = async (seriesParentRow) => {');
    expect(fnAt).toBeGreaterThan(-1);
    // Bound the search to this function's body by the next top-level const
    // definition that follows it in the file (replayActivation's call site
    // sits well after the function's closing brace).
    const nextAnchorAt = booking.indexOf('const replayActivation = await activateWizardSeries(replayParent);', fnAt);
    expect(nextAnchorAt).toBeGreaterThan(fnAt);
    const fnBody = booking.slice(fnAt, nextAnchorAt);
    expect(fnBody).not.toMatch(/pay-combined/);
    expect(fnBody).not.toMatch(/lockCombinedCustomers/);
    expect(fnBody).not.toMatch(/payer_id/);
    expect(fnBody).not.toMatch(/self_pay_override/);
  });
});

// ---------------------------------------------------------------------------
// Codex #4716 r3 P1s: a merge can COMMIT between the booking's own
// transaction and one of these post-commit follow-up transactions, repointing
// the parent scheduled_services row's customer_id to the winner while the
// follow-up transaction still holds (and is handed) the retired loser's
// row lock. Both creators now re-read the parent under lock, verify its
// owner, and retry the WHOLE transaction under the real owner through one
// shared mechanism (SeriesOwnerMovedError / lockAndVerifySeriesParentOwner /
// runSeriesTxWithOwnerRetry) instead of building the duplicate guard, the
// draft-owner check, or the seeded children off the stale id.
// ---------------------------------------------------------------------------

describe('SeriesOwnerMovedError / lockAndVerifySeriesParentOwner / runSeriesTxWithOwnerRetry — the shared owner-move retry primitive (Codex #4716 r3)', () => {
  const {
    SeriesOwnerMovedError,
    lockAndVerifySeriesParentOwner,
    runSeriesTxWithOwnerRetry,
  } = require('../routes/booking')._internals;

  test('all three primitives are exported', () => {
    expect(typeof SeriesOwnerMovedError).toBe('function');
    expect(typeof lockAndVerifySeriesParentOwner).toBe('function');
    expect(typeof runSeriesTxWithOwnerRetry).toBe('function');
  });

  test('lockAndVerifySeriesParentOwner returns the row when it still belongs to the expected customer (fast path)', async () => {
    const trx = jest.fn(() => ({
      where: (cond) => {
        expect(cond).toEqual({ id: 'svc-1' });
        return {
          forUpdate: () => ({
            first: async (cols) => {
              expect(cols).toBe('*');
              return { id: 'svc-1', customer_id: 'cust-A' };
            },
          }),
        };
      },
    }));
    const row = await lockAndVerifySeriesParentOwner(trx, { parentId: 'svc-1', expectedCustomerId: 'cust-A' });
    expect(row).toEqual({ id: 'svc-1', customer_id: 'cust-A' });
    expect(trx).toHaveBeenCalledWith('scheduled_services');
  });

  test('a merge-moved parent throws SeriesOwnerMovedError carrying the row\'s CURRENT (winner) owner', async () => {
    const trx = jest.fn(() => ({
      where: () => ({ forUpdate: () => ({ first: async () => ({ id: 'svc-1', customer_id: 'cust-WINNER' }) }) }),
    }));
    let caught = null;
    try {
      await lockAndVerifySeriesParentOwner(trx, { parentId: 'svc-1', expectedCustomerId: 'cust-LOSER' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SeriesOwnerMovedError);
    expect(caught.code).toBe('SERIES_OWNER_MOVED');
    expect(caught.newCustomerId).toBe('cust-WINNER');
    expect(caught.parentRow).toEqual({ id: 'svc-1', customer_id: 'cust-WINNER' });
  });

  test('a missing parent row (deleted/cancelled by the merge) resolves null rather than throwing — the caller keeps its own existing missing-parent handling', async () => {
    const trx = jest.fn(() => ({ where: () => ({ forUpdate: () => ({ first: async () => undefined }) }) }));
    await expect(lockAndVerifySeriesParentOwner(trx, { parentId: 'svc-gone', expectedCustomerId: 'cust-A' }))
      .resolves.toBeUndefined();
  });

  test('unchanged-owner fast path: the transaction body runs exactly once and onOwnerChange is never called', async () => {
    const db = { transaction: (fn) => fn('trx-handle') };
    const onOwnerChange = jest.fn();
    let calls = 0;
    const result = await runSeriesTxWithOwnerRetry(db, async (trx) => {
      calls += 1;
      expect(trx).toBe('trx-handle');
      return { seedResult: { insertedRows: [{ id: 'child-1', customer_id: 'cust-A' }] } };
    }, { onOwnerChange });
    expect(calls).toBe(1);
    expect(onOwnerChange).not.toHaveBeenCalled();
    expect(result.seedResult.insertedRows[0].customer_id).toBe('cust-A');
  });

  test('owner-changed case: ONE SeriesOwnerMovedError retries the WHOLE transaction under the new owner, calling onOwnerChange before the retry runs', async () => {
    const db = { transaction: (fn) => fn('trx-handle') };
    let attempt = 0;
    const onOwnerChange = jest.fn();
    const result = await runSeriesTxWithOwnerRetry(db, async () => {
      attempt += 1;
      if (attempt === 1) throw new SeriesOwnerMovedError('cust-WINNER', { id: 'svc-1', customer_id: 'cust-WINNER' });
      // The retried attempt builds its children off whatever the caller's
      // own transaction body derives AFTER onOwnerChange updated its owner
      // — proven here by the fact this second attempt only runs once
      // onOwnerChange has already fired.
      expect(onOwnerChange).toHaveBeenCalledTimes(1);
      return { seedResult: { insertedRows: [{ id: 'child-1', customer_id: 'cust-WINNER' }] } };
    }, { onOwnerChange });
    expect(attempt).toBe(2);
    expect(onOwnerChange).toHaveBeenCalledTimes(1);
    expect(onOwnerChange).toHaveBeenCalledWith('cust-WINNER', { id: 'svc-1', customer_id: 'cust-WINNER' });
    expect(result.seedResult.insertedRows[0].customer_id).toBe('cust-WINNER');
  });

  test('caps at 2 retries (3 total attempts) then rethrows the last SeriesOwnerMovedError so the path\'s own failure handling (loud log, price strip) still runs', async () => {
    const db = { transaction: (fn) => fn('trx-handle') };
    let attempts = 0;
    const onOwnerChange = jest.fn();
    await expect(runSeriesTxWithOwnerRetry(db, async () => {
      attempts += 1;
      throw new SeriesOwnerMovedError(`cust-${attempts}`, {});
    }, { onOwnerChange })).rejects.toMatchObject({ code: 'SERIES_OWNER_MOVED' });
    expect(attempts).toBe(3); // initial attempt + 2 retries, never a 4th
    expect(onOwnerChange).toHaveBeenCalledTimes(2);
  });

  test('a non-owner-move error is never retried and propagates on the first attempt', async () => {
    const db = { transaction: (fn) => fn('trx-handle') };
    let attempts = 0;
    const onOwnerChange = jest.fn();
    await expect(runSeriesTxWithOwnerRetry(db, async () => {
      attempts += 1;
      throw new Error('some unrelated failure');
    }, { onOwnerChange })).rejects.toThrow('some unrelated failure');
    expect(attempts).toBe(1);
    expect(onOwnerChange).not.toHaveBeenCalled();
  });
});

describe('booking.js pest follow-up seeding — re-verifies the parent owner under lock before the duplicate guard (Codex #4716 r3)', () => {
  test('the transaction runs through runSeriesTxWithOwnerRetry (not a bare db.transaction), so a merge-moved owner retries the whole thing', () => {
    const blockAt = booking.indexOf('Duplicate-series guard: don\'t seed a SECOND active series');
    expect(blockAt).toBeGreaterThan(-1);
    const nextBlockMarker = booking.indexOf('duplicateSeriesKept = pestDuplicateKeptAtBooking;', blockAt);
    const txStartAt = booking.indexOf('const outcome = await runSeriesTxWithOwnerRetry(db, async (trx) => {', nextBlockMarker);
    expect(txStartAt).toBeGreaterThan(nextBlockMarker);
    const onOwnerChangeAt = booking.indexOf('onOwnerChange: (newOwnerId) => { custId = newOwnerId; },', txStartAt);
    expect(onOwnerChangeAt).toBeGreaterThan(txStartAt);
  });

  test('the parent row lock/verify (lockAndVerifySeriesParentOwner) sits between the customers FOR UPDATE and checkActiveSeriesLocked', () => {
    const blockAt = booking.indexOf('Duplicate-series guard: don\'t seed a SECOND active series');
    const rowLockAt = booking.indexOf("await trx('customers').where({ id: custId }).forUpdate().first('id');", blockAt);
    expect(rowLockAt).toBeGreaterThan(blockAt);
    const verifyAt = booking.indexOf('const lockedParentRow = await lockAndVerifySeriesParentOwner(trx, {', rowLockAt);
    expect(verifyAt).toBeGreaterThan(rowLockAt);
    expect(booking.slice(verifyAt, verifyAt + 400)).toMatch(/parentId: serviceRow\.id,\s*\n\s*expectedCustomerId: custId,/);
    const staleReturnAt = booking.indexOf('if (!lockedParentRow) return { stale: true };', verifyAt);
    expect(staleReturnAt).toBeGreaterThan(verifyAt);
    const effectiveParentAt = booking.indexOf('const effectiveParent = { ...serviceRow, ...lockedParentRow };', staleReturnAt);
    expect(effectiveParentAt).toBeGreaterThan(staleReturnAt);
    const seriesLockAt = booking.indexOf('RecurringAppointmentSeeder.checkActiveSeriesLocked(trx, {', effectiveParentAt);
    expect(seriesLockAt).toBeGreaterThan(effectiveParentAt);
  });

  test('every customer-scoped read after the verify uses the RE-READ effectiveParent, never the stale in-memory serviceRow (children carry the winner\'s customer_id)', () => {
    const blockAt = booking.indexOf('Duplicate-series guard: don\'t seed a SECOND active series');
    const effectiveParentAt = booking.indexOf('const effectiveParent = { ...serviceRow, ...lockedParentRow };', blockAt);
    const blockEndAt = booking.indexOf('return { seedResult };', effectiveParentAt);
    expect(blockEndAt).toBeGreaterThan(effectiveParentAt);
    const body = booking.slice(effectiveParentAt, blockEndAt);
    // seedFollowUpsForParent — where a customer_id: parent.customer_id
    // (recurring-appointment-seeder.js) mints every child row — is handed
    // the re-read row, not serviceRow.
    expect(body).toMatch(/RecurringAppointmentSeeder\.seedFollowUpsForParent\(trx, effectiveParent, \{/);
    expect(body).not.toMatch(/RecurringAppointmentSeeder\.seedFollowUpsForParent\(trx, serviceRow,/);
    // The duplicate-series guard and the setup-fee stamp read the same
    // re-verified row too.
    expect(body).toMatch(/serviceId: effectiveParent\.service_id \|\| null,/);
    expect(body).toMatch(/excludeParentId: effectiveParent\.id,/);
    expect(body).toMatch(/stampDisclosedSetupFee\(trx, \{ stampServiceRow: effectiveParent \}\);/);
    // The seeder itself really does copy customer_id straight from the
    // parent object it is handed (proves the re-read row is what decides
    // the children's owner, not merely passed through unused).
    const seeder = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'recurring-appointment-seeder.js'), 'utf8');
    expect(seeder).toMatch(/customer_id: parent\.customer_id,/);
  });

  test('a stale/missing parent (deleted or repointed away entirely) short-circuits to { stale: true } without seeding or stamping', () => {
    const blockAt = booking.indexOf('Duplicate-series guard: don\'t seed a SECOND active series');
    const staleReturnAt = booking.indexOf('if (!lockedParentRow) return { stale: true };', blockAt);
    expect(staleReturnAt).toBeGreaterThan(blockAt);
    const outcomeHandlingAt = booking.indexOf('if (outcome.kept) duplicateSeriesKept = outcome.kept;', blockAt);
    expect(outcomeHandlingAt).toBeGreaterThan(staleReturnAt);
    expect(booking.slice(outcomeHandlingAt, outcomeHandlingAt + 200))
      .toMatch(/else if \(outcome\.seedResult\) followUpRows = outcome\.seedResult\.insertedRows \|\| \[\];/);
  });
});

describe('booking.js activateWizardSeries — re-verifies the parent owner under lock before it can read stale drift or seed stale children (Codex #4716 r3)', () => {
  test('activateWizardSeries also runs through runSeriesTxWithOwnerRetry, wired with the same onOwnerChange(custId) callback', () => {
    const fnAt = booking.indexOf('const activateWizardSeries = async (seriesParentRow) => {');
    expect(fnAt).toBeGreaterThan(-1);
    const txStartAt = booking.indexOf('const outcome = await runSeriesTxWithOwnerRetry(db, async (trx) => {', fnAt);
    expect(txStartAt).toBeGreaterThan(fnAt);
    const returnAt = booking.indexOf("return { seedResult, parentExtension };", txStartAt);
    expect(returnAt).toBeGreaterThan(txStartAt);
    const onOwnerChangeAt = booking.indexOf('onOwnerChange: (newOwnerId) => { custId = newOwnerId; },', returnAt);
    expect(onOwnerChangeAt).toBeGreaterThan(returnAt);
    const returnOutcomeAt = booking.indexOf('return outcome;', onOwnerChangeAt);
    expect(returnOutcomeAt).toBeGreaterThan(onOwnerChangeAt);
  });

  test('lockedParent now selects customer_id and is verified BEFORE the alreadyActivated / priced-state checks', () => {
    const fnAt = booking.indexOf('const activateWizardSeries = async (seriesParentRow) => {');
    const lockedParentAt = booking.indexOf("const lockedParent = await trx('scheduled_services')", fnAt);
    expect(lockedParentAt).toBeGreaterThan(fnAt);
    expect(booking.slice(lockedParentAt, lockedParentAt + 400))
      .toMatch(/\.first\('id', 'customer_id', 'is_recurring', 'status', 'payment_method_preference',/);
    const throwAt = booking.indexOf('throw new SeriesOwnerMovedError(lockedParent.customer_id, lockedParent);', lockedParentAt);
    expect(throwAt).toBeGreaterThan(lockedParentAt);
    // The owner check precedes BOTH the alreadyActivated fast path and the
    // priced-state drift check that strips price/payment/invoice — a
    // merge-moved parent must retry, never read as "drift" and get
    // stripped.
    const alreadyActivatedAt = booking.indexOf('alreadyActivated: true', throwAt);
    const pricedStateAt = booking.indexOf('no longer matches its priced state under lock', throwAt);
    expect(alreadyActivatedAt).toBeGreaterThan(throwAt);
    expect(pricedStateAt).toBeGreaterThan(throwAt);
  });

  test('the in-memory seriesParentRow.customer_id is re-synced from the locked row right after the owner check — the wizard activation keeps price/payment/invoice_flag intact because seedFollowUpsForParent (and every downstream helper keyed on seriesParentRow) now carries the REAL owner', () => {
    const fnAt = booking.indexOf('const activateWizardSeries = async (seriesParentRow) => {');
    const throwAt = booking.indexOf('throw new SeriesOwnerMovedError(lockedParent.customer_id, lockedParent);', fnAt);
    const syncAt = booking.indexOf('if (lockedParent) seriesParentRow.customer_id = lockedParent.customer_id;', throwAt);
    expect(syncAt).toBeGreaterThan(throwAt);
    const isRecurringCheckAt = booking.indexOf('if (lockedParent && lockedParent.is_recurring) {', syncAt);
    expect(isRecurringCheckAt).toBeGreaterThan(syncAt);
    // seedFollowUpsForParent is still handed seriesParentRow (now correctly
    // synced) — the price/payment/invoice fields it stamps on the parent,
    // and the customer_id it stamps on every seeded child, both read off
    // this one object.
    const seedAt = booking.indexOf('await RecurringAppointmentSeeder.seedFollowUpsForParent(trx, seriesParentRow', fnAt);
    expect(seedAt).toBeGreaterThan(syncAt);
  });

  test('regression: SeriesOwnerMovedError is thrown strictly between the lockedParent FOR UPDATE read and every custId-keyed check that follows it (draft-owner compare, duplicate guard)', () => {
    const fnAt = booking.indexOf('const activateWizardSeries = async (seriesParentRow) => {');
    const lockedParentAt = booking.indexOf("const lockedParent = await trx('scheduled_services')", fnAt);
    const throwAt = booking.indexOf('throw new SeriesOwnerMovedError(lockedParent.customer_id, lockedParent);', lockedParentAt);
    const draftOwnerCheckAt = booking.indexOf("String(lockedDraft.customer_id) === String(custId)", lockedParentAt);
    const dupGuardAt = booking.indexOf('checkActiveSeriesLocked(trx, {', lockedParentAt);
    expect(throwAt).toBeGreaterThan(lockedParentAt);
    expect(draftOwnerCheckAt).toBeGreaterThan(throwAt);
    expect(dupGuardAt).toBeGreaterThan(throwAt);
  });
});
