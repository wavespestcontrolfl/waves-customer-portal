// GATE_DAY_ONLY_PROMISE part B1 (Codex P1-1): the no-show reader's durable key recovery reads a day-only email as a DAY
// promise (level 'day', no slot), so the evidence survives a failed interaction insert, and a day-only email never reads
// as an hour. Numeric keys behave exactly as before. Also: guard_slot_ms / promised_date are not promises.
// The detector runs for real over a knex-shaped fake; synthetic ids only.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/street-level-hold', () => ({ ...jest.requireActual('../services/street-level-hold'), isStreetLevelHoldVisit: jest.fn(async () => false) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/visit-groups', () => ({
  ...jest.requireActual('../services/visit-groups'),
  appointmentSendHeld: jest.fn(async () => false),
}));
jest.mock('../services/email-template-library', () => ({
  ...jest.requireActual('../services/email-template-library'),
  sendTemplate: jest.fn(async () => ({ sent: true, message: { id: 'em-1', provider_message_id: 'sg-1', sent_at: '2026-11-10T14:00:00.000Z' } })),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const AppointmentEmail = require('../services/appointment-email');
const detector = require('../services/no-show-detector');
const { loadPromiseLevels } = require('../services/auto-dispatch/told-visits');

const NOW = new Date('2026-11-12T00:00:00Z');
const WHEN = '2026-11-15T14:00:00.000Z';
const SLOT = Date.parse(WHEN);

/** Fake conn: messaging rows, email interaction rows, direct (`email_messages`) and grouped (`email_messages as em`) key rows. */
function fakeConn({ messages = [], emails = [], direct = [], grouped = [], members = [] } = {}) {
  const wheres = {};
  const conn = (table) => {
    const chain = {};
    for (const m of ['join', 'leftJoin', 'whereBetween', 'whereNull', 'whereNotNull', 'where', 'distinct', 'orWhere']) chain[m] = () => chain;
    chain.whereRaw = (...args) => { (wheres[table] = wheres[table] || []).push(args); return chain; };
    chain.whereIn = () => chain;
    chain.select = async () => {
      if (table === 'messaging_audit_log as a') return messages;
      if (table === 'customer_interactions as ci') return emails;
      if (table === 'email_messages') return direct;
      if (table === 'email_messages as em') return grouped;
      if (table === 'scheduled_services') return members;
      return [];
    };
    return chain;
  };
  conn.raw = (sql, bindings) => ({ sql, bindings });
  conn.isTransaction = true;
  conn.wheres = wheres;
  return conn;
}

const directRow = (slot, over = {}) => ({ id: 'em-1', sent_at: '2026-11-10T14:00:00Z', visit_id: 's1', slot_ms: slot, stop_wide: false, ...over });
const events = (conn) => detector.loadPromiseEvents(conn, ['s1'], { now: NOW });

describe('per-service key recovery', () => {
  test('a day segment is recovered as a day promise: no slot, level day, the email\'s send time', async () => {
    const [event] = await events(fakeConn({ direct: [directRow('day-2026-11-15')] }));
    expect(event).toEqual({ visit_id: 's1', start_at: null, level: 'day', grouped: false, communicated_at: '2026-11-10T14:00:00Z', source: 'email', source_id: 'em-1' });
  });

  test('a numeric key is exactly as before: a known slot, no level key', async () => {
    const [event] = await events(fakeConn({ direct: [directRow(String(SLOT))] }));
    expect(event).toEqual({ visit_id: 's1', start_at: new Date(SLOT).toISOString(), grouped: false, communicated_at: '2026-11-10T14:00:00Z', source: 'email', source_id: 'em-1' });
    expect(event).not.toHaveProperty('level');
  });

  test('the read admits both key shapes and nothing looser', async () => {
    const conn = fakeConn();
    await events(conn);
    const [sql] = conn.wheres.email_messages.find(([text]) => String(text).includes("'^[0-9]+$'"));
    expect(sql).toContain("^day-[0-9]{4}-[0-9]{2}-[0-9]{2}$");
  });

  test('the interaction insert failed: the day email alone still yields level day for the night tools', async () => {
    const conn = fakeConn({ direct: [directRow('day-2026-11-15')] });
    expect(Object.fromEntries(await loadPromiseLevels(conn, ['s1'], NOW))).toEqual({ s1: 'day' });
  });

  test('a newer day email supersedes an older known slot; an older day email does not outrank a newer slot', async () => {
    const olderSlot = { id: 1, appointment_id: 's1', purpose: 'appointment_confirmation', sent_at: '2026-11-09T14:00:00Z', metadata: { rendered_slot_ms: SLOT } };
    const levels = async (messages, direct) => Object.fromEntries(await loadPromiseLevels(fakeConn({ messages, direct }), ['s1'], NOW));
    expect(await levels([olderSlot], [directRow('day-2026-11-15')])).toEqual({ s1: 'day' });
    const newerSlot = { ...olderSlot, sent_at: '2026-11-11T14:00:00Z' };
    expect(await levels([newerSlot], [directRow('day-2026-11-15')])).toEqual({ s1: 'hour' });
  });
});

describe('the keys a day-only email is sent under', () => {
  const sentKeys = () => EmailTemplates.sendTemplate.mock.calls.map(([arg]) => arg.idempotencyKey);
  const customerRow = { id: 'cust-1', account_id: 'acct-1', is_primary_profile: true, first_name: 'Rowan', last_name: 'Testcase', email: 'rowan@example.com', phone: '+19415550100' };
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation((table) => {
      if (table === 'customers') { const qb = { where: () => qb, select: () => qb, whereNull: () => qb, first: async () => customerRow }; return qb; }
      if (table === 'notification_prefs' || table === 'appointment_reminders') return { where: () => ({ first: async () => null }) };
      if (table === 'customer_interactions') return { insert: async () => [1] };
      if (table === 'scheduled_services') return { where: () => ({ first: async () => ({ scheduled_date: '2026-11-15', window_start: '09:00' }), leftJoin: () => ({ first: async () => ({ tech_name: 'Sam' }) }) }) };
      throw new Error(`unexpected db table ${table}`);
    });
  });
  const confirm = (extra) => AppointmentEmail.sendAppointmentConfirmationEmail({ customerId: 'cust-1', scheduledServiceId: 'ss1', appointmentTime: WHEN, serviceLabel: 'Pest Control', ...extra });
  const remind = (extra) => AppointmentEmail.sendAppointmentReminderEmail({ customerId: 'cust-1', scheduledServiceId: 'ss1', appointmentTime: WHEN, serviceLabel: 'Pest Control', kind: '72h', ...extra });

  test('a coalesced notice\'s supplied key: the numeric slot becomes the day segment, so recovery reads a day, never an hour', async () => {
    const supplied = `appointment.confirmation:ss1:${SLOT}:coalesced:1794000000000`;
    await confirm({ dayOnly: true, idempotencyKey: supplied });
    const key = sentKeys()[0];
    expect(key).toMatch(/^appointment\.confirmation:ss1:day-2026-11-15:coalesced:1794000000000:[0-9a-f]{16}$/);
    // What the reader's segment-3 test sees:
    expect(key.split(':')[2]).toBe('day-2026-11-15');
    expect(key.split(':')[2]).not.toMatch(/^[0-9]+$/);
  });

  test('the same supplied key for a window email is kept as given', async () => {
    const supplied = `appointment.confirmation:ss1:${SLOT}:coalesced:1794000000000`;
    await confirm({ idempotencyKey: supplied });
    expect(sentKeys()[0]).toMatch(new RegExp(`^appointment\\.confirmation:ss1:${SLOT}:coalesced:1794000000000:[0-9a-f]{16}$`));
  });

  test('a grouped reminder\'s visit key gains a trailing :day (segment 6), a window one does not', async () => {
    const grouped = 'appointment.reminder_72h:visit:visit-9:reminder_72h:2026-11-15';
    await remind({ dayOnly: true, idempotencyKey: grouped });
    await remind({ idempotencyKey: grouped });
    const [day, window] = sentKeys();
    expect(day).toMatch(/^appointment\.reminder_72h:visit:visit-9:reminder_72h:2026-11-15:day:[0-9a-f]{16}$/);
    expect(day.split(':')[5]).toBe('day');
    expect(window).toMatch(/^appointment\.reminder_72h:visit:visit-9:reminder_72h:2026-11-15:[0-9a-f]{16}$/);
    expect(window.split(':')[5]).not.toBe('day');
  });

  test('the default key is unchanged for window sends and carries the day for day sends', async () => {
    await remind({});
    await remind({ dayOnly: true });
    const [window, day] = sentKeys();
    expect(window).toMatch(new RegExp(`^appointment\\.reminder_72h:ss1:${SLOT}:`));
    expect(day).toMatch(/^appointment\.reminder_72h:ss1:day-2026-11-15:/);
  });

  test('a key built by the sender is recovered by the reader as a day (end to end through the key text)', async () => {
    await confirm({ dayOnly: true, idempotencyKey: `appointment.confirmation:ss1:${SLOT}:coalesced:1794000000000` });
    const segment3 = sentKeys()[0].split(':')[2];
    const [event] = await events(fakeConn({ direct: [directRow(segment3)] }));
    expect(event).toMatchObject({ start_at: null, level: 'day' });
  });
});

describe('grouped key recovery', () => {
  const groupedRow = (over = {}) => ({ id: 'g1', sent_at: '2026-11-10T14:00:00Z', visit_id: 's1', stop_id: 'v1', tier: 'appointment.reminder_72h', occurrence: '2026-11-15', ...over });

  test('a day-only grouped email (:day in segment 6) is recovered as a day promise', async () => {
    const [event] = await events(fakeConn({ grouped: [groupedRow({ day_only: true })] }));
    expect(event).toMatchObject({ visit_id: 's1', start_at: null, level: 'day', grouped: true, source: 'email' });
  });

  test('a window grouped email is recovered as before: unknown window, no level key', async () => {
    const [event] = await events(fakeConn({ grouped: [groupedRow({ day_only: false })] }));
    expect(event).toMatchObject({ start_at: null, grouped: true });
    expect(event).not.toHaveProperty('level');
    const [legacy] = await events(fakeConn({ grouped: [groupedRow()] }));
    expect(legacy).not.toHaveProperty('level');
  });

  test('the grouped read selects the segment-6 day marker', async () => {
    const src = require('fs').readFileSync(require.resolve('../services/no-show-detector'), 'utf8');
    expect(src).toContain(`split_part(em.idempotency_key, ':', 6) = 'day' as day_only`);
  });
});

describe('guard_slot_ms and promised_date are not promises', () => {
  const dayMsg = (metadata) => ({ id: 5, appointment_id: 's1', purpose: 'appointment_reminder_72h', sent_at: '2026-11-10T14:00:00Z', metadata });

  test('the reader maps a day-only text to no slot even though it carries a guard slot', async () => {
    const [event] = await events(fakeConn({ messages: [dayMsg({ promise_level: 'day', window_unknown: true, guard_slot_ms: SLOT, promised_date: '2026-11-15' })] }));
    expect(event).toMatchObject({ start_at: null, level: 'day' });
  });

  test('a row with only the guard fields (no marker, no rendered slot) is no known window', async () => {
    const [event] = await events(fakeConn({ messages: [dayMsg({ guard_slot_ms: SLOT, promised_date: '2026-11-15' })] }));
    expect(event.start_at).toBeNull();
    expect(event).not.toHaveProperty('level');
  });

  test('neither guard field is in the reader\'s SQL', async () => {
    const conn = fakeConn();
    await events(conn);
    const text = JSON.stringify(conn.wheres['messaging_audit_log as a']);
    expect(text).not.toMatch(/guard_slot_ms|promised_date/);
    const src = require('fs').readFileSync(require.resolve('../services/no-show-detector'), 'utf8');
    expect(src).not.toMatch(/guard_slot_ms|promised_date/);
  });

  test('levels: a day-only text with a guard slot reads day', async () => {
    const conn = fakeConn({ messages: [dayMsg({ promise_level: 'day', window_unknown: true, guard_slot_ms: SLOT, promised_date: '2026-11-15' })] });
    expect(Object.fromEntries(await loadPromiseLevels(conn, ['s1'], NOW))).toEqual({ s1: 'day' });
  });
});
