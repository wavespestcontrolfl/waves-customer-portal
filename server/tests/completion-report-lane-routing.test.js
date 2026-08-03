const { completionUsesReportLane, reportV1InvoiceBodyCarriesPayLink } = require('../routes/admin-dispatch')._test;
const smsTemplates = require('../routes/admin-sms-templates');
const { serviceReportV1SmsType } = require('../services/service-report/delivery');

// The defect this pins: buildServiceReportV1DeliveryContext has always
// returned 'service_report_v1_with_invoice' when handed a pay link, and the
// unit tests for it have always passed — but the ROUTE refused to enter the
// report branch whenever an invoice existed (`!invoiceCreated`), so that
// template could not render in production. Billed report-v1 visits fell
// through to the generic service_complete_with_invoice, and #3166 rewrote the
// copy of a template nothing could reach. These tests cover the routing
// decision itself, which is where the bug lived.

const base = {
  reportLaneEnabled: true,
  invoiceCreated: false,
  usePaidCompletionTemplate: false,
  reportV1InvoiceArmed: false,
};

describe('completionUsesReportLane', () => {
  test('un-billed report-v1 visit takes the report lane (unchanged behaviour)', () => {
    expect(completionUsesReportLane(base)).toBe(true);
  });

  test('a non-report-v1 line never takes the report lane', () => {
    expect(completionUsesReportLane({ ...base, reportLaneEnabled: false })).toBe(false);
    expect(completionUsesReportLane({
      ...base, reportLaneEnabled: false, invoiceCreated: true, reportV1InvoiceArmed: true,
    })).toBe(false);
  });

  test('a paid/prepaid completion keeps its own template family even when armed', () => {
    expect(completionUsesReportLane({
      ...base, usePaidCompletionTemplate: true,
    })).toBe(false);
    expect(completionUsesReportLane({
      ...base, usePaidCompletionTemplate: true, invoiceCreated: true, reportV1InvoiceArmed: true,
    })).toBe(false);
  });

  describe('billed visit', () => {
    const billed = { ...base, invoiceCreated: true };

    test('DARK (gate off or template inactive): falls through to the generic invoice text', () => {
      // This is the pre-fix production behaviour, preserved exactly while the
      // gate is off — the customer still gets a pay link, via
      // service_complete_with_invoice.
      expect(completionUsesReportLane({ ...billed, reportV1InvoiceArmed: false })).toBe(false);
    });

    test('ARMED: takes the report lane so service_report_v1_with_invoice can finally render', () => {
      expect(completionUsesReportLane({ ...billed, reportV1InvoiceArmed: true })).toBe(true);
    });
  });

  test('regression: the armed billed route was unreachable before this fix', () => {
    // The old condition was `enabled && !invoiceCreated && !paid`. Under it,
    // no combination of inputs with invoiceCreated=true could reach the report
    // lane — which is precisely why serviceReportV1SmsType's with-invoice
    // branch had no production caller.
    const oldCondition = ({ reportLaneEnabled, invoiceCreated, usePaidCompletionTemplate }) => (
      reportLaneEnabled && !invoiceCreated && !usePaidCompletionTemplate
    );
    const armedBilled = { ...base, invoiceCreated: true, reportV1InvoiceArmed: true };
    expect(oldCondition(armedBilled)).toBe(false);
    expect(completionUsesReportLane(armedBilled)).toBe(true);

    // And the template key that route now reaches is the one #3166 rewrote.
    expect(serviceReportV1SmsType({ hasInvoiceLink: true })).toBe('service_report_v1_with_invoice');
  });

  describe('a customer with a bill never gets a text without the pay link', () => {
    // The fixtures below are what the RENDERER actually returns, not
    // hand-written bodies: getTemplate runs stripPortalUrlScheme, which removes
    // https:// from owned portal hosts. A test written against the full URL
    // passes while production always falls back — the lane would have shipped
    // permanently unreachable. Both the strings and the URL here are pushed
    // through the same production function the route uses.
    const strip = smsTemplates.stripPortalUrlScheme;
    const payUrl = 'https://portal.wavespestcontrol.com/l/invoice-xyz89';
    const reportUrl = 'https://portal.wavespestcontrol.com/l/report-abc12';
    const render = (body) => strip(body);

    test('the renderer really does strip the scheme off a portal pay link', () => {
      // If this ever stops being true the guard below is testing nothing.
      expect(render(payUrl)).toBe('portal.wavespestcontrol.com/l/invoice-xyz89');
      expect(render(payUrl)).not.toContain('https://');
    });

    test('a rendered body carrying the pay link is usable', () => {
      const body = render(`Hello Van! Your pest control report is ready: ${reportUrl}\n\nInvoice for today's visit: ${payUrl}`);
      expect(reportV1InvoiceBodyCarriesPayLink(body, payUrl)).toBe(true);
    });

    test('an operator editing {pay_url} out of the template falls back', () => {
      // Renders fine, reads fine, leaves the customer no way to pay.
      const body = render(`Hello Van! Your pest control report is ready: ${reportUrl}`);
      expect(reportV1InvoiceBodyCarriesPayLink(body, payUrl)).toBe(false);
    });

    test('an active sms_template_variants row outranking a good base row falls back', () => {
      const body = render(`Thanks! See your report: ${reportUrl}`);
      expect(reportV1InvoiceBodyCarriesPayLink(body, payUrl)).toBe(false);
    });

    test('a render failure or deactivation between probe and send falls back', () => {
      expect(reportV1InvoiceBodyCarriesPayLink(null, payUrl)).toBe(false);
      expect(reportV1InvoiceBodyCarriesPayLink('', payUrl)).toBe(false);
    });

    test('a missing pay URL is unusable, never vacuously true', () => {
      const body = render(`Report: ${reportUrl}\n\nInvoice: ${payUrl}`);
      expect(reportV1InvoiceBodyCarriesPayLink(body, '')).toBe(false);
      expect(reportV1InvoiceBodyCarriesPayLink(body, null)).toBe(false);
    });

    test('a third-party link keeps its scheme and still matches', () => {
      // stripPortalUrlScheme is host-allowlisted, so a non-portal pay URL is
      // untouched on both sides.
      const other = 'https://pay.example.com/i/abc';
      const body = render(`Report: ${reportUrl}\n\nInvoice: ${other}`);
      expect(reportV1InvoiceBodyCarriesPayLink(body, other)).toBe(true);
    });
  });

  test('gate off leaves every un-billed path byte-identical to today', () => {
    for (const usePaidCompletionTemplate of [true, false]) {
      for (const reportLaneEnabled of [true, false]) {
        const args = {
          reportLaneEnabled, invoiceCreated: false, usePaidCompletionTemplate, reportV1InvoiceArmed: false,
        };
        expect(completionUsesReportLane(args))
          .toBe(reportLaneEnabled && !usePaidCompletionTemplate);
      }
    }
  });
});
