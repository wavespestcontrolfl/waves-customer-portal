const { serviceReportEmailEligible } = require('../routes/admin-dispatch')._test;

describe('service report email is decoupled from the completion-SMS toggle', () => {
  test('eligible for a real, non-suppressed report (no SMS input — that is the decoupling)', () => {
    // Previously the email enqueue was gated on effectiveSendCompletionSms, so a
    // completion with SMS off sent no report email either. Eligibility now
    // depends only on the report being a real, non-suppressed customer report.
    expect(serviceReportEmailEligible({ serviceReportV1Delivery: true, suppressTypedCustomerComms: false })).toBe(true);
  });

  test('not eligible when customer comms are suppressed (internal_only / disabled typed report)', () => {
    expect(serviceReportEmailEligible({ serviceReportV1Delivery: true, suppressTypedCustomerComms: true })).toBe(false);
  });

  test('not eligible when the record is not a v1 report delivery', () => {
    expect(serviceReportEmailEligible({ serviceReportV1Delivery: false, suppressTypedCustomerComms: false })).toBe(false);
  });

  test('defensive: missing/empty input is not eligible', () => {
    expect(serviceReportEmailEligible()).toBe(false);
    expect(serviceReportEmailEligible({})).toBe(false);
  });
});
