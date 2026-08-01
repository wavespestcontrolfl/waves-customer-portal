/**
 * House-voice sweep invariants.
 *
 * The migration rewrites 86 customer-facing SMS templates. The risks worth
 * pinning are not the prose but the mechanics: a lost {placeholder} silently
 * ships a literal "{pay_url}" to a customer, and a rewrite that reintroduces
 * banned boilerplate defeats the point of the sweep.
 */

const { REWRITES } = require('../models/migrations/20260801000001_sms_house_voice_sweep');

const placeholders = (body) => new Set(
  [...String(body).matchAll(/\{([a-z0-9_]+)\}/gi)].map((m) => m[1])
);

// reminder_24h / reminder_72h deliberately swap {time} for {window}.
const INTENTIONAL_SWAPS = {
  reminder_24h: { dropped: ['time'], added: ['window'] },
  reminder_72h: { dropped: ['time'], added: ['window'] },
};

describe('sms house-voice sweep', () => {
  test('every rewrite preserves the placeholders its sender depends on', () => {
    for (const [key, expected, next] of REWRITES) {
      const before = placeholders(expected);
      const after = placeholders(next);
      const swap = INTENTIONAL_SWAPS[key] || { dropped: [], added: [] };
      const lost = [...before].filter((p) => !after.has(p) && !swap.dropped.includes(p));
      const added = [...after].filter((p) => !before.has(p) && !swap.added.includes(p));
      expect({ key, lost }).toEqual({ key, lost: [] });
      expect({ key, added }).toEqual({ key, added: [] });
    }
  });

  test('no rewrite reintroduces banned sign-off boilerplate', () => {
    const BANNED = /(questions|requests?)[^.\n]{0,40}\?\s*(just\s+)?reply|reply to this message|simply reply|thank you for choosing/i;
    const offenders = REWRITES.filter(([, , next]) => BANNED.test(next)).map(([k]) => k);
    expect(offenders).toEqual([]);
  });

  test('no rewrite carries more than one exclamation mark', () => {
    const offenders = REWRITES.filter(([, , next]) => (String(next).match(/!/g) || []).length > 1).map(([k]) => k);
    expect(offenders).toEqual([]);
  });

  test('no rewrite contains typographic punctuation (forces UCS-2)', () => {
    const offenders = REWRITES.filter(([, , next]) => /[—…‘’“”]/.test(next)).map(([k]) => k);
    expect(offenders).toEqual([]);
  });

  test('opt-out language is preserved wherever it already existed', () => {
    // The STOP ruling removes it from recurring operational notices ONLY.
    const INTENTIONAL_REMOVALS = new Set(['reminder_72h']);
    for (const [key, expected, next] of REWRITES) {
      if (!/reply stop/i.test(expected) || INTENTIONAL_REMOVALS.has(key)) continue;
      expect({ key, hasStop: /reply stop/i.test(next) }).toEqual({ key, hasStop: true });
    }
  });

  test('fee, deposit, and card-security disclosures survive', () => {
    const MUST_KEEP = [
      ['ach_card_fallback', /processing fee/i],
      ['ach_suspended', /processing fee/i],
      ['secure_appointment_card', /never take card numbers by phone/i],
      ['late_payment_90d', /collections/i],
    ];
    for (const [key, re] of MUST_KEEP) {
      const row = REWRITES.find(([k]) => k === key);
      expect(row).toBeTruthy();
      expect({ key, kept: re.test(row[2]) }).toEqual({ key, kept: true });
    }
  });

  test('bed bug prep keeps all three steps', () => {
    const row = REWRITES.find(([k]) => k === 'auto_bed_bug_no_email');
    const steps = row[2].split('\n').filter((l) => l.trim().startsWith('- '));
    expect(steps).toHaveLength(3);
    expect(row[2]).toMatch(/14-day follow-up/i);
  });

  test('no duplicate template keys', () => {
    const keys = REWRITES.map(([k]) => k);
    expect(keys).toHaveLength(new Set(keys).size);
  });
});
