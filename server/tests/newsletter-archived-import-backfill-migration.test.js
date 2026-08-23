const migration = require('../models/migrations/20260823000001_newsletter_suppress_archived_customer_imports');

function fakeKnex({ hasReason = true } = {}) {
  const q = {};
  ['where', 'whereIn'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.update = jest.fn(async () => 3);
  const knex = jest.fn(() => q);
  knex.fn = { now: () => 'NOW()' };
  knex.schema = {
    hasTable: jest.fn(async () => true),
    hasColumn: jest.fn(async (_t, col) => (col === 'deactivated_reason' ? hasReason : true)),
  };
  return { knex, q };
}

describe('newsletter archived-customer import backfill migration', () => {
  test('flips only active customer_import rows linked to a deleted_at customer to inactive', async () => {
    const { knex, q } = fakeKnex();
    await migration.up(knex);
    expect(knex).toHaveBeenCalledWith('newsletter_subscribers');
    expect(q.where).toHaveBeenCalledWith({ status: 'active', source: 'customer_import' });
    expect(q.whereIn).toHaveBeenCalledWith('customer_id', expect.any(Function));
    // The subquery targets customers with deleted_at set.
    const sub = { select: jest.fn(() => sub), from: jest.fn(() => sub), whereNotNull: jest.fn(() => sub) };
    q.whereIn.mock.calls[0][1].call(sub);
    expect(sub.from).toHaveBeenCalledWith('customers');
    expect(sub.whereNotNull).toHaveBeenCalledWith('deleted_at');
    expect(q.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'inactive', deactivated_reason: 'customer_archived',
    }));
  });

  test('omits reason columns when the sunset columns are absent; down is a no-op', async () => {
    const { knex, q } = fakeKnex({ hasReason: false });
    await migration.up(knex);
    expect(q.update.mock.calls[0][0]).not.toHaveProperty('deactivated_reason');
    await expect(migration.down(knex)).resolves.toBeUndefined();
    expect(q.update).toHaveBeenCalledTimes(1);
  });
});
