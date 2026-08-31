// #1995: the accept onboarding email's recipient chain is customer row →
// estimate contact → account primary (secondary-property accepts only).

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true, rendered: { text: 'hi' } })),
  redactEmailAddresses: (s) => s,
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const { sendEstimateAcceptedOnboarding } = require('../services/estimate-accepted-email');

function mockDb({ customerRow, primaryRow = null, estimateRow = { customer_name: 'Lana Owner', customer_email: '' } }) {
  let customerReads = 0;
  db.mockImplementation((table) => {
    if (table === 'customers') {
      const qb = {
        where: () => qb,
        whereNull: () => qb,
        first: async () => (customerReads++ === 0 ? customerRow : primaryRow),
      };
      return qb;
    }
    if (table === 'estimates') return { where: () => ({ first: async () => estimateRow }) };
    if (table === 'estimate_acceptances') return { where: () => ({ orderBy: () => ({ first: async () => null }) }) };
    throw new Error(`unexpected db table ${table}`);
  });
}

beforeEach(() => jest.clearAllMocks());

const secondary = { id: 'prop-2', first_name: 'Lana', email: null, account_id: 'acct-1', is_primary_profile: false };

test('secondary-property accept with no row/estimate email → account primary email', async () => {
  mockDb({ customerRow: secondary, primaryRow: { id: 'prop-1', first_name: 'Lana', phone: '+1', email: 'lana@example.com' } });
  const res = await sendEstimateAcceptedOnboarding({ customerId: 'prop-2', estimateId: 'est-1', serviceLabel: 'Pest' });
  expect(res.sent).toBe(true);
  expect(EmailTemplates.sendTemplate.mock.calls[0][0].to).toBe('lana@example.com');
});

test('estimate contact email beats the account primary', async () => {
  mockDb({
    customerRow: secondary,
    primaryRow: { id: 'prop-1', email: 'lana@example.com' },
    estimateRow: { customer_name: 'Lana Owner', customer_email: 'est@example.com' },
  });
  await sendEstimateAcceptedOnboarding({ customerId: 'prop-2', estimateId: 'est-1', serviceLabel: 'Pest' });
  expect(EmailTemplates.sendTemplate.mock.calls[0][0].to).toBe('est@example.com');
});

test('primary row with no email anywhere is still no_address (no account lookup for a primary)', async () => {
  mockDb({ customerRow: { ...secondary, id: 'prop-1', is_primary_profile: true }, primaryRow: { id: 'zzz', email: 'never@example.com' } });
  const res = await sendEstimateAcceptedOnboarding({ customerId: 'prop-1', estimateId: 'est-1', serviceLabel: 'Pest' });
  expect(res).toEqual({ sent: false, outcome: 'no_address' });
  expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
});
