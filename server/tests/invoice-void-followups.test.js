jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/invoice-followups', () => ({
  stopSequence: jest.fn(async () => undefined),
}));
jest.mock('../services/annual-prepay-renewals', () => ({
  syncTermForInvoicePayment: jest.fn(async () => undefined),
}));

const db = require('../models/db');
const FollowUps = require('../services/invoice-followups');
const InvoiceService = require('../services/invoice');

function chain({ first, returning } = {}) {
  const q = {};
  q.where = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  return q;
}

function invoice(overrides = {}) {
  return {
    id: 'inv-1',
    status: 'sent',
    invoice_number: 'WPC-2026-1042',
    ...overrides,
  };
}

describe('InvoiceService.voidInvoice follow-up cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('stops the invoice follow-up sequence after voiding an invoice', async () => {
    db
      .mockReturnValueOnce(chain({ first: invoice() }))
      .mockReturnValueOnce(chain({ returning: [invoice({ status: 'void' })] }));

    await InvoiceService.voidInvoice('inv-1');

    expect(FollowUps.stopSequence).toHaveBeenCalledWith('inv-1', {
      reason: 'invoice_voided',
    });
  });

  test('also stops a stale sequence when the invoice is already void', async () => {
    db.mockReturnValueOnce(chain({ first: invoice({ status: 'void' }) }));

    await InvoiceService.voidInvoice('inv-1');

    expect(FollowUps.stopSequence).toHaveBeenCalledWith('inv-1', {
      reason: 'invoice_voided',
    });
  });
});
