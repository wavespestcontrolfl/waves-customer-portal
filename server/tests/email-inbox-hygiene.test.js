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
  listAllMessages: jest.fn(async () => ({ messages: [], truncated: false })),
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
  'whereIn', 'whereNull', 'whereNotNull', 'orWhereNotIn', 'orWhereNull', 'whereILike', 'andWhereILike',
  'whereBetween', 'whereNotExists', 'orderBy', 'limit',
];

/** Chainable knex mock — per-table FIFO first() queues, select() resolves rows. */
function setupDb(firstResults = {}, selectResults = {}, updateResults = {}) {
  const state = { inserts: [], updates: [], updateFilters: [] };
  const firstQueues = Object.fromEntries(Object.entries(firstResults).map(([t, rows]) => [t, [...rows]]));
  const selectQueues = Object.fromEntries(Object.entries(selectResults).map(([t, rows]) => [t, [...rows]]));
  const updateQueues = Object.fromEntries(Object.entries(updateResults).map(([t, rows]) => [t, [...rows]]));

  db.raw = jest.fn(async (sql, bindings) => {
    const q = selectQueues.__raw;
    return { rows: q && q.length ? q.shift() : [], __raw: sql, __bindings: bindings };
  });
  db.transaction = jest.fn(async (cb) => {
    const trx = (table) => db(table);
    trx.raw = db.raw;
    return cb(trx);
  });
  db.mockImplementation((table) => {
    const builder = {};
    const filters = [];
    for (const method of CHAIN_METHODS) {
      builder[method] = jest.fn((...args) => {
        if (typeof args[0] === 'function') args[0].call(builder, builder);
        else filters.push({ method, args });
        return builder;
      });
    }
    builder.first = jest.fn(async () => {
      const q = firstQueues[table];
      return q && q.length ? q.shift() : null;
    });
    // select() stays CHAINABLE (subqueries chain .whereRaw after it); the
    // builder itself is thenable, resolving the per-table select queue.
    builder.select = jest.fn(() => builder);
    builder.then = (resolve, reject) => {
      const q = selectQueues[table];
      return Promise.resolve(q && q.length ? q.shift() : []).then(resolve, reject);
    };
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

  test('an AUTHENTICATED known customer sender is never quarantined — marked important instead', async () => {
    const state = setupDb({ customers: [{ id: 'cust-1', email: 'jane@customer.example' }] });
    await handleSpam({
      ...EMAIL,
      from_address: 'jane@customer.example',
      authentication_results: 'mx.google.com; dkim=pass header.d=customer.example',
    });
    expect(gmailClient.modifyLabels).toHaveBeenCalledWith('g-1', ['IMPORTANT'], []);
    expect(gmailClient.ensureLabel).not.toHaveBeenCalled();
    expect(gmailClient.trashMessage).not.toHaveBeenCalled();
    expect(state.updates.find((u) => u.table === 'emails').patch.auto_action)
      .toBe('spam_skipped_known_customer');
  });

  test('a live lead sender is protected the same way (when authenticated)', async () => {
    setupDb({ leads: [{ id: 'lead-1', email: 'prospect@new.example' }] });
    await handleSpam({
      ...EMAIL,
      from_address: 'prospect@new.example',
      authentication_results: 'mx.google.com; spf=pass smtp.mailfrom=prospect@new.example',
    });
    expect(gmailClient.ensureLabel).not.toHaveBeenCalled();
    expect(gmailClient.trashMessage).not.toHaveBeenCalled();
  });

  test('a known-LOOKING sender WITHOUT aligned auth quarantines as a probable spoof', async () => {
    const state = setupDb({ customers: [{ id: 'cust-1', email: 'jane@customer.example' }] });
    await handleSpam({ ...EMAIL, from_address: 'jane@customer.example' }); // no auth results
    expect(gmailClient.ensureLabel).toHaveBeenCalledWith('Quarantine');
    expect(gmailClient.trashMessage).not.toHaveBeenCalled();
    const patch = state.updates.find((u) => u.table === 'emails')?.patch;
    expect(patch.auto_action).toBe('spam_quarantined');
  });

  test('spam-classified mail is NEVER auto-unsubscribed, header or not (live-address harvesting)', async () => {
    setupDb();
    await handleSpam({
      ...EMAIL,
      list_unsubscribe: '<https://esp.example/unsub>',
      authentication_results: 'mx.google.com; dkim=pass header.d=seo-blaster.example',
    });
    expect(autoUnsubscribe).not.toHaveBeenCalled();
    expect(gmailClient.ensureLabel).toHaveBeenCalledWith('Quarantine');
  });

  test('an ambiguous Gmail label-swap failure is NON-destructive (no trash, no block)', async () => {
    const state = setupDb();
    gmailClient.modifyLabels.mockRejectedValueOnce(new Error('label swap timeout'));
    await handleSpam({ ...EMAIL });
    expect(gmailClient.trashMessage).not.toHaveBeenCalled();
    expect(state.inserts.find((i) => i.table === 'blocked_email_senders')).toBeUndefined();
    // sweep can never trash it — and the AMBIGUOUS marker survives for the
    // sweep's live-label reconciliation (never flattened to plain failed)
    const patches = state.updates.filter((u) => u.table === 'emails').map((u) => u.patch.auto_action);
    expect(patches[patches.length - 1]).toBe('spam_quarantine_ambiguous');
  });

  test('EVERY quarantine failure is non-destructive — no trash, no block, marked for the digest', async () => {
    const state = setupDb();
    gmailClient.ensureLabel.mockRejectedValueOnce(new Error('labels down'));
    await handleSpam({ ...EMAIL });
    expect(gmailClient.trashMessage).not.toHaveBeenCalled();
    expect(state.inserts.find((i) => i.table === 'blocked_email_senders')).toBeUndefined();
    const patches = state.updates.filter((u) => u.table === 'emails').map((u) => u.patch.auto_action);
    expect(patches[patches.length - 1]).toBe('spam_quarantine_failed');
  });
});

describe('handleNewsletter — known-sender guard', () => {
  const { executeAutoAction } = require('../services/email/email-actions');

  test('an authenticated known customer misclassified as newsletter is neither archived nor unsubscribed', async () => {
    const state = setupDb({ customers: [{ id: 'cust-1', email: 'jane@customer.example' }] });
    await executeAutoAction({
      ...EMAIL,
      from_address: 'jane@customer.example',
      authentication_results: 'mx.google.com; dkim=pass header.d=customer.example',
    }, { category: 'marketing_newsletter' });
    expect(gmailClient.archiveMessage).not.toHaveBeenCalled();
    expect(autoUnsubscribe).not.toHaveBeenCalled();
    expect(state.updates.find((u) => u.table === 'emails').patch.auto_action)
      .toBe('newsletter_skipped_known_customer');
  });
});

describe('sweepQuarantine', () => {
  const { sweepQuarantine } = require('../services/email/inbox-hygiene');

  test('claims atomically, trashes aged rows, and blocks the sender only at commit', async () => {
    const state = setupDb({}, { emails: [[], [], [], [], [], [], [{ id: 'e-old', gmail_id: 'g-old', from_address: 'coldpitch@seo-blaster.example' }]] });
    const result = await sweepQuarantine(new Date('2026-07-28T12:00:00Z'));
    expect(gmailClient.trashMessage).toHaveBeenCalledWith('g-old');
    expect(result.trashed).toBe(1);
    const actions = state.updates.filter((u) => u.table === 'emails').map((u) => u.patch.auto_action);
    // claim → trash → block-pending settle → blocking claim → complete
    expect(actions).toEqual(['spam_trashing', 'spam_trashed_block_pending', 'spam_trashed_blocking', 'spam_trashed_after_quarantine']);
    // the deferred persistent block lands with the commit
    expect(state.inserts.find((i) => i.table === 'blocked_email_senders')).toBeDefined();
  });

  test('an operator label-restore vetoes the trash — state cleared, message kept', async () => {
    const state = setupDb({}, { emails: [[], [], [], [], [], [], [{ id: 'e-back', gmail_id: 'g-back' }]] });
    gmailClient.getMessageLabels.mockResolvedValueOnce(['INBOX']);
    const result = await sweepQuarantine(new Date('2026-07-28T12:00:00Z'));
    expect(gmailClient.trashMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ trashed: 0, restored: 1 });
    const patch = state.updates.find((u) => u.table === 'emails').patch;
    expect(patch.auto_action).toBe('quarantine_restored');
    expect(patch.quarantined_at).toBeNull();
  });

  test('a failed trash RETAINS the ambiguous claim (stuck-claim pass reconciles) and never aborts the sweep', async () => {
    const state = setupDb({}, { emails: [[], [], [], [], [], [], [{ id: 'e-1', gmail_id: 'g-1' }, { id: 'e-2', gmail_id: 'g-2' }]] });
    gmailClient.trashMessage.mockRejectedValueOnce(new Error('gone'));
    const result = await sweepQuarantine();
    expect(result.trashed).toBe(1);
    expect(gmailClient.trashMessage).toHaveBeenCalledTimes(2);
    const actions = state.updates.filter((u) => u.table === 'emails').map((u) => u.patch.auto_action);
    // the failed row's last state is its claim — never reverted to
    // quarantined (a committed-then-errored trash would read as restored)
    expect(actions.filter((a) => a === 'spam_quarantined')).toHaveLength(0);
    expect(actions.filter((a) => a === 'spam_trashing')).toHaveLength(2);
  });
});

describe('rescueSpamFolder', () => {
  const { rescueSpamFolder } = require('../services/email/inbox-hygiene');

  test('moves a known customer out of SPAM, marks important, rings the bell', async () => {
    const state = setupDb({ customers: [{ id: 'cust-1', email: 'jane@customer.example' }] });
    gmailClient.listAllMessages.mockResolvedValueOnce({ messages: [{ id: 'spam-1' }], truncated: false });
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
    gmailClient.listAllMessages.mockResolvedValueOnce({ messages: [{ id: 'spam-3' }], truncated: false });
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
    gmailClient.listAllMessages.mockResolvedValueOnce({ messages: [{ id: 'spam-2' }], truncated: false });
    gmailClient.getMessage.mockResolvedValueOnce({ from_address: 'junk@blaster.example' });
    const counts = await rescueSpamFolder();
    expect(gmailClient.modifyLabels).not.toHaveBeenCalled();
    expect(counts.rescued).toBe(0);
  });
});

describe('collectUnansweredNudges', () => {
  const { collectUnansweredNudges } = require('../services/email/inbox-hygiene');

  test('the SQL grouping asks for one latest-inbound row per thread before any cap', async () => {
    setupDb({}, { __raw: [[{ id: 'e-2', gmail_thread_id: 't-same', from_address: 'a@x.example', subject: 'second ping', received_at: '2026-07-24T12:00:00Z' }]] });
    gmailClient.getThread.mockResolvedValue({ messages: [{ labelIds: ['INBOX'], internalDate: '0' }] });
    const nudges = await collectUnansweredNudges(new Date('2026-07-28T12:00:00Z'));
    expect(nudges).toHaveLength(1);
    expect(nudges[0].id).toBe('e-2');
    const sql = db.raw.mock.calls[0][0];
    expect(sql).toContain('DISTINCT ON (gmail_thread_id)');
    expect(sql).toContain('received_at DESC');
  });

  test('returns threads with no SENT message after the inbound mail; skips answered ones', async () => {
    setupDb({}, {
      __raw: [[
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

describe('sweepQuarantine — stuck-claim recovery', () => {
  const { sweepQuarantine } = require('../services/email/inbox-hygiene');

  test('a crashed spam_trashing row already in TRASH settles + takes its deferred block', async () => {
    const state = setupDb({}, { emails: [
      [{ id: 'e-stuck', gmail_id: 'g-stuck', from_address: 'coldpitch@seo-blaster.example' }], // stuck select
      [], // stale reclassify-claim select
      [], // stranded-cancel select
      [], // stale blocking-claim select
      [], // block-pending retry select
      [], // ambiguous reconcile select
      [], // main quarantined select
    ] });
    gmailClient.getMessageLabels.mockResolvedValueOnce(['TRASH']);
    const result = await sweepQuarantine(new Date('2026-07-28T12:00:00Z'));
    expect(result.trashed).toBe(1);
    const acts = state.updates.filter((u) => u.table === 'emails').map((u) => u.patch.auto_action);
    expect(acts).toEqual(['spam_trashed_block_pending', 'spam_trashed_blocking', 'spam_trashed_after_quarantine']);
    expect(state.inserts.find((i) => i.table === 'blocked_email_senders')).toBeDefined();
  });

  test('a crashed spam_trashing row NOT in TRASH reverts to quarantined', async () => {
    const state = setupDb({}, { emails: [
      [{ id: 'e-stuck', gmail_id: 'g-stuck', from_address: 'x@y.example' }],
      [],
      [],
      [],
      [],
      [],
      [],
    ] });
    gmailClient.getMessageLabels.mockResolvedValueOnce(['Label_42']);
    const result = await sweepQuarantine(new Date('2026-07-28T12:00:00Z'));
    expect(result.trashed).toBe(0);
    expect(state.updates.find((u) => u.table === 'emails').patch.auto_action).toBe('spam_quarantined');
  });
});

describe('sweepQuarantine stale-reclass replay', () => {
  const { sweepQuarantine } = require('../services/email/inbox-hygiene');

  test('a committed non-spam verdict replays its auto-action with the STORED classification payload', async () => {
    const emailActions = require('../services/email/email-actions');
    const spy = jest.spyOn(emailActions, 'executeAutoAction').mockResolvedValueOnce(undefined);
    const stored = { category: 'lead_inquiry', confidence: 0.91, extracted: { name: 'Sam', service: 'quarterly pest' } };
    const fullRow = {
      id: 'e-reclass',
      gmail_id: 'g-reclass',
      from_address: 'sam@new.example',
      classification: 'lead_inquiry',
      classification_confidence: 0.91,
      quarantined_at: '2026-07-27T12:00:00Z',
      extracted_data: JSON.stringify(stored),
    };
    setupDb(
      { emails: [fullRow] },
      { emails: [
        [], // stuck spam_trashing select
        [{ id: 'e-reclass', gmail_id: 'g-reclass', from_address: 'sam@new.example', quarantined_at: '2026-07-27T12:00:00Z', classification: 'lead_inquiry' }],
        [], // stranded-cancel select
        [], // stale blocking-claim select
        [], // block-pending retry select
        [], // ambiguous reconcile select
        [], // main quarantined select
      ] }
    );
    await sweepQuarantine(new Date('2026-07-28T12:00:00Z'));
    // The stored payload — not a bare { category } — reaches the handler,
    // so a recovered lead_inquiry keeps its extraction and confidence.
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: 'e-reclass' }), stored);
    spy.mockRestore();
  });
});

describe('reconcilePendingDrafts', () => {
  const { reconcilePendingDrafts } = require('../services/email/inbox-hygiene');

  test('settles stale claims whose thread already has a draft; releases the rest', async () => {
    const state = setupDb({}, {
      emails: [[
        { id: 'e-has', gmail_thread_id: 't-has' },
        { id: 'e-none', gmail_thread_id: 't-none' },
      ]],
    });
    gmailClient.getThread.mockImplementation(async (threadId) => (threadId === 't-has'
      ? { messages: [{ labelIds: ['DRAFT'] }] }
      : { messages: [{ labelIds: ['INBOX'] }] }));
    const counts = await reconcilePendingDrafts(new Date('2026-07-28T12:00:00Z'));
    expect(counts).toEqual({ settled: 1, released: 1, redrafted: 0 });
    const patches = state.updates.filter((u) => u.table === 'emails').map((u) => u.patch.draft_gmail_id);
    expect(patches).toEqual(['reconciled_existing_draft', null]);
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

  test('SENT/DRAFT (own-authored) rows never draft — no reply-to-self loops', async () => {
    process.env.GATE_EMAIL_AUTO_DRAFTS = 'true';
    setupDb();
    expect(await draftReplyForEmail({ ...CUSTOMER_EMAIL, label_ids: JSON.stringify(['SENT']) })).toBeNull();
    expect(await draftReplyForEmail({ ...CUSTOMER_EMAIL, from_address: 'contact@wavespestcontrol.com' })).toBeNull();
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(gmailClient.createDraft).not.toHaveBeenCalled();
  });

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
    // the claim STAYS pending — the daily reconciler is the retry mechanism
    // (it releases and immediately re-drafts when no thread draft exists)
    const patches = state.updates.filter((u) => u.table === 'emails').map((u) => u.patch.draft_gmail_id);
    expect(patches).toEqual(['pending']);
  });
});

describe('hasAlignedAuth organizational-domain alignment', () => {
  const { hasAlignedAuth } = require('../services/email/inbox-hygiene');

  test('sibling subdomains of one org domain align (DMARC relaxed)', () => {
    expect(hasAlignedAuth('mx.google.com; dkim=pass header.d=mail.customer.com', 'news.customer.com')).toBe(true);
    expect(hasAlignedAuth('mx.google.com; dkim=pass header.d=customer.com', 'mail.customer.com')).toBe(true);
  });

  test('unrelated registrable domains never align', () => {
    expect(hasAlignedAuth('mx.google.com; dkim=pass header.d=attacker.com', 'customer.com')).toBe(false);
  });

  test('multi-label public suffixes do not create false alignment', () => {
    // Naive last-two-labels would reduce both to co.uk and "align" them.
    expect(hasAlignedAuth('mx.google.com; dkim=pass header.d=attacker.co.uk', 'customer.co.uk')).toBe(false);
    expect(hasAlignedAuth('mx.google.com; dkim=pass header.d=mail.customer.co.uk', 'customer.co.uk')).toBe(true);
  });

  test('private-registry suffixes (github.io) are org boundaries too', () => {
    expect(hasAlignedAuth('mx.google.com; dkim=pass header.d=attacker.github.io', 'victim.github.io')).toBe(false);
    expect(hasAlignedAuth('mx.google.com; dkim=pass header.d=victim.github.io', 'victim.github.io')).toBe(true);
  });
});

describe('rescueSpamFolder scan window', () => {
  const { rescueSpamFolder } = require('../services/email/inbox-hygiene');

  test('no watermark = first run scans the full ~30d retention window', async () => {
    setupDb();
    gmailClient.listAllMessages.mockResolvedValueOnce({ messages: [], truncated: false });
    await rescueSpamFolder(new Date('2026-07-28T12:00:00Z'));
    expect(gmailClient.listAllMessages).toHaveBeenCalledWith('in:spam newer_than:30d', 500, { includeSpamTrash: true, pageToken: null });
  });

  test('window widens to cover the gap since the last successful sweep', async () => {
    // Last clean sweep 8 days ago (outage) → 8d gap + 1d overlap = 9d window.
    setupDb({ email_sync_state: [{ id: 1, last_spam_scan_at: '2026-07-20T12:00:00Z' }] });
    gmailClient.listAllMessages.mockResolvedValueOnce({ messages: [], truncated: false });
    await rescueSpamFolder(new Date('2026-07-28T12:00:00Z'));
    expect(gmailClient.listAllMessages).toHaveBeenCalledWith('in:spam newer_than:9d', 500, { includeSpamTrash: true, pageToken: null });
  });

  test('a clean pass stamps the watermark; a pass with per-message failures does not', async () => {
    const state = setupDb({ email_sync_state: [{ id: 1, last_spam_scan_at: '2026-07-27T12:00:00Z' }] });
    gmailClient.listAllMessages.mockResolvedValueOnce({ messages: [{ id: 'spam-1' }], truncated: false });
    gmailClient.getMessage.mockResolvedValueOnce({ from_address: 'junk@blaster.example' });
    await rescueSpamFolder(new Date('2026-07-28T12:00:00Z'));
    expect(state.updates.find((u) => u.table === 'email_sync_state').patch.last_spam_scan_at).toEqual(new Date('2026-07-28T12:00:00Z'));

    const state2 = setupDb({ email_sync_state: [{ id: 1, last_spam_scan_at: '2026-07-27T12:00:00Z' }] });
    gmailClient.listAllMessages.mockResolvedValueOnce({ messages: [{ id: 'spam-1' }, { id: 'spam-2' }], truncated: false });
    gmailClient.getMessage
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ from_address: 'junk@blaster.example' });
    await rescueSpamFolder(new Date('2026-07-28T12:00:00Z'));
    // Failed message stays in the next window — watermark must NOT advance.
    expect(state2.updates.find((u) => u.table === 'email_sync_state')).toBeUndefined();
  });

  test('drains multiple batches until the window is exhausted, then stamps the watermark', async () => {
    const state = setupDb({ email_sync_state: [{ id: 1, last_spam_scan_at: '2026-07-27T12:00:00Z' }] });
    gmailClient.listAllMessages
      .mockResolvedValueOnce({ messages: [{ id: 's1' }], truncated: true, nextPageToken: 'p2' })
      .mockResolvedValueOnce({ messages: [{ id: 's2' }], truncated: false, nextPageToken: null });
    gmailClient.getMessage
      .mockResolvedValueOnce({ from_address: 'junk@blaster.example' })
      .mockResolvedValueOnce({ from_address: 'junk2@blaster.example' });
    const counts = await rescueSpamFolder(new Date('2026-07-28T12:00:00Z'));
    expect(counts.scanned).toBe(2);
    expect(gmailClient.listAllMessages).toHaveBeenNthCalledWith(2, 'in:spam newer_than:2d', 500, { includeSpamTrash: true, pageToken: 'p2' });
    expect(state.updates.find((u) => u.table === 'email_sync_state')).toBeDefined();
  });

  test('a capped run persists the continuation epoch instead of stalling', async () => {
    const state = setupDb({ email_sync_state: [{ id: 1, last_spam_scan_at: '2026-07-27T12:00:00Z' }] });
    for (let i = 0; i < 20; i += 1) {
      gmailClient.listAllMessages.mockResolvedValueOnce({ messages: [{ id: `s${i}` }], truncated: true, nextPageToken: `p${i}` });
      gmailClient.getMessage.mockResolvedValueOnce({ from_address: 'junk@blaster.example', received_at: new Date(Date.parse('2026-07-28T00:00:00Z') - i * 3600000) });
    }
    await rescueSpamFolder(new Date('2026-07-28T12:00:00Z'));
    const patch = state.updates.find((u) => u.table === 'email_sync_state').patch;
    // Oldest scanned = 19h before midnight; +1s so a same-second sibling re-scans.
    expect(patch.spam_scan_before_epoch).toBe(Math.floor(Date.parse('2026-07-27T05:00:00Z') / 1000) + 1);
    expect(patch.last_spam_scan_at).toBeUndefined();
  });

  test('a continuation run partitions on before: and clears the marker when drained', async () => {
    const state = setupDb({ email_sync_state: [{ id: 1, last_spam_scan_at: '2026-07-27T12:00:00Z', spam_scan_before_epoch: 1753000000 }] });
    gmailClient.listAllMessages.mockResolvedValueOnce({ messages: [], truncated: false, nextPageToken: null });
    await rescueSpamFolder(new Date('2026-07-28T12:00:00Z'));
    expect(gmailClient.listAllMessages).toHaveBeenCalledWith('in:spam newer_than:2d before:1753000000', 500, { includeSpamTrash: true, pageToken: null });
    const patches = state.updates.filter((u) => u.table === 'email_sync_state').map((u) => u.patch);
    expect(patches).toEqual([{ spam_scan_before_epoch: null }]);
  });

  test('an undrained window (batch backstop) holds the watermark', async () => {
    const state = setupDb({ email_sync_state: [{ id: 1, last_spam_scan_at: '2026-07-27T12:00:00Z' }] });
    for (let i = 0; i < 20; i += 1) {
      gmailClient.listAllMessages.mockResolvedValueOnce({ messages: [], truncated: true, nextPageToken: `p${i}` });
    }
    await rescueSpamFolder(new Date('2026-07-28T12:00:00Z'));
    expect(gmailClient.listAllMessages).toHaveBeenCalledTimes(20);
    // Remainder unscanned — the next run must re-cover this window.
    expect(state.updates.find((u) => u.table === 'email_sync_state')).toBeUndefined();
  });
});

describe('reply drafts honor Reply-To', () => {
  const { draftReplyForEmail } = require('../services/email/email-actions');

  test('a stale same-row takeover is blocked while ANOTHER thread row holds a fresh claim', async () => {
    process.env.GATE_EMAIL_AUTO_DRAFTS = 'true';
    // Both the fresh claim (row already 'pending') and the guarded takeover
    // updates return 0 — the takeover's NOT EXISTS sees the sibling's fresh
    // claim.
    const state = setupDb({}, {}, { emails: [0, 0] });
    const result = await draftReplyForEmail({
      id: 'e-stale',
      gmail_id: 'g-stale',
      gmail_thread_id: 't-shared',
      from_address: 'jane@customer.example',
      from_name: 'Jane Customer',
      subject: 'Can you come Friday?',
      body_text: 'Can you come Friday instead of Monday?',
      label_ids: JSON.stringify(['INBOX']),
      message_id: '<inbound-stale@mail.example>',
      received_at: '2026-07-28T10:00:00Z',
      draft_gmail_id: 'pending',
    });
    expect(result).toBeNull();
    expect(gmailClient.createDraft).not.toHaveBeenCalled();
    // The takeover update carries the same active-thread-claim guard as the
    // fresh path.
    const emailUpdates = state.updateFilters.filter((u) => u.table === 'emails');
    const takeover = emailUpdates[emailUpdates.length - 1];
    expect(takeover.filters.some((f) => f.method === 'whereNotExists')).toBe(true);
  });

  test('a validated Reply-To beats a relay From when addressing the draft', async () => {
    process.env.GATE_EMAIL_AUTO_DRAFTS = 'true';
    setupDb();
    gmailClient.getThread.mockResolvedValue({ messages: [] });
    const result = await draftReplyForEmail({
      id: 'e-relay',
      gmail_id: 'g-relay',
      gmail_thread_id: 't-relay',
      from_address: 'no-reply@forms-relay.example',
      from_name: 'Contact Form',
      subject: 'New inquiry',
      body_text: 'Need a quote for pest control.',
      label_ids: JSON.stringify(['INBOX']),
      message_id: '<relay-123@forms-relay.example>',
      reply_to: 'real.customer@customer.example',
      received_at: '2026-07-28T10:00:00Z',
      draft_gmail_id: null,
    });
    expect(result).toBe('draft-1');
    expect(gmailClient.createDraft).toHaveBeenCalledWith(
      'real.customer@customer.example',
      expect.any(String),
      expect.any(String),
      't-relay',
      '<relay-123@forms-relay.example>'
    );
  });
});
