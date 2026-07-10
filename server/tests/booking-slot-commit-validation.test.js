/**
 * Booking-audit P1s — commit-time slot validation, coordinate exposure,
 * confirmation-code strength, and /status/:code enumeration guard.
 *
 * POST /booking/confirm is public: the availability builder only OFFERS
 * conforming slots, so every rule it applies (day window, whole-hour grid,
 * lunch block, day cap, real active tech, sane duration) must be re-checked
 * at commit or a crafted payload books whatever it likes. Unit tests cover
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
  validateBookingSlotGeometry,
  generateConfirmationCode,
  roundPublicCoord,
  bookingStatusLimiter,
  createSelfBooking,
} = _internals;

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
  test('accepts the funnel catalog range (45–90) including string form', () => {
    expect(resolveBookingDuration(45, {})).toBe(45);
    expect(resolveBookingDuration(90, {})).toBe(90);
    expect(resolveBookingDuration('60', {})).toBe(60);
  });

  test('forged tiny/huge/garbage durations fall back to the configured slot duration', () => {
    for (const forged of [1, 0, -30, 600, 'abc', null, undefined, NaN, 14.5]) {
      expect(resolveBookingDuration(forged, {})).toBe(60);
      expect(resolveBookingDuration(forged, { slot_duration_minutes: 45 })).toBe(45);
    }
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
    expect(src).toMatch(/const duration = resolveBookingDuration\(duration_minutes, config\);/);
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

  test('day cap re-checked INSIDE the transaction, after the idempotent-replay lookup', () => {
    const replayIdx = src.indexOf("if (existing) return { existing };");
    const capIdx = src.indexOf("code: 'DAY_FULL',");
    const conflictIdx = src.indexOf("code: 'SLOT_TAKEN',");
    expect(replayIdx).toBeGreaterThan(-1);
    expect(capIdx).toBeGreaterThan(replayIdx);
    expect(conflictIdx).toBeGreaterThan(capIdx);
    // same non-cancelled predicate the availability builder counts with
    expect(src).toMatch(/const dayCountRow = await trx\('self_booked_appointments'\)\s*\n\s*\.where\('date', slotDateStr\)\s*\n\s*\.whereNot\('status', 'cancelled'\)/);
  });

  test('DAY_FULL rides the SLOT_TAKEN catch (409 + created-profile rollback)', () => {
    expect(src).toMatch(/txErr\.code === 'SLOT_TAKEN' \|\| txErr\.code === 'DAY_FULL'/);
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

  test('generation is crypto.randomBytes — Math.random is gone from the route file', () => {
    expect(src).toMatch(/crypto\.randomBytes\(CONFIRMATION_CODE_LENGTH\)/);
    expect(src).not.toMatch(/Math\.random/);
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
