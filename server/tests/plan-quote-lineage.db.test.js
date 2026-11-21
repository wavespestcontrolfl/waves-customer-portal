/**
 * The plan-quote lineage read behind staff Unarchive (admin-estimates.js POST
 * /:id/unarchive), against live Postgres. newerLineageQuoteExists compares the
 * stored (created_at, id) inside the database, so the unit suite's mocked
 * builder cannot prove it (estimate-status-guards.test.js holds the route's
 * rules). Synthetic rows in one transaction that is rolled back.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('plan quote lineage (live Postgres)', () => {
  test('only a newer quote of the same customer and source replaces a quote', async () => {
    const crypto = require('crypto');
    const db = require('../models/db');
    const { newerLineageQuoteExists } = require('../services/cancellation-resolution/restart');
    const ROLLBACK = new Error('rollback');
    const seen = {};
    await db.transaction(async (trx) => {
      // Area code 555 is not assigned, so the numbers are nobody's.
      const phoneBase = crypto.randomInt(1000000, 9999000);
      let customers = 0;
      const customer = async () => {
        const id = crypto.randomUUID();
        customers += 1;
        await trx('customers').insert({
          id, first_name: 'Pat', last_name: 'Sampleton', phone: `+1555${phoneBase + customers}`, email: `qa-${id.slice(0, 8)}@example.test`, active: true,
        });
        return id;
      };
      const quote = async (customerId, source, createdAt, extra = {}) => {
        const [row] = await trx('estimates').insert({ customer_id: customerId, source, status: 'sent', created_at: trx.raw('?::timestamptz', [createdAt]), ...extra }).returning('id');
        return row.id;
      };
      const replaced = (id) => newerLineageQuoteExists(trx, id);

      // One lineage, two quotes one microsecond apart: a JavaScript Date would call them equal.
      const first = await customer();
      const older = await quote(first, 'plan_start', '2026-11-01 10:00:00.000001+00');
      const newer = await quote(first, 'plan_start', '2026-11-01 10:00:00.000002+00', { archived_at: trx.fn.now(), status: 'expired' });
      seen.older = await replaced(older);
      // The newest of the lineage is not replaced; the newer one counts in any status, archived too.
      seen.newest = await replaced(newer);

      // A newer quote of ANOTHER source, or of another customer, is not this lineage.
      const second = await customer();
      const restart = await quote(second, 'plan_restart', '2026-11-01 10:00:00+00');
      await quote(second, 'plan_start', '2026-11-02 10:00:00+00');
      await quote(second, 'admin_estimator', '2026-11-03 10:00:00+00');
      await quote(first, 'plan_restart', '2026-11-04 10:00:00+00');
      seen.otherSourceOrCustomer = await replaced(restart);

      // Two quotes stored at the same instant: the id breaks the tie, so exactly one is the newer.
      const third = await customer();
      const tie = [await quote(third, 'plan_start', '2026-11-05 10:00:00+00'), await quote(third, 'plan_start', '2026-11-05 10:00:00+00')];
      seen.tie = [await replaced(tie[0]), await replaced(tie[1])].sort();

      // An id that is not an estimate has no lineage.
      seen.unknown = await replaced(crypto.randomUUID());
      throw ROLLBACK;
    }).catch((err) => { if (err !== ROLLBACK) throw err; });
    expect(seen).toEqual({ older: true, newest: false, otherSourceOrCustomer: false, tie: [false, true], unknown: false });
  });
});
