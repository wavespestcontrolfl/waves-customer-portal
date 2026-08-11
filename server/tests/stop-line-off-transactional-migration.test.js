/**
 * Guards migration 20260810000060 (owner directive 2026-08-10): "Reply STOP
 * to opt out." comes off customer-transactional templates. Pins the swap
 * table's invariants (STOP actually removed, variables preserved, GSM-7
 * safety, whitespace hygiene) and the mechanical fallback used for
 * admin-edited rows.
 */

const {
  _SWAPS: SWAPS,
  _dropStop: dropStop,
} = require('../models/migrations/20260810000060_stop_line_off_customer_transactional');

const tokens = (body) => [...String(body).matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]).sort();

describe('stop-line-off-transactional swap table', () => {
  test('every entry changes something and no rewritten body still carries STOP', () => {
    for (const [key, expect_, set] of SWAPS) {
      expect({ key, changed: set !== expect_ }).toEqual({ key, changed: true });
      expect({ key, stop: /Reply STOP/i.test(set) }).toEqual({ key, stop: false });
    }
  });

  test('rewrites preserve the exact variable set of the audited body', () => {
    for (const [key, expect_, set] of SWAPS) {
      expect({ key, vars: tokens(set) }).toEqual({ key, vars: tokens(expect_) });
    }
  });

  test('rewritten bodies stay GSM-7-safe ASCII (same budget the fleet obeys)', () => {
    for (const [key, , set] of SWAPS) {
      expect({ key, ok: /^[\x20-\x7E\n]*$/.test(set) }).toEqual({ key, ok: true });
    }
  });

  test('no blank-line runs, trailing spaces, or trailing whitespace beyond a render-time placeholder', () => {
    for (const [key, , set] of SWAPS) {
      expect({ key, runs: /\n{3,}/.test(set) }).toEqual({ key, runs: false });
      expect({ key, trail: /[ \t]+\n/.test(set) }).toEqual({ key, trail: false });
      expect({ key, end: /\s$/.test(set) }).toEqual({ key, end: false });
    }
  });

  test('cancel-fee and card-security disclosures survive on the secure-card texts', () => {
    for (const key of ['secure_appointment_card', 'secure_appointment_card_plans']) {
      const [, , set] = SWAPS.find(([k]) => k === key);
      expect(set).toContain('{cancel_fee_line}');
      expect(set).toContain('We never take card numbers by phone.');
    }
    // The plans variant keeps the prepay-conditioned truth line, tightened.
    const [, , plans] = SWAPS.find(([k]) => k === 'secure_appointment_card_plans');
    expect(plans).toContain('Nothing is charged today unless you prepay');
  });

  test('plans copy lands at 2 segments at typical render lengths (was the only 3-segment template)', () => {
    const [, , set] = SWAPS.find(([k]) => k === 'secure_appointment_card_plans');
    const rendered = set
      .replace('{first_name}', 'Jennifer')
      .replace('{service_type}', 'Pest Control')
      .replace('{date_line}', ' on Thu, Aug 20')
      .replace('{secure_link}', 'portal.wavespestcontrol.com/l/abcd1234ef')
      .replace('{cancel_fee_line}', '\n$49 fee only for last-minute cancels or no-shows.');
    expect(rendered.length).toBeLessThanOrEqual(306); // 2 GSM-7 segments
  });

  test('receipt spacing fix separates the report and receipt link blocks', () => {
    const [, , set] = SWAPS.find(([k]) => k === 'service_complete_paid_receipt');
    expect(set).toContain('{portal_url}\n\nReceipt: {receipt_url}');
  });

  test('mechanical fallback strips STOP from admin-edited bodies in both positions', () => {
    expect(dropStop('Body text.\n\nReply STOP to opt out.')).toBe('Body text.');
    expect(dropStop('We never take card numbers by phone. Reply STOP to opt out.'))
      .toBe('We never take card numbers by phone.');
    expect(dropStop('No STOP here.')).toBe('No STOP here.');
  });
});
