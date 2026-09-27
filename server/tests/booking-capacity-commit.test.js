/**
 * Confirm-time whole-route capacity re-check for self-serve bookings
 * (GATE_BOOK_CAPACITY_COMMIT, owner-approved 2026-09-26 dispatch backlog) —
 * prepared before createSelfBooking's transaction and verified inside it
 * (Codex #4992: no one-use helper).
 *
 * Its behavior is driven end to end elsewhere: the gate matrix, the
 * SLOT_TAKEN refusal and certified-order persistence through createSelfBooking
 * in booking-confirm-signed-offer.test.js, and the real whole-route
 * simulation (feasible / non-overlapping overload / stale-order fallback)
 * against PostgreSQL in booking-capacity-commit-db.test.js. Neither can see
 * WHERE the check runs, which is the contract here: under the tech-day
 * advisory lock the transaction already holds, on that transaction's own
 * connection, and before either booking row is written — so no concurrent
 * confirm on the same tech-day can land between the check and the insert.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../routes/booking.js'), 'utf8');
const fn = src.slice(src.indexOf('async function createSelfBooking'));

test('traffic is prepared before the transaction, then verified under selected + unassigned day fences before row locks or inserts', () => {
  const transaction = fn.indexOf('txResult = await db.transaction');
  const prepare = fn.indexOf('preparedCapacity = await prepareArrivalCapacity({');
  const capacityLock = fn.indexOf('await lockTechDays(trx, [');
  const capacityBranch = fn.lastIndexOf('if (preparedCapacity)', capacityLock);
  const firstRowLock = fn.indexOf('.forShare()', capacityLock);
  const verify = fn.indexOf(".verifyArrivalCapacity(preparedCapacity, {");
  const bookingInsert = fn.indexOf("await trx('self_booked_appointments').insert({");
  const visitInsert = fn.indexOf("trx('scheduled_services')", bookingInsert);
  expect(prepare).toBeGreaterThan(-1);
  expect(prepare).toBeLessThan(transaction);
  expect(capacityLock).toBeGreaterThan(transaction);
  expect(capacityBranch).toBeGreaterThan(transaction);
  expect(capacityBranch).toBeLessThan(capacityLock);
  const lockBlock = fn.slice(capacityLock, capacityLock + 220);
  expect(lockBlock).toContain('{ techId: technician_id, date: slotDateStr }');
  expect(lockBlock).toContain('{ techId: null, date: slotDateStr }');
  expect(firstRowLock).toBeGreaterThan(capacityLock);
  expect(verify).toBeGreaterThan(firstRowLock);
  expect(bookingInsert).toBeGreaterThan(verify);
  expect(visitInsert).toBeGreaterThan(verify);
  expect(fn.slice(verify, verify + 140)).toContain('conn: trx,');
  expect(fn).not.toContain('capacityCommitFit = await checkArrivalPlacement');
});
