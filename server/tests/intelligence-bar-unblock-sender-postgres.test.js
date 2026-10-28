/**
 * IB unblock_sender against real Postgres (committed fixture rows, cleaned up), Gmail mocked: the confirmed run goes
 * through unblockSender, which reads the blocklist row FOR UPDATE inside its own transaction and compares it to the
 * card BEFORE the Gmail filter is touched. A row changed or removed by someone else (even while the confirm waits for
 * the lock) refuses with preview_changed, deletes nothing and never calls Gmail; a Gmail failure keeps the row; the
 * Email page's one-argument call still works on real rows. Synthetic addresses only.
 */
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockFilterDelete = jest.fn();
jest.mock('googleapis', () => ({
  google: { gmail: () => ({ users: { settings: { filters: { delete: (...a) => mockFilterDelete(...a), create: jest.fn() } } } }) },
}));
const mockGetAuthClient = jest.fn();
jest.mock('../services/email/gmail-client', () => ({ getAuthClient: (...a) => mockGetAuthClient(...a) }));

const LOCAL = (() => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname); } catch { return false; } })();

(SKIP || !LOCAL ? describe.skip : describe)('IB unblock_sender (real PG)', () => {
  let db;
  let executeUnblockSenderTool;
  let spamBlocker;
  const created = [];

  beforeAll(() => {
    process.env.GATE_IB_UNBLOCK_SENDER = 'true';
    process.env.GATE_IB_PLATFORM = 'true';
    db = require('../models/db');
    ({ executeUnblockSenderTool } = require('../services/intelligence-bar/unblock-sender-tools'));
    spamBlocker = require('../services/email/spam-blocker');
  });

  afterAll(async () => {
    delete process.env.GATE_IB_UNBLOCK_SENDER;
    delete process.env.GATE_IB_PLATFORM;
    if (!db) return;
    if (created.length) await db('blocked_email_senders').whereIn('id', created).del();
    await db.destroy();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthClient.mockResolvedValue({});
    mockFilterDelete.mockResolvedValue({});
  });

  async function block(fields = {}) {
    const [row] = await db('blocked_email_senders').insert({
      email_address: `fixture-${randomUUID().slice(0, 8)}@spam.example.invalid`, domain: null, gmail_filter_id: 'fixture-filter',
      reason: 'spam_auto', blocked_count: 3, ...fields,
    }).returning('*');
    created.push(row.id);
    return row;
  }

  const ADMIN = { isAdmin: true, technicianId: null };
  const card = (blockedId) => executeUnblockSenderTool('unblock_sender', { blocked_id: blockedId }, ADMIN);
  const confirm = (blockedId, preview) => executeUnblockSenderTool('unblock_sender', { blocked_id: blockedId, confirmed: true, _verified_unblock_sender_version: preview._version }, ADMIN);
  const exists = async (id) => Boolean(await db('blocked_email_senders').where({ id }).first('id'));
  const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

  test('the card removes the Gmail filter, then deletes the row', async () => {
    const row = await block();
    const preview = await card(row.id);
    expect(preview).toMatchObject({ preview: true, blocked_target: row.email_address, blocked_count: 3, gmail_filter: 'on file' });
    expect(await exists(row.id)).toBe(true);
    expect(await confirm(row.id, preview)).toMatchObject({ success: true, sent_to_customer: false });
    expect(mockFilterDelete).toHaveBeenCalledTimes(1);
    expect(mockFilterDelete).toHaveBeenCalledWith({ userId: 'me', id: 'fixture-filter' });
    expect(await exists(row.id)).toBe(false);
  });

  test('a domain block is found by its domain and unblocked', async () => {
    const row = await block({ email_address: null, domain: `fixture-${randomUUID().slice(0, 8)}.example.invalid`, gmail_filter_id: null });
    const preview = await executeUnblockSenderTool('unblock_sender', { domain: row.domain.toUpperCase() }, ADMIN);
    expect(preview).toMatchObject({ preview: true, blocked_id: row.id, scope: 'a whole domain', gmail_filter: 'none on file' });
    expect(await confirm(row.id, preview)).toMatchObject({ success: true });
    expect(mockFilterDelete).not.toHaveBeenCalled();
    expect(await exists(row.id)).toBe(false);
  });

  test.each([
    ['the block count moved', (id) => db('blocked_email_senders').where({ id }).update({ blocked_count: 8 })],
    ['the Gmail filter was replaced', (id) => db('blocked_email_senders').where({ id }).update({ gmail_filter_id: 'other-filter' })],
    ['the row was removed', (id) => db('blocked_email_senders').where({ id }).del()],
  ])('%s after the card: refused, Gmail untouched', async (_label, change) => {
    const row = await block();
    const preview = await card(row.id);
    await change(row.id);
    expect(await confirm(row.id, preview)).toMatchObject({ preview_changed: true });
    expect(mockFilterDelete).not.toHaveBeenCalled();
  });

  test('a change landing in the gap between the pre-check and the lock (another admin holds the row): waits, then refuses, Gmail untouched', async () => {
    const row = await block();
    const preview = await card(row.id);
    let confirmDone = false;
    let confirming;
    await db.transaction(async (trx) => {
      await trx('blocked_email_senders').where({ id: row.id }).forUpdate().first();
      confirming = confirm(row.id, preview).then((r) => { confirmDone = true; return r; });
      await settle(400);
      expect(confirmDone).toBe(false);
      await trx('blocked_email_senders').where({ id: row.id }).update({ gmail_filter_id: 'replaced-filter' });
    });
    expect(await confirming).toMatchObject({ failed: true, code: 'preview_changed', preview_changed: true });
    expect(mockFilterDelete).not.toHaveBeenCalled();
    expect(await exists(row.id)).toBe(true);
  });

  test('another admin deleting the row while the confirm waits: refused, nothing deleted twice, Gmail untouched', async () => {
    const row = await block();
    const preview = await card(row.id);
    let confirming;
    await db.transaction(async (trx) => {
      await trx('blocked_email_senders').where({ id: row.id }).forUpdate().first();
      confirming = confirm(row.id, preview);
      await settle(300);
      await trx('blocked_email_senders').where({ id: row.id }).del();
    });
    expect(await confirming).toMatchObject({ failed: true, code: 'preview_changed' });
    expect(mockFilterDelete).not.toHaveBeenCalled();
  });

  test('Gmail cannot remove the filter: the row stays and the card says the sender is still blocked', async () => {
    const row = await block();
    const preview = await card(row.id);
    mockFilterDelete.mockRejectedValueOnce(Object.assign(new Error('quota'), { code: 500 }));
    expect(await confirm(row.id, preview)).toMatchObject({ failed: true, code: 'unblock_refused' });
    expect(await exists(row.id)).toBe(true);
    mockGetAuthClient.mockResolvedValueOnce(null);
    expect(await confirm(row.id, preview)).toMatchObject({ failed: true, code: 'unblock_refused' });
    expect(await exists(row.id)).toBe(true);
  });

  test('the Email page call (one argument, no card) still unblocks a real row', async () => {
    const row = await block();
    expect(await spamBlocker.unblockSender(row.id)).toEqual({ success: true, unblocked: row.email_address });
    expect(await exists(row.id)).toBe(false);
    expect(await spamBlocker.unblockSender(row.id)).toEqual({ error: 'Not found' });
  });
});
