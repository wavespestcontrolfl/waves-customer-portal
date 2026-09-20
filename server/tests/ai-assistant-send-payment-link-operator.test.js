// The expanded-tool executor carries the caller's execution context: an
// operator-confirmed `send_payment_link` names the authenticated operator
// (actorTechnicianId), so when the send closes out the open visit the
// invoice bills (GATE_INVOICE_ISSUED_CLOSES_VISIT) the transition and its
// audit row are attributed to that staff member, not the system (GitHub r4
// P2 #4127). An autonomous customer-facing turn carries none.

jest.mock('../models/db', () => {
  const chain = () => {
    const q = {};
    ['where', 'whereNull', 'whereNotIn', 'orderBy', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => ({ id: 'inv-1', customer_id: 'cust-1', payer_id: null, invoice_number: 'WPC-2026-0007', total: '117.00', status: 'sent' }));
    return q;
  };
  const mockDb = jest.fn(() => chain());
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice', () => ({
  sendViaSMS: jest.fn(async () => ({ sent: true, payUrl: 'https://pay.example/x' })),
}));

const InvoiceService = require('../services/invoice');
const { executeToolCall } = require('../services/ai-assistant/tools-expanded');

describe('send_payment_link operator context', () => {
  beforeEach(() => jest.clearAllMocks());

  test('an operator-confirmed send hands the operator to sendViaSMS as actorTechnicianId', async () => {
    const out = await executeToolCall('send_payment_link', { invoice_id: 'inv-1' }, 'cust-1', { actorTechnicianId: 'staff-1' });
    expect(out.sent).toBe(true);
    expect(InvoiceService.sendViaSMS).toHaveBeenCalledWith('inv-1', { operatorInitiated: true, actorTechnicianId: 'staff-1' });
  });

  test('an autonomous turn (no execution context) sends as the system — actorTechnicianId null', async () => {
    await executeToolCall('send_payment_link', { invoice_id: 'inv-1' }, 'cust-1');
    expect(InvoiceService.sendViaSMS).toHaveBeenCalledWith('inv-1', { operatorInitiated: true, actorTechnicianId: null });
  });

  test('the operator comes from the execution context only — never from the model\'s tool input', async () => {
    await executeToolCall('send_payment_link', { invoice_id: 'inv-1', actorTechnicianId: 'forged' }, 'cust-1', {});
    expect(InvoiceService.sendViaSMS).toHaveBeenCalledWith('inv-1', { operatorInitiated: true, actorTechnicianId: null });
  });
});

describe('send_payment_link — sent must reflect actual delivery, never sendResult.ok (Codex round-5 P1 #4131 finding 3)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a zero-due settlement resolves sent: false with settledZeroDue: true — never told to the customer as a delivered link', async () => {
    // The chokepoint's own resolved outcome for this case: { sent: false,
    // ok: true, ... }. Before this fix, `sent` read `sendResult?.sent ||
    // sendResult?.ok` — a genuine ok:true good outcome (nothing texted)
    // would have reported sent: true here, telling the customer a pay
    // link went out when nothing was ever delivered.
    InvoiceService.sendViaSMS.mockResolvedValue({
      sent: false, ok: true, code: 'zero_due', settled_zero_due: true,
      reason: 'Nothing is due on this invoice — settled instead of delivering a $0 pay link',
    });

    const out = await executeToolCall('send_payment_link', { invoice_id: 'inv-1' }, 'cust-1', {});

    expect(out.sent).toBe(false);
    expect(out.settledZeroDue).toBe(true);
    // A genuine good outcome (ok: true) must never also carry an `error`
    // field just because nothing was texted.
    expect(out.error).toBeUndefined();
  });

  test('a genuine send failure (ok: false) still reports sent: false WITH an error — unaffected by the ok:true carve-out above', async () => {
    InvoiceService.sendViaSMS.mockResolvedValue({ sent: false, ok: false, code: 'provider_rejected' });

    const out = await executeToolCall('send_payment_link', { invoice_id: 'inv-1' }, 'cust-1', {});

    expect(out.sent).toBe(false);
    expect(out.settledZeroDue).toBeUndefined();
    expect(out.error).toBe('provider_rejected');
  });

  test('an ordinary successful text keeps sent: true with no settledZeroDue', async () => {
    InvoiceService.sendViaSMS.mockResolvedValue({ sent: true, ok: true, payUrl: 'https://pay.example/x' });

    const out = await executeToolCall('send_payment_link', { invoice_id: 'inv-1' }, 'cust-1', {});

    expect(out.sent).toBe(true);
    expect(out.settledZeroDue).toBeUndefined();
    expect(out.error).toBeUndefined();
  });
});
