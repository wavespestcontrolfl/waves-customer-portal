'use strict';

// Contact login (GATE_CONTACT_LOGIN), codex #6363 r15 P2: the accept
// onboarding email's fallback to the ESTIMATE's own address runs through the
// slot-1 contact's email master switch — the same dispatch-time reroute the
// deferred sends use (contact-notification-prefs rerouteForContactEmailOptOut,
// whose matching rules have their own tests). The holder's row address is
// never re-resolved; a rerouted-to-nothing address falls to the account
// primary exactly as an empty estimate address does.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true, rendered: { text: 'hi' } })),
  redactEmailAddresses: (s) => s,
}));
jest.mock('../services/contact-notification-prefs', () => ({ rerouteForContactEmailOptOut: jest.fn() }));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const { rerouteForContactEmailOptOut } = require('../services/contact-notification-prefs');
const { sendEstimateAcceptedOnboarding } = require('../services/estimate-accepted-email');

function mockDb({ customerRow, primaryRow = null, estimateRow = { customer_name: 'Lana Owner', customer_email: '' } }) {
  let customerReads = 0;
  db.mockImplementation((table) => {
    if (table === 'customers') {
      const qb = { where: () => qb, whereNull: () => qb, first: async () => (customerReads++ === 0 ? customerRow : primaryRow) };
      return qb;
    }
    if (table === 'estimates') return { where: () => ({ first: async () => estimateRow }) };
    if (table === 'estimate_acceptances') return { where: () => ({ orderBy: () => ({ first: async () => null }) }) };
    throw new Error(`unexpected db table ${table}`);
  });
}

const sentTo = () => EmailTemplates.sendTemplate.mock.calls.map((c) => c[0].to);
const secondary = { id: 'prop-2', first_name: 'Lana', email: null, account_id: 'acct-1', is_primary_profile: false };

beforeEach(() => jest.clearAllMocks());

test('the estimate address is re-resolved through the contact switch; the rerouted address is the one sent', async () => {
  mockDb({ customerRow: { id: 'c1', first_name: 'Pat', email: 'pat@localhost', is_primary_profile: true }, estimateRow: { customer_name: 'Sam', customer_email: 'sam@example.com' } });
  rerouteForContactEmailOptOut.mockResolvedValue({ email: 'pat@example.com', rerouted: true });
  const res = await sendEstimateAcceptedOnboarding({ customerId: 'c1', estimateId: 'est-1', serviceLabel: 'Pest' });
  expect(res.sent).toBe(true);
  expect(rerouteForContactEmailOptOut).toHaveBeenCalledWith('c1', 'sam@example.com');
  expect(sentTo()).toEqual(['pat@example.com']);
});

test('a pass-through (the holder\'s or a stranger\'s address) sends to the estimate address', async () => {
  mockDb({ customerRow: { id: 'c1', first_name: 'Pat', email: null, is_primary_profile: true }, estimateRow: { customer_name: 'Sam', customer_email: 'sam@example.com' } });
  rerouteForContactEmailOptOut.mockResolvedValue({ email: 'sam@example.com', rerouted: false });
  await sendEstimateAcceptedOnboarding({ customerId: 'c1', estimateId: 'est-1', serviceLabel: 'Pest' });
  expect(sentTo()).toEqual(['sam@example.com']);
});

test('held (contact off, holder without an address) → the account primary for a secondary property, else no_address', async () => {
  rerouteForContactEmailOptOut.mockResolvedValue({ email: null, rerouted: true });
  mockDb({ customerRow: secondary, primaryRow: { id: 'prop-1', first_name: 'Lana', email: 'lana@example.com' }, estimateRow: { customer_name: 'Sam', customer_email: 'sam@example.com' } });
  await sendEstimateAcceptedOnboarding({ customerId: 'prop-2', estimateId: 'est-1', serviceLabel: 'Pest' });
  expect(sentTo()).toEqual(['lana@example.com']);

  jest.clearAllMocks();
  rerouteForContactEmailOptOut.mockResolvedValue({ email: null, rerouted: true });
  mockDb({ customerRow: { ...secondary, id: 'prop-1', is_primary_profile: true }, estimateRow: { customer_name: 'Sam', customer_email: 'sam@example.com' } });
  const res = await sendEstimateAcceptedOnboarding({ customerId: 'prop-1', estimateId: 'est-1', serviceLabel: 'Pest' });
  expect(res).toEqual({ sent: false, outcome: 'no_address' });
  expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
});

test('the row\'s own usable address is the holder\'s: sent as is, never re-resolved; a customer-less accept never asks either', async () => {
  mockDb({ customerRow: { id: 'c1', first_name: 'Pat', email: 'pat@example.com', is_primary_profile: true } });
  await sendEstimateAcceptedOnboarding({ customerId: 'c1', estimateId: 'est-1', serviceLabel: 'Pest' });
  expect(sentTo()).toEqual(['pat@example.com']);
  expect(rerouteForContactEmailOptOut).not.toHaveBeenCalled();

  jest.clearAllMocks();
  mockDb({ customerRow: undefined, estimateRow: { customer_name: 'Sam', customer_email: 'sam@example.com' } });
  await sendEstimateAcceptedOnboarding({ customerId: null, estimateId: 'est-2', acceptanceId: 'acc-1', serviceLabel: 'Pest' });
  expect(sentTo()).toEqual(['sam@example.com']);
  expect(rerouteForContactEmailOptOut).not.toHaveBeenCalled();
});

test('a failing re-resolution is a transient failure, never a send to the un-rechecked address', async () => {
  mockDb({ customerRow: { id: 'c1', first_name: 'Pat', email: null, is_primary_profile: true }, estimateRow: { customer_name: 'Sam', customer_email: 'sam@example.com' } });
  rerouteForContactEmailOptOut.mockRejectedValue(new Error('timeout'));
  const res = await sendEstimateAcceptedOnboarding({ customerId: 'c1', estimateId: 'est-1', serviceLabel: 'Pest' });
  expect(res).toMatchObject({ sent: false, outcome: 'failed' });
  expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
});
