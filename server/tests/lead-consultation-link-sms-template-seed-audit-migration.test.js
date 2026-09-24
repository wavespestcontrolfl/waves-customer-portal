// 20260924000003 — records the sms_template.seeded audit event for
// lead_consultation_link that 20260923000020 never recorded (that migration
// already ran on the PR's preview branch by the time the audit-event fix was
// written, so it had to ship as this new file instead — waves-db skill §4).
// Same pattern as 20260908000010_visit_summary_email_seed_audit.
const mockRecordAuditEvent = jest.fn(async () => 'audit-new');
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...args) => mockRecordAuditEvent(...args) }));

const migration = require('../models/migrations/20260924000003_lead_consultation_link_sms_template_seed_audit');

function fakeKnex({ hasAuditLog = true, template = { id: 't-1' }, alreadyRecorded = null } = {}) {
  const knex = jest.fn((table) => {
    if (table === 'sms_templates') {
      return {
        where: jest.fn((cond) => {
          expect(cond).toEqual({ template_key: 'lead_consultation_link' });
          return { first: jest.fn(async () => template) };
        }),
      };
    }
    expect(table).toBe('audit_log');
    return {
      where: jest.fn((cond) => {
        expect(cond).toEqual({ action: 'sms_template.seeded', resource_type: 'sms_template', resource_id: template.id });
        return { first: jest.fn(async () => alreadyRecorded) };
      }),
    };
  });
  knex.schema = { hasTable: jest.fn(async (table) => (table === 'audit_log' ? hasAuditLog : true)) };
  return knex;
}

beforeEach(() => {
  mockRecordAuditEvent.mockClear();
});

test('records sms_template.seeded once for the existing template with no prior audit row', async () => {
  const knex = fakeKnex();
  await migration.up(knex);
  expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
  expect(mockRecordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
    actor_type: 'system',
    action: 'sms_template.seeded',
    resource_type: 'sms_template',
    resource_id: 't-1',
    metadata: expect.objectContaining({
      templateKey: 'lead_consultation_link',
      migration: '20260924000003_lead_consultation_link_sms_template_seed_audit',
    }),
    trx: knex,
    critical: true,
  }));
});

test('is idempotent — an already-recorded audit row is never duplicated', async () => {
  const knex = fakeKnex({ alreadyRecorded: { id: 'a-existing' } });
  await migration.up(knex);
  expect(mockRecordAuditEvent).not.toHaveBeenCalled();
});

test('no-ops when the template row does not exist (never seeded, or a different environment)', async () => {
  // null, not undefined — a destructured default only applies to undefined,
  // and this must exercise the real "no row" branch.
  const knex = fakeKnex({ template: null });
  await migration.up(knex);
  expect(mockRecordAuditEvent).not.toHaveBeenCalled();
});

test('no-ops when audit_log does not exist — the template query never runs', async () => {
  const knex = fakeKnex({ hasAuditLog: false });
  await migration.up(knex);
  expect(knex).not.toHaveBeenCalled();
  expect(mockRecordAuditEvent).not.toHaveBeenCalled();
});

test('down() is a documented no-op — audit history is append-only', async () => {
  await expect(migration.down()).resolves.toBeUndefined();
  expect(mockRecordAuditEvent).not.toHaveBeenCalled();
});
