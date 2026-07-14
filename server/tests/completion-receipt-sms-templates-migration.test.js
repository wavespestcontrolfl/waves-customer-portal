const migration = require('../models/migrations/20260714100010_completion_receipt_sms_templates');

function buildKnex({ paymentFailedRow = null } = {}) {
  const state = { upserted: [], updates: [], deleted: [] };
  const knex = jest.fn((table) => {
    expect(table).toBe('sms_templates');
    const query = {
      insert: jest.fn((row) => {
        query.__inserted = row;
        return query;
      }),
      onConflict: jest.fn((col) => {
        expect(col).toBe('template_key');
        return query;
      }),
      merge: jest.fn(async (row) => {
        state.upserted.push({ ...query.__inserted, ...row });
      }),
      where: jest.fn((criteria) => {
        query.__where = criteria;
        return query;
      }),
      first: jest.fn(async () => (query.__where?.template_key === 'payment_failed' ? paymentFailedRow : null)),
      update: jest.fn(async (patch) => {
        state.updates.push({ where: query.__where, patch });
      }),
      del: jest.fn(async () => {
        state.deleted.push(query.__where);
        return 1;
      }),
    };
    return query;
  });
  knex.schema = { hasTable: jest.fn(async () => true) };
  return { knex, state };
}

describe('completion receipt/decline SMS templates migration', () => {
  test('seeds the combined report+receipt template INACTIVE (owner flips after copy review)', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);

    const row = state.upserted.find((r) => r.template_key === 'service_complete_paid_receipt');
    expect(row).toBeTruthy();
    // The whole point of the dark seed: dispatch only combines when the row
    // is active, so shipping this migration changes NOTHING until the owner
    // reviews the copy and enables it.
    expect(row.is_active).toBe(false);
    expect(JSON.parse(row.variables)).toEqual([
      'first_name', 'service_type', 'portal_url', 'amount', 'card_line', 'receipt_url',
    ]);
    // Copy contract: one text = report link + receipt facts + opt-out line.
    expect(row.body).toContain('{portal_url}');
    expect(row.body).toContain('${amount}{card_line}');
    expect(row.body).toContain('Receipt: {receipt_url}');
    expect(row.body).toContain('Reply STOP to opt out');
  });

  test('widens payment_failed allowed variables without touching its body', async () => {
    const { knex, state } = buildKnex({
      paymentFailedRow: {
        template_key: 'payment_failed',
        body: 'OWNER COPY — MUST NOT CHANGE',
        variables: JSON.stringify(['first_name', 'service_type', 'service_date', 'pay_url']),
      },
    });
    await migration.up(knex);

    const update = state.updates.find((u) => u.where?.template_key === 'payment_failed');
    expect(update).toBeTruthy();
    expect(JSON.parse(update.patch.variables)).toEqual([
      'first_name', 'service_type', 'service_date', 'pay_url',
      'amount', 'card_line', 'card_last4',
    ]);
    expect(update.patch.body).toBeUndefined();
    expect(update.patch.is_active).toBeUndefined();
  });

  test('is idempotent on payment_failed variables (no update when already widened)', async () => {
    const { knex, state } = buildKnex({
      paymentFailedRow: {
        template_key: 'payment_failed',
        variables: JSON.stringify([
          'first_name', 'service_type', 'service_date', 'pay_url',
          'amount', 'card_line', 'card_last4',
        ]),
      },
    });
    await migration.up(knex);
    expect(state.updates).toHaveLength(0);
  });

  test('down removes only the new combined template', async () => {
    const { knex, state } = buildKnex();
    await migration.down(knex);
    expect(state.deleted).toEqual([{ template_key: 'service_complete_paid_receipt' }]);
  });
});
