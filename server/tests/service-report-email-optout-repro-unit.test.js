// Audit repro r2-completion-live-money-tail-1: the service-report-v1 email
// ignores notification_prefs.email_enabled=false and service_completed=false.
// Setup copied from tests/service-report-email-delivery-recipients.test.js.
jest.mock('../services/customer-visit-history', () => ({ isFirstServiceVisit: jest.fn(async () => false) }));
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.raw = (sql) => ({ toString: () => sql });
  mock.transaction = async (fn) => {
    const trx = (table) => mock(table);
    trx.raw = mock.raw;
    return fn(trx);
  };
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  serviceGroupId: jest.fn(() => 123),
  sendOne: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
  activeSuppressionFor: jest.fn(() => null),
}));
jest.mock('../services/service-report/pdf-queue', () => ({
  enqueuePdfRenderRetry: jest.fn(),
  getOrRenderServiceReportPdf: jest.fn(() => Promise.resolve({ pdf: Buffer.from('pdf') })),
}));
jest.mock('../services/service-report/delivery', () => ({
  shouldSendServiceReportV1Delivery: jest.fn(() => true),
}));
jest.mock('../services/service-report/report-data', () => ({
  buildReportV1Data: jest.fn(() => Promise.resolve({
    customerName: 'Owner Customer', serviceDate: '2030-01-02',
    serviceType: 'Residential Pest Control', serviceDisplayName: 'Residential Pest Control',
    technicianName: 'Waves Tech', cityState: 'Sarasota, FL',
    findings: [], applications: [], advisory: {}, metrics: [],
  })),
}));
jest.mock('../services/service-report/dynamic-context', () => ({
  buildServiceReportDynamicContext: jest.fn(() => Promise.resolve({})),
}));

const db = require('../models/db');
const EmailTemplateLibrary = require('../services/email-template-library');
const { getServiceReportEmailRecipients } = require('../services/customer-contact');

function query(result) {
  const chain = {
    where: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    select: jest.fn(() => chain),
    first: jest.fn(() => Promise.resolve(result)),
    update: jest.fn(() => Promise.resolve(1)),
    catch: jest.fn((handler) => Promise.resolve(result).catch(handler)),
  };
  return chain;
}

function installDb(prefs) {
  const emailMessageRows = [];
  db.mockImplementation((table) => {
    if (table === 'service_records') {
      return query({
        id: 'record-1', customer_id: 'customer-1', status: 'completed',
        service_date: '2030-01-02', service_type: 'Residential Pest Control',
        report_view_token: 'token-1', first_name: 'Owner', last_name: 'Customer',
        customer_email: 'owner@example.com', customer_phone: '9415550100',
        city: 'Sarasota', state: 'FL', technician_name: 'Waves Tech',
      });
    }
    if (table === 'notification_prefs') return query({ customer_id: 'customer-1', ...prefs });
    if (table === 'email_messages') {
      const chain = {
        criteria: null,
        where(c) { chain.criteria = c || {}; return chain; },
        first() {
          return Promise.resolve(emailMessageRows.find((row) => Object.entries(chain.criteria || {})
            .every(([k, v]) => row[k] === v)) || null);
        },
        insert(payload) {
          return { returning: async () => { const row = { id: `email-${emailMessageRows.length + 1}`, ...payload }; emailMessageRows.push(row); return [row]; } };
        },
        update(payload) {
          const apply = () => { const row = emailMessageRows.find((r) => Object.entries(chain.criteria || {}).every(([k, v]) => r[k] === v)); if (row) Object.assign(row, payload); return row; };
          return {
            returning: async () => { const row = apply(); return row ? [row] : []; },
            catch: (h) => Promise.resolve().then(() => { apply(); return 1; }).catch(h),
            then: (res, rej) => Promise.resolve().then(() => { apply(); return 1; }).then(res, rej),
          };
        },
      };
      return chain;
    }
    return query(null);
  });
}

describe('r2-completion-live-money-tail-1: report-v1 email honors portal email opt-outs', () => {
  beforeEach(() => jest.clearAllMocks());

  test('pure: getServiceReportEmailRecipients returns [] when email_enabled=false', () => {
    const out = getServiceReportEmailRecipients(
      { id: 'c1', email: 'a@b.com', first_name: 'A' },
      { email_enabled: false, service_completed: false, service_report_notify_primary: true },
    );
    expect(out).toEqual([]);
  });

  test('integration: email_enabled=false skips the report email', async () => {
    installDb({ email_enabled: false, service_report_notify_primary: true });
    const { sendServiceReportV1Email } = require('../services/service-report/email-delivery');
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true, message: { provider_message_id: 'm' } });
    const result = await sendServiceReportV1Email('record-1', { token: 'token-1' });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, skipped: true });
  });

  test('integration: service_completed=false skips the report email', async () => {
    installDb({ service_completed: false, service_report_notify_primary: true });
    const { sendServiceReportV1Email } = require('../services/service-report/email-delivery');
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true, message: { provider_message_id: 'm' } });
    const result = await sendServiceReportV1Email('record-1', { token: 'token-1' });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, skipped: true });
  });
});
