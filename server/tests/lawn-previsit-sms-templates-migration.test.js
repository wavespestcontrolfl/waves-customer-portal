// The two lawn rows of the 24-hour reminder (GATE_LAWN_PREVISIT_LINE): the migration that seeds them, the template registry's required
// placeholder, and the rendered text. Synthetic data only.
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => ({})) }));

const migration = require('../models/migrations/20261114120000_lawn_previsit_sms_templates');
const { recordAuditEvent } = require('../services/audit-log');
const { detectEncoding, countSegments } = require('../services/messaging/segment-counter');
const { stripSmsUrlScheme } = require('../services/messaging/sms-link-policy');
const { REQUIRED_TEMPLATE_PLACEHOLDERS } = jest.requireActual('../routes/admin-sms-templates');
const { buildLawnPrevisitLine } = require('../services/lawn-previsit-line');

const { SMS_TEMPLATES } = migration._test;
const byKey = Object.fromEntries(SMS_TEMPLATES.map((t) => [t.key, t]));
const placeholders = (body) => [...String(body).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
const render = (body, vars) => stripSmsUrlScheme(body.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '')).replace(/\n{3,}/g, '\n\n').trim();

const VARS = {
  first_name: 'Maria', service_type: 'Every 6 Weeks Lawn Care Service', window: 'between 8:00 AM and 10:00 AM',
  lawn_prep_line: buildLawnPrevisitLine({ petsStructured: [{ name: 'Biscuit', type: 'dog' }] }),
  appointment_line: 'Everything about your visit: portal.wavespestcontrol.com/l/k3j9m2x7qp\n\n',
  card_hold_policy_line: '',
};

describe('the lawn 24-hour reminder rows', () => {
  test('the two keys and the approved bodies, word for word', () => {
    expect(SMS_TEMPLATES.map((t) => t.key)).toEqual(['reminder_24h_lawn_v2', 'reminder_24h_lawn']);
    expect(byKey.reminder_24h_lawn_v2.body).toBe('Hi {first_name}, your Waves {service_type} is tomorrow, {window}.\n\n{lawn_prep_line}\n\n{appointment_line}{card_hold_policy_line}');
    expect(byKey.reminder_24h_lawn.body).toBe("Hi {first_name}, your {service_type} with Waves is tomorrow, {window}. We'll text you when your tech is on the way.\n\n{lawn_prep_line}{card_hold_policy_line}");
  });

  test('both read right when rendered, with and without a card-hold line and a link', () => {
    expect(render(byKey.reminder_24h_lawn_v2.body, VARS)).toBe(
      `Hi Maria, your Waves Every 6 Weeks Lawn Care Service is tomorrow, between 8:00 AM and 10:00 AM.\n\n${VARS.lawn_prep_line}\n\nEverything about your visit: portal.wavespestcontrol.com/l/k3j9m2x7qp`,
    );
    expect(render(byKey.reminder_24h_lawn_v2.body, { ...VARS, appointment_line: '', card_hold_policy_line: '\n\nA card hold note.' })).toBe(
      `Hi Maria, your Waves Every 6 Weeks Lawn Care Service is tomorrow, between 8:00 AM and 10:00 AM.\n\n${VARS.lawn_prep_line}\n\nA card hold note.`,
    );
    expect(render(byKey.reminder_24h_lawn.body, VARS)).toBe(
      `Hi Maria, your Every 6 Weeks Lawn Care Service with Waves is tomorrow, between 8:00 AM and 10:00 AM. We'll text you when your tech is on the way.\n\n${VARS.lawn_prep_line}`,
    );
  });

  test.each(SMS_TEMPLATES.map((t) => [t.key, t]))('%s: GSM-7, "Waves" and never "Waves Pest Control", declared variables cover the body', (_key, t) => {
    expect(detectEncoding(t.body).encoding).toBe('GSM_7');
    expect(t.body).not.toMatch(/[–—‘’“”]/);
    expect(t.body).not.toMatch(/Waves Pest Control/);
    expect(t.body.match(/Waves/g)).toHaveLength(1);
    expect(placeholders(t.body).every((name) => t.variables.includes(name))).toBe(true);
    expect(t.variables.every((name) => placeholders(t.body).includes(name))).toBe(true);
  });

  test('the template registry requires {lawn_prep_line} in both rows', () => {
    for (const t of SMS_TEMPLATES) {
      expect(REQUIRED_TEMPLATE_PLACEHOLDERS[t.key]).toEqual(['lawn_prep_line']);
      expect(t.body).toContain('{lawn_prep_line}');
    }
  });

  test('the finished text with the pet link runs three segments, without it two (the 24h policy figure is advisory)', () => {
    const noPets = { ...VARS, lawn_prep_line: buildLawnPrevisitLine({ petsStructured: [] }) };
    expect(countSegments(render(byKey.reminder_24h_lawn_v2.body, noPets)).segmentCount).toBe(3);
    expect(countSegments(render(byKey.reminder_24h_lawn_v2.body, VARS)).segmentCount).toBe(2);
  });
});

// A knex-shaped fake: rows per table, inserts recorded, schema introspection.
function fakeKnex({ rows = {}, tables = ['sms_templates', 'audit_log'] } = {}) {
  const have = new Set(tables);
  const inserted = {};
  let n = 0;
  const knex = (table) => {
    const q = { filter: {} };
    q.where = (f) => { q.filter = f; return q; };
    q.first = async () => (rows[table] || []).find((r) => Object.entries(q.filter).every(([k, v]) => r[k] === v));
    q.insert = (row) => {
      (inserted[table] = inserted[table] || []).push(row);
      n += 1;
      const stored = { id: `${table}-${n}`, ...row };
      (rows[table] = rows[table] || []).push(stored);
      return { returning: async () => [stored] };
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => have.has(t) };
  knex.transaction = async (cb) => cb(knex);
  return { knex, inserted };
}

describe('the migration', () => {
  beforeEach(() => recordAuditEvent.mockClear());

  test('inserts both rows active beside their base rows, with one audit event each', async () => {
    const { knex, inserted } = fakeKnex({
      rows: { sms_templates: [{ template_key: 'reminder_24h', category: 'service', sort_order: 4 }, { template_key: 'reminder_24h_v2', category: 'service', sort_order: 5 }] },
    });
    await migration.up(knex);
    expect(inserted.sms_templates.map((r) => r.template_key)).toEqual(['reminder_24h_lawn_v2', 'reminder_24h_lawn']);
    const v2 = inserted.sms_templates[0];
    expect(v2).toMatchObject({ category: 'service', body: byKey.reminder_24h_lawn_v2.body, is_active: true, sort_order: 6 });
    expect(JSON.parse(v2.variables)).toEqual(byKey.reminder_24h_lawn_v2.variables);
    expect(inserted.sms_templates[1]).toMatchObject({ sort_order: 5, is_active: true });
    expect(recordAuditEvent).toHaveBeenCalledTimes(2);
    const action = recordAuditEvent.mock.calls[0][0];
    expect(action).toMatchObject({ action: 'sms_template.seeded', critical: true });
    expect(action.action.length).toBeLessThan(96);
  });

  test('idempotent: a row that exists (possibly edited or disabled) is left alone', async () => {
    const { knex, inserted } = fakeKnex({ rows: { sms_templates: SMS_TEMPLATES.map((t) => ({ template_key: t.key, body: 'edited', is_active: false })) } });
    await migration.up(knex);
    expect(inserted.sms_templates).toBeUndefined();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('no audit table: rows still seed, with no audit event; no sms_templates table: skipped', async () => {
    const noAudit = fakeKnex({ tables: ['sms_templates'] });
    await migration.up(noAudit.knex);
    expect(noAudit.inserted.sms_templates).toHaveLength(2);
    expect(recordAuditEvent).not.toHaveBeenCalled();
    const none = fakeKnex({ tables: [] });
    await expect(migration.up(none.knex)).resolves.toBeUndefined();
    expect(none.inserted).toEqual({});
  });

  test('down leaves the rows', async () => {
    await expect(migration.down()).resolves.toBeUndefined();
  });
});
