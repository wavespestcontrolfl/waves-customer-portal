jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  serviceGroupId: jest.fn(() => 123),
  sendOne: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
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
    customerName: 'Tenant Contact',
    serviceDate: '2026-05-18',
    serviceType: 'Residential Pest Control',
    serviceDisplayName: 'Residential Pest Control',
    technicianName: 'Waves Tech',
    cityState: 'Sarasota, FL',
    findings: [],
    applications: [],
    advisory: {},
    metrics: [],
  })),
}));
jest.mock('../services/service-report/dynamic-context', () => ({
  buildServiceReportDynamicContext: jest.fn(() => Promise.resolve({})),
}));

const db = require('../models/db');
const EmailTemplateLibrary = require('../services/email-template-library');
const sendgrid = require('../services/sendgrid-mail');

function query(result) {
  const chain = {
    where: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    select: jest.fn(() => chain),
    first: jest.fn(() => Promise.resolve(result)),
    catch: jest.fn((handler) => Promise.resolve(result).catch(handler)),
  };
  return chain;
}

describe('service report email recipient delivery', () => {
  let emailMessageRows;

  beforeEach(() => {
    jest.clearAllMocks();
    emailMessageRows = [];

    db.mockImplementation((table) => {
      if (table === 'service_records') {
        return query({
          id: 'record-1',
          customer_id: 'customer-1',
          status: 'completed',
          service_type: 'Residential Pest Control',
          report_view_token: 'token-1',
          first_name: 'Owner',
          last_name: 'Customer',
          customer_email: 'owner@example.com',
          customer_phone: '9415550100',
          service_contact_name: 'Tenant Contact',
          service_contact_email: 'tenant@example.com',
          service_contact_phone: '9415550101',
          city: 'Sarasota',
          state: 'FL',
          technician_name: 'Waves Tech',
        });
      }
      if (table === 'notification_prefs') {
        return query({
          customer_id: 'customer-1',
          service_report_notify_primary: true,
        });
      }
      if (table === 'email_messages') {
        const chain = {
          criteria: null,
          where(criteria) {
            chain.criteria = criteria || {};
            return chain;
          },
          first() {
            return Promise.resolve(emailMessageRows.find((row) => Object.entries(chain.criteria || {})
              .every(([key, value]) => row[key] === value)) || null);
          },
          insert(payload) {
            return {
              returning: async () => {
                const row = { id: `email-${emailMessageRows.length + 1}`, ...payload };
                emailMessageRows.push(row);
                return [row];
              },
            };
          },
          update(payload) {
            const apply = () => {
              const row = emailMessageRows.find((candidate) => Object.entries(chain.criteria || {})
                .every(([key, value]) => candidate[key] === value));
              if (row) Object.assign(row, payload);
              return row;
            };
            return {
              returning: async () => {
                const row = apply();
                return row ? [row] : [];
              },
              catch: (handler) => Promise.resolve().then(() => {
                apply();
                return 1;
              }).catch(handler),
              then: (resolve, reject) => Promise.resolve().then(() => {
                apply();
                return 1;
              }).then(resolve, reject),
            };
          },
        };
        return chain;
      }
      return query(null);
    });
  });

  test('keeps queue retryable when one service-report recipient fails', async () => {
    const { sendServiceReportV1Email } = require('../services/service-report/email-delivery');

    EmailTemplateLibrary.sendTemplate.mockImplementation(({ to }) => {
      if (to === 'tenant@example.com') {
        return Promise.reject(new Error('SendGrid 500'));
      }
      return Promise.resolve({
        sent: true,
        message: { provider_message_id: 'msg-owner' },
      });
    });

    const result = await sendServiceReportV1Email('record-1', {
      token: 'token-1',
      reportUrl: 'https://portal.wavespestcontrol.com/report/token-1',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('SendGrid 500');
    expect(result.recipientCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.messageIds).toEqual(['msg-owner']);

    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(2);
    expect(EmailTemplateLibrary.sendTemplate.mock.calls.map(([args]) => args.idempotencyKey).sort()).toEqual([
      'service_report_ready:record-1:primary',
      'service_report_ready:record-1:service_contact',
    ]);
  });

  test('legacy fallback uses the same recipient idempotency keys as templates', async () => {
    const { sendServiceReportV1Email } = require('../services/service-report/email-delivery');

    EmailTemplateLibrary.sendTemplate.mockRejectedValue(new Error('active template not found'));
    sendgrid.sendOne.mockImplementation(({ to }) => {
      if (to === 'tenant@example.com') {
        return Promise.reject(new Error('SendGrid 500'));
      }
      return Promise.resolve({ messageId: 'legacy-owner' });
    });

    const result = await sendServiceReportV1Email('record-1', {
      token: 'token-1',
      reportUrl: 'https://portal.wavespestcontrol.com/report/token-1',
    });

    expect(result.ok).toBe(false);
    expect(result.messageIds).toEqual(['legacy-owner']);
    expect(emailMessageRows.map((row) => row.idempotency_key).sort()).toEqual([
      'service_report_ready:record-1:primary',
      'service_report_ready:record-1:service_contact',
    ]);
  });
});
