// 20260928040000 — records the 'AI Assistant Referrals' lead_sources seed
// (20260928030000, already deployed/frozen) in audit_log. Codex pre-push
// P1-b: a migration that seeds a row must write an audit event when an
// audit table exists (waves-db skill); this SEPARATE migration appends the
// event 20260928030000 should have written, without editing that file.

const mockRecordAuditEvent = jest.fn(async () => 'audit-new');
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockRecordAuditEvent(...a) }));
const migration = require('../models/migrations/20260928040000_ai_assistant_lead_source_audit');

function fakeKnex({
  hasLeadSources = true,
  hasAuditLog = true,
  seedRow = { id: 'ls-ai-1', name: 'AI Assistant Referrals' },
  existingAuditRow = null,
} = {}) {
  const knex = (table) => ({
    where: (cond) => ({
      first: async (...cols) => {
        if (table === 'lead_sources') {
          expect(cond).toEqual({ source_type: 'ai_assistant' });
          expect(cols).toEqual(['id', 'name']);
          return seedRow;
        }
        expect(table).toBe('audit_log');
        expect(cond).toMatchObject({ action: 'lead_sources.seeded', resource_type: 'lead_sources' });
        return existingAuditRow;
      },
    }),
  });
  knex.schema = {
    hasTable: async (name) => {
      if (name === 'lead_sources') return hasLeadSources;
      if (name === 'audit_log') return hasAuditLog;
      return false;
    },
  };
  return knex;
}

beforeEach(() => mockRecordAuditEvent.mockClear());

describe('migration 20260928040000 — ai_assistant lead_sources seed audit', () => {
  test('records the seed as a system audit event when the row exists and no event does yet', async () => {
    await migration.up(fakeKnex({ seedRow: { id: 'ls-ai-1', name: 'AI Assistant Referrals' } }));
    expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordAuditEvent.mock.calls[0][0]).toMatchObject({
      actor_type: 'system',
      action: migration.ACTION,
      resource_type: 'lead_sources',
      resource_id: 'ls-ai-1',
      critical: true,
      metadata: expect.objectContaining({
        source_type: 'ai_assistant',
        name: 'AI Assistant Referrals',
        seededBy: '20260928030000_ai_assistant_lead_source',
      }),
    });
  });

  test('idempotent — no second write when an audit event already exists for the row', async () => {
    await migration.up(fakeKnex({ existingAuditRow: { id: 'evt-1' } }));
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  test('no-op when the seed row does not exist yet (never fabricates one)', async () => {
    // null, not undefined — a default-parameter value only applies on
    // undefined, and this test needs the override to actually take.
    await migration.up(fakeKnex({ seedRow: null }));
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  test.each([
    ['lead_sources table absent', { hasLeadSources: false }],
    ['audit_log table absent', { hasAuditLog: false }],
  ])('no-op when %s', async (_label, opts) => {
    await migration.up(fakeKnex(opts));
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  test('down() is a documented no-op — audit history is append-only', async () => {
    await expect(migration.down()).resolves.toBeUndefined();
  });
});
