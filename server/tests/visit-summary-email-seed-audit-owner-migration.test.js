// 20260908000030 — retract the seed audit event 20260908000010 recorded for
// an administrator-created service.visit_summary template.
const mockRecordAuditEvent = jest.fn(async () => 'audit-new');
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockRecordAuditEvent(...a) }));
const migration = require('../models/migrations/20260908000030_visit_summary_email_seed_audit_owner');

function fakeKnex({ hasTable = true, template = { id: 't1', created_by: 'admin-1' }, seeded = [], retracted = false } = {}) {
  const knex = (table) => ({
    where: (cond) => ({
      first: async () => {
        if (table === 'email_templates') return template;
        expect(table).toBe('audit_log');
        expect(cond.action).toBe(migration.RETRACTION);
        return retracted ? { id: 'r1' } : undefined;
      },
      select: async () => {
        expect(table).toBe('audit_log');
        expect(cond).toMatchObject({ action: 'email_template.seeded', actor_type: 'system', resource_id: 't1' });
        return seeded;
      },
    }),
  });
  knex.schema = { hasTable: async () => hasTable };
  return knex;
}

beforeEach(() => mockRecordAuditEvent.mockClear());

test('an administrator-created template with the backfill event gets one retraction naming that event', async () => {
  await migration.up(fakeKnex({ seeded: [
    { id: 'a-admin', metadata: { migration: 'some_other_seed' } },
    { id: 'a-backfill', metadata: JSON.stringify({ migration: migration.BACKFILL }) },
  ] }));
  expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
  expect(mockRecordAuditEvent.mock.calls[0][0]).toMatchObject({
    actor_type: 'system', action: migration.RETRACTION, resource_type: 'email_template', resource_id: 't1', critical: true,
    metadata: expect.objectContaining({ retractsAuditId: 'a-backfill' }),
  });
});

test.each([
  ['a seed-created template keeps its event', { template: { id: 't1', created_by: null }, seeded: [{ id: 'a', metadata: { migration: migration.BACKFILL } }] }],
  ['no backfill event to retract', { seeded: [{ id: 'a', metadata: { migration: 'other' } }] }],
  ['already retracted', { seeded: [{ id: 'a', metadata: { migration: migration.BACKFILL } }], retracted: true }],
  ['no template', { template: undefined }],
  ['no audit table', { hasTable: false }],
])('up is a no-op when %s', async (_label, opts) => {
  await migration.up(fakeKnex(opts));
  expect(mockRecordAuditEvent).not.toHaveBeenCalled();
});
