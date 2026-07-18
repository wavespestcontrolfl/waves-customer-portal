/**
 * Contract for 20260709000030_irrigation_footer_drop_portal_toggle: the
 * portal's Seasonal Lawn Tips toggle was removed (owner ruling 2026-07-09),
 * so the irrigation weekly email footer must stop directing recipients to it
 * (Codex P2 on PR #2523). These emails ride service_operational, which
 * renders no visible unsubscribe link — the reply path is the one honest
 * opt-out left to advertise.
 */

const seed = require('../models/migrations/20260702000001_seed_irrigation_weekly_email_templates');
const fix = require('../models/migrations/20260709000030_irrigation_footer_drop_portal_toggle');

const { TEMPLATE_KEYS, OLD_SENTENCE, NEW_SENTENCE, rewriteJson } = fix.__private;

describe('irrigation footer copy fix migration', () => {
  test('covers exactly the seeded irrigation templates', () => {
    expect([...TEMPLATE_KEYS].sort()).toEqual(seed.TEMPLATES.map((t) => t.key).sort());
  });

  test('the sentence being replaced is the one the seed actually shipped', () => {
    // If the seed's footer copy drifts, this pairing must be revisited —
    // a silent miss would leave the broken portal-toggle instruction live.
    for (const t of seed.TEMPLATES) {
      const footers = t.blocks.filter(
        (b) => typeof b.content === 'string' && b.content.includes(OLD_SENTENCE),
      );
      expect(footers).toHaveLength(1);
    }
  });

  test('rewritten blocks advertise only the reply opt-out', () => {
    for (const t of seed.TEMPLATES) {
      const rewritten = rewriteJson(t.blocks);
      const json = JSON.stringify(rewritten);
      expect(json).not.toContain('Seasonal Lawn Tips');
      expect(json).not.toContain('Notification Preferences');
      const footer = rewritten.find(
        (b) => typeof b.content === 'string' && b.content.includes(NEW_SENTENCE),
      );
      expect(footer).toBeDefined();
      // Everything before the opt-out sentence is untouched.
      expect(footer.content).toContain('University of Florida turf guidance');
    }
  });

  test('rewrite is a no-op on already-clean blocks', () => {
    for (const t of seed.TEMPLATES) {
      const once = rewriteJson(t.blocks);
      expect(rewriteJson(once)).toEqual(once);
    }
  });
});
