jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(),
}));
jest.mock('../utils/portal-url', () => ({
  portalUrl: jest.fn((path) => `https://portal.test${path}`),
}));
jest.mock('../utils/datetime-et', () => ({
  addETDays: jest.fn((d) => d),
  etDateString: jest.fn(() => '2026-08-11'), // frozen min effective date
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
  isSendRefusal: jest.fn((err) => !!err && err.preDispatchRefusal === true),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/annual-prepay-renewals', () => ({
  getActivelyCoveredCustomerIds: jest.fn(async () => []),
  getPaymentPendingCustomerIds: jest.fn(async () => []),
}));

const crypto = require('crypto');
const db = require('../models/db');
db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
db.transaction = jest.fn(async (fn) => fn(db));
const { getInvoiceEmailRecipients } = require('../services/customer-contact');
const { getActivelyCoveredCustomerIds, getPaymentPendingCustomerIds } = require('../services/annual-prepay-renewals');
const { sendTemplate } = require('../services/email-template-library');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { previewPriceChange, createAndSendBatch, sendNoticeSms, sendNoticeEmail } = require('../services/price-change-notices');

let customerRows;
let noticeInserts;
let noticeUpdates;
let activityInserts;
let customersUpdateCalls;
let customersWhereNotInCalls;
let existingNoticeRow;
let rateReviewNoticeRow;
let insertConflict;
let conflictTargets = [];
let claimRejected;

function customersQuery() {
  const q = {
    modify: jest.fn((fn) => { fn(q); return q; }),
    where: jest.fn(() => q),
    whereRaw: jest.fn(() => q),
    whereNull: jest.fn(() => q),
    whereNotIn: jest.fn((...args) => { customersWhereNotInCalls.push(args); return q; }),
    orWhere: jest.fn(() => q),
    select: jest.fn(() => q),
    orderBy: jest.fn(() => q),
    update: jest.fn((...args) => { customersUpdateCalls.push(args); return Promise.resolve(1); }),
    then: (resolve, reject) => Promise.resolve(customerRows).then(resolve, reject),
  };
  return q;
}

const emailKeyHash = (email) => crypto.createHash('sha256').update(email).digest('hex').slice(0, 10);

function noticesQuery() {
  const q = {
    insert: jest.fn((row) => {
      noticeInserts.push(row);
      const returned = insertConflict ? [] : [{ id: `n-${noticeInserts.length}`, batch_id: row.batch_id, notice_token: row.notice_token }];
      const returning = jest.fn(async () => returned);
      return { onConflict: jest.fn((target) => { conflictTargets.push(target); return { ignore: jest.fn(() => ({ returning })) }; }), returning };
    }),
    where: jest.fn(() => q),
    whereNull: jest.fn(() => q),
    whereNotNull: jest.fn((col) => { if (col === 'rate_review_row_id') q.rateReviewOnly = true; return q; }),
    orderBy: jest.fn(() => q),
    first: jest.fn(async () => (q.rateReviewOnly ? rateReviewNoticeRow : existingNoticeRow)),
    update: jest.fn(async (patch) => {
      noticeUpdates.push(patch);
      // The draft→sending claim reports affected rows; 0 = claim lost.
      if (patch.status === 'sending' && claimRejected) return 0;
      return 1;
    }),
  };
  return q;
}

// The send contract requires the digest from a real preview of the same
// parameters — mirrors what AdminPriceChangePage passes through.
async function digestFor(args) {
  const { previewPriceChange: preview } = require('../services/price-change-notices');
  const out = await preview({ increase: args.increase, locationId: args.locationId || null });
  return out.digest;
}

function prefsQuery() {
  const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
  return q;
}

function activityQuery() {
  return { insert: jest.fn(async (row) => { activityInserts.push(row); return [1]; }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  customerRows = [];
  noticeInserts = [];
  noticeUpdates = [];
  activityInserts = [];
  customersUpdateCalls = [];
  customersWhereNotInCalls = [];
  existingNoticeRow = null;
  rateReviewNoticeRow = null;
  insertConflict = false;
  claimRejected = false;
  getActivelyCoveredCustomerIds.mockResolvedValue([]);
  getPaymentPendingCustomerIds.mockResolvedValue([]);
  db.mockImplementation((table) => {
    if (table === 'customers') return customersQuery();
    if (table === 'price_change_notices') return noticesQuery();
    if (table === 'notification_prefs') return prefsQuery();
    if (table === 'activity_log') return activityQuery();
    throw new Error(`unexpected table ${table}`);
  });
  getInvoiceEmailRecipients.mockImplementation((customer) => [
    { email: customer.email, name: customer.first_name },
  ]);
  sendTemplate.mockResolvedValue({ sent: true });
  renderSmsTemplate.mockResolvedValue('rendered sms body');
  sendCustomerMessage.mockResolvedValue({ sent: true });
});

const CUSTOMER = {
  id: 'c-1',
  first_name: 'Pat',
  last_name: 'Lee',
  email: 'pat@example.com',
  phone: '+19415550001',
  monthly_rate: '49',
};

const GOOD_ARGS = {
  increase: { type: 'amount', value: 3 },
  effectiveDate: '2026-08-15',
  expectedCount: 1,
  actorId: 'admin-1',
};

describe('previewPriceChange', () => {
  it('computes current → new per customer and flags reachability', async () => {
    customerRows = [CUSTOMER, { ...CUSTOMER, id: 'c-2', email: '', phone: '', monthly_rate: '100' }];
    const out = await previewPriceChange({ increase: { type: 'percent', value: 5 } });
    expect(out.count).toBe(2);
    expect(out.rows[0]).toMatchObject({ current: '$49', next: '$51.45', hasEmail: true, hasPhone: true });
    expect(out.rows[1]).toMatchObject({ current: '$100', next: '$105', hasEmail: false, hasPhone: false });
    expect(out.invalidCount).toBe(0);
    expect(out.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes the digest when membership or amounts change at the same count', async () => {
    customerRows = [CUSTOMER];
    const a = (await previewPriceChange({ increase: { type: 'amount', value: 3 } })).digest;
    customerRows = [{ ...CUSTOMER, id: 'c-9' }];
    const b = (await previewPriceChange({ increase: { type: 'amount', value: 3 } })).digest;
    customerRows = [CUSTOMER];
    const c = (await previewPriceChange({ increase: { type: 'amount', value: 4 } })).digest;
    expect(b).not.toBe(a);
    expect(c).not.toBe(a);
  });

  it('counts customers a negative adjustment would take to $0 or below', async () => {
    customerRows = [{ ...CUSTOMER, monthly_rate: '20' }];
    const out = await previewPriceChange({ increase: { type: 'amount', value: -25 } });
    expect(out.invalidCount).toBe(1);
  });

  it('rejects zero, out-of-range, and malformed adjustments', async () => {
    await expect(previewPriceChange({ increase: { type: 'amount', value: 0 } })).rejects.toThrow(/non-zero/);
    await expect(previewPriceChange({ increase: { type: 'percent', value: 150 } })).rejects.toThrow(/between/);
    await expect(previewPriceChange({ increase: { type: 'visits', value: 5 } })).rejects.toThrow(/percent or amount/);
    await expect(previewPriceChange({ increase: { type: 'amount', value: 3 }, locationId: 'tampa' })).rejects.toThrow(/known location/);
  });
});

describe('createAndSendBatch policy gates', () => {
  it('enforces the 30-day advance-notice policy', async () => {
    customerRows = [CUSTOMER];
    await expect(createAndSendBatch({ ...GOOD_ARGS, effectiveDate: '2026-08-10' }))
      .rejects.toThrow(/at least 30 days/);
    expect(noticeInserts).toHaveLength(0);
  });

  it('accepts the exact minimum date', async () => {
    customerRows = [CUSTOMER];
    const out = await createAndSendBatch({ ...GOOD_ARGS, effectiveDate: '2026-08-11', expectedDigest: await digestFor(GOOD_ARGS) });
    expect(out.created).toBe(1);
  });

  it('refuses on count drift without sending', async () => {
    customerRows = [CUSTOMER, { ...CUSTOMER, id: 'c-2' }];
    const out = await createAndSendBatch({ ...GOOD_ARGS, expectedCount: 1 });
    expect(out).toMatchObject({ ok: false, reason: 'count_drift', count: 2 });
    expect(noticeInserts).toHaveLength(0);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('refuses when any customer would land at $0 or below', async () => {
    customerRows = [{ ...CUSTOMER, monthly_rate: '2' }];
    const args = { ...GOOD_ARGS, increase: { type: 'amount', value: -2 } };
    const out = await createAndSendBatch({ ...args, expectedDigest: await digestFor(args) });
    expect(out).toMatchObject({ ok: false, reason: 'invalid_amounts' });
    expect(noticeInserts).toHaveLength(0);
  });

  it('refuses when membership or amounts changed even though the count matches', async () => {
    customerRows = [CUSTOMER];
    const staleDigest = await digestFor(GOOD_ARGS);
    // Same count (1), different member: c-1 left the segment, c-9 entered.
    customerRows = [{ ...CUSTOMER, id: 'c-9' }];
    const out = await createAndSendBatch({ ...GOOD_ARGS, expectedDigest: staleDigest });
    expect(out).toMatchObject({ ok: false, reason: 'list_changed', count: 1 });
    expect(noticeInserts).toHaveLength(0);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('refuses when no digest is supplied', async () => {
    customerRows = [CUSTOMER];
    const out = await createAndSendBatch(GOOD_ARGS);
    expect(out).toMatchObject({ ok: false, reason: 'list_changed' });
    expect(noticeInserts).toHaveLength(0);
  });
});

describe('createAndSendBatch delivery', () => {
  it('creates a tokened notice row and sends both legs with the notice URL', async () => {
    customerRows = [CUSTOMER];
    const out = await createAndSendBatch({ ...GOOD_ARGS, expectedDigest: await digestFor(GOOD_ARGS) });
    expect(out).toMatchObject({ ok: true, created: 1, emailed: 1, texted: 1, unreachable: 0, alreadyNotified: 0, failed: 0 });

    expect(noticeInserts).toHaveLength(1);
    const row = noticeInserts[0];
    expect(row.notice_token).toMatch(/^[a-f0-9]{32}$/);
    expect(row).toMatchObject({ current_amount_cents: 4900, new_amount_cents: 5200, status: 'draft' });

    const emailArgs = sendTemplate.mock.calls[0][0];
    expect(emailArgs.templateKey).toBe('billing.price_change_notice');
    // Stable across retry batches — keyed to the change event + resolved
    // recipient (a corrected address mints a fresh key), never batch_id.
    expect(emailArgs.idempotencyKey).toBe(`price_change:c-1:2026-08-15:4900:5200:${emailKeyHash('pat@example.com')}`);
    expect(emailArgs.suppressionGroupKey).toBe('transactional_required');
    expect(emailArgs.payload.price_change_url).toBe(`https://portal.test/price-change/${row.notice_token}`);
    expect(emailArgs.payload).toMatchObject({ current_price: '$49', new_price: '$52' });

    const smsArgs = sendCustomerMessage.mock.calls[0][0];
    expect(smsArgs).toMatchObject({ purpose: 'billing', customerId: 'c-1', hasEmailLeg: true });

    // claim (draft→sending) then final state
    expect(noticeUpdates[0]).toMatchObject({ status: 'sending' });
    expect(noticeUpdates.at(-1)).toMatchObject({ email_sent: true, sms_sent: true, status: 'sent' });
    expect(activityInserts).toHaveLength(1);
    expect(activityInserts[0].action).toBe('price_change_batch_sent');
  });

  it('never modifies monthly_rate — notices only', async () => {
    customerRows = [CUSTOMER];
    await createAndSendBatch({ ...GOOD_ARGS, expectedDigest: await digestFor(GOOD_ARGS) });
    expect(customersUpdateCalls).toHaveLength(0);
  });

  it('does not declare an email leg to the SMS gate when the email did not send', async () => {
    customerRows = [{ ...CUSTOMER, email: '' }];
    getInvoiceEmailRecipients.mockReturnValue([]);
    await createAndSendBatch({ ...GOOD_ARGS, expectedDigest: await digestFor(GOOD_ARGS) });
    expect(sendCustomerMessage.mock.calls[0][0].hasEmailLeg).toBe(false);
  });

  it('parks true no-contact customers as unreachable — claimable later, never sent', async () => {
    customerRows = [{ ...CUSTOMER, email: '', phone: '' }];
    getInvoiceEmailRecipients.mockReturnValue([]);
    const out = await createAndSendBatch({ ...GOOD_ARGS, expectedDigest: await digestFor(GOOD_ARGS) });
    expect(out).toMatchObject({ ok: true, created: 1, emailed: 0, texted: 0, unreachable: 1, failed: 0 });
    expect(noticeUpdates.at(-1)).toMatchObject({ status: 'unreachable' });
    expect(noticeUpdates.some((u) => u.status === 'sent')).toBe(false);
  });

  it('parks policy-blocked legs as unreachable, not eternally-failing drafts', async () => {
    // Phone-only customer whose SMS is policy-blocked (STOP/pref) — a rerun
    // cannot fix it, so it must not sit in the retryable failed class.
    customerRows = [{ ...CUSTOMER, email: '' }];
    getInvoiceEmailRecipients.mockReturnValue([]);
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'SUPPRESSED' });
    const out = await createAndSendBatch({ ...GOOD_ARGS, expectedDigest: await digestFor(GOOD_ARGS) });
    expect(out).toMatchObject({ ok: true, created: 1, unreachable: 1, failed: 0 });
    expect(noticeUpdates.at(-1)).toMatchObject({ status: 'unreachable' });
  });

  it('parks a bounce-suppressed email-only customer as unreachable', async () => {
    customerRows = [{ ...CUSTOMER, phone: '' }];
    sendTemplate.mockResolvedValue({ sent: false, blocked: true, reason: 'Email suppressed' });
    const out = await createAndSendBatch({ ...GOOD_ARGS, expectedDigest: await digestFor(GOOD_ARGS) });
    expect(out).toMatchObject({ ok: true, created: 1, unreachable: 1, failed: 0 });
    expect(noticeUpdates.at(-1)).toMatchObject({ status: 'unreachable' });
  });

  it('re-attempts an unreachable row once contact info exists', async () => {
    customerRows = [CUSTOMER];
    existingNoticeRow = {
      id: 'n-unreach', status: 'unreachable', notice_token: 'feedfacefeedfacefeedfacefeedface',
      customer_id: 'c-1', current_amount_cents: 4900, new_amount_cents: 5200,
    };
    const out = await createAndSendBatch({ ...GOOD_ARGS, expectedDigest: await digestFor(GOOD_ARGS) });
    expect(out).toMatchObject({ ok: true, created: 0, emailed: 1, texted: 1, alreadyNotified: 0 });
    expect(noticeUpdates.at(-1)).toMatchObject({ email_sent: true, sms_sent: true, status: 'sent' });
  });

  it('never claims or stamps an annual rate review notice for the same change tuple', async () => {
    customerRows = [CUSTOMER];
    existingNoticeRow = {
      id: 'n-review', status: 'draft', notice_token: 'abcdabcdabcdabcdabcdabcdabcdabcd', rate_review_row_id: 'row-1',
      customer_id: 'c-1', current_amount_cents: 4900, new_amount_cents: 5200,
    };
    const out = await createAndSendBatch({ ...GOOD_ARGS, expectedDigest: await digestFor(GOOD_ARGS) });
    expect(out).toMatchObject({ created: 0, emailed: 0, texted: 0, alreadyNotified: 1 });
    expect(noticeUpdates).toEqual([]);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('excludes customers covered by active or pending annual-prepay terms', async () => {
    customerRows = [CUSTOMER];
    getActivelyCoveredCustomerIds.mockResolvedValue(['ap-1']);
    getPaymentPendingCustomerIds.mockResolvedValue(['ap-2']);
    await previewPriceChange({ increase: GOOD_ARGS.increase });
    expect(customersWhereNotInCalls).toContainEqual(['id', ['ap-1', 'ap-2']]);
  });

  it('skips customers already notified of the same change event on retry', async () => {
    customerRows = [CUSTOMER];
    existingNoticeRow = {
      id: 'n-prior', status: 'sent', notice_token: '0123456789abcdef0123456789abcdef',
      customer_id: 'c-1', current_amount_cents: 4900, new_amount_cents: 5200,
    };
    const out = await createAndSendBatch({ ...GOOD_ARGS, expectedDigest: await digestFor(GOOD_ARGS) });
    expect(out).toMatchObject({ ok: true, created: 0, emailed: 0, texted: 0, alreadyNotified: 1, failed: 0 });
    expect(noticeInserts).toHaveLength(0);
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(noticeUpdates).toHaveLength(0);
  });

  it('leaves an event the annual rate review already owns to that lane — its draft is never claimed or sent here', async () => {
    customerRows = [CUSTOMER];
    rateReviewNoticeRow = { id: 'n-rate-review' };
    existingNoticeRow = { id: 'n-rate-review', status: 'draft', notice_token: '0123456789abcdef0123456789abcdef', rate_review_row_id: 'rr-1' };
    const out = await createAndSendBatch({ ...GOOD_ARGS, expectedDigest: await digestFor(GOOD_ARGS) });
    expect(out).toMatchObject({ ok: true, created: 0, emailed: 0, texted: 0, alreadyNotified: 0, rateReview: 1, failed: 0 });
    expect(noticeInserts).toHaveLength(0);
    expect(noticeUpdates).toHaveLength(0);
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  it('targets the legacy (partial) event index by its predicate — rate-review notices key per plan line', async () => {
    customerRows = [CUSTOMER];
    conflictTargets = [];
    await createAndSendBatch({ ...GOOD_ARGS, expectedDigest: await digestFor(GOOD_ARGS) });
    expect(conflictTargets).toEqual([{ sql: '(customer_id, effective_date, current_amount_cents, new_amount_cents) WHERE rate_review_row_id IS NULL', bindings: undefined }]);
    // the lookup and insert run in one transaction under the shared notice-event lock
    const lockCall = db.raw.mock.calls.find(([sql]) => /pg_advisory_xact_lock/.test(sql));
    expect(lockCall[1]).toEqual([0x5043, `${CUSTOMER.id}|${GOOD_ARGS.effectiveDate}|${noticeInserts[0].current_amount_cents}|${noticeInserts[0].new_amount_cents}`]);
    expect(db.transaction).toHaveBeenCalled();
  });

  it('skips a customer when a concurrent send wins the event-insert race', async () => {
    customerRows = [CUSTOMER];
    insertConflict = true; // unique event index swallowed our insert
    const out = await createAndSendBatch({ ...GOOD_ARGS, expectedDigest: await digestFor(GOOD_ARGS) });
    expect(out).toMatchObject({ ok: true, created: 0, emailed: 0, texted: 0, alreadyNotified: 1, failed: 0 });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(noticeUpdates).toHaveLength(0);
  });

  it('keeps the row retryable when a reachable customer has a provider failure on every leg', async () => {
    customerRows = [CUSTOMER];
    sendTemplate.mockResolvedValue({ sent: false });
    sendCustomerMessage.mockResolvedValue({ sent: false });
    const out = await createAndSendBatch({ ...GOOD_ARGS, expectedDigest: await digestFor(GOOD_ARGS) });
    expect(out).toMatchObject({ ok: false, created: 1, emailed: 0, texted: 0, unreachable: 0, failed: 1 });
    // Claim, then release back to 'draft' — never 'sent'. A retry resumes it.
    expect(noticeUpdates.at(-1)).toMatchObject({ status: 'draft' });
    expect(noticeUpdates.some((u) => u.status === 'sent')).toBe(false);
  });

  it('treats a billing-contact-only customer as reachable when the provider fails', async () => {
    // No primary email/phone, but getInvoiceEmailRecipients resolves a
    // billing address — a failed send must stay retryable, not unreachable.
    customerRows = [{ ...CUSTOMER, email: '', phone: '' }];
    getInvoiceEmailRecipients.mockReturnValue([{ email: 'billing@example.com', name: 'Pat' }]);
    sendTemplate.mockResolvedValue({ sent: false });
    const out = await createAndSendBatch({ ...GOOD_ARGS, expectedDigest: await digestFor(GOOD_ARGS) });
    expect(out).toMatchObject({ ok: false, created: 1, unreachable: 0, failed: 1 });
    expect(noticeUpdates.at(-1)).toMatchObject({ status: 'draft' });
  });

  it('skips when another retry holds the draft claim', async () => {
    customerRows = [CUSTOMER];
    existingNoticeRow = {
      id: 'n-draft', status: 'draft', notice_token: 'feedfacefeedfacefeedfacefeedface',
      customer_id: 'c-1', current_amount_cents: 4900, new_amount_cents: 5200,
    };
    claimRejected = true;
    const out = await createAndSendBatch({ ...GOOD_ARGS, expectedDigest: await digestFor(GOOD_ARGS) });
    expect(out).toMatchObject({ ok: true, created: 0, emailed: 0, texted: 0, alreadyNotified: 1, failed: 0 });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  it('resumes a draft row from a crashed attempt, reusing its token instead of inserting', async () => {
    customerRows = [CUSTOMER];
    existingNoticeRow = {
      id: 'n-draft', status: 'draft', notice_token: 'feedfacefeedfacefeedfacefeedface',
      customer_id: 'c-1', current_amount_cents: 4900, new_amount_cents: 5200,
    };
    const out = await createAndSendBatch({ ...GOOD_ARGS, expectedDigest: await digestFor(GOOD_ARGS) });
    expect(out).toMatchObject({ ok: true, created: 0, emailed: 1, texted: 1, alreadyNotified: 0, failed: 0 });
    expect(noticeInserts).toHaveLength(0);
    const emailArgs = sendTemplate.mock.calls[0][0];
    expect(emailArgs.payload.price_change_url).toBe('https://portal.test/price-change/feedfacefeedfacefeedfacefeedface');
    expect(emailArgs.idempotencyKey).toBe(`price_change:c-1:2026-08-15:4900:5200:${emailKeyHash('pat@example.com')}`);
    expect(noticeUpdates.at(-1)).toMatchObject({ email_sent: true, sms_sent: true, status: 'sent' });
  });

  it('reports ok:false when a send throws, without losing the rest of the batch', async () => {
    customerRows = [CUSTOMER, { ...CUSTOMER, id: 'c-2', email: 'two@example.com' }];
    const digest = await digestFor(GOOD_ARGS);
    let call = 0;
    db.mockImplementation((table) => {
      if (table === 'customers') return customersQuery();
      if (table === 'price_change_notices') {
        call += 1;
        if (call === 1) {
          // c-1's prior-notice lookup blows up (no where/first on this stub).
          return { insert: jest.fn(() => { throw new Error('insert boom'); }) };
        }
        return noticesQuery();
      }
      if (table === 'notification_prefs') return prefsQuery();
      if (table === 'activity_log') return activityQuery();
      throw new Error(`unexpected table ${table}`);
    });
    const out = await createAndSendBatch({ ...GOOD_ARGS, expectedCount: 2, expectedDigest: digest });
    expect(out).toMatchObject({ ok: false, created: 1, failed: 1 });
    expect(activityInserts).toHaveLength(1);
  });
});

describe('sendNoticeSms delivery evidence', () => {
  const args = { customer: CUSTOMER, vars: { effective_date: 'December 10, 2026', price_change_url: 'waves.test/p/abc' }, hasEmailLeg: false };
  it('legacy callers keep counting a sent answer as sent', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'not_sent' });
    expect(await sendNoticeSms(args)).toEqual({ sent: true, attempted: true });
  });
  it.each([
    [{ sent: true, deliveryOutcome: 'accepted' }, { sent: true, attempted: true }],
    // SMS gate off / owner silence answer sent:true but nothing left: definitively unsent
    [{ sent: true, deliveryOutcome: 'not_sent' }, { sent: false, attempted: false }],
    // unknown whether it left: held by the caller, never stamped delivered
    [{ sent: true, deliveryOutcome: 'uncertain' }, { sent: false, attempted: true }],
    // the canonical sender's definite provider non-send: sent:false with a not_sent outcome (not blocked)
    [{ sent: false, deliveryOutcome: 'not_sent' }, { sent: false, attempted: false }],
    // an ambiguous failure keeps the attempt (held for the owner)
    [{ sent: false, deliveryOutcome: 'uncertain' }, { sent: false, attempted: true }],
    [{ sent: true }, { sent: false, attempted: true }],
  ])('requireAccepted: %j', async (answer, expected) => {
    sendCustomerMessage.mockResolvedValue(answer);
    expect(await sendNoticeSms({ ...args, requireAccepted: true })).toEqual(expected);
  });
  it('surfaces a caller hook refusal code and merges caller metadata without losing the base', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'NOTICE_REPOINTED' });
    const res = await sendNoticeSms({ ...args, sendOptions: { metadata: { rate_review_letter: true } } });
    expect(res).toEqual({ sent: false, attempted: false, blockedCode: 'NOTICE_REPOINTED' });
    expect(sendCustomerMessage.mock.calls.at(-1)[0].metadata).toMatchObject({ original_message_type: 'price_change_notice', rate_review_letter: true });
  });
});

describe('sendNoticeEmail definite-non-send classification', () => {
  const args = { customer: CUSTOMER, idempotencyKeyBase: 'k', vars: {} };
  beforeEach(() => {
    getInvoiceEmailRecipients.mockReturnValue([{ email: 'pat@example.com', name: 'Pat' }]);
    db.mockImplementation((table) => {
      if (table === 'notification_prefs') return prefsQuery();
      throw new Error(`unexpected table ${table}`);
    });
  });
  it.each([
    ['unconfigured sender', Object.assign(new Error('not configured'), { code: 'SENDGRID_NOT_CONFIGURED' })],
    ['a provider status that conclusively rejects the payload', Object.assign(new Error('bad request'), { status: 400 })],
    ['a pre-dispatch refusal (the reviewed template changed before dispatch)', Object.assign(new Error('The reviewed email content changed.'), { preDispatchRefusal: true })],
  ])('%s: a certain non-send', async (_label, err) => {
    sendTemplate.mockRejectedValue(err);
    expect(await sendNoticeEmail(args)).toEqual({ sent: false, attempted: true, definiteNonSend: true });
  });
  it.each([
    ['a 5xx the provider may have processed', Object.assign(new Error('boom'), { status: 502 })],
    ['a network failure', new Error('socket hang up')],
  ])('%s: stays ambiguous', async (_label, err) => {
    sendTemplate.mockRejectedValue(err);
    expect(await sendNoticeEmail(args)).toEqual({ sent: false, attempted: true });
  });
});

describe('sendNoticeSms preparation failures are certain non-sends', () => {
  const args = { customer: CUSTOMER, vars: { effective_date: 'December 10, 2026', price_change_url: 'waves.test/p/abc' }, hasEmailLeg: false };
  it('a template that renders nothing (missing or inactive) never reached the sender', async () => {
    renderSmsTemplate.mockResolvedValue(null);
    expect(await sendNoticeSms(args)).toEqual({ sent: false, attempted: true, definiteNonSend: true });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
  it('a rendering throw never reached the sender', async () => {
    renderSmsTemplate.mockRejectedValue(new Error('template exploded'));
    expect(await sendNoticeSms(args)).toEqual({ sent: false, attempted: true, definiteNonSend: true });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
  it('a throw from the canonical sender itself stays ambiguous', async () => {
    sendCustomerMessage.mockRejectedValue(new Error('socket hang up'));
    expect(await sendNoticeSms(args)).toEqual({ sent: false, attempted: true });
  });
});
