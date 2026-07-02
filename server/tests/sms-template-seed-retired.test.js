/**
 * Retired SMS templates must not resurrect (Codex P2, PR-bot round 1).
 *
 * ensureTable() reseeds default templates with onConflict-ignore on every
 * deploy's first admin visit. The seed source (the 20260514000002 copy
 * migration) still contains the follow-up keys that migration
 * 20260702000031 retired — unfiltered, the deleted templates reappear as
 * protected clutter. Pins: the runtime seed list excludes retired keys, and
 * the coarse `estimate_followup` kill-switch mapping is gone (every cron
 * stage now sends its own template key as the messageType).
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));
jest.mock('../services/sms-template-variants', () => ({}));
jest.mock('../services/audit-log', () => ({
  auditNotificationTemplateIssue: jest.fn(),
}));

const { _private } = require('../routes/admin-sms-templates');
const {
  RETIRED_KEYS,
  NEW_TEMPLATES,
} = require('../models/migrations/20260702000031_estimate_followup_cadence_templates');

describe('sms template default seed vs retired keys', () => {
  test('the retired follow-up keys are filtered out of the runtime seed', () => {
    const seedKeys = new Set(_private.SEED_SMS_TEMPLATES.map((t) => t.template_key));
    for (const retired of RETIRED_KEYS) {
      expect(seedKeys.has(retired)).toBe(false);
    }
    // Sanity: the filter didn't gut the seed (baseline templates remain).
    expect(_private.SEED_SMS_TEMPLATES.length).toBeGreaterThan(50);
    expect(seedKeys.has('estimate_sent')).toBe(true);
  });

  test('retired-key set mirrors the retiring migration', () => {
    expect([..._private.RETIRED_SEED_KEYS].sort()).toEqual([...RETIRED_KEYS].sort());
  });

  test('no coarse estimate_followup kill-switch mapping — stages use their own keys', () => {
    expect(_private.MSG_TYPE_TO_TEMPLATE).not.toHaveProperty('estimate_followup');
    // The per-stage message types ARE template keys, resolved by the
    // isTemplateActive fallback — none of them may be re-mapped elsewhere.
    for (const t of NEW_TEMPLATES) {
      expect(_private.MSG_TYPE_TO_TEMPLATE).not.toHaveProperty(t.template_key);
    }
  });
});
