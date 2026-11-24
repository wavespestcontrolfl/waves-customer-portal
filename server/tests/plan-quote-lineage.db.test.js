/**
 * The plan-quote lineage against live Postgres: the read behind staff Unarchive
 * (admin-estimates.js POST /:id/unarchive) and the order the mint assigns.
 * lineageUnarchiveBlock compares the stored (created_at, id) and reads the open
 * siblings inside the database, and lineageOrderStamp is a database-side value,
 * so the unit suites' mocked builders cannot prove either (estimate-status-guards.test.js
 * holds the route's rules; plan-restart.test.js and plan-start.test.js hold the mint's).
 * Synthetic rows in transactions that are rolled back.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('plan quote lineage (live Postgres)', () => {
  const crypto = require('crypto');
  const lineageModule = () => require('../services/cancellation-resolution/restart');
  const ROLLBACK = new Error('rollback');

  // Runs `work(trx, { customer, quote })` in a transaction that is always rolled back.
  async function rolledBack(work) {
    const db = require('../models/db');
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
      // createdAt: a timestamp string, or a database-side value (the mint's order stamp).
      const quote = async (customerId, source, createdAt, extra = {}) => {
        const [row] = await trx('estimates').insert({
          customer_id: customerId,
          source,
          status: 'sent',
          archived_at: trx.fn.now(),
          created_at: typeof createdAt === 'string' ? trx.raw('?::timestamptz', [createdAt]) : createdAt,
          ...extra,
        }).returning(['id', 'customer_id', 'source']);
        return row;
      };
      await work(trx, { customer, quote });
      throw ROLLBACK;
    }).catch((err) => { if (err !== ROLLBACK) throw err; });
  }

  test('a quote is replaced by a newer quote of its lineage or by one still open, and by nothing else', async () => {
    const { lineageUnarchiveBlock } = lineageModule();
    const seen = {};
    await rolledBack(async (trx, { customer, quote }) => {
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
    });
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

  // #8245 pre-push r1 and r2. The column's default is the transaction's start, which is not the order
  // the mints ran in: of two mints for one customer, the one that began first can take the customer
  // lock second. Its quote, the live one, was then the older row.
  test('the mint stamps a new quote after every stored quote of its lineage, whatever its transaction\'s start', async () => {
    const { lineageOrderStamp, lineageUnarchiveBlock } = lineageModule();
    const seen = {};
    await rolledBack(async (trx, { customer, quote }) => {
      const minted = (customerId, source, extra) => quote(customerId, source, lineageOrderStamp(trx, customerId, source), extra);
      // A quote's distance from this transaction's start, in microseconds, in the stored order.
      const offsets = async (customerId, source) => (await trx.raw(
        `SELECT id, round(extract(epoch FROM (created_at - now())) * 1000000)::bigint AS micros
           FROM estimates WHERE customer_id = ? AND source = ? ORDER BY created_at, id`,
        [customerId, source],
      )).rows.map((row) => [row.id, Number(row.micros)]);

      // Three mints in one transaction: the column default would store one instant three times.
      // The first of a lineage keeps the transaction's start; each next one is one step later.
      const first = await customer();
      const run = [await minted(first, 'plan_start'), await minted(first, 'plan_start'), await minted(first, 'plan_start')];
      seen.inInsertOrder = (await offsets(first, 'plan_start')).map(([id, micros]) => [run.findIndex((row) => row.id === id), micros]);

      // The race. Another mint, whose transaction began 5 s AFTER this one, already stored its quote;
      // this mint retired it (archived) and now stores the live quote. The default would sort the
      // live quote first.
      const second = await customer();
      const retired = await quote(second, 'plan_restart', trx.raw("now() + interval '5 seconds'"));
      const successor = await minted(second, 'plan_restart', { archived_at: null });
      seen.successorIsNewer = (await offsets(second, 'plan_restart')).map(([id, micros]) => [id === successor.id ? 'successor' : 'retired', micros]);
      // While the successor is open, and after staff archive it: the retired quote stays archived,
      // and the successor is the one that can come back.
      const block = (row) => lineageUnarchiveBlock(trx, row);
      seen.successorOpen = await block(retired);
      await trx('estimates').where({ id: successor.id }).update({ archived_at: trx.fn.now() });
      seen.successorArchived = { retired: await block(retired), successor: await block(successor) };

      // An accepted quote of the lineage counts too: the next quote is stored after it.
      const third = await customer();
      await quote(third, 'plan_start', trx.raw("now() + interval '9 seconds'"), { status: 'accepted', archived_at: null });
      await minted(third, 'plan_start');
      seen.afterAccepted = (await offsets(third, 'plan_start')).map(([, micros]) => micros);

      // A later quote of another source, or of another customer, is not this lineage: it lifts nothing.
      const fourth = await customer();
      await quote(fourth, 'plan_restart', trx.raw("now() + interval '5 seconds'"));
      await quote(third, 'plan_restart', trx.raw("now() + interval '5 seconds'"));
      const alone = await minted(fourth, 'plan_start');
      seen.otherLineagesLiftNothing = (await offsets(fourth, 'plan_start')).map(([id, micros]) => [id === alone.id, micros]);
    });
    expect(seen).toEqual({
      inInsertOrder: [[0, 0], [1, 1], [2, 2]],
      successorIsNewer: [['retired', 5000000], ['successor', 5000001]],
      successorOpen: 'replaced',
      successorArchived: { retired: 'replaced', successor: null },
      afterAccepted: [9000000, 9000001],
      otherLineagesLiftNothing: [[true, 0]],
    });
  });
});
