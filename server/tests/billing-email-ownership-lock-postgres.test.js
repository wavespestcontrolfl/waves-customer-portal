// Raw SQL writer proof, using disposable schemas and a private dev/CI database.
jest.mock('../models/db', () => jest.fn());
// The bounce-recovery phase marker is written on the marker connection; here that is the test's own app handle.
let mockMarkerApp;
jest.mock('../models/marker-db', () => () => Object.assign((...args) => mockMarkerApp(...args), { raw: (...args) => mockMarkerApp.raw(...args) }));
jest.mock('../services/visit-completion-summary', () => ({ retrySummaryThroughHandoff: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { randomUUID } = require('node:crypto');
const knex = require('knex');
const migration = require('../models/migrations/20260927000150_billing_email_ownership_assignment_locks');
const { lockCustomerEmail, lockEmailOwnershipForSend } = require('../utils/customer-comms-lock');
const { correctedAddressOwnedByOther, dispatchRecoveryMessage } = require('../services/email-bounce-recovery');
const db = require('../models/db');
const summary = require('../services/visit-completion-summary');
const { sendOne } = require('../services/sendgrid-mail');
const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `billing_email_ownership_${randomUUID().replaceAll('-', '')}`;
const owner = randomUUID();
const other = randomUUID();
const newcomer = randomUUID();
const sourceIds = { customers: other, notification_prefs: other, estimates: randomUUID(), leads: randomUUID() };
const sources = [['customers', 'email', 'id'], ['notification_prefs', 'billing_email', 'customer_id'],
  ['estimates', 'customer_email', 'id'], ['leads', 'email', 'id']];
const corrected = 'qa.fence@gmail.com';
const alias = 'qafence+assignment@googlemail.com';
const previousFetch = global.fetch;
const previousApiKey = process.env.SENDGRID_API_KEY;
let admin;
let app;
let writer;

async function waitForLock(pid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await admin.raw("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = ? AND wait_event_type = 'Lock') AS waiting", [pid]);
    if (result.rows[0].waiting) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected a concurrent lock waiter');
}

postgres('billing Email ownership assignments (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 1 } });
    writer = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 1 } });
    await app.schema.createTable('customers', table => {
      table.uuid('id').primary(); table.text('email'); table.text('notes');
      for (const field of ['service_contact_email', 'service_contact2_email', 'service_contact3_email']) table.text(field);
    });
    await app.schema.createTable('notification_prefs', table => {
      table.uuid('customer_id').primary().references('id').inTable('customers'); table.text('billing_email'); table.text('notes');
    });
    await app.schema.createTable('estimates', table => {
      table.uuid('id').primary(); table.uuid('customer_id').references('id').inTable('customers'); table.text('customer_email'); table.text('notes');
    });
    await app.schema.createTable('leads', table => {
      table.uuid('id').primary(); table.uuid('customer_id'); table.text('email'); table.text('notes');
    });
    mockMarkerApp = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 1 } }); // its own pool: the held handoff owns app's only connection
    await app.schema.createTable('email_bounce_recoveries', table => {
      table.uuid('recovery_message_id'); table.jsonb('metadata'); table.timestamp('updated_at');
    });
    await app.schema.createTable('email_messages', table => {
      table.uuid('id').primary(); table.text('status'); table.text('error_message'); table.text('provider_message_id');
      table.text('html_snapshot'); table.text('text_snapshot');
      table.timestamp('sent_at'); table.timestamp('updated_at');
    });
    db.mockImplementation(table => app(table));
    await migration.up(app);
    await app('customers').insert([{ id: owner, email: 'qa-owner@example.invalid' }, { id: other }, { id: newcomer }]);
    for (const [table, column, key] of sources) {
      if (table !== 'customers') await app(table).insert({ [key]: sourceIds[table],
        ...(key !== 'customer_id' ? { customer_id: other } : {}), [column]: 'qa-other@example.invalid' });
    }
  }, 30000);
  beforeEach(async () => {
    process.env.SENDGRID_API_KEY = 'SG.synthetic-no-network';
    global.fetch = jest.fn(async () => ({ ok: true, headers: { get: () => 'synthetic-provider-id' } }));
    for (const [table, column, key] of sources) await app(table).where({ [key]: sourceIds[table] }).update({ [column]: 'qa-other@example.invalid' });
  });
  afterAll(async () => {
    global.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = previousApiKey;
    await app?.destroy(); await writer?.destroy(); await mockMarkerApp?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  test('migration up/down are idempotent', async () => {
    const count = async () => (await app.raw(`SELECT count(*)::int AS count FROM pg_trigger
      WHERE tgname = 'billing_email_ownership_assignment_guard'
        AND tgrelid IN ('customers'::regclass, 'notification_prefs'::regclass, 'estimates'::regclass, 'leads'::regclass)`)).rows[0].count;
    try {
      await migration.up(app); expect(await count()).toBe(4);
      await migration.down(app); await migration.down(app); expect(await count()).toBe(0);
    } finally { await migration.up(app); }
  });

  test.each(sources)('raw %s UPDATE/INSERT cannot assign an exact or Gmail destination during HTTP', async (table, column, key) => {
    global.fetch.mockImplementation(async () => {
      for (const address of [corrected, alias]) {
        await expect(writer.transaction(async trx => {
          await trx.raw("SET LOCAL lock_timeout = '100ms'");
          await trx.raw('UPDATE ?? SET ?? = ? WHERE ?? = ?', [table, column, address, key, sourceIds[table]]);
        })).rejects.toMatchObject({ code: '55P03' });
        const inserted = { [key]: key === 'customer_id' ? newcomer : randomUUID(),
          ...(table !== 'customers' && key !== 'customer_id' ? { customer_id: newcomer } : {}), [column]: address };
        await expect(writer.transaction(async trx => {
          await trx.raw("SET LOCAL lock_timeout = '100ms'");
          const fields = Object.keys(inserted);
          await trx.raw(`INSERT INTO ?? (${fields.map(() => '??').join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
            [table, ...fields, ...Object.values(inserted)]);
        })).rejects.toMatchObject({ code: '55P03' });
      }
      await writer.raw('UPDATE ?? SET ?? = ?, notes = ? WHERE ?? = ?', [table, column, 'qa-unrelated@example.invalid', 'routine', key, sourceIds[table]]);
      return { ok: true, headers: { get: () => 'synthetic-provider-id' } };
    });
    await app.transaction(async trx => {
      await trx('customers').where({ id: owner }).forUpdate().first();
      await lockCustomerEmail(trx, corrected);
      await sendOne({ to: corrected, subject: 'Synthetic', text: 'Synthetic', database: trx,
        providerBoundaryCheck: async ({ database }) => {
          await lockEmailOwnershipForSend(database, corrected);
            if (await correctedAddressOwnedByOther(corrected, owner, database)) throw new Error('Ownership conflict');
        } });
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  }, 15000);

  test.each(sources)('an in-flight raw %s assignment refuses without waiting or HTTP', async (table, column, key) => {
    const assignment = await writer.transaction();
    try {
      await assignment.raw('UPDATE ?? SET ?? = ? WHERE ?? = ?', [table, column, alias, key, sourceIds[table]]);
      await app.transaction(async trx => {
        await trx('customers').where({ id: owner }).forUpdate().first();
        await lockCustomerEmail(trx, corrected);
        await sendOne({ to: corrected, subject: 'Synthetic', text: 'Synthetic', database: trx,
          providerBoundaryCheck: async ({ database }) => {
            await lockEmailOwnershipForSend(database, corrected);
            if (await correctedAddressOwnedByOther(corrected, owner, database)) throw new Error('Ownership conflict');
          } }).catch(err => { expect(err.code).toBe('EMAIL_OWNERSHIP_CHECK_BUSY'); });
      });
      expect(global.fetch).not.toHaveBeenCalled();
      await assignment.commit();
      await app.transaction(async trx => {
        await lockEmailOwnershipForSend(trx, corrected);
        expect(await correctedAddressOwnedByOther(corrected, owner, trx)).toBe(true);
      });
    } finally { if (!assignment.isCompleted()) await assignment.rollback(); }
  });

  test('the live visit-summary callback refuses a busy assignment with a sanitized transient failure', async () => {
    const message = { id: randomUUID(), status: 'queued', subject_snapshot: 'Synthetic', send_attempt_token: 'synthetic' };
    await app('email_messages').insert({ id: message.id, status: 'queued' });
    const assignment = await writer.transaction();
    try {
      await assignment('leads').where({ id: sourceIds.leads }).update({ email: alias });
      summary.retrySummaryThroughHandoff.mockImplementationOnce(async (_message, dispatch) => app.transaction(async trx => {
        await trx('customers').where({ id: owner }).forShare().first();
        await trx('notification_prefs').where({ customer_id: owner }).forShare().first();
        await lockCustomerEmail(trx, corrected);
        return dispatch(trx);
      }));
      const result = await dispatchRecoveryMessage({ message, categories: [], ownCustomerId: owner, correctedEmail: corrected,
        bouncedMessage: { template_key: 'service.visit_summary', text_snapshot: 'Synthetic' } });
      expect(result).toEqual({ ok: false, error: 'Email ownership assignment in progress' });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(await app('email_messages').where({ id: message.id }).first()).toMatchObject({ status: 'failed', error_message: result.error });
    } finally { if (!assignment.isCompleted()) await assignment.rollback(); }
  });

  test('the live visit-summary callback holds raw destination assignments through actual HTTP', async () => {
    const message = { id: randomUUID(), status: 'queued', subject_snapshot: 'Synthetic', send_attempt_token: 'synthetic' };
    await app('email_messages').insert({ id: message.id, status: 'queued' });
    summary.retrySummaryThroughHandoff.mockImplementationOnce(async (_message, dispatch) => app.transaction(async trx => {
      await trx('customers').where({ id: owner }).forShare().first();
      await trx('notification_prefs').where({ customer_id: owner }).forShare().first();
      await lockCustomerEmail(trx, corrected);
      return dispatch(trx);
    }));
    global.fetch.mockImplementationOnce(async () => {
      await expect(writer.transaction(async trx => {
        await trx.raw("SET LOCAL lock_timeout = '100ms'");
        await trx('leads').insert({ id: randomUUID(), customer_id: other, email: alias });
      })).rejects.toMatchObject({ code: '55P03' });
      return { ok: true, headers: { get: () => 'synthetic-provider-id' } };
    });
    await expect(dispatchRecoveryMessage({ message, categories: [], ownCustomerId: owner, correctedEmail: corrected,
      bouncedMessage: { template_key: 'service.visit_summary', text_snapshot: 'Synthetic' } })).resolves.toEqual({ ok: true, messageRowId: message.id });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test.each(sources.filter(([table]) => table !== 'customers'))('%s same-address owner reassignment takes the shared fence', async (table, column, key) => {
    await app(table).where({ [key]: sourceIds[table] }).update({ [column]: alias });
    await app.transaction(async trx => {
      await lockEmailOwnershipForSend(trx, corrected);
      await expect(writer.transaction(async changing => {
        await changing.raw("SET LOCAL lock_timeout = '100ms'");
        await changing(table).where({ [key]: sourceIds[table] }).update({ customer_id: owner });
      })).rejects.toMatchObject({ code: '55P03' });
      await writer.transaction(async routine => {
        await routine.raw("SET LOCAL lock_timeout = '100ms'");
        await routine(table).where({ [key]: sourceIds[table] }).update({ [column]: alias, notes: 'same address unchanged' });
      });
    });
  });

  test.each(sources)('committed raw %s addresses use the same normalization as their fence', async (table, column, key) => {
    for (const address of [`  ${corrected.toUpperCase()}  `, `  ${alias.toUpperCase()}  `]) {
      await app(table).where({ [key]: sourceIds[table] }).update({ [column]: address });
      await app.transaction(async trx => {
        await lockEmailOwnershipForSend(trx, corrected);
        expect(await correctedAddressOwnedByOther(corrected, owner, trx)).toBe(true);
      });
    }
  });

  test.each(['estimates', 'notification_prefs'])('a %s INSERT waiting on the held customer cannot deadlock the final reader', async (table) => {
    const id = randomUUID();
    const pid = (await writer.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const sender = await app.transaction();
    let assigning;
    try {
      await sender('customers').where({ id: owner }).forUpdate().first();
      await lockCustomerEmail(sender, corrected);
      assigning = writer.transaction(async trx => {
        await trx(table).insert(table === 'estimates'
          ? { id, customer_id: owner, customer_email: alias }
          : { customer_id: owner, billing_email: alias });
      }).then(() => 'committed', err => err.code);
      await waitForLock(pid);
      await expect(lockEmailOwnershipForSend(sender, corrected)).rejects.toMatchObject({ code: 'EMAIL_OWNERSHIP_CHECK_BUSY' });
      await sender.rollback();
      expect(await assigning).toBe('committed');
    } finally {
      if (!sender.isCompleted()) await sender.rollback();
      await assigning;
      await app(table).where(table === 'estimates' ? { id } : { customer_id: owner }).del();
    }
  });

  test('different raw writers share ownership keys, including opposite address order', async () => {
    const one = await app.transaction();
    const two = await writer.transaction();
    try {
      await one('customers').where({ id: other }).update({ email: corrected, service_contact_email: 'second@example.invalid' });
      await two.raw("SET LOCAL lock_timeout = '200ms'");
      await two('customers').where({ id: newcomer }).update({ service_contact_email: corrected, email: 'second@example.invalid' });
      await two.commit(); await one.commit();
    } finally {
      if (!one.isCompleted()) await one.rollback();
      if (!two.isCompleted()) await two.rollback();
      await app('customers').where({ id: newcomer }).update({ email: null, service_contact_email: null });
      await app('customers').where({ id: other }).update({ service_contact_email: null });
    }
  });
});
