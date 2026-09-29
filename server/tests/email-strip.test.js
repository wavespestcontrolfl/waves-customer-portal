'use strict';

const { stripQuotedAndSignature, decodeEntities } = require('../services/email/email-strip');

describe('stripQuotedAndSignature', () => {
  test('cuts a Gmail-style "On ... wrote:" quote header and everything after it', () => {
    const body = 'Can you send the estimate by Friday?\n\nOn Mon, Sep 28, 2026 at 3:00 PM, Waves <contact@wavespestcontrol.com> wrote:\n> Sure thing, working on it.';
    expect(stripQuotedAndSignature(body)).toBe('Can you send the estimate by Friday?');
  });

  test('cuts an Outlook "-----Original Message-----" block', () => {
    const body = 'Please call me back today.\n\n-----Original Message-----\nFrom: Waves\nSent: Monday';
    expect(stripQuotedAndSignature(body)).toBe('Please call me back today.');
  });

  test('drops a trailing run of >-quoted lines the header did not catch', () => {
    const body = 'One more thing — can you reschedule?\n> old message line 1\n> old message line 2';
    expect(stripQuotedAndSignature(body)).toBe('One more thing — can you reschedule?');
  });

  test('cuts an RFC 3676 signature delimiter', () => {
    const body = "I'll send the photos tomorrow.\n--\nJane Doe\n555-1234";
    expect(stripQuotedAndSignature(body)).toBe("I'll send the photos tomorrow.");
  });

  test('drops a "Sent from my iPhone" trailer', () => {
    const body = 'Reschedule to Friday please.\nSent from my iPhone';
    expect(stripQuotedAndSignature(body)).toBe('Reschedule to Friday please.');
  });

  test('an ordinary short email with none of these markers passes through unchanged', () => {
    expect(stripQuotedAndSignature('Can you send the estimate?')).toBe('Can you send the estimate?');
  });

  test('empty/null input returns empty string', () => {
    expect(stripQuotedAndSignature(null)).toBe('');
    expect(stripQuotedAndSignature('')).toBe('');
  });

  test('decodeEntities decodes the common HTML entities', () => {
    expect(decodeEntities('Jamie Fixture &lt;jamie.fixture@example.invalid&gt; said &quot;hi&quot; &amp; left &#39;a note&#39;&nbsp;here'))
      .toBe('Jamie Fixture <jamie.fixture@example.invalid> said "hi" & left \'a note\' here');
  });

  // Owner diagnostic, 2026-09-29: real Gmail plain-text bodies run the
  // quoted history/signature INLINE (no line breaks at all) and the "On ...
  // wrote:" marker is HTML-entity-encoded. Every case below is shaped like
  // an actual production body (SYNTHETIC name/phone/address — never real
  // customer data in the repo).
  describe('real Gmail body shapes (inline, entity-encoded)', () => {
    test('weekday-date "On ... wrote:", entity-encoded email, no line break at all', () => {
      const body = 'That works great, see you then On Tue, Sep 22, 2026 at 3:21 PM Waves Pest Control &lt; contact@wavespestcontrol.com&gt; wrote: &gt; Hey Jamie, &gt; &gt; How does tomorrow afternoon work for you?';
      expect(stripQuotedAndSignature(body)).toBe('That works great, see you then');
    });

    test('numeric-date "On MM/DD/YYYY ... wrote:", with an inline " > " quote marker directly before it', () => {
      const body = 'Thank you, Jamie Fixture 555-010-0100 &gt; On 09/09/2026 8:29 AM, Waves Pest Control &lt;contact@wavespestcontrol.com&gt; wrote: &gt; Your payment was received and your receipt is attached.';
      expect(stripQuotedAndSignature(body)).toBe('Thank you, Jamie Fixture 555-010-0100');
    });

    test('Outlook underscore rule + "From:", entity-encoded email', () => {
      const body = 'Thanks, Jamie Fixture ________________________________ From: Waves Pest Control &lt;contact@wavespestcontrol.com&gt; Sent: Monday, September 21, 2026 9:00 AM';
      expect(stripQuotedAndSignature(body)).toBe('Thanks, Jamie Fixture');
    });

    test("Waves' own signature (\"*Office: (941) ...\") cuts a staff reply's own boilerplate", () => {
      const body = 'Hey Jamie, How does tomorrow afternoon work for you? *Office: (941) 297-5749 &lt;+19412975749&gt;* *Toll-Free: (855) 555-0100 &lt;+18555550100&gt; * *Email: contact@wavespestcontrol.com &lt;contact@wavespestcontrol.com&gt;*';
      expect(stripQuotedAndSignature(body)).toBe('Hey Jamie, How does tomorrow afternoon work for you?');
    });
  });

  test('a marker at the very start (cut index < 2) is not applied — keeps the whole text rather than leave almost nothing', () => {
    expect(stripQuotedAndSignature('On Tue wrote: this whole message')).toBe('On Tue wrote: this whole message');
  });
});
