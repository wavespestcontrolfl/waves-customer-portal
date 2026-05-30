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
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'service.report_ready',
      payload: expect.objectContaining({
        property_address: 'Sarasota, FL',
        finding_summary: 'No action-required findings were documented.',
        application_summary: '0 applications',
        pdf_note: 'Your PDF service report is attached.',
      }),
    }));
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

  test('does not fall back to legacy service report rendering in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const { sendServiceReportV1Email } = require('../services/service-report/email-delivery');

    EmailTemplateLibrary.sendTemplate.mockRejectedValue(new Error('active template not found'));

    try {
      const result = await sendServiceReportV1Email('record-1', {
        token: 'token-1',
        reportUrl: 'https://portal.wavespestcontrol.com/report/token-1',
      });

      expect(result).toEqual(expect.objectContaining({
        ok: false,
        error: 'Email send unavailable: service.report_ready template path failed and legacy fallback is disabled in production',
        failedCount: 2,
        blockedCount: 0,
        attachedPdf: true,
      }));
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
      expect(emailMessageRows).toEqual([]);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalEnv;
      }
    }
  });

  test('legacy fallback skips recipients already blocked by the template send', async () => {
    const { sendServiceReportV1Email } = require('../services/service-report/email-delivery');

    EmailTemplateLibrary.sendTemplate.mockImplementation(({ to }) => {
      if (to === 'owner@example.com') {
        return Promise.resolve({ sent: false, reason: 'Email already sent' });
      }
      return Promise.reject(new Error('active template not found'));
    });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'legacy-tenant' });

    const result = await sendServiceReportV1Email('record-1', {
      token: 'token-1',
      reportUrl: 'https://portal.wavespestcontrol.com/report/token-1',
    });

    expect(result.ok).toBe(true);
    expect(result.messageIds).toEqual(['legacy-tenant']);
    expect(result.recipientCount).toBe(1);
    expect(result.blockedCount).toBe(1);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      to: 'tenant@example.com',
    }));
    expect(emailMessageRows.map((row) => row.idempotency_key)).toEqual([
      'service_report_ready:record-1:service_contact',
    ]);
  });

  test('legacy fallback blocks a suppressed recipient before sending', async () => {
    const { sendServiceReportV1Email } = require('../services/service-report/email-delivery');

    // Both recipients fall through to the legacy path; the suppressed one must
    // never reach SendGrid and must be recorded as a blocked ledger row.
    EmailTemplateLibrary.sendTemplate.mockRejectedValue(new Error('active template not found'));
    EmailTemplateLibrary.activeSuppressionFor.mockImplementation((_template, email) =>
      Promise.resolve(email === 'owner@example.com'
        ? { suppression_type: 'bounce', group_key: null }
        : null));
    sendgrid.sendOne.mockResolvedValue({ messageId: 'legacy-tenant' });

    const result = await sendServiceReportV1Email('record-1', {
      token: 'token-1',
      reportUrl: 'https://portal.wavespestcontrol.com/report/token-1',
    });

    expect(result.ok).toBe(true);
    expect(result.recipientCount).toBe(1);
    expect(result.blockedCount).toBe(1);
    expect(result.messageIds).toEqual(['legacy-tenant']);

    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({ to: 'tenant@example.com' }));

    const ownerRow = emailMessageRows.find((row) => row.recipient_email_snapshot === 'owner@example.com');
    expect(ownerRow?.status).toBe('blocked');
    expect(ownerRow?.error_message).toMatch(/^Suppressed: bounce/);
  });
});
