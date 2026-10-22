'use strict';

// visit-completion-summary.js summaryEmailRecipients (codex #6363 r2): the
// contact-preference filter runs on the CALLER's handle — a held handoff
// (summaryRetryAuthorized on a transaction) must never acquire a second pool
// connection — and the authorization that calls it awaits the async resolver.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/contact-notification-prefs', () => ({
  filterReportEmailRecipientsByContactPrefs: jest.fn(async (recipients) => recipients),
}));
jest.mock('../services/customer-contact', () => ({
  ...jest.requireActual('../services/customer-contact'),
  withAccountPrimaryContact: jest.fn(async (row) => row),
  getServiceReportEmailRecipients: jest.fn(() => [{ email: 'sam@example.com', name: 'Sam', role: 'service_contact' }]),
}));
jest.mock('../services/email-template-library', () => ({
  loadTemplateByKey: jest.fn(async () => ({ template: { id: 't' } })),
  activeSuppressionFor: jest.fn(async () => null),
}));

const { filterReportEmailRecipientsByContactPrefs } = require('../services/contact-notification-prefs');
const { summaryRetryAuthorized } = require('../services/visit-completion-summary');

function trxStub() {
  const rows = {
    service_visits: { id: 'v1', customer_id: 'c1' },
    customers: { id: 'c1', email: 'pat@example.com' },
    notification_prefs: { customer_id: 'c1' },
  };
  const trx = (table) => {
    const q = {};
    for (const m of ['where', 'whereNull', 'whereIn', 'modify', 'forShare']) q[m] = () => q;
    q.first = async () => rows[table] || null;
    return q;
  };
  trx.isTransaction = true;
  return trx;
}

test('a held retry authorization forwards its transaction to the contact-preference filter and reads the awaited list', async () => {
  const trx = trxStub();
  const verdict = await summaryRetryAuthorized(
    { trigger_event_id: 'visit_summary:11111111-1111-1111-1111-111111111111', template_key: 'service.visit_summary', recipient_email_snapshot: 'Sam@Example.com' },
    trx,
  );
  expect(verdict).toEqual({ ok: true });
  expect(filterReportEmailRecipientsByContactPrefs).toHaveBeenCalledWith(
    [{ email: 'sam@example.com', name: 'Sam', role: 'service_contact' }], expect.objectContaining({ id: 'c1' }), { dbh: trx },
  );
  // The contact's decline is honored through the same awaited path.
  filterReportEmailRecipientsByContactPrefs.mockResolvedValueOnce([]);
  expect(await summaryRetryAuthorized(
    { trigger_event_id: 'visit_summary:11111111-1111-1111-1111-111111111111', template_key: 'service.visit_summary', recipient_email_snapshot: 'sam@example.com' },
    trx,
  )).toEqual({ ok: false, reason: 'visit_summary_recipient_changed' });
});
