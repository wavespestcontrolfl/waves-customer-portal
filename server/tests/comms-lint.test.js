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
  it('permits SMS emojis while retaining the customer email restriction', () => {
    const text = 'Great day for it, go gators! 🐊';
    expect(lintComms(text, { channel: 'sms', audience: 'customer' }).pass).toBe(true);
    const email = lintComms(text, { channel: 'email', audience: 'customer' });
    expect(email.failures.map((f) => f.rule)).toContain('no-emoji');
  });

  it('passes a plain clean message and reports which rules ran', () => {
    const r = lintComms('Hello Sarah! You are confirmed for Tuesday at 10am.', { channel: 'sms', audience: 'customer' });
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.checked).not.toContain('no-emoji');
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

  it('catches shorteners hidden behind unicode dots and percent-encoding', () => {
    for (const msg of ['Book at https://bit。ly/waves', 'Book at https://bit．ly/waves', 'Book at https://bit%2Ely/waves']) {
      const r = lintComms(msg, { channel: 'sms', audience: 'customer' });
      expect(r.failures.map((f) => f.rule)).toContain('no-url-shortener');
    }
  });

  it('a stray literal percent does not disable link canonicalization', () => {
    const hidden = lintComms('Save 50% today: https://bit%2Ely/x', { channel: 'sms', audience: 'customer' });
    expect(hidden.failures.map((f) => f.rule)).toContain('no-url-shortener');
    const plain = lintComms('Save 50% on your renewal this month.', { channel: 'sms', audience: 'customer' });
    expect(plain.failures.map((f) => f.rule)).not.toContain('no-url-shortener');
  });

  it('catches shorteners beyond the fixed list via the short-host fingerprint', () => {
    for (const msg of ['Pay at https://tiny.one/x today', 'Pay at https://v.gd/x today', 'Pay at https://zz.gd/x today']) {
      const r = lintComms(msg, { channel: 'sms', audience: 'customer' });
      expect(r.failures.map((f) => f.rule)).toContain('no-url-shortener');
    }
    // Sanctioned g.page and prose abbreviation pairs never match.
    const gpage = lintComms('We would love a review: https://g.page/r/waves-review', { channel: 'sms', audience: 'customer' });
    expect(gpage.failures.map((f) => f.rule)).not.toContain('no-url-shortener');
    const prose = lintComms('Communication is key, e.g. we text before arrival at 3 p.m. sharp.', { channel: 'sms', audience: 'customer' });
    expect(prose.failures.map((f) => f.rule)).not.toContain('no-url-shortener');
  });

  it('decodes multibyte percent-encoded unicode before folding', () => {
    const r = lintComms('Book at https://bit%EF%BC%8Ely/x today', { channel: 'sms', audience: 'customer' });
    expect(r.failures.map((f) => f.rule)).toContain('no-url-shortener');
  });

  it('counts segments on the normalized body the send path dispatches', () => {
    const body = `We’ll be out Friday between 10 and noon. ${'a'.repeat(100)}`;
    const r = lintComms(body, { channel: 'sms', audience: 'customer' });
    expect(r.failures.map((f) => f.rule)).toContain('plain-punctuation');
    expect(r.failures.map((f) => f.rule)).not.toContain('sms-segment-limit');
  });

  it('a leading plan unit binds through a billing noun, not any later amount', () => {
    const balance = lintComms('Your monthly service is Friday, and your balance is $117.', { channel: 'sms', audience: 'customer', monthlyBilled: false });
    expect(balance.failures.map((f) => f.rule)).not.toContain('no-plan-total');
  });

  it('catches shortener URLs glued to prose punctuation', () => {
    for (const msg of ['Pay here:https://bit.ly/x', 'Pay here,https://tinyurl.com/x', 'See:bit.ly/x']) {
      const r = lintComms(msg, { channel: 'sms', audience: 'customer' });
      expect(r.failures.map((f) => f.rule)).toContain('no-url-shortener');
    }
  });

  it('requires the same scheme-free display for portal and external SMS links', () => {
    for (const host of ['portal.wavespestcontrol.com', 'wavespestcontrol.com', 'waves-customer-portal-production.up.railway.app', 'g.page', 'www.epa.gov', 'example.dev']) {
      const bare = lintComms(`See ${host}/demo`, { channel: 'sms', audience: 'customer' });
      expect(bare.failures.map(f => f.rule)).not.toContain('portal-link-scheme');
      const full = lintComms(`See https://${host}/demo`, { channel: 'sms', audience: 'customer' });
      expect(full.failures.map(f => f.rule)).toContain('portal-link-scheme');
      const email = lintComms(`See https://${host}/demo`, { channel: 'email', audience: 'customer' });
      expect(email.failures.map(f => f.rule)).not.toContain('portal-link-scheme');
    }
  });

  it('does not reject ordinary punctuation, email addresses, or bare hosts', () => {
    for (const text of ['No.problem, e.g. after 3 p.m.', 'Email contact@example.com', 'See:yelp.com', '[trustpilot.com]', 'See WWW.EPA.GOV']) {
      expect(lintComms(text).failures.map(f => f.rule)).not.toContain('portal-link-scheme');
    }
  });

  it('counts the final scheme-free text at the two-segment boundary', () => {
    const link = 'https://g.page/r/demo';
    const body = 'a'.repeat(307 - link.length) + link;
    expect(lintComms(body).failures.map(f => f.rule)).not.toContain('sms-segment-limit');
  });

  it('flags dollar-anchored each/every visit forms but not scheduling prose', () => {
    for (const msg of ['The plan is $117 each visit.', 'Service runs $99 every visit after the initial.', 'It comes to $30 a visit.', 'That plan is 117 dollars each visit.', 'Runs about 30 bucks a visit.', 'Billed at USD 117 every visit.']) {
      const r = lintComms(msg, { channel: 'sms', audience: 'customer' });
      expect(r.failures.map((f) => f.rule)).toContain('per-application-wording');
    }
    const ok = lintComms('We will text you before each visit.', { channel: 'sms', audience: 'customer' });
    expect(ok.failures.map((f) => f.rule)).not.toContain('per-application-wording');
  });

  it('flags plan totals whenever the lane is known and the unit is not the lane\'s own', () => {
    const monthlyForms = ['Your plan is $117/mo.', 'It runs $98 per month.', 'The service is $117 monthly.', 'It comes to 117 dollars per month.'];
    const yearlyForms = ['That works out to $1,404/yr.', 'About $1,404 annually.'];
    for (const msg of [...monthlyForms, ...yearlyForms]) {
      const nonMonthly = lintComms(msg, { channel: 'sms', audience: 'customer', monthlyBilled: false });
      expect(nonMonthly.failures.map((f) => f.rule)).toContain('no-plan-total');
      const unknownLane = lintComms(msg, { channel: 'sms', audience: 'customer' });
      expect(unknownLane.checked).not.toContain('no-plan-total');
    }
    for (const msg of monthlyForms) {
      const member = lintComms(msg, { channel: 'sms', audience: 'customer', monthlyBilled: true });
      expect(member.failures.map((f) => f.rule)).not.toContain('no-plan-total');
    }
    for (const msg of yearlyForms) {
      const member = lintComms(msg, { channel: 'sms', audience: 'customer', monthlyBilled: true });
      expect(member.failures.map((f) => f.rule)).toContain('no-plan-total');
    }
  });

  it('detects plan units that precede the amount', () => {
    for (const msg of ['Your monthly plan total is $117.', 'The annual total is $1,404 for the year.']) {
      const r = lintComms(msg, { channel: 'sms', audience: 'customer', monthlyBilled: false });
      expect(r.failures.map((f) => f.rule)).toContain('no-plan-total');
    }
    const memberDues = lintComms('Your monthly dues are $98.50 as always.', { channel: 'sms', audience: 'customer', monthlyBilled: true, billingMode: 'monthly_membership' });
    expect(memberDues.failures.map((f) => f.rule)).not.toContain('no-plan-total');
  });

  it('appointment timing does not satisfy the re-entry confirmation idiom', () => {
    const r = lintComms('The treatment is safe once dry. The technician will confirm the timing of your next visit.', { channel: 'sms', audience: 'customer' });
    expect(r.failures.map((f) => f.rule)).toContain('reentry-language');
    const ok = lintComms('It is safe once dry - your technician will confirm the timing.', { channel: 'sms', audience: 'customer' });
    expect(ok.failures.map((f) => f.rule)).not.toContain('reentry-language');
  });

  it('plan-total exemptions are unit-specific, not lane-wide', () => {
    const prepayYearly = lintComms('Your annual prepay is $1,404/yr, already covered.', { channel: 'sms', audience: 'customer', monthlyBilled: false, billingMode: 'annual_prepay' });
    expect(prepayYearly.failures.map((f) => f.rule)).not.toContain('no-plan-total');
    const prepayMonthlySpread = lintComms('That works out to $98/mo across the year.', { channel: 'sms', audience: 'customer', monthlyBilled: false, billingMode: 'annual_prepay' });
    expect(prepayMonthlySpread.failures.map((f) => f.rule)).toContain('no-plan-total');
    const memberMonthly = lintComms('Your dues are $98.50/mo as always.', { channel: 'sms', audience: 'customer', monthlyBilled: true, billingMode: 'monthly_membership' });
    expect(memberMonthly.failures.map((f) => f.rule)).not.toContain('no-plan-total');
    const memberYearlyAggregate = lintComms('That comes to $1,176/yr in total.', { channel: 'sms', audience: 'customer', monthlyBilled: true, billingMode: 'monthly_membership' });
    expect(memberYearlyAggregate.failures.map((f) => f.rule)).toContain('no-plan-total');
  });

  it('does not read a mid-message reply instruction as a sign-off closer', () => {
    for (const msg of ['Please reply to this message with the gate code so the technician can enter.', 'Reply to this message if Tuesday works so I can schedule it.']) {
      const r = lintComms(msg, { channel: 'sms', audience: 'customer' });
      expect(r.failures.map((f) => f.rule)).not.toContain('no-signoff-boilerplate');
    }
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
