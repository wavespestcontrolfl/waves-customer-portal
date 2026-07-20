/**
 * createSelfBooking — the booking-commit operation extracted from
 * POST /api/booking/confirm so the voice agent's confirm_booking tool (Phase 2)
 * can run the exact same path. This covers the discriminated-result contract on
 * the DB-free validation branches (the deeper customer/transaction paths need a
 * live DB and are exercised by the route in integration). Behavior must match the
 * pre-refactor route exactly: same status codes, same messages.
 */
const { createSelfBooking } = require('../routes/booking')._internals;

describe('createSelfBooking — validation contract (no DB)', () => {
  test('is a function exported from booking _internals', () => {
    expect(typeof createSelfBooking).toBe('function');
  });

  test('missing slot_date or slot_start → 400 (discriminated result, not an HTTP response)', async () => {
    expect(await createSelfBooking({})).toEqual({ ok: false, status: 400, error: 'slot_date and slot_start required' });
    expect(await createSelfBooking({ slot_date: '2099-01-01' })).toEqual({ ok: false, status: 400, error: 'slot_date and slot_start required' });
    expect(await createSelfBooking({ slot_start: '09:00' })).toEqual({ ok: false, status: 400, error: 'slot_date and slot_start required' });
  });

  test('malformed slot_date → 400 Invalid slot_date', async () => {
    expect(await createSelfBooking({ slot_date: 'not-a-date', slot_start: '09:00' }))
      .toEqual({ ok: false, status: 400, error: 'Invalid slot_date' });
  });

  test('past calendar date → 400 with the "already passed" message', async () => {
    expect(await createSelfBooking({ slot_date: '2020-01-01', slot_start: '09:00' }))
      .toEqual({ ok: false, status: 400, error: expect.stringMatching(/already passed/i) });
  });

  test('new_customer with disagreeing inline + dedicated units → 400, fails closed (codex rd6)', async () => {
    const result = await createSelfBooking({
      slot_date: '2099-01-01',
      slot_start: '09:00',
      new_customer: { first_name: 'Ada', address_line1: '123 Main St Apt A', address_line2: 'Apt B', zip: '34231' },
    });
    expect(result).toEqual({ ok: false, status: 400, error: expect.stringMatching(/unit number disagree/i) });
  });

  test('mid-line unit in a full one-line address still conflicts with the unit box (codex rd12)', async () => {
    const result = await createSelfBooking({
      slot_date: '2099-01-01',
      slot_start: '09:00',
      new_customer: { first_name: 'Ada', address_line1: '123 Main St Apt A Sarasota FL 34236', address_line2: 'Apt B' },
    });
    expect(result).toEqual({ ok: false, status: 400, error: expect.stringMatching(/unit number disagree/i) });
    // The AGREEING one-line shape sails past this guard — it fails later only
    // for lack of identity, which proves the conflict guard did not fire.
    const agreeing = await createSelfBooking({
      slot_date: '2099-01-01',
      slot_start: '09:00',
      new_customer: { first_name: 'Ada', address_line1: '123 Main St Apt A Sarasota FL 34236', address_line2: 'Apt A' },
    });
    expect(agreeing).toEqual({ ok: false, status: 400, error: 'customer_id, estimate_id, or new_customer required' });
  });
});

// Estimator audit P2: the persisted/displayed service label must be
// ALLOWLISTED, never an echo of the client string — the raw value reaches the
// customer confirmation page (/status/:code), the owner-alert SMS, and
// admin/tech dispatch.
describe('canonicalBookingServiceLabel — the label allowlist', () => {
  const { canonicalBookingServiceLabel, BOOKING_FUNNEL_SERVICE_LABELS } = require('../routes/booking')._internals;

  test('catalog keys and display-label aliases resolve to the canonical label', () => {
    expect(canonicalBookingServiceLabel('pest_control')).toBe('Pest Control');
    expect(canonicalBookingServiceLabel('Pest Control')).toBe('Pest Control');
    expect(canonicalBookingServiceLabel('  mosquito control ')).toBe('Mosquito Control');
    expect(canonicalBookingServiceLabel('TERMITE INSPECTION')).toBe('Termite Inspection');
    expect(canonicalBookingServiceLabel('bora-care wood treatment')).toBe('Bora-Care Wood Treatment');
  });

  test('a crafted label never echoes through', () => {
    expect(canonicalBookingServiceLabel('FREE Termite Treatment call 941-555-0000')).toBe('');
    expect(canonicalBookingServiceLabel('<script>alert(1)</script>')).toBe('');
    expect(canonicalBookingServiceLabel('Pest Control!!!')).toBe('');
    expect(canonicalBookingServiceLabel('')).toBe('');
    expect(canonicalBookingServiceLabel(null)).toBe('');
  });

  test('prototype-chain keys never resolve (own-property lookups only)', () => {
    expect(canonicalBookingServiceLabel('__proto__')).toBe('');
    expect(canonicalBookingServiceLabel('constructor')).toBe('');
    expect(canonicalBookingServiceLabel('toString')).toBe('');
    expect(canonicalBookingServiceLabel('hasOwnProperty')).toBe('');
  });

  test('every funnel key has a canonical label (map stays in sync with the catalog)', () => {
    const { BOOKING_FUNNEL_SERVICE_DURATIONS } = require('../routes/booking')._internals;
    for (const key of Object.keys(BOOKING_FUNNEL_SERVICE_DURATIONS)) {
      expect(typeof BOOKING_FUNNEL_SERVICE_LABELS[key]).toBe('string');
      expect(BOOKING_FUNNEL_SERVICE_LABELS[key].length).toBeGreaterThan(0);
    }
  });
});
