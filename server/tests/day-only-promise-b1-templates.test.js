// GATE_DAY_ONLY_PROMISE part B1: the migration that adds the day-only text and email rows and the customer_asked_time
// column, the template registry's required placeholders for them, and the day-only reschedule line. Synthetic data only.
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => ({})) }));

const migration = require('../models/migrations/20261106120000_day_only_promise_templates');
const { recordAuditEvent } = require('../services/audit-log');
const { dayOnlyLineFor, smsLineFor } = require('../services/reschedule-link');
const { detectEncoding, countSegments } = require('../services/messaging/segment-counter');
const { normalizeGsmPunctuation } = require('../services/messaging/gsm-normalize');
const { stripSmsUrlScheme } = require('../services/messaging/sms-link-policy');
const { REQUIRED_TEMPLATE_PLACEHOLDERS } = jest.requireActual('../routes/admin-sms-templates');

const { SMS_TEMPLATES, EMAIL_TEMPLATES } = migration._test;
const byKey = Object.fromEntries(SMS_TEMPLATES.map((t) => [t.key, t]));
const placeholders = (body) => [...String(body).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
const LINK = 'https://portal.wavespestcontrol.com/l/k3j9m2x7qp';
const render = (body, vars) => normalizeGsmPunctuation(stripSmsUrlScheme(
  body.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? ''),
)).replace(/\n{3,}/g, '\n\n').trim();

const VARS = {
  first_name: 'Maria', service_type: 'Quarterly Pest Control Service', day: 'Monday', date: 'November 9',
  reschedule_line: dayOnlyLineFor(LINK), card_hold_policy_line: '', appointment_line: 'See your visit: portal.wavespestcontrol.com/a/abc123',
};

describe('the day-only text rows', () => {
  test('the four keys, and the owner-approved 72-hour wording renders exactly', () => {
    expect(SMS_TEMPLATES.map((t) => t.key)).toEqual([
      'appointment_confirmation_day_v2', 'appointment_confirmation_day_v1', 'reminder_72h_day_v1', 'reminder_72h_no_reply_day_v1',
    ]);
    expect(render(byKey.reminder_72h_day_v1.body, VARS)).toBe(
      `Hi Maria, your Waves Quarterly Pest Control Service is Monday, November 9. We'll text your arrival window the day before.\n\nNeed a different day or a set time? portal.wavespestcontrol.com/l/k3j9m2x7qp`,
    );
  });

  test('the spec bodies, word for word', () => {
    expect(byKey.appointment_confirmation_day_v2.body).toBe("Hi {first_name}, your Waves {service_type} is booked for {day}, {date}. We'll text your arrival window the day before.\n\n{appointment_line}");
    expect(byKey.appointment_confirmation_day_v1.body).toBe("Hi {first_name}, your Waves {service_type} is booked for {day}, {date}. We'll text your arrival window the day before.\n\n{reschedule_line}");
    expect(byKey.reminder_72h_day_v1.body).toBe("Hi {first_name}, your Waves {service_type} is {day}, {date}. We'll text your arrival window the day before.\n\n{reschedule_line}{card_hold_policy_line}");
    expect(byKey.reminder_72h_no_reply_day_v1.body).toBe("Hi {first_name}, we didn't hear back, so we scheduled your Waves {service_type} for {day}, {date}. We'll text your arrival window the day before.\n\n{reschedule_line}{card_hold_policy_line}");
  });

  test.each(SMS_TEMPLATES.map((t) => [t.key, t]))('%s: no hour var, GSM-7, "Waves" once and never "Waves Pest Control", declared variables cover the body', (_key, t) => {
    expect(placeholders(t.body)).not.toContain('window');
    expect(placeholders(t.body)).not.toContain('time');
    expect(t.variables).not.toContain('window');
    expect(t.variables).not.toContain('time');
    expect(detectEncoding(t.body).encoding).toBe('GSM_7');
    expect(t.body).not.toMatch(/[–—‘’“”]/);
    expect(t.body).not.toMatch(/Waves Pest Control/);
    expect(t.body.match(/Waves/g)).toHaveLength(1);
    expect(placeholders(t.body).every((name) => t.variables.includes(name))).toBe(true);
    expect(countSegments(render(t.body, VARS)).segmentCount).toBeLessThanOrEqual(2);
  });

  test('the template registry requires the day and the date, never the window', () => {
    for (const t of SMS_TEMPLATES) {
      const required = REQUIRED_TEMPLATE_PLACEHOLDERS[t.key];
      expect(required).toEqual(['date', 'day']);
      expect(required).not.toContain('window');
      expect(required.every((name) => t.body.includes(`{${name}}`))).toBe(true);
    }
  });
});

describe('dayOnlyLineFor', () => {
  test('a link: the ask, then the link, then a blank line; no link: how to reach someone', () => {
    expect(dayOnlyLineFor(LINK)).toBe(`Need a different day or a set time? ${LINK}\n\n`);
    expect(dayOnlyLineFor(null)).toBe('Need a different day or a set time? Reply here or call.\n\n');
    expect(dayOnlyLineFor('')).toBe('Need a different day or a set time? Reply here or call.\n\n');
  });

  test('today\'s line is unchanged', () => {
    expect(smsLineFor(LINK)).toBe(`Reschedule here: ${LINK}\n\n`);
    expect(smsLineFor(null)).toBe('');
  });
});

// A knex-shaped fake: rows per table, inserts recorded, schema introspection.
function fakeKnex({ rows = {}, tables, columns = {} } = {}) {
  const have = new Set(tables || ['sms_templates', 'email_templates', 'email_template_versions', 'email_template_fixtures', 'audit_log', 'scheduled_services']);
  const inserted = {};
  const added = [];
  const raws = [];
  let n = 0;
  const knex = (table) => {
    const q = { filter: {} };
    q.where = (f) => { q.filter = f; return q; };
    q.first = async () => (rows[table] || []).find((r) => Object.entries(q.filter).every(([k, v]) => r[k] === v));
    q.update = async () => 1;
    q.insert = (row) => {
      (inserted[table] = inserted[table] || []).push(row);
      n += 1;
      const stored = { id: `${table}-${n}`, version_number: 1, ...row };
      (rows[table] = rows[table] || []).push(stored);
      return { returning: async () => [stored] };
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => have.has(t),
    hasColumn: async (t, c) => (columns[t] || []).includes(c),
    alterTable: async (t, fn) => { fn({ boolean: (name) => { added.push([t, name]); return { nullable: () => {} }; } }); },
  };
  knex.raw = async (sql) => { raws.push(sql); };
  knex.transaction = async (cb) => cb(knex);
  return { knex, inserted, added, raws, rows };
}

describe('the migration', () => {
  beforeEach(() => recordAuditEvent.mockClear());

  test('inserts the four active text rows beside their base rows, the two email templates with a version and a fixture, and adds the column', async () => {
    const { knex, inserted, added, raws } = fakeKnex({
      rows: { sms_templates: [{ template_key: 'reminder_72h', category: 'service', sort_order: 2 }, { template_key: 'appointment_confirmation', category: 'service', sort_order: 5 }] },
    });
    await migration.up(knex);
    expect(inserted.sms_templates.map((r) => r.template_key)).toEqual(SMS_TEMPLATES.map((t) => t.key));
    const r72 = inserted.sms_templates.find((r) => r.template_key === 'reminder_72h_day_v1');
    expect(r72).toMatchObject({ category: 'service', body: byKey.reminder_72h_day_v1.body, is_active: true, sort_order: 3 });
    expect(JSON.parse(r72.variables)).toEqual(byKey.reminder_72h_day_v1.variables);
    expect(inserted.email_templates.map((r) => r.template_key)).toEqual(['appointment.confirmation_day', 'appointment.reminder_72h_day']);
    expect(inserted.email_templates.every((r) => r.status === 'active' && r.send_stream === 'transactional_required')).toBe(true);
    expect(inserted.email_template_versions).toHaveLength(2);
    expect(inserted.email_template_fixtures).toHaveLength(2);
    expect(added).toEqual([['scheduled_services', 'customer_asked_time']]);
    expect(raws.join(' ')).toMatch(/COMMENT ON COLUMN scheduled_services\.customer_asked_time/);
    expect(recordAuditEvent).toHaveBeenCalledTimes(6);
    expect(recordAuditEvent.mock.calls[0][0]).toMatchObject({ action: 'sms_template.seeded', critical: true });
  });

  test('idempotent: rows that exist (possibly edited or disabled) are left alone, and so is an existing column', async () => {
    const existing = [...SMS_TEMPLATES.map((t) => ({ template_key: t.key, body: 'edited', is_active: false }))];
    const { knex, inserted, added } = fakeKnex({
      rows: { sms_templates: existing, email_templates: EMAIL_TEMPLATES.map((t) => ({ template_key: t.key })) },
      columns: { scheduled_services: ['customer_asked_time'] },
    });
    await migration.up(knex);
    expect(inserted.sms_templates).toBeUndefined();
    expect(inserted.email_templates).toBeUndefined();
    expect(added).toEqual([]);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('missing tables are skipped without error', async () => {
    const { knex, inserted } = fakeKnex({ tables: [] });
    await expect(migration.up(knex)).resolves.toBeUndefined();
    expect(inserted).toEqual({});
  });

  test('down drops only the column; the template rows stay', async () => {
    const calls = [];
    const { knex } = fakeKnex({ columns: { scheduled_services: ['customer_asked_time'] } });
    knex.schema.alterTable = async (t, fn) => { fn({ dropColumn: (c) => calls.push([t, c]) }); };
    await migration.down(knex);
    expect(calls).toEqual([['scheduled_services', 'customer_asked_time']]);
  });

  test('the column is a nullable boolean with no default: NULL means not recorded', () => {
    const src = require('fs').readFileSync(require.resolve('../models/migrations/20261106120000_day_only_promise_templates'), 'utf8');
    expect(src).toMatch(/t\.boolean\(COLUMN\)\.nullable\(\)/);
    expect(src).not.toMatch(/defaultTo/);
  });
});
