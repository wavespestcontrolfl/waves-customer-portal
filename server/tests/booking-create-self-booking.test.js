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
});
