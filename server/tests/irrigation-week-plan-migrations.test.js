/**
 * 20260828000003 (snapshot table) + 20260828000004 (weekly_plan template).
 * Pins: table shape (unique customer/week), and that every REQUIRED template
 * variable is referenced by the blocks or subject (the library rejects a
 * required variable nothing references), subject is the plan's.
 */
const table = require('../models/migrations/20260828000003_irrigation_week_plans');
const seed = require('../models/migrations/20260828000004_seed_irrigation_week_plan_email_template');

describe('irrigation_week_plans table', () => {
  test('creates once with a unique (customer_id, week_ending)', async () => {
    const cols = [];
    const builder = {
      uuid: (n) => { cols.push(n); return chain; }, date: (n) => { cols.push(n); return chain; }, string: (n) => { cols.push(n); return chain; },
      timestamp: (n) => { cols.push(n); return chain; }, jsonb: (n) => { cols.push(n); return chain; },
      unique: jest.fn(), index: jest.fn(),
    };
    const chain = { primary: () => chain, defaultTo: () => chain, notNullable: () => chain, references: () => chain, inTable: () => chain, onDelete: () => chain };
    const knex = { schema: { hasTable: jest.fn().mockResolvedValue(false), createTable: jest.fn(async (_n, cb) => cb(builder)) }, raw: (s) => s, fn: { now: () => 'now()' } };
    await table.up(knex);
    expect(knex.schema.createTable).toHaveBeenCalledWith('irrigation_week_plans', expect.any(Function));
    expect(cols).toEqual(expect.arrayContaining(['customer_id', 'week_ending', 'plan_as_of', 'weather_inputs', 'restriction_policy', 'week_plan', 'sent_at', 'decision_hash']));
    expect(builder.unique).toHaveBeenCalledWith(['customer_id', 'week_ending']);
    knex.schema.hasTable.mockResolvedValue(true);
    knex.schema.createTable.mockClear();
    await table.up(knex);
    expect(knex.schema.createTable).not.toHaveBeenCalled();
  });
});

describe('irrigation.weekly_plan template seed', () => {
  const { TEMPLATE, REQUIRED, OPTIONAL, templateRow } = seed.__private;
  const referenced = (blocks, subject) => {
    const text = `${subject} ${JSON.stringify(blocks)}`;
    return new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
  };

  test('every required variable is referenced; plan fields are required, notes optional', () => {
    const refs = referenced(TEMPLATE.blocks, TEMPLATE.subject);
    for (const v of REQUIRED) expect(refs.has(v)).toBe(true);
    expect(REQUIRED).toEqual(expect.arrayContaining(['plan_subject', 'plan_heading', 'week_plan', 'summary_line']));
    expect(OPTIONAL).toEqual(expect.arrayContaining(['plan_note', 'restriction_note', 'forecast_line']));
    expect(TEMPLATE.subject).toBe('{{plan_subject}}');
  });

  test('row: service_operational stream, lawn purpose, optional = allowed − required', () => {
    const row = templateRow(TEMPLATE);
    expect(row.template_key).toBe('irrigation.weekly_plan');
    expect(row.send_stream).toBe('service_operational');
    const allowed = JSON.parse(row.allowed_variables);
    const required = JSON.parse(row.required_variables);
    const optional = JSON.parse(row.optional_variables);
    expect(optional.every((v) => allowed.includes(v) && !required.includes(v))).toBe(true);
  });

  test('wording rules hold in the static blocks', () => {
    const text = JSON.stringify(TEMPLATE.blocks);
    expect(text).not.toMatch(/each zone\b/);
    expect(text).not.toMatch(/controller/i);
  });
});
