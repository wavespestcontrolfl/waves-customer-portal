// Customers page Auto Pay setup link outcomes: the three deliveries (copy /
// text / email) must each read back in their own words, and every email
// skip reason the server can return maps to a line the office can act on.
import { describe, it, expect } from 'vitest';
import { describeAutopaySetupLinkResult } from './cardLinkStatus';

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
