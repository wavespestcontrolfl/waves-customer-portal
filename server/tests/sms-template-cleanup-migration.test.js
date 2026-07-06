const cleanTemplateSeed = require('../models/migrations/20260514000002_tighten_sms_template_copy');
const migration = require('../models/migrations/20260706000010_sms_template_cleanup');

const EXPECTED_REMOVED = [
  'appointment_call_confirmed',
  'health_check_in',
  'health_retention_offer',
  'health_rebook',
  'health_payment_reminder',
  'health_apology',
  'health_welcome_followup',
  'waveguard_upsell',
  'seasonal_alert',
  'estimate_auto_renewed',
];

const EXPECTED_REACTIVATED = [
  'quote_wizard_booking_invite',
  'auto_new_recurring',
  'auto_bed_bug',
  'auto_cockroach',
];

function buildKnex({ fleaExists = false } = {}) {
  const state = {
    deletedTemplateKeys: [],
    deletedVariantKeys: [],
    reactivatedKeys: [],
    reactivateUpdate: null,
    inserted: [],
  };

  const knex = jest.fn((table) => {
    if (table === 'sms_template_variants') {
      const query = {
        whereIn(column, keys) {
          expect(column).toBe('template_key');
          state.deletedVariantKeys.push(...keys);
          return query;
        },
        del: jest.fn(async () => 0),
      };
      return query;
    }
    expect(table).toBe('sms_templates');
    const query = {
      whereIn(column, keys) {
        expect(column).toBe('template_key');
        query.__keys = keys;
        return query;
      },
      where(criteria) {
        query.__where = criteria;
        return query;
      },
      del: jest.fn(async () => {
        state.deletedTemplateKeys.push(...query.__keys);
        return query.__keys.length;
      }),
      update: jest.fn(async (data) => {
        state.reactivatedKeys.push(...(query.__keys || []));
        state.reactivateUpdate = data;
        return query.__keys.length;
      }),
      first: jest.fn(async () => (fleaExists ? { id: 'existing-flea' } : null)),
      insert: jest.fn(async (data) => {
        state.inserted.push(data);
        return [data];
      }),
    };
    return query;
  });

  knex.schema = {
    hasTable: jest.fn(async () => true),
  };

  return { knex, state };
}

describe('sms template cleanup migration (20260706000010)', () => {
  test('deletes retired templates and their variants', async () => {
    const { knex, state } = buildKnex();

    await migration.up(knex);

    expect(state.deletedTemplateKeys).toEqual(EXPECTED_REMOVED);
    expect(state.deletedVariantKeys).toEqual(EXPECTED_REMOVED);
  });

  test('reactivates live-send templates without touching their bodies', async () => {
    const { knex, state } = buildKnex();

    await migration.up(knex);

    expect(state.reactivatedKeys).toEqual(EXPECTED_REACTIVATED);
    // Only the flag flips — admin-edited copy stays whatever it is.
    expect(Object.keys(state.reactivateUpdate).sort()).toEqual(['is_active', 'updated_at']);
    expect(state.reactivateUpdate.is_active).toBe(true);
  });

  test('seeds auto_flea when missing and skips when present', async () => {
    const missing = buildKnex();
    await migration.up(missing.knex);
    expect(missing.state.inserted).toHaveLength(1);
    expect(missing.state.inserted[0]).toMatchObject({
      template_key: 'auto_flea',
      category: 'automations',
      is_active: true,
    });
    expect(missing.state.inserted[0].body).toContain('flea-free');
    expect(missing.state.inserted[0].body).not.toMatch(/\{service_date\}/);

    const present = buildKnex({ fleaExists: true });
    await migration.up(present.knex);
    expect(present.state.inserted).toHaveLength(0);
  });

  test('does nothing when sms_templates does not exist', async () => {
    const knex = jest.fn();
    knex.schema = { hasTable: jest.fn(async () => false) };

    await migration.up(knex);

    expect(knex).not.toHaveBeenCalled();
  });

  test('keeps removed templates out of the runtime default seed list', () => {
    const defaultKeys = cleanTemplateSeed.TEMPLATES.map((template) => template.template_key);

    for (const key of EXPECTED_REMOVED) {
      expect(defaultKeys).not.toContain(key);
    }
    // The cancellation-save sequence is kept in full (owner call 2026-07-06),
    // as is seasonal_reactivation.
    expect(defaultKeys).toContain('cancellation_save_step1_price');
    expect(defaultKeys).toContain('cancellation_save_step2_default');
    expect(defaultKeys).toContain('cancellation_save_step3');
    expect(defaultKeys).toContain('seasonal_reactivation');
  });
});
