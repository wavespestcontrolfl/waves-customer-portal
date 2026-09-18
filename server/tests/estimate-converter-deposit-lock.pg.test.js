/** Real PostgreSQL regression for caller-owned estimate locks versus deposit receipts. */
const knex = require('knex');
const { randomUUID } = require('crypto');
const { acquireEstimateDepositLedgerLock } = require('../services/estimate-deposits');
const { acquireConverterInvoiceDepositLocks } = require('../services/estimate-converter');

const connection = process.env.VISIT_PACKET_TEST_DATABASE_URL;
let database;
let fixture;
jest.setTimeout(120000);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function reached(barrier) {
  let timer;
  try {
    await Promise.race([
      barrier.promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Expected competing transaction never reached its lock')), 30000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

(connection ? describe : describe.skip)('estimate converter deposit locks on isolated PostgreSQL', () => {
  beforeAll(() => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(url.hostname)
      && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 3 } });
  });

  afterAll(async () => { if (database) await database.destroy(); });

  beforeEach(async () => {
    fixture = { customerId: randomUUID(), estimateId: randomUUID() };
    await database('customers').insert({
      id: fixture.customerId,
      first_name: 'Annual',
      last_name: 'Lock Fixture',
      email: `annual-lock-${fixture.customerId}@example.invalid`,
      phone: `+1999${fixture.customerId.replace(/-/g, '').slice(0, 10)}`,
      address_line1: '1 Example Plaza',
      city: 'Fictional',
      state: 'FL',
      zip: '00000',
    });
    await database('estimates').insert({
      id: fixture.estimateId,
      customer_id: fixture.customerId,
      status: 'sent',
    });
  });

  afterEach(async () => {
    await database('estimate_deposits').where({ estimate_id: fixture.estimateId }).del();
    await database('estimates').where({ id: fixture.estimateId }).del();
    await database('customers').where({ id: fixture.customerId }).del();
  });

  test('annual-accept invoice locks roll back acceptance while a new receipt owns the ledger', async () => {
    expect(await database('estimate_deposits').where({ estimate_id: fixture.estimateId }).first('id')).toBeUndefined();

    const estimateLocked = deferred();
    const ledgerLocked = deferred();
    const receiptInsertAttempted = deferred();
    const onQuery = (query) => {
      if (query.sql.startsWith('insert into "estimate_deposits"')) receiptInsertAttempted.resolve();
    };
    database.on('query', onQuery);

    const accept = database.transaction(async (trx) => {
      await trx('estimates').where({ id: fixture.estimateId }).forUpdate().first('id');
      await trx('estimates').where({ id: fixture.estimateId }).update({ status: 'accepted' });
      estimateLocked.resolve();
      await reached(ledgerLocked);
      await reached(receiptInsertAttempted);

      await acquireConverterInvoiceDepositLocks(trx, {
        estimateId: fixture.estimateId,
        customerId: fixture.customerId,
        nonblocking: true,
      });
    });

    const receipt = database.transaction(async (trx) => {
      await reached(estimateLocked);
      await acquireEstimateDepositLedgerLock(trx, fixture.estimateId);
      ledgerLocked.resolve();
      await trx('estimate_deposits').insert({
        estimate_id: fixture.estimateId,
        customer_id: fixture.customerId,
        stripe_payment_intent_id: `pi_${randomUUID().replace(/-/g, '')}`,
        amount: 49,
        status: 'received',
        received_at: trx.fn.now(),
      });
    });

    let outcomes;
    try {
      outcomes = await Promise.allSettled([accept, receipt]);
    } finally {
      database.removeListener('query', onQuery);
    }

    expect(outcomes[0]).toMatchObject({
      status: 'rejected',
      reason: {
        status: 409,
        code: 'DEPOSIT_LEDGER_BUSY_RETRY',
        retryableAcceptInvoiceLock: true,
      },
    });
    expect(outcomes[1]).toMatchObject({ status: 'fulfilled' });

    const recorded = await database('estimate_deposits')
      .where({ estimate_id: fixture.estimateId })
      .first('status', 'amount');
    expect(recorded).toMatchObject({ status: 'received' });
    expect(Number(recorded.amount)).toBe(49);
    expect((await database('estimates').where({ id: fixture.estimateId }).first('status')).status).toBe('sent');
    expect(await database('invoices').where({ customer_id: fixture.customerId }).first('id')).toBeUndefined();
  });
});
