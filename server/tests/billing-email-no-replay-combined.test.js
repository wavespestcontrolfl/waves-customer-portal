// Ported from the closed dunning-combined-message branch (Codex r1 P2): the
// combined-message terminal steps (sent by the customer-level dunning
// schedule, GATE_DUNNING_CUSTOMER_SCHEDULE) must be classified as
// final notices the same way their single-invoice counterparts already
// are — otherwise a blocked/bounced invoice.followup_combined_90_day (or
// invoice.followup_combined_30_day with the Day 90 ladder off) never
// triggers alertFinalNoticeMissed, and staff never learn the customer's
// final notice was never delivered.
const {
  isFinalSenderRenderedEmail, isSenderRenderedEmail, SENDER_RENDERED_TEMPLATES,
} = require('../services/billing-email-no-replay');

afterEach(() => {
  delete process.env.GATE_DUNNING_LADDER_90;
});

describe('combined-message templates are sender-rendered (never replayed)', () => {
  test.each([
    'invoice.followup_combined_3_day',
    'invoice.followup_combined_10_day',
    'invoice.followup_combined_17_day',
    'invoice.followup_combined_30_day',
    'invoice.followup_combined_60_day',
    'invoice.followup_combined_90_day',
  ])('%s is in SENDER_RENDERED_TEMPLATES', (key) => {
    expect(SENDER_RENDERED_TEMPLATES.has(key)).toBe(true);
    expect(isSenderRenderedEmail({ template_key: key })).toBe(true);
  });
});

describe('isFinalSenderRenderedEmail — combined 90-day is always final', () => {
  test('invoice.followup_combined_90_day is final regardless of the Day 90 ladder gate', () => {
    delete process.env.GATE_DUNNING_LADDER_90;
    expect(isFinalSenderRenderedEmail({ template_key: 'invoice.followup_combined_90_day' })).toBe(true);
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    expect(isFinalSenderRenderedEmail({ template_key: 'invoice.followup_combined_90_day' })).toBe(true);
  });
});

describe('isFinalSenderRenderedEmail — combined 30-day is final only while the Day 90 ladder is off', () => {
  test('ladder off: invoice.followup_combined_30_day is the final notice', () => {
    delete process.env.GATE_DUNNING_LADDER_90;
    expect(isFinalSenderRenderedEmail({ template_key: 'invoice.followup_combined_30_day' })).toBe(true);
  });

  test('ladder on: invoice.followup_combined_30_day is no longer final — the ladder carries the customer on to 60/90', () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    expect(isFinalSenderRenderedEmail({ template_key: 'invoice.followup_combined_30_day' })).toBe(false);
  });
});

describe('isFinalSenderRenderedEmail — combined mid-cadence steps are never final', () => {
  test.each([
    'invoice.followup_combined_3_day',
    'invoice.followup_combined_10_day',
    'invoice.followup_combined_17_day',
    'invoice.followup_combined_60_day',
  ])('%s is never a final notice', (key) => {
    delete process.env.GATE_DUNNING_LADDER_90;
    expect(isFinalSenderRenderedEmail({ template_key: key })).toBe(false);
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    expect(isFinalSenderRenderedEmail({ template_key: key })).toBe(false);
  });
});

describe('single-invoice final-notice classification is unaffected by the combined-message addition', () => {
  test('invoice.followup_90_day and billing_late_payment_90_day remain final', () => {
    expect(isFinalSenderRenderedEmail({ template_key: 'invoice.followup_90_day' })).toBe(true);
    expect(isFinalSenderRenderedEmail({ template_key: 'billing_late_payment_90_day' })).toBe(true);
  });

  test('invoice.followup_30_day keeps its existing ladder-conditional final-notice rule', () => {
    delete process.env.GATE_DUNNING_LADDER_90;
    expect(isFinalSenderRenderedEmail({ template_key: 'invoice.followup_30_day' })).toBe(true);
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    expect(isFinalSenderRenderedEmail({ template_key: 'invoice.followup_30_day' })).toBe(false);
  });
});
