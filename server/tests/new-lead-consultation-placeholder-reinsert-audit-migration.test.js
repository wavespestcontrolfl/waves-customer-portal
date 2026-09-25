const mockRecord = jest.fn(async () => ({}));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockRecord(...a) }));
const migration = require('../models/migrations/20260924030101_new_lead_consultation_placeholder_reinsert_audit');

function makeKnex({ steps = [], recorded = null, hasAudit = true } = {}) {
  const knex = jest.fn((table) => {
    const q = {
      where: jest.fn(() => q), whereRaw: jest.fn(() => q),
      select: jest.fn(async () => (table === 'automation_steps' ? steps : [])),
      first: jest.fn(async () => (table === 'audit_log' ? recorded : null)),
    };
    return q;
  });
  knex.schema = { hasTable: jest.fn(async (t) => (t === 'audit_log' ? hasAudit : true)) };
  return knex;
}

const PATCHED = { id: 's0', html_body: "x\n{{consultation_booking}}\n<h2>What's next</h2>", text_body: '{{consultation_booking_text}}\nReply' };

describe('re-insert audit migration', () => {
  beforeEach(() => mockRecord.mockClear());
  test('records one system event for a patched step 0', async () => {
    await migration.up(makeKnex({ steps: [PATCHED] }));
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0]).toMatchObject({
      actor_type: 'system', action: 'automation_step.patched', resource_type: 'automation_step', resource_id: 's0', critical: true,
      metadata: { migration: '20260924030100_new_lead_consultation_placeholder_reinsert', stepOrder: 0 },
    });
  });
  test('silent when already recorded', async () => {
    await migration.up(makeKnex({ steps: [PATCHED], recorded: { id: 'a1' } }));
    expect(mockRecord).not.toHaveBeenCalled();
  });
  test('silent when step 0 carries no placeholder (patch never applied)', async () => {
    await migration.up(makeKnex({ steps: [{ id: 's0', html_body: '<p>plain</p>', text_body: 'plain' }] }));
    expect(mockRecord).not.toHaveBeenCalled();
  });
  test('no audit_log table → no-op; down is a no-op', async () => {
    await migration.up(makeKnex({ steps: [PATCHED], hasAudit: false }));
    expect(mockRecord).not.toHaveBeenCalled();
    await expect(migration.down()).resolves.toBeUndefined();
  });
});
