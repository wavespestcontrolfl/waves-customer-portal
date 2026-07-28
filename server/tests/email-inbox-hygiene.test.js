/**
 * Hands-off email agent upgrade (owner directive 2026-07-28): spam gets a
 * 24h quarantine window instead of an instant trash, known senders
 * (customers/leads/vendors/partners) can never be a destructive target,
 * legit bulk mail gets unsubscribed at the source, Gmail's spam folder is
 * swept for buried known-sender mail, and unanswered conversation mail
 * surfaces as digest nudges. Auto-drafted replies are gated
 * (GATE_EMAIL_AUTO_DRAFTS) and NEVER send.
 */

jest.mock('googleapis', () => ({ google: {} }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email/gmail-client', () => ({
  trashMessage: jest.fn(),
  archiveMessage: jest.fn(),
  modifyLabels: jest.fn(),
  ensureLabel: jest.fn(async () => 'Label_42'),
  getAuthClient: jest.fn(async () => null),
  listMessages: jest.fn(async () => []),
  getMessage: jest.fn(),
  getThread: jest.fn(),
  getMessageLabels: jest.fn(async () => ['Label_42']),
  createDraft: jest.fn(async () => ({ id: 'draft-1' })),
}));
jest.mock('../services/email/auto-unsubscribe', () => ({
  autoUnsubscribe: jest.fn(async () => ({ method: 'list_header_url' })),
}));
jest.mock('../services/llm/call', () => ({
  dispatchWithFallback: jest.fn(async () => ({ ok: true, text: 'Hi Jane,\n\nHappy to help with that.' })),
}));

const db = require('../models/db');
const gmailClient = require('../services/email/gmail-client');
const { autoUnsubscribe } = require('../services/email/auto-unsubscribe');
const { dispatchWithFallback } = require('../services/llm/call');

const CHAIN_METHODS = [
  'where', 'orWhere', 'whereRaw', 'orWhereRaw', 'whereNot', 'whereNotIn',
  'whereIn', 'whereNull', 'whereNotNull', 'whereILike', 'andWhereILike',
  'whereBetween', 'orderBy', 'limit',
];

/** Chainable knex mock — per-table FIFO first() queues, select() resolves rows. */
function setupDb(firstResults = {}, selectResults = {}, updateResults = {}) {
  const state = { inserts: [], updates: [], updateFilters: [] };
  const firstQueues = Object.fromEntries(Object.entries(firstResults).map(([t, rows]) => [t, [...rows]]));
  const selectQueues = Object.fromEntries(Object.entries(selectResults).map(([t, rows]) => [t, [...rows]]));
  const updateQueues = Object.fromEntries(Object.entries(updateResults).map(([t, rows]) => [t, [...rows]]));

  db.mockImplementation((table) => {
    const builder = {};
    const filters = [];
    for (const method of CHAIN_METHODS) {
      builder[method] = jest.fn((...args) => {
        if (typeof args[0] === 'function') args[0].call(builder);
        else filters.push({ method, args });
        return builder;
      });
    }
    builder.first = jest.fn(async () => {
      const q = firstQueues[table];
      return q && q.length ? q.shift() : null;
    });
    builder.select = jest.fn(async () => {
      const q = selectQueues[table];
      return q && q.length ? q.shift() : [];
    });
    builder.update = jest.fn(async (patch) => {
      state.updates.push({ table, patch });
      state.updateFilters.push({ table, filters: [...filters] });
      const q = updateQueues[table];
      return q && q.length ? q.shift() : 1;
    });
    builder.insert = jest.fn((row) => {
      state.inserts.push({ table, row });
      const promise = Promise.resolve([{ id: 'new-1', ...row }]);
      return { returning: jest.fn(async () => [{ id: 'new-1', ...row }]), then: promise.then.bind(promise), catch: promise.catch.bind(promise) };
    });
    return builder;
  });
  return state;
}

const EMAIL = {
  id: 'email-1',
  gmail_id: 'g-1',
  gmail_thread_id: 'thread-1',
  from_address: 'coldpitch@seo-blaster.example',
  from_name: 'Cold Pitch',
  subject: 'rank #1 on google',
  body_text: 'we make you rank',
  list_unsubscribe: null,
  draft_gmail_id: null,
};

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_EMAIL_AUTO_DRAFTS;
});

describe('handleSpam — quarantine + known-sender guard', () => {
  const { handleSpam } = require('../services/email/email-actions');

  test('quarantines unknown spam (label swap, stamp); the sender block WAITS for the sweep', async () => {
    const state = setupDb();
    await handleSpam({ ...EMAIL });
    expect(gmailClient.ensureLabel).toHaveBeenCalledWith('Quarantine');
    expect(gmailClient.modifyLabels).toHaveBeenCalledWith('g-1', ['Label_42'], ['INBOX']);
    expect(gmailClient.trashMessage).not.toHaveBeenCalled();
    const patch = state.updates.find((u) => u.table === 'emails')?.patch;
    expect(patch.auto_action).toBe('spam_quarantined');
    expect(patch.quarantined_at).toBeInstanceOf(Date);
    // no persistent block during the undo window
    expect(state.inserts.find((i) => i.table === 'blocked_email_senders')).toBeUndefined();
  });

  test('a known customer sender is never quarantined — marked important instead', async () => {
    const state = setupDb({ customers: [{ id: 'cust-1', email: 'jane@customer.example' }] });
    await handleSpam({ ...EMAIL, from_address: 'jane@customer.example' });
    expect(gmailClient.modifyLabels).toHaveBeenCalledWith('g-1', ['IMPORTANT'], []);
    expect(gmailClient.ensureLabel).not.toHaveBeenCalled();
    expect(gmailClient.trashMessage).not.toHaveBeenCalled();
    expect(state.updates.find((u) => u.table === 'emails').patch.auto_action)
      .toBe('spam_skipped_known_customer');
  });

  test('a live lead sender is protected the same way', async () => {
    setupDb({ leads: [{ id: 'lead-1', email: 'prospect@new.example' }] });
    await handleSpam({ ...EMAIL, from_address: 'prospect@new.example' });
    expect(gmailClient.ensureLabel).not.toHaveBeenCalled();
    expect(gmailClient.trashMessage).not.toHaveBeenCalled();
  });

  test('spam WITH a List-Unsubscribe header gets unsubscribed before quarantine', async () => {
    setupDb();
    await handleSpam({ ...EMAIL, list_unsubscribe: '<https://esp.example/unsub>' });
    expect(autoUnsubscribe).toHaveBeenCalled();
    expect(gmailClient.ensureLabel).toHaveBeenCalledWith('Quarantine');
  });

  test('cold spam without the header is never unsubscribed (no live-address confirmation)', async () => {
    setupDb();
    await handleSpam({ ...EMAIL });
    expect(autoUnsubscribe).not.toHaveBeenCalled();
  });

  test('falls back to trash + immediate block when the quarantine label API fails', async () => {
    const state = setupDb();
    gmailClient.ensureLabel.mockRejectedValueOnce(new Error('labels down'));
    await handleSpam({ ...EMAIL });
    expect(gmailClient.trashMessage).toHaveBeenCalledWith('g-1');
    // no undo window exists on this path, so the block is immediate
    expect(state.inserts.find((i) => i.table === 'blocked_email_senders')).toBeDefined();
  });
});

describe('sweepQuarantine', () => {
  const { sweepQuarantine } = require('../services/email/inbox-hygiene');

  test('claims atomically, trashes aged rows, and blocks the sender only at commit', async () => {
    const state = setupDb({}, { emails: [[{ id: 'e-old', gmail_id: 'g-old', from_address: 'coldpitch@seo-blaster.example' }]] });
    const result = await sweepQuarantine(new Date('2026-07-28T12:00:00Z'));
    expect(gmailClient.trashMessage).toHaveBeenCalledWith('g-old');
    expect(result.trashed).toBe(1);
    const actions = state.updates.filter((u) => u.table === 'emails').map((u) => u.patch.auto_action);
    // claim BEFORE the destructive call, settle after
    expect(actions).toEqual(['spam_trashing', 'spam_trashed_after_quarantine']);
    // the deferred persistent block lands with the commit
    expect(state.inserts.find((i) => i.table === 'blocked_email_senders')).toBeDefined();
  });

  test('an operator label-restore vetoes the trash — state cleared, message kept', async () => {
    const state = setupDb({}, { emails: [[{ id: 'e-back', gmail_id: 'g-back' }]] });
    gmailClient.getMessageLabels.mockResolvedValueOnce(['INBOX']);
    const result = await sweepQuarantine(new Date('2026-07-28T12:00:00Z'));
    expect(gmailClient.trashMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ trashed: 0, restored: 1 });
    const patch = state.updates.find((u) => u.table === 'emails').patch;
    expect(patch.auto_action).toBe('quarantine_restored');
    expect(patch.quarantined_at).toBeNull();
  });

  test('a failed trash releases the claim and never aborts the sweep', async () => {
    const state = setupDb({}, { emails: [[{ id: 'e-1', gmail_id: 'g-1' }, { id: 'e-2', gmail_id: 'g-2' }]] });
    gmailClient.trashMessage.mockRejectedValueOnce(new Error('gone'));
    const result = await sweepQuarantine();
    expect(result.trashed).toBe(1);
    expect(gmailClient.trashMessage).toHaveBeenCalledTimes(2);
    const actions = state.updates.filter((u) => u.table === 'emails').map((u) => u.patch.auto_action);
    expect(actions).toContain('spam_quarantined'); // claim released for retry
  });
});

describe('rescueSpamFolder', () => {
  const { rescueSpamFolder } = require('../services/email/inbox-hygiene');

  test('moves a known customer out of SPAM, marks important, rings the bell', async () => {
    const state = setupDb({ customers: [{ id: 'cust-1', email: 'jane@customer.example' }] });
    gmailClient.listMessages.mockResolvedValueOnce([{ id: 'spam-1' }]);
    gmailClient.getMessage.mockResolvedValueOnce({
      from_address: 'jane@customer.example',
      from_name: 'Jane',
      subject: 'Where is my report?',
      authentication_results: 'mx.google.com; dkim=pass header.i=@customer.example header.d=customer.example; spf=pass smtp.mailfrom=jane@customer.example',
    });
    const counts = await rescueSpamFolder();
    expect(gmailClient.modifyLabels).toHaveBeenCalledWith('spam-1', ['INBOX', 'IMPORTANT'], ['SPAM']);
    expect(counts).toEqual({ scanned: 1, rescued: 1, customers: 1, unauthenticated: 0 });
    expect(state.inserts.find((i) => i.table === 'notifications').row.category).toBe('email_rescue');
  });

  test('a spoofed known sender (no aligned auth) is NEVER rescued — review bell instead', async () => {
    const state = setupDb({ customers: [{ id: 'cust-1', email: 'jane@customer.example' }] });
    gmailClient.listMessages.mockResolvedValueOnce([{ id: 'spam-3' }]);
    gmailClient.getMessage.mockResolvedValueOnce({
      from_address: 'jane@customer.example',
      from_name: 'Jane',
      subject: 'urgent wire transfer',
      authentication_results: 'mx.google.com; spf=fail smtp.mailfrom=attacker.example; dkim=none',
    });
    const counts = await rescueSpamFolder();
    expect(gmailClient.modifyLabels).not.toHaveBeenCalled();
    expect(counts.rescued).toBe(0);
    expect(counts.unauthenticated).toBe(1);
    expect(state.inserts.find((i) => i.table === 'notifications').row.category).toBe('email_rescue_review');
  });

  test('unknown senders stay in SPAM', async () => {
    setupDb();
    gmailClient.listMessages.mockResolvedValueOnce([{ id: 'spam-2' }]);
    gmailClient.getMessage.mockResolvedValueOnce({ from_address: 'junk@blaster.example' });
    const counts = await rescueSpamFolder();
    expect(gmailClient.modifyLabels).not.toHaveBeenCalled();
    expect(counts.rescued).toBe(0);
  });
});

describe('collectUnansweredNudges', () => {
  const { collectUnansweredNudges } = require('../services/email/inbox-hygiene');

  test('several messages in one unanswered thread produce ONE nudge (latest inbound)', async () => {
    setupDb({}, {
      emails: [[
        { id: 'e-1', gmail_thread_id: 't-same', from_address: 'a@x.example', subject: 'first ping', received_at: '2026-07-23T12:00:00Z' },
        { id: 'e-2', gmail_thread_id: 't-same', from_address: 'a@x.example', subject: 'second ping', received_at: '2026-07-24T12:00:00Z' },
      ]],
    });
    gmailClient.getThread.mockResolvedValue({ messages: [{ labelIds: ['INBOX'], internalDate: '0' }] });
    const nudges = await collectUnansweredNudges(new Date('2026-07-28T12:00:00Z'));
    expect(nudges).toHaveLength(1);
    expect(nudges[0].id).toBe('e-2'); // the thread's latest inbound message
  });

  test('returns threads with no SENT message after the inbound mail; skips answered ones', async () => {
    setupDb({}, {
      emails: [[
        { id: 'e-a', gmail_thread_id: 't-a', from_address: 'a@x.example', subject: 'A', received_at: '2026-07-24T12:00:00Z' },
        { id: 'e-b', gmail_thread_id: 't-b', from_address: 'b@x.example', subject: 'B', received_at: '2026-07-24T12:00:00Z' },
      ]],
    });
    gmailClient.getThread.mockImplementation(async (threadId) => (threadId === 't-a'
      ? { messages: [{ labelIds: ['SENT'], internalDate: String(new Date('2026-07-25T12:00:00Z').getTime()) }] }
      : { messages: [{ labelIds: ['INBOX'], internalDate: String(new Date('2026-07-24T12:00:00Z').getTime()) }] }));
    const nudges = await collectUnansweredNudges(new Date('2026-07-28T12:00:00Z'));
    expect(nudges.map((n) => n.id)).toEqual(['e-b']);
  });
});

describe('draftReplyForEmail (GATE_EMAIL_AUTO_DRAFTS)', () => {
  const { draftReplyForEmail } = require('../services/email/email-actions');

  const CUSTOMER_EMAIL = {
    ...EMAIL,
    from_address: 'jane@customer.example',
    from_name: 'Jane Customer',
    subject: 'Can you come Friday?',
    body_text: 'Can you come Friday instead of Monday?',
    message_id: '<inbound-123@mail.example>',
  };

  test('gate off → no draft, no LLM call', async () => {
    setupDb();
    const result = await draftReplyForEmail({ ...CUSTOMER_EMAIL });
    expect(result).toBeNull();
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(gmailClient.createDraft).not.toHaveBeenCalled();
  });

  test('gate on → drafts into the thread and records draft_gmail_id; never sends', async () => {
    process.env.GATE_EMAIL_AUTO_DRAFTS = 'true';
    const state = setupDb();
    const result = await draftReplyForEmail({ ...CUSTOMER_EMAIL }, { customer: { first_name: 'Jane' } });
    expect(result).toBe('draft-1');
    expect(gmailClient.createDraft).toHaveBeenCalledWith(
      'jane@customer.example',
      'Re: Can you come Friday?',
      expect.stringContaining('<p>'),
      'thread-1',
      '<inbound-123@mail.example>'
    );
    // claim first ('pending'), then the settled draft id
    const draftPatches = state.updates.filter((u) => u.table === 'emails').map((u) => u.patch.draft_gmail_id);
    expect(draftPatches).toEqual(['pending', 'draft-1']);
  });

  test('the Postgres claim (not stale memory) is the dedup guard — lost claim means no draft', async () => {
    process.env.GATE_EMAIL_AUTO_DRAFTS = 'true';
    // claim update returns 0: another worker (or a prior classification pass)
    // already holds/held the claim, even though the in-memory row looks free.
    // both the NULL->pending claim and the stale-takeover lose
    setupDb({}, {}, { emails: [0, 0] });
    const result = await draftReplyForEmail({ ...CUSTOMER_EMAIL, draft_gmail_id: null });
    expect(result).toBeNull();
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(gmailClient.createDraft).not.toHaveBeenCalled();
  });

  test('an ambiguous createDraft failure keeps the claim for reconcile (no duplicate on retry)', async () => {
    process.env.GATE_EMAIL_AUTO_DRAFTS = 'true';
    const state = setupDb();
    gmailClient.createDraft.mockRejectedValueOnce(new Error('socket hang up'));
    const result = await draftReplyForEmail({ ...CUSTOMER_EMAIL });
    expect(result).toBeNull();
    const patches = state.updates.filter((u) => u.table === 'emails').map((u) => u.patch.draft_gmail_id);
    expect(patches).toEqual(['pending']); // claim NOT released
  });

  test('a stale pending claim reconciles against the live thread instead of duplicating', async () => {
    process.env.GATE_EMAIL_AUTO_DRAFTS = 'true';
    // first claim (NULL->pending) loses, stale takeover wins
    const state = setupDb({}, {}, { emails: [0, 1, 1] });
    gmailClient.getThread.mockResolvedValueOnce({ messages: [{ labelIds: ['DRAFT'] }] });
    const result = await draftReplyForEmail({ ...CUSTOMER_EMAIL, draft_gmail_id: 'pending' });
    expect(result).toBeNull();
    expect(gmailClient.createDraft).not.toHaveBeenCalled();
    const patches = state.updates.filter((u) => u.table === 'emails').map((u) => u.patch.draft_gmail_id);
    expect(patches[patches.length - 1]).toBe('reconciled_existing_draft');
  });

  test('LLM failure degrades to no draft, never throws', async () => {
    process.env.GATE_EMAIL_AUTO_DRAFTS = 'true';
    setupDb();
    dispatchWithFallback.mockResolvedValueOnce({ ok: false, reason: 'all_failed' });
    const state = setupDb();
    const result = await draftReplyForEmail({ ...CUSTOMER_EMAIL });
    expect(result).toBeNull();
    expect(gmailClient.createDraft).not.toHaveBeenCalled();
    // the claim is handed back for a future retry
    const patches = state.updates.filter((u) => u.table === 'emails').map((u) => u.patch.draft_gmail_id);
    expect(patches).toEqual(['pending', null]);
  });
});
