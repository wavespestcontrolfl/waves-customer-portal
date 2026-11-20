/**
 * The scheduler's dispatch claim is bound to the row version the tick read
 * and validated. An admin PATCH that lands between the tick's read and the
 * claim rewrites the content and moves updated_at (and returns the row to
 * draft), so the version-bound claim finds nothing — the edited, unapproved
 * content is never broadcast. A direct sendCampaign (manual send) keeps the
 * legacy draft-or-scheduled claim.
 */
const mockValidateEventSelection = jest.fn(async () => ({ valid: true, errors: [], flagship: false, events: [] }));
const mockTrigger = jest.fn(async () => ({ bellWritten: true }));

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: () => true,
  sendBroadcast: jest.fn(async () => ({ messageId: 'sg-1', recipientCount: 1 })),
  unsubscribeUrl: jest.fn((t) => `https://portal/unsub/${t}`),
}));
jest.mock('../services/newsletter-event-selection', () => ({
  validateFlagshipEventSelection: mockValidateEventSelection,
  parseLockedEventIds: jest.fn(() => []),
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: mockTrigger }));
// The inbox sync the send-time HOLD check runs to read the inbox through now (inboxReadThrough).
jest.mock('../services/email/email-sync', () => ({ syncEmails: jest.fn(async () => ({ newEmails: 0 })) }));
jest.mock('../services/newsletter-validator', () => ({
  validateNewsletterDraft: jest.fn(() => ({ errors: [], warnings: [] })),
  lockedPricesForSend: jest.fn(async () => []),
}));

const db = require('../models/db');
// The pre-send archived-link relink sweep runs a raw UPDATE in its own
// transaction; nothing stale here, so it is a 0-row no-op.
db.raw = jest.fn(async () => ({ rowCount: 0 }));
// A transaction reaches the same tables too (a stop at send time reverts in one).
db.transaction = jest.fn(async (cb) => {
  const trx = (table) => db(table);
  trx.raw = db.raw;
  return cb(trx);
});
const { sendCampaign, processScheduledSends } = require('../services/newsletter-sender');

const READ_AT = new Date('2026-10-06T14:00:00Z');
const APPROVED_AT = new Date('2026-10-06T13:55:00Z');
const SEND = {
  id: 'send-pi-1', status: 'scheduled', newsletter_type: 'pest-insider-monthly', subject: 'Pest Insider — October',
  html_body: '<p>Body</p>', text_body: 'Body', event_ids: [],
  // A Waves Pest Insider issue goes out only with a planned audience.
  segment_filter: {
    subscriber_ids: [1], holdout: 'pest-insider',
    address_keys: { 1: require('../services/pest-insider/audience').addressKey('a@example.com') },
  },
  scheduled_for: new Date('2026-10-06T13:56:00Z'), updated_at: READ_AT, proof_approved_at: APPROVED_AT,
  // Approved by an APPROVED reply (email-sync always passes the stored email
  // row); no email id would mean the auto-send switch queued it.
  proof_approval_email_id: 'email-1',
};

// The planned reader as the sender reads it now (withMailboxCustomers): still at the planned address.
const PLANNED_ROWS = [{ id: 1, customer_id: null, email: 'a@example.com', mailbox_customer_ids: [] }];

function chain({ first, rows, returning, updated } = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereNot', 'whereNotIn', 'whereNotNull', 'whereNull', 'whereNotExists', 'whereIn',
    'select', 'orderBy', 'leftJoin', 'join', 'joinRaw', 'forUpdate',
    // excludeMarketingOptedOut's pre-filtering CTE (codex #5165) — a no-op
    // chain link here, same as every other query-shape method above.
    'withMaterialized'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.limit = jest.fn(async () => rows || []);
  q.first = jest.fn(async () => first);
  q.count = jest.fn(() => ({ first: jest.fn(async () => ({ c: 5 })) }));
  q.update = jest.fn(() => ({
    returning: jest.fn(async () => returning || []),
    then: (resolve, reject) => Promise.resolve(updated ?? 1).then(resolve, reject),
  }));
  q.then = (resolve, reject) => Promise.resolve(rows || []).then(resolve, reject);
  return q;
}

function wire(queues) {
  db.mockImplementation((table) => {
    const queue = queues[table] || [];
    return queue.length ? queue.shift() : chain();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_NEWSLETTER_PROOF_APPROVAL = 'true';
  process.env.GATE_PEST_INSIDER_PROOF = 'true';
});

afterAll(() => {
  delete process.env.GATE_NEWSLETTER_PROOF_APPROVAL;
  delete process.env.GATE_PEST_INSIDER_PROOF;
});

test('the scheduler binds the claim to the version it validated, and an empty claim is not a failure', async () => {
  const claim = chain({ returning: [] }); // the row moved on: no row matches the validated version
  wire({
    newsletter_sends: [chain({ rows: [SEND] }), chain({ first: SEND }), claim],
    newsletter_subscribers: [chain({ rows: PLANNED_ROWS }), chain({ rows: PLANNED_ROWS })],
  });

  const result = await processScheduledSends();

  expect(result).toEqual({ processed: 0 });
  expect(claim.where).toHaveBeenCalledWith({ id: 'send-pi-1' });
  expect(claim.where).toHaveBeenCalledWith({ status: 'scheduled' });
  expect(claim.where).toHaveBeenCalledWith('updated_at', '<', new Date(READ_AT.getTime() + 1));
  expect(claim.whereNotNull).toHaveBeenCalledWith('proof_approved_at');
  expect(claim.where).toHaveBeenCalledWith('proof_approved_at', '<', new Date(APPROVED_AT.getTime() + 1));
  expect(claim.whereIn).not.toHaveBeenCalled();
  // An issue approved by a reply has no send window: no deadline on its claim.
  expect(claim.whereRaw).not.toHaveBeenCalled();
  expect(claim.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'sending' }));
  // The row was NOT flipped to failed: the only newsletter_sends writes are the claim attempt.
});

test('the scheduler returns a Waves Pest Insider issue with no plan to draft with one alert, and never marks it failed', async () => {
  const revert = chain();
  wire({
    newsletter_sends: [chain({ rows: [{ ...SEND, segment_filter: null }] }), chain({ first: { ...SEND, segment_filter: null } }), revert],
    // A draft made by hand: no planned issue row moves, so the alert goes out right away.
    pest_insider_issues: [chain({ updated: 0 })],
  });

  const result = await processScheduledSends();

  expect(result).toEqual({ processed: 0 });
  expect(revert.where).toHaveBeenCalledWith({ id: 'send-pi-1', status: 'scheduled' });
  // Bound to the version this tick read, as the claim is.
  expect(revert.where).toHaveBeenCalledWith('updated_at', '<', new Date(READ_AT.getTime() + 1));
  expect(revert.where).toHaveBeenCalledWith('proof_approved_at', '<', new Date(APPROVED_AT.getTime() + 1));
  expect(revert.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft', proof_approved_at: null }));
  expect(mockTrigger).toHaveBeenCalledTimes(1);
  expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.objectContaining({
    sendId: 'send-pi-1',
    errors: ['Stopped at send time: a Waves Pest Insider issue goes only to its planned readers, and this one has no plan'],
  }));
  expect(require('../services/sendgrid-mail').sendBroadcast).not.toHaveBeenCalled();
});

test('a refused issue that was repaired and queued again since the tick read it is left as it is now, with no alert', async () => {
  // The bound revert finds no row: the plan was repaired and the issue re-approved in between.
  const revert = chain({ updated: 0 });
  wire({
    newsletter_sends: [chain({ rows: [{ ...SEND, segment_filter: null }] }), chain({ first: { ...SEND, segment_filter: null } }), revert],
  });

  const result = await processScheduledSends();

  expect(result).toEqual({ processed: 0 });
  expect(revert.where).toHaveBeenCalledWith('updated_at', '<', new Date(READ_AT.getTime() + 1));
  expect(mockTrigger).not.toHaveBeenCalled();
  expect(require('../services/sendgrid-mail').sendBroadcast).not.toHaveBeenCalled();
});

test('a direct (manual) sendCampaign keeps the legacy draft-or-scheduled claim and reports a lost race as ALREADY_CLAIMED', async () => {
  const claim = chain({ returning: [] });
  wire({
    newsletter_sends: [chain({ first: SEND }), claim],
    newsletter_subscribers: [chain({ rows: PLANNED_ROWS })],
  });

  await expect(sendCampaign('send-pi-1')).rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });
  expect(claim.whereIn).toHaveBeenCalledWith('status', ['draft', 'scheduled']);
  expect(claim.where).not.toHaveBeenCalledWith({ status: 'scheduled' });
});

test('a version-bound claim that finds no row throws VERSION_CHANGED, never ALREADY_CLAIMED', async () => {
  const claim = chain({ returning: [] });
  wire({
    newsletter_sends: [chain({ first: SEND }), claim],
    newsletter_subscribers: [chain({ rows: PLANNED_ROWS })],
  });

  await expect(sendCampaign('send-pi-1', { expect: { status: 'scheduled', updatedAt: READ_AT, proofApprovedAt: APPROVED_AT } }))
    .rejects.toMatchObject({ code: 'VERSION_CHANGED' });
});

test.each([
  ['draft', 'VERSION_CHANGED'],
  ['scheduled', 'VERSION_CHANGED'],
  ['sending', 'ALREADY_CLAIMED'],
  ['sent', 'ALREADY_CLAIMED'],
])('a lost version-bound claim on a row now %s reports %s (an edit is not a send race)', async (nowStatus, code) => {
  wire({
    newsletter_sends: [chain({ first: SEND }), chain({ returning: [] }), chain({ first: { status: nowStatus } })],
    newsletter_subscribers: [chain({ rows: PLANNED_ROWS })],
  });

  await expect(sendCampaign('send-pi-1', { expect: { status: 'scheduled', updatedAt: READ_AT, proofApprovedAt: APPROVED_AT } }))
    .rejects.toMatchObject({ code });
});

test.each([
  ['its bodies cleared', 'VERSION_CHANGED', { status: 'draft', html_body: null, text_body: null }],
  ['its segment emptied', 'VERSION_CHANGED', { segment_filter: { service_line: 'nobody' } }],
  ['a newer proof approval', 'VERSION_CHANGED', { proof_approved_at: new Date(APPROVED_AT.getTime() + 60_000) }],
  ['another worker already sending it', 'ALREADY_CLAIMED', { status: 'sending' }],
])('a row edited after validation (%s) reports %s before any pre-claim gate runs (codex round 18 P2)', async (_label, code, edit) => {
  const edited = { ...SEND, ...edit, updated_at: new Date(READ_AT.getTime() + 60_000) };
  const claim = chain({ returning: [{ id: SEND.id }] });
  wire({
    newsletter_sends: [chain({ first: edited }), claim],
    newsletter_subscribers: [chain({ rows: PLANNED_ROWS })],
  });

  await expect(sendCampaign('send-pi-1', { expect: { status: 'scheduled', updatedAt: READ_AT, proofApprovedAt: APPROVED_AT } }))
    .rejects.toMatchObject({ code });
  // Nothing past the version check ran: no event gate, no relink sweep, no claim.
  expect(mockValidateEventSelection).not.toHaveBeenCalled();
  expect(db.transaction).not.toHaveBeenCalled();
  expect(claim.update).not.toHaveBeenCalled();
});

describe('a planned Waves Pest Insider issue the switch queued (GATE_PEST_INSIDER_AUTO_SEND)', () => {
  // Thursday, December 3, 2026: its 7:00 AM EST send time, and the 10:00 AM end of its window.
  const ISSUE_SEND_AT = new Date('2026-12-03T12:00:00Z');
  const WINDOW_END = new Date('2026-12-03T15:00:00Z');
  const QUEUED = { ...SEND, id: 'send-pi-2', scheduled_for: ISSUE_SEND_AT, proof_approval_email_id: null };
  const PLANNED = { id: 'issue-1', issue_date: '2026-12-03', status: 'scheduled', send_id: 'send-pi-2' };

  beforeEach(() => {
    process.env.GATE_PEST_INSIDER_AUTO_SEND = 'true';
    // The FYI copy's address (the default) can reply HOLD.
    process.env.NEWSLETTER_PROOF_APPROVERS = 'contact@wavespestcontrol.com';
    delete process.env.NEWSLETTER_PROOF_EMAIL;
    // Only the clock is fake; the send path's own timers and ticks run as usual.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    jest.setSystemTime(new Date('2026-12-03T14:59:00Z')); // 9:59 AM EST: inside the window
  });
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.GATE_PEST_INSIDER_AUTO_SEND;
    delete process.env.NEWSLETTER_PROOF_APPROVERS;
  });

  test('its claim must land before 10:00 AM ET: a claim the window closed on stops the issue for good', async () => {
    const claim = chain({ returning: [] });
    // The checks before the claim ran past 10:00 AM, so the claim finds nothing.
    claim.update.mockImplementation(() => {
      jest.setSystemTime(new Date('2026-12-03T15:00:01Z'));
      return { returning: jest.fn(async () => []) };
    });
    const revert = chain();
    const issueRow = chain();
    wire({
      newsletter_sends: [chain({ rows: [QUEUED] }), chain({ first: QUEUED }), claim, chain({ first: { status: 'scheduled' } }), revert],
      newsletter_subscribers: [chain({ rows: PLANNED_ROWS }), chain({ rows: PLANNED_ROWS })],
      pest_insider_issues: [chain({ first: PLANNED }), issueRow],
      // The sync run the send-time HOLD check starts at 9:59 finishes clean.
      email_sync_state: [chain({ first: { last_sync_at: new Date('2026-12-03T14:59:00Z'), errors: null } })],
    });

    const result = await processScheduledSends();

    expect(result).toEqual({ processed: 0 });
    expect(claim.whereRaw).toHaveBeenCalledWith('clock_timestamp() < ?::timestamptz', [WINDOW_END]);
    expect(revert.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft', scheduled_for: null, proof_approved_at: null }));
    expect(issueRow.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', reason: 'stopped at send time: its send window closed before the send could start',
    }));
    // Its one alert comes from settlePlannedIssues, which retries it until it reaches the owner.
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(require('../services/sendgrid-mail').sendBroadcast).not.toHaveBeenCalled();
  });
});
