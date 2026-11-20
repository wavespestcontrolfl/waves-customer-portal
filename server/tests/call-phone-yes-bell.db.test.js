/**
 * The phone-yes bell through PostgreSQL (call-phone-yes-bell.js; GATE_CALL_PHONE_YES_ACCEPT, owner 2026-11-18 "ok go",
 * step 1: the office's phone alert). The sweep's bell pass rings each open card once when it is filed, and once more
 * when time runs short (an open estimate on the card expires within 24 hours, or its visit starts within 48), then
 * closes the rows of cards that are no longer open. The notification service is real; the phone banner is stubbed at
 * bell-banners.js. Runs inside a rolled-back transaction. Synthetic names, numbers and addresses only. Skips without
 * DATABASE_URL.
 */
const SKIP = !process.env.DATABASE_URL;

jest.setTimeout(120000);
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  Object.defineProperty(proxy, 'fn', { get: () => mockConn.fn });
  Object.defineProperty(proxy, 'schema', { get: () => mockConn.schema });
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The phone banner: notifyAdmin hands each write here; nothing leaves the machine.
jest.mock('../services/bell-banners', () => ({ bannerAfterWrite: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('crypto');
const { bannerAfterWrite } = require('../services/bell-banners');
const { etDateString, formatETDayDate, parseETDateTime } = require('../utils/datetime-et');
const { _private: { ringOpenCardsForTest } } = require('../services/call-phone-yes-accept');

const describeDb = SKIP ? describe.skip : describe;
const DAY = 86400000;
const HOUR = 3600000;
const WORDS = "Let's do the quarterly plan, just bill me each time you come out.";

describeDb('phone-yes bell (PostgreSQL)', () => {
  let database; let trx;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  afterAll(async () => { await database.destroy(); });
  beforeEach(async () => {
    jest.clearAllMocks();
    trx = await database.transaction();
    mockConn = trx;
  });
  afterEach(async () => { await trx.rollback(); });

  let seq = 0;
  // The Eastern day `n` days from now, and how the bell writes it.
  const etDay = (n) => etDateString(new Date(Date.now() + n * DAY));
  const dayWords = (n) => formatETDayDate(parseETDateTime(`${etDay(n)}T15:00`));

  // One open phone-yes card as the sweep files it: a customer, the estimates it names (each { hours } until it expires,
  // and its status), the booking call and the pest visit it booked (`visitDays` from today, at 3:00 PM Eastern). One
  // estimate is the card's own; two or more are a card that names several.
  async function phoneYesCard({ estimates = [{ hours: 5 * 24 }], visitDays = 5, payload = { yes_heard: true, caller_words: WORDS }, status = 'open' } = {}) {
    seq += 1;
    const customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Pat', last_name: 'Sampleton', phone: `+1941555${String(6000 + seq)}`, email: `qa-${customerId.slice(0, 8)}@example.test`, active: true,
    });
    const estimateIds = [];
    for (const { hours, status: estimateStatus = 'sent' } of estimates) {
      const [row] = await trx('estimates').insert({
        customer_id: customerId, status: estimateStatus, token: randomUUID().replace(/-/g, ''), customer_name: 'Pat Sampleton',
        address: '100 Example Lane, Sampleton, FL 34200', monthly_total: 15, annual_total: 180, onetime_total: 0, category: 'RESIDENTIAL',
        sent_at: new Date(Date.now() - 2 * DAY), expires_at: new Date(Date.now() + hours * HOUR),
      }).returning('id');
      estimateIds.push(String(row.id || row));
    }
    const callLogId = randomUUID();
    await trx('call_log').insert({ id: callLogId, customer_id: customerId, twilio_call_sid: `CA${callLogId.replace(/-/g, '')}`, from_phone: '+19415550101', direction: 'inbound' });
    const visitId = randomUUID();
    await trx('scheduled_services').insert({
      id: visitId, customer_id: customerId, source_call_log_id: callLogId, scheduled_date: etDay(visitDays), window_start: '15:00', window_end: '17:00',
      service_type: 'General Pest Control', status: 'confirmed', source_action: 'ai_call_pipeline', is_recurring: false,
      service_address_line1: '100 Example Lane', service_address_city: 'Sampleton', service_address_state: 'FL', service_address_zip: '34200',
    });
    const id = randomUUID();
    await trx('triage_items').insert({
      id, call_log_id: callLogId, category: 'billing_review', reason_code: 'call_phone_yes', severity: 'advisory', status,
      summary: 'Caller said yes to pay per application on the call. The estimate is not accepted yet.',
      payload: JSON.stringify({ flag: 'call_phone_yes', estimate_ids: estimateIds, scheduled_service_id: visitId, ...payload }),
      related_customer_id: customerId, related_estimate_id: estimateIds.length === 1 ? estimateIds[0] : null, related_scheduled_service_id: visitId,
    });
    return { id, customerId, callLogId, visitId, estimateIds };
  }

  const pass = () => ringOpenCardsForTest(new Date());
  const filedKey = (cardId) => `call-phone-yes:${cardId}`;
  const dueKey = (cardId) => `call-phone-yes-due:${cardId}`;
  // The card's bell rows by key: { filed, due } (undefined when that key never rang).
  async function bellsOf(cardId) {
    const rows = await trx('notifications').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ANY(?::text[])", [[filedKey(cardId), dueKey(cardId)]]);
    const keyed = (key) => rows.filter((row) => row.metadata.dedupeKey === key);
    expect(keyed(filedKey(cardId)).length).toBeLessThanOrEqual(1);
    expect(keyed(dueKey(cardId)).length).toBeLessThanOrEqual(1);
    return { filed: keyed(filedKey(cardId))[0], due: keyed(dueKey(cardId))[0], count: rows.length };
  }
  const bannerKinds = () => bannerAfterWrite.mock.calls.map(([, { metadata }]) => metadata.triggerKey);

  test("a filed card rings one bell with the card's words and one phone banner; the next pass rings nothing", async () => {
    const card = await phoneYesCard();
    await pass();

    const { filed, due, count } = await bellsOf(card.id);
    expect(count).toBe(1);
    expect(due).toBeUndefined();
    expect(filed).toEqual(expect.objectContaining({
      category: 'estimate', title: "Estimates — accept Pat Sampleton's estimate", link: '/admin/communications?tab=triage',
      read_at: null, done_at: null,
    }));
    expect(filed.body).toMatch(/^The caller said “Let's do the quarterly plan, just bill me/);
    expect(filed.body.endsWith(`” on a call, and the visit is ${dayWords(5)}.`)).toBe(true);
    expect(filed.body.length).toBeLessThanOrEqual(110);
    // The detail keeps the caller's whole words.
    expect(filed.detail).toContain(`“${WORDS}”`);
    expect(filed.metadata).toEqual(expect.objectContaining({
      area: 'Estimates', severity: 'needs-you', who: 'person', doneWhen: 'phone_yes_card_closed',
      subject: { type: 'call', id: card.callLogId }, triageItemId: card.id, callLogId: card.callLogId, customerId: card.customerId,
      estimateId: card.estimateIds[0], due: null,
    }));
    expect(bannerKinds()).toEqual(['call_phone_yes']);

    await pass();
    expect((await bellsOf(card.id)).count).toBe(1);
    expect(bannerKinds()).toEqual(['call_phone_yes']);
  });

  test('time runs short (the visit is tomorrow): the time-short bell rings once and the filed row closes', async () => {
    const card = await phoneYesCard();
    await pass();
    await trx('scheduled_services').where({ id: card.visitId }).update({ scheduled_date: etDay(1) });
    await pass();

    const { filed, due } = await bellsOf(card.id);
    expect(due).toEqual(expect.objectContaining({
      title: "Estimates — accept Pat Sampleton's estimate",
      body: `The visit the call booked is ${dayWords(1)}, and its card in Triage is still open.`, done_at: null,
    }));
    expect(due.metadata).toEqual(expect.objectContaining({ due: 'visit_soon', triageItemId: card.id }));
    expect(filed.done_at).not.toBeNull();
    expect(filed.metadata).toEqual(expect.objectContaining({ autoCleared: true, autoClearedReason: 'phone_yes_time_short' }));
    expect(bannerKinds()).toEqual(['call_phone_yes', 'call_phone_yes']);

    // Rung once: no third row, no third banner, also once the visit moves out again.
    await pass();
    await trx('scheduled_services').where({ id: card.visitId }).update({ scheduled_date: etDay(6) });
    await pass();
    expect((await bellsOf(card.id)).count).toBe(2);
    expect(bannerKinds()).toHaveLength(2);
  });

  test('a card filed when its estimate expires within 24 hours rings the time-short bell alone, and nothing after', async () => {
    const card = await phoneYesCard({ estimates: [{ hours: 20 }] });
    await pass();

    const { filed, due } = await bellsOf(card.id);
    expect(filed).toBeUndefined();
    expect(due.body).toBe(`The estimate expires ${formatETDayDate(new Date(Date.now() + 20 * HOUR))} and is not accepted yet.`);
    expect(due.metadata).toEqual(expect.objectContaining({ due: 'estimate_expires' }));

    // Extended: time is no longer short, and the filed bell does not ring after the time-short one.
    await trx('estimates').where({ id: card.estimateIds[0] }).update({ expires_at: new Date(Date.now() + 5 * DAY) });
    await pass();
    expect(await bellsOf(card.id)).toEqual(expect.objectContaining({ filed: undefined, count: 1 }));
  });

  test('a card that names several estimates: only an open one counts, and the why says one of them', async () => {
    const card = await phoneYesCard({ estimates: [{ hours: 5 * 24 }, { hours: 20, status: 'declined' }] });
    await pass();
    // The declined estimate's expiry is not short time: the filed bell rings.
    expect(await bellsOf(card.id)).toEqual(expect.objectContaining({ due: undefined, count: 1 }));

    await trx('estimates').where({ id: card.estimateIds[0] }).update({ expires_at: new Date(Date.now() + 20 * HOUR) });
    await pass();
    const { due } = await bellsOf(card.id);
    expect(due.body).toBe(`An open estimate on the card expires ${formatETDayDate(new Date(Date.now() + 20 * HOUR))} and is not accepted yet.`);
    expect(due.metadata.estimateId).toBeNull();
  });

  test("the rows of a card no longer open close; an in-progress card's row stays", async () => {
    const resolved = await phoneYesCard();
    const working = await phoneYesCard({ payload: { yes_heard: false } });
    await pass();
    expect((await bellsOf(working.id)).filed.title).toBe("Estimates — check Pat Sampleton's estimate");

    await trx('triage_items').where({ id: resolved.id }).update({ status: 'resolved', resolved_at: new Date() });
    await trx('triage_items').where({ id: working.id }).update({ status: 'in_progress' });
    await pass();

    const closed = (await bellsOf(resolved.id)).filed;
    expect(closed.done_at).not.toBeNull();
    expect(closed.metadata).toEqual(expect.objectContaining({ autoCleared: true, autoClearedReason: 'phone_yes_card_closed' }));
    expect((await bellsOf(working.id)).filed.done_at).toBeNull();
    // A closed card rings nothing more.
    expect(bannerKinds()).toEqual(['call_phone_yes', 'call_phone_yes']);
  });
});
