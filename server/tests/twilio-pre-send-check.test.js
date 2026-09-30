// options.preSendCheck is the canonical messaging pipeline's send-window
// boundary re-check, and it must be awaited as the LAST step before
// c.messages.create() — sendSMS's own internal awaits (redirect check,
// template lookup, customer/location query) can carry a 19:59 ET send past
// the 20:00 cutoff, so any earlier placement re-opens the boundary race
// (codex r2). Fail closed: a throwing check blocks the send.

const mockTwilioCreate = jest.fn();
const mockValidateOutbound = jest.fn(() => ({ ok: true }));

jest.mock('twilio', () => jest.fn(() => ({
  messages: { create: mockTwilioCreate },
})));
jest.mock('../config', () => ({
  twilio: {
    accountSid: 'AC_test',
    authToken: 'auth_test',
    verifyServiceSid: 'VA_test',
  },
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(gate => gate !== 'smsGratitudeReplies'),
  // Push channel routing reads this at send time; false keeps routing inert
  // so these tests keep asserting the legacy SMS path.
  gateEnvValue: jest.fn(() => false),
  gateEnvTimestamp: jest.fn(() => null),
}));
jest.mock('../models/db', () => jest.fn());
// Codex round 3 on #4608 (structural move, P1 PRRT_kwDOR3YQi86j8Ydm): the
// annual-offer guard's AUTHORITATIVE check now lives inside sendSMS's own
// dispatch(), the true provider boundary. Mocked transparently (always
// allowed) by default so every existing test in this file — none of whose
// bodies carry an estimate link — is unaffected; the tests below override it.
jest.mock('../services/estimate-annual-guard', () => ({
  annualHandoffGuard: jest.fn(() => async () => ({ blocked: false, reason: null, estimateId: null })),
  // Round 8 P1: default no-op (nothing rewritten) so every existing test
  // in this file is unaffected; the withheldLinkPolicy tests below override it.
  rewriteWithheldEstimateLinks: jest.fn(async ({ text }) => ({ html: undefined, text, rewrittenIds: [] })),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  isTemplateActive: jest.fn(async () => true),
}));
jest.mock('../services/sms-guard', () => ({
  validateOutbound: (...args) => mockValidateOutbound(...args),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(() => Promise.resolve()),
}));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => {}) }));
jest.mock('../services/messaging/sync-optout', () => ({ recordSyncProviderOptOut: jest.fn(async () => {}) }));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// callback_number_needed (PR #4807): every SMS is checked against
// disclaimed_number_holds (sendCustomerMessage + sendSMS's dispatch). Not
// under test here — stubbed to "never held" so no hold read reaches the db.
jest.mock('../services/disclaimed-number-holds', () => ({
  disclaimedNumberBlocksSend: jest.fn(async () => false),
}));

const TwilioService = require('../services/twilio');
const { annualHandoffGuard, rewriteWithheldEstimateLinks } = require('../services/estimate-annual-guard');
const { isEnabled } = require('../config/feature-gates');

const TO = '+19415550123';
const FROM = '+19413180000';

describe('TwilioService.sendSMS preSendCheck (provider-handoff gate)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateOutbound.mockReturnValue({ ok: true });
    mockTwilioCreate.mockResolvedValue({ sid: 'SM_ok' });
    delete process.env.OWNER_SMS_DISABLED;
    // codex #5018 P2: the accepted-send recovery insert now opens its own
    // short transaction on the base connection (holding a transaction-
    // scoped advisory lock around the check-then-insert). Every test below
    // that reaches it needs `db.transaction` to exist and run its callback
    // against the SAME base-connection mock the test configures via
    // `db.mockImplementation` — that mock IS what a fresh base-connection
    // transaction resolves to here, never the caller's own dead trx.
    // `db.raw` backs the advisory-lock SELECT itself.
    require('../models/db').transaction = jest.fn(async (cb) => cb(require('../models/db')));
    require('../models/db').raw = jest.fn(async () => ({}));
  });

  test('a passing check sends normally', async () => {
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
      fromNumber: FROM,
      preSendCheck,
    });
    expect(preSendCheck).toHaveBeenCalledTimes(1);
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.sid).toBe('SM_ok');
    expect(result.deliveryOutcome).toBe('accepted');
  });

  test('direct SMS callers strip external links without changing provider callback URLs', async () => {
    const body = 'Review: https://g.page/r/demo/review';
    const result = await TwilioService.sendSMS(TO, body, {
      messageType: 'manual', fromNumber: FROM,
    });
    expect(result.success).toBe(true);
    expect(mockTwilioCreate.mock.calls[0][0]).toMatchObject({
      body: 'Review: g.page/r/demo/review',
      statusCallback: expect.stringMatching(/^https:\/\//),
    });
  });

  test('MMS captions and media fetch URLs preserve their HTTPS schemes', async () => {
    const body = 'Photo: https://example.com/photo';
    await TwilioService.sendSMS(TO, body, {
      messageType: 'manual', fromNumber: FROM, mediaUrls: ['https://example.com/photo.jpg'],
    });
    expect(mockTwilioCreate.mock.calls[0][0]).toMatchObject({
      body, mediaUrl: ['https://example.com/photo.jpg'],
    });
  });

  test('a blocked check stops the send before messages.create and carries the deferral fields', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
      fromNumber: FROM,
      preSendCheck: () => ({
        ok: false,
        code: 'QUIET_HOURS_HOLD',
        reason: 'Automated SMS is limited to 8:00 AM-8:00 PM ET',
        retryable: true,
        deferred: true,
        nextAllowedAt: '2026-08-07T12:00:00.000Z',
      }),
    });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      sid: null,
      preSendBlocked: true,
      code: 'QUIET_HOURS_HOLD',
      retryable: true,
      deferred: true,
      nextAllowedAt: '2026-08-07T12:00:00.000Z',
    });
  });

  test('a throwing check fails closed', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
      fromNumber: FROM,
      preSendCheck: () => { throw new Error('window check exploded'); },
    });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      preSendBlocked: true,
      code: 'PRE_SEND_CHECK_FAILED',
    });
  });

  test('legacy callers without preSendCheck are unaffected', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
      fromNumber: FROM,
    });
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  // codex #5018 r15 pre-push P1: sms_log now writes INSIDE dispatch(), on
  // the caller's own trx when one exists — so it lands BEFORE the lock
  // releases, never after. Writing it after (this test's OLD assertion,
  // ['locked', 'sdk', 'released', 'sms_log']) let a second locker waiting
  // on the SAME key acquire it, see no evidence yet, and send a duplicate.
  test('handoff locks enclose the SDK call AND the sms_log write; log time follows lock acquisition', async () => {
    const events = [];
    const acquiredAt = new Date('2026-01-01T15:00:02Z');
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T15:00:00Z'));
    require('../models/db').mockImplementation(table => ({ insert: async row => {
      events.push(table);
      expect(row.created_at).toEqual(acquiredAt);
      expect(JSON.parse(row.metadata).notificationEventKey).toBe('payment-expiry:pm-1:9:2026:expired');
    } }));
    mockTwilioCreate.mockImplementation(async () => { events.push('sdk'); return { sid: 'SM_ok' }; });
    try {
      const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
        notificationEventKey: 'payment-expiry:pm-1:9:2026:expired',
        // codex #5018 structural fix (post-r7): the in-transaction insert
        // this test proves is now opt-in.
        logInHandoff: true,
        withSmsHandoff: async dispatch => {
          events.push('locked');
          jest.setSystemTime(acquiredAt);
          await dispatch();
          events.push('released');
          return { ok: true };
        },
      });
      expect(result.success).toBe(true);
      expect(events).toEqual(['locked', 'sdk', 'sms_log', 'released']);
    } finally { jest.useRealTimers(); require('../models/db').mockReset(); }
  });

  // codex #5018 r15 pre-push P1: the SAME evidence-before-release ordering,
  // but with a real trx object supplied to dispatch — the write must land
  // on THAT connection, never silently fall back to the plain db, or a
  // caller's own transaction rollback would not also roll back the log row.
  test('with a caller-supplied trx, the sms_log write lands on THAT connection, never the plain db', async () => {
    const trxInsert = jest.fn(async () => {});
    // knex convention: calling the trx itself as a function selects a table.
    const trx = jest.fn((_table) => ({ insert: trxInsert }));
    // codex #5018 r15/r16 P1 follow-up: dispatch()'s own in-transaction
    // insert now takes a transaction-scoped advisory lock on `trx` (the
    // SAME key the recovery insert already does) right before it inserts —
    // a real knex trx carries `.raw` directly on the transaction object,
    // same as `db`.
    trx.raw = jest.fn(async () => ({}));
    // codex #5196 P1-B: the in-handoff insert now runs inside a SAVEPOINT
    // (`trx.transaction(...)`) so a failed insert doesn't abort the whole
    // handoff transaction — a real knex trx exposes `.transaction()` for
    // this the same way it exposes `.raw()`; forwarding the SAME mock trx
    // to the callback is enough to exercise the real code path here, since
    // this repo's own convention treats a savepoint connection identically
    // to its parent for table access.
    trx.transaction = jest.fn((cb) => cb(trx));
    require('../models/db').mockImplementation(() => ({
      insert: jest.fn(async () => { throw new Error('sms_log must not write on the plain db when a trx is held'); }),
    }));
    try {
      const result = await TwilioService.sendSMS(TO, 'Reminder body', {
        messageType: 'manual', fromNumber: FROM,
        // codex #5018 structural fix (post-r7): the in-transaction insert
        // this test proves is now opt-in.
        logInHandoff: true,
        withSmsHandoff: async dispatch => { await dispatch(trx); return { ok: true }; },
      });
      expect(result.success).toBe(true);
      expect(trxInsert).toHaveBeenCalledTimes(1);
    } finally { require('../models/db').mockReset(); }
  });

  // codex #5018 r15/r16 P1 follow-up: the ORIGINAL in-handoff insert now
  // takes the SAME advisory lock key the recovery insert already does
  // (hashtextextended('sms_log_sid:'||sid, 0)), transaction-scoped on the
  // held trx, right before it inserts — closing the window where recovery
  // could run its own check-then-insert while this original was still open
  // (its insert made but not yet committed, invisible under READ
  // COMMITTED) and land a genuine duplicate. Real cross-connection blocking
  // behavior is proven with a real Postgres advisory lock in
  // call-booking-link-text-postgres.test.js (a mocked trx cannot prove a
  // second session actually waits); this pins the key + ordering.
  test('the original in-handoff insert takes the same sms_log_sid advisory lock, on trx, before it inserts', async () => {
    const order = [];
    const trxInsert = jest.fn(async () => { order.push('insert'); });
    const trx = jest.fn((_table) => ({ insert: trxInsert }));
    trx.raw = jest.fn(async (...args) => { order.push('raw'); return args; });
    trx.transaction = jest.fn((cb) => cb(trx));
    require('../models/db').mockImplementation(() => ({ insert: jest.fn(async () => {}) }));
    try {
      const result = await TwilioService.sendSMS(TO, 'Reminder body', {
        messageType: 'manual', fromNumber: FROM,
        logInHandoff: true,
        withSmsHandoff: async dispatch => { await dispatch(trx); return { ok: true }; },
      });
      expect(result.success).toBe(true);
      expect(trx.raw).toHaveBeenCalledWith(
        expect.stringContaining('pg_advisory_xact_lock(hashtextextended('),
        ['sms_log_sid:SM_ok'],
      );
      // Same key derivation the recovery insert below uses (`sms_log_sid:`
      // + the exact twilio_sid) — never a different namespace.
      expect(trx.raw.mock.calls[0][1]).toEqual([`sms_log_sid:${result.sid}`]);
      expect(order).toEqual(['raw', 'insert']); // lock acquired BEFORE the insert
    } finally { require('../models/db').mockReset(); }
  });

  // The lock is transaction-scoped (pg_advisory_xact_lock, never taken on
  // the plain base connection) — a bare dispatch() call with no trx has
  // nothing to scope it to, so it is skipped entirely; the insert still
  // runs on the plain db unchanged.
  test('a bare dispatch() call with no trx never attempts the advisory lock', async () => {
    const baseRaw = jest.fn(async () => {});
    require('../models/db').mockImplementation(() => ({ insert: jest.fn(async () => {}) }));
    require('../models/db').raw = baseRaw;
    try {
      const result = await TwilioService.sendSMS(TO, 'Reminder body', {
        messageType: 'manual', fromNumber: FROM, logInHandoff: true,
      });
      expect(result.success).toBe(true);
      expect(baseRaw).not.toHaveBeenCalled();
    } finally { require('../models/db').mockReset(); }
  });

  // codex #5018 round-2 P1: dispatch()'s own sms_log insert runs INSIDE the
  // caller's handoff transaction. If that transaction rolls back, or its own
  // commit fails, AFTER Twilio accepted the message, the in-transaction
  // insert rolls back with it even though the SMS genuinely sent — the catch
  // below used to just log a warning and return success, silently losing the
  // ONE piece of durable evidence linkSentRecently and delivery reconciliation
  // read. Recreate the row on the base connection outside the dead
  // transaction, with every field the in-transaction insert would have
  // written.
  test('a caller transaction that fails AFTER Twilio accepted recreates the sms_log row on the base connection, with the same fields', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T15:00:00Z'));
    const trxInsert = jest.fn(async () => {});
    // knex convention: calling the trx itself as a function selects a table.
    const trx = jest.fn((_table) => ({ insert: trxInsert }));
    // codex #5018 r15/r16 P1 follow-up: dispatch()'s own in-transaction
    // insert now takes a transaction-scoped advisory lock on `trx` (the
    // SAME key the recovery insert already does) right before it inserts —
    // a real knex trx carries `.raw` directly on the transaction object,
    // same as `db`.
    trx.raw = jest.fn(async () => ({}));
    trx.transaction = jest.fn((cb) => cb(trx));
    const baseInserted = [];
    require('../models/db').mockImplementation((table) => {
      if (table !== 'sms_log') throw new Error(`unexpected table: ${table}`);
      return {
        // No row exists yet on the base connection — the transaction really
        // did roll back, taking its own in-transaction insert with it.
        where: () => ({ first: async () => undefined }),
        insert: async (row) => { baseInserted.push(row); },
      };
    });
    try {
      const result = await TwilioService.sendSMS(TO, 'Reminder body', {
        messageType: 'manual', fromNumber: FROM, customerId: 'cust-1', adminUserId: 'admin-1',
        notificationEventKey: 'payment-expiry:pm-1:9:2026:expired',
        // codex #5018 structural fix (post-r7): the in-transaction insert
        // this test proves is now opt-in.
        logInHandoff: true,
        withSmsHandoff: async (dispatch) => {
          // The SDK call and the in-transaction sms_log insert both
          // "succeed" on trx — then the caller's own transaction fails to
          // commit (or the handoff wrapper throws some other error) AFTER
          // that, exactly mirroring a real commit failure.
          await dispatch(trx);
          throw new Error('commit failed');
        },
      });
      // Known acceptance is preserved — never surfaced as a send failure.
      expect(result.success).toBe(true);
      expect(result.sid).toBe('SM_ok');
      // The doomed in-transaction insert still ran once (on trx, not db).
      expect(trxInsert).toHaveBeenCalledTimes(1);
      // Recreated exactly once, on the base connection.
      expect(baseInserted).toHaveLength(1);
      const row = baseInserted[0];
      expect(row).toMatchObject({
        customer_id: 'cust-1',
        direction: 'outbound',
        from_phone: FROM,
        to_phone: TO,
        message_body: 'Reminder body',
        twilio_sid: 'SM_ok',
        status: 'sent',
        created_at: new Date('2026-01-01T15:00:00Z'),
        message_type: 'manual',
        admin_user_id: 'admin-1',
      });
      expect(JSON.parse(row.metadata)).toMatchObject({
        pre_handoff_stamp: true,
        notificationEventKey: 'payment-expiry:pm-1:9:2026:expired',
      });
    } finally { jest.useRealTimers(); require('../models/db').mockReset(); }
  });

  // The other half of the same fix: a caller whose transaction ACTUALLY
  // committed (the row genuinely exists) but which threw some unrelated
  // later error — e.g. releasing its own advisory lock after commit — must
  // never get a duplicate row for the one send that already landed.
  test('a caller transaction whose commit actually succeeded, but which threw a later error, does not duplicate the sms_log row', async () => {
    const trxInsert = jest.fn(async () => {});
    const trx = jest.fn((_table) => ({ insert: trxInsert }));
    // codex #5018 r15/r16 P1 follow-up: dispatch()'s own in-transaction
    // insert now takes a transaction-scoped advisory lock on `trx` (the
    // SAME key the recovery insert already does) right before it inserts —
    // a real knex trx carries `.raw` directly on the transaction object,
    // same as `db`.
    trx.raw = jest.fn(async () => ({}));
    trx.transaction = jest.fn((cb) => cb(trx));
    const baseInsert = jest.fn(async () => {});
    require('../models/db').mockImplementation((table) => {
      if (table !== 'sms_log') throw new Error(`unexpected table: ${table}`);
      return {
        // The commit already landed — a row with this SID genuinely exists.
        where: () => ({ first: async () => ({ id: 'already-there' }) }),
        insert: baseInsert,
      };
    });
    try {
      const result = await TwilioService.sendSMS(TO, 'Reminder body', {
        messageType: 'manual', fromNumber: FROM,
        // codex #5018 structural fix (post-r7): the in-transaction insert
        // this test proves is now opt-in.
        logInHandoff: true,
        withSmsHandoff: async (dispatch) => {
          await dispatch(trx);
          throw new Error('some unrelated post-commit error');
        },
      });
      expect(result.success).toBe(true);
      expect(trxInsert).toHaveBeenCalledTimes(1);
      expect(baseInsert).not.toHaveBeenCalled();
    } finally { require('../models/db').mockReset(); }
  });

  // codex #5018 round-3 P1: catching the in-transaction insert's OWN
  // failure and swallowing it (the pre-fix shape) would leave a real
  // Postgres transaction ABORTED, whose later COMMIT does not error — it
  // silently performs a ROLLBACK instead (standard Postgres protocol
  // behavior for a COMMIT on an aborted transaction) — so the caller's own
  // `conn.transaction(...)` would resolve as if it had succeeded and the
  // withSmsHandoff catch's accepted-send recovery above would never run at
  // all. dispatch()'s own insert failure must rethrow when a trx is held,
  // so the caller's transaction genuinely rejects and that recovery fires;
  // a bare (no-trx) dispatch() call has no transaction to abort and keeps
  // swallowing its own log failure unchanged, proven by the SAME
  // `trx` / no-`trx` distinction the caller-supplied-trx test above pins.
  test('a genuine in-transaction sms_log insert failure propagates and still triggers the base-connection recovery', async () => {
    const insertError = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    const trxInsert = jest.fn(async () => { throw insertError; });
    const trx = jest.fn((_table) => ({ insert: trxInsert }));
    // codex #5018 r15/r16 P1 follow-up: dispatch()'s own in-transaction
    // insert now takes a transaction-scoped advisory lock on `trx` (the
    // SAME key the recovery insert already does) right before it inserts —
    // a real knex trx carries `.raw` directly on the transaction object,
    // same as `db`.
    trx.raw = jest.fn(async () => ({}));
    trx.transaction = jest.fn((cb) => cb(trx));
    const baseInserted = [];
    require('../models/db').mockImplementation((table) => {
      if (table !== 'sms_log') throw new Error(`unexpected table: ${table}`);
      return {
        where: () => ({ first: async () => undefined }),
        insert: async (row) => { baseInserted.push(row); },
      };
    });
    try {
      const result = await TwilioService.sendSMS(TO, 'Reminder body', {
        messageType: 'manual', fromNumber: FROM,
        // codex #5018 structural fix (post-r7): the in-transaction insert
        // this test proves is now opt-in.
        logInHandoff: true,
        // No explicit throw of its own — the propagation must come from
        // dispatch()'s own rethrow, not from anything this wrapper adds.
        withSmsHandoff: async (dispatch) => dispatch(trx),
      });
      expect(result.success).toBe(true);
      expect(trxInsert).toHaveBeenCalledTimes(1);
      expect(baseInserted).toHaveLength(1);
      expect(baseInserted[0]).toMatchObject({ twilio_sid: 'SM_ok', status: 'sent' });
    } finally { require('../models/db').mockReset(); }
  });

  test('a bare dispatch() call with no trx still swallows its own sms_log insert failure (nothing to abort)', async () => {
    require('../models/db').mockImplementation((table) => {
      if (table !== 'sms_log') throw new Error(`unexpected table: ${table}`);
      return { insert: async () => { throw new Error('insert failed'); } };
    });
    try {
      const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM });
      expect(result.success).toBe(true);
    } finally { require('../models/db').mockReset(); }
  });

  // codex #5018 structural fix (post-r7): a withSmsHandoff caller that does
  // NOT opt into logInHandoff must get origin/main's exact original
  // behavior — the sms_log write happens on the plain base connection,
  // AFTER the handoff's own transaction has already resolved, never on the
  // held trx. This is what makes it safe for a caller to hold whatever row
  // locks it needs across the handoff without a new ordering conflict
  // against sms_log's customer_id FK KEY SHARE.
  test('a withSmsHandoff caller that does not opt into logInHandoff gets the post-handoff insert on the plain db, never on its own trx (origin/main behavior)', async () => {
    const trxInsert = jest.fn(async () => { throw new Error('non-opt-in caller must never insert on trx'); });
    const trx = jest.fn((_table) => ({ insert: trxInsert }));
    // codex #5018 r15/r16 P1 follow-up: dispatch()'s own in-transaction
    // insert now takes a transaction-scoped advisory lock on `trx` (the
    // SAME key the recovery insert already does) right before it inserts —
    // a real knex trx carries `.raw` directly on the transaction object,
    // same as `db`.
    trx.raw = jest.fn(async () => ({}));
    const baseInserted = [];
    const events = [];
    require('../models/db').mockImplementation((table) => {
      if (table !== 'sms_log') throw new Error(`unexpected table: ${table}`);
      return { insert: async (row) => { events.push('sms_log'); baseInserted.push(row); } };
    });
    try {
      const result = await TwilioService.sendSMS(TO, 'Reminder body', {
        messageType: 'manual', fromNumber: FROM, customerId: 'cust-1',
        // No logInHandoff — the default for every caller that doesn't name it.
        withSmsHandoff: async (dispatch) => {
          events.push('locked');
          await dispatch(trx);
          events.push('released');
          return { ok: true };
        },
      });
      expect(result.success).toBe(true);
      // dispatch() itself never touched sms_log at all on the non-opt-in path.
      expect(trxInsert).not.toHaveBeenCalled();
      // The write lands after the handoff released, on the plain db.
      expect(events).toEqual(['locked', 'released', 'sms_log']);
      expect(baseInserted).toHaveLength(1);
      expect(baseInserted[0]).toMatchObject({
        customer_id: 'cust-1', twilio_sid: 'SM_ok', status: 'sent',
      });
    } finally { require('../models/db').mockReset(); }
  });

  test.each([
    ['stamps human_authored on the sms_log row for a composer-typed body', { humanAuthored: true }, true],
    ['leaves human_authored off for an automated or unchanged-draft manual send', { humanAuthored: false }, false],
    ['leaves human_authored off when the option is absent', {}, false],
  ])('%s', async (_label, extra, expected) => {
    const rows = [];
    require('../models/db').mockImplementation(() => ({ insert: async row => { rows.push(row); } }));
    try {
      const result = await TwilioService.sendSMS(TO, 'Yes, the app is the easiest way to move it.', {
        messageType: 'manual', fromNumber: FROM, ...extra,
      });
      expect(result.success).toBe(true);
      expect(rows).toHaveLength(1);
      const metadata = JSON.parse(rows[0].metadata);
      expect(metadata.pre_handoff_stamp).toBe(true);
      expect(metadata.human_authored === true).toBe(expected);
      expect(Object.prototype.hasOwnProperty.call(metadata, 'human_authored')).toBe(expected);
    } finally { require('../models/db').mockReset(); }
  });

  test.each([
    ['stamps the visit and its send-time property (Codex #4816 r41/r49)', { appointmentId: 'visit-123' }, 'visit-123', 'prop-1'],
    ['leaves both off when the send names no visit', {}, undefined, undefined],
  ])('%s', async (_label, extra, expected, expectedProperty) => {
    const rows = [];
    require('../models/db').mockImplementation((table) => (table === 'scheduled_services'
      ? { where: () => ({ first: async () => ({ property_id: 'prop-1' }) }) }
      : { insert: async row => { rows.push(row); } }));
    try {
      const result = await TwilioService.sendSMS(TO, 'Your appointment is confirmed.', {
        messageType: 'confirmation', fromNumber: FROM, ...extra,
      });
      expect(result.success).toBe(true);
      expect(JSON.parse(rows[0].metadata).scheduled_service_id).toBe(expected);
      expect(JSON.parse(rows[0].metadata).property_id).toBe(expectedProperty);
    } finally { require('../models/db').mockReset(); }
  });

  test.each([
    ['a typed send with no media option (scheduled dispatch) records zero media', { humanAuthored: true }, []],
    ['a typed send with media urls but no media option stays unknown', { humanAuthored: true, mediaUrls: ['https://example.invalid/a.jpg'] }, undefined],
    ['an automated send records no media evidence', { humanAuthored: false }, undefined],
    ['a caller-supplied media array is kept as is', { humanAuthored: true, media: [] }, []],
  ])('%s', async (_label, extra, expected) => {
    const rows = [];
    require('../models/db').mockImplementation(() => ({ insert: async row => { rows.push(row); } }));
    try {
      const result = await TwilioService.sendSMS(TO, 'Yes, the app is the easiest way to move it.', {
        messageType: 'manual', fromNumber: FROM, ...extra,
      });
      expect(result.success).toBe(true);
      expect(JSON.parse(rows[0].metadata).media).toEqual(expected);
    } finally { require('../models/db').mockReset(); }
  });

  test('a direct customer caller publishes before its handoff and settles the normalized accepted provider context afterward', async () => {
    const coordination = require('../services/messaging/provider-handoff-reservation');
    const handle = { direct: true };
    const events = [];
    const applies = jest.spyOn(coordination, 'directCoordinationApplies').mockReturnValue(true);
    const prepare = jest.spyOn(coordination, 'prepareProviderHandoffReservation').mockImplementation(async (input) => {
      events.push(['reserve', input]);
      return { handle };
    });
    const capture = jest.spyOn(coordination, 'captureProviderContext').mockImplementation((_handle, context) => {
      events.push(['capture', context]);
    });
    const record = jest.spyOn(coordination, 'recordProviderOutcome').mockImplementation((_handle, outcome) => {
      events.push(['outcome', outcome]);
    });
    const settle = jest.spyOn(coordination, 'settleProviderHandoffReservation').mockImplementation(async () => {
      events.push(['settle']);
      return true;
    });
    mockTwilioCreate.mockImplementationOnce(async payload => {
      events.push(['sdk', payload]);
      return { sid: `SM${'2'.repeat(32)}` };
    });
    try {
      const result = await TwilioService.sendSMS('(941) 555-0123', 'Thanks — visit https://example.com', {
        messageType: 'estimate_service_details', fromNumber: FROM,
        notificationEventKey: 'payment-expiry:pm-1:9:2026:expired',
        // codex #5018 round-3 P1: dispatch()'s own sms_log insert now
        // rethrows a failure when `trx` is truthy, so `trx` must be a
        // genuinely callable stand-in here (matching every other trx mock
        // in this file) — a bare `{ held: true }` marker (not a function)
        // would itself throw when called as `trx('sms_log')`, which is
        // exactly the kind of failure that rethrow now correctly surfaces.
        withSmsHandoff: async dispatch => {
          events.push(['handoff']);
          await dispatch(jest.fn(() => ({ insert: jest.fn(async () => {}) })));
          events.push(['handoff-done']);
          return { ok: true };
        },
      });
      expect(result).toMatchObject({ success: true, deliveryOutcome: 'accepted' });
      expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
        to: '+19415550123', fromNumber: FROM,
        body: 'Thanks - visit example.com', messageType: 'estimate_service_details',
      }));
      expect(events.map(([event]) => event)).toEqual(expect.arrayContaining([
        'reserve', 'capture', 'handoff', 'sdk', 'handoff-done', 'outcome', 'settle',
      ]));
      expect(events.find(([event, context]) => event === 'capture' && context.body)?.[1]).toMatchObject({
        to: '+19415550123', fromNumber: FROM, body: 'Thanks - visit example.com',
        messageType: 'estimate_service_details', channel: 'sms',
        metadata: expect.objectContaining({ notificationEventKey: 'payment-expiry:pm-1:9:2026:expired' }),
      });
      const eventNames = events.map(([event]) => event);
      expect(eventNames.indexOf('reserve')).toBeLessThan(eventNames.indexOf('handoff'));
      expect(eventNames.indexOf('sdk')).toBeGreaterThan(eventNames.indexOf('handoff'));
      expect(eventNames.indexOf('settle')).toBeGreaterThan(eventNames.indexOf('handoff-done'));
      expect(capture).toHaveBeenCalledWith(handle, expect.objectContaining({
        providerAcceptedAt: expect.any(Date),
        metadata: expect.objectContaining({ notificationEventKey: 'payment-expiry:pm-1:9:2026:expired' }),
      }));
      expect(settle).toHaveBeenCalledWith(handle);
    } finally {
      applies.mockRestore(); prepare.mockRestore(); capture.mockRestore();
      record.mockRestore(); settle.mockRestore();
    }
  });

  test('direct coordination covers customer-facing sends without a customer id and trusts only the canonical gratitude marker', () => {
    const coordination = require('../services/messaging/provider-handoff-reservation');
    isEnabled.mockReturnValue(true);
    try {
      expect(coordination.directCoordinationApplies({ messageType: 'estimate_service_details' })).toBe(true);
      expect(coordination.directCoordinationApplies({ messageType: 'ai_gratitude' })).toBe(true);
      const owner = coordination.gratitudeReservationOwner({
        audience: 'customer', purpose: 'conversational', entryPoint: 'sms_auto_send_executor',
        metadata: { original_message_type: 'ai_gratitude', agentDecisionId: 'decision-1' },
      }, { providerPreSendCheck: () => {}, withSmsHandoff: () => {} });
      expect(coordination.directCoordinationApplies({
        messageType: 'ai_gratitude', reservationOwner: owner,
      })).toBe(false);
    } finally {
      isEnabled.mockImplementation(gate => gate !== 'smsGratitudeReplies');
    }
  });

  test('a direct coordination database failure is retryable and never reaches the provider', async () => {
    const coordination = require('../services/messaging/provider-handoff-reservation');
    const applies = jest.spyOn(coordination, 'directCoordinationApplies').mockReturnValue(true);
    const prepare = jest.spyOn(coordination, 'prepareProviderHandoffReservation')
      .mockRejectedValue(new Error('database unavailable'));
    try {
      await expect(TwilioService.sendSMS(TO, 'Reminder body', {
        messageType: 'estimate_service_details', fromNumber: FROM,
      })).resolves.toMatchObject({
        success: false, preSendBlocked: true, deliveryOutcome: 'not_sent', retryable: true,
        code: 'PROVIDER_HANDOFF_PREPARATION_FAILED',
      });
      expect(mockTwilioCreate).not.toHaveBeenCalled();
    } finally {
      applies.mockRestore(); prepare.mockRestore();
    }
  });

  test.each([
    ['guard refusal', async () => ({ ok: false, code: 'STALE', reason: 'stale' }), null, 'not_sent'],
    ['SDK uncertainty', async () => ({ ok: true }), Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }), 'uncertain'],
  ])('a direct %s settles only after the final outcome is known', async (_label, preSendCheck, sdkError, expectedOutcome) => {
    const coordination = require('../services/messaging/provider-handoff-reservation');
    const handle = { direct: true };
    const applies = jest.spyOn(coordination, 'directCoordinationApplies').mockReturnValue(true);
    const prepare = jest.spyOn(coordination, 'prepareProviderHandoffReservation').mockResolvedValue({ handle });
    const capture = jest.spyOn(coordination, 'captureProviderContext').mockImplementation(() => {});
    const events = [];
    const record = jest.spyOn(coordination, 'recordProviderOutcome').mockImplementation((_handle, outcome) => {
      events.push(['outcome', outcome.deliveryOutcome]);
    });
    const settle = jest.spyOn(coordination, 'settleProviderHandoffReservation').mockImplementation(async () => {
      events.push(['settle']);
      return true;
    });
    if (sdkError) mockTwilioCreate.mockRejectedValueOnce(sdkError);
    try {
      const pending = TwilioService.sendSMS(TO, 'Reminder body', {
        customerId: 'cust-1', messageType: 'estimate_service_details', fromNumber: FROM, preSendCheck,
      });
      if (sdkError) await expect(pending).rejects.toMatchObject({ providerOutcome: { deliveryOutcome: 'uncertain' } });
      else await expect(pending).resolves.toMatchObject({ success: false, preSendBlocked: true });
      expect(settle).toHaveBeenCalledWith(handle);
      expect(events.slice(-2)).toEqual([['outcome', expectedOutcome], ['settle']]);
    } finally {
      applies.mockRestore(); prepare.mockRestore(); capture.mockRestore();
      record.mockRestore(); settle.mockRestore();
    }
  });


  test('a stale subject refuses the SDK handoff', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async () => ({ ok: false, code: 'LEAD_SUBJECT_CHANGED' }),
    });
    expect(result).toMatchObject({ success: false, preSendBlocked: true, code: 'LEAD_SUBJECT_CHANGED' });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
  });

  test('a guard failure after acceptance preserves the send result', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async dispatch => { await dispatch(); throw new Error('commit connection lost'); },
    });
    expect(result).toMatchObject({ success: true, sid: 'SM_ok' });
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
  });

  test('an authority lookup error blocks retryably without a provider failure alert', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async () => { throw Object.assign(new Error('connection unavailable'), { code: '08006' }); },
    });
    expect(result).toMatchObject({ success: false, preSendBlocked: true, code: 'SMS_HANDOFF_CHECK_FAILED', retryable: true });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(require('../services/twilio-failure-alerts').alertTwilioFailure).not.toHaveBeenCalled();
  });

  // codex #5018 round-2 P1: the post-acceptance sms_log recovery fallback
  // must be gated on genuine provider acceptance — a handoff that fails
  // BEFORE dispatch() ever runs (the provider was never reached) must never
  // touch sms_log at all, recovery included.
  test('the post-acceptance sms_log recovery never runs when the provider was not reached at all', async () => {
    const dbSmsLog = jest.fn();
    require('../models/db').mockImplementation((table) => {
      if (table !== 'sms_log') throw new Error(`unexpected table: ${table}`);
      dbSmsLog();
      return { where: () => ({ first: async () => undefined }), insert: async () => {} };
    });
    try {
      const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
        withSmsHandoff: async () => { throw Object.assign(new Error('connection unavailable'), { code: '08006' }); },
      });
      expect(result).toMatchObject({ success: false, preSendBlocked: true, code: 'SMS_HANDOFF_CHECK_FAILED' });
      expect(mockTwilioCreate).not.toHaveBeenCalled();
      expect(dbSmsLog).not.toHaveBeenCalled();
    } finally { require('../models/db').mockReset(); }
  });

  test.each([
    ['timeout', Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })],
    ['reset', Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })],
    ['HTTP 408', Object.assign(new Error('request timeout'), { status: 408 })],
    ['timeout with an incidental 4xx status', Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT', status: 400 })],
    ['HTTP 503', Object.assign(new Error('provider unavailable'), { status: 503 })],
    ['unknown handoff error', new Error('unexpected transport failure')],
  ])('an SDK %s stays uncertain and follows provider failure handling', async (_label, failure) => {
    mockTwilioCreate.mockRejectedValueOnce(failure);
    await expect(TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async dispatch => { await dispatch(); return { ok: true }; },
    })).rejects.toMatchObject({
      providerOutcome: { sent: false, deliveryOutcome: 'uncertain' },
    });
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(require('../services/twilio-failure-alerts').alertTwilioFailure).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])('a missing SID remains uncertain (guarded: %s)', async guarded => {
    mockTwilioCreate.mockResolvedValueOnce({});
    await expect(TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM,
      ...(guarded ? { withSmsHandoff: async dispatch => { await dispatch(); return { ok: true }; } } : {}),
    })).rejects.toMatchObject({ providerOutcome: { sent: false, deliveryOutcome: 'uncertain' } });
  });

  test('a provider 4xx is a definitive retryable/non-retryable rejection', async () => {
    mockTwilioCreate.mockRejectedValueOnce(Object.assign(new Error('too many requests'), { code: 20429, status: 429 }));

    await expect(TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM,
    })).rejects.toMatchObject({
      status: 429,
      providerOutcome: { sent: false, deliveryOutcome: 'not_sent' },
    });
  });

  test('a pre-provider 5xx-shaped exception is still definitive non-delivery', async () => {
    jest.spyOn(TwilioService, 'deriveOutboundNumber').mockRejectedValueOnce(
      Object.assign(new Error('location lookup unavailable'), { status: 503 }),
    );

    await expect(TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
    })).rejects.toMatchObject({
      status: 503,
      providerOutcome: { sent: false, deliveryOutcome: 'not_sent' },
    });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
  });

  test('an exception after an accepted SDK response preserves acceptance provenance', async () => {
    require('../services/conversations').recordTouchpoint.mockImplementationOnce(() => {
      throw Object.assign(new Error('touchpoint module failed'), { status: 503 });
    });

    await expect(TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM,
    })).rejects.toMatchObject({
      providerOutcome: {
        sent: true,
        deliveryOutcome: 'accepted',
        providerMessageId: 'SM_ok',
      },
    });
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
  });

  test('a guarded send cannot escape through explicit push routing', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
      explicitPushOnly: true, withSmsHandoff: jest.fn(),
    });
    expect(result).toMatchObject({ success: false, code: 'UNSUPPORTED_SMS_HANDOFF' });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
  });
});

describe('annual-offer guard at the TRUE provider boundary (Codex round 3 on #4608, P1 PRRT_kwDOR3YQi86j8Ydm — structural move)', () => {
  // This is a SIBLING describe, not nested under the first one — its
  // beforeEach (jest.clearAllMocks + mockTwilioCreate's default resolve)
  // never runs for tests here, so a queued once-value left over from the
  // FIRST describe's last test (several of which chain
  // mockRejectedValueOnce/mockImplementationOnce on the SAME shared
  // mockTwilioCreate) can otherwise leak in. Reset fully, independently.
  beforeEach(() => {
    jest.clearAllMocks();
    mockTwilioCreate.mockResolvedValue({ sid: 'SM_ok' });
    annualHandoffGuard.mockReturnValue(async () => ({ blocked: false, reason: null, estimateId: null }));
  });

  test('runs INSIDE a caller withSmsHandoff lock — AFTER it acquires, not before (closes the preSendCheck-before-the-lock gap)', async () => {
    const events = [];
    annualHandoffGuard.mockReturnValueOnce(async () => { events.push('guard'); return { blocked: false, reason: null, estimateId: null }; });
    mockTwilioCreate.mockImplementation(async () => { events.push('sdk'); return { sid: 'SM_ok' }; });

    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async dispatch => {
        events.push('locked');
        await dispatch();
        events.push('released');
        return { ok: true };
      },
    });

    expect(result.success).toBe(true);
    expect(events).toEqual(['locked', 'guard', 'sdk', 'released']);
  });

  // Pre-push audit P2 (twilio.js:953, round 12): dispatch() must reuse the
  // handoff's OWN transaction for the guard read, not open a second
  // root-pool connection while the first is still held.
  test('with a caller withSmsHandoff, the guard\'s loader is called with the HELD trx, not the module db', async () => {
    const db = require('../models/db');
    const trxSentinel = { __isTrx: true };
    let capturedDb;
    annualHandoffGuard.mockImplementationOnce((args) => { capturedDb = args.db; return async () => ({ blocked: false, reason: null, estimateId: null }); });

    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async dispatch => { await dispatch(trxSentinel); return { ok: true }; },
    });

    expect(result.success).toBe(true);
    expect(capturedDb).toBe(trxSentinel);
    expect(capturedDb).not.toBe(db);
  });

  test('with NO caller withSmsHandoff (plain dispatch), the guard\'s loader falls back to the module db', async () => {
    const db = require('../models/db');
    let capturedDb;
    annualHandoffGuard.mockImplementationOnce((args) => { capturedDb = args.db; return async () => ({ blocked: false, reason: null, estimateId: null }); });

    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM });

    expect(result.success).toBe(true);
    expect(capturedDb).toBe(db);
  });

  test('a blocked verdict inside the lock never reaches the SDK — a permanent, non-retryable refusal, not the generic handoff-check-failed shape', async () => {
    annualHandoffGuard.mockReturnValueOnce(async () => ({ blocked: true, reason: 'annual_offer_withheld', estimateId: 'est-1' }));

    const result = await TwilioService.sendSMS(TO, 'Your estimate is expiring: https://portal.wavespestcontrol.com/estimate/withheld-token-abc', {
      messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async dispatch => { await dispatch(); return { ok: true }; },
    });

    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false, preSendBlocked: true, code: 'ANNUAL_OFFER_WITHHELD', error: 'annual_offer_withheld',
    });
    // Never the generic "handoff check failed, retryable" shape — this is a
    // definite, permanent refusal.
    expect(result.retryable).not.toBe(true);
  });

  test('a blocked verdict with NO caller handoff (plain dispatch) is a clean guardBlocked refusal — never a Twilio-failure alert or a thrown/wrapped error', async () => {
    annualHandoffGuard.mockReturnValueOnce(async () => ({ blocked: true, reason: 'annual_offer_withheld', estimateId: 'est-1' }));

    const result = await TwilioService.sendSMS(TO, 'https://portal.wavespestcontrol.com/estimate/withheld-token-xyz', {
      messageType: 'manual', fromNumber: FROM,
    });

    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false, guardBlocked: true, code: 'ANNUAL_OFFER_WITHHELD', error: 'annual_offer_withheld', deliveryOutcome: 'not_sent',
    });
    expect(require('../services/twilio-failure-alerts').alertTwilioFailure).not.toHaveBeenCalled();
  });

  test('estimateId / estimateIds options are threaded through as the guard\'s explicit addition, alongside the final normalized body as content', async () => {
    await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, estimateId: 'est-solo',
    });
    expect(annualHandoffGuard).toHaveBeenCalledWith(expect.objectContaining({
      estimateIds: ['est-solo'], texts: ['Reminder body'],
    }));

    annualHandoffGuard.mockClear();
    await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, estimateIds: ['est-a', 'est-b'],
    });
    expect(annualHandoffGuard).toHaveBeenCalledWith(expect.objectContaining({
      estimateIds: ['est-a', 'est-b'], texts: ['Reminder body'],
    }));

    annualHandoffGuard.mockClear();
    await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM });
    expect(annualHandoffGuard).toHaveBeenCalledWith(expect.objectContaining({ estimateIds: [] }));
  });

  test('a guard infrastructure error (the lookup itself throws), with NO withSmsHandoff, resolves to a retryable, provider-never-attempted result — not a withheld/blocked refusal, and never a generic provider-failure throw (round 13 P1)', async () => {
    annualHandoffGuard.mockReturnValueOnce(async () => { throw new Error('estimates lookup unavailable'); });

    // Pre-push audit P1 (twilio.js:964, round 13): a lookup failure here
    // used to propagate as a bare throw, landing in the generic Twilio-
    // error classification below — which treats an unrecognized error code
    // as a definite, non-retryable provider failure. It must instead
    // resolve to the SAME retryable/not-attempted shape sendWindowClosed
    // gets, so a scheduled retry sweep tries again instead of marking an
    // unsent message permanently failed.
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM });

    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false, sid: null, preSendBlocked: true,
      code: 'ANNUAL_OFFER_GUARD_FAILED', retryable: true, deliveryOutcome: 'not_sent',
    });
    expect(result.error).toMatch(/estimates lookup unavailable/);
    expect(require('../services/twilio-failure-alerts').alertTwilioFailure).not.toHaveBeenCalled();
  });

  test('a guard infrastructure error (the lookup itself throws) INSIDE a caller withSmsHandoff also resolves retryable, provider-never-attempted — never the generic handoff-check-failed shape or a Twilio SDK call (round 13 P1)', async () => {
    annualHandoffGuard.mockReturnValueOnce(async () => { throw new Error('estimates lookup unavailable'); });

    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async dispatch => { await dispatch(); return { ok: true }; },
    });

    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false, preSendBlocked: true,
      code: 'ANNUAL_OFFER_GUARD_FAILED', retryable: true,
      validator: 'check_sms_handoff_authority',
    });
    expect(result.error).toMatch(/estimates lookup unavailable/);
  });

  test('round 5 P1: a guard that resolves after the window closes gets ONE more sync recheck immediately before the SDK call — no provider call, window refusal', async () => {
    // The early preSendCheck() passes (window was fine THEN); by the time
    // the guard's own DB reads resolve inside dispatch(), the window has
    // closed — isStillValid() is the ONLY thing that can see that, since
    // it is pure/synchronous and reruns at the true last moment.
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    preSendCheck.isStillValid = jest.fn(() => false);

    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, preSendCheck,
    });

    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(preSendCheck.isStillValid).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false, preSendBlocked: true, code: 'QUIET_HOURS_HOLD', retryable: true,
    });
    expect(require('../services/twilio-failure-alerts').alertTwilioFailure).not.toHaveBeenCalled();
  });

  test('round 5 P1: the same final recheck applies INSIDE a caller withSmsHandoff lock, after the guard, before the SDK call', async () => {
    const events = [];
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    preSendCheck.isStillValid = jest.fn(() => { events.push('isStillValid'); return false; });
    annualHandoffGuard.mockReturnValueOnce(async () => { events.push('guard'); return { blocked: false, reason: null, estimateId: null }; });

    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, preSendCheck,
      withSmsHandoff: async dispatch => {
        events.push('locked');
        await dispatch();
        // dispatch() throws for this refusal — a real caller's own lock
        // release happens around this callback (a try/finally the caller
        // owns), not inside it, so nothing past the throw runs here.
        events.push('released');
        return { ok: true };
      },
    });

    expect(events).toEqual(['locked', 'guard', 'isStillValid']);
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false, preSendBlocked: true, code: 'QUIET_HOURS_HOLD', retryable: true,
    });
  });

  test('round 5 P1: isStillValid() returning true lets the send proceed normally', async () => {
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    preSendCheck.isStillValid = jest.fn(() => true);

    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, preSendCheck,
    });

    expect(preSendCheck.isStillValid).toHaveBeenCalledTimes(1);
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  test('round 5 P1: a preSendCheck with no isStillValid is unaffected (legacy/direct callers)', async () => {
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, preSendCheck,
    });
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  // codex #5018 r15 pre-push P1: onDispatchStart's own await is real
  // wall-clock time, sitting AFTER the isStillValid() recheck above — a
  // second, later window-close is invisible to that first check alone.
  test('codex #5018 r15 pre-push P1: onDispatchStart runs, then a SECOND isStillValid recheck lets the send proceed when the window is still open', async () => {
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    preSendCheck.isStillValid = jest.fn(() => true);
    const onDispatchStart = jest.fn(async () => {});
    const onDispatchAbort = jest.fn(async () => {});

    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, preSendCheck, onDispatchStart, onDispatchAbort,
    });

    expect(onDispatchStart).toHaveBeenCalledTimes(1);
    expect(preSendCheck.isStillValid).toHaveBeenCalledTimes(2); // the original check, plus the new post-marker recheck
    expect(onDispatchAbort).not.toHaveBeenCalled();
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  test('codex #5018 r15 pre-push P1: a window close DURING onDispatchStart\'s own await aborts the marker and refuses, never reaching the SDK', async () => {
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    // First call (before onDispatchStart) still open; second call (right
    // after it) finds the window has closed while that await ran.
    preSendCheck.isStillValid = jest.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const events = [];
    const onDispatchStart = jest.fn(async () => { events.push('onDispatchStart'); });
    const onDispatchAbort = jest.fn(async () => { events.push('onDispatchAbort'); });

    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, preSendCheck, onDispatchStart, onDispatchAbort,
    });

    expect(events).toEqual(['onDispatchStart', 'onDispatchAbort']);
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, preSendBlocked: true, code: 'QUIET_HOURS_HOLD', retryable: true });
  });

  test('codex #5018 r15 pre-push P1: onDispatchAbort throwing is swallowed — the window-close refusal still surfaces, never a worse thrown error', async () => {
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    preSendCheck.isStillValid = jest.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const onDispatchStart = jest.fn(async () => {});
    const onDispatchAbort = jest.fn(async () => { throw new Error('marker table unreachable'); });

    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, preSendCheck, onDispatchStart, onDispatchAbort,
    });

    expect(onDispatchAbort).toHaveBeenCalledTimes(1);
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, preSendBlocked: true, code: 'QUIET_HOURS_HOLD', retryable: true });
  });

  test('codex #5018 r15 pre-push P1: no onDispatchStart at all keeps isStillValid a SINGLE call, byte-identical to before', async () => {
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    preSendCheck.isStillValid = jest.fn(() => true);

    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM, preSendCheck });

    expect(preSendCheck.isStillValid).toHaveBeenCalledTimes(1);
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  test.each([
    ['bare', false],
    ['locked handoff', true],
  ])('a late final predicate blocks the %s path after the suspended annual guard, before the SDK', async (_label, locked) => {
    const events = [];
    let finishGuard;
    let announceGuard;
    let lateCondition = false;
    const guardStarted = new Promise(resolve => { announceGuard = resolve; });
    const guardSuspended = new Promise(resolve => { finishGuard = resolve; });
    annualHandoffGuard.mockReturnValueOnce(async () => {
      events.push('guard:start');
      announceGuard();
      await guardSuspended;
      events.push('guard:end');
      return { blocked: false, reason: null, estimateId: null };
    });
    const providerPreSendCheck = jest.fn(async () => {
      events.push('final');
      return lateCondition
        ? { ok: false, code: 'GRATITUDE_THREAD_CHANGED', reason: 'thread changed', retryable: false }
        : { ok: true };
    });
    const trx = { __isTrx: true };

    const resultPromise = TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
      fromNumber: FROM,
      providerPreSendCheck,
      ...(locked ? {
        withSmsHandoff: async dispatch => {
          events.push('locked');
          await dispatch(trx);
          return { ok: true };
        },
      } : {}),
    });
    await guardStarted;
    expect(providerPreSendCheck).not.toHaveBeenCalled();
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    lateCondition = true;
    finishGuard();

    const result = await resultPromise;
    expect(events).toEqual(locked
      ? ['locked', 'guard:start', 'guard:end', 'final']
      : ['guard:start', 'guard:end', 'final']);
    expect(providerPreSendCheck).toHaveBeenCalledTimes(1);
    expect(providerPreSendCheck).toHaveBeenCalledWith({
      channel: 'sms',
      dbi: locked ? trx : require('../models/db'),
    });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      preSendBlocked: true,
      code: 'GRATITUDE_THREAD_CHANGED',
      error: 'thread changed',
      retryable: false,
      validator: 'provider_pre_send_check_boundary',
      deliveryOutcome: 'not_sent',
    });
  });

  test.each([
    ['bare', false],
    ['locked handoff', true],
  ])('a throwing final predicate fails the %s path closed as a definite retryable non-send', async (_label, locked) => {
    const providerPreSendCheck = jest.fn(async () => {
      throw Object.assign(new Error('fresh thread unavailable'), {
        code: 'GRATITUDE_CONTEXT_UNAVAILABLE',
        retryable: true,
      });
    });

    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
      fromNumber: FROM,
      providerPreSendCheck,
      ...(locked ? {
        withSmsHandoff: async dispatch => { await dispatch(); return { ok: true }; },
      } : {}),
    });

    expect(providerPreSendCheck).toHaveBeenCalledTimes(1);
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      preSendBlocked: true,
      code: 'GRATITUDE_CONTEXT_UNAVAILABLE',
      error: 'fresh thread unavailable',
      retryable: true,
      validator: 'provider_pre_send_check_boundary',
      deliveryOutcome: 'not_sent',
    });
    expect(require('../services/twilio-failure-alerts').alertTwilioFailure).not.toHaveBeenCalled();
  });

  test('a passing final predicate runs once after the annual guard and before the sync check and SDK', async () => {
    const events = [];
    annualHandoffGuard.mockReturnValueOnce(async () => {
      events.push('annual');
      return { blocked: false, reason: null, estimateId: null };
    });
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    preSendCheck.isStillValid = jest.fn(() => { events.push('sync'); return true; });
    const providerPreSendCheck = jest.fn(async () => { events.push('final'); return { ok: true }; });
    mockTwilioCreate.mockImplementationOnce(async () => { events.push('sdk'); return { sid: 'SM_ok' }; });

    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, preSendCheck, providerPreSendCheck,
    });

    expect(result).toMatchObject({ success: true, deliveryOutcome: 'accepted' });
    expect(preSendCheck).toHaveBeenCalledTimes(1);
    expect(providerPreSendCheck).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['annual', 'final', 'sync', 'sdk']);
  });

  test('round 8 P1: withheldLinkPolicy "rewrite" strips a withheld estimate link from the body BEFORE the guard check and the SDK call, and the provider is called with the rewritten text', async () => {
    const originalBody = 'Hello! We received your deposit. https://portal.wavespestcontrol.com/estimate/withheld-token-abc';
    const rewrittenBody = 'Hello! We received your deposit. https://portal.wavespestcontrol.com';
    rewriteWithheldEstimateLinks.mockResolvedValueOnce({ html: undefined, text: rewrittenBody, rewrittenIds: ['est-1'] });

    const result = await TwilioService.sendSMS(TO, originalBody, {
      messageType: 'deposit_receipt', fromNumber: FROM, withheldLinkPolicy: 'rewrite', estimateId: 'est-1',
    });

    // Runs AFTER stripSmsUrlScheme/normalizeGsmPunctuation (this file's own
    // "direct SMS callers strip external links" test pins that behavior),
    // so the scheme is already gone by the time the rewrite sees it — the
    // estimate path/token survives either way.
    expect(rewriteWithheldEstimateLinks).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('/estimate/withheld-token-abc'),
    }));
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    const sentBody = mockTwilioCreate.mock.calls[0][0].body;
    expect(sentBody).toBe(rewrittenBody);
    expect(sentBody).not.toMatch(/\/estimate\//);
    expect(sentBody).toContain('https://portal.wavespestcontrol.com');
    // The guard's own re-derivation runs on the REWRITTEN body, and the
    // explicit estimateId that survived the rewrite must NOT be forced
    // through — it would refuse a body that no longer carries the link.
    expect(annualHandoffGuard).toHaveBeenCalledWith(expect.objectContaining({
      estimateIds: [], texts: [rewrittenBody],
    }));
    expect(result).toMatchObject({ success: true, withheldLinksRewritten: ['est-1'] });
  });

  test('round 8 P1: without withheldLinkPolicy (default refuse), a withheld estimate link still refuses — never silently rewritten', async () => {
    annualHandoffGuard.mockReturnValueOnce(async () => ({ blocked: true, reason: 'annual_offer_withheld', estimateId: 'est-1' }));

    const result = await TwilioService.sendSMS(TO, 'https://portal.wavespestcontrol.com/estimate/withheld-token-xyz', {
      messageType: 'manual', fromNumber: FROM,
    });

    expect(rewriteWithheldEstimateLinks).not.toHaveBeenCalled();
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, guardBlocked: true, code: 'ANNUAL_OFFER_WITHHELD' });
  });

  test('round 8 P1: withheldLinkPolicy "rewrite" with nothing to rewrite sends the original body unchanged, no marker', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, withheldLinkPolicy: 'rewrite',
    });

    expect(rewriteWithheldEstimateLinks).toHaveBeenCalledTimes(1);
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(mockTwilioCreate.mock.calls[0][0].body).toBe('Reminder body');
    expect(result.withheldLinksRewritten).toBeUndefined();
  });
});

// codex #5196 r4 P2: onDispatchRejected fires from INSIDE dispatch()'s own
// messages.create() catch, still holding whatever lock the caller's
// withSmsHandoff acquired — the sibling of onDispatchAbort/onDispatchStart
// above, for the "Twilio definitively rejected it" outcome instead of a
// pre-provider window close.
describe('onDispatchRejected (codex #5196 r4 P2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTwilioCreate.mockResolvedValue({ sid: 'SM_ok' });
    annualHandoffGuard.mockReturnValue(async () => ({ blocked: false, reason: null, estimateId: null }));
  });

  test('a definitive 4xx rejection calls onDispatchRejected BEFORE the withSmsHandoff callback settles', async () => {
    const events = [];
    const onDispatchRejected = jest.fn(async () => { events.push('onDispatchRejected'); });
    mockTwilioCreate.mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400 }));

    await expect(TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, onDispatchRejected,
      withSmsHandoff: async dispatch => {
        events.push('locked');
        try {
          await dispatch();
        } finally {
          events.push('lock-released');
        }
      },
    })).rejects.toMatchObject({ status: 400, providerOutcome: { sent: false, deliveryOutcome: 'not_sent' } });

    expect(events).toEqual(['locked', 'onDispatchRejected', 'lock-released']);
    expect(onDispatchRejected).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['timeout', Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })],
    ['reset', Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })],
    ['HTTP 408', Object.assign(new Error('request timeout'), { status: 408 })],
    ['HTTP 503', Object.assign(new Error('provider unavailable'), { status: 503 })],
    ['unknown transport error', new Error('unexpected transport failure')],
  ])('an SDK %s never calls onDispatchRejected', async (_label, failure) => {
    const onDispatchRejected = jest.fn();
    mockTwilioCreate.mockRejectedValueOnce(failure);

    await expect(TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, onDispatchRejected,
    })).rejects.toBeTruthy();

    expect(onDispatchRejected).not.toHaveBeenCalled();
  });

  // 21610's opt-out is recorded after the lock releases (outer catch), so
  // the attempt marker must survive until then — the hook must not fire.
  test('a 21610 opt-out rejection never calls onDispatchRejected, and still records the opt-out', async () => {
    const { recordSyncProviderOptOut } = require('../services/messaging/sync-optout');
    const onDispatchRejected = jest.fn();
    mockTwilioCreate.mockRejectedValueOnce(Object.assign(new Error('unsubscribed recipient'), { status: 400, code: 21610 }));

    await expect(TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, onDispatchRejected,
      withSmsHandoff: async dispatch => dispatch(),
    })).rejects.toMatchObject({ status: 400, providerOutcome: { sent: false, deliveryOutcome: 'not_sent' } });

    expect(onDispatchRejected).not.toHaveBeenCalled();
    expect(recordSyncProviderOptOut).toHaveBeenCalledTimes(1);
  });

  test('a missing SID never calls onDispatchRejected', async () => {
    const onDispatchRejected = jest.fn();
    mockTwilioCreate.mockResolvedValueOnce({});

    await expect(TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, onDispatchRejected,
    })).rejects.toBeTruthy();

    expect(onDispatchRejected).not.toHaveBeenCalled();
  });

  test('a successful send never calls onDispatchRejected', async () => {
    const onDispatchRejected = jest.fn();

    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, onDispatchRejected,
    });

    expect(result.success).toBe(true);
    expect(onDispatchRejected).not.toHaveBeenCalled();
  });

  test('onDispatchRejected throwing is swallowed — the classified failure still surfaces unchanged', async () => {
    const onDispatchRejected = jest.fn(async () => { throw new Error('marker table unreachable'); });
    mockTwilioCreate.mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400, code: 21211 }));

    await expect(TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, onDispatchRejected,
    })).rejects.toMatchObject({
      status: 400,
      code: 21211,
      providerOutcome: { sent: false, deliveryOutcome: 'not_sent' },
    });

    expect(onDispatchRejected).toHaveBeenCalledTimes(1);
  });

  test('a caller that never passes onDispatchRejected is unaffected by a definitive rejection', async () => {
    mockTwilioCreate.mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400 }));

    await expect(TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM,
    })).rejects.toMatchObject({ status: 400, providerOutcome: { sent: false, deliveryOutcome: 'not_sent' } });
  });
});

// Codex round-43 P2 (PR #5334): the provider-boundary predicate runs after the disclaimed-number
// hold's await; repeatable predicates (`afterMarker`, the live-ETA checks) also re-run after the
// durable attempt marker's await. Predicates without `afterMarker` stay once-only.
describe('providerPreSendCheck placement at the TRUE provider boundary (round 43)', () => {
  const { disclaimedNumberBlocksSend } = require('../services/disclaimed-number-holds');
  beforeEach(() => {
    jest.clearAllMocks();
    mockTwilioCreate.mockResolvedValue({ sid: 'SM_ok' });
    annualHandoffGuard.mockReturnValue(async () => ({ blocked: false, reason: null, estimateId: null }));
    disclaimedNumberBlocksSend.mockResolvedValue(false);
  });

  test('order: annual guard -> disclaimed-number hold -> provider predicate -> sync window check -> SDK', async () => {
    const events = [];
    annualHandoffGuard.mockReturnValueOnce(async () => { events.push('annual'); return { blocked: false, reason: null, estimateId: null }; });
    disclaimedNumberBlocksSend.mockImplementationOnce(async () => { events.push('disclaimed'); return false; });
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    preSendCheck.isStillValid = jest.fn(() => { events.push('sync'); return true; });
    const providerPreSendCheck = jest.fn(async () => { events.push('final'); return { ok: true }; });
    mockTwilioCreate.mockImplementationOnce(async () => { events.push('sdk'); return { sid: 'SM_ok' }; });
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM, preSendCheck, providerPreSendCheck });
    expect(result).toMatchObject({ success: true });
    expect(events).toEqual(['annual', 'disclaimed', 'final', 'sync', 'sdk']);
    expect(providerPreSendCheck).toHaveBeenCalledTimes(1);
  });

  test('state that changes DURING the disclaimed-number await is caught by the predicate (it used to run first)', async () => {
    let stale = false;
    disclaimedNumberBlocksSend.mockImplementationOnce(async () => { stale = true; return false; });
    const providerPreSendCheck = jest.fn(async () => (stale ? { ok: false, code: 'LIVE_ETA_STALE_AT_BOUNDARY', reason: 'stale', retryable: false } : { ok: true }));
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM, providerPreSendCheck });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, preSendBlocked: true, code: 'LIVE_ETA_STALE_AT_BOUNDARY' });
  });

  test('a disclaimed-number hold still refuses first (retryable) and the predicate never runs', async () => {
    disclaimedNumberBlocksSend.mockResolvedValueOnce(true);
    const providerPreSendCheck = jest.fn(async () => ({ ok: true }));
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM, providerPreSendCheck });
    expect(providerPreSendCheck).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, code: 'CALLBACK_NUMBER_HOLD', retryable: true });
  });

  test('a once-only predicate (no afterMarker) is NOT re-run after onDispatchStart', async () => {
    const events = [];
    const providerPreSendCheck = jest.fn(async () => { events.push('final'); return { ok: true }; });
    const onDispatchStart = jest.fn(async () => { events.push('marker'); });
    mockTwilioCreate.mockImplementationOnce(async () => { events.push('sdk'); return { sid: 'SM_ok' }; });
    await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM, providerPreSendCheck, onDispatchStart });
    expect(events).toEqual(['final', 'marker', 'sdk']);
    expect(providerPreSendCheck).toHaveBeenCalledTimes(1);
  });

  test('a repeatable predicate re-runs AFTER the marker; a refusal there undoes the marker and never reaches the SDK', async () => {
    const events = [];
    let staleByMarker = false;
    const providerPreSendCheck = jest.fn(async () => { events.push('final'); return { ok: true }; });
    providerPreSendCheck.afterMarker = jest.fn(async () => { events.push('after-marker'); return staleByMarker ? { ok: false, code: 'LIVE_ETA_STALE_AT_BOUNDARY', reason: 'stale', retryable: false } : { ok: true }; });
    const onDispatchStart = jest.fn(async () => { events.push('marker'); staleByMarker = true; });
    const onDispatchAbort = jest.fn(async () => { events.push('abort'); });
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM, providerPreSendCheck, onDispatchStart, onDispatchAbort });
    expect(events).toEqual(['final', 'marker', 'after-marker', 'abort']);
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, preSendBlocked: true, code: 'LIVE_ETA_STALE_AT_BOUNDARY', retryable: false });
  });

  test('a repeatable predicate that still passes after the marker lets the send through, marker kept', async () => {
    const events = [];
    const providerPreSendCheck = jest.fn(async () => ({ ok: true }));
    providerPreSendCheck.afterMarker = jest.fn(async () => { events.push('after-marker'); return { ok: true }; });
    const onDispatchStart = jest.fn(async () => { events.push('marker'); });
    const onDispatchAbort = jest.fn(async () => { events.push('abort'); });
    mockTwilioCreate.mockImplementationOnce(async () => { events.push('sdk'); return { sid: 'SM_ok' }; });
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM, providerPreSendCheck, onDispatchStart, onDispatchAbort });
    expect(result).toMatchObject({ success: true });
    expect(events).toEqual(['marker', 'after-marker', 'sdk']);
  });

  test('an unreadable repeat (throws, retryable) also undoes the marker and surfaces retryable', async () => {
    const providerPreSendCheck = jest.fn(async () => ({ ok: true }));
    providerPreSendCheck.afterMarker = jest.fn(async () => { throw Object.assign(new Error('db down'), { code: 'LIVE_ETA_CHECK_FAILED_AT_BOUNDARY', retryable: true }); });
    const onDispatchAbort = jest.fn(async () => {});
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM, providerPreSendCheck, onDispatchStart: jest.fn(async () => {}), onDispatchAbort });
    expect(onDispatchAbort).toHaveBeenCalledTimes(1);
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, code: 'LIVE_ETA_CHECK_FAILED_AT_BOUNDARY', retryable: true });
  });

  test('without an onDispatchStart marker there is nothing to repeat: the flagged predicate runs once', async () => {
    const providerPreSendCheck = jest.fn(async () => ({ ok: true }));
    providerPreSendCheck.afterMarker = jest.fn(async () => ({ ok: true }));
    await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM, providerPreSendCheck });
    expect(providerPreSendCheck).toHaveBeenCalledTimes(1);
    expect(providerPreSendCheck.afterMarker).not.toHaveBeenCalled();
  });
});
