/**
 * cancellation-preview (W0B) — the money/identity disclosure behind a
 * cancel_appointment confirmation card:
 *  1. FAIL CLOSED: a thrown fee preview or invoice query is an error, never
 *     "no fee" / "no invoices".
 *  2. The rails' own "unresolved" posture is disclosed as fee-may-apply.
 *  3. The fingerprint covers visit identity/state + fee + invoices, and
 *     moves when any of them moves.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const queue = [];
function builder() {
  const b = {};
  for (const m of ['leftJoin', 'where', 'whereIn', 'orderBy', 'select', 'forUpdate']) b[m] = () => b;
  b.first = () => b;
  b.then = (resolve, reject) => {
    const next = queue.shift();
    // `null` = "no row" (first() miss); undefined = nothing queued → [].
    return (next instanceof Error ? Promise.reject(next) : Promise.resolve(next === undefined ? [] : next)).then(resolve, reject);
  };
  return b;
}
const mockDb = jest.fn(() => builder());
jest.mock('../models/db', () => mockDb);

const mockHoldPreview = jest.fn();
const mockApptPreview = jest.fn();
const mockParkOnCancel = jest.fn(() => false);
jest.mock('../services/estimate-card-holds', () => ({
  cardHoldCancelPreview: (...a) => mockHoldPreview(...a),
  isParkOnCancelEnabled: () => mockParkOnCancel(),
}));
jest.mock('../services/appointment-card-request', () => ({ appointmentCardCancelPreview: (...a) => mockApptPreview(...a) }));
jest.mock('../services/invoice', () => ({ CANCELLED_SERVICE_VOIDABLE_STATUSES: ['draft', 'scheduled', 'sent'] }));

const { previewCancellationEffects, cancellationFingerprint } = require('../services/intelligence-bar/cancellation-preview');

const APPT = { id: 'ap1', scheduled_date: '2026-09-02', service_type: 'Quarterly Pest', status: 'scheduled', technician_id: 't1', first_name: 'acct', last_name: '3001' };

beforeEach(() => { queue.length = 0; jest.clearAllMocks(); });

test('card-hold rail: fee applies with amount; invoices listed', async () => {
  queue.push(APPT, [{ id: 'inv1', invoice_number: 'INV-1', status: 'sent', total: '120.00', credit_applied: '0' }]);
  mockHoldPreview.mockResolvedValue({ held: true, feeApplies: true, feeAmount: 49 });
  const p = await previewCancellationEffects('ap1');
  expect(p.fee).toEqual({ rail: 'card_hold', applies: true, amount: 49, unresolved: false, hold_disposition: null });
  expect(p.invoices).toEqual([{ id: 'inv1', invoice_number: 'INV-1', status: 'sent', total: 120, credit_applied: 0 }]);
  expect(p.appointment).toMatchObject({ id: 'ap1', status: 'scheduled', customer_name: 'acct 3001', technician_id: 't1' });
  expect(mockApptPreview).not.toHaveBeenCalled();
});

test('card-hold rail, no fee: the disposition is frozen from the park-on-cancel gate and fingerprinted', async () => {
  queue.push(APPT, []);
  mockHoldPreview.mockResolvedValue({ held: true, feeApplies: false });
  mockParkOnCancel.mockReturnValue(true);
  const parked = await previewCancellationEffects('ap1');
  expect(parked.fee).toEqual({ rail: 'card_hold', applies: false, amount: null, unresolved: false, hold_disposition: 'parked' });
  queue.push(APPT, []);
  mockParkOnCancel.mockReturnValue(false);
  const released = await previewCancellationEffects('ap1');
  expect(released.fee.hold_disposition).toBe('released');
  expect(cancellationFingerprint(parked)).not.toBe(cancellationFingerprint(released));
});

test('no hold → /secure appointment-card rail; its unresolved posture is disclosed as fee-may-apply', async () => {
  queue.push(APPT, []);
  mockHoldPreview.mockResolvedValue({ held: false, feeApplies: false });
  mockApptPreview.mockResolvedValue({ secured: true, feeApplies: true, feeAmount: 35, unresolved: true });
  const p = await previewCancellationEffects('ap1');
  expect(p.fee).toEqual({ rail: 'appointment_card', applies: true, amount: 35, unresolved: true });
});

test('FAIL CLOSED: a thrown fee preview is an error, not "no fee"', async () => {
  queue.push(APPT);
  mockHoldPreview.mockRejectedValue(new Error('stripe down'));
  const p = await previewCancellationEffects('ap1');
  expect(p.error).toMatch(/Could not verify the late-cancel fee/);
  expect(p.fee).toBeUndefined();
});

test('FAIL CLOSED: a thrown invoice query is an error, not an empty list', async () => {
  queue.push(APPT, new Error('db down'));
  mockHoldPreview.mockResolvedValue({ held: false });
  mockApptPreview.mockResolvedValue({ secured: false, feeApplies: false });
  const p = await previewCancellationEffects('ap1');
  expect(p.error).toMatch(/Could not verify the invoices/);
});

test('missing appointment is an error', async () => {
  queue.push(null);
  const p = await previewCancellationEffects('nope');
  expect(p.error).toMatch(/not found/);
});

test('fingerprint moves with visit state, fee posture, or invoice set — and only those', () => {
  const base = {
    appointment: { id: 'ap1', scheduled_date: '2026-09-02', service_type: 'Quarterly Pest', status: 'scheduled', technician_id: 't1', customer_name: 'acct 3001' },
    fee: { rail: 'card_hold', applies: true, amount: 49, unresolved: false },
    invoices: [{ id: 'inv1', status: 'sent', total: 120, credit_applied: 0 }],
  };
  const fp = cancellationFingerprint(base);
  expect(fp).toMatch(/^[0-9a-f]{64}$/);
  expect(cancellationFingerprint({ ...base, appointment: { ...base.appointment, scheduled_date: '2026-09-03' } })).not.toBe(fp);
  expect(cancellationFingerprint({ ...base, appointment: { ...base.appointment, technician_id: 't2' } })).not.toBe(fp);
  expect(cancellationFingerprint({ ...base, fee: { ...base.fee, applies: false, amount: null } })).not.toBe(fp);
  expect(cancellationFingerprint({ ...base, invoices: [] })).not.toBe(fp);
  expect(cancellationFingerprint({ ...base, invoices: [{ ...base.invoices[0], credit_applied: 120 }] })).not.toBe(fp);
  // Irrelevant extras (e.g. invoice_number label) don't perturb it.
  expect(cancellationFingerprint({ ...base, invoices: [{ ...base.invoices[0], invoice_number: 'X' }] })).toBe(fp);
});
