/**
 * email-sync (Communications audit 2026-10-30, C01 + C02).
 * - C01: a message that fails (fetch or store, not 404) holds the incremental
 *   cursor, so the next run re-lists and stores it; Gmail never offers it
 *   again once the cursor passes. A message that keeps failing is passed
 *   after MESSAGE_RETRY_RUNS runs, and only once the office has a needs-you
 *   alert for it. A Zelle notice whose retry record was lost holds for as
 *   long as it fails.
 * - C02: an email row and its attachment rows commit together, so a failed
 *   attachment insert leaves nothing and the retry stores the whole message;
 *   a stored row missing attachment rows gets only the missing ones back
 *   when Gmail lists it again (the rows it has, invoice results included,
 *   are kept).
 * All boundaries are in-memory doubles: no Gmail, database, AI or message.
 * The alert runs through the real composer (it throws under NODE_ENV=test
 * on any docs/admin-notifications.md breach); only notifyAdmin is faked.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/email/gmail-client', () => ({
  isConnected: jest.fn(), getHistory: jest.fn(), getMessage: jest.fn(),
  getProfileHistoryId: jest.fn(), listMessages: jest.fn(), trashMessage: jest.fn(),
}));
jest.mock('../services/email/spam-blocker', () => ({
  isBlocked: jest.fn(async () => false), domainFromAddress: (a) => String(a || '').split('@')[1] || '',
}));
jest.mock('../services/email/email-classifier', () => ({ classifyEmail: jest.fn(async () => undefined) }));
jest.mock('../services/zelle-notice-reconciler', () => ({
  ZELLE_RETRY_MARK: 'zelle_notice_retry', isZelleReconcileEnabled: () => false,
  sweepStaleClaims: jest.fn(async () => 0), maybeHandleZelleNotice: jest.fn(async () => false),
}));
jest.mock('../services/zelle-notice', () => ({ isZelleNoticeCandidate: () => false }));
jest.mock('../services/content/email-approvals', () => ({ isApprovalControlMessage: jest.fn(async () => false) }));
jest.mock('../services/newsletter-proof', () => ({ maybeHandleProofApproval: jest.fn(async () => false) }));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: () => false }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const db = require('../models/db');
const gmail = require('../services/email/gmail-client');
const { notifyAdmin } = require('../services/notification-service');
const { syncEmails, upsertEmail } = require('../services/email/email-sync');

const MESSAGE_RETRY_RUNS = 15;

let tables;
let failures;
function installDb() {
  tables = {
    email_sync_state: [{ id: 'state-1', last_history_id: '100', emails_synced: 0, initial_sync_completed_at: new Date(0) }],
    emails: [], email_attachments: [], customers: [], vendor_email_domains: [],
  };
  failures = { emailInsert: null, attachmentInsert: null };
  db.mockReset();
  db.schema = { hasColumn: jest.fn(async () => false) };
  // A transaction runs its work against the same tables and puts them back
  // as they were when the work throws.
  db.transaction = jest.fn(async (work) => {
    const before = structuredClone(tables);
    try {
      return await work(db);
    } catch (err) {
      tables = before;
      throw err;
    }
  });
  db.mockImplementation((table) => {
    if (!(table in tables)) throw new Error(`Unexpected table ${table}`);
    const predicates = [];
    let operation = 'select';
    let value;
    let first = false;
    let returnColumn;
    const execute = () => {
      const matched = tables[table].filter((row) => predicates.every((predicate) => predicate(row)));
      if (operation === 'insert') {
        if (table === 'emails' && failures.emailInsert) throw failures.emailInsert;
        if (table === 'email_attachments' && failures.attachmentInsert) throw failures.attachmentInsert;
        const inserted = [];
        for (const data of Array.isArray(value) ? value : [value]) {
          if (table === 'emails' && tables.emails.some((row) => row.gmail_id === data.gmail_id)) continue;
          const row = { id: `${table}-${tables[table].length + 1}`, ...(table === 'emails' ? { is_archived: false } : {}), ...data };
          tables[table].push(row);
          inserted.push(row);
        }
        return returnColumn === 'id' ? inserted.map((row) => ({ id: row.id })) : inserted.map((row) => ({ ...row }));
      }
      if (operation === 'update') {
        matched.forEach((row) => Object.assign(row, value));
        return matched.length;
      }
      if (operation === 'increment') {
        matched.forEach((row) => { row[value[0]] = (row[value[0]] || 0) + value[1]; });
        return matched.length;
      }
      if (operation === 'count') return [{ count: String(matched.length) }];
      return first ? (matched[0] ? { ...matched[0] } : undefined) : matched.map((row) => ({ ...row }));
    };
    const chain = {
      where(key, expected) {
        const filter = typeof key === 'object' ? key : { [key]: expected };
        predicates.push((row) => Object.entries(filter).every(([field, wanted]) => row[field] === wanted));
        return chain;
      },
      whereRaw() { return chain; },
      whereNull(key) { predicates.push((row) => row[key] == null); return chain; },
      first() { first = true; return chain; },
      select() { return chain; },
      forUpdate() { return chain; },
      count() { operation = 'count'; return chain; },
      insert(data) { operation = 'insert'; value = data; return chain; },
      update(data) { operation = 'update'; value = data; return chain; },
      increment(...args) { operation = 'increment'; value = args; return chain; },
      onConflict() { return chain; },
      ignore() { return chain; },
      returning(column) { returnColumn = column; return chain; },
      then(resolve, reject) { return Promise.resolve().then(execute).then(resolve, reject); },
    };
    return chain;
  });
}

// Every test uses its own Gmail id: the retry count lives in the module.
let gmailId;
let sequence = 0;
const attachment = (name, extra = {}) => ({ gmail_attachment_id: `fetch-${Math.random()}`, filename: name, mime_type: 'application/pdf', size_bytes: 2, ...extra });
const parsed = (overrides = {}) => ({
  gmail_id: gmailId, gmail_thread_id: 'thread-1', historyId: '200',
  from_address: 'fixture@example.invalid', to_address: 'contact@wavespestcontrol.com',
  subject: 'Synthetic fixture', body_text: 'Fixture', body_html: null, snippet: 'Fixture',
  label_ids: ['INBOX'], received_at: new Date(Date.now() - 72 * 3600 * 1000), is_read: true, is_starred: false,
  has_attachments: false, attachments: [], ...overrides,
});
const state = () => tables.email_sync_state[0];
const cursors = () => gmail.getHistory.mock.calls.map(([cursor]) => cursor);

beforeEach(() => {
  jest.clearAllMocks();
  installDb();
  sequence += 1;
  gmailId = `message-${sequence}`;
  gmail.isConnected.mockResolvedValue(true);
  gmail.getHistory.mockImplementation(async (cursor) => (cursor === '100'
    ? { historyId: '200', history: [{ messagesAdded: [{ message: { id: gmailId } }] }] }
    : { historyId: cursor }));
  gmail.getMessage.mockImplementation(async () => parsed());
  gmail.getProfileHistoryId.mockResolvedValue('200');
  gmail.listMessages.mockImplementation(async () => [{ id: gmailId }]);
  notifyAdmin.mockResolvedValue({ id: 'alert-1' });
});

describe('C01: a failed message holds the incremental cursor', () => {
  test.each(['fetch', 'store'])('an ordinary %s failure is retried on the next run and stored', async (failure) => {
    if (failure === 'fetch') gmail.getMessage.mockRejectedValueOnce(new Error('synthetic fetch failure'));
    else failures.emailInsert = new Error('synthetic insert failure');
    await syncEmails();
    expect(state().last_history_id).toBe('100');
    expect(state().errors).toBe('incremental sync incomplete: 1 message(s) failed — cursor withheld, retrying next run');
    expect(tables.emails).toHaveLength(0);

    failures.emailInsert = null;
    expect(await syncEmails()).toEqual({ newEmails: 1 });
    expect(cursors()).toEqual(['100', '100']);
    expect(tables.emails.map((row) => row.gmail_id)).toEqual([gmailId]);
    expect(state()).toMatchObject({ last_history_id: '200', errors: null });
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('a message that keeps failing is passed after the retry runs, once its alert is written', async () => {
    gmail.getMessage.mockRejectedValue(new Error('synthetic permanent failure'));
    for (let run = 1; run < MESSAGE_RETRY_RUNS; run += 1) await syncEmails();
    expect(state().last_history_id).toBe('100');
    expect(notifyAdmin).not.toHaveBeenCalled();

    await syncEmails();
    expect(state()).toMatchObject({ last_history_id: '200', errors: null });
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = notifyAdmin.mock.calls[0];
    expect(category).toBe('alert');
    expect(headline).toMatch(/skipped email/i);
    expect(why).toMatch(/failing to save/);
    expect(opts).toMatchObject({ bell: true, dedupeKey: `email-sync-skip:${gmailId}`, link: '/admin/communications#tab=email' });

    await syncEmails();
    expect(cursors().at(-1)).toBe('200');
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('an alert that was not written keeps holding the cursor until one is', async () => {
    gmail.getMessage.mockRejectedValue(new Error('synthetic permanent failure'));
    notifyAdmin.mockResolvedValue(null);
    for (let run = 1; run <= MESSAGE_RETRY_RUNS + 1; run += 1) await syncEmails();
    expect(state().last_history_id).toBe('100');
    expect(notifyAdmin).toHaveBeenCalledTimes(2);

    notifyAdmin.mockResolvedValue({ id: 'alert-2' });
    await syncEmails();
    expect(state().last_history_id).toBe('200');
  });

  test('a Zelle notice whose retry record was lost holds past the retry runs, with no alert', async () => {
    gmail.getMessage.mockRejectedValue(Object.assign(new Error('synthetic lost retry'), { zelleRetryLost: true }));
    for (let run = 1; run <= MESSAGE_RETRY_RUNS + 2; run += 1) await syncEmails();
    expect(state().last_history_id).toBe('100');
    expect(state().errors).toContain('cursor withheld');
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('the cursor stops at the listing, not at a later historyId of a message changed during the loop', async () => {
    // '300' is lexically and numerically past the listing's '200': a cursor
    // there would pass an email that arrived between the two.
    gmail.getMessage.mockImplementation(async () => parsed({ historyId: '300' }));
    await syncEmails();
    expect(state()).toMatchObject({ last_history_id: '200', errors: null });
  });

  test('a message Gmail no longer has (404) still passes the cursor and archives the row', async () => {
    tables.emails.push({ id: 'emails-1', gmail_id: gmailId, is_archived: false });
    gmail.getMessage.mockRejectedValue(Object.assign(new Error('Requested entity was not found.'), { code: 404 }));
    await syncEmails();
    expect(state()).toMatchObject({ last_history_id: '200', errors: null });
    expect(tables.emails[0].is_archived).toBe(true);
  });
});

describe('C02: attachment rows commit with their email', () => {
  test.each([
    ['incremental', '100'],
    ['full', null],
  ])('%s sync: a failed attachment insert stores nothing, and the retry stores the email with every attachment', async (_kind, cursor) => {
    state().last_history_id = cursor;
    gmail.getMessage.mockImplementation(async () => parsed({ has_attachments: true, attachments: [attachment('first.pdf'), attachment('second.pdf')] }));
    failures.attachmentInsert = new Error('synthetic attachment write failure');
    await syncEmails();
    expect(tables.emails).toHaveLength(0);
    expect(tables.email_attachments).toHaveLength(0);
    expect(state().last_history_id).toBe(cursor);

    failures.attachmentInsert = null;
    await syncEmails();
    expect(tables.emails).toHaveLength(1);
    expect(tables.email_attachments.map((row) => [row.email_id, row.filename])).toEqual([
      [tables.emails[0].id, 'first.pdf'], [tables.emails[0].id, 'second.pdf'],
    ]);
    expect(state().last_history_id).toBe('200');
  });

  test('a stored row missing an attachment row gets only that one back, and keeps the rows it has', async () => {
    tables.emails.push({ id: 'emails-1', gmail_id: gmailId, auto_action: null, is_archived: false });
    // Stored before: one row with the invoice processor's results on it, and
    // no MIME type recorded (Gmail's parse gives none either).
    tables.email_attachments.push({ id: 'kept', email_id: 'emails-1', gmail_attachment_id: 'old-fetch', filename: 'invoice.pdf', mime_type: null, size_bytes: 2, is_invoice: true, extracted_data: { total: 12 } });
    const listed = parsed({ has_attachments: true, attachments: [attachment('invoice.pdf', { mime_type: undefined }), attachment('photo.jpg', { mime_type: 'image/jpeg', size_bytes: 9 })] });

    expect(await upsertEmail(listed)).toBe(false);
    expect(tables.email_attachments.map((row) => [row.id, row.filename])).toEqual([['kept', 'invoice.pdf'], ['email_attachments-2', 'photo.jpg']]);
    expect(tables.email_attachments[0]).toMatchObject({ gmail_attachment_id: 'old-fetch', is_invoice: true, extracted_data: { total: 12 } });

    // Listed again (new Gmail attachment ids, as every fetch gives): nothing to add.
    await upsertEmail(parsed({ has_attachments: true, attachments: [attachment('invoice.pdf', { mime_type: undefined }), attachment('photo.jpg', { mime_type: 'image/jpeg', size_bytes: 9 })] }));
    expect(tables.email_attachments).toHaveLength(2);
  });

  test('two identical files stay two rows', async () => {
    tables.emails.push({ id: 'emails-1', gmail_id: gmailId, auto_action: null, is_archived: false });
    tables.email_attachments.push({ id: 'kept', email_id: 'emails-1', filename: 'scan.jpg', mime_type: 'image/jpeg', size_bytes: 5 });
    const same = () => attachment('scan.jpg', { mime_type: 'image/jpeg', size_bytes: 5 });
    await upsertEmail(parsed({ has_attachments: true, attachments: [same(), same()] }));
    expect(tables.email_attachments.map((row) => row.filename)).toEqual(['scan.jpg', 'scan.jpg']);
  });

  test.each(['outbound_skipped', 'blocked_sender_trashed'])('a %s row is not given attachment rows', async (autoAction) => {
    tables.emails.push({ id: 'emails-1', gmail_id: gmailId, auto_action: autoAction, is_archived: true });
    await upsertEmail(parsed({ has_attachments: true, attachments: [attachment('file.pdf')] }));
    expect(tables.email_attachments).toHaveLength(0);
  });
});
