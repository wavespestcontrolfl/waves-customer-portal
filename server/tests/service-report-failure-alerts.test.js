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
      link: '/admin/customers/cust-1',
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
      link: '/admin/customers/cust-9',
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

  test('sanitizeErrorText redacts emails and long tokens and caps length', () => {
    const out = sanitizeErrorText('Failed for van@example.com token=abcdef0123456789abcdef0123456789 retry');
    expect(out).toContain('[email]');
    expect(out).not.toContain('van@example.com');
    expect(out).toContain('[token]');
    expect(sanitizeErrorText('x'.repeat(500)).length).toBeLessThanOrEqual(240);
  });
});
