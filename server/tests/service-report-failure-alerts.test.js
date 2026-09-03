jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const { TRIGGER_REGISTRY } = require('../services/notification-triggers');
const {
  alertServiceReportDeliveryFailed,
  alertServiceReportPdfFailed,
  alertServiceReportTokenMintFailed,
  alertCompletionSmsFailed,
  sanitizeErrorText,
} = require('../services/service-report/failure-alerts');

// Mock knex that resolves the dedupe lookup (`notifications`) and the
// customer/service context join (`service_records as sr`).
function makeKnex({ existingNotification = null, serviceRow = null, throwOnQuery = false } = {}) {
  const knex = (table) => {
    if (throwOnQuery) throw new Error('db down');
    const isNotifications = table === 'notifications';
    const builder = {
      where: () => builder,
      whereRaw: () => builder,
      leftJoin: () => builder,
      first: () => Promise.resolve(isNotifications ? existingNotification : serviceRow),
    };
    return builder;
  };
  knex.raw = (sql) => sql;
  return knex;
}

describe('service report failure alerts', () => {
  test('delivery failure raises a service_report_delivery_failed alert with redacted error + customer context', async () => {
    const trigger = jest.fn(async () => ({ bellWritten: true }));
    const knex = makeKnex({
      existingNotification: null,
      serviceRow: {
        customer_id: 'cust-1', service_type: 'Lawn Care', service_date: '2026-05-16',
        first_name: 'Van', last_name: 'Lee',
      },
    });

    await alertServiceReportDeliveryFailed({
      delivery: { id: 'del-1', service_record_id: 'svc-1', customer_id: 'cust-1', attempts: 5 },
      error: new Error('SendGrid 550 rejected van@example.com'),
    }, { knex, trigger });

    expect(trigger).toHaveBeenCalledWith('service_report_delivery_failed', expect.objectContaining({
      customerName: 'Van Lee',
      serviceLabel: 'Lawn Care · 2026-05-16',
      attempts: 5,
      link: '/admin/customers?customerId=cust-1',
      dedupeKey: 'service_report_delivery_failed:del-1',
    }));
    const payload = trigger.mock.calls[0][1];
    expect(payload.errorMessage).toContain('[email]');
    expect(payload.errorMessage).not.toContain('van@example.com');
  });

  test('does not re-alert when a matching admin notification exists within the window', async () => {
    const trigger = jest.fn();
    const knex = makeKnex({ existingNotification: { id: 'notif-1' } });

    const result = await alertServiceReportDeliveryFailed({
      delivery: { id: 'del-1', service_record_id: 'svc-1' },
    }, { knex, trigger });

    expect(trigger).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true, reason: 'duplicate' });
  });

  test('pdf failure raises a service_report_pdf_failed alert keyed on the service record', async () => {
    const trigger = jest.fn(async () => ({ bellWritten: true }));
    const knex = makeKnex({
      serviceRow: {
        customer_id: 'cust-9', service_type: 'Quarterly Pest Control', service_date: '2026-06-01',
        first_name: 'Ana', last_name: 'Diaz',
      },
    });

    await alertServiceReportPdfFailed({
      job: { id: 'job-1', service_record_id: 'svc-9', attempts: 3 },
      error: 'render timeout',
    }, { knex, trigger });

    expect(trigger).toHaveBeenCalledWith('service_report_pdf_failed', expect.objectContaining({
      customerName: 'Ana Diaz',
      link: '/admin/customers?customerId=cust-9',
      dedupeKey: 'service_report_pdf_failed:svc-9',
    }));
  });

  test('is best-effort: never throws even if the database is unavailable', async () => {
    const trigger = jest.fn(async () => ({ bellWritten: true }));
    const knex = makeKnex({ throwOnQuery: true });

    await expect(alertServiceReportDeliveryFailed({
      delivery: { id: 'del-x', service_record_id: 'svc-x' },
      error: 'boom',
    }, { knex, trigger })).resolves.toBeDefined();
    // dedupe + context both fail soft, so the alert still fires with the fallback link.
    expect(trigger).toHaveBeenCalledWith('service_report_delivery_failed', expect.objectContaining({
      link: '/admin/dispatch',
    }));
  });

  test('trigger registry builds customer-facing copy for both failure types', () => {
    const delivery = TRIGGER_REGISTRY.service_report_delivery_failed;
    const pdf = TRIGGER_REGISTRY.service_report_pdf_failed;
    expect(['urgent', 'high', 'normal', 'low']).toContain(delivery.priority);
    expect(['urgent', 'high', 'normal', 'low']).toContain(pdf.priority);

    const builtDelivery = delivery.build({
      customerName: 'Van Lee', serviceLabel: 'Lawn Care · 2026-05-16', attempts: 5,
      errorMessage: 'SendGrid 550', link: '/admin/customers/cust-1',
    });
    expect(builtDelivery.title).toBeTruthy();
    expect(builtDelivery.body).toContain('Van Lee');
    expect(builtDelivery.link).toBe('/admin/customers/cust-1');

    const builtPdf = pdf.build({ customerName: 'Ana Diaz', attempts: 3 });
    expect(builtPdf.title).toBeTruthy();
    expect(builtPdf.body).toContain('Ana Diaz');
  });

  test('token mint failure raises service_report_token_mint_failed keyed on the service record', async () => {
    const trigger = jest.fn(async () => ({ bellWritten: true }));
    const knex = makeKnex({
      serviceRow: {
        customer_id: 'cust-3', service_type: 'Lawn Care', service_date: '2026-09-01',
        first_name: 'Rae', last_name: 'Kim',
      },
    });

    await alertServiceReportTokenMintFailed({
      serviceRecordId: 'svc-3', customerId: 'cust-3',
      error: new Error('relation service_records deadlock for rae@example.com'),
    }, { knex, trigger });

    expect(trigger).toHaveBeenCalledWith('service_report_token_mint_failed', expect.objectContaining({
      customerId: 'cust-3',
      serviceRecordId: 'svc-3',
      customerName: 'Rae Kim',
      serviceLabel: 'Lawn Care · 2026-09-01',
      link: '/admin/customers?customerId=cust-3',
      dedupeKey: 'service_report_token_mint_failed:svc-3',
    }));
    expect(trigger.mock.calls[0][1].errorMessage).toContain('[email]');
  });

  test('token mint failure dedupes within the window like the other lanes', async () => {
    const trigger = jest.fn();
    const knex = makeKnex({ existingNotification: { id: 'notif-2' } });
    const result = await alertServiceReportTokenMintFailed({ serviceRecordId: 'svc-3' }, { knex, trigger });
    expect(trigger).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true, reason: 'duplicate' });
  });

  test('completion SMS failure raises completion_sms_failed with sms type + error class', async () => {
    const trigger = jest.fn(async () => ({ bellWritten: true }));
    const knex = makeKnex({
      serviceRow: {
        customer_id: 'cust-4', service_type: 'Quarterly Pest Control', service_date: '2026-09-02',
        first_name: 'Ben', last_name: 'Ortiz',
      },
    });

    await alertCompletionSmsFailed({
      serviceRecordId: 'svc-4', customerId: 'cust-4',
      smsType: 'service_report_v1', errorClass: 'TWILIO_30007',
      error: 'Carrier violation for +19415550100',
    }, { knex, trigger });

    expect(trigger).toHaveBeenCalledWith('completion_sms_failed', expect.objectContaining({
      customerId: 'cust-4',
      serviceRecordId: 'svc-4',
      customerName: 'Ben Ortiz',
      smsType: 'service_report_v1',
      errorClass: 'TWILIO_30007',
      link: '/admin/customers?customerId=cust-4',
      dedupeKey: 'completion_sms_failed:svc-4:resumable',
    }));
    expect(trigger.mock.calls[0][1].errorMessage).toContain('Carrier violation');
    // The destination number is redacted from the tech-visible bell text.
    expect(trigger.mock.calls[0][1].errorMessage).toContain('[phone]');
    expect(trigger.mock.calls[0][1].errorMessage).not.toContain('9415550100');

    // A terminal follow-up on the same record is a different outcome — its
    // own dedupe identity, so it can replace the "held for retry" copy.
    const trigger2 = jest.fn(async () => ({ bellWritten: true }));
    await alertCompletionSmsFailed(
      { serviceRecordId: 'svc-4', resumable: false, error: 'invalid number' },
      { knex: makeKnex({}), trigger: trigger2 },
    );
    expect(trigger2).toHaveBeenCalledWith('completion_sms_failed', expect.objectContaining({
      dedupeKey: 'completion_sms_failed:svc-4:final',
      resumable: false,
    }));
  });

  test('completion SMS failure dedupes per record and never throws on a dead DB', async () => {
    const dupTrigger = jest.fn();
    expect(await alertCompletionSmsFailed(
      { serviceRecordId: 'svc-4' },
      { knex: makeKnex({ existingNotification: { id: 'notif-3' } }), trigger: dupTrigger },
    )).toEqual({ skipped: true, reason: 'duplicate' });
    expect(dupTrigger).not.toHaveBeenCalled();

    const trigger = jest.fn(async () => ({ bellWritten: true }));
    await expect(alertCompletionSmsFailed(
      { serviceRecordId: 'svc-y', error: 'boom' },
      { knex: makeKnex({ throwOnQuery: true }), trigger },
    )).resolves.toBeDefined();
    expect(trigger).toHaveBeenCalledWith('completion_sms_failed', expect.objectContaining({ link: '/admin/dispatch' }));
  });

  test('trigger registry builds copy for the token-mint and completion-SMS failure types', () => {
    const mint = TRIGGER_REGISTRY.service_report_token_mint_failed;
    const sms = TRIGGER_REGISTRY.completion_sms_failed;
    expect(['urgent', 'high', 'normal', 'low']).toContain(mint.priority);
    expect(['urgent', 'high', 'normal', 'low']).toContain(sms.priority);

    const builtMint = mint.build({ customerName: 'Rae Kim', serviceLabel: 'Lawn Care · 2026-09-01', errorMessage: 'deadlock', link: '/admin/customers/cust-3' });
    expect(builtMint.title).toBeTruthy();
    expect(builtMint.body).toContain('Rae Kim');
    expect(builtMint.body).toContain('deadlock');
    expect(builtMint.link).toBe('/admin/customers/cust-3');

    const builtSms = sms.build({ customerName: 'Ben Ortiz', smsType: 'service_report_v1', errorClass: 'TWILIO_30007', errorMessage: 'Carrier violation' });
    expect(builtSms.title).toBeTruthy();
    expect(builtSms.body).toContain('Ben Ortiz');
    expect(builtSms.body).toContain('TWILIO_30007');
    expect(builtSms.body).toContain('service_report_v1');
    expect(builtSms.body).toContain('held for retry');
    // A permanent provider refusal or a thrown send finalizes the closeout —
    // the copy must not promise a retry that cannot re-send.
    const builtTerminal = sms.build({ customerName: 'Ben Ortiz', resumable: false });
    expect(builtTerminal.body).not.toContain('held for retry');
    expect(builtTerminal.body).toContain('will not re-send');
  });

  test('push tags are per service record so concurrent failures do not replace each other', () => {
    const { pushTagFor } = require('../services/notification-triggers').__private;
    expect(pushTagFor('completion_sms_failed', { serviceRecordId: 'svc-a' }))
      .not.toBe(pushTagFor('completion_sms_failed', { serviceRecordId: 'svc-b' }));
    expect(pushTagFor('service_report_token_mint_failed', { serviceRecordId: 'svc-a' }))
      .toBe('waves-service_report_token_mint_failed-svc-a');
  });

  test('sanitizeErrorText redacts emails and long tokens and caps length', () => {
    const out = sanitizeErrorText('Failed for van@example.com token=abcdef0123456789abcdef0123456789 retry');
    expect(out).toContain('[email]');
    expect(out).not.toContain('van@example.com');
    expect(out).toContain('[token]');
    expect(sanitizeErrorText('x'.repeat(500)).length).toBeLessThanOrEqual(240);
  });
});
