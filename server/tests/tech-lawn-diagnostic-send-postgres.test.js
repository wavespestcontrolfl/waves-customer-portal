/**
 * DB-backed concurrency check for POST /api/tech/lawn-diagnostic/:id/send
 * (routes/tech-lawn-diagnostic.js). The send locks the diagnostic row before it
 * resolves the recipient and decides keep-or-rotate, so a send queued behind
 * another one reads the snapshot and token the first committed (Today audit
 * TODAY-01). A test transaction holds the row lock while the sends queue behind
 * it in a known order, then lets them go. The mocked suites cannot show this.
 *
 * Self-skips without DATABASE_URL (run after `knex migrate:latest`).
 */
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = { id: null, role: 'admin' };
    req.technicianId = null;
    req.techRole = 'admin';
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const recipient = (letter, line1) => ({
  contact: { name: `Fixture Prospect ${letter}`, email: `prospect-${letter.toLowerCase()}@example.invalid` },
  address: { line1, city: 'Venice', state: 'FL' },
});
const X = recipient('X', '1 Fixture Way');
const Y = recipient('Y', '2 Fixture Way');
const Z = recipient('Z', '3 Fixture Way');

describeOrSkip('lawn report send: concurrent sends on PostgreSQL', () => {
  let db;
  let server;
  let base;
  const ids = [];

  beforeAll(async () => {
    db = require('../models/db');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/tech/lawn-diagnostic', require('../routes/tech-lawn-diagnostic'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}/api/tech/lawn-diagnostic`;
  });

  afterAll(async () => {
    if (ids.length) await db('lawn_diagnostics').whereIn('id', ids).del();
    await new Promise((resolve) => server.close(resolve));
    await db.destroy();
  });

  const send = async (id, body) => {
    const res = await fetch(`${base}/${id}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, ...(await res.json()) };
  };

  const seed = async () => {
    const [row] = await db('lawn_diagnostics').insert({ mode: 'internal', status: 'analyzed' }).returning(['id']);
    ids.push(row.id);
    return row.id;
  };

  const waitForLockWaiters = async (count) => {
    for (let i = 0; i < 400; i += 1) {
      const { rows } = await db.raw(`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query ILIKE '%lawn_diagnostics%'`);
      if (rows[0].n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`expected ${count} sends waiting on the diagnostic row lock`);
  };

  // Each send starts only once the one before it is waiting on the lock, so they
  // run in this order when the test transaction lets the row go.
  const sendQueuedBehindLock = async (id, bodies) => {
    const blocker = await db.transaction();
    const pending = [];
    try {
      await blocker('lawn_diagnostics').where({ id }).forUpdate().first();
      for (const body of bodies) {
        pending.push(send(id, body));
        await waitForLockWaiters(pending.length);
      }
    } finally {
      await blocker.commit();
    }
    return Promise.all(pending);
  };

  test('two sends of the same new recipient return one link, the one that is stored', async () => {
    const id = await seed();
    const [first, second] = await sendQueuedBehindLock(id, [Y, Y]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const row = await db('lawn_diagnostics').where({ id }).first();
    expect(first.token).toBe(row.report_token);
    expect(second.token).toBe(row.report_token);
  });

  test('a bare resend queued behind a recipient change keeps the new recipient on the new link', async () => {
    const id = await seed();
    const original = await send(id, X);
    expect(original.status).toBe(200);
    const [changed, bare] = await sendQueuedBehindLock(id, [Y, {}]);
    expect(changed.token).not.toBe(original.token);
    expect(bare.token).toBe(changed.token);
    const row = await db('lawn_diagnostics').where({ id }).first();
    expect(row.report_token).toBe(changed.token);
    // X's name and address never sit behind the link that was made for Y.
    expect(row.contact_snapshot).toMatchObject(Y.contact);
    expect(row.address_snapshot).toMatchObject(Y.address);
  });

  test('two different recipients still rotate: the stored link belongs to the last one', async () => {
    const id = await seed();
    const [toY, toZ] = await sendQueuedBehindLock(id, [Y, Z]);
    expect(toY.token).not.toBe(toZ.token);
    const row = await db('lawn_diagnostics').where({ id }).first();
    expect(row.report_token).toBe(toZ.token);
    expect(row.contact_snapshot).toMatchObject(Z.contact);
  });
});
