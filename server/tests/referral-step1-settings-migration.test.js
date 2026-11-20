/**
 * 20261120090000_referral_step1_settings (owner 2026-11-20, referral Step 1):
 * the values themselves. DB-backed up() / down() behavior (compare-and-swap,
 * admin-edit safety, audit tracking, tracked-only revert) is in
 * referral-step1-settings-migration-postgres.test.js.
 */
const migration = require('../models/migrations/20261120090000_referral_step1_settings');
const SWEEP = require('../models/migrations/20260801000001_sms_house_voice_sweep');

const { _CHANGES: CHANGES } = migration;
const placeholders = (s) => (s.match(/\{[a-z_]+\}/g) || []).sort();

test('the invite text swaps from exactly what the house-voice sweep wrote, and says "Waves"', () => {
  const [, before, after] = CHANGES.find(([column]) => column === 'invite_sms_template');
  const swept = SWEEP.LEGACY_REFERRAL_REWRITES.find(([column]) => column === 'invite_sms_template')[2];
  expect(before).toBe(swept);
  expect(after).toBe(before.replace('Waves Pest Control', 'Waves'));
  expect(after).not.toMatch(/Waves Pest Control/);
  expect(placeholders(after)).toEqual(placeholders(before));
  expect(after).toBe("Hi {referee_name}! Your neighbor {referrer_name} recommended Waves. You'll both save when you sign up: {referral_link}");
});

test('the tier bonuses go from the live values to 0, and nothing else changes', () => {
  expect(CHANGES.map(([column]) => column)).toEqual(['invite_sms_template', 'bonus_silver_cents', 'bonus_gold_cents', 'bonus_platinum_cents']);
  expect(CHANGES.slice(1)).toEqual([
    ['bonus_silver_cents', 5000, 0],
    ['bonus_gold_cents', 7500, 0],
    ['bonus_platinum_cents', 10000, 0],
  ]);
});

test('the audit actions fit audit_log.action (varchar 96)', () => {
  expect(migration._AUDIT_ACTION.length).toBeLessThanOrEqual(96);
  expect(migration._AUDIT_ROLLBACK_ACTION.length).toBeLessThanOrEqual(96);
});
