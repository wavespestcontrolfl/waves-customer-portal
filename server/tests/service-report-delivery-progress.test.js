/**
 * The progress-headline SMS variant was retired 2026-07-06 (owner call):
 * the completion text is a gateway to the service report and the report
 * itself carries the trend. Every typed visit — first or follow-up — sends
 * the base service_report_v1 text (invoice variant when a pay link rides
 * along).
 */

const {
  buildServiceReportV1DeliveryContext,
  serviceReportV1SmsType,
} = require('../services/service-report/delivery');

function recordWith(snapshot, overrides = {}) {
  return {
    id: 101,
    status: 'completed',
    report_template_version: 'service_report_v1',
    service_line: 'pest_control',
    advisory: null,
    service_data: snapshot === undefined ? null : JSON.stringify({ typedReportSnapshot: snapshot }),
    ...overrides,
  };
}

const PROGRESS_SNAPSHOT = {
  type: 'cockroach',
  visitSequence: 2,
  todaysResult: { headline: 'Cockroach activity has decreased since our last visit.' },
};

describe('serviceReportV1SmsType', () => {
  test('base template for every non-invoice send', () => {
    expect(serviceReportV1SmsType({})).toBe('service_report_v1');
    expect(serviceReportV1SmsType({ hasInvoiceLink: false })).toBe('service_report_v1');
  });

  test('invoice link picks the invoice template', () => {
    expect(serviceReportV1SmsType({ hasInvoiceLink: true })).toBe('service_report_v1_with_invoice');
  });
});

describe('buildServiceReportV1DeliveryContext', () => {
  const service = { first_name: 'Dana', service_type: 'Cockroach Control Service' };

  test('typed visit 2+ sends the base template — no progress variant, no headline var', () => {
    const ctx = buildServiceReportV1DeliveryContext({
      record: recordWith(PROGRESS_SNAPSHOT),
      service,
      reportUrl: 'https://portal.example/r/abc',
    });
    expect(ctx.enabled).toBe(true);
    expect(ctx.smsType).toBe('service_report_v1');
    expect(ctx.vars.progress_headline).toBeUndefined();
    expect(ctx.vars.report_url).toBe('https://portal.example/r/abc');
  });

  test('initial typed visit sends the base template', () => {
    const ctx = buildServiceReportV1DeliveryContext({
      record: recordWith({ ...PROGRESS_SNAPSHOT, visitSequence: 1 }),
      service,
      reportUrl: 'https://portal.example/r/abc',
    });
    expect(ctx.smsType).toBe('service_report_v1');
    expect(ctx.vars.progress_headline).toBeUndefined();
  });

  test('a pay link picks the invoice template regardless of visit sequence', () => {
    const ctx = buildServiceReportV1DeliveryContext({
      record: recordWith(PROGRESS_SNAPSHOT),
      service,
      reportUrl: 'https://portal.example/r/abc',
      payUrl: 'https://pay.example/i/9',
    });
    expect(ctx.smsType).toBe('service_report_v1_with_invoice');
    expect(ctx.vars.progress_headline).toBeUndefined();
  });
});
