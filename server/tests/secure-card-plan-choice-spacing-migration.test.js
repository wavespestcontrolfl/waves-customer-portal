/**
 * Guards migration 20260811000010 (owner spacing pass 2026-08-11): the
 * secure-card SMS bodies gain paragraph breaks, the plans intro drops the
 * date-colon jam, and the fee + card-security disclosures share one line.
 * Pins the swap table's invariants and the mechanical token-repositioning
 * fallback that keeps admin-edited bodies compatible with the new
 * trailing-space cancelFeeLine() token shipped in the same PR.
 */

const {
  _SWAPS: SWAPS,
  _repositionFeeToken: repositionFeeToken,
} = require('../models/migrations/20260811000010_secure_card_plan_choice_spacing');

const tokens = (body) => [...String(body).matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]).sort();

// The NEW cancelFeeLine() shape (appointment-card-request.js): trailing
// space, no leading newline; '' when the fee is configured off.
const FEE_ON = '$75 fee only for last-minute cancels or no-shows. ';
const FEE_OFF = '';

const render = (body, feeLine) => body
  .replace('{first_name}', 'Jennifer')
  .replace('{service_type}', 'Quarterly Pest Control Service')
  .replace(/\{date_line\}/, ' on Wed, Aug 12')
  .replace('{secure_link}', `portal.wavespestcontrol.com/secure/${'a'.repeat(64)}`)
  .replace('{cancel_fee_line}', feeLine);

describe('secure-card plan-choice spacing swap table', () => {
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

  test('every disclosure survives, and the fine-print tail shares one line', () => {
    for (const [key, , set] of SWAPS) {
      expect({ key, has: set.includes('\n\n{cancel_fee_line}We never take card numbers by phone.') })
        .toEqual({ key, has: true });
    }
    const [, , plans] = SWAPS.find(([k]) => k === 'secure_appointment_card_plans');
    expect(plans).toContain('Nothing is charged today unless you prepay');
    expect(plans).toContain('pay per application'); // price-unit rule: never "per visit"
    expect(plans).not.toContain('{date_line}:'); // the date-colon jam this pass removes
  });

  test('plans render: fee-on joins the disclosures on one line after a blank line', () => {
    const [, , plans] = SWAPS.find(([k]) => k === 'secure_appointment_card_plans');
    const rendered = render(plans, FEE_ON);
    expect(rendered).toContain('\n\n$75 fee only for last-minute cancels or no-shows. We never take card numbers by phone.');
    // Three blocks: intro / charge-truth + link / fine print.
    expect(rendered.split('\n\n')).toHaveLength(3);
    // 64-hex bearer link + longest realistic service label stays ≤3 GSM-7 segments.
    expect(rendered.length).toBeLessThanOrEqual(459);
  });

  test('plans render: fee-off leaves the security line starting cleanly', () => {
    const [, , plans] = SWAPS.find(([k]) => k === 'secure_appointment_card_plans');
    const rendered = render(plans, FEE_OFF);
    expect(rendered).toContain('\n\nWe never take card numbers by phone.');
    expect(rendered).not.toMatch(/\n /);
  });

  test('mechanical fallback repositions the token in drifted bodies (old adjacency would jam the link into the fee text)', () => {
    // The pre-pass audited adjacency, as an admin-drifted wording variant.
    expect(repositionFeeToken('Custom wording: {secure_link}{cancel_fee_line}\nWe never take card numbers by phone.'))
      .toBe('Custom wording: {secure_link}\n\n{cancel_fee_line}We never take card numbers by phone.');
    // Sentence-adjacent form (the non-plans audited shape).
    expect(repositionFeeToken('Done today.{cancel_fee_line}\nWe never take card numbers by phone.'))
      .toBe('Done today.\n\n{cancel_fee_line}We never take card numbers by phone.');
    // Idempotent on already-migrated bodies, and a no-op without the token.
    for (const [, , set] of SWAPS) {
      expect(repositionFeeToken(set)).toBe(set);
    }
    expect(repositionFeeToken('No token here.')).toBe('No token here.');
  });
});
