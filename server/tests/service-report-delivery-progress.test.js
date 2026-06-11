/**
 * Progress-visit SMS selection (PR 5): typed trend visits 2+ send the short
 * service_report_v1_progress template led by the snapshot's generated
 * Today's Result headline; everything else keeps the existing templates.
 */

const {
  buildServiceReportV1DeliveryContext,
  serviceReportV1SmsType,
  typedProgressContext,
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

describe('typedProgressContext', () => {
  test('visit 2 with headline is progress', () => {
    const ctx = typedProgressContext(recordWith(PROGRESS_SNAPSHOT));
    expect(ctx.isProgress).toBe(true);
    expect(ctx.headline).toBe('Cockroach activity has decreased since our last visit.');
  });

  test('visit 1 is not progress', () => {
    const ctx = typedProgressContext(recordWith({ ...PROGRESS_SNAPSHOT, visitSequence: 1 }));
    expect(ctx.isProgress).toBe(false);
  });

  test('visit 2 without a headline is not progress', () => {
    const ctx = typedProgressContext(recordWith({ type: 'cockroach', visitSequence: 2, todaysResult: {} }));
    expect(ctx.isProgress).toBe(false);
  });

  test('no snapshot (recurring record) is not progress', () => {
    expect(typedProgressContext(recordWith(undefined)).isProgress).toBe(false);
    expect(typedProgressContext({ service_data: 'not json {' }).isProgress).toBe(false);
    expect(typedProgressContext(null).isProgress).toBe(false);
  });

  test('parses object service_data too', () => {
    const record = recordWith(undefined, { service_data: { typedReportSnapshot: PROGRESS_SNAPSHOT } });
    expect(typedProgressContext(record).isProgress).toBe(true);
  });
});

describe('serviceReportV1SmsType', () => {
  test('progress without invoice picks the progress template', () => {
    expect(serviceReportV1SmsType({ hasInvoiceLink: false, isProgress: true }))
      .toBe('service_report_v1_progress');
  });

  test('invoice link wins over progress', () => {
    expect(serviceReportV1SmsType({ hasInvoiceLink: true, isProgress: true }))
      .toBe('service_report_v1_with_invoice');
  });

  test('defaults unchanged', () => {
    expect(serviceReportV1SmsType({})).toBe('service_report_v1');
    expect(serviceReportV1SmsType({ hasInvoiceLink: true })).toBe('service_report_v1_with_invoice');
  });
});

describe('buildServiceReportV1DeliveryContext', () => {
  const service = { first_name: 'Dana', service_type: 'Cockroach Control Service' };

  test('progress visit selects progress template and threads the headline var', () => {
    const ctx = buildServiceReportV1DeliveryContext({
      record: recordWith(PROGRESS_SNAPSHOT),
      service,
      reportUrl: 'https://portal.example/r/abc',
    });
    expect(ctx.enabled).toBe(true);
    expect(ctx.smsType).toBe('service_report_v1_progress');
    expect(ctx.vars.progress_headline).toBe('Cockroach activity has decreased since our last visit.');
    expect(ctx.vars.report_url).toBe('https://portal.example/r/abc');
  });

  test('initial typed visit keeps the plain template and no headline var', () => {
    const ctx = buildServiceReportV1DeliveryContext({
      record: recordWith({ ...PROGRESS_SNAPSHOT, visitSequence: 1 }),
      service,
      reportUrl: 'https://portal.example/r/abc',
    });
    expect(ctx.smsType).toBe('service_report_v1');
    expect(ctx.vars.progress_headline).toBeUndefined();
  });

  test('progress visit with an invoice link keeps the invoice template', () => {
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
