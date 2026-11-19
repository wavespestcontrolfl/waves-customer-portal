// Customers page Auto Pay setup link outcomes: the three deliveries (copy /
// text / email) must each read back in their own words, and every email
// skip reason the server can return maps to a line the office can act on.
import { describe, it, expect } from 'vitest';
import { describeAutopaySetupLinkResult, describeCardRequestState, describeCardRequestResult, canSendCardRequest } from './cardLinkStatus';

describe('describeAutopaySetupLinkResult — delivery channels', () => {
  it('names the channel a sent link went out on', () => {
    expect(describeAutopaySetupLinkResult({ action: 'sent', channel: 'sms' }).text).toBe('Auto Pay setup link texted');
    expect(describeAutopaySetupLinkResult({ action: 'sent' }).text).toBe('Auto Pay setup link texted');
    expect(describeAutopaySetupLinkResult({ action: 'sent', channel: 'email' })).toEqual({ tone: 'good', text: 'Auto Pay setup link emailed' });
  });

  it('maps every email skip reason to an actionable line', () => {
    expect(describeAutopaySetupLinkResult({ action: 'skipped', reason: 'no_customer_email' })).toEqual({ tone: 'bad', text: 'No email address on file for this customer' });
    expect(describeAutopaySetupLinkResult({ action: 'skipped', reason: 'email_opted_out' }).tone).toBe('muted');
    expect(describeAutopaySetupLinkResult({ action: 'skipped', reason: 'email_prefs_check_uncertain' })).toEqual({ tone: 'bad', text: expect.stringMatching(/try again/) });
    expect(describeAutopaySetupLinkResult({ action: 'skipped', reason: 'email_template_inactive' }).text).toMatch(/Auto Pay setup email is inactive/);
    expect(describeAutopaySetupLinkResult({ action: 'skipped', reason: 'send_outcome_uncertain' }).text).toMatch(/uncertain/);
  });
});

// Owner 2026-11-19: "Text card / Auto Pay link" showed on an on-site visit
// and all three taps were refused. Once the server says the visit's link is
// closed, the panel says why, and names the customer's own Auto Pay link
// only when the server says that link would go out.
describe('closed visit — no send button, a line that says why', () => {
  const live = { enabled: true, autopayActive: false, cardLinkSentAt: null, request: null, closedReason: null, customerLinkAvailable: false };
  const onSite = { ...live, closedReason: 'visit_not_live:on_site' };

  it('keeps the send button on a live visit', () => {
    expect(describeCardRequestState(live)).toBeNull();
    expect(canSendCardRequest(live)).toBe(true);
  });

  it('hides the button and names the reason once the tech is on site', () => {
    expect(canSendCardRequest(onSite)).toBe(false);
    expect(describeCardRequestState(onSite)).toEqual({ tone: 'muted', text: 'The tech is on the way or done, so its card link is closed.' });
    expect(describeCardRequestState({ ...live, closedReason: 'visit_not_live:en_route' }).text).toMatch(/^The tech is on the way or done/);
    expect(describeCardRequestState({ ...live, closedReason: 'visit_not_live:cancelled' }).text).toMatch(/^This visit is not live/);
    expect(describeCardRequestState({ ...live, closedReason: 'visit_in_past' }).text).toMatch(/^This visit's date has passed/);
  });

  it("names the customer's Auto Pay link only when the server says it would go out", () => {
    expect(describeCardRequestState({ ...onSite, customerLinkAvailable: true }).text)
      .toBe("The tech is on the way or done, so its card link is closed. Use Text Auto Pay link on the customer's page.");
    expect(describeCardRequestState(onSite).text).not.toMatch(/Text Auto Pay link/);
  });

  it('reports live Auto Pay and a finished capture first, and a closed visit before a sent link', () => {
    expect(describeCardRequestState({ ...onSite, autopayActive: true }).text).toBe('Auto Pay active');
    expect(describeCardRequestState({ ...onSite, request: { status: 'completed' } }).tone).toBe('bad');
    // A link texted before the tech left is closed too: never "awaiting customer".
    expect(describeCardRequestState({ ...onSite, cardLinkSentAt: '2026-11-11T13:00:00Z' }))
      .toEqual(describeCardRequestState(onSite));
    expect(describeCardRequestState({ ...live, cardLinkSentAt: '2026-11-11T13:00:00Z' }).text).toBe('Secure card link sent — awaiting customer');
  });

  it('gives the closed line, with no fallback named, when a tap races the status change', () => {
    expect(describeCardRequestResult({ action: 'skipped', reason: 'visit_not_live:on_site' })).toEqual(describeCardRequestState(onSite));
    expect(describeCardRequestResult({ action: 'skipped', reason: 'visit_in_past' }).text).toMatch(/^This visit's date has passed/);
  });
});
