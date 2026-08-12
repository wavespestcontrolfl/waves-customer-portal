/**
 * Guards migration 20260812000010 (owner shortening pass 2026-08-12): the
 * secure-card base invite drops " visit" and "the service is done" →
 * "service" so that — together with the 22-char base64url token minted by
 * appointment-card-request.js in the same PR — a typical render lands at
 * 2 GSM-7 segments instead of 3. Pins the swap table's invariants, that
 * every disclosure survives, and the segment budget itself.
 */

const { _SWAPS: SWAPS } = require('../models/migrations/20260812000010_shorten_secure_card_invite_sms');

const tokens = (body) => [...String(body).matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]).sort();

// cancelFeeLine() shapes (appointment-card-request.js): trailing space, no
// leading newline; '' when the fee is configured off.
const FEE_ON = '$75 fee only for last-minute cancels or no-shows. ';
const FEE_OFF = '';

// Current mint: randomBytes(16).toString('base64url') → 22 chars; the SMS
// leg strips https:// (SCHEMELESS_SMS_HOSTS), so this is the sent link.
const SHORT_LINK = `portal.wavespestcontrol.com/secure/${'A'.repeat(22)}`;
const LEGACY_LINK = `portal.wavespestcontrol.com/secure/${'a'.repeat(64)}`;

const render = (body, feeLine, link = SHORT_LINK) => body
  .replace('{first_name}', 'Jennifer')
  .replace('{service_type}', 'Quarterly Pest Control Service')
  .replace(/\{date_line\}/, ' on Wed, Aug 12')
  .replace('{secure_link}', link)
  .replace('{cancel_fee_line}', feeLine);

describe('secure-card invite shortening swap table', () => {
  test('every entry changes something and preserves the audited variable set', () => {
    for (const [key, expect_, set] of SWAPS) {
      expect({ key, changed: set !== expect_ }).toEqual({ key, changed: true });
      expect({ key, vars: tokens(set) }).toEqual({ key, vars: tokens(expect_) });
    }
  });

  test('rewritten bodies stay GSM-7-safe ASCII with clean whitespace', () => {
    for (const [key, , set] of SWAPS) {
      expect({ key, ok: /^[\x20-\x7E\n]*$/.test(set) }).toEqual({ key, ok: true });
      expect({ key, runs: /\n{3,}/.test(set) }).toEqual({ key, runs: false });
      expect({ key, trail: /[ \t]+\n/.test(set) }).toEqual({ key, trail: false });
      expect({ key, end: /\s$/.test(set) }).toEqual({ key, end: false });
    }
  });

  test('every disclosure survives the trim', () => {
    for (const [key, , set] of SWAPS) {
      expect({ key, has: set.includes('Nothing is charged today') }).toEqual({ key, has: true });
      expect({ key, has: set.includes('\n\n{cancel_fee_line}We never take card numbers by phone.') })
        .toEqual({ key, has: true });
    }
  });

  test('base render with the short link + fee line + long service label fits 2 GSM-7 segments', () => {
    const [, , base] = SWAPS.find(([k]) => k === 'secure_appointment_card');
    const rendered = render(base, FEE_ON);
    // 2 concatenated GSM-7 segments = 306 septets; the whole point of the
    // shortening pass. Fee-off is strictly shorter.
    expect(rendered.length).toBeLessThanOrEqual(306);
    // Three blocks: ask + link / charge-truth / fine print.
    expect(rendered.split('\n\n')).toHaveLength(3);
    expect(rendered).toContain('\n\n$75 fee only for last-minute cancels or no-shows. We never take card numbers by phone.');
  });

  test('a reused legacy 64-hex link still fits the card_request 3-segment cap', () => {
    const [, , base] = SWAPS.find(([k]) => k === 'secure_appointment_card');
    expect(render(base, FEE_ON, LEGACY_LINK).length).toBeLessThanOrEqual(459);
  });

  test('fee-off render leaves the security line starting cleanly', () => {
    const [, , base] = SWAPS.find(([k]) => k === 'secure_appointment_card');
    const rendered = render(base, FEE_OFF);
    expect(rendered).toContain('\n\nWe never take card numbers by phone.');
    expect(rendered).not.toMatch(/\n /);
  });
});
