/**
 * House-voice sweep invariants.
 *
 * The migration rewrites 86 customer-facing SMS templates. The risks worth
 * pinning are not the prose but the mechanics: a lost {placeholder} silently
 * ships a literal "{pay_url}" to a customer, and a rewrite that reintroduces
 * banned boilerplate defeats the point of the sweep.
 */

const { REWRITES, LEGACY_REFERRAL_REWRITES } = require('../models/migrations/20260801000001_sms_house_voice_sweep');
const { spokenArrivalWindow, UNKNOWN_ARRIVAL_WINDOW } = require('../utils/sms-time-format');

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

  test('legacy referral overrides are rewritten and clean', () => {
    // referral_engine prefers these columns and never consults sms_templates,
    // so rewriting the base rows alone would leave the live copy untouched.
    expect(LEGACY_REFERRAL_REWRITES.map(([c]) => c)).toEqual(['invite_sms_template', 'reward_sms_template']);
    for (const [column, expected, next] of LEGACY_REFERRAL_REWRITES) {
      expect({ column, bangs: (next.match(/!/g) || []).length <= 1 }).toEqual({ column, bangs: true });
      expect({ column, hype: /great news|we'd love/i.test(next) }).toEqual({ column, hype: false });
      // placeholders preserved
      const ph = (s) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
      expect([...ph(expected)].filter((p) => !ph(next).has(p))).toEqual([]);
    }
  });
});

describe('spokenArrivalWindow ({window} placeholder)', () => {
  test('renders the 2-hour range with the preposition inside the value', () => {
    expect(spokenArrivalWindow('08:00')).toBe('between 8:00 AM and 10:00 AM');
    expect(spokenArrivalWindow('15:00:00')).toBe('between 3:00 PM and 5:00 PM');
  });

  test('wraps midnight without producing a negative range', () => {
    expect(spokenArrivalWindow('23:00')).toBe('between 11:00 PM and 1:00 AM');
  });

  test('falls back to a grammatical phrase when the window is unusable', () => {
    // The reminders read "...is tomorrow, {window}." so the fallback has to
    // read correctly in that slot, not just be non-empty.
    for (const bad of [null, undefined, '', 'garbage', '99:99']) {
      expect(spokenArrivalWindow(bad)).toBe(UNKNOWN_ARRIVAL_WINDOW);
    }
    expect(`Your service is tomorrow, ${UNKNOWN_ARRIVAL_WINDOW}.`)
      .toBe("Your service is tomorrow, at a time we'll confirm.");
  });
});

describe('rendered-output whitespace hygiene', () => {
  // Optional clause variables carry their own trailing "\n\n" so copy can
  // follow them. The house-voice sweep removed the footers that used to
  // follow, which left several templates ending in blank lines — billable
  // whitespace Twilio counts toward the segment budget.
  const tidy = (s) => s.replace(/\n{3,}/g, '\n\n').trim();

  test('a clause-terminated body loses its dangling blank lines', () => {
    const raw = 'Hello Jennifer! Adam is on the way.\n\nTrack live: https://x.co/a\n\n';
    expect(tidy(raw)).toBe('Hello Jennifer! Adam is on the way.\n\nTrack live: https://x.co/a');
  });

  test('an empty middle clause does not leave a double gap', () => {
    const raw = 'Line one.\n\n\n\nLine two.';
    expect(tidy(raw)).toBe('Line one.\n\nLine two.');
  });

  test('intentional single blank lines survive', () => {
    const raw = 'Para one.\n\nPara two.';
    expect(tidy(raw)).toBe(raw);
  });
});

describe('scheme-less portal links in SMS', () => {
  // Mirror of stripPortalUrlScheme in routes/admin-sms-templates.js.
  const HOSTS = ['portal.wavespestcontrol.com', 'waves-customer-portal-production.up.railway.app'];
  const esc = (h) => h.replace(/\./g, '\\.');
  const RE = new RegExp(
    `https://(?=(?:${HOSTS.map(esc).join('|')})[/\\s]|(?:${HOSTS.map(esc).join('|')})$)`, 'g'
  );
  const strip = (s) => s.replace(RE, '');

  test('drops the scheme from our own portal links', () => {
    expect(strip('Track live: https://portal.wavespestcontrol.com/l/adwy9'))
      .toBe('Track live: portal.wavespestcontrol.com/l/adwy9');
    expect(strip('Visit https://portal.wavespestcontrol.com'))
      .toBe('Visit portal.wavespestcontrol.com');
    expect(strip('Pay: https://waves-customer-portal-production.up.railway.app/l/x9'))
      .toBe('Pay: waves-customer-portal-production.up.railway.app/l/x9');
  });

  test('leaves third-party links (Google review) with their scheme', () => {
    const google = 'Review us: https://g.page/r/abc/review';
    expect(strip(google)).toBe(google);
  });

  test('does not match a foreign URL that merely contains our host in its path', () => {
    const spoof = 'https://example.com/portal.wavespestcontrol.com/fake';
    expect(strip(spoof)).toBe(spoof);
  });
});
