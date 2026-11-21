/**
 * The plan-quote lineage read behind staff Unarchive (admin-estimates.js POST
 * /:id/unarchive), against live Postgres. lineageUnarchiveBlock compares the
 * stored (created_at, id) and reads the open siblings inside the database, so
 * the unit suite's mocked builder cannot prove it (estimate-status-guards.test.js
 * holds the route's rules). Synthetic rows in one transaction that is rolled back.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('plan quote lineage (live Postgres)', () => {
  test('a quote is replaced by a newer quote of its lineage or by one still open, and by nothing else', async () => {
    const crypto = require('crypto');
    const db = require('../models/db');
    const { lineageUnarchiveBlock } = require('../services/cancellation-resolution/restart');
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
      // An archived quote unless `extra` says otherwise: the route only asks about archived rows.
      const quote = async (customerId, source, createdAt, extra = {}) => {
        const [row] = await trx('estimates').insert({
          customer_id: customerId, source, status: 'sent', archived_at: trx.fn.now(), created_at: trx.raw('?::timestamptz', [createdAt]), ...extra,
        }).returning(['id', 'customer_id', 'source']);
        return row;
      };
      const block = (row) => lineageUnarchiveBlock(trx, row);

      // One lineage, two quotes one microsecond apart: a JavaScript Date would call them equal.
      // The newer one counts in any status, archived too; the newest is replaced by nothing.
      const first = await customer();
      const older = await quote(first, 'plan_start', '2026-11-01 10:00:00.000001+00');
      const newest = await quote(first, 'plan_start', '2026-11-01 10:00:00.000002+00', { status: 'expired' });
      seen.older = await block(older);
      seen.newest = await block(newest);
      // "Another quote" never means the quote itself, open or not.
      seen.openAlone = await block(await quote(await customer(), 'plan_start', '2026-11-01 10:00:00+00', { archived_at: null }));

      // A newer quote of ANOTHER source, or of another customer, is not this lineage; an open one neither.
      const second = await customer();
      const restart = await quote(second, 'plan_restart', '2026-11-01 10:00:00+00');
      await quote(second, 'plan_start', '2026-11-02 10:00:00+00', { archived_at: null });
      await quote(second, 'admin_estimator', '2026-11-03 10:00:00+00', { archived_at: null });
      await quote(first, 'plan_restart', '2026-11-04 10:00:00+00', { archived_at: null });
      seen.otherSourceOrCustomer = await block(restart);

      // Two mints that took the customer lock in the other order: the live quote is the OLDER row
      // (created_at is the transaction's start). It is open, so the retired newer row stays archived.
      const third = await customer();
      await quote(third, 'plan_start', '2026-11-05 10:00:00+00', { archived_at: null, status: 'viewed' });
      const retiredButNewer = await quote(third, 'plan_start', '2026-11-05 10:00:01+00');
      seen.openOlderSibling = await block(retiredButNewer);
      // An open sibling that expired still counts (it can be extended); an accepted one is history.
      const fourth = await customer();
      await quote(fourth, 'plan_restart', '2026-11-05 10:00:00+00', { archived_at: null, status: 'expired' });
      seen.expiredOlderSibling = await block(await quote(fourth, 'plan_restart', '2026-11-05 10:00:01+00'));
      const fifth = await customer();
      await quote(fifth, 'plan_restart', '2026-11-05 10:00:00+00', { archived_at: null, status: 'accepted' });
      await quote(fifth, 'plan_restart', '2026-11-05 10:00:00.5+00', { status: 'declined' });
      seen.acceptedOrArchivedOlderSibling = await block(await quote(fifth, 'plan_restart', '2026-11-05 10:00:01+00'));

      // Two archived quotes stored at the same instant: the id breaks the tie, so exactly one is the newer.
      const sixth = await customer();
      const tie = [await quote(sixth, 'plan_start', '2026-11-06 10:00:00+00'), await quote(sixth, 'plan_start', '2026-11-06 10:00:00+00')];
      seen.tie = [await block(tie[0]), await block(tie[1])].map(String).sort();

      // The row as the route read it before the lock, against the row now: another owner, another
      // source, or gone. The lock held is then not this lineage's.
      seen.moved = [
        await block({ ...newest, customer_id: second }),
        await block({ ...newest, source: 'plan_restart' }),
        await block({ ...newest, id: crypto.randomUUID() }),
      ];
      throw ROLLBACK;
    }).catch((err) => { if (err !== ROLLBACK) throw err; });
    expect(seen).toEqual({
      older: 'replaced',
      newest: null,
      openAlone: null,
      otherSourceOrCustomer: null,
      openOlderSibling: 'replaced',
      expiredOlderSibling: 'replaced',
      acceptedOrArchivedOlderSibling: null,
      tie: ['null', 'replaced'],
      moved: ['moved', 'moved', 'moved'],
    });
  });
});
