/**
 * services/zelle-notice.js — deterministic parsing + trust predicate for the
 * Capital One "Someone sent you money with Zelle" notice. Fixtures are a real
 * notice with the payer redacted, in both the text and HTML renderings the
 * Gmail sync stores. Pins:
 *   - payer / amount / memo extraction across ®, NBSP, curly apostrophes,
 *     entity-encoded HTML, and comma amounts;
 *   - the memo is optional, invoice numbers in it are found case-insensitively;
 *   - the trust predicate: aligned Capital One DKIM on the Gmail-written header
 *     → trusted; a forwarder's gmail SPF alone, a look-alike domain, a missing
 *     header, or a spoofed From → never trusted.
 */
const fs = require('fs');
const path = require('path');
const {
  isZelleNoticeCandidate,
  noticeText,
  parseZelleNotice,
  memoInvoiceNumbers,
  isTrustedZelleSender,
} = require('../services/zelle-notice');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const TEXT = fixture('zelle-notice-capitalone.txt');
const HTML = fixture('zelle-notice-capitalone.html');

describe('isZelleNoticeCandidate', () => {
  test('matches on subject, body or snippet; case-insensitive', () => {
    expect(isZelleNoticeCandidate({ subject: 'Good news: Someone sent you money with Zelle®.' })).toBe(true);
    expect(isZelleNoticeCandidate({ body_text: TEXT })).toBe(true);
    expect(isZelleNoticeCandidate({ snippet: 'PAT DOE has just SENT YOU MONEY WITH ZELLE' })).toBe(true);
    // HTML-only rendering where a tag splits the marker and the snippet is unrelated.
    expect(isZelleNoticeCandidate({ subject: 'Good news', snippet: 'Sign In', body_html: HTML })).toBe(true);
    expect(isZelleNoticeCandidate({ subject: 'Your statement is ready', body_text: 'nothing here' })).toBe(false);
    expect(isZelleNoticeCandidate({})).toBe(false);
  });
});

describe('noticeText + parseZelleNotice', () => {
  test('text rendering: payer proper-cased, amount in cents, memo trimmed', () => {
    const parsed = parseZelleNotice(noticeText({ body_text: TEXT }));
    expect(parsed).toEqual({ payerName: 'Pat Doe', amountCents: 11700, memo: 'Quarterly Service Pat D' });
  });

  test('HTML rendering (no body_text): entities, ® superscripts and comma amounts handled', () => {
    const parsed = parseZelleNotice(noticeText({ body_text: '   ', body_html: HTML }));
    expect(parsed).toEqual({ payerName: 'Pat Doe', amountCents: 125000, memo: 'Invoice WPC-2026-0412 & wpc-2026-0413' });
  });

  test('HTML-only notice: named, decimal and hex entities decode (accented payer survives)', () => {
    const html = '<p>JOS&Eacute; NU&Ntilde;EZ has just sent you money with Zelle<sup>&reg;</sup> in the amount of $88.00.</p>'
      + '<p>Here&#x2019;s the message from JOS&Eacute; NU&Ntilde;EZ: Caf&eacute; &#8212; back patio</p>';
    expect(parseZelleNotice(noticeText({ body_html: html })))
      .toEqual({ payerName: 'José Nuñez', amountCents: 8800, memo: 'Café — back patio' });
  });

  test('NBSP and curly apostrophes in the text rendering do not break the memo regex', () => {
    const t = noticeText({ body_text: 'PAT DOE has just sent you money with Zelle® in the amount of $50.00.\nHere’s the message from PAT DOE: Front lawn' });
    expect(parseZelleNotice(t)).toEqual({ payerName: 'Pat Doe', amountCents: 5000, memo: 'Front lawn' });
  });

  test('memo is optional; payer and amount are not', () => {
    expect(parseZelleNotice('PAT DOE has just sent you money with Zelle in the amount of $75.00.'))
      .toEqual({ payerName: 'Pat Doe', amountCents: 7500, memo: null });
    expect(parseZelleNotice('Someone sent you money with Zelle in the amount of $75.00.')).toBeNull();
    expect(parseZelleNotice('PAT DOE has just sent you money with Zelle.')).toBeNull();
    expect(parseZelleNotice('')).toBeNull();
  });

  test('an empty memo line never swallows the next paragraph', () => {
    const t = noticeText({ body_text: "PAT DOE has just sent you money with Zelle in the amount of $50.00.\nHere's the message from PAT DOE:\n\nThe money has already been deposited in your account." });
    expect(parseZelleNotice(t)).toEqual({ payerName: 'Pat Doe', amountCents: 5000, memo: null });
  });

  test('amounts are parsed as integer cents, never through a float', () => {
    for (const [txt, cents] of [['$0.01', 1], ['$1.10', 110], ['$4.35', 435], ['$1,234,567.89', 123456789]]) {
      expect(parseZelleNotice(`PAT DOE has just sent you money with Zelle in the amount of ${txt}.`).amountCents).toBe(cents);
    }
  });

  test('a $0.00 or malformed amount is not a notice', () => {
    expect(parseZelleNotice('PAT DOE has just sent you money with Zelle in the amount of $0.00.')).toBeNull();
    expect(parseZelleNotice('PAT DOE has just sent you money with Zelle in the amount of $12.')).toBeNull();
  });
});

describe('memoInvoiceNumbers', () => {
  test('finds WPC invoice numbers case-insensitively, de-duplicated and upper-cased', () => {
    expect(memoInvoiceNumbers('Invoice WPC-2026-0412 & wpc-2026-0413, again WPC-2026-0412')).toEqual(['WPC-2026-0412', 'WPC-2026-0413']);
    expect(memoInvoiceNumbers('Quarterly Service Pat D')).toEqual([]);
    expect(memoInvoiceNumbers(null)).toEqual([]);
  });
});

describe('isTrustedZelleSender', () => {
  // What Gmail writes at contact@ for an auto-forwarded Capital One notice:
  // Capital One's DKIM survives the forward; SPF now aligns to the forwarder.
  const FORWARDED_AUTH = 'mx.google.com; dkim=pass header.i=@notification.capitalone.com header.s=k1 header.b=abc; '
    + 'arc=pass (i=1 spf=pass spfdomain=capitalone.com dkim=pass dkdomain=capitalone.com dmarc=pass fromdomain=capitalone.com); '
    + 'spf=pass (google.com: domain of owner+caf_=contact=wavespestcontrol.com@gmail.com designates 1.2.3.4 as permitted sender) '
    + 'smtp.mailfrom="owner+caf_=contact=wavespestcontrol.com@gmail.com"; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=capitalone.com';

  test('aligned Capital One DKIM on a forwarded notice → trusted', () => {
    expect(isTrustedZelleSender({ from_address: 'capitalone@notification.capitalone.com', authentication_results: FORWARDED_AUTH })).toBe(true);
    expect(isTrustedZelleSender({ from_address: 'Capital One <alerts@capitalone.com>', authentication_results: 'mx.google.com; dkim=pass header.i=@capitalone.com; spf=pass smtp.mailfrom=bounce.capitalone.com' })).toBe(true);
  });

  test('SPF can never establish trust — only a Capital One DKIM signature (forged quoted local part)', () => {
    const forged = 'mx.google.com; dkim=none; spf=pass (google.com: domain of "x@capitalone.com"@evil.example designates 1.2.3.4 as permitted sender) smtp.mailfrom="x@capitalone.com"@evil.example';
    expect(isTrustedZelleSender({ from_address: 'alerts@capitalone.com', authentication_results: forged })).toBe(false);
    const forgedDkim = 'mx.google.com; dkim=pass header.i="x@capitalone.com"@evil.example header.d=evil.example';
    expect(isTrustedZelleSender({ from_address: 'alerts@capitalone.com', authentication_results: forgedDkim })).toBe(false);
  });

  test('dkim text nested in a quoted envelope address or a comment never counts (structural parse)', () => {
    const inQuotedMailfrom = 'mx.google.com; dkim=none; spf=pass smtp.mailfrom="dkim=pass header.i=@capitalone.com"@evil.example';
    expect(isTrustedZelleSender({ from_address: 'alerts@capitalone.com', authentication_results: inQuotedMailfrom })).toBe(false);
    const inComment = 'mx.google.com; dkim=fail (dkim=pass header.i=@capitalone.com) header.i=@evil.example; spf=pass smtp.mailfrom=evil.example';
    expect(isTrustedZelleSender({ from_address: 'alerts@capitalone.com', authentication_results: inComment })).toBe(false);
    const inArc = 'mx.google.com; arc=pass (i=1 dkim=pass dkdomain=capitalone.com header.i=@capitalone.com); dkim=none; spf=pass smtp.mailfrom=evil.example';
    expect(isTrustedZelleSender({ from_address: 'alerts@capitalone.com', authentication_results: inArc })).toBe(false);
    // A quoted run inside Google's SPF comment cannot break out of the comment.
    const breakout = 'mx.google.com; dkim=none; spf=pass (google.com: domain of "x); dkim=pass header.i=@capitalone.com; ("@evil.example designates 1.2.3.4 as permitted sender) smtp.mailfrom="x); dkim=pass header.i=@capitalone.com; ("@evil.example';
    expect(isTrustedZelleSender({ from_address: 'alerts@capitalone.com', authentication_results: breakout })).toBe(false);
    const escaped = 'mx.google.com; dkim=none; spf=pass (domain of x\\); dkim=pass header.i=@capitalone.com; (@evil.example) smtp.mailfrom=evil.example';
    expect(isTrustedZelleSender({ from_address: 'alerts@capitalone.com', authentication_results: escaped })).toBe(false);
    // A genuine clause with a comment inside it still passes.
    const genuine = 'mx.google.com; dkim=pass (2048-bit key; unprotected) header.i=@notification.capitalone.com header.s=k1 header.b="ab;cd"; spf=pass smtp.mailfrom=gmail.com';
    expect(isTrustedZelleSender({ from_address: 'capitalone@notification.capitalone.com', authentication_results: genuine })).toBe(true);
  });

  test('forwarder SPF alone (DKIM broken) → not trusted', () => {
    const spfOnly = 'mx.google.com; dkim=fail header.i=@notification.capitalone.com; spf=pass smtp.mailfrom="owner+caf_=contact=wavespestcontrol.com@gmail.com"';
    expect(isTrustedZelleSender({ from_address: 'capitalone@notification.capitalone.com', authentication_results: spfOnly })).toBe(false);
  });

  test('a manual "Fwd:" from the owner\'s gmail is not a Capital One sender → not trusted (parks for a human)', () => {
    expect(isTrustedZelleSender({ from_address: 'owner@gmail.com', authentication_results: 'mx.google.com; dkim=pass header.i=@gmail.com; spf=pass smtp.mailfrom=owner@gmail.com' })).toBe(false);
  });

  test('look-alike domains never trust, even with their own aligned DKIM', () => {
    for (const from of ['x@capitalone.com.evil.example', 'x@capitalone-alerts.com', 'x@notcapitalone.com']) {
      const domain = from.split('@')[1];
      expect(isTrustedZelleSender({ from_address: from, authentication_results: `mx.google.com; dkim=pass header.i=@${domain}` })).toBe(false);
    }
  });

  test('missing Gmail-written header or missing From → not trusted', () => {
    expect(isTrustedZelleSender({ from_address: 'capitalone@notification.capitalone.com', authentication_results: null })).toBe(false);
    expect(isTrustedZelleSender({ from_address: '', authentication_results: FORWARDED_AUTH })).toBe(false);
    expect(isTrustedZelleSender({})).toBe(false);
  });
});
