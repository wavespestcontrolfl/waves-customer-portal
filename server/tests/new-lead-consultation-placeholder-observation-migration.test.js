const mockRecord = jest.fn(async () => ({}));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockRecord(...a) }));
const migration = require('../models/migrations/20260924030102_new_lead_consultation_placeholder_observation');

function makeKnex({ inferred = [], done = null, step = null } = {}) {
  const knex = jest.fn((table) => {
    const q = {
      where: jest.fn(() => q), whereRaw: jest.fn(() => q),
      select: jest.fn(async () => (table === 'audit_log' ? inferred : [])),
      first: jest.fn(async () => (table === 'audit_log' ? done : step)),
    };
    return q;
  });
  knex.schema = { hasTable: jest.fn(async () => true) };
  return knex;
}

describe('placeholder observation migration (corrects 030101)', () => {
  beforeEach(() => mockRecord.mockClear());
  test('records one correcting observation per inferred event with true per-column presence', async () => {
    await migration.up(makeKnex({
      inferred: [{ id: 'a1', resource_id: 's0' }],
      step: { html_body: "x\n{{consultation_booking}}\n<h2>What's next</h2>", text_body: 'no text placeholder here' },
    }));
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0]).toMatchObject({
      action: 'automation_step.placeholder_observed', resource_id: 's0', actor_type: 'system', critical: true,
      metadata: { corrects: 'a1', html_placeholder_present: true, text_placeholder_present: false },
    });
    expect(mockRecord.mock.calls[0][0].metadata.note).toMatch(/not proof/);
  });
  test('idempotent — already corrected → silent', async () => {
    await migration.up(makeKnex({ inferred: [{ id: 'a1', resource_id: 's0' }], done: { id: 'o1' } }));
    expect(mockRecord).not.toHaveBeenCalled();
  });
  test('no inferred events → silent; down no-op', async () => {
    await migration.up(makeKnex());
    expect(mockRecord).not.toHaveBeenCalled();
    await expect(migration.down()).resolves.toBeUndefined();
  });
});
