/**
 * The phone-yes bell through PostgreSQL (call-phone-yes-bell.js; GATE_CALL_PHONE_YES_ACCEPT, owner 2026-11-18 "ok go",
 * step 1: the office's phone alert). The sweep's bell pass rings each open card once when it is filed, and once more
 * when time runs short (an open estimate on the card expires within 24 hours, or its visit starts within 48), then
 * closes the rows of cards that are no longer open. Each card says what its calls and estimates say, as the sweep's moot
 * pass keeps it. The notification service is real; the phone banner is stubbed at bell-banners.js. Runs inside a
 * rolled-back transaction. Synthetic names, numbers and addresses only. Skips without DATABASE_URL.
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
// The phone banner: notifyAdmin hands every write here; nothing leaves the machine. The real skipReason says which
// writes rang (a fresh row, or a refresh that rang), so the test counts the banners the real module would send.
jest.mock('../services/bell-banners', () => ({ ...jest.requireActual('../services/bell-banners'), bannerAfterWrite: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('crypto');
const { bannerAfterWrite, __private: { skipReason } } = require('../services/bell-banners');
const Compose = require('../services/admin-alert-compose');
const Bell = require('../services/call-phone-yes-bell');
const NotificationService = require('../services/notification-service');
const { etDateString, formatETDayDate, parseETDateTime } = require('../utils/datetime-et');
const {
  _private: { ringOpenCardsForTest, cardStateForTest, applyCardStateForTest, openCardNowForTest },
} = require('../services/call-phone-yes-accept');

const describeDb = SKIP ? describe.skip : describe;
const DAY = 86400000;
const HOUR = 3600000;
const WORDS = "Let's do the quarterly plan, just bill me each time you come out.";
// A call's V2 extraction and labeled transcript (as in call-phone-yes-accept.db.test.js): the caller picks pay per
// application in WORDS, or makes no choice; `intent` is the call's ask (a cancel takes an earlier yes back).
const extractionWith = (choice, intent = null) => ({
  meta: { call_summary: 'Caller asked about the quarterly plan.' },
  service_request: { primary_service_category: 'pest_general', ...(choice ? { billing_choice: choice } : {}), ...(intent ? { service_intent: intent } : {}) },
  scheduling: { status: 'confirmed' },
  evidence: choice ? [{ field_path: '/service_request/billing_choice', quote: WORDS, speaker: 'caller', transcript_offset_ms: 1200 }] : [],
});
const transcriptWith = (choice) => (choice
  ? `Agent: Thanks for calling Waves, how can I help?\nCaller: ${WORDS}\nAgent: You can bill each time. You are all set.`
  : 'Agent: Thanks for calling Waves, how can I help?\nCaller: I need someone out for the bugs.\nAgent: You are all set.');

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
  let admin;
  beforeEach(async () => {
    jest.clearAllMocks();
    trx = await database.transaction();
    mockConn = trx;
    // An active admin with no Push Settings row for the type: the Bell switch reads on.
    admin = randomUUID();
    await trx('technicians').insert({ id: admin, name: 'Sample Admin', role: 'admin', active: true });
  });
  afterEach(async () => { await trx.rollback(); });

  let seq = 0;
  // The Eastern day `n` days from now, and how the bell writes it.
  const etDay = (n) => etDateString(new Date(Date.now() + n * DAY));
  const dayWords = (n) => formatETDayDate(parseETDateTime(`${etDay(n)}T15:00`));

  // A visit the card's call booked: `days` from today at 3:00 PM Eastern, a pest visit unless `service_type` says else.
  async function addVisit({ customerId, callLogId }, { days, service_type = 'General Pest Control' }) {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id, customer_id: customerId, source_call_log_id: callLogId, scheduled_date: etDay(days), window_start: '15:00', window_end: '17:00',
      service_type, status: 'confirmed', source_action: 'ai_call_pipeline', is_recurring: false,
      service_address_line1: '100 Example Lane', service_address_city: 'Sampleton', service_address_state: 'FL', service_address_zip: '34200',
    });
    return id;
  }

  // A call of the customer's, read and final, `hoursAgo` hours ago: `choice` is the caller's plan choice (null for
  // none), `intent` the call's ask; `over` overrides columns (a call still being read).
  async function call(customerId, { choice = null, intent = null, hoursAgo = 0, over = {} } = {}) {
    const id = randomUUID();
    await trx('call_log').insert({
      id, customer_id: customerId, twilio_call_sid: `CA${id.replace(/-/g, '')}`, from_phone: '+19415550101', answered_by: 'human',
      processing_status: 'processed', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify(extractionWith(choice, intent)),
      transcription: transcriptWith(choice), direction: 'inbound', created_at: new Date(Date.now() - hoursAgo * HOUR), ...over,
    });
    return id;
  }

  // The sweep's moot pass for one card (cardState, then applyCardState): the card says what its calls and estimates
  // say. The bell rings an open card only while nothing is left to write.
  async function keepCurrent(cardId) {
    const card = await trx('triage_items').where({ id: cardId })
      .first('id', 'call_log_id', 'related_customer_id', 'related_estimate_id', 'payload');
    const state = await cardStateForTest(card);
    if (state) await applyCardStateForTest(card, state);
  }

  // One open phone-yes card as the sweep files and keeps it: a customer, the estimates it names (each { hours } until it
  // expires, and its status; made `madeHoursAgo` hours ago and sent two days ago), the call with the yes a day ago
  // (`yes`; none when false), the booking call two hours ago and the pest visit it booked (`visitDays` from today). One
  // estimate is the card's own; two or more are a card that names several. A call that booked several visits files its
  // card with no visit of its own (`cardVisit` false); `moreVisits` are the call's other visits.
  async function phoneYesCard({
    estimates = [{ hours: 5 * 24 }], visitDays = 5, cardVisit = true, moreVisits = [], yes = true, madeHoursAgo = 72,
  } = {}) {
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
        created_at: new Date(Date.now() - madeHoursAgo * HOUR), sent_at: new Date(Date.now() - 2 * DAY), expires_at: new Date(Date.now() + hours * HOUR),
      }).returning('id');
      estimateIds.push(String(row.id || row));
    }
    const yesCallId = yes ? await call(customerId, { choice: 'per_application', hoursAgo: 24 }) : null;
    const callLogId = await call(customerId, { hoursAgo: 2 });
    const visitId = await addVisit({ customerId, callLogId }, { days: visitDays });
    for (const more of moreVisits) await addVisit({ customerId, callLogId }, more);
    const cardVisitId = cardVisit ? visitId : null;
    const id = randomUUID();
    await trx('triage_items').insert({
      id, call_log_id: callLogId, category: 'billing_review', reason_code: 'call_phone_yes', severity: 'advisory', status: 'open',
      summary: 'Filed.', payload: JSON.stringify({ flag: 'call_phone_yes', estimate_ids: estimateIds, scheduled_service_id: cardVisitId }),
      related_customer_id: customerId, related_estimate_id: estimateIds.length === 1 ? estimateIds[0] : null, related_scheduled_service_id: cardVisitId,
    });
    await keepCurrent(id);
    expect(await trx('triage_items').where({ id }).first('status')).toEqual({ status: 'open' });
    return { id, customerId, callLogId, visitId, estimateIds, yesCallId };
  }

  // Every active admin's Bell switch for the type in Push Settings (a preference row for each).
  async function setBellSwitch(on) {
    const admins = await trx('technicians').where({ active: true, role: 'admin' }).pluck('id');
    await trx('notification_preferences')
      .insert(admins.map((id) => ({ admin_user_id: id, trigger_key: 'call_phone_yes', bell_enabled: on })))
      .onConflict(['admin_user_id', 'trigger_key']).merge(['bell_enabled']);
  }

  // The sweep's bell pass (its moot pass is keepCurrent).
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
  // The banners this card's writes would send: kind call_phone_yes, and only a write that rang (the hour aside).
  const bannersFor = (cardId) => bannerAfterWrite.mock.calls
    .filter(([result, { metadata }]) => metadata.triageItemId === String(cardId) && metadata.triggerKey === 'call_phone_yes'
      && skipReason(result, metadata) === null).length;

  test("a filed card rings one bell in the card's state, with none of the caller's words, and one banner; the next pass rings nothing", async () => {
    const card = await phoneYesCard();
    await pass();

    const { filed, due, count } = await bellsOf(card.id);
    expect(count).toBe(1);
    expect(due).toBeUndefined();
    expect(filed).toEqual(expect.objectContaining({
      category: 'estimate', title: "Estimates — accept Pat Sampleton's estimate", link: '/admin/communications#tab=triage',
      read_at: null, done_at: null,
    }));
    expect(filed.body).toBe(`The caller said yes to pay per application on a call, and the visit is ${dayWords(5)}.`);
    expect(filed.detail).toBe('Caller said yes to pay per application on the call. The estimate is not accepted yet. '
      + "Open Communications, then Triage, to see the card and the caller's words.");
    // The caller's words stay on the card: nothing of them in the row.
    expect(JSON.stringify(filed)).not.toMatch(/quarterly/);
    expect(filed.metadata).toEqual(expect.objectContaining({
      area: 'Estimates', severity: 'needs-you', who: 'person', doneWhen: 'phone_yes_card_closed',
      subject: { type: 'call', id: card.callLogId }, triageItemId: card.id, callLogId: card.callLogId, customerId: card.customerId,
      estimateId: card.estimateIds[0], due: null,
    }));
    expect(bannersFor(card.id)).toBe(1);

    await pass();
    expect((await bellsOf(card.id)).count).toBe(1);
    expect(bannersFor(card.id)).toBe(1);
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
    expect(bannersFor(card.id)).toBe(2);

    // Rung once: no third row and no third banner, also once the visit moves out again. The open row then says the
    // card's own words with the new day, rewritten quietly.
    await pass();
    await trx('scheduled_services').where({ id: card.visitId }).update({ scheduled_date: etDay(6) });
    await pass();
    const after = await bellsOf(card.id);
    expect(after.count).toBe(2);
    expect(after.due.body).toBe(`The caller said yes to pay per application on a call, and the visit is ${dayWords(6)}.`);
    expect(after.due.read_at).toBeNull();
    expect(bannersFor(card.id)).toBe(2);
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
    const card = await phoneYesCard({ estimates: [{ hours: 5 * 24 }, { hours: 6 * 24 }, { hours: 20, status: 'declined' }] });
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
    const working = await phoneYesCard({ yes: false });
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
    expect(bannersFor(resolved.id) + bannersFor(working.id)).toBe(2);
  });

  test('a card the tap accepts or a person claims while the pass runs rings nothing; the accepted one closes in that pass', async () => {
    const accepted = await phoneYesCard();
    const claimed = await phoneYesCard();
    await pass();
    // Time runs short on both, and each changes after the pass lists it: the tap accepts one, a person claims the other.
    await trx('scheduled_services').whereIn('id', [accepted.visitId, claimed.visitId]).update({ scheduled_date: etDay(1) });
    const realPass = Bell.runBellPass;
    let listedOnce = false;
    const spy = jest.spyOn(Bell, 'runBellPass').mockImplementation(({ listCards, ...rest }) => realPass({
      ...rest,
      listCards: async () => {
        const listed = await listCards();
        if (!listedOnce) {
          listedOnce = true;
          await trx('triage_items').where({ id: accepted.id }).update({ status: 'resolved', resolved_at: new Date() });
          await trx('triage_items').where({ id: claimed.id }).update({ status: 'in_progress' });
        }
        return listed;
      },
    }));
    try {
      await pass();
    } finally {
      spy.mockRestore();
    }

    const acceptedBells = await bellsOf(accepted.id);
    expect(acceptedBells.due).toBeUndefined();
    expect(acceptedBells.filed.metadata).toEqual(expect.objectContaining({ autoCleared: true, autoClearedReason: 'phone_yes_card_closed' }));
    const claimedBells = await bellsOf(claimed.id);
    expect(claimedBells.due).toBeUndefined();
    expect(claimedBells.filed.done_at).toBeNull();
    // The two rings at filing, nothing after.
    expect(bannersFor(accepted.id) + bannersFor(claimed.id)).toBe(2);
  });

  // A system close takes the row over (done_by is the latest closer, doneColumns), and Reopen undoes only a person's
  // close: a filed row a person marked Done cannot come back once the card closes or the time-short row replaces it.
  test.each([
    ['the card closes', (card) => trx('triage_items').where({ id: card.id }).update({ status: 'resolved', resolved_at: new Date() }), 'phone_yes_card_closed'],
    ['time runs short', (card) => trx('scheduled_services').where({ id: card.visitId }).update({ scheduled_date: etDay(1) }), 'phone_yes_time_short'],
  ])('a filed row a person marked Done cannot be reopened once %s', async (_label, change, reason) => {
    const card = await phoneYesCard();
    await pass();
    const { filed } = await bellsOf(card.id);
    await trx('notifications').where({ id: filed.id }).update({ done_at: new Date(Date.now() - 60000), done_by: '123' });
    await change(card);
    await pass();

    const closed = (await bellsOf(card.id)).filed;
    expect(closed.done_by).toBe('episodes');
    expect(closed.metadata).toEqual(expect.objectContaining({ autoCleared: true, autoClearedReason: reason }));
    const { token } = await trx('notifications').where({ id: filed.id }).first(trx.raw('done_at::text AS token'));
    await expect(NotificationService.reopenAdminDone(String(filed.id), { expectedDoneAt: token })).resolves.toBe('not_reopenable');
    expect((await bellsOf(card.id)).filed.done_at).not.toBeNull();
  });

  test('a yes taken back: the open row is rewritten quietly, with no banner, and keeps its read state', async () => {
    const card = await phoneYesCard();
    await pass();
    const readAt = new Date(Date.now() - 60000);
    await trx('notifications').whereRaw("metadata->>'dedupeKey' = ?", [filedKey(card.id)]).update({ read_at: readAt });
    // A later call takes the yes back. Until the sweep writes that on the card, the bell says nothing new.
    await call(card.customerId, { intent: 'cancellation_request' });
    await pass();
    expect((await bellsOf(card.id)).filed.title).toBe("Estimates — accept Pat Sampleton's estimate");
    await keepCurrent(card.id);
    await pass();

    const { filed, count } = await bellsOf(card.id);
    expect(count).toBe(1);
    expect(filed).toEqual(expect.objectContaining({
      title: "Estimates — check Pat Sampleton's estimate",
      body: `A call booked a pest visit for ${dayWords(5)} while an estimate is open; no yes was heard.`, done_at: null,
    }));
    expect(new Date(filed.read_at).getTime()).toBe(readAt.getTime());
    expect(filed.detail).not.toContain(WORDS);
    expect(bannersFor(card.id)).toBe(1);
  });

  test('a claimed card rings nothing more and its row is not rewritten; the row stays until the card closes', async () => {
    const card = await phoneYesCard();
    await pass();
    // The sweep leaves a claimed card as it is, so the bell does too: time runs short and its words change, quietly.
    await trx('triage_items').where({ id: card.id }).update({
      status: 'in_progress', payload: JSON.stringify({ flag: 'call_phone_yes', estimate_ids: card.estimateIds, yes_heard: false }),
    });
    await trx('scheduled_services').where({ id: card.visitId }).update({ scheduled_date: etDay(1) });
    await pass();

    const { filed, due, count } = await bellsOf(card.id);
    expect(count).toBe(1);
    expect(due).toBeUndefined();
    expect(filed).toEqual(expect.objectContaining({ title: "Estimates — accept Pat Sampleton's estimate", done_at: null }));
    expect(bannersFor(card.id)).toBe(1);
  });

  test('a call that booked several visits: the soonest pest visit to come gives the time, never a lawn visit', async () => {
    const card = await phoneYesCard({ cardVisit: false, moreVisits: [{ days: 1, service_type: 'Lawn Care' }] });
    await pass();
    // The lawn visit tomorrow is no reason; the pest visit is in five days.
    let bells = await bellsOf(card.id);
    expect(bells).toEqual(expect.objectContaining({ due: undefined, count: 1 }));
    expect(bells.filed.body).toBe(`The caller said yes to pay per application on a call, and the visit is ${dayWords(5)}.`);

    // The call's second pest visit, tomorrow: time runs short.
    await addVisit(card, { days: 1 });
    await pass();
    bells = await bellsOf(card.id);
    expect(bells.due.body).toBe(`The visit the call booked is ${dayWords(1)}, and its card in Triage is still open.`);
  });

  test('the filed row closes only once the time-short row exists, and every pass retries that close', async () => {
    const card = await phoneYesCard();
    await pass();
    await trx('scheduled_services').where({ id: card.visitId }).update({ scheduled_date: etDay(1) });

    // The time-short raise writes no row (notifyAdmin returns null on a failed write): the filed row stays open.
    const original = Compose.raiseAdminAlert;
    const spy = jest.spyOn(Compose, 'raiseAdminAlert').mockImplementation((category, spec, opts) => (
      opts.dedupeKey === dueKey(card.id) ? Promise.resolve(null) : original(category, spec, opts)));
    await pass();
    spy.mockRestore();
    let bells = await bellsOf(card.id);
    expect(bells).toEqual(expect.objectContaining({ due: undefined, count: 1 }));
    expect(bells.filed.done_at).toBeNull();

    // The next pass rings it, and the filed row closes.
    await pass();
    bells = await bellsOf(card.id);
    expect(bells.due.done_at).toBeNull();
    expect(bells.filed.done_at).not.toBeNull();

    // A close that failed after the time-short row committed is made up by the next pass.
    await trx('notifications').where({ id: bells.filed.id }).update({ done_at: null, metadata: trx.raw("metadata - 'autoCleared'") });
    await pass();
    bells = await bellsOf(card.id);
    expect(bells.filed.done_at).not.toBeNull();
    expect(bells.filed.metadata).toEqual(expect.objectContaining({ autoCleared: true, autoClearedReason: 'phone_yes_time_short' }));
    expect(bannersFor(card.id)).toBe(2);
  });

  test('an estimate accepted since the sweep last read the card rings nothing until the sweep writes it', async () => {
    const card = await phoneYesCard();
    await pass();
    // Time runs short, and the customer accepts the estimate after the sweep's moot pass read the card.
    await trx('scheduled_services').where({ id: card.visitId }).update({ scheduled_date: etDay(1) });
    await trx('estimates').where({ id: card.estimateIds[0] }).update({ status: 'accepted', accepted_at: new Date() });
    await pass();
    // No alert to accept an accepted estimate, and the time-short key is not spent on one.
    let bells = await bellsOf(card.id);
    expect(bells).toEqual(expect.objectContaining({ due: undefined, count: 1 }));
    expect(bells.filed.title).toBe("Estimates — accept Pat Sampleton's estimate");
    expect(bannersFor(card.id)).toBe(1);

    // The next run writes the accept on the card; then the time-short bell says what the card says.
    await keepCurrent(card.id);
    await pass();
    bells = await bellsOf(card.id);
    expect(bells.due).toEqual(expect.objectContaining({
      title: "Estimates — check Pat Sampleton's booked visit",
      body: `The visit the call booked is ${dayWords(1)}, and its card in Triage is still open.`, done_at: null,
    }));
    expect(bannersFor(card.id)).toBe(2);
  });

  test("with the type's Bell switch off for every admin nothing rings and no banner goes; rows stay current and close", async () => {
    const rung = await phoneYesCard();
    await pass();
    // Every active admin, a second one too, turns the type's Bell switch off in Push Settings.
    await trx('technicians').insert({ id: randomUUID(), name: 'Sample Admin Two', role: 'admin', active: true });
    await setBellSwitch(false);
    const quiet = await phoneYesCard();
    await trx('scheduled_services').where({ id: rung.visitId }).update({ scheduled_date: etDay(1) });
    await pass();

    // The new card rings nothing. The rung card's time-short bell waits; its open row says the time is short, quietly.
    expect((await bellsOf(quiet.id)).count).toBe(0);
    const bells = await bellsOf(rung.id);
    expect(bells).toEqual(expect.objectContaining({ due: undefined, count: 1 }));
    expect(bells.filed.body).toBe(`The visit the call booked is ${dayWords(1)}, and its card in Triage is still open.`);
    expect(bannersFor(rung.id) + bannersFor(quiet.id)).toBe(1);
    // A closed card's row still closes.
    await trx('triage_items').where({ id: rung.id }).update({ status: 'resolved', resolved_at: new Date() });
    await pass();
    expect((await bellsOf(rung.id)).filed.metadata).toEqual(expect.objectContaining({ autoCleared: true, autoClearedReason: 'phone_yes_card_closed' }));

    // One admin with the switch on is enough, the other's still off: the card still open rings.
    await trx('notification_preferences').where({ admin_user_id: admin, trigger_key: 'call_phone_yes' }).update({ bell_enabled: true });
    await pass();
    expect((await bellsOf(quiet.id)).filed.done_at).toBeNull();
    expect(bannersFor(quiet.id)).toBe(1);
  });

  test('the Bell switch is read for each ring, under the card\'s lock: turned off while the pass runs, the card rings nothing', async () => {
    const card = await phoneYesCard();
    const realPass = Bell.runBellPass;
    const spy = jest.spyOn(Bell, 'runBellPass').mockImplementation(({ readCard, ...rest }) => realPass({
      ...rest,
      // The last admin with it on turns it off after the pass starts, while it waits for the card's lock.
      readCard: async (conn, listed) => {
        await setBellSwitch(false);
        return readCard(conn, listed);
      },
    }));
    try {
      await pass();
    } finally {
      spy.mockRestore();
    }
    expect((await bellsOf(card.id)).count).toBe(0);
    expect(bannersFor(card.id)).toBe(0);
  });

  test('a later call still being read holds the ring, as it holds the tap; once read, the ring says what the read found', async () => {
    const card = await phoneYesCard();
    await pass();
    // Time runs short while a newer call is not read yet: the card still shows the yes, and the bell rings nothing.
    await trx('scheduled_services').where({ id: card.visitId }).update({ scheduled_date: etDay(1) });
    const later = await call(card.customerId, {
      over: { processing_status: 'processing', v2_extraction_status: null, ai_extraction_enriched: null, transcription: null },
    });
    await pass();
    expect(await bellsOf(card.id)).toEqual(expect.objectContaining({ due: undefined, count: 1 }));
    expect(bannersFor(card.id)).toBe(1);

    // The read finds a cancel: the sweep writes it on the card, then the time-short bell says what the card says.
    await trx('call_log').where({ id: later }).update({
      processing_status: 'processed', v2_extraction_status: 'valid', transcription: transcriptWith(null),
      ai_extraction_enriched: JSON.stringify(extractionWith(null, 'cancellation_request')),
    });
    await keepCurrent(card.id);
    await pass();
    const { due } = await bellsOf(card.id);
    expect(due).toEqual(expect.objectContaining({
      title: "Estimates — check Pat Sampleton's estimate",
      body: `The visit the call booked is ${dayWords(1)}, and its card in Triage is still open.`,
    }));
    expect(bannersFor(card.id)).toBe(2);
  });

  test('a yes with every estimate on the card expired asks for a check, not an accept, since the tap refuses it', async () => {
    // Filed after its estimate expired: the filed bell asks for a check.
    const lapsed = await phoneYesCard({ estimates: [{ hours: -1 }] });
    // Filed while its estimate is open: an accept.
    const card = await phoneYesCard();
    await pass();
    expect((await bellsOf(lapsed.id)).filed).toEqual(expect.objectContaining({
      title: "Estimates — check Pat Sampleton's estimate",
      body: 'The caller said yes to pay per application, but no estimate on the card is open to accept now.',
    }));
    expect((await bellsOf(card.id)).filed.title).toBe("Estimates — accept Pat Sampleton's estimate");

    // Its estimate expires, then the visit moves to tomorrow: the time-short bell asks for a check.
    await trx('estimates').whereIn('id', card.estimateIds).update({ expires_at: new Date(Date.now() - HOUR) });
    await trx('scheduled_services').where({ id: card.visitId }).update({ scheduled_date: etDay(1) });
    await keepCurrent(card.id);
    await pass();
    expect((await bellsOf(card.id)).due).toEqual(expect.objectContaining({
      title: "Estimates — check Pat Sampleton's estimate",
      body: `The visit the call booked is ${dayWords(1)}, and its card in Triage is still open.`,
    }));
  });

  test('the filed row closes in the commit that writes the time-short row, before the pass reads the next card', async () => {
    const first = await phoneYesCard();
    const second = await phoneYesCard();
    await pass();
    await trx('scheduled_services').whereIn('id', [first.visitId, second.visitId]).update({ scheduled_date: etDay(1) });
    // At each card's read: every other card whose time-short row stands, and whether its filed row is still open.
    const seen = [];
    const realPass = Bell.runBellPass;
    const spy = jest.spyOn(Bell, 'runBellPass').mockImplementation(({ readCard, ...rest }) => realPass({
      ...rest,
      readCard: async (conn, listed) => {
        for (const other of [first, second].filter((made) => made.id !== listed.id)) {
          const { filed, due } = await bellsOf(other.id);
          if (due) seen.push({ card: other.id, filedOpen: filed.done_at == null });
        }
        return readCard(conn, listed);
      },
    }));
    try {
      await pass();
    } finally {
      spy.mockRestore();
    }
    // The second card's read found the first card's time-short row with its filed row already closed.
    expect(seen).toEqual([expect.objectContaining({ filedOpen: false })]);
    for (const made of [first, second]) {
      const { filed, due } = await bellsOf(made.id);
      expect(due.done_at).toBeNull();
      expect(filed.done_at).not.toBeNull();
    }
  });

  test("urgency is read by the clock after the card's lock, not the sweep's start", async () => {
    // By a clock two days old (a long scan, a long wait for the lock), a visit that began yesterday at 3:00 PM would
    // start within 48 hours, and one tomorrow at 3:00 PM would not.
    const started = await phoneYesCard({ visitDays: -1 });
    const soon = await phoneYesCard({ visitDays: 1 });
    await ringOpenCardsForTest(new Date(Date.now() - 2 * DAY));
    const startedBells = await bellsOf(started.id);
    expect(startedBells.due).toBeUndefined();
    expect(startedBells.filed.body).toBe('The caller said yes to pay per application on a call.');
    const soonBells = await bellsOf(soon.id);
    expect(soonBells.filed).toBeUndefined();
    expect(soonBells.due.body).toBe(`The visit the call booked is ${dayWords(1)}, and its card in Triage is still open.`);
  });

  describe('the rows a ring reads, on two connections', () => {
    // These rows are committed, on a pool of their own, so a second connection sees them; each test deletes its own.
    let pool; let made = null;
    beforeAll(() => { pool = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } }); });
    afterAll(async () => { await pool.destroy(); });
    afterEach(async () => {
      if (!made) return;
      const { id, customerId } = made;
      made = null;
      await pool('triage_items').where({ id }).del();
      await pool('scheduled_services').where({ customer_id: customerId }).del();
      await pool('call_log').where({ customer_id: customerId }).del();
      await pool('estimates').where({ customer_id: customerId }).del();
      await pool('customers').where({ id: customerId }).del();
    });
    // A read that must not wait: no lock timeout (a NOWAIT miss and a lock timeout both raise 55P03), and a statement
    // timeout instead, so a lock that waits fails as a cancel (57014). Long: a loaded machine can stretch a statement.
    const waitNoLonger = async (conn) => {
      await conn.raw('SET LOCAL lock_timeout = 0');
      await conn.raw("SET LOCAL statement_timeout = '30s'");
    };

    const reRead = (card) => ['call_log', card.yesCallId, { v2_extraction_status: 'valid' }];
    test.each([
      ['the customer accepts the estimate', {}, (card) => ['estimates', card.estimateIds[0], { status: 'accepted', accepted_at: new Date() }]],
      ['the visit moves to tomorrow', {}, (card) => ['scheduled_services', card.visitId, { scheduled_date: etDay(1) }]],
      ['a re-read of the call with the yes', {}, reRead],
      // The window starts at the send, as the card's check reads it: here before the estimate's row was made.
      ['a re-read of the call with the yes, on an estimate whose send is dated before its row was made', { madeHoursAgo: 0 }, reRead],
      // The customer's numbers decide which unlinked calls are theirs (and so which still owe a read).
      ['a new phone number on the customer', {}, (card) => ['customers', card.customerId, { phone: '+19415559876' }]],
    ])("%s: in flight, the card rings nothing this run; after the ring's read, the change waits for its commit", async (_label, setup, changeOf) => {
      const perTest = trx;
      try {
        trx = pool;
        mockConn = pool;
        made = await phoneYesCard(setup);
      } finally {
        trx = perTest;
        mockConn = perTest;
      }
      const [table, rowId, change] = changeOf(made);
      const write = (conn) => conn(table).where({ id: rowId }).update(change);
      const listed = { id: made.id, call_log_id: made.callLogId };

      // The change in flight on another connection (not committed): the ring's read skips the card at once.
      const other = await pool.transaction();
      let ring = await pool.transaction();
      try {
        await write(other);
        await waitNoLonger(ring);
        await expect(openCardNowForTest(ring, listed)).resolves.toBeNull();
      } finally {
        await ring.rollback();
        await other.rollback();
      }
      // The ring's read first: the change after it waits until the ring commits.
      ring = await pool.transaction();
      try {
        await expect(openCardNowForTest(ring, listed)).resolves.toEqual(expect.objectContaining({
          card: expect.objectContaining({ id: made.id }),
        }));
        await expect(pool.transaction(async (later) => {
          await later.raw("SET LOCAL lock_timeout = '300ms'");
          await write(later);
        })).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await ring.rollback();
      }
    });
  });
});
