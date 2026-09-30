/**
 * The scheduler's dispatch claim is bound to the row version the tick read
 * and validated. An admin PATCH that lands between the tick's read and the
 * claim rewrites the content and moves updated_at (and returns the row to
 * draft), so the version-bound claim finds nothing — the edited, unapproved
 * content is never broadcast. A direct sendCampaign (manual send) keeps the
 * legacy draft-or-scheduled claim.
 */
const mockValidateEventSelection = jest.fn(async () => ({ valid: true, errors: [], flagship: false, events: [] }));

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
jest.mock('../services/newsletter-validator', () => ({
  validateNewsletterDraft: jest.fn(() => ({ errors: [], warnings: [] })),
  lockedPricesForSend: jest.fn(async () => []),
}));

const db = require('../models/db');
// The pre-send archived-link relink sweep runs a raw UPDATE in its own
// transaction; nothing stale here, so it is a 0-row no-op.
db.raw = jest.fn(async () => ({ rowCount: 0 }));
db.transaction = jest.fn(async (cb) => cb({ raw: db.raw }));
const { sendCampaign, processScheduledSends } = require('../services/newsletter-sender');

const READ_AT = new Date('2026-10-06T14:00:00Z');
const APPROVED_AT = new Date('2026-10-06T13:55:00Z');
const SEND = {
  id: 'send-pi-1', status: 'scheduled', newsletter_type: 'pest-insider-monthly', subject: 'Pest Insider — October',
  html_body: '<p>Body</p>', text_body: 'Body', event_ids: [], segment_filter: null,
  scheduled_for: new Date('2026-10-06T13:56:00Z'), updated_at: READ_AT, proof_approved_at: APPROVED_AT,
};

function chain({ first, rows, returning } = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereNot', 'whereNotIn', 'whereNotNull', 'whereNull', 'whereNotExists', 'whereIn',
    'select', 'orderBy', 'leftJoin', 'join', 'forUpdate',
    // excludeMarketingOptedOut's pre-filtering CTE (codex #5165) — a no-op
    // chain link here, same as every other query-shape method above.
    'withMaterialized'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.limit = jest.fn(async () => rows || []);
  q.first = jest.fn(async () => first);
  q.count = jest.fn(() => ({ first: jest.fn(async () => ({ c: 5 })) }));
  q.update = jest.fn(() => ({ returning: jest.fn(async () => returning || []) }));
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
    newsletter_subscribers: [chain(), chain()],
  });

  const result = await processScheduledSends();

  expect(result).toEqual({ processed: 0 });
  expect(claim.where).toHaveBeenCalledWith({ id: 'send-pi-1' });
  expect(claim.where).toHaveBeenCalledWith({ status: 'scheduled' });
  expect(claim.where).toHaveBeenCalledWith('updated_at', '<', new Date(READ_AT.getTime() + 1));
  expect(claim.whereNotNull).toHaveBeenCalledWith('proof_approved_at');
  expect(claim.where).toHaveBeenCalledWith('proof_approved_at', '<', new Date(APPROVED_AT.getTime() + 1));
  expect(claim.whereIn).not.toHaveBeenCalled();
  expect(claim.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'sending' }));
  // The row was NOT flipped to failed: the only newsletter_sends writes are the claim attempt.
});

test('a direct (manual) sendCampaign keeps the legacy draft-or-scheduled claim and reports a lost race as ALREADY_CLAIMED', async () => {
  const claim = chain({ returning: [] });
  wire({
    newsletter_sends: [chain({ first: SEND }), claim],
    newsletter_subscribers: [chain()],
  });

  await expect(sendCampaign('send-pi-1')).rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });
  expect(claim.whereIn).toHaveBeenCalledWith('status', ['draft', 'scheduled']);
  expect(claim.where).not.toHaveBeenCalledWith({ status: 'scheduled' });
});

test('a version-bound claim that finds no row throws VERSION_CHANGED, never ALREADY_CLAIMED', async () => {
  const claim = chain({ returning: [] });
  wire({
    newsletter_sends: [chain({ first: SEND }), claim],
    newsletter_subscribers: [chain()],
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
    newsletter_subscribers: [chain()],
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
    newsletter_subscribers: [chain()],
  });

  await expect(sendCampaign('send-pi-1', { expect: { status: 'scheduled', updatedAt: READ_AT, proofApprovedAt: APPROVED_AT } }))
    .rejects.toMatchObject({ code });
  // Nothing past the version check ran: no event gate, no relink sweep, no claim.
  expect(mockValidateEventSelection).not.toHaveBeenCalled();
  expect(db.transaction).not.toHaveBeenCalled();
  expect(claim.update).not.toHaveBeenCalled();
});
