/**
 * Confirm-time whole-route capacity re-check for self-serve bookings
 * (GATE_BOOK_CAPACITY_COMMIT, owner-approved 2026-09-26 dispatch backlog) —
 * inline in createSelfBooking's transaction (Codex #4992: no one-use helper).
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

test('the re-check runs under the tech-day lock, on the booking transaction, before either booking row is inserted', () => {
  const techDayLock = fn.indexOf("['slot-reserve', `${technician_id}:${slotDateStr}`]");
  const check = fn.indexOf('capacityCommitFit = await checkArrivalPlacement({');
  const bookingInsert = fn.indexOf("await trx('self_booked_appointments').insert({");
  const visitInsert = fn.indexOf("trx('scheduled_services')", bookingInsert);
  expect(techDayLock).toBeGreaterThan(-1);
  expect(check).toBeGreaterThan(techDayLock);
  expect(bookingInsert).toBeGreaterThan(check);
  expect(visitInsert).toBeGreaterThan(check);
  expect(fn.slice(check, check + 120)).toContain('conn: trx,');
});
