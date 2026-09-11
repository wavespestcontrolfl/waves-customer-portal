// Real webhook control flow; synthetic persistence and inert delivery seams.
const mockState = { sms: [], sequence: 0, ai: true, read: false, pending: 0, claims: new Map() };
let mockPg;
let mockDatabase;
function mockDb(table) {
  // Atomic per-sender alert-window claim (sms_reply_alert_claims): a
  // synthetic Map standing in for the DB-atomic INSERT ... ON CONFLICT ...
  // RETURNING in claimUnknownSenderAlertWindow — release deletes the entry.
  if (table === 'sms_reply_alert_claims') {
    // Ownership-scoped (codex #4210 round-3 P1): confirm/release now filter
    // by {phone, expires_at: token} — the exact lease value the claim
    // returned — so a dispatch whose token no longer matches the row's
    // CURRENT expires_at (another dispatch already reclaimed the phone) is
    // a safe no-op, mirroring the real WHERE phone = ? AND expires_at = ?.
    const q = { _phone: undefined, _token: undefined };
    q.where = (key) => {
      q._phone = key && typeof key === 'object' ? key.phone : undefined;
      q._token = key && typeof key === 'object' ? key.expires_at : undefined;
      return q;
    };
    const owns = () => Boolean(q._phone) && mockState.claims.has(q._phone)
      && (q._token === undefined || mockState.claims.get(q._phone)?.getTime() === q._token?.getTime());
    q.del = async () => {
      if (owns()) { mockState.claims.delete(q._phone); return 1; }
      return 0;
    };
    // Confirm step: extends an existing (short-lease) claim row to the full
    // window — standing in for confirmUnknownSenderAlertWindow's UPDATE.
    q.update = async (patch) => {
      if (owns() && patch?.expires_at) {
        mockState.claims.set(q._phone, patch.expires_at);
        return 1;
      }
      return 0;
    };
    return q;
  }
  if (mockPg && table === 'sms_log') {
    const q = mockPg(table);
    const insert = q.insert.bind(q);
    q.insert = (row) => insert({ created_at: new Date(Date.now() + ++mockState.sequence), ...row });
    if (mockState.omitSmsLogCreatedAt) {
      const ret = q.returning?.bind(q);
      if (ret) q.returning = (...args) => ret(...args).then((rows) => rows.map((r) => ({ ...r, created_at: undefined })));
    }
    for (const method of ['first', 'update']) {
      const run = q[method].bind(q);
      q[method] = (...args) => {
        mockState.pending++;
        return Promise.resolve(run(...args)).finally(() => { mockState.pending--; });
      };
    }
    return q;
  }
  const filters = [];
  const q = { rows: [] };
  q.where = (key, op, value) => {
    if (key && typeof key === 'object') filters.push((r) => Object.entries(key).every(([k, v]) => r[k] === v));
    else if (typeof key === 'string') filters.push((r) => value === undefined ? r[key] === op : op === '<' ? r[key] < value : r[key] > value);
    return q;
  };
  q.whereNot = (key, value) => { filters.push((r) => r[key] !== value); return q; };
  q.whereIn = (key, values) => { filters.push((r) => values.includes(r[key])); return q; };
  q.whereRaw = (sql) => { if (sql.includes("sms_reply_alerted")) filters.push((r) => JSON.parse(r.metadata || '{}').sms_reply_alerted === true); return q; };
  for (const method of ['whereNull', 'orderBy', 'limit', 'select']) q[method] = () => q;
  const matches = () => mockState.sms.filter((r) => filters.every((f) => f(r)));
  q.insert = (row) => {
    const stored = { id: `synthetic-${++mockState.sequence}`, created_at: new Date(Date.now() + mockState.sequence), ...row };
    if (table === 'sms_log') {
      mockState.sms.push(stored);
      // Seam for the "sms_log insert succeeded but returned a row without
      // created_at" scenario (claude pre-push audit P1, round 2): the
      // stored row (read by hasRecentUnknownSenderReceipt) keeps its real
      // created_at; only what's handed back as `smsLogEntry` loses it.
      q.rows = [mockState.omitSmsLogCreatedAt ? { ...stored, created_at: undefined } : stored];
      return q;
    }
    q.rows = [stored]; return q;
  };
  q.update = async (patch) => {
    if (table === 'sms_log') for (const row of matches()) {
      if (patch.metadata?.merge) row.metadata = JSON.stringify({ ...JSON.parse(row.metadata || '{}'), ...patch.metadata.merge });
    }
    return matches().length;
  };
  q.first = async () => table === 'messages' ? { is_read: mockState.read }
    : table === 'sms_log' ? matches()[0] || null : null;
  q.returning = async () => q.rows;
  q.then = (resolve, reject) => Promise.resolve(q.rows).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(q.rows).catch(reject);
  return q;
}
// Seam for the atomic alert-window claim: record every attempt and let a
// test force a write failure (fail-open path). No transaction is ever
// opened for this — claimUnknownSenderAlertWindow/release both call plain
// db.raw / db(table) statements directly. Checked BEFORE the mockPg branch
// (codex #4210 round-4 P1) so the whole claims subsystem — this raw INSERT
// AND the table-based confirm/release in mockDb(table) above, which already
// special-cases 'sms_reply_alert_claims' unconditionally — stays on the
// SAME synthetic Map in every mode. Routing just this INSERT to a real
// (unmigrated-for-this-table) Postgres connection when SMS_BELL_QA_URL is
// set would abort the whole shared transaction, while confirm/release kept
// reading/writing the synthetic Map regardless — two disconnected stores
// that could never agree, and a claim insert failure this table's own
// `mockPg` temp-table setup was never asked to survive.
const mockClaim = { calls: [], fail: false };
mockDb.raw = (sql, values) => {
  if (String(sql).includes('sms_reply_alert_claims')) {
    mockClaim.calls.push({ sql: String(sql), values });
    if (mockClaim.fail) throw Object.assign(new Error('synthetic claim write failure'), { code: 'synthetic' });
    const [phone, expiresAt, now] = values;
    const existing = mockState.claims.get(phone);
    if (existing && existing > now) return { rows: [] }; // still held — claim lost
    mockState.claims.set(phone, expiresAt);
    return { rows: [{ phone }] };
  }
  if (mockPg) return mockPg.raw(sql, values);
  return { sql, merge: values?.[0] ? JSON.parse(values[0]) : {} };
};
mockDb.transaction = async () => ({
  raw: async () => ({ rows: [] }),
  rollback: async () => {},
});
jest.mock('../models/db', () => mockDb);
jest.mock('../config/feature-gates', () => ({ isEnabled: (key) => key === 'webhooks' || (key === 'aiAssistantAutoReply' && mockState.ai) }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({})) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/messaging/validators/suppression', () => ({ recordSuppression: jest.fn(), clearSuppression: jest.fn() }));
jest.mock('../services/messaging/inbound-dedupe', () => ({ tryClaimInboundWebhook: async () => ({ processable: true, owned: true }), releaseInboundWebhook: jest.fn() }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(async () => ({ message: { id: 'synthetic-message' } })), updateByTwilioSid: jest.fn() }));
jest.mock('../services/sms-media', () => ({ uploadTwilioMedia: jest.fn(async () => []) }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => {}), isFailureStatus: () => false }));
jest.mock('../middleware/spam-block', () => ({ checkInboundBlock: async () => ({ blocked: false }) }));
jest.mock('../services/contact-correction', () => ({ detectContactCorrectionIntent: () => false }));
jest.mock('../services/contact-correction-queue', () => ({}));
jest.mock('../services/recipient-optin', () => ({ markRecipientOptin: async () => true }));
jest.mock('../services/estimate-clarify-asks', () => ({ handleClarifyReply: async () => ({ handled: false }) }));
jest.mock('../services/estimator-engine/sms-thread', () => ({ smsThreadDraftsEnabled: () => false }));
jest.mock('../services/estimate-conversion-agent', () => ({ processInboundSms: async () => ({}) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: true, push: { sent: 1 } })) }));
jest.mock('../services/ai-assistant/assistant', () => ({ processMessage: jest.fn(async () => ({ reply: 'Synthetic answer', escalated: false })) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));

const { EventEmitter } = require('node:events');
const { triggerNotification } = require('../services/notification-triggers');
const { processMessage } = require('../services/ai-assistant/assistant');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { uploadTwilioMedia } = require('../services/sms-media');
const numbers = require('../config/twilio-numbers');
const webhookRouter = require('../routes/twilio-webhook');
const handler = webhookRouter.stack.find((l) => l.route?.path === '/sms').route.stack[0].handle;
const { claimUnknownSenderAlertWindow, confirmUnknownSenderAlertWindow, releaseUnknownSenderAlertClaim } = webhookRouter._internals;
const aiLine = '+18559260203';
const sender = '+12025550101';
async function receive(body = 'What services do you offer?', to = aiLine) {
  const sid = `SM-synthetic-${mockState.sequence + 1}`;
  const res = new EventEmitter();
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = () => res;
  res.send = (value) => { res.body = value; return res; };
  await handler({ body: { From: sender, To: to, Body: body, MessageSid: sid } }, res);
  // The real route acknowledges before its notification work. Drain the
  // tracked PostgreSQL promises rather than asserting immediately after ACK.
  let stable = 0;
  const deadline = Date.now() + 3000;
  while (stable < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    stable = mockState.pending ? 0 : stable + 1;
  }
  expect(mockState.pending).toBe(0);
  expect(res.body).toBe('<Response></Response>');
  const errors = require('../services/logger').error.mock.calls.filter(([message]) => !String(message).startsWith('AI '));
  expect(errors).toEqual([]);
  return sid;
}
beforeAll(async () => {
  const connection = process.env.SMS_BELL_QA_URL;
  if (!connection) return;
  if (!/^\/waves_qa_[a-f0-9]{32}$/.test(new URL(connection).pathname)) throw new Error('Use a private QA database');
  mockDatabase = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
  mockPg = await mockDatabase.transaction();
  await mockPg.raw(`CREATE TEMP TABLE sms_log (
    id uuid DEFAULT gen_random_uuid(), customer_id uuid, direction text, from_phone text, to_phone text,
    message_body text, twilio_sid text, status text, message_type text, is_read boolean,
    metadata jsonb, created_at timestamptz DEFAULT clock_timestamp()
  )`);
});
afterAll(async () => { await mockPg?.rollback(); await mockDatabase?.destroy(); });
async function storedMetadata() {
  const row = mockPg ? await mockPg('sms_log').orderBy('created_at').first() : mockState.sms[0];
  return typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
}
beforeEach(async () => {
  if (mockPg) await mockPg.raw('TRUNCATE sms_log');
  jest.clearAllMocks();
  mockState.sms = []; mockState.sequence = 0; mockState.ai = true; mockState.read = false; mockState.claims = new Map(); mockState.omitSmsLogCreatedAt = false;
  mockClaim.calls = []; mockClaim.fail = false;
  processMessage.mockResolvedValue({ reply: 'Synthetic answer', escalated: false });
  sendCustomerMessage.mockResolvedValue({ sent: true });
  triggerNotification.mockResolvedValue({ bellWritten: true, push: { sent: 1 } });
  uploadTwilioMedia.mockResolvedValue([]);
});

test('a delivered non-escalated AI reply does not ring or consume the alert window', async () => {
  await receive();
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  expect(triggerNotification).not.toHaveBeenCalled();
  expect((await storedMetadata()).sms_reply_alerted).toBeUndefined();
});

test.each(['escalated', 'no reply', 'model failure', 'blocked send', 'send failure'])('rings when the AI produces %s', async (outcome) => {
  if (outcome === 'escalated') processMessage.mockResolvedValue({ escalated: true });
  if (outcome === 'no reply') processMessage.mockResolvedValue({ reply: '' });
  if (outcome === 'model failure') processMessage.mockRejectedValue(new Error('synthetic model failure'));
  if (outcome === 'blocked send') sendCustomerMessage.mockResolvedValue({ sent: false, code: 'synthetic_block' });
  if (outcome === 'send failure') sendCustomerMessage.mockRejectedValue(new Error('synthetic send failure'));
  await receive();
  expect(triggerNotification).toHaveBeenCalledWith('sms_reply', expect.objectContaining({ fromPhone: sender }), expect.any(Object));
  expect((await storedMetadata()).sms_reply_alerted).toBe(true);
});

test('an MMS-only inbound rings without trying the text-only AI handler', async () => {
  uploadTwilioMedia.mockResolvedValue([{ url: 'https://example.test/synthetic.jpg' }]);
  await receive('');
  expect(processMessage).not.toHaveBeenCalled();
  expect(triggerNotification).toHaveBeenCalledTimes(1);
});

test('a successfully answered AI turn cannot throttle a later human-bound request', async () => {
  await receive();
  mockState.ai = false;
  await receive('Please have the office help me.');
  expect(triggerNotification).toHaveBeenCalledTimes(1);
  await receive('Additional details for the office.');
  expect(triggerNotification).toHaveBeenCalledTimes(1);
});

test('an undelivered alert does not throttle the next request', async () => {
  mockState.ai = false;
  triggerNotification.mockResolvedValueOnce({ bellWritten: false, push: { sent: 0 } });
  await receive();
  await receive('Please help with this request.');
  expect(triggerNotification).toHaveBeenCalledTimes(2);
});

test('ordinary location-line unknown texts ring the SMS bell', async () => {
  await receive('Please quote pest control.', numbers.locations.parrish.number);
  expect(triggerNotification).toHaveBeenCalledTimes(1);
  expect(processMessage).not.toHaveBeenCalled();
});

test('the alert window is claimed atomically with no transaction held across the dispatch', async () => {
  mockState.ai = false;
  await receive('Please quote pest control.', numbers.locations.parrish.number);
  const claim = mockClaim.calls.find(({ sql }) => sql.includes('INSERT INTO sms_reply_alert_claims'));
  expect(claim).toBeDefined();
  expect(claim.values[0]).toBe(sender);
  // The claim is a single INSERT ... RETURNING, never a held pooled
  // transaction — codex #4210 head-round P1.
  expect(mockClaim.calls).toHaveLength(1);
  expect(triggerNotification).toHaveBeenCalledTimes(1);
});

test('two concurrent claims for the same sender let only one dispatch', async () => {
  mockState.ai = false;
  // Simulate the exact race the claim closes: a second sender arrives while
  // the first still holds the (unexpired) window.
  mockState.claims.set(sender, new Date(Date.now() + 60 * 60 * 1000));
  await receive('Please quote pest control.', numbers.locations.parrish.number);
  expect(triggerNotification).not.toHaveBeenCalled();
});

test('a claim write failure rings unfenced rather than dropping first contact', async () => {
  mockState.ai = false;
  mockClaim.fail = true;
  await receive('Please quote pest control.', numbers.locations.parrish.number);
  expect(triggerNotification).toHaveBeenCalledTimes(1);
});

test('a claim is released, not extended, when a prior receipt (rung outside the claim path) already covers the window', async () => {
  // A loud reaction rings ringSmsReplyBell directly without ever claiming
  // (twilio-webhook.js's reaction branch), so its receipt has no matching
  // claims-table row — only the sms_log stamp windowHeld() reads.
  const priorReceiptAt = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3h ago — still inside the 4h window
  const row = { direction: 'inbound', from_phone: sender, to_phone: numbers.locations.parrish.number,
    message_type: 'inbound', created_at: priorReceiptAt, twilio_sid: 'SM-prior-reaction',
    metadata: JSON.stringify({ sms_reply_alerted: true }) };
  if (mockPg) await mockPg('sms_log').insert(row);
  else mockState.sms.push(row);
  mockState.ai = false;
  await receive('Please quote pest control.', numbers.locations.parrish.number);
  expect(triggerNotification).not.toHaveBeenCalled();
  // Fixed (pre-push audit P1): the fresh claim this message took is
  // released rather than left with a 4h-from-now expiry that would
  // outlive the real receipt's own (much sooner) cutoff.
  expect(mockState.claims.has(sender)).toBe(false);
});

test('a claimed window that never delivers is released for the next message to retry', async () => {
  mockState.ai = false;
  triggerNotification.mockResolvedValueOnce({ bellWritten: false, push: { sent: 0 } });
  await receive('Please quote pest control.', numbers.locations.parrish.number);
  expect(mockState.claims.has(sender)).toBe(false);
  await receive('Second message, same sender.', numbers.locations.parrish.number);
  expect(triggerNotification).toHaveBeenCalledTimes(2);
});

test('a consumed START or a courtesy row does not consume the first alert window', async () => {
  for (const message_type of ['opt_in', 'inbound']) {
    const row = { direction: 'inbound', from_phone: sender, to_phone: aiLine,
      message_type, created_at: new Date(Date.now() - 1000), twilio_sid: `SM-prior-${message_type}`,
      metadata: JSON.stringify({ courtesyOnly: message_type === 'inbound' }) };
    if (mockPg) await mockPg('sms_log').insert(row);
    else mockState.sms.push(row);
  }
  mockState.ai = false;
  await receive('Please quote pest control.');
  expect(triggerNotification).toHaveBeenCalledTimes(1);
});

test('a loud reaction from an unknown sender rings the sms_reply bell', async () => {
  mockState.ai = false;
  await receive('Disliked "We will treat inside"', numbers.locations.parrish.number);
  expect(triggerNotification).toHaveBeenCalledTimes(1);
});

test('loud reactions from an unknown sender are throttled through the SAME per-sender window as ordinary texts (claude pre-push audit P1)', async () => {
  mockState.ai = false;
  await receive('Disliked "We will treat inside"', numbers.locations.parrish.number);
  expect(triggerNotification).toHaveBeenCalledTimes(1);
  // Fixed: the reaction path used to call ringSmsReplyBell directly,
  // completely unthrottled — a second loud reaction from the same sender
  // inside the 4h window would ring again, reproducing the exact
  // 19-alerts-from-one-thread spam incident this throttle exists to
  // prevent. It now shares dispatchUnknownSenderAlert with the ordinary
  // alertEligible path, so this second one must NOT ring again.
  await receive('Questioned "We will treat inside"', numbers.locations.parrish.number);
  expect(triggerNotification).toHaveBeenCalledTimes(1);
});

test('a loud reaction consumes the window for a later ordinary text from the same sender, and vice versa', async () => {
  mockState.ai = false;
  await receive('Disliked "We will treat inside"', numbers.locations.parrish.number);
  expect(triggerNotification).toHaveBeenCalledTimes(1);
  await receive('Please quote pest control.', numbers.locations.parrish.number);
  expect(triggerNotification).toHaveBeenCalledTimes(1);
});

test('an unknown sender still throttles through dispatchUnknownSenderAlert when smsLogEntry carries no created_at (claude pre-push audit P1, round 2)', async () => {
  mockState.ai = false;
  mockState.omitSmsLogCreatedAt = true;
  // Fixed: the ordinary-text branch used to route on `!customer &&
  // smsLogEntry?.created_at`, so a falsy/malformed smsLogEntry (its insert
  // is best-effort) fell through to an UNTHROTTLED ringSmsReplyBell call for
  // an unknown sender — the exact bypass this PR's throttle exists to close.
  // It now routes purely on `customer` truthiness; a second message from
  // the same unknown sender must still be suppressed.
  await receive('Please quote pest control.', numbers.locations.parrish.number);
  expect(triggerNotification).toHaveBeenCalledTimes(1);
  await receive('Second message, same sender.', numbers.locations.parrish.number);
  expect(triggerNotification).toHaveBeenCalledTimes(1);
});

test('a delivered alert confirms the claim to the full 4h window, not left on the short claim lease (codex #4210 round-2 P1)', async () => {
  mockState.ai = false;
  const before = Date.now();
  await receive('Please quote pest control.', numbers.locations.parrish.number);
  const expiresAt = mockState.claims.get(sender);
  expect(expiresAt).toBeDefined();
  // The claim lease is a couple of minutes; a confirmed window is ~4h out.
  // Assert it landed well past the lease so a stray "confirm never ran"
  // regression (the window silently staying on the short lease) shows up.
  expect(expiresAt.getTime() - before).toBeGreaterThan(3 * 60 * 60 * 1000);
});

test('an expired, unconfirmed lease is reclaimed by the next message instead of blocking on a claim nothing ever delivered for (codex #4210 round-2 P1)', async () => {
  mockState.ai = false;
  // Stands in for the deploy-crash gap: the process died between the claim
  // insert and confirmUnknownSenderAlertWindow, leaving a row whose (short)
  // lease has already expired with no bell ever rung for it.
  mockState.claims.set(sender, new Date(Date.now() - 1000));
  await receive('Please quote pest control.', numbers.locations.parrish.number);
  expect(triggerNotification).toHaveBeenCalledTimes(1);
  // And the winning claim itself gets confirmed to the full window.
  expect(mockState.claims.get(sender).getTime() - Date.now()).toBeGreaterThan(3 * 60 * 60 * 1000);
});

test('a dispatch that outlasts its lease cannot confirm or release a claim a later message has since reclaimed (codex #4210 round-3 P1)', async () => {
  // A controlled clock so A's and B's leases land on distinct, deterministic
  // timestamps rather than relying on real wall-clock drift between two
  // synchronous awaits (which can otherwise land in the same millisecond).
  const start = Date.now();
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  try {
    jest.setSystemTime(start);
    // Dispatch A claims first.
    const a = await claimUnknownSenderAlertWindow(sender);
    expect(a.claimed).toBe(true);
    expect(a.token).toBeDefined();

    // Simulate A's lease (2 minutes) expiring — a slow network/DB, not a
    // failure — before A ever confirms or releases: the row is now
    // reclaimable by whoever checks next.
    jest.setSystemTime(start + 3 * 60 * 1000);
    // Dispatch B, for a LATER message from the same sender, reclaims the
    // now-expired lease and gets its OWN token.
    const b = await claimUnknownSenderAlertWindow(sender);
    expect(b.claimed).toBe(true);
    expect(b.token.getTime()).not.toBe(a.token.getTime());
    const bOwnedExpiry = mockState.claims.get(sender);

    // A finally finishes (its own network/DB was just slow, not failed) and
    // tries to confirm/release using its STALE token — this must be a
    // no-op against B's now-live claim, not overwrite or delete it.
    await confirmUnknownSenderAlertWindow(sender, a.token);
    expect(mockState.claims.get(sender)).toBe(bOwnedExpiry);
    await releaseUnknownSenderAlertClaim(sender, a.token);
    expect(mockState.claims.has(sender)).toBe(true);
    expect(mockState.claims.get(sender)).toBe(bOwnedExpiry);

    // B's own token, by contrast, correctly confirms B's claim.
    await confirmUnknownSenderAlertWindow(sender, b.token);
    expect(mockState.claims.get(sender).getTime() - start).toBeGreaterThan(3 * 60 * 60 * 1000);
  } finally {
    jest.useRealTimers();
  }
});

test('a fail-open (unfenced) dispatch never confirms or releases a claim it does not own (codex #4210 round-3 P1)', async () => {
  // A genuine claim is held by some other in-flight dispatch.
  const owned = await claimUnknownSenderAlertWindow(sender);
  expect(owned.claimed).toBe(true);

  // A claim ATTEMPT that fails (DB error) returns a null token — it must
  // never touch the row above, even though it "proceeds unfenced" and
  // rings its own bell.
  mockClaim.fail = true;
  const unfenced = await claimUnknownSenderAlertWindow(sender);
  mockClaim.fail = false;
  expect(unfenced.claimed).toBe(true);
  expect(unfenced.token).toBeNull();

  await confirmUnknownSenderAlertWindow(sender, unfenced.token);
  await releaseUnknownSenderAlertClaim(sender, unfenced.token);
  // The genuinely owned claim is untouched — still present, still on its
  // original lease.
  expect(mockState.claims.get(sender)).toBe(owned.token);
});

test('an unknown loud reaction rings exactly one alert — not also the legacy owner forward (codex #4210 round-2 P1)', async () => {
  mockState.ai = false;
  const originalAdamPhone = process.env.ADAM_PHONE;
  process.env.ADAM_PHONE = '+19415993489';
  try {
    await receive('Disliked "We will treat inside"', numbers.locations.parrish.number);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    // Before the fix: the legacy branch's `landed` only gets set when
    // `customer` is truthy, so for an unknown sender it stayed false
    // regardless of the throttled dispatch above already ringing — and the
    // internal_alert owner forward fired as a SECOND, undeduped alert.
    expect(require('../services/twilio').sendSMS).not.toHaveBeenCalled();
  } finally {
    if (originalAdamPhone === undefined) delete process.env.ADAM_PHONE;
    else process.env.ADAM_PHONE = originalAdamPhone;
  }
});
