// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// Runs in the existing DB-gated CI step or the owning worktree's private QA DB.
//
// Zelle payments from the Plaid bank feed (GATE_ZELLE_BANK_RECONCILE): the
// SQL the mocked suite (zelle-bank-reconciler.test.js) cannot prove — the scan
// window and its exclusions, the per-transaction claim (UNIQUE +
// ON CONFLICT), the one-source CHECK, the live open-balance lookup end to end,
// and the migration's fail-closed rollback. The money path itself
// (recordManualPayment) and the alert sink are stubs; nothing can reach a
// customer or a provider.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'synthetic-notification' })) }));
jest.mock('../services/invoice-manual-payment', () => ({ recordManualPayment: jest.fn() }));

const { randomUUID } = require('node:crypto');
const { recordManualPayment } = require('../services/invoice-manual-payment');
const NotificationService = require('../services/notification-service');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const MIGRATION = '20261024233000_zelle_bank_feed_notices';
const HOUR = 3600 * 1000;
// What a claimed bank notice carries for today's synthetic credit.
const todayStartET = () => parseETDateTime(`${etDateString(new Date())}T00:00`);

postgres('Zelle payments from the bank feed against migrated PostgreSQL', () => {
  let database;
  let trx;
  let reconciler;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
    reconciler = require('../services/zelle-notice-reconciler');
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    delete process.env.GATE_ZELLE_BANK_RECONCILE;
    trx = await database.transaction();
    require('../models/db').connection = trx;
  });

  afterEach(async () => {
    await trx.rollback();
    require('../models/db').connection = database;
  });

  afterAll(async () => {
    await database.destroy();
  });

  // A linked Capital One connection with one bank and one card account.
  async function linkAccounts({ linkedAt = new Date(Date.now() - 24 * HOUR) } = {}) {
    const [item] = await trx('plaid_items').insert({ item_id: `item-${randomUUID()}`, institution_name: 'Capital One', status: 'active' }).returning('id');
    const bank = `acct-bank-${randomUUID()}`;
    const card = `acct-card-${randomUUID()}`;
    await trx('plaid_accounts').insert([
      { plaid_item_id: item.id, account_id: bank, mask: '0001', account_label: `synthetic-checking-${bank.slice(-6)}`, account_type: 'bank', sync_from: '2026-01-01', enabled: true, created_at: linkedAt },
      { plaid_item_id: item.id, account_id: card, mask: '0002', account_label: `synthetic-card-${card.slice(-6)}`, account_type: 'card', sync_from: '2026-01-01', enabled: true, created_at: linkedAt },
    ]);
    return { bank, card };
  }

  async function bankRow(accountId, over = {}) {
    const txnId = `ptx-${randomUUID()}`;
    const [row] = await trx('bank_transactions').insert({
      account_label: over.account_label || `synthetic-checking-${accountId.slice(-6)}`,
      account_type: 'bank',
      txn_date: etDateString(new Date()),
      description: 'Zelle',
      original_description: 'Zelle money received from QUENTIN ZELLEFEEDTEST',
      amount: '173.29',
      direction: 'credit',
      source: 'plaid',
      row_hash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      plaid_transaction_id: txnId,
      plaid_account_id: accountId,
      created_at: new Date(Date.now() - HOUR),
      ...over,
    }).returning(['id', 'plaid_transaction_id']);
    return row;
  }

  test('the scan reads only live Zelle credits on linked bank accounts that have no notice yet', async () => {
    const { bank, card } = await linkAccounts();
    const live = await bankRow(bank);
    await bankRow(bank, { txn_date: etDateString(addETDays(new Date(), -4)) }); // before the link grace (linked yesterday, so 3 days back is the floor) — history
    await bankRow(bank, { account_type: 'card', account_label: `synthetic-card-${card.slice(-6)}`, plaid_account_id: card }); // card credit
    await bankRow(bank, { direction: 'debit', original_description: 'Zelle money sent to QUENTIN ZELLEFEEDTEST' }); // money out
    await bankRow(bank, { status: 'ignored' }); // owner said not business
    await bankRow(bank, { original_description: 'Mobile Deposit', description: 'Mobile Deposit' }); // not Zelle
    await bankRow(bank, { status: 'matched_payout', suggestion: JSON.stringify({ plaidRemoved: true }) }); // the bank withdrew it
    await bankRow(bank, { suggestion: JSON.stringify({ plaidModified: { amount: 17 } }) }); // a correction waiting on the operator
    const noticed = await bankRow(bank);
    await trx('inbound_payment_notices').insert({
      plaid_transaction_id: noticed.plaid_transaction_id, source: reconciler.BANK_SOURCE, amount_cents: 17329, received_at: new Date(), status: 'ignored',
    });
    // A CSV statement row carries no Plaid identity at all.
    await trx('bank_transactions').insert({
      account_label: 'synthetic-csv', account_type: 'bank', txn_date: etDateString(new Date()), description: 'Zelle money received from QUENTIN ZELLEFEEDTEST',
      amount: '173.29', direction: 'credit', source: 'csv', row_hash: randomUUID().replace(/-/g, '').padEnd(64, '1'),
    });

    const rows = await reconciler._private.bankRowsToDecide(Date.now());
    expect(rows.map((r) => r.plaid_transaction_id)).toEqual([live.plaid_transaction_id]);
    expect(rows[0].txn_date).toBe(etDateString(new Date()));
    expect(rows[0].amount).toBe('173.29');
  });

  test('an account linked weeks ago reads only the 14-day lookback', async () => {
    const { bank } = await linkAccounts({ linkedAt: new Date(Date.now() - 40 * 24 * HOUR) });
    const recent = await bankRow(bank, { txn_date: etDateString(addETDays(new Date(), -13)) });
    await bankRow(bank, { txn_date: etDateString(addETDays(new Date(), -15)) });
    const rows = await reconciler._private.bankRowsToDecide(Date.now());
    expect(rows.map((r) => r.plaid_transaction_id)).toEqual([recent.plaid_transaction_id]);
  });

  test('end to end: the one open invoice at these cents under the payer\'s name is settled once; the next pass reads nothing', async () => {
    const { bank } = await linkAccounts();
    const customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Quentin', last_name: 'Zellefeedtest', email: `${customerId}@example.invalid`,
      phone: `fixture-${customerId.slice(0, 8)}`, address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true,
    });
    const invoiceId = randomUUID();
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId, status: 'sent', subtotal: 173.29, total: 173.29, line_items: '[]',
      invoice_number: `TEST-${invoiceId.slice(0, 8)}`, token: randomUUID(), created_at: new Date(Date.now() - 48 * HOUR),
    });
    const row = await bankRow(bank);
    recordManualPayment.mockImplementation(async (id) => ({ invoice: { id, invoice_number: `TEST-${invoiceId.slice(0, 8)}`, customer_id: customerId, status: 'paid' }, receipt: { queued: true } }));

    expect(await reconciler.reconcileZelleBankFeed()).toMatchObject({ read: 1, decided: 1, failed: 0 });
    expect(recordManualPayment).toHaveBeenCalledWith(invoiceId, expect.objectContaining({
      method: 'zelle', reference: 'Quentin Zellefeedtest', sendReceipt: true, via: 'both', expectedAmountCents: 17329, requireSelfPay: true, automated: true,
    }));
    const notice = await trx('inbound_payment_notices').where({ plaid_transaction_id: row.plaid_transaction_id }).first();
    expect(notice).toMatchObject({
      source: reconciler.BANK_SOURCE, email_id: null, status: 'auto_applied', match_method: 'amount_name',
      matched_invoice_id: invoiceId, matched_customer_id: customerId, payer_name: 'Quentin Zellefeedtest', amount_cents: 17329, applied_by: reconciler.RECORDED_BY,
    });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();

    expect(await reconciler.reconcileZelleBankFeed()).toMatchObject({ read: 0, decided: 0 });
    expect(recordManualPayment).toHaveBeenCalledTimes(1);
  });

  test('bank evidence: same Plaid transaction, still a credit, same cents, day and payer, no pending change — and it can be read under FOR SHARE', async () => {
    const { bank } = await linkAccounts();
    const row = await bankRow(bank);
    const notice = { plaid_transaction_id: row.plaid_transaction_id, amount_cents: 17329, payer_name: 'Quentin Zellefeedtest', received_at: todayStartET() };
    expect(await reconciler.bankEvidenceHolds(trx, notice)).toBe(true);
    expect(await reconciler.bankEvidenceHolds(trx, notice, { lock: true })).toBe(true);
    expect(await reconciler.bankEvidenceHolds(trx, { ...notice, amount_cents: 1700 })).toBe(false);
    expect(await reconciler.bankEvidenceHolds(trx, { ...notice, payer_name: 'Sam Roe' })).toBe(false);
    expect(await reconciler.bankEvidenceHolds(trx, { ...notice, received_at: new Date(todayStartET().getTime() - 24 * HOUR) })).toBe(false);
    expect(await reconciler.bankEvidenceHolds(trx, { ...notice, plaid_transaction_id: `ptx-${randomUUID()}` })).toBe(false);
    await trx('bank_transactions').where({ id: row.id }).update({ suggestion: JSON.stringify({ plaidRemoved: true }) });
    expect(await reconciler.bankEvidenceHolds(trx, notice)).toBe(false);
    expect(await reconciler.bankEvidenceHolds(trx, { plaid_transaction_id: null, amount_cents: 100 })).toBe(true); // an email notice has no bank row
  });

  test('the claim holds the bank row\'s lock and refuses a row the bank changed since the scan', async () => {
    const { bank } = await linkAccounts();
    const row = await bankRow(bank);
    const [scanned] = await reconciler._private.bankRowsToDecide(Date.now());
    const parsed = { payerName: 'Quentin Zellefeedtest', amountCents: 17329 };
    // The bank corrected the amount between the scan and the claim.
    await trx('bank_transactions').where({ id: row.id }).update({ amount: '17.29' });
    expect(await reconciler._private.claimBankNotice(scanned, parsed)).toBeNull();
    await trx('bank_transactions').where({ id: row.id }).update({ amount: '173.29' });
    const notice = await reconciler._private.claimBankNotice(scanned, parsed);
    expect(notice).toMatchObject({ plaid_transaction_id: row.plaid_transaction_id, status: 'processing', received_at: todayStartET() });
  });

  test('frozen evidence end to end: once a notice backs the row, a Plaid correction parks on it and a recorded payment raises the bank-change alert', async () => {
    const { bank } = await linkAccounts();
    const row = await bankRow(bank);
    const [noticeRow] = await trx('inbound_payment_notices').insert({
      plaid_transaction_id: row.plaid_transaction_id, source: reconciler.BANK_SOURCE, payer_name: 'Quentin Zellefeedtest', amount_cents: 17329,
      received_at: todayStartET(), status: 'auto_applied', applied_at: new Date(), applied_by: reconciler.RECORDED_BY,
    }).returning('id');
    const account = await trx('plaid_accounts').where({ account_id: bank }).first();
    const plaidSync = require('../services/plaid-sync');
    const corrected = {
      transaction_id: row.plaid_transaction_id, account_id: bank, amount: -17.29, date: etDateString(new Date()), pending: false, iso_currency_code: 'USD',
      name: 'Zelle', original_description: 'Zelle money received from QUENTIN ZELLEFEEDTEST',
    };
    expect(await plaidSync._private.applyChanges(trx, new Map([[bank, account]]), { upserts: [corrected], removedIds: [] }))
      .toMatchObject({ updated: 0, flagged: 1 });
    const kept = await trx('bank_transactions').where({ plaid_transaction_id: row.plaid_transaction_id });
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe(row.id); // never replaced under the notice
    expect(Number(kept[0].amount)).toBe(173.29);
    expect(kept[0].suggestion.plaidModified).toMatchObject({ amount: 17.29 });

    expect(await reconciler._private.alertChangedSettlements()).toBe(1);
    // A long payer name is shortened to fit the headline; the amount stays.
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('payment', "Billing — check the bank change on Quentin…'s $173.29 Zelle",
      expect.any(String), expect.objectContaining({ dedupeKey: `zelle-notice:${noticeRow.id}:bank-changed` }));

    // A withdrawal flags the row; it is never deleted under the notice.
    expect(await plaidSync._private.applyChanges(trx, new Map([[bank, account]]), { upserts: [], removedIds: [row.plaid_transaction_id] }))
      .toMatchObject({ deleted: 0, flagged: 1 });
    expect(await trx('bank_transactions').where({ id: row.id }).first('id')).toBeTruthy();
  });

  test('one notice per Plaid transaction, and every notice has exactly one source', async () => {
    const txnId = `ptx-${randomUUID()}`;
    const claim = () => trx('inbound_payment_notices')
      .insert({ plaid_transaction_id: txnId, source: reconciler.BANK_SOURCE, amount_cents: 100, received_at: new Date(), status: 'processing', claim_token: randomUUID() })
      .onConflict('plaid_transaction_id').ignore().returning('id');
    expect(await claim()).toHaveLength(1);
    expect(await claim()).toHaveLength(0);

    await trx.raw('SAVEPOINT no_source');
    await expect(trx('inbound_payment_notices').insert({ source: reconciler.BANK_SOURCE, amount_cents: 100, received_at: new Date(), status: 'processing' }))
      .rejects.toMatchObject({ code: '23514', constraint: 'inbound_payment_notices_one_source_check' });
    await trx.raw('ROLLBACK TO SAVEPOINT no_source');

    const [email] = await trx('emails').insert({
      gmail_id: `synthetic-${randomUUID()}`, gmail_thread_id: `synthetic-${randomUUID()}`, from_address: 'alerts@example.invalid', subject: 'synthetic', received_at: new Date(),
    }).returning('id');
    await trx.raw('SAVEPOINT two_sources');
    await expect(trx('inbound_payment_notices').insert({ email_id: email.id, plaid_transaction_id: `ptx-${randomUUID()}`, amount_cents: 100, received_at: new Date(), status: 'processing' }))
      .rejects.toMatchObject({ code: '23514' });
    await trx.raw('ROLLBACK TO SAVEPOINT two_sources');
  });

  test('the migration refuses to roll back over a bank-feed notice, and round-trips without one', async () => {
    const migration = require(`../models/migrations/${MIGRATION}`);
    await trx('inbound_payment_notices').insert({ plaid_transaction_id: `ptx-${randomUUID()}`, source: reconciler.BANK_SOURCE, amount_cents: 100, received_at: new Date(), status: 'ignored' });
    await expect(migration.down(trx)).rejects.toThrow(/cannot roll back: 1 bank-feed Zelle notice/);

    await trx('inbound_payment_notices').whereNotNull('plaid_transaction_id').del();
    await migration.down(trx);
    expect(await trx.schema.hasColumn('inbound_payment_notices', 'plaid_transaction_id')).toBe(false);
    expect(await trx.schema.hasColumn('bank_transactions', 'original_description')).toBe(false);
    const nullable = async () => (await trx('information_schema.columns').where({ table_name: 'inbound_payment_notices', column_name: 'email_id' }).first('is_nullable')).is_nullable;
    expect(await nullable()).toBe('NO');
    await migration.up(trx);
    await migration.up(trx); // idempotent
    expect(await trx.schema.hasColumn('inbound_payment_notices', 'plaid_transaction_id')).toBe(true);
    expect(await trx.schema.hasColumn('bank_transactions', 'original_description')).toBe(true);
    expect(await nullable()).toBe('YES');
  });
});
