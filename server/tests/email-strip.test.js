'use strict';

const { ownReplySubject, stripQuotedAndSignature, decodeEntities } = require('../services/email/email-strip');

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

  test('a body that opens with quoted history or a forwarded header strips to nothing', () => {
    expect(stripQuotedAndSignature('On Tue, Sep 22, 2026 at 3:21 PM, Jane <jane@example.invalid> wrote: please send a quote by Friday')).toBe('');
    expect(stripQuotedAndSignature('---------- Forwarded message ---------\nFrom: Jane\nCan you come out Monday?')).toBe('');
    expect(stripQuotedAndSignature('> can you call me back today')).toBe('');
  });

  describe('"On ... wrote:" needs a real quote header', () => {
    test('ordinary prose that happens to say "on ... wrote:" is not cut', () => {
      const body = 'Please note on Tuesday the tech wrote: we are coming Friday morning.';
      expect(stripQuotedAndSignature(body)).toBe(body);
      expect(stripQuotedAndSignature('On Tuesday the tech wrote: we are coming')).toBe('On Tuesday the tech wrote: we are coming');
    });

    test('a dated / addressed quote header still cuts', () => {
      expect(stripQuotedAndSignature('Sounds good. On Tue, Sep 22, 2026 at 3:21 PM, Jane <jane@example.invalid> wrote: see you then')).toBe('Sounds good.');
      expect(stripQuotedAndSignature('Sounds good. On 09/09/2026 8:29 AM, Jane wrote: see you then')).toBe('Sounds good.');
      // Any case: some clients write the header lower-case (Codex #5422 r3).
      expect(stripQuotedAndSignature('Sounds good. on Tue, Sep 22, 2026 at 3:21 PM, Jane <jane@example.invalid> wrote: see you then')).toBe('Sounds good.');
    });

    test('the digit or address must sit inside the header, before the first "wrote:"', () => {
      const body = 'On Tuesday the tech wrote: come at 3 and On Friday he wrote: no';
      expect(stripQuotedAndSignature(body)).toBe(body);
    });
  });
});

describe('ownReplySubject', () => {
  test('the thread subject behind Re:/Fwd: prefixes is not new text', () => {
    expect(ownReplySubject('Re: Please reschedule Friday', ['Please reschedule Friday'])).toBe('');
    expect(ownReplySubject('RE: re: Fwd: please reschedule  friday', ['Please reschedule Friday'])).toBe('');
    expect(ownReplySubject('Re:', [])).toBe('');
  });

  test('a subject that says something new is the reply\'s own words, without its prefixes', () => {
    expect(ownReplySubject('Re: Booked you for Friday 9am', ['Please reschedule Friday'])).toBe('Booked you for Friday 9am');
    expect(ownReplySubject('Estimate attached', [])).toBe('Estimate attached');
  });

  test('a forwarded subject is never the sender\'s own words, even the first in its thread', () => {
    expect(ownReplySubject('Fwd: Please cancel service', [])).toBe('');
    expect(ownReplySubject('FW: Please cancel service', [])).toBe('');
    expect(ownReplySubject('Re: Fwd: Please cancel service', [])).toBe('');
    expect(ownReplySubject('Forward this to Adam please', [])).toBe('Forward this to Adam please');
    // Localized clients' forward prefixes (Codex #5422 r3).
    for (const prefix of ['WG', 'RV', 'TR', 'ENC', 'Doorst', 'VB', 'VL', 'AW: WG']) {
      expect(ownReplySubject(`${prefix}: Please cancel service`, [])).toBe('');
    }
    expect(ownReplySubject('AW: Please cancel service', ['Please cancel service'])).toBe('');
  });
});
