// GATE_DAY_ONLY_PROMISE part B1 (Codex round 6): every path that stores a day-only notice to send or record LATER carries
// its promise fields (promiseMetaOf / withPromiseMeta in services/time-promise.js), so the later send records a DAY promise
// and not an unknown window, which the readers count as an hour. The 20:00 partial-delivery case runs the real fan-out
// (safeSendAppointment -> queueHeldNoticeContacts) and the real audit row builder and reader; the scheduler's replay
// spread and the writers/replays list are pinned by a source scan so a new persist path cannot appear without a decision.
jest.mock('../models/db', () => {
  const inserts = [];
  const chain = () => {
    const q = {};
    ['where', 'whereRaw', 'whereNotNull', 'whereIn', 'orderBy', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => null);
    q.insert = jest.fn(async (row) => { inserts.push(row); return [{ id: 'audit-1' }]; });
    return q;
  };
  const mockDb = jest.fn(() => chain());
  mockDb.raw = jest.fn((sql) => sql);
  mockDb._inserts = inserts;
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: jest.fn(() => '+19413180000') }));
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: jest.fn(() => []),
  isServiceContactRole: jest.fn((role) => role !== 'primary'),
  getPrimaryContact: jest.fn(() => ({ phone: null })),
  prefsUnavailable: jest.fn(() => false),
}));
jest.mock('../services/recipient-optin', () => ({ filterRecipientsByOptin: jest.fn(async (contacts) => contacts) }));
jest.mock('../services/appointment-email', () => ({
  sendAppointmentConfirmationEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentReminderEmail: jest.fn(async () => ({ ok: true })),
  sendTechEnRouteEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/disclaimed-number-holds', () => ({ disclaimedNumberHeldForVisit: jest.fn(async () => false) }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => ({})) }));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { getAppointmentContacts } = require('../services/customer-contact');
const AppointmentReminders = require('../services/appointment-reminders');
const { recordAuditEvent } = require('../services/audit-log');
const detector = require('../services/no-show-detector');
const { loadPromiseLevels } = require('../services/auto-dispatch/told-visits');
const { persistAudit } = require('../services/messaging/audit');
const { DAY_PROMISE_META, promiseMetaOf, withPromiseMeta, PROMISE_META_KEYS } = require('../services/time-promise');

const CUSTOMER = { id: 'cust-1', phone: '+19415550001' };
const PRIMARY = { phone: '+19415550001', role: 'primary' };
const SPOUSE = { phone: '+19415550002', role: 'spouse' };
const ACCEPTED = { sent: true };
const HELD = { sent: false, blocked: true, code: 'QUIET_HOURS_HOLD', retryable: true, deferred: true, nextAllowedAt: '2026-08-11T12:00:00.000Z' };
const SLOT = Date.parse('2026-08-14T13:00:00.000Z');
const DAY_SEND_META = {
  scheduled_service_id: 'ss-1', templateKey: 'reminder_72h_day_v1', rendered_slot_ms: SLOT, ...DAY_PROMISE_META,
  guard_slot_ms: SLOT, promised_date: '2026-08-14',
};

describe('promiseMetaOf / withPromiseMeta', () => {
  test('a day send gives exactly the four promise fields; rendered_slot_ms and everything else stay out', () => {
    expect(PROMISE_META_KEYS).toEqual(['promise_level', 'window_unknown', 'guard_slot_ms', 'promised_date']);
    expect(promiseMetaOf(DAY_SEND_META)).toEqual({ promise_level: 'day', window_unknown: true, guard_slot_ms: SLOT, promised_date: '2026-08-14' });
  });

  test('only the fields present are returned', () => {
    expect(promiseMetaOf({ promise_level: 'day', window_unknown: true })).toEqual({ promise_level: 'day', window_unknown: true });
  });

  test('a window send, and anything that is not a day promise, gives {} (a windowless reschedule\'s window_unknown alone is not a day)', () => {
    expect(promiseMetaOf({ scheduled_service_id: 'ss-1', rendered_slot_ms: SLOT })).toEqual({});
    expect(promiseMetaOf({ window_unknown: true })).toEqual({});
    expect(promiseMetaOf({ promise_level: 'hour' })).toEqual({});
    expect(promiseMetaOf(null)).toEqual({});
    expect(promiseMetaOf(undefined)).toEqual({});
  });

  test('withPromiseMeta re-applies the saved fields and adds nothing for a window send', () => {
    expect(withPromiseMeta({ a: 1 }, DAY_SEND_META)).toEqual({ a: 1, promise_level: 'day', window_unknown: true, guard_slot_ms: SLOT, promised_date: '2026-08-14' });
    expect(withPromiseMeta({ a: 1 }, { rendered_slot_ms: SLOT })).toEqual({ a: 1 });
  });
});

describe('the 20:00 partial-delivery case: an accepted primary, a held contact', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db._inserts.length = 0;
    getAppointmentContacts.mockReturnValue([PRIMARY, SPOUSE]);
  });

  const fanOut = (meta) => AppointmentReminders.safeSendAppointment(
    CUSTOMER, {}, async (c) => `Hi ${c.role}`, 'reminder_72h', 'appointment_reminder_72h', meta, {},
  );

  test('the queued row carries the day fields beside the body', async () => {
    sendCustomerMessage.mockResolvedValueOnce(ACCEPTED).mockResolvedValueOnce(HELD);
    await fanOut(DAY_SEND_META);
    expect(db._inserts).toHaveLength(1);
    const meta = JSON.parse(db._inserts[0].metadata);
    expect(meta).toMatchObject({
      entry_point: 'appointment_notice_contact_deferred', replay_purpose: 'appointment_reminder_72h', scheduled_service_id: 'ss-1',
      promise_level: 'day', window_unknown: true, guard_slot_ms: SLOT, promised_date: '2026-08-14',
    });
    expect(meta).not.toHaveProperty('rendered_slot_ms');
  });

  test('a window fan-out queues exactly what it queued before: no promise fields', async () => {
    sendCustomerMessage.mockResolvedValueOnce(ACCEPTED).mockResolvedValueOnce(HELD);
    await fanOut({ scheduled_service_id: 'ss-1', rendered_slot_ms: SLOT, templateKey: 'reminder_72h' });
    const meta = JSON.parse(db._inserts[0].metadata);
    for (const key of PROMISE_META_KEYS) expect(meta).not.toHaveProperty(key);
  });

  test('the morning replay records level day (through the real audit row builder, the reader and loadPromiseLevels), not hour', async () => {
    sendCustomerMessage.mockResolvedValueOnce(ACCEPTED).mockResolvedValueOnce(HELD);
    await fanOut(DAY_SEND_META);
    const stored = JSON.parse(db._inserts[0].metadata);
    // What the scheduler's replay sends: its own metadata plus promiseMetaOf(claimMeta) (pinned by the source scan below).
    const replayInput = {
      to: SPOUSE.phone, body: 'Hi spouse', purpose: stored.replay_purpose, audience: 'customer', channel: 'sms', appointmentId: stored.scheduled_service_id,
      metadata: { original_message_type: 'reminder_72h', scheduled_sms_log_id: 'q-1', ...promiseMetaOf(stored) },
    };
    db._inserts.length = 0;
    await persistAudit({ input: replayInput, validatorsPassed: [], validatorsFailed: [], blockedBy: null, providerOutcome: null });
    const auditRow = db._inserts[0];
    expect(auditRow.metadata).toMatchObject({ promise_level: 'day' });

    const conn = (table) => {
      const chain = {};
      for (const m of ['join', 'leftJoin', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where', 'distinct', 'orWhere', 'whereIn']) chain[m] = () => chain;
      chain.select = async () => (table === 'messaging_audit_log as a'
        ? [{ id: 9, appointment_id: 'ss-1', purpose: auditRow.purpose, sent_at: '2026-08-11T12:00:05Z', metadata: auditRow.metadata }] : []);
      return chain;
    };
    conn.raw = (sql, bindings) => ({ sql, bindings });
    conn.isTransaction = true;
    expect(Object.fromEntries(await loadPromiseLevels(conn, ['ss-1'], new Date('2026-08-11T13:00:00Z')))).toEqual({ 'ss-1': 'day' });

    // Control: the SAME replay without the fields (the bug) reads as an hour.
    const bare = { ...replayInput, metadata: { original_message_type: 'reminder_72h', scheduled_sms_log_id: 'q-1' } };
    db._inserts.length = 0;
    await persistAudit({ input: bare, validatorsPassed: [], validatorsFailed: [], blockedBy: null, providerOutcome: null });
    const bareRow = db._inserts[0];
    const bareConn = (table) => {
      const c = conn(table);
      c.select = async () => (table === 'messaging_audit_log as a'
        ? [{ id: 10, appointment_id: 'ss-1', purpose: bareRow.purpose, sent_at: '2026-08-11T12:00:05Z', metadata: bareRow.metadata }] : []);
      return c;
    };
    bareConn.raw = conn.raw;
    bareConn.isTransaction = true;
    expect(Object.fromEntries(await loadPromiseLevels(bareConn, ['ss-1'], new Date('2026-08-11T13:00:00Z')))).toEqual({ 'ss-1': 'hour' });
  });
});

describe('the no-show reader\'s durable fallback record', () => {
  test('a day-only send whose audit insert failed is recorded as a day promise', async () => {
    recordAuditEvent.mockClear();
    await detector.recordSentWindowFallback({ visitId: 'ss-1', startAtMs: null, windowUnknown: true, communicatedAt: '2026-08-11T12:00:00Z', providerSid: 'SM1', promiseLevel: 'day' });
    expect(recordAuditEvent.mock.calls[0][0].metadata).toMatchObject({ start_at: null, promise_level: 'day' });
  });

  test('without promiseLevel the record is exactly as before (an unknown window)', async () => {
    recordAuditEvent.mockClear();
    await detector.recordSentWindowFallback({ visitId: 'ss-1', startAtMs: null, windowUnknown: true, communicatedAt: '2026-08-11T12:00:00Z' });
    expect(recordAuditEvent.mock.calls[0][0].metadata).not.toHaveProperty('promise_level');
  });

  test('the reader turns that record into level day, and an unmarked one stays unknown (no level)', async () => {
    const conn = (rows) => {
      const c = (table) => {
        const chain = {};
        for (const m of ['join', 'leftJoin', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where', 'distinct', 'orWhere', 'whereIn']) chain[m] = () => chain;
        chain.select = async () => (table === 'audit_log as al' ? rows : []);
        return chain;
      };
      c.raw = (sql, bindings) => ({ sql, bindings });
      c.isTransaction = true;
      return c;
    };
    const row = (metadata) => [{ id: 1, resource_id: 'ss-1', created_at: '2026-08-11T12:00:00Z', metadata }];
    const [day] = await detector.loadPromiseEvents(conn(row({ start_at: null, communicated_at: '2026-08-11T12:00:00Z', promise_level: 'day' })), ['ss-1'], { now: new Date('2026-08-12T00:00:00Z') });
    expect(day).toMatchObject({ start_at: null, level: 'day' });
    const [plain] = await detector.loadPromiseEvents(conn(row({ start_at: null, communicated_at: '2026-08-11T12:00:00Z' })), ['ss-1'], { now: new Date('2026-08-12T00:00:00Z') });
    expect(plain).not.toHaveProperty('level');
  });
});

// ── the guard: every place a notice's body or metadata is persisted for later ───────────────────────────────────────
describe('persist and replay paths are accounted for', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const SERVER = path.join(__dirname, '..');
  const SKIP = new Set(['node_modules', 'tests', 'contract-tests', '__tests__', 'migrations']);
  const files = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP.has(e.name)) files(path.join(dir, e.name), out); } else if (e.name.endsWith('.js')) out.push(path.join(dir, e.name));
    }
    return out;
  };

  test('the held-contact writer stores promiseMetaOf(metaExtra) and the scheduler replay applies promiseMetaOf(claimMeta)', () => {
    expect(read('services/appointment-reminders.js')).toMatch(/replay_purpose: purpose,[\s\S]{0,400}\.\.\.require\('\.\/time-promise'\)\.promiseMetaOf\(metaExtra\)/);
    expect(read('services/scheduler.js')).toMatch(/\.\.\.require\('\.\/time-promise'\)\.promiseMetaOf\(claimMeta\)/);
    expect(read('services/messaging/send-customer-message.js')).toMatch(/metadata\?\.promise_level === 'day' \? 'day' : null[\s\S]*promiseLevel: promiseLevelOf\(sendInput\.metadata\)/);
  });

  // Every non-test file that parks a message in sms_log with a replay_purpose taken from the sender's own purpose or an
  // appointment purpose is a persist path. A new one fails here until it is listed with its decision.
  const KNOWN = {
    'services/appointment-reminders.js': 'WRITER: queueHeldNoticeContacts stores promiseMetaOf(metaExtra); the scheduler replay applies promiseMetaOf(claimMeta)',
    'services/scheduler.js': 'REPLAY: the one reader of those rows; spreads promiseMetaOf(claimMeta) into the replayed send',
    'services/call-recording-processor.js': 'NO CHANGE: the AI call agent\'s booking confirmation is the customer\'s own pick, never day-only',
    'services/recipient-optin.js': 'NO CHANGE: the opt-in ask promises no visit time',
    'services/lawn-intelligence.js': 'NO CHANGE: a lawn assessment notice, not an appointment time promise',
    'services/notification-dispatcher.js': 'NO CHANGE: generic notification texts (purpose passed through), none carries a day-only visit promise',
    'services/appointment-card-request.js': 'NO CHANGE: a card-on-file link text',
    'services/messaging/deferred-replay-registry.js': 'NO CHANGE: the pre-send liveness checks for replays; builds no send metadata',
    'services/scheduled-sms-cancel.js': 'NO CHANGE: cancels queued rows',
    'services/scheduled-sms-delivery.js': 'NO CHANGE: marks queued rows sent/failed',
    'services/request-app-notifications.js': 'NO CHANGE: service-request status texts, no visit time',
    'routes/admin-communications.js': 'NO CHANGE: operator-composed scheduled texts',
    'routes/stripe-webhook.js': 'NO CHANGE: billing',
    'services/billing-cron.js': 'NO CHANGE: billing',
    'services/payer-invoice-sms.js': 'NO CHANGE: billing',
    'services/complete-scheduled-service.js': 'NO CHANGE: service-completion texts',
    'services/contact-report-text.js': 'NO CHANGE: service report text',
  };

  test('no file that persists a replay_purpose is missing from the decided list', () => {
    const found = files(SERVER)
      .filter((f) => /replay_purpose/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SERVER, f));
    const unknown = found.filter((f) => !(f in KNOWN)
      // billing / invoice / referral / document lanes are not appointment-notice paths
      && !/invoice|billing|payment|referral|document|review|estimate|voicemail|newsletter|recruit|autopay|payer|stripe|membership/i.test(f));
    expect(unknown).toEqual([]);
  });

  // Every path that sends a stored day-only body LATER must ask the chokepoint (appointment-reminders.js
  // revalidateDelayedDaySend) first. The only ways to carry or recognise a stored day-only body are promiseMetaOf(...) and
  // isDayPromise(...): a file that uses either must be listed with how it reaches the chokepoint, so a new delayed path
  // cannot skip it.
  test('every delayed day-only sender calls the chokepoint', () => {
    const reminders = read('services/appointment-reminders.js');
    // the bounce recovery
    expect(reminders).toMatch(/async function recoverBouncedNotice[\s\S]*?revalidateDelayedDaySend\(/);
    // the morning replay of queued contacts, via the registry's recheck
    const registry = read('services/messaging/deferred-replay-registry.js');
    expect(registry).toMatch(/appointment_notice_contact_deferred: \{[\s\S]*?dayPromiseStillValid\(meta\)/);
    expect(registry).toMatch(/async function dayPromiseStillValid[\s\S]*?revalidateDelayedDaySend\(/);
    // the chokepoint is the only caller of the shared decision for a delayed send: no inline dayOnlyNow in either path
    expect(reminders.match(/async function recoverBouncedNotice[\s\S]*?\n}\n/)[0]).not.toMatch(/dayOnlyNow\(/);
    expect(registry).not.toMatch(/dayOnlyNow|dayOnlySendDecision/);
  });

  test('no other file carries or recognises a stored day-only body without being decided here', () => {
    const DECIDED = new Set([
      'services/time-promise.js', // defines promiseMetaOf
      'services/appointment-reminders.js', // writer (queueHeldNoticeContacts), bounce recovery (isDayPromise)
      'services/scheduler.js', // replay: applies promiseMetaOf(claimMeta); its recheck is the registry's (above)
    ]);
    const users = files(SERVER)
      .filter((f) => /\bpromiseMetaOf\(|\bisDayPromise\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SERVER, f));
    expect(users.filter((f) => !DECIDED.has(f))).toEqual([]);
  });

  test('the paths decided as NO CHANGE do not hold appointment-reminders send metadata (they never call safeSendAppointment)', () => {
    for (const [file, why] of Object.entries(KNOWN)) {
      if (!why.startsWith('NO CHANGE')) continue;
      const code = read(file).split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
      expect(code).not.toMatch(/safeSendAppointment\s*\(|queueHeldNoticeContacts\s*\(/);
    }
  });
});
