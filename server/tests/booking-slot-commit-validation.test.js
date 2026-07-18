/**
 * Booking-audit P1s — commit-time slot validation, coordinate exposure,
 * confirmation-code strength, and /status/:code enumeration guard.
 *
 * POST /booking/confirm is public: the availability builder only OFFERS
 * conforming slots, so every rule it applies (day window, whole-hour grid,
 * lunch block, ET date bounds, day cap, real active tech, catalog-range
 * duration) must be re-checked at commit or a crafted payload books whatever
 * it likes — and every check that needs no customer row must run BEFORE the
 * new-customer insert, or a rejection strands an orphan profile. Unit tests cover
 * the pure helpers; source-pattern guards (house style — see
 * attribution-capture-wiring.test.js) pin the call sites so a refactor can't
 * silently drop them.
 */
const fs = require('fs');
const path = require('path');

const { _internals } = require('../routes/booking');
const {
  bookingSlotWindow,
  resolveBookingDuration,
  normalizeBookingServiceKey,
  bookingOfferLocationKey,
  BOOKING_FUNNEL_SERVICE_DURATIONS,
  validateBookingSlotGeometry,
  validateBookingSlotDate,
  generateConfirmationCode,
  roundPublicCoord,
  bookingStatusLimiter,
  createSelfBooking,
  MAX_BOOKING_HORIZON_DAYS,
} = _internals;
const { etDateString, addETDays } = require('../utils/datetime-et');

const src = fs.readFileSync(path.join(__dirname, '../routes/booking.js'), 'utf8');

const min = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// ---------------------------------------------------------------------------
// FIX 1 — slot geometry mirrors the availability builder
// ---------------------------------------------------------------------------

describe('bookingSlotWindow — one config derivation for builder + commit', () => {
  test('defaults match the availability builder (08:00–17:00, 12–13 lunch, cap 3, hourly grid)', () => {
    expect(bookingSlotWindow({})).toEqual({
      slotGridMinutes: 60,
      dayStartMin: 480,
      dayEndMin: 1020,
      lunchStartMin: 720,
      lunchEndMin: 780,
      maxPerDay: 3,
    });
  });

  test('honors configured hours, lunch, and cap', () => {
    const w = bookingSlotWindow({
      day_start: '09:00', day_end: '18:00',
      lunch_start: '11:30', lunch_end: '12:30',
      max_self_books_per_day: 5,
    });
    expect(w).toMatchObject({
      dayStartMin: 540, dayEndMin: 1080,
      lunchStartMin: 690, lunchEndMin: 750, maxPerDay: 5,
    });
  });

  test('the availability builder consumes the SAME derivation (no duplicated constants)', () => {
    // builder destructures it + createSelfBooking geometry/day-cap use it
    expect((src.match(/bookingSlotWindow\(config\)/g) || []).length).toBeGreaterThanOrEqual(3);
    // the old inline constants are gone from the builder
    expect(src).not.toMatch(/const slotGridMinutes = 60;/);
  });
});

describe('validateBookingSlotGeometry — forged-slot rejection', () => {
  const ok = (startHHMM, duration = 60, config = {}) =>
    validateBookingSlotGeometry({ startMin: min(startHHMM), duration, config });

  test('accepts every slot the builder offers (whole hours, in-hours, off-lunch)', () => {
    for (const t of ['08:00', '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00']) {
      expect(ok(t)).toBeNull();
    }
  });

  test('rejects out-of-hours starts (before day_start / ending after day_end)', () => {
    expect(ok('07:00')).toMatch(/working hours/i);
    expect(ok('17:00')).toMatch(/working hours/i); // ends 18:00 > 17:00
    expect(ok('16:00', 90)).toMatch(/working hours/i); // 90-min ends 17:30
    expect(ok('23:00')).toMatch(/working hours/i);
  });

  test('rejects grid-misaligned starts (builder offers whole hours only)', () => {
    expect(ok('09:30')).toMatch(/bookable slots/i);
    expect(ok('08:15')).toMatch(/bookable slots/i);
    expect(ok('10:01')).toMatch(/bookable slots/i);
  });

  test('rejects the lunch block, including overlap-by-duration', () => {
    expect(ok('12:00')).toMatch(/isn.t available/i);
    expect(ok('11:00', 90)).toMatch(/isn.t available/i); // ends 12:30, inside lunch
    expect(ok('11:00', 60)).toBeNull(); // ends exactly at lunch start
    expect(ok('13:00', 60)).toBeNull(); // starts exactly at lunch end
  });

  test('respects a configured day window', () => {
    const config = { day_start: '09:00', day_end: '18:00' };
    expect(ok('08:00', 60, config)).toMatch(/working hours/i);
    expect(ok('17:00', 60, config)).toBeNull(); // ends exactly at 18:00
  });
});

describe('resolveBookingDuration — server-derived, never trusted raw', () => {
  test('a recognized funnel service PINS its catalog duration — the client minutes are ignored', () => {
    // The server-side mirror of the client SERVICES array is the authority.
    expect(BOOKING_FUNNEL_SERVICE_DURATIONS).toEqual({
      pest_control: 60,
      lawn_care: 60,
      mosquito: 45,
      tree_shrub: 60,
      termite: 90,
      rodent: 60,
      bora_care: 90,
    });
    for (const [key, minutes] of Object.entries(BOOKING_FUNNEL_SERVICE_DURATIONS)) {
      // Whatever the caller asks for — in-range, out-of-range, garbage — the
      // catalog wins for a known service.
      for (const requested of [45, 60, 90, 15, 600, 'abc', null]) {
        expect(resolveBookingDuration(requested, {}, key)).toBe(minutes);
      }
    }
  });

  test('normalizeBookingServiceKey maps catalog ids AND funnel display labels; unknown → empty', () => {
    expect(normalizeBookingServiceKey('pest_control')).toBe('pest_control');
    expect(normalizeBookingServiceKey('Pest Control')).toBe('pest_control');
    expect(normalizeBookingServiceKey('  Mosquito Control ')).toBe('mosquito');
    expect(normalizeBookingServiceKey('Termite Inspection')).toBe('termite');
    expect(normalizeBookingServiceKey('German Roach Cleanout')).toBe('');
    expect(normalizeBookingServiceKey('')).toBe('');
    expect(normalizeBookingServiceKey(null)).toBe('');
  });

  test('bookingOfferLocationKey — public rounding grid, idempotent for exact vs rounded echoes', () => {
    expect(bookingOfferLocationKey(27.336789, -82.530612)).toBe('27.34,-82.53');
    expect(bookingOfferLocationKey(27.34, -82.53)).toBe('27.34,-82.53'); // re-rounding a rounded echo
    expect(bookingOfferLocationKey(null, -82.53)).toBe('');
    expect(bookingOfferLocationKey('junk', 'junk')).toBe('');
  });

  test('accepts the funnel catalog range (45–90) including string form (unknown service)', () => {
    expect(resolveBookingDuration(45, {})).toBe(45);
    expect(resolveBookingDuration(75, {})).toBe(75);
    expect(resolveBookingDuration(90, {})).toBe(90);
    expect(resolveBookingDuration('60', {})).toBe(60);
  });

  test('forged tiny/huge/garbage durations fall back to the configured slot duration', () => {
    for (const forged of [1, 0, -30, 600, 'abc', null, undefined, NaN, 14.5]) {
      expect(resolveBookingDuration(forged, {})).toBe(60);
      expect(resolveBookingDuration(forged, { slot_duration_minutes: 45 })).toBe(45);
    }
  });

  test('durations OUTSIDE what the catalog actually emits (45–90) fall back — no 15-minute overlap-shrink, no 240-minute day block', () => {
    // The client SERVICES catalog (PublicBookingPage.jsx) only emits 45/60/90.
    // 15 and 240 were the old accepted bounds — a forged 15 shrank the
    // overlap-check window against 60-minute route slots.
    for (const outside of [15, 30, 44, 91, 120, 240]) {
      expect(resolveBookingDuration(outside, {})).toBe(60);
      expect(resolveBookingDuration(outside, { slot_duration_minutes: 90 })).toBe(90);
    }
  });
});

describe('validateBookingSlotDate — commit mirrors the builder\'s ET date bounds', () => {
  // Pin `now` so boundary math is deterministic; the helper computes both
  // bounds from the same injectable instant.
  const now = new Date('2026-07-10T16:00:00Z');
  const day = (n) => etDateString(addETDays(now, n));

  test('accepts every day the builder can offer (advance_days_min .. horizon)', () => {
    expect(validateBookingSlotDate(day(1), {}, now)).toBeNull();
    expect(validateBookingSlotDate(day(14), {}, now)).toBeNull();
    expect(validateBookingSlotDate(day(MAX_BOOKING_HORIZON_DAYS), {}, now)).toBeNull();
  });

  test('rejects days before the advance_days_min floor (default 1 — same-day never offered)', () => {
    expect(validateBookingSlotDate(day(0), {}, now)).toMatch(/no longer open/i);
    expect(validateBookingSlotDate(day(-3), {}, now)).toMatch(/no longer open/i);
  });

  test('honors a configured advance_days_min floor', () => {
    const config = { advance_days_min: 3 };
    expect(validateBookingSlotDate(day(2), config, now)).toMatch(/no longer open/i);
    expect(validateBookingSlotDate(day(3), config, now)).toBeNull();
  });

  test('rejects days beyond the 90-day booking horizon', () => {
    expect(validateBookingSlotDate(day(MAX_BOOKING_HORIZON_DAYS + 1), {}, now)).toMatch(/beyond our online booking window/i);
    expect(validateBookingSlotDate('2099-01-01', {}, now)).toMatch(/beyond our online booking window/i);
  });

  test('rejects IMPOSSIBLE calendar dates that sit lexically inside the bounds (2026-09-31)', () => {
    // Regex + lexical bounds admitted these; Postgres then rejected the date
    // AFTER the customer insert, stranding an orphan profile (audit round 2).
    expect(validateBookingSlotDate('2026-09-31', {}, now)).toMatch(/calendar day/i);
    expect(validateBookingSlotDate('2026-08-32', {}, now)).toMatch(/calendar day/i);
    expect(validateBookingSlotDate('2027-02-29', {}, now)).toMatch(/calendar day/i); // 2027 is no leap year
    // …while real days keep validating on the bounds alone.
    expect(validateBookingSlotDate(day(30), {}, now)).toBeNull();
  });

  test('the calendar round-trip runs BEFORE the bound checks (source order)', () => {
    const fnStart = src.indexOf('function validateBookingSlotDate(');
    const roundTripIdx = src.indexOf('isRealCalendarDate(slotDateStr)', fnStart);
    const boundIdx = src.indexOf('const minDate = etDateString(', fnStart);
    expect(roundTripIdx).toBeGreaterThan(fnStart);
    expect(roundTripIdx).toBeLessThan(boundIdx);
  });
});

describe('createSelfBooking — DB-free forged-payload rejections', () => {
  test('malformed slot_start → 400 before any numeric comparison sees NaN', async () => {
    // ('' is caught earlier by the required-fields check)
    for (const bad of ['abc', '25:00', '9:5', '12:60', '09:00:99', '09-00']) {
      expect(await createSelfBooking({ slot_date: '2099-01-01', slot_start: bad }))
        .toEqual({ ok: false, status: 400, error: 'Invalid slot_start' });
    }
  });

  test('valid slot_start shapes still pass the format gate (fail later on identity)', async () => {
    for (const good of ['09:00', '9:00', '13:00:00']) {
      const result = await createSelfBooking({ slot_date: '2099-01-01', slot_start: good });
      expect(result.error).not.toBe('Invalid slot_start');
    }
  });
});

describe('createSelfBooking commit-path wiring (source guards)', () => {
  test('geometry validation runs at commit with the server-resolved duration', () => {
    expect(src).toMatch(/const geometryError = validateBookingSlotGeometry\(\{\s*\n?\s*startMin: timeToMin\(slot_start\), duration, config,/);
    expect(src).toMatch(/const duration = resolveBookingDuration\(duration_minutes, config, serviceKey\);/);
  });

  test('end time is ALWAYS start + duration; a disagreeing client slot_end is rejected', () => {
    expect(src).toMatch(/const endMin = timeToMin\(slot_start\) \+ duration;/);
    expect(src).toMatch(/if \(slot_end && timeToMin\(slot_end\) !== endMin\)/);
    // the old client-trusted form is gone
    expect(src).not.toMatch(/slot_end \? timeToMin\(slot_end\) : \(timeToMin\(slot_start\) \+ duration\)/);
  });

  test('technician_id must name a real, ACTIVE technician (uuid-shape guarded)', () => {
    expect(src).toMatch(/await db\('technicians'\)\.where\('id', techIdStr\)\.first\('id', 'active'\)/);
    expect(src).toMatch(/if \(!tech \|\| tech\.active === false\)/);
  });

  test('ET date bounds enforced at commit, from the shared config, before any write', () => {
    expect(src).toMatch(/const slotDateError = validateBookingSlotDate\(slotDateStr, config\);/);
    // ...and the check runs before the customer insert AND the transaction
    const dateIdx = src.indexOf('const slotDateError = validateBookingSlotDate(slotDateStr, config);');
    expect(dateIdx).toBeGreaterThan(-1);
    expect(dateIdx).toBeLessThan(src.indexOf("await db('customers').insert(applyContactNormalization("));
    expect(dateIdx).toBeLessThan(src.indexOf('txResult = await db.transaction'));
  });

  test('EVERY no-customer-needed validation runs BEFORE the customer insert — a rejected payload never strands an orphan profile', () => {
    // The insert used to precede the slot-end / geometry / technician checks:
    // a failure left an orphan customer whose retry hit the
    // phone-already-on-file 409. Pin the order so it can't regress.
    const insertIdx = src.indexOf("await db('customers').insert(applyContactNormalization(");
    expect(insertIdx).toBeGreaterThan(-1);
    for (const validation of [
      'const slotDateError = validateBookingSlotDate(slotDateStr, config);', // ET date bounds + calendar round-trip
      'const duration = resolveBookingDuration(duration_minutes, config, serviceKey);', // server duration (catalog-pinned)
      'if (slot_end && timeToMin(slot_end) !== endMin)', // slot_end agreement
      'const geometryError = validateBookingSlotGeometry({', // grid/hours/lunch
      'if (!serviceKey || !verifySlotOfferField({', // signed-offer proof (rounds 2+3)
      "await db('technicians').where('id', techIdStr).first('id', 'active')", // real active tech
      'let sourceEstimateId = null;', // accept-retry correlation validation
    ]) {
      const idx = src.indexOf(validation);
      expect(idx).toBeGreaterThan(-1);
      expect(idx).toBeLessThan(insertIdx);
    }
    // Failures only detectable under the advisory locks still roll the
    // just-created profile back (the DAY_FULL / SLOT_TAKEN catch).
    expect(src).toMatch(/if \(createdCustomerId\) \{\s*\n\s*await db\('notification_prefs'\)\.where\(\{ customer_id: createdCustomerId \}\)\.del\(\)/);
  });

  test('identity failure still answers 400 BEFORE the config/date/tech checks (DB-free contract)', () => {
    const identityIdx = src.indexOf("if (!custId && !willCreateCustomer) {");
    expect(identityIdx).toBeGreaterThan(-1);
    expect(identityIdx).toBeLessThan(src.indexOf('const slotDateError = validateBookingSlotDate(slotDateStr, config);'));
  });

  test('day-cap count is serialized under the SHARED date-scoped advisory lock (cross-zone, cross-writer)', () => {
    // The customer/tech/zone locks don't cover two confirms in DIFFERENT
    // zones — both could observe a cap-1 count. The cap is global by date, so
    // both self_booked_appointments writers take the SAME shared lock+count
    // primitives (services/availability.js) — a private copy in either file
    // would let the other bypass it.
    expect(src).toMatch(/const \{ acquireSelfBookingDayCapLock, countActiveSelfBookingsForDay \} = require\('\.\.\/services\/availability'\);/);
    const lockIdx = src.indexOf('await acquireSelfBookingDayCapLock(trx, slotDateStr);');
    const txIdx = src.indexOf('txResult = await db.transaction');
    const capCountIdx = src.indexOf('const dayCount = await countActiveSelfBookingsForDay(trx, slotDateStr);');
    expect(txIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeGreaterThan(txIdx); // inside the transaction (xact-scoped)
    expect(lockIdx).toBeLessThan(capCountIdx); // taken before the count it serializes
  });

  test('lock acquisition order stays fixed — customer → tech → zone → day — so writers can never deadlock', () => {
    const txIdx = src.indexOf('txResult = await db.transaction');
    const customerLockIdx = src.indexOf("['self-booking-confirm', `${custId}:${slotDateStr}`],", txIdx);
    const techLockIdx = src.indexOf("['slot-reserve', `${technician_id}:${slotDateStr}`],", txIdx);
    const zoneLockIdx = src.indexOf("['slot-reserve', `zone:${zone?.id || 'unknown'}:${slotDateStr}`],", txIdx);
    const dayLockIdx = src.indexOf('await acquireSelfBookingDayCapLock(trx, slotDateStr);', txIdx);
    expect(customerLockIdx).toBeGreaterThan(txIdx);
    expect(techLockIdx).toBeGreaterThan(customerLockIdx);
    expect(zoneLockIdx).toBeGreaterThan(techLockIdx);
    expect(dayLockIdx).toBeGreaterThan(zoneLockIdx);
  });

  test('day cap re-checked INSIDE the transaction, after the idempotent-replay lookup', () => {
    const replayIdx = src.indexOf("if (existing) return { existing };");
    const capIdx = src.indexOf("code: 'DAY_FULL',");
    const conflictIdx = src.indexOf("code: 'SLOT_TAKEN',");
    expect(replayIdx).toBeGreaterThan(-1);
    expect(capIdx).toBeGreaterThan(replayIdx);
    expect(conflictIdx).toBeGreaterThan(capIdx);
  });

  test('DAY_FULL rides the SLOT_TAKEN catch (409 + created-profile rollback)', () => {
    expect(src).toMatch(/txErr\.code === 'SLOT_TAKEN' \|\| txErr\.code === 'DAY_FULL'/);
  });

  test('source_estimate_id: uuid-shape 400, existence-checked (FK), stamped on the scheduled_services insert', () => {
    const blockIdx = src.indexOf('let sourceEstimateId = null;');
    expect(blockIdx).toBeGreaterThan(-1);
    const block = src.slice(blockIdx, blockIdx + 1200);
    // shape gate before any uuid cast could throw
    expect(block).toMatch(/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$/);
    expect(block).toMatch(/status: 400/);
    // existence check — the column FKs estimates; a stale link books UNLINKED.
    // Ownership columns ride the fetch so the post-resolution gate below can
    // decide the link without a second query.
    expect(block).toMatch(/await db\('estimates'\)\.where\('id', srcEstIdStr\)\.first\('id', 'customer_id', 'customer_phone', 'customer_email'\)/);
    expect(block).toMatch(/proceeds unlinked/);
    // …and the dispatch row actually carries it
    expect(src).toMatch(/source_estimate_id: sourceEstimateId,/);
    // never the raw payload value
    expect(src).not.toMatch(/source_estimate_id: source_estimate_id/);
  });

  test('source_estimate_id ownership gate: the link is stamped only AFTER the customer resolves, and only for the customer\'s own estimate', () => {
    // Any existing estimate UUID used to link unconditionally — the column is
    // trusted downstream (already-booked retry detection, estimate-deposit
    // credit roll-forward), so a borrowed UUID could suppress the real
    // customer's retry link or consume their deposit credit. Pin the gate:
    // decided after the customer row loads, matched by customer_id or (no
    // customer yet) by contact, mismatch books UNLINKED with a warn (fail-open,
    // same shape as the unknown-id path — correlation never blocks a booking).
    const customerFetchIdx = src.indexOf("const customer = await db('customers').where('id', custId).first();");
    const gateIdx = src.indexOf('if (sourceEstimateRow) {');
    const stampIdx = src.indexOf('sourceEstimateId = srcEstIdStr;');
    expect(customerFetchIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(customerFetchIdx); // after resolution (incl. just-created)
    expect(stampIdx).toBeGreaterThan(gateIdx); // the ONLY stamp lives inside the gate
    expect(src.indexOf('sourceEstimateId = srcEstIdStr;', stampIdx + 1)).toBe(-1);
    const gateBlock = src.slice(gateIdx, gateIdx + 1600);
    // linked estimate → must be THIS customer's
    expect(gateBlock).toMatch(/String\(sourceEstimateRow\.customer_id\) === String\(custId\)/);
    // unlinked estimate → contact match: last-10 phone, email only when the
    // estimate has no phone (estimates.customer_phone may be freeform/E.164)
    expect(gateBlock).toMatch(/customer_phone/);
    expect(gateBlock).toMatch(/customer_email/);
    expect(gateBlock).toMatch(/slice\(-10\)/);
    // mismatch: warn + unlinked, never a rejection
    expect(gateBlock).toMatch(/does not belong to booking customer/);
    expect(gateBlock).not.toMatch(/ok: false/);
  });
});

// ---------------------------------------------------------------------------
// Global day cap — availability.js's confirmBooking is the OTHER writer
// ---------------------------------------------------------------------------

describe('AvailabilityEngine.confirmBooking — shared global day cap (source guards)', () => {
  const availSrc = fs.readFileSync(path.join(__dirname, '../services/availability.js'), 'utf8');

  test('the shared helpers own the lock namespace + the global non-cancelled count', () => {
    expect(availSrc).toMatch(/const SELF_BOOKING_DAY_CAP_LOCK_NS = 'self-booking-day-cap';/);
    expect(availSrc).toMatch(/pg_advisory_xact_lock\(hashtext\(\?\), hashtext\(\?::text\)\)/);
    const countIdx = availSrc.indexOf('async function countActiveSelfBookingsForDay');
    expect(countIdx).toBeGreaterThan(-1);
    const countFn = availSrc.slice(countIdx, countIdx + 600);
    expect(countFn).toMatch(/\.whereNot\('status', 'cancelled'\)/);
    // GLOBAL by date — no zone scoping inside the shared count
    expect(countFn).not.toMatch(/service_zone_id/);
    // …and both primitives are exported for the route writer
    expect(availSrc).toMatch(/module\.exports\.acquireSelfBookingDayCapLock = acquireSelfBookingDayCapLock;/);
    expect(availSrc).toMatch(/module\.exports\.countActiveSelfBookingsForDay = countActiveSelfBookingsForDay;/);
  });

  test('confirmBooking takes the day lock AFTER its zone lock (fixed order) and counts globally before inserting', () => {
    const zoneLockIdx = availSrc.indexOf("['slot-reserve', `zone:${zone?.id || 'unknown'}:${dateStr}`],");
    const dayLockIdx = availSrc.indexOf('await acquireSelfBookingDayCapLock(trx, dateStr);');
    const dayCountIdx = availSrc.indexOf('const dayCount = await countActiveSelfBookingsForDay(trx, dateStr, {');
    const insertIdx = availSrc.indexOf("await trx('self_booked_appointments').insert({");
    expect(zoneLockIdx).toBeGreaterThan(-1);
    expect(dayLockIdx).toBeGreaterThan(zoneLockIdx); // zone → day, same relative order as createSelfBooking
    expect(dayCountIdx).toBeGreaterThan(dayLockIdx); // count under the lock
    expect(insertIdx).toBeGreaterThan(dayCountIdx); // checked before the write
    // reschedules still exclude the row being moved
    expect(availSrc).toMatch(/excludeSelfBookingId: options\.excludeSelfBookingId \|\| null,/);
  });

  test('the old PER-ZONE cap count is gone (it let cross-zone writers exceed the global cap)', () => {
    expect(availSrc).not.toMatch(/const existingBookings = await trx\('self_booked_appointments'\)/);
  });

  test('getAvailableSlots filters full days by the GLOBAL count (shared helper), matching what confirm enforces', () => {
    // The zone-engine BUILDER used to count per zone: when another zone had
    // consumed the global cap, it still offered this zone's slots and every
    // confirm then 409'd SLOT_TAKEN. Both builders (this one and booking.js's
    // buildBookingAvailability, which already counts with no zone filter)
    // must use the same global-by-date count the confirms enforce.
    expect(availSrc).toMatch(/const existingBookingsCount = await countActiveSelfBookingsForDay\(db, dateStr\);/);
    expect(availSrc).not.toMatch(/const existingBookings = await db\('self_booked_appointments'\)\s*\n\s*\.where\('service_zone_id', zone\.id\)[\s\S]{0,200}\.count\(/);
  });
});

// ---------------------------------------------------------------------------
// Signed slot offers (audit round 2) — /book surface wiring
// ---------------------------------------------------------------------------

describe('signed slot offers on the /book surface (source guards)', () => {
  test('the availability builder SIGNS every candidate over (service, location, date, start, tech, duration)', () => {
    expect(src).toMatch(/slot_sig: mintSlotOfferField\(\{\s*\n\s*surface: 'booking',/);
    const signIdx = src.indexOf("slot_sig: mintSlotOfferField({");
    const sign = src.slice(signIdx, signIdx + 400);
    expect(sign).toMatch(/serviceKey,/);
    expect(sign).toMatch(/locationKey: offerLocationKey,/);
    // …over the coords the slot computation actually ran on
    expect(src).toMatch(/const offerLocationKey = bookingOfferLocationKey\(lat, lng\);/);
    // the day-bucket copies carry the sig through to the client
    expect(src).toMatch(/technician_id: slot\.technician_id,\s*\n\s*slot_sig: slot\.slot_sig,/);
  });

  test('/availability and /find-slots derive service + duration BEFORE shaping/signing offers', () => {
    // both routes + createSelfBooking = 3 call sites of the shared
    // derivation; the old raw parseInt(duration_minutes) form is gone.
    expect((src.match(/const duration = resolveBookingDuration\(duration_minutes, config, serviceKey\);/g) || []).length).toBe(3);
    expect(src).not.toMatch(/\? parseInt\(duration_minutes\)/);
    // both public offer routes normalize the service key the same way
    expect((src.match(/const serviceKey = normalizeBookingServiceKey\(service_type\);/g) || []).length).toBe(2);
    // …and pass it into the builder that signs
    expect((src.match(/^\s*serviceKey,$/gm) || []).length).toBeGreaterThanOrEqual(3); // 2 routes + sign payload
  });

  test('createSelfBooking requires the signed offer — service + location bound — and rejects with the plain-string 409', () => {
    const gateIdx = src.indexOf('if (!serviceKey || !verifySlotOfferField({');
    expect(gateIdx).toBeGreaterThan(-1);
    const gate = src.slice(gateIdx, gateIdx + 700);
    expect(gate).toMatch(/surface: 'booking'/);
    expect(gate).toMatch(/serviceKey,/);
    expect(gate).toMatch(/locationKey: offerLocationKey,/);
    expect(gate).toMatch(/date: slotDateStr/);
    expect(gate).toMatch(/startMinutes: timeToMin\(slot_start\)/);
    expect(gate).toMatch(/technicianId: technician_id \|\| null/);
    expect(gate).toMatch(/durationMinutes: duration/);
    expect(gate).toMatch(/status: 409/);
  });

  test("the confirm-side service scope prefers the catalog id and the location scope prefers the submitted coords (customer-record fallback)", () => {
    expect(src).toMatch(/const serviceKey = normalizeBookingServiceKey\(service_id\)\s*\n\s*\|\| normalizeBookingServiceKey\(service_type\)\s*\n\s*\|\| normalizeBookingServiceKey\(quoted_service_label\);/);
    expect(src).toMatch(/let offerLat = Number\(new_customer\?\.lat\);/);
    expect(src).toMatch(/&& custId\) \{\s*\n\s*const coordRow = await db\('customers'\)\.where\('id', custId\)\.first\('latitude', 'longitude'\);/);
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — no exact coordinates on public responses
// ---------------------------------------------------------------------------

describe('public coordinate rounding', () => {
  test('rounds to 2 decimal places (~1 km) and null-safes garbage', () => {
    expect(roundPublicCoord(27.336789)).toBe(27.34);
    expect(roundPublicCoord(-82.530612)).toBe(-82.53);
    expect(roundPublicCoord(null)).toBeNull();
    expect(roundPublicCoord(undefined)).toBeNull();
    expect(roundPublicCoord('junk')).toBeNull();
  });

  test('/availability and /find-slots echo exact coords only when disclosable', () => {
    // both routes gate the echo on the resolver's disclosable flag
    expect((src.match(/coordsDisclosable \? resolvedLat : roundPublicCoord\(resolvedLat\)/g) || []).length).toBe(2);
    expect((src.match(/coordsDisclosable \? resolvedLng : roundPublicCoord\(resolvedLng\)/g) || []).length).toBe(2);
    // no raw resolved-coordinate echo remains on any response body
    expect(src).not.toMatch(/lat: resolvedLat,\s*\n\s*lng: resolvedLng,/);
  });

  test('resolveBookingCoords marks ONLY caller-held sources disclosable', () => {
    // caller-supplied lat/lng → disclosable up front
    expect(src).toMatch(/let disclosable = !!\(resolvedLat && resolvedLng\);/);
    // a geocode of the caller's own address → disclosable
    expect(src).toMatch(/resolvedLat = geo\.lat; resolvedLng = geo\.lng;\s*\n\s*disclosable = true;/);
    // the estimate_id branch never sets it — an estimate's customer coords
    // must go out rounded (the ownership-less estimate_id lookup is the leak)
    const estimateBranch = src.slice(
      src.indexOf('&& estimate_id) {', src.indexOf('async function resolveBookingCoords')),
      src.indexOf('&& address) {', src.indexOf('async function resolveBookingCoords')),
    );
    expect(estimateBranch).not.toMatch(/disclosable = true/);
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — confirmation-code strength + /status/:code enumeration guard
// ---------------------------------------------------------------------------

describe('confirmation codes', () => {
  test('new codes are WPC- + 10 chars from the 32-symbol alphabet (≈50 bits)', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateConfirmationCode()).toMatch(/^WPC-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
    }
  });

  test('codes are effectively unique (CSPRNG smoke)', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateConfirmationCode()));
    expect(seen.size).toBe(500);
  });

  test('generation is the SHARED crypto.randomBytes generator — Math.random is gone from every confirmation-code writer', () => {
    // The generator moved to utils/slot-offer-token.js so BOTH writers of
    // confirmation_code (this route and services/availability.js's zone-engine
    // confirmBooking) mint the same ≈50-bit codes.
    const utilSrc = fs.readFileSync(path.join(__dirname, '../utils/slot-offer-token.js'), 'utf8');
    expect(utilSrc).toMatch(/crypto\.randomBytes\(CONFIRMATION_CODE_LENGTH\)/);
    expect(src).toMatch(/generateConfirmationCode,?\s*\n?\} = require\('\.\.\/utils\/slot-offer-token'\)/);
    expect(src).not.toMatch(/Math\.random/);

    const availabilitySrc = fs.readFileSync(path.join(__dirname, '../services/availability.js'), 'utf8');
    expect(availabilitySrc).toMatch(/require\('\.\.\/utils\/slot-offer-token'\)/);
    expect(availabilitySrc).toMatch(/const confCode = generateConfirmationCode\(\);/);
    expect(availabilitySrc).not.toMatch(/Math\.random/);
  });

  test('legacy 4-char codes still resolve: /status matches by plain equality, no format gate', () => {
    expect(src).toMatch(/\.where\('confirmation_code', req\.params\.code\)/);
    // nothing between the route open and the lookup validates the code's shape
    const route = src.slice(src.indexOf("router.get('/status/:code'"), src.indexOf("module.exports = router"));
    expect(route).not.toMatch(/req\.params\.code\)\.(test|match|length)/);
  });
});

describe('/status/:code rate limit', () => {
  test('the dedicated limiter is registered on the route', () => {
    expect(src).toMatch(/router\.get\('\/status\/:code', bookingStatusLimiter, async/);
  });

  const mkRes = () => ({
    setHeader() {},
    status(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; },
    json(b) { this.body = b; return this; },
    end() {},
  });
  const mkReq = (ip) => ({ ip, headers: {}, app: { get: () => false }, method: 'GET', path: '/status/WPC-XXXX' });
  const hit = async (req) => {
    const res = mkRes();
    let allowed = false;
    await new Promise((resolve) => {
      const out = bookingStatusLimiter(req, res, () => { allowed = true; resolve(); });
      Promise.resolve(out).then(() => setImmediate(resolve));
    });
    return { allowed, res };
  };

  test('allows 10 lookups per IP then answers 429 without calling the handler', async () => {
    const req = mkReq('203.0.113.7');
    for (let i = 0; i < 10; i += 1) {
      expect((await hit(req)).allowed).toBe(true);
    }
    const { allowed, res } = await hit(req);
    expect(allowed).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ error: expect.stringMatching(/too many/i) });
  });

  test('the limit is per IP — another IP is unaffected', async () => {
    const other = mkReq('203.0.113.8');
    expect((await hit(other)).allowed).toBe(true);
  });
});

describe('/status/:code PII trim', () => {
  test('selects only first_name + city from customers — last_name and street address dropped', () => {
    const route = src.slice(src.indexOf("router.get('/status/:code'"), src.indexOf("module.exports = router"));
    expect(route).toMatch(/'customers\.first_name', 'customers\.city'/);
    expect(route).not.toMatch(/customers\.last_name/);
    expect(route).not.toMatch(/customers\.address_line1/);
  });
});
