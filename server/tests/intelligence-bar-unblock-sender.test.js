/**
 * IB unblock_sender (IB gap #6): the Email page's blocklist Unblock run in process behind a card, dark behind
 * GATE_IB_UNBLOCK_SENDER (needs GATE_IB_PLATFORM). What the card shows (address or domain, when and why it was blocked,
 * its block count, every effect), the refusals (not found, ambiguous), pin drift (before and inside the row lock),
 * gate off, admin only, and that the confirmed run goes through the SAME unblockSender the Email page route calls,
 * which removes the Gmail filter before the row and keeps the row when Gmail cannot remove the filter. The page's own
 * one-argument call keeps its behavior (bottom). A tiny in-memory knex stand-in and a fake Gmail are used; the lock
 * path against real Postgres is intelligence-bar-unblock-sender-postgres.test.js. Synthetic addresses only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockFilterDelete = jest.fn();
jest.mock('googleapis', () => ({
  google: { gmail: () => ({ users: { settings: { filters: { delete: (...a) => mockFilterDelete(...a), create: jest.fn() } } } }) },
}));
const mockGetAuthClient = jest.fn();
jest.mock('../services/email/gmail-client', () => ({ getAuthClient: (...a) => mockGetAuthClient(...a) }));

const db = require('../models/db');
const { executeUnblockSenderTool, UNBLOCK_SENDER_TOOLS, cardLines } = require('../services/intelligence-bar/unblock-sender-tools');
const spamBlocker = require('../services/email/spam-blocker');
const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const ROW = '00000000-0000-4000-8000-0000000000e1';
const OTHER_ROW = '00000000-0000-4000-8000-0000000000e2';
const ADMIN = { isAdmin: true, technicianId: 'staff-1' };

let S;
function freshState() {
  return {
    rows: [{
      id: ROW, email_address: 'promo@spam.example.invalid', domain: null, reason: 'spam_auto', blocked_count: 4,
      created_at: new Date('2026-10-01T16:30:00Z'), gmail_filter_id: 'filter-1',
    }],
    deleted: [],
    locks: [],
    beforeTx: null,
  };
}

function makeTable() {
  const q = { filters: [], rawEq: [], nullCols: [], single: false, del: false };
  const run = () => {
    const rows = S.rows.filter((r) => q.filters.every(([k, v]) => r[k] === v)
      && q.rawEq.every(([k, v]) => String(r[k] || '').toLowerCase() === v)
      && q.nullCols.every((k) => r[k] == null));
    if (q.del) {
      S.deleted.push(...rows.map((r) => r.id));
      S.rows = S.rows.filter((r) => !rows.includes(r));
      return rows.length;
    }
    return q.single ? rows[0] : rows;
  };
  const b = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve().then(run).then(res, rej);
      if (prop === 'first') return () => { q.single = true; return b; };
      if (prop === 'where') return (k) => { Object.entries(k).forEach((e) => q.filters.push(e)); return b; };
      if (prop === 'whereRaw') return (sql, [v]) => { q.rawEq.push([/domain/.test(sql) ? 'domain' : 'email_address', v]); return b; };
      if (prop === 'whereNull') return (k) => { q.nullCols.push(k); return b; };
      if (prop === 'forUpdate') return () => { S.locks.push('blocked_email_senders'); return b; };
      if (prop === 'del') return () => { q.del = true; return b; };
      if (['insert', 'update', 'upsert'].includes(prop)) throw new Error(`unexpected ${String(prop)}`);
      return () => b;
    },
  });
  return b;
}

function makeDb() {
  const fn = () => makeTable();
  fn.transaction = async (cb) => {
    const snapshot = { rows: S.rows.map((r) => ({ ...r })), deleted: [...S.deleted] };
    if (S.beforeTx) { const hook = S.beforeTx; S.beforeTx = null; hook(); }
    const trx = () => makeTable();
    try {
      return await cb(trx);
    } catch (err) {
      S.rows = snapshot.rows; S.deleted = snapshot.deleted;
      throw err;
    }
  };
  return fn;
}

function envGate(on) {
  if (on) { process.env.GATE_IB_UNBLOCK_SENDER = 'true'; process.env.GATE_IB_PLATFORM = 'true'; }
  else { delete process.env.GATE_IB_UNBLOCK_SENDER; delete process.env.GATE_IB_PLATFORM; }
}

const row = () => S.rows[0];
const preview = (input = { blocked_id: ROW }, ctx = ADMIN) => executeUnblockSenderTool('unblock_sender', input, ctx);
const confirm = (card, input = { blocked_id: ROW }, ctx = ADMIN) => executeUnblockSenderTool('unblock_sender',
  { ...input, confirmed: true, _verified_unblock_sender_version: card._version }, ctx);

beforeEach(() => {
  jest.clearAllMocks();
  S = freshState();
  const fake = makeDb();
  db.mockImplementation(fake);
  db.transaction = fake.transaction;
  mockGetAuthClient.mockResolvedValue({});
  mockFilterDelete.mockResolvedValue({});
  envGate(true);
});
afterEach(() => envGate(false));

describe('registration', () => {
  test('a two-step write, admin only, in the same email domain as block_sender', () => {
    expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has('unblock_sender')).toBe(true);
    expect(gates.UI_GATED_WRITE_TOOL_NAMES.has('unblock_sender')).toBe(true);
    expect(registry.actions.get('unblock_sender')).toMatchObject({ domain: 'email', role: 'admin', approval: 'ui_confirm', scope: 'route_wide', module: 'unblock-sender-tools.js' });
    expect(registry.actions.get('unblock_sender').domain).toBe(registry.actions.get('block_sender').domain);
    expect(registry.policyErrors).not.toContain('unblock_sender');
    expect(UNBLOCK_SENDER_TOOLS[0]._sideEffects).toBe(true);
  });

  test('offered wherever block_sender is offered while on; gone with either gate off; never for a technician', () => {
    const offered = (context) => registry.initialTools(context, { role: 'admin', fullAccess: false }).map((d) => d.name);
    for (const context of ['email', 'comms', 'dashboard', 'customers', 'schedule']) {
      expect(offered(context).includes('unblock_sender')).toBe(offered(context).includes('block_sender'));
    }
    expect(offered('email')).toEqual(expect.arrayContaining(['block_sender', 'unblock_sender']));
    delete process.env.GATE_IB_UNBLOCK_SENDER;
    expect(offered('email')).not.toContain('unblock_sender');
    envGate(true);
    delete process.env.GATE_IB_PLATFORM;
    expect(registry.allowed(registry.actions.get('unblock_sender'), { role: 'admin', context: 'email' })).toBe(false);
    envGate(true);
    expect(registry.allowed(registry.actions.get('unblock_sender'), { role: 'technician', context: 'tech' })).toBe(false);
  });

  test('discoverable by the operator\'s words', () => {
    for (const query of ['unblock a sender', 'take this domain off the blocklist']) {
      const { definitions } = registry.discover({ query }, { role: 'admin', context: 'email', fullAccess: false });
      expect(definitions.map((d) => d.name)).toContain('unblock_sender');
    }
  });
});

describe('gate and login', () => {
  test('gate off: every call refuses and nothing is touched', async () => {
    envGate(false);
    expect(await preview()).toMatchObject({ code: 'gate_off' });
    expect(await executeUnblockSenderTool('unblock_sender', { blocked_id: ROW, confirmed: true, _verified_unblock_sender_version: {} }, ADMIN)).toMatchObject({ code: 'gate_off' });
    expect(mockFilterDelete).not.toHaveBeenCalled();
    expect(S.deleted).toEqual([]);
  });

  test('a non-admin is refused, and a confirmed run needs a positive admin flag', async () => {
    expect(await preview(undefined, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    const card = await preview();
    expect(await confirm(card, undefined, {})).toMatchObject({ code: 'permission_denied' });
    expect(mockFilterDelete).not.toHaveBeenCalled();
  });
});

describe('the preview', () => {
  test('shows the address, when and why it was blocked, its block count, and every effect; writes nothing', async () => {
    const card = await preview();
    expect(card).toMatchObject({
      preview: true, tool: 'unblock_sender', blocked_id: ROW, blocked_target: 'promo@spam.example.invalid', scope: 'one sender address',
      reason: 'the automatic spam check', blocked_count: 4, gmail_filter: 'on file', sends_to_customer: false,
    });
    expect(card.blocked_on_et).toBe('October 1, 2026, 12:30 PM ET');
    const text = card.effects.map((e) => e.text).join('\n');
    expect(text).toMatch(/The Gmail filter that sends promo@spam\.example\.invalid to Trash is removed/);
    expect(text).toMatch(/blocklist entry for promo@spam\.example\.invalid is deleted/);
    expect(text).toMatch(/no longer auto-trashed/);
    expect(text).toMatch(/Mail already in Trash stays there/);
    expect(text).toMatch(/nothing changes and the sender stays blocked/);
    expect(text).toMatch(/spam check can block this address again/);
    expect(text).toMatch(/Nothing is sent/);
    expect(S.deleted).toEqual([]);
    expect(mockFilterDelete).not.toHaveBeenCalled();
    expect(cardLines('unblock_sender', card).map((l) => l.text)).toEqual(expect.arrayContaining([
      'Unblock promo@spam.example.invalid (one sender address)',
      'Blocked October 1, 2026, 12:30 PM ET, by the automatic spam check',
      'The block has caught 4 messages. Gmail filter: on file.',
    ]));
    const contract = buildContract({ toolName: 'unblock_sender', params: { blocked_id: ROW }, displayParams: {}, preview: card, summary: 'x' });
    expect(JSON.stringify(contract)).toMatch(/Nothing is sent/);
    expect(contract.irreversible).toBe(false);
  });

  test('a domain block and a block with no Gmail filter are described as they are', async () => {
    S.rows = [{ ...row(), email_address: null, domain: 'spam.example.invalid', reason: 'Manual block (Intelligence Bar)', blocked_count: 1, gmail_filter_id: null }];
    const card = await preview({ domain: '@Spam.Example.Invalid' });
    expect(card).toMatchObject({ blocked_target: '@spam.example.invalid', scope: 'a whole domain', reason: 'Manual block (Intelligence Bar)', gmail_filter: 'none on file' });
    const text = card.effects.map((e) => e.text).join('\n');
    expect(text).toMatch(/No Gmail filter is on file for this block, so only the blocklist entry is deleted/);
    expect(text).toMatch(/any sender at @spam\.example\.invalid/);
    expect(text).not.toMatch(/spam check can block this address again/);
    expect(cardLines('unblock_sender', card).map((l) => l.text)).toContain('The block has caught 1 message. Gmail filter: none on file.');
  });

  test('the route builds the confirmation card from this preview', async () => {
    const { confirmationDisplayParams } = jest.requireActual('../routes/admin-intelligence-bar');
    expect(confirmationDisplayParams('unblock_sender', { blocked_id: ROW }, await preview())).toEqual({
      unblock: 'promo@spam.example.invalid', scope: 'one sender address', blocked_before: 'the automatic spam check', messages_caught: 4, sends_to_customer: 'nothing',
    });
  });

  test('selectors: exactly one; by address or domain; not found; ambiguous', async () => {
    expect(await preview({})).toMatchObject({ code: 'invalid_target' });
    expect(await preview({ blocked_id: ROW, domain: 'x.example.invalid' })).toMatchObject({ code: 'invalid_target' });
    expect(await preview({ blocked_id: 'nope' })).toMatchObject({ code: 'invalid_target' });
    expect(await preview({ blocked_id: OTHER_ROW })).toMatchObject({ code: 'block_not_found' });
    expect(await preview({ email_address: ' PROMO@spam.example.invalid ' })).toMatchObject({ preview: true, blocked_id: ROW });
    expect(await preview({ email_address: 'nobody@spam.example.invalid' })).toMatchObject({ code: 'block_not_found' });
    S.rows.push({ ...row(), id: OTHER_ROW });
    expect(await preview({ email_address: 'promo@spam.example.invalid' })).toMatchObject({ code: 'ambiguous_block' });
  });
});

describe('the confirmed run', () => {
  test('removes the Gmail filter, then the row, once, under a row lock', async () => {
    const card = await preview();
    const done = await confirm(card);
    expect(done).toMatchObject({ success: true, sent_to_customer: false, blocked_id: ROW });
    expect(done.note).toMatch(/promo@spam\.example\.invalid is unblocked\. Its Gmail trash filter is removed\./);
    expect(S.locks).toContain('blocked_email_senders');
    expect(mockFilterDelete).toHaveBeenCalledTimes(1);
    expect(mockFilterDelete).toHaveBeenCalledWith({ userId: 'me', id: 'filter-1' });
    expect(S.deleted).toEqual([ROW]);
  });

  test('a row with no Gmail filter is deleted without touching Gmail', async () => {
    row().gmail_filter_id = null;
    const card = await preview();
    expect(await confirm(card)).toMatchObject({ success: true });
    expect(mockFilterDelete).not.toHaveBeenCalled();
    expect(mockGetAuthClient).not.toHaveBeenCalled();
    expect(S.deleted).toEqual([ROW]);
  });

  test('no pin refuses; a different entry than the card pinned is refused', async () => {
    expect(await executeUnblockSenderTool('unblock_sender', { blocked_id: ROW, confirmed: true }, ADMIN)).toMatchObject({ code: 'approval_required' });
    const card = await preview();
    S.rows.push({ ...row(), id: OTHER_ROW, email_address: 'other@spam.example.invalid' });
    expect(await confirm(card, { blocked_id: OTHER_ROW })).toMatchObject({ code: 'preview_changed', preview_changed: true });
    expect(mockFilterDelete).not.toHaveBeenCalled();
    expect(S.deleted).toEqual([]);
  });

  test.each([
    ['the block count moved', () => { row().blocked_count = 5; }],
    ['the reason changed', () => { row().reason = 'Manual block'; }],
    ['the Gmail filter was replaced', () => { row().gmail_filter_id = 'filter-2'; }],
    ['the row was re-created (new time)', () => { row().created_at = new Date('2026-10-02T00:00:00Z'); }],
  ])('%s after the card: refused before Gmail is touched, nothing written', async (_label, change) => {
    const card = await preview();
    change();
    expect(await confirm(card)).toMatchObject({ code: 'preview_changed', preview_changed: true });
    expect(mockFilterDelete).not.toHaveBeenCalled();
    expect(S.deleted).toEqual([]);
  });

  test('gone after the card: refused, nothing written', async () => {
    const card = await preview();
    S.rows = [];
    expect(await confirm(card)).toMatchObject({ code: 'block_not_found', preview_changed: true });
    expect(mockFilterDelete).not.toHaveBeenCalled();
  });

  test('a change that lands between the pre-check and the row lock is refused inside the transaction', async () => {
    const card = await preview();
    S.beforeTx = () => { row().blocked_count = 9; };
    expect(await confirm(card)).toMatchObject({ failed: true, code: 'preview_changed', preview_changed: true });
    expect(mockFilterDelete).not.toHaveBeenCalled();
    expect(S.deleted).toEqual([]);
    row().blocked_count = 4;
    S.beforeTx = () => { S.rows = []; };
    expect(await confirm(card)).toMatchObject({ failed: true, code: 'preview_changed' });
    expect(mockFilterDelete).not.toHaveBeenCalled();
  });

  test('Gmail not connected, or a Gmail failure: the sender stays blocked and the card says so', async () => {
    const card = await preview();
    mockGetAuthClient.mockResolvedValueOnce(null);
    expect(await confirm(card)).toMatchObject({ failed: true, code: 'unblock_refused' });
    mockFilterDelete.mockRejectedValueOnce(Object.assign(new Error('quota'), { code: 500 }));
    const refused = await confirm(card);
    expect(refused).toMatchObject({ failed: true, code: 'unblock_refused' });
    expect(refused.error).toMatch(/It is still blocked\.$/);
    expect(S.deleted).toEqual([]);
    expect(S.rows).toHaveLength(1);
  });

  test('a filter Gmail already lost counts as removed', async () => {
    const card = await preview();
    mockFilterDelete.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 404 }));
    expect(await confirm(card)).toMatchObject({ success: true });
    expect(S.deleted).toEqual([ROW]);
  });

  test('an unknown failure is outcome_unknown unless the entry is gone', async () => {
    const card = await preview();
    const spy = jest.spyOn(spamBlocker, 'unblockSender').mockRejectedValueOnce(new Error('boom'));
    expect(await confirm(card)).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    spy.mockImplementationOnce(async () => { S.rows = []; throw new Error('late failure'); });
    expect(await confirm(card)).toMatchObject({ success: true, warning: true });
    spy.mockRestore();
  });
});

describe('the Email page route keeps its behavior (one-argument unblockSender)', () => {
  test('no lock, no card: reads, removes the filter, deletes the row', async () => {
    expect(await spamBlocker.unblockSender(ROW)).toEqual({ success: true, unblocked: 'promo@spam.example.invalid' });
    expect(S.locks).toEqual([]);
    expect(mockFilterDelete).toHaveBeenCalledWith({ userId: 'me', id: 'filter-1' });
    expect(S.deleted).toEqual([ROW]);
  });

  test('not found, Gmail not connected and a Gmail failure answer as before', async () => {
    expect(await spamBlocker.unblockSender(OTHER_ROW)).toEqual({ error: 'Not found' });
    mockGetAuthClient.mockResolvedValueOnce(null);
    expect(await spamBlocker.unblockSender(ROW)).toEqual({ error: 'Gmail not connected — filter cannot be removed; retry after reconnecting' });
    mockFilterDelete.mockRejectedValueOnce(Object.assign(new Error('quota'), { code: 500 }));
    expect(await spamBlocker.unblockSender(ROW)).toEqual({ error: 'Gmail filter removal failed — sender is still blocked; retry the unblock' });
    expect(S.deleted).toEqual([]);
  });

  test('the DELETE /blocked/:id route still calls unblockSender with the id alone', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-email.js'), 'utf8');
    const start = source.indexOf("router.delete('/blocked/:id'");
    const route = source.slice(start, source.indexOf('\n});\n', start));
    expect(route).toContain('await unblockSender(req.params.id)');
    expect(route).toContain('res.status(502)');
  });
});
