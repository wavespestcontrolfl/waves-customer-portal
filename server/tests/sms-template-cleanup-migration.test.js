const cleanTemplateSeed = require('../models/migrations/20260514000002_tighten_sms_template_copy');
const migration = require('../models/migrations/20260706000010_sms_template_cleanup');

const EXPECTED_REMOVED = [
  'appointment_call_confirmed',
  'health_check_in',
  'health_rebook',
  'health_payment_reminder',
  'health_apology',
  'health_welcome_followup',
  'seasonal_alert',
  'estimate_auto_renewed',
  'service_complete_concise',
  'service_report_v1_progress',
  'reschedule_options_weather',
  'reschedule_options_access',
  'reschedule_options_general',
  'referral_enrollment',
  'self_booking_confirmation',
];

// Rows whose sending workflow is retired but which gate still-live send
// paths via isTemplateActive — a missing row reads as ACTIVE and all three
// are disabled in prod, so deleting them would silently enable blocked
// texts (campaign upsell drafts, retention outreach, manual billing texts).
const EXPECTED_KILL_SWITCHES = [
  'waveguard_upsell',
  'health_retention_offer',
  'billing_reminder',
];

const EXPECTED_REACTIVATED = [
  'quote_wizard_booking_invite',
  'auto_new_recurring',
  'auto_bed_bug',
  'auto_cockroach',
];

function buildKnex({ fleaExists = false, bodyRows = [], variantRows = [] } = {}) {
  const state = {
    deletedTemplateKeys: [],
    deletedVariantKeys: [],
    updates: [],
    variantUpdates: [],
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
        where(criteria) {
          query.__where = criteria;
          return query;
        },
        select: jest.fn(async () => variantRows.map((r) => ({ ...r }))),
        update: jest.fn(async (data) => {
          state.variantUpdates.push({ where: query.__where, data });
          return 1;
        }),
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
      whereNot(criteria) {
        query.__whereNot = criteria;
        return query;
      },
      del: jest.fn(async () => {
        state.deletedTemplateKeys.push(...query.__keys);
        return query.__keys.length;
      }),
      update: jest.fn(async (data) => {
        state.updates.push({ keys: [...(query.__keys || [])], where: query.__where, data });
        return (query.__keys || []).length;
      }),
      first: jest.fn(async () => (fleaExists ? { id: 'existing-flea' } : null)),
      select: jest.fn(async () => bodyRows.map((r) => ({ ...r }))),
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
    // The kill-switch rows must never be in the delete set.
    for (const key of EXPECTED_KILL_SWITCHES) {
      expect(state.deletedTemplateKeys).not.toContain(key);
    }
  });

  test('kill-switch rows get a description update ONLY — is_active untouched, bucketed system', async () => {
    const { knex, state } = buildKnex();

    await migration.up(knex);

    for (const key of EXPECTED_KILL_SWITCHES) {
      const update = state.updates.find((u) => u.where?.template_key === key && 'description' in u.data);
      expect(update).toBeTruthy();
      // Description only — flipping is_active here would either enable a
      // blocked send path or pin the switch against the operator.
      expect(Object.keys(update.data).sort()).toEqual(['description', 'updated_at']);
      expect(update.data.description).toContain('KILL SWITCH');
    }
    const systemBucket = state.updates.find((u) => u.data.category === 'system');
    expect(systemBucket.keys).toEqual(expect.arrayContaining(EXPECTED_KILL_SWITCHES));
  });

  test('kill-switch rows are seeded DISABLED for fresh environments', () => {
    for (const key of EXPECTED_KILL_SWITCHES) {
      const seed = cleanTemplateSeed.TEMPLATES.find((t) => t.template_key === key);
      expect(seed).toBeTruthy();
      expect(seed.is_active).toBe(false);
      expect(seed.category).toBe('system');
    }
  });

  test('reactivates live-send templates without touching their bodies', async () => {
    const { knex, state } = buildKnex();

    await migration.up(knex);

    const reactivation = state.updates.find((u) => 'is_active' in u.data);
    expect(reactivation.keys).toEqual(EXPECTED_REACTIVATED);
    // Only the flag flips — admin-edited copy stays whatever it is.
    expect(Object.keys(reactivation.data).sort()).toEqual(['is_active', 'updated_at']);
    expect(reactivation.data.is_active).toBe(true);
  });

  test('recategorizes without overlaps and never touches a removed key', async () => {
    const { knex, state } = buildKnex();

    await migration.up(knex);

    const categoryUpdates = state.updates.filter((u) => 'category' in u.data);
    expect(categoryUpdates.length).toBeGreaterThan(0);
    const seen = new Set();
    for (const u of categoryUpdates) {
      // Category-only update — bodies and active flags untouched.
      expect(Object.keys(u.data).sort()).toEqual(['category', 'updated_at']);
      for (const key of u.keys) {
        expect(seen.has(key)).toBe(false); // one bucket per key
        seen.add(key);
        expect(EXPECTED_REMOVED).not.toContain(key);
      }
    }
    // Every retained seed template has a home in the new taxonomy.
    for (const template of cleanTemplateSeed.TEMPLATES) {
      if (template.category === 'custom') continue;
      expect(seen.has(template.template_key)).toBe(true);
    }
    // The seeded flea prep text is bucketed too.
    expect(seen.has('auto_flea')).toBe(true);
  });

  test('seeds auto_flea + deposit_receipt when missing and skips when present', async () => {
    const missing = buildKnex();
    await migration.up(missing.knex);
    expect(missing.state.inserted).toHaveLength(2);
    expect(missing.state.inserted[0]).toMatchObject({
      template_key: 'auto_flea',
      category: 'onboarding',
      is_active: true,
    });
    expect(missing.state.inserted[0].body).toContain('flea-free');
    expect(missing.state.inserted[0].body).not.toMatch(/\{service_date\}/);
    expect(missing.state.inserted[1]).toMatchObject({
      template_key: 'deposit_receipt',
      category: 'invoices',
      is_active: true,
    });
    expect(missing.state.inserted[1].body).toContain('deposit');

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

  test('normalizes copy: STOP notice on every body, no office phone, Hello greeting', async () => {
    const bodyRows = [
      { id: 'r1', template_key: 'autopay_charge_failed', body: 'Hello {first_name}! Update your card here: {update_card_url}\n\nQuestions or requests? Reply here or call (941) 297-5749.' },
      { id: 'r2', template_key: 'referral_invite', body: "Hi {referee_name}! Get a free quote here: {referral_link}\n\nQuestions? Call (941) 297-5749." },
      { id: 'r3', template_key: 'tech_arrived', body: 'Hello {first_name}! {tech_name} has arrived.\n\nReply here. Reply STOP to opt out.' },
    ];
    const { knex, state } = buildKnex({ bodyRows });

    await migration.up(knex);

    const bodyUpdates = state.updates.filter((u) => 'body' in u.data);
    const byWhere = Object.fromEntries(state.updates.filter((u) => 'body' in u.data).map((u) => [u.where?.id, u.data.body]));
    expect(byWhere.r1).toBe('Hello {first_name}! Update your card here: {update_card_url}\n\nQuestions or requests? Reply here.\n\nReply STOP to opt out.');
    expect(byWhere.r2).toBe('Hello {referee_name}! Get a free quote here: {referral_link}\n\nQuestions? Reply here.\n\nReply STOP to opt out.');
    // Already compliant — untouched.
    expect(byWhere.r3).toBeUndefined();
    for (const u of bodyUpdates) {
      expect(u.data.body).toMatch(/Reply STOP to opt out\./);
      expect(u.data.body).not.toMatch(/297-5749/);
    }
  });

  test('normalizes retained A/B variant bodies too', async () => {
    const variantRows = [
      { id: 'v1', body: 'Hello {first_name}! Short pitch. Reply here or call (941) 297-5749.' },
      { id: 'v2', body: 'Hello {first_name}! Already compliant. Reply STOP to opt out.' },
    ];
    const { knex, state } = buildKnex({ variantRows });

    await migration.up(knex);

    const byId = Object.fromEntries(state.variantUpdates.map((u) => [u.where?.id, u.data.body]));
    expect(byId.v1).toBe('Hello {first_name}! Short pitch. Reply here.\n\nReply STOP to opt out.');
    expect(byId.v2).toBeUndefined();
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
