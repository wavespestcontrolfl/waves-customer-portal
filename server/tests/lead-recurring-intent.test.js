/**
 * leadWantsRecurringPlan (services/lead-recurring-intent.js) —
 * lead-inspection-link-scope.md §2/§7: form leads classify from the
 * "Recurring "/"One-Time " label lead-webhook.js writes; call leads classify
 * from the same RECURRING_PEST_PROGRAMS set call-recording-processor.js
 * already resolves. Blank/unknown/'Consultation' (a dead mapping — the live
 * form has no `not-sure` option) all resolve to false, the safe default.
 */

const { leadWantsRecurringPlan } = require('../services/lead-recurring-intent');

describe('leadWantsRecurringPlan', () => {
  test('form path: "Recurring "-prefixed labels are recurring', () => {
    expect(leadWantsRecurringPlan({ service_interest: 'Recurring Pest Control' })).toBe(true);
    expect(leadWantsRecurringPlan({ service_interest: 'Recurring Pest Control + Lawn Care' })).toBe(true);
  });

  test('form path: "One-Time "-prefixed labels are not recurring', () => {
    expect(leadWantsRecurringPlan({ service_interest: 'One-Time Pest Control' })).toBe(false);
  });

  test('call path: a RECURRING_PEST_PROGRAMS name is recurring regardless of the "Service" suffix', () => {
    expect(leadWantsRecurringPlan({ service_interest: 'Quarterly Pest Control Service' })).toBe(true);
    expect(leadWantsRecurringPlan({ service_interest: 'Quarterly Pest Control' })).toBe(true);
    expect(leadWantsRecurringPlan({ service_interest: 'Bi-Monthly Pest Control Service' })).toBe(true);
  });

  test('a one-time / singular pest name from the call path is not recurring', () => {
    expect(leadWantsRecurringPlan({ service_interest: 'Bee / Wasp Nest Removal' })).toBe(false);
    expect(leadWantsRecurringPlan({ service_interest: 'General Pest Control Service' })).toBe(false);
  });

  test('blank, missing, and non-string service_interest all resolve to false', () => {
    expect(leadWantsRecurringPlan({ service_interest: '' })).toBe(false);
    expect(leadWantsRecurringPlan({ service_interest: '   ' })).toBe(false);
    expect(leadWantsRecurringPlan({})).toBe(false);
    expect(leadWantsRecurringPlan(null)).toBe(false);
    expect(leadWantsRecurringPlan({ service_interest: null })).toBe(false);
  });

  test("the dead 'Consultation' frequency label is NOT treated as recurring", () => {
    expect(leadWantsRecurringPlan({ service_interest: 'Pest Control Consultation' })).toBe(false);
    expect(leadWantsRecurringPlan({ service_interest: 'Consultation' })).toBe(false);
  });
});

describe('leadWantsRecurringPlan — composed call labels (GH Codex #4702 r1 P2)', () => {
  test('recurring primary segment plus an appended service is recurring', () => {
    expect(leadWantsRecurringPlan({ service_interest: 'Quarterly Pest Control Service + Lawn Care Service' })).toBe(true);
  });
  test('one-time primary segment plus an appended recurring service is not', () => {
    expect(leadWantsRecurringPlan({ service_interest: 'Wasp Nest Removal + Quarterly Pest Control Service' })).toBe(false);
  });
});
