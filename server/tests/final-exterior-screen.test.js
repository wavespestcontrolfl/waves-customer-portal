// Shared copy screen for the pre-treat certificate's final-exterior fields:
// the admin write guard, the public /data egress and the staff preview all
// read this one rule (GATE_PRETREAT_STICKER_REPORT).
const { failingFinalExteriorKeys, screenFinalExteriorFindings } = require('../services/final-exterior-screen');

describe('final exterior copy screen', () => {
  test('passes product, ingredient and applicator names', () => {
    expect(failingFinalExteriorKeys({
      final_exterior_product: 'Termidor SC',
      final_exterior_active_ingredient: 'Fipronil',
      final_exterior_applicator_name: 'Alex Tester',
    })).toEqual([]);
  });

  test('names a banned claim and an access code, from an object or a JSON string', () => {
    expect(failingFinalExteriorKeys({ final_exterior_product: 'pet-safe Termidor' })).toEqual(['final_exterior_product']);
    expect(failingFinalExteriorKeys(JSON.stringify({ final_exterior_applicator_name: 'gate code 1234' })))
      .toEqual(['final_exterior_applicator_name']);
  });

  test('blanks only the failing keys and leaves clean findings untouched', () => {
    const clean = { final_exterior_product: 'Termidor SC' };
    expect(screenFinalExteriorFindings(clean)).toBe(clean);
    expect(screenFinalExteriorFindings({ final_exterior_product: 'EPA-approved fipronil', final_exterior_active_ingredient: 'Fipronil' }))
      .toEqual({ final_exterior_product: '', final_exterior_active_ingredient: 'Fipronil' });
  });
});
