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

  it('produces flags-array entries in the consumer shape', () => {
    const flags = lintFlags('So excited!! 🎉', { channel: 'sms', audience: 'customer' });
    expect(flags.length).toBeGreaterThan(0);
    for (const f of flags) {
      expect(f.severity).toBe('warn');
      expect(f.type).toMatch(/^comms_lint:/);
      expect(typeof f.detail).toBe('string');
    }
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
