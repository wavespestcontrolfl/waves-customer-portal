const mockRecordAuditEvent = jest.fn(async () => 'audit-1');
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...args) => mockRecordAuditEvent(...args) }));

const migration = require('../models/migrations/20260923000020_lead_consultation_link_sms_template');

describe('lead consultation-link SMS template migration', () => {
  function makeKnex({ existing = null, hasAuditLog = true } = {}) {
    const calls = { inserted: null };
    const query = {
      where: jest.fn(() => query),
      first: jest.fn(async () => existing),
      insert: jest.fn((row) => {
        calls.inserted = row;
        return { returning: jest.fn(async () => [{ id: 't-new' }]) };
      }),
      del: jest.fn(async () => 1),
    };
    const knex = jest.fn((table) => {
      expect(table).toBe('sms_templates');
      return query;
    });
    knex.schema = { hasTable: jest.fn(async (table) => (table === 'audit_log' ? hasAuditLog : true)) };
    return { knex, query, calls };
  }

  beforeEach(() => {
    mockRecordAuditEvent.mockClear();
  });

  test('seeds the template active, in the leads category, with the consultation link slot', async () => {
    const { knex, calls } = makeKnex();
    await migration.up(knex);

    expect(calls.inserted).toEqual(expect.objectContaining({
      template_key: 'lead_consultation_link',
      category: 'leads',
      is_active: true,
      variables: JSON.stringify(['first_name', 'consultation_url']),
    }));
    expect(calls.inserted.body).toContain('{first_name}');
    expect(calls.inserted.body).toContain('{consultation_url}');
    // Compliance shape: sender is "Waves" (never "Waves Pest Control" or a
    // person's name), and this is a first text to a not-yet-customer lead —
    // docs/sms-stop-line-policy.md test 2 keeps the disclosure.
    expect(calls.inserted.body).toMatch(/it's Waves\./);
    expect(calls.inserted.body).not.toMatch(/Waves Pest Control/);
    expect(calls.inserted.body).toMatch(/Reply STOP to opt out\./);
  });

  test('records a sms_template.seeded audit event for the newly inserted row', async () => {
    const { knex } = makeKnex();
    await migration.up(knex);

    expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actor_type: 'system',
      action: 'sms_template.seeded',
      resource_type: 'sms_template',
      resource_id: 't-new',
      metadata: expect.objectContaining({
        templateKey: 'lead_consultation_link',
        migration: '20260923000020_lead_consultation_link_sms_template',
      }),
      trx: knex,
      critical: true,
    }));
  });

  test('no audit event when audit_log does not exist yet', async () => {
    const { knex } = makeKnex({ hasAuditLog: false });
    await migration.up(knex);
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  test('is idempotent — an existing row is never re-inserted or overwritten, and no audit event fires', async () => {
    const { knex, query, calls } = makeKnex({ existing: { id: 't-1' } });
    await migration.up(knex);
    expect(calls.inserted).toBeNull();
    expect(query.insert).not.toHaveBeenCalled();
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  test('no-ops when sms_templates does not exist yet', async () => {
    const { knex } = makeKnex();
    knex.schema.hasTable = jest.fn(async () => false);
    await migration.up(knex);
    expect(knex).not.toHaveBeenCalled();
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  test('down() is a documented no-op — never deletes the (possibly admin-edited) row', async () => {
    const { knex, query } = makeKnex({ existing: { id: 't-1' } });
    await migration.down(knex);
    expect(query.del).not.toHaveBeenCalled();
  });
});
