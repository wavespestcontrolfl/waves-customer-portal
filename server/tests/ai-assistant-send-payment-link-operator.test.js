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
