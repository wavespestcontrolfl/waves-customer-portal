/**
 * SMS offer ledger on PostgreSQL (GATE_SMS_OFFER_LEDGER): one row per sent
 * decision, a newer offer to the same phone and kind supersedes the open one,
 * and the one-open-offer index holds. Everything runs in a transaction that is
 * always rolled back.
 */
const path = require('path');

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('sms_offers on PostgreSQL', () => {
  let knex;
  let offers;
  const GATE = 'GATE_SMS_OFFER_LEDGER';
  const ROLLBACK = new Error('rollback');
  const SENT_AT = new Date('2026-10-02T15:00:00Z');
  const BODY = 'We can do Tuesday, October 6 10:00 AM - 12:00 PM. Does that work?';

  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
    offers = require('../services/sms-offers');
    // The ledger reads its label and edit-plan functions from the drafter on
    // first use; loading that module is slow, so it is paid here, not in a test.
    require('../services/sms-shadow-drafter');
    process.env[GATE] = 'true';
  }, 60000);
  afterAll(async () => {
    delete process.env[GATE];
    if (knex) await knex.destroy();
    // sms-offers loads the app's own pool; an open pool keeps Jest alive in CI.
    await require('../models/db').destroy();
  });

  async function insertDecision(trx, { source = 'scheduler', lookup = {} } = {}) {
    const [row] = await trx('agent_decisions').insert({
      workflow: 'sms_reply', agent_name: 'ledger-test', decision_version: 'test', suggested_message: BODY,
      input_snapshot: JSON.stringify({
        open_times_snapshot: {
          lookup: { source, ...lookup },
          quotedWindows: [{ date: 'Tuesday, October 6', window: '10:00 AM - 12:00 PM' }],
        },
      }),
    }).returning('id');
    return row.id || row;
  }

  const inTrx = (fn) => expect(knex.transaction(async (trx) => { await fn(trx); throw ROLLBACK; })).rejects.toBe(ROLLBACK);

  test('an accepted send records one open offer with its resolved slot', () => inTrx(async (trx) => {
    const visitId = '11111111-1111-4111-8111-111111111111';
    const decisionId = await insertDecision(trx, { lookup: { scheduledServiceId: visitId } });
    const result = await offers.recordOfferForSend({ agentDecisionId: decisionId, outgoingBody: BODY, providerMessageId: 'SMtest1', to: '+19415550100', sentAt: SENT_AT, dbh: trx });
    expect(result).toMatchObject({ recorded: true, superseded: 0 });
    const row = await trx('sms_offers').where({ id: result.id }).first();
    expect(row).toMatchObject({ kind: 'move_visit', status: 'open', phone_last10: '9415550100', scheduled_service_id: visitId, provider_message_id: 'SMtest1' });
    expect(row.slots).toEqual([{ date_label: 'Tuesday, October 6', window_label: '10:00 AM - 12:00 PM', date: '2026-10-06', start: '10:00', end: '12:00' }]);
    expect(new Date(row.expires_at).getTime() - new Date(row.sent_at).getTime()).toBe(48 * 3600000);
  }));

  test('the same decision recorded twice stays one row', () => inTrx(async (trx) => {
    const decisionId = await insertDecision(trx, { lookup: { scheduledServiceId: '11111111-1111-4111-8111-111111111111' } });
    const args = { agentDecisionId: decisionId, outgoingBody: BODY, to: '9415550101', sentAt: SENT_AT, dbh: trx };
    const first = await offers.recordOfferForSend(args);
    const second = await offers.recordOfferForSend(args);
    expect(second).toEqual({ recorded: false, reason: 'already_recorded', id: first.id });
    expect(await trx('sms_offers').where({ agent_decision_id: decisionId }).count('* as n').first()).toMatchObject({ n: '1' });
  }));

  test('a newer offer to the same phone and kind supersedes the open one; another kind is left alone', () => inTrx(async (trx) => {
    const phone = '9415550102';
    const visit = { scheduledServiceId: '11111111-1111-4111-8111-111111111111' };
    const first = await offers.recordOfferForSend({ agentDecisionId: await insertDecision(trx, { lookup: visit }), outgoingBody: BODY, to: phone, sentAt: SENT_AT, dbh: trx });
    const other = await offers.recordOfferForSend({ agentDecisionId: await insertDecision(trx, { source: 'book', lookup: { serviceKey: 'pest_control' } }), outgoingBody: BODY, to: phone, sentAt: SENT_AT, dbh: trx });
    const second = await offers.recordOfferForSend({ agentDecisionId: await insertDecision(trx, { lookup: visit }), outgoingBody: BODY, to: phone, sentAt: new Date(SENT_AT.getTime() + 3600000), dbh: trx });
    expect(second).toMatchObject({ recorded: true, superseded: 1 });
    const rows = await trx('sms_offers').where({ phone_last10: phone }).select('id', 'kind', 'status', 'superseded_by', 'closed_at');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[first.id]).toMatchObject({ status: 'superseded', superseded_by: second.id });
    // Closed when the newer text went out, not when the row was written.
    expect(new Date(byId[first.id].closed_at).toISOString()).toBe(new Date(SENT_AT.getTime() + 3600000).toISOString());
    expect(byId[second.id]).toMatchObject({ status: 'open', superseded_by: null });
    expect(byId[other.id]).toMatchObject({ kind: 'book_new', status: 'open' });
  }));

  test('a late record of an OLDER text stays superseded; the newest sent offer stays open', () => inTrx(async (trx) => {
    const phone = '9415550104';
    const visit = { scheduledServiceId: '11111111-1111-4111-8111-111111111111' };
    const newer = await offers.recordOfferForSend({ agentDecisionId: await insertDecision(trx, { lookup: visit }), outgoingBody: BODY, to: phone, sentAt: new Date(SENT_AT.getTime() + 3600000), dbh: trx });
    const older = await offers.recordOfferForSend({ agentDecisionId: await insertDecision(trx, { lookup: visit }), outgoingBody: BODY, to: phone, sentAt: SENT_AT, dbh: trx });
    expect(older).toMatchObject({ recorded: true, superseded: 0, late: true });
    const rows = await trx('sms_offers').where({ phone_last10: phone }).select('id', 'status', 'superseded_by');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[newer.id]).toMatchObject({ status: 'open', superseded_by: null });
    expect(byId[older.id]).toMatchObject({ status: 'superseded', superseded_by: newer.id });
    const closed = await trx('sms_offers').where({ id: older.id }).first('closed_at');
    expect(new Date(closed.closed_at).toISOString()).toBe(new Date(SENT_AT.getTime() + 3600000).toISOString());
  }));

  test('backfill re-records an accepted decision send whose ledger write was lost, once', () => inTrx(async (trx) => {
    const decisionId = await insertDecision(trx, { lookup: { scheduledServiceId: '11111111-1111-4111-8111-111111111111' } });
    const sid = `SM${'b'.repeat(32)}`;
    await trx('sms_log').insert({
      direction: 'outbound', from_phone: '+19415550199', to_phone: '+19415550105', message_body: BODY,
      twilio_sid: sid, status: 'sent', metadata: JSON.stringify({ agent_decision_id: decisionId }), created_at: SENT_AT,
    });
    const now = new Date(SENT_AT.getTime() + 3600000);
    const first = await offers.backfillMissedOffers({ now, dbh: trx });
    expect(first.recorded).toBeGreaterThanOrEqual(1);
    const row = await trx('sms_offers').where({ agent_decision_id: decisionId }).first();
    expect(row).toMatchObject({ provider_message_id: sid, phone_last10: '9415550105', status: 'open' });
    const again = await offers.backfillMissedOffers({ now, dbh: trx });
    expect(await trx('sms_offers').where({ agent_decision_id: decisionId }).count('* as n').first()).toMatchObject({ n: '1' });
    expect(again.scanned).toBe(first.scanned - first.recorded);
  }));

  test('backfill pages past sends it skips for good, so a newer recoverable offer is still recorded', () => inTrx(async (trx) => {
    const visit = { scheduledServiceId: '11111111-1111-4111-8111-111111111111' };
    const logSend = async (decisionId, body, minutes, phone) => trx('sms_log').insert({
      direction: 'outbound', from_phone: '+19415550199', to_phone: phone, message_body: body,
      twilio_sid: `SM${String(minutes).padStart(32, 'c')}`, status: 'sent',
      metadata: JSON.stringify({ agent_decision_id: decisionId }), created_at: new Date(SENT_AT.getTime() + minutes * 60000),
    });
    // Two sends whose text no longer carries any offered time: skipped every tick.
    await logSend(await insertDecision(trx, { lookup: visit }), 'Thanks, talk soon.', 1, '+19415550106');
    await logSend(await insertDecision(trx, { lookup: visit }), 'Thanks, talk soon.', 2, '+19415550107');
    const recoverable = await insertDecision(trx, { lookup: visit });
    await logSend(recoverable, BODY, 3, '+19415550108');
    await offers.backfillMissedOffers({ now: new Date(SENT_AT.getTime() + 3600000), dbh: trx, batchSize: 1 });
    expect(await trx('sms_offers').where({ agent_decision_id: recoverable }).first('status')).toMatchObject({ status: 'open' });
  }));

  test('three offers recorded out of order (B, C, then A recovered) chain in send order', () => inTrx(async (trx) => {
    const phone = '9415550109';
    const visit = { scheduledServiceId: '11111111-1111-4111-8111-111111111111' };
    const at = (h) => new Date(SENT_AT.getTime() + h * 3600000);
    const send = async (h) => offers.recordOfferForSend({ agentDecisionId: await insertDecision(trx, { lookup: visit }), outgoingBody: BODY, to: phone, sentAt: at(h), dbh: trx });
    const b = await send(1);
    const c = await send(2);
    const a = await send(0);
    expect(a).toMatchObject({ recorded: true, late: true });
    const rows = Object.fromEntries((await trx('sms_offers').where({ phone_last10: phone }).select('id', 'status', 'superseded_by', 'closed_at')).map((r) => [r.id, r]));
    expect(rows[a.id]).toMatchObject({ status: 'superseded', superseded_by: b.id });
    expect(new Date(rows[a.id].closed_at).toISOString()).toBe(at(1).toISOString());
    expect(rows[b.id]).toMatchObject({ status: 'superseded', superseded_by: c.id });
    expect(new Date(rows[b.id].closed_at).toISOString()).toBe(at(2).toISOString());
    expect(rows[c.id]).toMatchObject({ status: 'open', superseded_by: null, closed_at: null });
  }));

  test('the database refuses a second open offer for one phone and kind', () => inTrx(async (trx) => {
    const base = { phone_last10: '9415550103', kind: 'move_visit', slots: '[]', sent_at: SENT_AT, expires_at: SENT_AT, status: 'open' };
    await trx('sms_offers').insert({ ...base, agent_decision_id: await insertDecision(trx) });
    const decisionId = await insertDecision(trx);
    await expect(trx.transaction((sp) => sp('sms_offers').insert({ ...base, agent_decision_id: decisionId })))
      .rejects.toThrow(/sms_offers_one_open_per_phone_kind/);
  }));
});
