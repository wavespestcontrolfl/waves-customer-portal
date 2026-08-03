const { completionUsesReportLane, reportV1InvoiceBodyCarriesPayLink } = require('../routes/admin-dispatch')._test;
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

  test('a customer with a bill never gets a text without the pay link', () => {
    const payUrl = 'https://portal.wavespestcontrol.com/l/invoice-xyz89';
    // The arming probe (isOptInSmsTemplateEnabled) only proves the row exists
    // and is active. These are the bodies it would happily arm.
    const usable = `Hello Van! Your pest control report is ready: https://x/l/r\n\nInvoice for today's visit: ${payUrl}`;
    expect(reportV1InvoiceBodyCarriesPayLink(usable, payUrl)).toBe(true);

    // Operator edited {pay_url} out of the template in /admin — renders fine,
    // reads fine, and leaves the customer no way to pay.
    expect(reportV1InvoiceBodyCarriesPayLink(
      'Hello Van! Your pest control report is ready: https://x/l/r', payUrl,
    )).toBe(false);

    // An active sms_template_variants row outranks the base row, so a good
    // base template is no guarantee either.
    expect(reportV1InvoiceBodyCarriesPayLink('Thanks! See your report: https://x/l/r', payUrl)).toBe(false);

    // Render failure / deactivated between probe and send.
    expect(reportV1InvoiceBodyCarriesPayLink(null, payUrl)).toBe(false);
    expect(reportV1InvoiceBodyCarriesPayLink('', payUrl)).toBe(false);

    // A missing pay URL is unusable, never vacuously true.
    expect(reportV1InvoiceBodyCarriesPayLink(usable, '')).toBe(false);
    expect(reportV1InvoiceBodyCarriesPayLink(usable, null)).toBe(false);
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
