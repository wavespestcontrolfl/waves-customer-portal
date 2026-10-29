/**
 * Email agent operational-sender guard — destructive auto-actions
 * (trash, archive, one-click unsubscribe) must never fire on mail from
 * Waves-owned or operational domains. Regression for the failure where
 * our own newsletter test sends were archived AND one-click
 * unsubscribed, silently enrolling contact@ in SendGrid's newsletter
 * suppression group (2026-05-28 and 2026-06-11).
 */

const { shouldSkipAutoAction } = require('../services/email/email-actions');
const GOOG = (d) => `mx.google.com; dkim=pass header.d=${d}`;
const { autoUnsubscribe } = require('../services/email/auto-unsubscribe');
const { isOperationalDomain, domainFromAddress } = require('../services/email/spam-blocker');

describe('email shouldSkipAutoAction — operational-sender guard', () => {
  test('an inbound operational-LOOKING sender with FAILED auth does NOT skip (spoof falls through to quarantine)', () => {
    expect(shouldSkipAutoAction('spam', 'billing@stripe.com', 'mx.google.com; spf=fail smtp.mailfrom=attacker.example; dkim=none')).toBe(false);
    expect(shouldSkipAutoAction('spam', 'contact@wavespestcontrol.com', 'mx.google.com; spf=fail smtp.mailfrom=attacker.example')).toBe(false);
  });

  test('mail with NO trusted auth header (own DRAFT/SENT, legacy rows) keeps the unconditional skip', () => {
    expect(shouldSkipAutoAction('spam', 'contact@wavespestcontrol.com')).toBe(true);
    expect(shouldSkipAutoAction('marketing_newsletter', 'newsletter@wavespestcontrol.com', null)).toBe(true);
  });

  test('skips spam and marketing_newsletter actions for Waves senders', () => {
    expect(shouldSkipAutoAction('marketing_newsletter', 'events@wavespestcontrol.com', GOOG('wavespestcontrol.com'))).toBe(true);
    expect(shouldSkipAutoAction('marketing_newsletter', 'newsletter@wavespestcontrol.com', GOOG('wavespestcontrol.com'))).toBe(true);
    expect(shouldSkipAutoAction('spam', 'contact@wavespestcontrol.com', GOOG('wavespestcontrol.com'))).toBe(true);
    expect(shouldSkipAutoAction('marketing_newsletter', 'noreply@portal.wavespestcontrol.com', GOOG('portal.wavespestcontrol.com'))).toBe(true);
  });

  test('skips destructive actions for other operational domains (Google security notices etc.)', () => {
    expect(shouldSkipAutoAction('spam', 'no-reply@accounts.google.com', GOOG('accounts.google.com'))).toBe(true);
    expect(shouldSkipAutoAction('marketing_newsletter', 'noreply@google.com', GOOG('google.com'))).toBe(true);
  });

  test('Capital One Zelle payment notices are operational — never trashed/unsubscribed by a verdict (2026-09-02)', () => {
    expect(isOperationalDomain(domainFromAddress('capitalone@notification.capitalone.com'))).toBe(true);
    expect(shouldSkipAutoAction('spam', 'capitalone@notification.capitalone.com', GOOG('notification.capitalone.com'))).toBe(true);
    expect(shouldSkipAutoAction('marketing_newsletter', 'alerts@capitalone.com', GOOG('capitalone.com'))).toBe(true);
    // A spoof that fails auth still falls through to quarantine.
    expect(shouldSkipAutoAction('spam', 'alerts@capitalone.com', 'mx.google.com; spf=fail smtp.mailfrom=attacker.example; dkim=none')).toBe(false);
  });

  test('external newsletters and spam still get auto-actioned', () => {
    expect(shouldSkipAutoAction('marketing_newsletter', 'deals@retailer.example.com')).toBe(false);
    expect(shouldSkipAutoAction('spam', 'winner@lottery.example.biz')).toBe(false);
  });

  test('non-destructive categories still run for operational domains that are not ours', () => {
    expect(shouldSkipAutoAction('vendor_invoice', 'billing@google.com')).toBe(false);
    expect(shouldSkipAutoAction('lead_inquiry', 'no-reply@accounts.google.com', GOOG('accounts.google.com'))).toBe(false);
    expect(shouldSkipAutoAction('customer_request', 'jane@example.com', GOOG('example.com'))).toBe(false);
  });

  test('our OWN addresses skip every non-destructive handler — a self-addressed alert never matches a customer or drafts a reply', () => {
    expect(shouldSkipAutoAction('lead_inquiry', 'events@wavespestcontrol.com')).toBe(true);
    expect(shouldSkipAutoAction('customer_request', 'contact@wavespestcontrol.com', GOOG('wavespestcontrol.com'))).toBe(true);
    expect(shouldSkipAutoAction('scheduling', 'Contact@WavesPestControl.com', GOOG('wavespestcontrol.com'))).toBe(true);
    expect(shouldSkipAutoAction('complaint', 'anyone@wavespestcontrol.com', GOOG('wavespestcontrol.com'))).toBe(true);
    // A spoofed "us" with failed auth is skipped too: these handlers would
    // match/draft for the spoofer; the spam verdict path is what quarantines.
    expect(shouldSkipAutoAction('customer_request', 'contact@wavespestcontrol.com', 'mx.google.com; spf=fail smtp.mailfrom=attacker.example')).toBe(true);
    expect(shouldSkipAutoAction('spam', 'contact@wavespestcontrol.com', 'mx.google.com; spf=fail smtp.mailfrom=attacker.example')).toBe(false);
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

describe('email government-sender guard (outside review 2026-10-25)', () => {
  const { isGovernmentDomain } = require('../services/email/spam-blocker');

  test('recognizes .gov, .mil, .fed.us, Florida .us and named Florida agencies — never look-alikes', () => {
    for (const domain of ['fdacs.gov', 'licensing.fdacs.gov', 'epa.gov', 'irs.gov', 'army.mil', 'fs.fed.us',
      'co.manatee.fl.us', 'dep.state.fl.us', 'freshfromflorida.com', 'mail.freshfromflorida.com',
      'floridarevenue.com', 'myfloridalicense.com', 'scgov.net']) {
      expect(isGovernmentDomain(domain)).toBe(true);
    }
    for (const domain of ['connectively.us', 'gov.example.com', 'fdacs.gov.attacker.example', 'mygov.com',
      'freshfromflorida.com.evil.example', '', null]) {
      expect(isGovernmentDomain(domain)).toBe(false);
    }
  });

  test('every public bid portal the Bid Desk reads is a government sender, never a look-alike (inbox replay 2026-10-28)', () => {
    const { PUBLIC_PORTAL_DOMAINS } = require('../services/bid-desk/detector');
    expect(PUBLIC_PORTAL_DOMAINS).toEqual(expect.arrayContaining(['myvendorlink.com', 'demandstar.com', 'bidnetdirect.com']));
    for (const domain of PUBLIC_PORTAL_DOMAINS) expect(isGovernmentDomain(domain)).toBe(true);
    for (const domain of ['myvendorlink.com.evil.example', 'notmyvendorlink.com']) expect(isGovernmentDomain(domain)).toBe(false);
    // One spam label blocked VendorLink, and its Gmail filter trashed every later bid notice.
    expect(shouldSkipAutoAction('spam', 'vendorlink@myvendorlink.com', GOOG('myvendorlink.com'))).toBe(true);
    expect(shouldSkipAutoAction('spam', 'vendorlink@myvendorlink.com', 'mx.google.com; spf=fail smtp.mailfrom=attacker.example; dkim=none')).toBe(false);
  });

  test('a regulator notice classified spam or newsletter is never auto-actioned when its auth aligns', () => {
    expect(shouldSkipAutoAction('spam', 'licensing@fdacs.gov', GOOG('fdacs.gov'))).toBe(true);
    expect(shouldSkipAutoAction('marketing_newsletter', 'news@freshfromflorida.com', GOOG('freshfromflorida.com'))).toBe(true);
    expect(shouldSkipAutoAction('spam', 'notices@floridarevenue.com', GOOG('floridarevenue.com'))).toBe(true);
  });

  test('a spoofed .gov sender that fails auth still falls through to quarantine', () => {
    expect(shouldSkipAutoAction('spam', 'licensing@fdacs.gov', 'mx.google.com; spf=fail smtp.mailfrom=attacker.example; dkim=none')).toBe(false);
  });

  test('a quoted MAIL FROM forgery never earns the exemption, even with GATE_EMAIL_AUTH_STRICT dark (Codex security P2, #6668)', () => {
    const saved = process.env.GATE_EMAIL_AUTH_STRICT;
    delete process.env.GATE_EMAIL_AUTH_STRICT;
    try {
      const forged = 'mx.google.com; dkim=none; spf=pass (google.com: domain of "x dkim=pass header.d=fdacs.gov y"@evil.example designates 192.0.2.1 as permitted sender) smtp.mailfrom="x dkim=pass header.d=fdacs.gov y"@evil.example';
      const real = 'mx.google.com; dkim=pass header.i=@fdacs.gov header.s=s1 header.b=abc; spf=pass (google.com: domain of bounce@fdacs.gov designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@fdacs.gov; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=fdacs.gov';
      expect(shouldSkipAutoAction('spam', 'licensing@fdacs.gov', forged)).toBe(false);
      expect(shouldSkipAutoAction('marketing_newsletter', 'licensing@fdacs.gov', forged)).toBe(false);
      expect(shouldSkipAutoAction('spam', 'licensing@fdacs.gov', real)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GATE_EMAIL_AUTH_STRICT;
      else process.env.GATE_EMAIL_AUTH_STRICT = saved;
    }
  });

  test('non-destructive categories still run for government senders', () => {
    expect(shouldSkipAutoAction('regulatory', 'licensing@fdacs.gov', GOOG('fdacs.gov'))).toBe(false);
    expect(shouldSkipAutoAction('vendor_invoice', 'billing@myflorida.com', GOOG('myflorida.com'))).toBe(false);
  });

  test('autoUnsubscribe refuses a government sender', async () => {
    const result = await autoUnsubscribe({
      id: 'test',
      from_address: 'news@freshfromflorida.com',
      list_unsubscribe: '<https://example.com/unsub>',
    });
    expect(result.method).toBe('none');
    expect(result.note).toContain('government sender');
  });
});
