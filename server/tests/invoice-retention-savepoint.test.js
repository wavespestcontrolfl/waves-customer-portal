/**
 * The retention-offer lookup inside a completion mint runs under a SAVEPOINT
 * (InvoiceService.applyRetentionOfferUnderSavepoint). Proven against a REAL
 * Postgres transaction — a hand-rolled fake has no transaction semantics
 * and passes the broken version (waves-db §5b): before this, a failed
 * statement in the lookup aborted the caller's whole mint transaction and
 * four priced completions went out unbilled (2026-08-31→09-01).
 *
 * Self-skips without DATABASE_URL (run after `knex migrate:latest`).
 */
const path = require('path');
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('applyRetentionOfferUnderSavepoint', () => {
  let knex;
  let InvoiceService;
  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
    InvoiceService = require('../services/invoice');
  });
  afterAll(async () => { if (knex) await knex.destroy(); });

  test('a failed statement inside the lookup rolls back ONLY the savepoint — the mint transaction stays usable and no line is added', async () => {
    const lookup = jest.spyOn(InvoiceService, 'buildRetentionOfferLineForMint').mockImplementation(async ({ database }) => {
      // The exact failure class that shipped: a column the table does not have.
      await database('services').select('service_name').first();
      return null;
    });
    try {
      await knex.transaction(async (trx) => {
        const result = await InvoiceService.applyRetentionOfferUnderSavepoint({
          customerId: '00000000-0000-0000-0000-000000000001',
          scheduledServiceId: '00000000-0000-0000-0000-000000000002',
          lineItems: [{ amount: 100 }],
          trx,
        });
        expect(result).toBeNull();
        // The caller's transaction is still healthy: the next statement runs
        // instead of failing with "current transaction is aborted".
        const probe = await trx.raw('select 1 as ok');
        expect(probe.rows[0].ok).toBe(1);
        throw new Error('rollback-test');
      }).catch((e) => { if (e.message !== 'rollback-test') throw e; });
    } finally {
      lookup.mockRestore();
    }
  });

  test('without a transaction the helper is a no-op; a healthy lookup that finds no offer returns null and leaves the transaction usable', async () => {
    expect(await InvoiceService.applyRetentionOfferUnderSavepoint({ customerId: 'x', scheduledServiceId: 'y', lineItems: [], trx: null })).toBeNull();
    await knex.transaction(async (trx) => {
      const result = await InvoiceService.applyRetentionOfferUnderSavepoint({
        customerId: '00000000-0000-0000-0000-000000000001',
        scheduledServiceId: '00000000-0000-0000-0000-000000000002',
        lineItems: [{ amount: 100 }],
        trx,
      });
      expect(result).toBeNull();
      const probe = await trx.raw('select 2 as ok');
      expect(probe.rows[0].ok).toBe(2);
      throw new Error('rollback-test');
    }).catch((e) => { if (e.message !== 'rollback-test') throw e; });
  });
});
