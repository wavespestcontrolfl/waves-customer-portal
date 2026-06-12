/**
 * Email agent operational-sender guard — destructive auto-actions
 * (trash, archive, one-click unsubscribe) must never fire on mail from
 * Waves-owned or operational domains. Regression for the failure where
 * our own newsletter test sends were archived AND one-click
 * unsubscribed, silently enrolling contact@ in SendGrid's newsletter
 * suppression group (2026-05-28 and 2026-06-11).
 */

const { shouldSkipAutoAction } = require('../services/email/email-actions');
const { autoUnsubscribe } = require('../services/email/auto-unsubscribe');
const { isOperationalDomain, domainFromAddress } = require('../services/email/spam-blocker');

describe('email shouldSkipAutoAction — operational-sender guard', () => {
  test('skips spam and marketing_newsletter actions for Waves senders', () => {
    expect(shouldSkipAutoAction('marketing_newsletter', 'events@wavespestcontrol.com')).toBe(true);
    expect(shouldSkipAutoAction('marketing_newsletter', 'newsletter@wavespestcontrol.com')).toBe(true);
    expect(shouldSkipAutoAction('spam', 'contact@wavespestcontrol.com')).toBe(true);
    expect(shouldSkipAutoAction('marketing_newsletter', 'noreply@portal.wavespestcontrol.com')).toBe(true);
  });

  test('skips destructive actions for other operational domains (Google security notices etc.)', () => {
    expect(shouldSkipAutoAction('spam', 'no-reply@accounts.google.com')).toBe(true);
    expect(shouldSkipAutoAction('marketing_newsletter', 'noreply@google.com')).toBe(true);
  });

  test('external newsletters and spam still get auto-actioned', () => {
    expect(shouldSkipAutoAction('marketing_newsletter', 'deals@retailer.example.com')).toBe(false);
    expect(shouldSkipAutoAction('spam', 'winner@lottery.example.biz')).toBe(false);
  });

  test('non-destructive categories are never skipped by this guard', () => {
    expect(shouldSkipAutoAction('lead_inquiry', 'events@wavespestcontrol.com')).toBe(false);
    expect(shouldSkipAutoAction('vendor_invoice', 'billing@google.com')).toBe(false);
    expect(shouldSkipAutoAction('customer_request', 'contact@wavespestcontrol.com')).toBe(false);
  });
});

describe('email autoUnsubscribe — operational-sender belt', () => {
  test('refuses to unsubscribe from our own newsletter regardless of headers', async () => {
    const result = await autoUnsubscribe({
      id: 'test',
      from_address: 'events@wavespestcontrol.com',
      list_unsubscribe: '<https://example.sendgrid.net/unsubscribe/oneclick>',
    });
    expect(result.method).toBe('none');
    expect(result.note).toContain('operational sender');
  });

  test('spoke domains are covered too', async () => {
    const result = await autoUnsubscribe({
      id: 'test',
      from_address: 'hello@parrishpestcontrol.com',
      list_unsubscribe: '<https://example.com/unsub>',
    });
    expect(result.method).toBe('none');
  });
});

describe('email spam-blocker — isOperationalDomain export', () => {
  test('covers hub, subdomains, and spokes; not external domains', () => {
    expect(isOperationalDomain('wavespestcontrol.com')).toBe(true);
    expect(isOperationalDomain(domainFromAddress('x@portal.wavespestcontrol.com'))).toBe(true);
    expect(isOperationalDomain('parrishpestcontrol.com')).toBe(true);
    expect(isOperationalDomain('retailer.example.com')).toBe(false);
  });
});
