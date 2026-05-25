const migration = require('../models/migrations/20260526000019_remove_lead_auto_reply_menu_prompt');

const TEMPLATE_KEY = 'lead_auto_reply_biz';
const MENU_BODY =
  "Hello {first_name}! Thanks for reaching out to Waves!\n\nWhat are you interested in: Pest Control, Lawn Care, or a One-Time Service?\n\nReply and we'll get you a quote.";
const NEW_BODY =
  'Hello {first_name}! Waves here! We received your quote request. A specialist will be calling soon. Thank you!';

function createKnex(initialRow) {
  const state = {
    row: initialRow ? { ...initialRow } : null,
    inserted: null,
    updates: [],
  };
  const columnInfo = jest.fn(async () => ({
    template_key: {},
    name: {},
    category: {},
    body: {},
    variables: {},
    is_active: {},
    sort_order: {},
    created_at: {},
    updated_at: {},
  }));

  const knex = jest.fn((table) => {
    expect(table).toBe('sms_templates');
    const query = {
      columnInfo,
      where(criteria) {
        query.criteria = criteria;
        return query;
      },
      async first() {
        expect(query.criteria).toEqual({ template_key: TEMPLATE_KEY });
        return state.row;
      },
      async update(values) {
        expect(query.criteria).toEqual({ template_key: TEMPLATE_KEY });
        state.updates.push(values);
        state.row = { ...state.row, ...values };
        return 1;
      },
      async insert(values) {
        state.inserted = values;
        state.row = { ...values };
        return [values];
      },
    };
    return query;
  });

  knex.schema = {
    hasTable: jest.fn(async () => true),
  };
  knex.__state = state;

  return knex;
}

describe('lead auto reply template migration', () => {
  test('replaces the menu prompt with the quote request acknowledgment', async () => {
    const knex = createKnex({
      template_key: TEMPLATE_KEY,
      body: MENU_BODY,
    });

    await migration.up(knex);

    expect(knex.__state.row.body).toBe(NEW_BODY);
    expect(knex.__state.row.variables).toBe(JSON.stringify(['first_name']));
    expect(knex.__state.updates[0]).not.toHaveProperty('is_active');
  });

  test('preserves disabled kill-switch state while replacing legacy copy', async () => {
    const knex = createKnex({
      template_key: TEMPLATE_KEY,
      body: MENU_BODY,
      is_active: false,
    });

    await migration.up(knex);

    expect(knex.__state.row.body).toBe(NEW_BODY);
    expect(knex.__state.row.is_active).toBe(false);
    expect(knex.__state.updates[0]).not.toHaveProperty('is_active');
  });

  test('leaves already-customized lead auto replies alone', async () => {
    const customBody = 'Hello {first_name}! We have your request and will call soon.';
    const knex = createKnex({
      template_key: TEMPLATE_KEY,
      body: customBody,
    });

    await migration.up(knex);

    expect(knex.__state.row.body).toBe(customBody);
    expect(knex.__state.updates).toHaveLength(0);
  });

  test('inserts the required template if it is missing', async () => {
    const knex = createKnex(null);

    await migration.up(knex);

    expect(knex.__state.inserted).toMatchObject({
      template_key: TEMPLATE_KEY,
      body: NEW_BODY,
      name: 'Lead Auto-Reply (Business Hours)',
      category: 'estimates',
      is_active: true,
    });
  });
});
