'use strict';

// Contact login (GATE_CONTACT_LOGIN), codex #6363 r15 P2 + r16 security P2:
// the accept onboarding email's fallback to the ESTIMATE's own address asks
// whether that address is an on-location contact's who turned their email
// off — any slot, deny wins (contact-notification-prefs contactEmailDeclines,
// whose matching rules have their own tests). The holder's row address is
// never re-checked; a declined address falls to the account primary exactly
// as an empty estimate address does.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true, rendered: { text: 'hi' } })),
  redactEmailAddresses: (s) => s,
}));
jest.mock('../services/contact-notification-prefs', () => ({ contactEmailDeclines: jest.fn(async () => false) }));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const { contactEmailDeclines } = require('../services/contact-notification-prefs');
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
const ESTIMATE = { customer_name: 'Sam', customer_email: 'sam@example.com' };

beforeEach(() => { jest.clearAllMocks(); contactEmailDeclines.mockResolvedValue(false); });

test('the estimate address is checked against the contact switches and sent when nobody declines', async () => {
  mockDb({ customerRow: { id: 'c1', first_name: 'Pat', email: 'pat@localhost', is_primary_profile: true }, estimateRow: ESTIMATE });
  const res = await sendEstimateAcceptedOnboarding({ customerId: 'c1', estimateId: 'est-1', serviceLabel: 'Pest' });
  expect(res.sent).toBe(true);
  expect(contactEmailDeclines).toHaveBeenCalledWith('c1', 'sam@example.com');
  expect(sentTo()).toEqual(['sam@example.com']);
});

test('a declined address → the account primary for a secondary property, else no_address — never the declined contact', async () => {
  contactEmailDeclines.mockResolvedValue(true);
  mockDb({ customerRow: secondary, primaryRow: { id: 'prop-1', first_name: 'Lana', email: 'lana@example.com' }, estimateRow: ESTIMATE });
  await sendEstimateAcceptedOnboarding({ customerId: 'prop-2', estimateId: 'est-1', serviceLabel: 'Pest' });
  expect(sentTo()).toEqual(['lana@example.com']);

  jest.clearAllMocks();
  contactEmailDeclines.mockResolvedValue(true);
  mockDb({ customerRow: { ...secondary, id: 'prop-1', is_primary_profile: true }, estimateRow: ESTIMATE });
  const res = await sendEstimateAcceptedOnboarding({ customerId: 'prop-1', estimateId: 'est-1', serviceLabel: 'Pest' });
  expect(res).toEqual({ sent: false, outcome: 'no_address' });
  expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
});

test('the row\'s own usable address is the holder\'s: sent as is, never checked; a customer-less accept never asks either', async () => {
  mockDb({ customerRow: { id: 'c1', first_name: 'Pat', email: 'pat@example.com', is_primary_profile: true } });
  await sendEstimateAcceptedOnboarding({ customerId: 'c1', estimateId: 'est-1', serviceLabel: 'Pest' });
  expect(sentTo()).toEqual(['pat@example.com']);
  expect(contactEmailDeclines).not.toHaveBeenCalled();

  jest.clearAllMocks();
  mockDb({ customerRow: undefined, estimateRow: ESTIMATE });
  await sendEstimateAcceptedOnboarding({ customerId: null, estimateId: 'est-2', acceptanceId: 'acc-1', serviceLabel: 'Pest' });
  expect(sentTo()).toEqual(['sam@example.com']);
  expect(contactEmailDeclines).not.toHaveBeenCalled();
});

test('a contact address is re-checked at the provider handoff (codex r27 P2): a decline during the library\'s awaits aborts; the holder\'s own address carries no hook', async () => {
  mockDb({ customerRow: { id: 'c1', first_name: 'Pat', email: 'pat@localhost', is_primary_profile: true }, estimateRow: ESTIMATE });
  // The resolution saw no decline; by the handoff the contact turned email off.
  contactEmailDeclines.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  EmailTemplates.sendTemplate.mockImplementationOnce(async (opts) => {
    if (opts.onQueued && (await opts.onQueued()) === false) return { sent: false, aborted: true, reason: 'aborted_by_caller_before_dispatch' };
    return { sent: true, rendered: { text: 'hi' } };
  });
  const res = await sendEstimateAcceptedOnboarding({ customerId: 'c1', estimateId: 'est-1', serviceLabel: 'Pest' });
  expect(res).toMatchObject({ sent: false, blocked: true, reason: 'contact_declined' });
  expect(contactEmailDeclines).toHaveBeenCalledTimes(2);
  // An estimate address that matched NO slot at resolution (a stranger's) is re-read for a decline only.
  expect(contactEmailDeclines).toHaveBeenLastCalledWith('c1', 'sam@example.com', { requireSlot: false });
  // One that matched a contact slot must still occupy one at the handoff (codex r28 security P2).
  jest.clearAllMocks();
  mockDb({ customerRow: { id: 'c1', first_name: 'Pat', email: 'pat@localhost', is_primary_profile: true, service_contact_phone: '+19415550202', service_contact_email: 'sam@example.com' }, estimateRow: ESTIMATE });
  contactEmailDeclines.mockResolvedValue(false);
  EmailTemplates.sendTemplate.mockImplementationOnce(async (opts) => { await opts.onQueued(); return { sent: true, rendered: { text: 'hi' } }; });
  expect((await sendEstimateAcceptedOnboarding({ customerId: 'c1', estimateId: 'est-1', serviceLabel: 'Pest' })).sent).toBe(true);
  expect(contactEmailDeclines).toHaveBeenLastCalledWith('c1', 'sam@example.com', { requireSlot: true });
  // An unreadable table at the handoff aborts too (fail closed).
  jest.clearAllMocks();
  mockDb({ customerRow: { id: 'c1', first_name: 'Pat', email: 'pat@localhost', is_primary_profile: true }, estimateRow: ESTIMATE });
  contactEmailDeclines.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('timeout'));
  EmailTemplates.sendTemplate.mockImplementationOnce(async (opts) => ((await opts.onQueued()) === false ? { sent: false, aborted: true } : { sent: true }));
  expect(await sendEstimateAcceptedOnboarding({ customerId: 'c1', estimateId: 'est-1', serviceLabel: 'Pest' })).toMatchObject({ sent: false, blocked: true, reason: 'contact_declined' });
  // The holder's own address: no handoff hook at all.
  jest.clearAllMocks();
  mockDb({ customerRow: { id: 'c1', first_name: 'Pat', email: 'pat@example.com', is_primary_profile: true } });
  await sendEstimateAcceptedOnboarding({ customerId: 'c1', estimateId: 'est-1', serviceLabel: 'Pest' });
  expect(EmailTemplates.sendTemplate.mock.calls[0][0].onQueued).toBeUndefined();
});

test('a failing check is a transient failure, never a send to the unchecked address', async () => {
  mockDb({ customerRow: { id: 'c1', first_name: 'Pat', email: null, is_primary_profile: true }, estimateRow: ESTIMATE });
  contactEmailDeclines.mockRejectedValue(new Error('timeout'));
  const res = await sendEstimateAcceptedOnboarding({ customerId: 'c1', estimateId: 'est-1', serviceLabel: 'Pest' });
  expect(res).toMatchObject({ sent: false, outcome: 'failed' });
  expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
});
