/**
 * 20261112210000_job_receipt_matches_form: the application receipt texts stop
 * promising a reply "within 2 business days" (owner 2026-11-12). Runs up() /
 * down() against a small in-memory knex stand-in: compare-and-swap on the exact
 * "before" body, base row AND variant row, one audit event per changed row,
 * tracked-only revert.
 */
const mockAudit = [];
jest.mock('../services/audit-log', () => ({
  recordAuditEvent: jest.fn(async (event) => {
    mockAudit.push({ id: mockAudit.length + 1, action: event.action, resource_type: event.resource_type, resource_id: event.resource_id, metadata: event.metadata });
  }),
}));

const migration = require('../models/migrations/20261112210000_job_receipt_matches_form');

const { _SWAPS: SWAPS, _AUDIT_ACTION: AUDIT_ACTION, _AUDIT_ROLLBACK_ACTION: ROLLBACK_ACTION } = migration;
const BEFORE = Object.fromEntries(SWAPS.map(([key, before]) => [key, before]));
const AFTER = Object.fromEntries(SWAPS.map(([key, , after]) => [key, after]));
const KEYS = ['job_application_received', 'job_application_received_es'];

function matches(row, where) {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

function makeKnex(tables) {
  const knex = (name) => {
    const rows = tables[name];
    let filter = () => true;
    const q = {
      whereIn: (col, vals) => { const prev = filter; filter = (r) => prev(r) && vals.includes(r[col]); return q; },
      where: (where) => { const prev = filter; filter = (r) => prev(r) && matches(r, where); return q; },
      select: async () => rows.filter(filter).map((r) => ({ ...r })),
      update: async (patch) => {
        const hit = rows.filter(filter);
        hit.forEach((r) => Object.assign(r, patch));
        return hit.length;
      },
    };
    return q;
  };
  knex.schema = { hasTable: async (name) => Object.prototype.hasOwnProperty.call(tables, name) };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

function setup(extra = {}) {
  mockAudit.length = 0;
  const tables = {
    sms_templates: [
      { id: 't1', template_key: 'job_application_received', body: BEFORE.job_application_received },
      { id: 't2', template_key: 'job_application_received_es', body: BEFORE.job_application_received_es },
      { id: 't3', template_key: 'job_interview_invite', body: 'Hi {first_name}, Waves would like to interview you. Pick a phone or in-person time that works for you: {interview_url}' },
    ],
    sms_template_variants: [
      { id: 'v1', template_key: 'job_application_received', body: BEFORE.job_application_received },
      { id: 'v2', template_key: 'job_application_received', body: 'Adam wrote this variant by hand.' },
    ],
    audit_log: mockAudit,
    ...extra,
  };
  return { tables, knex: makeKnex(tables) };
}

describe('wording', () => {
  test('touches only the two receipt keys, from the Waves-named seeded body', () => {
    expect(SWAPS.map(([key]) => key)).toEqual(KEYS);
    expect(BEFORE.job_application_received).toBe('Hi {first_name}, thanks for applying to Waves. We read every application and will reach out within 2 business days. Reply STOP to opt out.');
    expect(BEFORE.job_application_received_es).toBe('Hola {first_name}, gracias por postularte a Waves. Revisamos cada solicitud y te contactaremos en un plazo de 2 dias habiles. Reply STOP to opt out.');
  });

  test('the new bodies are exactly the approved wording, no time promise, STOP line kept, "Waves" only', () => {
    expect(AFTER.job_application_received).toBe('Hi {first_name}, thanks for applying to Waves. Adam, the owner, reads every application himself and will call or text you directly if it looks like a fit. Reply STOP to opt out.');
    expect(AFTER.job_application_received_es).toBe('Hola {first_name}, gracias por postularte a Waves. Adam, el dueño, lee cada solicitud personalmente y te llamara o enviara un mensaje directamente si parece una buena opcion. Reply STOP to opt out.');
    for (const key of KEYS) {
      expect(AFTER[key]).not.toMatch(/business days|dias habiles|días hábiles/i);
      expect(AFTER[key]).not.toMatch(/Waves Pest Control/);
      expect(AFTER[key]).toMatch(/ Reply STOP to opt out\.$/);
      expect(AFTER[key].match(/\{[a-z_]+\}/g)).toEqual(['{first_name}']);
    }
  });

  test('the audit actions fit audit_log.action (varchar 96)', () => {
    expect(AUDIT_ACTION.length).toBeLessThanOrEqual(96);
    expect(ROLLBACK_ACTION.length).toBeLessThanOrEqual(96);
  });
});

describe('up() / down()', () => {
  test('swaps the base rows and the matching variant, audits each changed row, leaves the rest', async () => {
    const { tables, knex } = setup();
    await migration.up(knex);
    expect(tables.sms_templates.map((r) => r.body).slice(0, 2)).toEqual([AFTER.job_application_received, AFTER.job_application_received_es]);
    expect(tables.sms_templates[2].body).toMatch(/would like to interview you/);
    expect(tables.sms_template_variants[0].body).toBe(AFTER.job_application_received);
    expect(tables.sms_template_variants[1].body).toBe('Adam wrote this variant by hand.');
    expect(mockAudit.map((a) => `${a.action}:${a.resource_type}:${a.resource_id}`).sort()).toEqual([
      `${AUDIT_ACTION}:sms_template_variants:v1`, `${AUDIT_ACTION}:sms_templates:t1`, `${AUDIT_ACTION}:sms_templates:t2`,
    ].sort());
  });

  test('a body an admin already edited is left alone and never audited', async () => {
    const { tables, knex } = setup();
    tables.sms_templates[0].body = 'Hi {first_name}, the office rewrote this. Reply STOP to opt out.';
    await migration.up(knex);
    expect(tables.sms_templates[0].body).toBe('Hi {first_name}, the office rewrote this. Reply STOP to opt out.');
    expect(tables.sms_templates[1].body).toBe(AFTER.job_application_received_es);
    expect(mockAudit.map((a) => a.resource_id).sort()).toEqual(['t2', 'v1']);
  });

  test('a second run changes nothing (the new body is not the before body)', async () => {
    const { knex } = setup();
    await migration.up(knex);
    const first = mockAudit.length;
    await migration.up(knex);
    expect(mockAudit).toHaveLength(first);
  });

  test('down() restores only tracked rows that still carry the new body', async () => {
    const { tables, knex } = setup();
    await migration.up(knex);
    tables.sms_templates[1].body = 'Edited by the office after the swap.';
    await migration.down(knex);
    expect(tables.sms_templates[0].body).toBe(BEFORE.job_application_received);
    expect(tables.sms_templates[1].body).toBe('Edited by the office after the swap.');
    expect(tables.sms_template_variants[0].body).toBe(BEFORE.job_application_received);
    expect(tables.sms_template_variants[1].body).toBe('Adam wrote this variant by hand.');
    expect(mockAudit.filter((a) => a.action === ROLLBACK_ACTION).map((a) => a.resource_id).sort()).toEqual(['t1', 'v1']);
  });

  test('down() with nothing tracked changes no row', async () => {
    const { tables, knex } = setup();
    tables.sms_templates[0].body = AFTER.job_application_received; // set by hand, never tracked
    await migration.down(knex);
    expect(tables.sms_templates[0].body).toBe(AFTER.job_application_received);
    expect(mockAudit).toHaveLength(0);
  });
});
