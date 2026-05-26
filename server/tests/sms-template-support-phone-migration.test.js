const migration = require('../models/migrations/20260527100003_repair_sms_template_support_phone');

function createKnex(rows) {
  const state = {
    rows: new Map(rows.map((row) => [row.template_key, { ...row }])),
    updates: [],
  };

  const knex = jest.fn((table) => {
    expect(table).toBe('sms_templates');
    const query = {
      criteria: null,
      columnInfo: jest.fn(async () => ({ updated_at: {} })),
      where(criteria) {
        query.criteria = criteria;
        return query;
      },
      async first() {
        return state.rows.get(query.criteria.template_key) || null;
      },
      async update(values) {
        const existing = state.rows.get(query.criteria.template_key);
        if (existing) {
          state.rows.set(query.criteria.template_key, { ...existing, ...values });
        }
        state.updates.push({ templateKey: query.criteria.template_key, values });
        return existing ? 1 : 0;
      },
    };
    return query;
  });

  knex.schema = {
    hasTable: jest.fn(async (table) => {
      expect(table).toBe('sms_templates');
      return true;
    }),
  };
  knex.__state = state;

  return knex;
}

describe('SMS template support phone migration', () => {
  test('replaces customer-support copy with the support phone', async () => {
    const knex = createKnex([
      {
        template_key: 'billing_reminder',
        body: 'Manage your payment method in the customer portal or call (941) 318-7612.',
      },
      {
        template_key: 'seasonal_alert',
        body: 'Questions or requests? Reply here or call (941) 318-7612.',
      },
    ]);

    await migration.up(knex);

    expect(knex.__state.rows.get('billing_reminder').body).toContain('(941) 297-5749');
    expect(knex.__state.rows.get('billing_reminder').body).not.toContain('(941) 318-7612');
    expect(knex.__state.rows.get('seasonal_alert').body).toContain('(941) 297-5749');
  });

  test('removes unused days_added variable from estimate_extended', async () => {
    const knex = createKnex([
      {
        template_key: 'estimate_extended',
        body: 'Hello {first_name}! We extended your estimate through {new_expiry}: {estimate_url}',
        variables: JSON.stringify(['first_name', 'estimate_url', 'new_expiry', 'days_added']),
      },
    ]);

    await migration.up(knex);

    expect(knex.__state.rows.get('estimate_extended').variables).toBe(
      JSON.stringify(['first_name', 'estimate_url', 'new_expiry'])
    );
  });
});
