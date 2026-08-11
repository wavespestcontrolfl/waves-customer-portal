/**
 * Comms-lint harness — rule mechanics plus the permanent regression corpus.
 * The corpus (fixtures/comms-lint-regressions/) is append-only: every miss
 * a sweep or review finds becomes a case here and never leaves.
 */
const path = require('path');
const { lintComms, lintFlags, smsSegmentCount, isGsm7 } = require('../services/comms-lint');

describe('smsSegmentCount', () => {
  it('counts GSM-7 boundaries at 160/153', () => {
    expect(smsSegmentCount('a'.repeat(160))).toBe(1);
    expect(smsSegmentCount('a'.repeat(161))).toBe(2);
    expect(smsSegmentCount('a'.repeat(306))).toBe(2);
    expect(smsSegmentCount('a'.repeat(307))).toBe(3);
  });

  it('counts GSM-7 extension characters as two septets', () => {
    // 159 chars + '€' (2 septets) = 161 septets → 2 segments
    expect(smsSegmentCount(`${'a'.repeat(159)}€`)).toBe(2);
  });

  it('flips to UCS-2 boundaries (70/67) on a single non-GSM character', () => {
    const gsm = 'a'.repeat(71);
    expect(smsSegmentCount(gsm)).toBe(1);
    expect(smsSegmentCount(`’${'a'.repeat(70)}`)).toBe(2);
  });

  it('recognizes GSM-7 text including newlines', () => {
    expect(isGsm7('Hello Dan!\nSee you at 10am.')).toBe(true);
    expect(isGsm7('curly ’ quote')).toBe(false);
  });
});

describe('lintComms mechanics', () => {
  it('passes a plain clean message and reports which rules ran', () => {
    const r = lintComms('Hello Sarah! You are confirmed for Tuesday at 10am.', { channel: 'sms', audience: 'customer' });
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.checked).toContain('no-emoji');
    expect(r.checked).toContain('sms-segment-limit');
  });

  it('skips stop-line-policy when the caller cannot assert the class', () => {
    const r = lintComms('Confirmed for Tuesday. Reply STOP to opt out.', { channel: 'sms', audience: 'customer' });
    expect(r.checked).not.toContain('stop-line-policy');
    expect(r.failures.map((f) => f.rule)).not.toContain('stop-line-policy');
  });

  it('exempts internal messages from customer-voice rules but not link safety', () => {
    const r = lintComms('FIX: 3 failures 🚨 see bit.ly/x', { channel: 'email', audience: 'internal' });
    const rules = r.failures.map((f) => f.rule);
    expect(rules).not.toContain('no-emoji');
    expect(rules).toContain('no-url-shortener');
  });

  it('never matches shortener hosts as substrings of longer domains', () => {
    const r = lintComms('Details at portal.wavespestcontrol.com and habit.ly.example.com today', { channel: 'sms', audience: 'customer' });
    expect(r.failures.map((f) => f.rule)).not.toContain('no-url-shortener');
  });

  it('flags www-prefixed and subdomain forms of a shortener host', () => {
    for (const msg of ['Book at https://www.tinyurl.com/waves', 'Book at custom.bit.ly/waves']) {
      const r = lintComms(msg, { channel: 'sms', audience: 'customer' });
      expect(r.failures.map((f) => f.rule)).toContain('no-url-shortener');
    }
  });

  it('does not flag a non-shortener host that merely starts with a shortener name', () => {
    const r = lintComms('See https://bit.ly.evil.com/x for details', { channel: 'sms', audience: 'customer' });
    expect(r.failures.map((f) => f.rule)).not.toContain('no-url-shortener');
  });

  it('catches shortener URLs glued to prose punctuation', () => {
    for (const msg of ['Pay here:https://bit.ly/x', 'Pay here,https://tinyurl.com/x', 'See:bit.ly/x']) {
      const r = lintComms(msg, { channel: 'sms', audience: 'customer' });
      expect(r.failures.map((f) => f.rule)).toContain('no-url-shortener');
    }
  });

  it('flags any bare third-party host, not just g.page', () => {
    const r = lintComms('Leave us a review at trustpilot.com when you get a chance.', { channel: 'sms', audience: 'customer' });
    const hit = r.failures.find((f) => f.rule === 'portal-link-scheme');
    expect(hit).toBeDefined();
    expect(hit.reason).toContain('trustpilot.com');
  });

  it('exempts scheme-qualified links, email addresses, and own-domain hosts from the bare-host rule', () => {
    const r = lintComms(
      'Pay at portal.wavespestcontrol.com, review us at https://maps.google.com/waves, or email contact@wavespestcontrol.com.',
      { channel: 'sms', audience: 'customer' }
    );
    expect(r.failures.map((f) => f.rule)).not.toContain('portal-link-scheme');
  });

  it('does not read prose abbreviations or TLD-prefixed words as bare hosts', () => {
    const r = lintComms('No.problem at all. Communication is key, e.g. we text before arrival.', { channel: 'sms', audience: 'customer' });
    expect(r.failures.map((f) => f.rule)).not.toContain('portal-link-scheme');
  });

  it('catches bare hosts glued to prose punctuation', () => {
    for (const msg of ['See:yelp.com for our reviews', 'Find us here [yelp.com] anytime', 'Reviews at,yelp.com']) {
      const r = lintComms(msg, { channel: 'sms', audience: 'customer' });
      expect(r.failures.map((f) => f.rule)).toContain('portal-link-scheme');
    }
  });

  it('treats every canonical schemeless host like the portal (bare required, scheme flagged)', () => {
    const bare = lintComms('Pay at waves-customer-portal-production.up.railway.app/pay/abc anytime.', { channel: 'sms', audience: 'customer' });
    expect(bare.failures.map((f) => f.rule)).not.toContain('portal-link-scheme');
    const schemed = lintComms('Pay at https://waves-customer-portal-production.up.railway.app/pay/abc anytime.', { channel: 'sms', audience: 'customer' });
    expect(schemed.failures.map((f) => f.rule)).toContain('portal-link-scheme');
  });

  it('flags bare edu/gov hosts too', () => {
    for (const msg of ['More detail at edis.ifas.ufl.edu if curious.', 'See www.epa.gov for the label.']) {
      const r = lintComms(msg, { channel: 'sms', audience: 'customer' });
      expect(r.failures.map((f) => f.rule)).toContain('portal-link-scheme');
    }
  });

  it('still sees a bare host glued behind a qualified URL or email', () => {
    for (const msg of ['See https://example.com,yelp.com today', 'Email contact@wavespestcontrol.com;trustpilot.com has details']) {
      const r = lintComms(msg, { channel: 'sms', audience: 'customer' });
      expect(r.failures.map((f) => f.rule)).toContain('portal-link-scheme');
    }
  });

  it('does not match a TLD inside a longer word', () => {
    const r = lintComms('Join the yelp.community discussion group', { channel: 'sms', audience: 'customer' });
    expect(r.failures.map((f) => f.rule)).not.toContain('portal-link-scheme');
  });

  it('flags dollar-anchored each/every visit forms but not scheduling prose', () => {
    for (const msg of ['The plan is $117 each visit.', 'Service runs $99 every visit after the initial.', 'It comes to $30 a visit.', 'That plan is 117 dollars each visit.', 'Runs about 30 bucks a visit.', 'Billed at USD 117 every visit.']) {
      const r = lintComms(msg, { channel: 'sms', audience: 'customer' });
      expect(r.failures.map((f) => f.rule)).toContain('per-application-wording');
    }
    const ok = lintComms('We will text you before each visit.', { channel: 'sms', audience: 'customer' });
    expect(ok.failures.map((f) => f.rule)).not.toContain('per-application-wording');
  });

  it('flags plan totals only when the lane positively says not-monthly', () => {
    for (const msg of ['Your plan is $117/mo.', 'That works out to $1,404/yr.', 'It runs $98 per month.', 'The service is $117 monthly.', 'It comes to 117 dollars per month.', 'About $1,404 annually.']) {
      const fail = lintComms(msg, { channel: 'sms', audience: 'customer', monthlyBilled: false });
      expect(fail.failures.map((f) => f.rule)).toContain('no-plan-total');
      const monthlyMember = lintComms(msg, { channel: 'sms', audience: 'customer', monthlyBilled: true });
      expect(monthlyMember.failures.map((f) => f.rule)).not.toContain('no-plan-total');
      const unknownLane = lintComms(msg, { channel: 'sms', audience: 'customer' });
      expect(unknownLane.checked).not.toContain('no-plan-total');
    }
  });

  it('exempts the annual-prepay lane from the plan-total rule', () => {
    const r = lintComms('Your annual prepay is $1,404/yr, already covered.', { channel: 'sms', audience: 'customer', monthlyBilled: false, billingMode: 'annual_prepay' });
    expect(r.checked).not.toContain('no-plan-total');
    expect(r.failures.map((f) => f.rule)).not.toContain('no-plan-total');
  });

  it('does not read a mid-message reply instruction as a sign-off closer', () => {
    const r = lintComms('Please reply to this message with the gate code so the technician can enter.', { channel: 'sms', audience: 'customer' });
    expect(r.failures.map((f) => f.rule)).not.toContain('no-signoff-boilerplate');
    const closer = lintComms('All set for Friday. Reply to this message if you have any questions.', { channel: 'sms', audience: 'customer' });
    expect(closer.failures.map((f) => f.rule)).toContain('no-signoff-boilerplate');
  });

  it('delegates typographic detection to the canonical GSM normalizer set', () => {
    for (const ch of ['‒', '•', '′', '…']) {
      const r = lintComms(`Plain text with ${ch} inside`, { channel: 'sms', audience: 'customer' });
      expect(r.failures.map((f) => f.rule)).toContain('plain-punctuation');
    }
    const clean = lintComms("Plain text - with 'quotes' and \"doubles\".", { channel: 'sms', audience: 'customer' });
    expect(clean.failures.map((f) => f.rule)).not.toContain('plain-punctuation');
  });

  it('recognizes STOP tails beyond the reply/text verb forms', () => {
    for (const msg of ['Your service is confirmed. STOP to unsubscribe', 'Send STOP to opt out anytime.', 'Msg&data rates may apply. Stop to end.']) {
      const r = lintComms(msg, { channel: 'sms', audience: 'customer', stopExpected: false });
      expect(r.failures.map((f) => f.rule)).toContain('stop-line-policy');
    }
    const prose = lintComms('Feel free to stop by the office to grab the report.', { channel: 'sms', audience: 'customer', stopExpected: false });
    expect(prose.failures.map((f) => f.rule)).not.toContain('stop-line-policy');
  });

  it('produces flags-array entries in the consumer shape', () => {
    const flags = lintFlags('So excited!! 🎉', { channel: 'sms', audience: 'customer' });
    expect(flags.length).toBeGreaterThan(0);
    for (const f of flags) {
      expect(f.severity).toBe('warn');
      expect(f.type).toMatch(/^comms_lint:/);
      expect(typeof f.detail).toBe('string');
    }
  });

  it('toFlags on a lintComms result matches lintFlags (single-lint callers must not drift)', () => {
    const { toFlags } = require('../services/comms-lint');
    const text = 'So excited!! 🎉 Book at bit.ly/x';
    const ctx = { channel: 'sms', audience: 'customer', stopExpected: false };
    expect(toFlags(lintComms(text, ctx))).toEqual(lintFlags(text, ctx));
  });

  it('handles empty and non-string input without throwing', () => {
    expect(lintComms('', {}).pass).toBe(true);
    expect(lintComms(null, {}).pass).toBe(true);
    expect(lintComms(undefined, {}).pass).toBe(true);
  });
});

describe('regression corpus (append-only)', () => {
  const { cases } = require(path.join(__dirname, 'fixtures', 'comms-lint-regressions', 'seed-cases.json'));

  it('has cases', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(c.name, () => {
      const r = lintComms(c.text, c.context);
      expect(r.pass).toBe(c.expect.pass);
      if (!c.expect.pass) {
        const failedRules = r.failures.map((f) => f.rule).sort();
        expect(failedRules).toEqual([...c.expect.rules].sort());
        for (const f of r.failures) {
          expect(f.reason.length).toBeGreaterThan(10); // one-line reason, always present
        }
      }
    });
  }
});
