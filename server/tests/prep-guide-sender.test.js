jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/project-email', () => ({
  // Drive channel selection off the customer's email field for the test.
  resolveProjectEmailRecipient: (customer) => ({
    email: customer.email || '',
    name: customer.first_name || '',
    role: 'primary',
  }),
}));

const db = require('../models/db');
const EmailTemplateLibrary = require('../services/email-template-library');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { sendPrepToCustomer } = require('../services/prep-guide-sender');

let customerRow;

function customersQuery() {
  const q = { where: jest.fn(() => q), whereNull: jest.fn(() => q), first: jest.fn(async () => customerRow) };
  return q;
}
// nextServiceDate lookup — no upcoming visit by default.
function scheduledQuery() {
  const q = {
    where: jest.fn(() => q), whereRaw: jest.fn(() => q), whereNotIn: jest.fn(() => q),
    orderBy: jest.fn(() => q), first: jest.fn(async () => null),
  };
  return q;
}
const interactionsInsert = jest.fn(async () => [1]);

beforeEach(() => {
  jest.clearAllMocks();
  customerRow = {
    id: 'cust-1', first_name: 'Megan', last_name: 'Example',
    email: 'megan@example.com', phone: '+19415550101',
    address_line1: '5022 Sunnyside Ln', city: 'Bradenton', state: 'FL', zip: '34211',
    deleted_at: null,
  };
  db.mockImplementation((table) => {
    if (table === 'customers') return customersQuery();
    if (table === 'scheduled_services') return scheduledQuery();
    if (table === 'customer_interactions') return { insert: interactionsInsert };
    return customersQuery();
  });
  EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });
  renderSmsTemplate.mockResolvedValue('Flea prep steps...');
  sendCustomerMessage.mockResolvedValue({ sent: true });
});

describe('sendPrepToCustomer', () => {
  test('email on file → emails the prep guide AND the companion text', async () => {
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea' });

    expect(result.ok).toBe(true);
    expect(result.emailSent).toBe(true);
    expect(result.smsSent).toBe(true);
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0]).toMatchObject({
      templateKey: 'prep.flea',
      to: 'megan@example.com',
      recipientId: 'cust-1',
    });
    // Companion SMS (references the emailed guide), not the standalone variant.
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'auto_flea', { first_name: 'Megan' }, expect.any(Object),
    );
  });

  test('no email → sends the self-contained standalone text, no email', async () => {
    customerRow = { ...customerRow, email: '' };

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea' });

    expect(result.ok).toBe(true);
    expect(result.emailSent).toBe(false);
    expect(result.smsSent).toBe(true);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'auto_flea_no_email', { first_name: 'Megan' }, expect.any(Object),
    );
  });

  test('no email and no phone → nothing to send', async () => {
    customerRow = { ...customerRow, email: '', phone: '' };

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_email_or_phone');
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('unknown customer → customer_not_found', async () => {
    customerRow = undefined;

    const result = await sendPrepToCustomer({ customerId: 'missing', pestType: 'flea' });

    expect(result).toMatchObject({ ok: false, reason: 'customer_not_found' });
  });

  test('unsupported pest type → rejected', async () => {
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite' });

    expect(result).toMatchObject({ ok: false, reason: 'unsupported_pest_type' });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test('email send fails but SMS succeeds → still ok', async () => {
    EmailTemplateLibrary.sendTemplate.mockResolvedValueOnce({ sent: false, reason: 'blocked' });

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea' });

    expect(result.ok).toBe(true);
    expect(result.emailSent).toBe(false);
    expect(result.smsSent).toBe(true);
  });
});
