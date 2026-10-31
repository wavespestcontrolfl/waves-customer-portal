/**
 * Open-balance cancellation text (owner 2026-10-30): a whole-plan or
 * end-of-coverage confirmation names what the customer still owes for
 * completed visits, with the pay link, instead of "Completed visits are
 * still payable." The amount and the linked invoice come from the pay
 * page's own authority (resolveDunnableSet); anything it cannot prove keeps
 * the generic copy. The twin bodies stay within two segments (owner ruling
 * 2026-08-31).
 */
const mockSend = jest.fn().mockResolvedValue({ sent: true });
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSend(...a) }));
const mockRender = jest.fn(async (key) => `rendered ${key}`);
const mockRenderRequired = jest.fn(async (key) => `rendered ${key}`);
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: (...a) => mockRender(...a),
  renderRequiredSmsTemplate: (...a) => mockRenderRequired(...a),
}));
jest.mock('../services/account-membership-email', () => ({ sendCancellationReceived: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Send-once probe: no prior accepted send.
jest.mock('../models/db', () => jest.fn(() => {
  const b = {
    where(c) { if (typeof c === 'function') c.call(b); return b; },
    whereNotNull() { return b; },
    whereRaw() { return b; },
    orWhereRaw() { return b; },
    first: async () => null,
  };
  return b;
}));
const mockWithhold = jest.fn().mockResolvedValue(false);
jest.mock('../services/collections/collection-hold', () => ({ shouldWithholdPayLink: (...a) => mockWithhold(...a) }));
const mockResolveSet = jest.fn();
jest.mock('../services/customer-dunning/balance-set', () => ({ resolveDunnableSet: (...a) => mockResolveSet(...a) }));
const mockShort = jest.fn().mockResolvedValue({ code: 'AbCdEfGhIj', shortUrl: 'https://portal.wavespestcontrol.com/l/AbCdEfGhIj' });
jest.mock('../services/short-url', () => ({ createShortCode: (...a) => mockShort(...a) }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.wavespestcontrol.com' }));
jest.mock('../routes/admin-sms-templates', () => ({
  REQUIRED_TEMPLATE_PLACEHOLDERS: {
    service_cancellation_confirmation_balance: ['balance', 'pay_url'],
    service_cancellation_end_of_term_confirmation_balance: ['balance', 'pay_url'],
  },
}));

const { sendCancellationConfirmations } = require('../services/cancellation-confirmations');
const { countSegments, detectEncoding } = require('../services/messaging/segment-counter');
const {
  CANCELLATION_BALANCE_BODY,
  CANCELLATION_END_OF_TERM_BALANCE_BODY,
} = require('../models/migrations/20261030210000_cancel_confirm_balance_sms');

const customer = { id: 'cust-1', first_name: 'Pat', phone: '+15550000000' };
const request = { id: 'req-1', created_at: new Date('2026-10-30T14:00:00Z') };
const SINGLE = { kind: 'single', anchor: { id: 'inv-1', token: 'tok-1' }, totalCents: 8460 };

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveSet.mockResolvedValue(SINGLE);
});

describe('balance twin bodies', () => {
  // Worst case: long name, long date, a four-digit balance, and the bare
  // short link as getTemplate sends it (scheme stripped, 11-char code).
  const render = (body) => body.replace(/\{(\w+)\}/g, (_, k) => ({
    first_name: 'Christopher-Alexander',
    effective_date: 'September 30, 2026',
    balance: '$9,999.99',
    pay_url: 'portal.wavespestcontrol.com/l/AbCdEfGhIjK',
  })[k]);

  test.each([
    ['whole plan', CANCELLATION_BALANCE_BODY],
    ['end of paid coverage', CANCELLATION_END_OF_TERM_BALANCE_BODY],
  ])('%s renders to at most 2 GSM-7 segments and carries the amount, the link and reply-here', (_, body) => {
    const rendered = render(body);
    expect(detectEncoding(rendered).encoding).toBe('GSM_7');
    expect(countSegments(rendered).segmentCount).toBeLessThanOrEqual(2);
    expect(body).toMatch(/open balance of \{balance\} for completed visits\. Pay here: \{pay_url\}/);
    expect(body).toMatch(/Reply here\./);
  });
});

describe('sendCancellationConfirmations open-balance line', () => {
  test('an open balance renders the twin with the amount and a short pay link; the message class stays the base key', async () => {
    const out = await sendCancellationConfirmations({ customer, request, result: { scope: [] }, processed: true });
    expect(mockShort).toHaveBeenCalledWith('https://portal.wavespestcontrol.com/pay/tok-1', expect.objectContaining({
      entityType: 'invoices', entityId: 'inv-1', customerId: 'cust-1', channel: 'sms',
    }));
    expect(mockRender).toHaveBeenCalledWith(
      'service_cancellation_confirmation_balance',
      expect.objectContaining({ first_name: 'Pat', balance: '$84.60', pay_url: 'https://portal.wavespestcontrol.com/l/AbCdEfGhIj' }),
      expect.anything(),
      { requiredVars: ['balance', 'pay_url'] },
    );
    expect(mockRenderRequired).not.toHaveBeenCalled();
    expect(mockSend.mock.calls[0][0].body).toBe('rendered service_cancellation_confirmation_balance');
    expect(mockSend.mock.calls[0][0].metadata.original_message_type).toBe('service_cancellation_confirmation');
    expect(out.smsTemplateKey).toBe('service_cancellation_confirmation');
  });

  test('an end-of-coverage cancel uses its own twin', async () => {
    await sendCancellationConfirmations({ customer, request, result: { scope: [] }, processed: true, keptThrough: true, effectiveAt: '2027-02-28T12:00:00-05:00' });
    expect(mockRender.mock.calls[0][0]).toBe('service_cancellation_end_of_term_confirmation_balance');
  });

  test.each([
    ['no open balance', () => mockResolveSet.mockResolvedValue({ kind: 'empty', anchor: null, totalCents: 0 })],
    ['the pay-page set is on hold (e.g. account credit)', () => mockResolveSet.mockResolvedValue({ ...SINGLE, kind: 'hold', reason: 'account_credit_available' })],
    ['a collection hold withholds pay links', () => mockWithhold.mockResolvedValue(true)],
    ['the short link fails (no long bearer URL)', () => mockShort.mockRejectedValueOnce(new Error('db down'))],
    ['the twin is missing, inactive or lost a placeholder', () => mockRender.mockResolvedValueOnce(undefined)],
  ])('%s → the generic base copy', async (_, arrange) => {
    arrange();
    await sendCancellationConfirmations({ customer, request, result: { scope: [] }, processed: true });
    expect(mockRenderRequired).toHaveBeenCalledWith('service_cancellation_confirmation', expect.anything(), expect.anything());
    expect(mockSend.mock.calls[0][0].body).toBe('rendered service_cancellation_confirmation');
    mockWithhold.mockResolvedValue(false);
  });

  test.each([
    ['scoped', { result: { scope: ['lawn_care'], remaining: ['pest_control'] }, processed: true }],
    ['by-hand (not processed)', { result: null, processed: false }],
  ])('a %s confirmation never reads the balance', async (_, args) => {
    await sendCancellationConfirmations({ customer, request, ...args });
    expect(mockResolveSet).not.toHaveBeenCalled();
    expect(mockRender).not.toHaveBeenCalled();
  });
});
