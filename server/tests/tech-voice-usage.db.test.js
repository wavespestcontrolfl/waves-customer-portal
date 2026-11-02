// The tech voice line's billed-minute ledger (services/tech-voice-usage.js) against PostgreSQL: a call reserves
// 3 minutes before Twilio answers, one call at a time per technician, the ET day (15) and month (150) limits sum
// billed-or-reserved minutes, an unknown is counted as spent, and a settlement keeps the billed minutes once.
// Synthetic technician rows, committed (the race needs two connections) and deleted after each test. Skips without
// DATABASE_URL (CI runs it against the migrated database).
const SKIP = !process.env.DATABASE_URL;

const knex = require('knex');
const { randomUUID } = require('crypto');
const { reserveTechVoiceCall, settleTechVoiceCall, RESERVE_MINUTES } = require('../services/tech-voice-usage');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);

// 2026-11-12 15:00 ET: mid-month, mid-day, after the DST change.
const NOW = new Date('2026-11-12T20:00:00Z');
const minutesBefore = (n, from = NOW) => new Date(from.getTime() - n * 60 * 1000);

describeDb('tech voice usage ledger (PostgreSQL)', () => {
  let database;
  let techId;
  const sid = () => `CA${randomUUID().replace(/-/g, '')}`;
  const row = (callSid) => database('tech_voice_usage').where({ call_sid: callSid }).first();
  const seed = (fields) => database('tech_voice_usage').insert({ call_sid: sid(), technician_id: techId, reserved_minutes: 3, ...fields });

  beforeAll(() => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } });
  });
  beforeEach(async () => {
    [{ id: techId }] = await database('technicians').insert({ name: 'Voice Ledger Test' }).returning('id');
  });
  afterEach(async () => {
    await database('tech_voice_usage').where({ technician_id: techId }).del();
    await database('technicians').where({ id: techId }).del();
  });
  afterAll(async () => { if (database) await database.destroy(); });

  test('reserves 3 minutes for a new call; a Twilio retry of the same CallSid adds nothing', async () => {
    const callSid = sid();
    expect(await reserveTechVoiceCall(database, { callSid, technicianId: techId, now: NOW })).toEqual({ ok: true });
    expect(await reserveTechVoiceCall(database, { callSid, technicianId: techId, now: NOW })).toEqual({ ok: true });
    const rows = await database('tech_voice_usage').where({ technician_id: techId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ call_sid: callSid, reserved_minutes: RESERVE_MINUTES, billed_minutes: null, settled_at: null });
  });

  test('one call at a time: a second call while the first is live is refused; after it settles, allowed', async () => {
    const first = sid();
    await reserveTechVoiceCall(database, { callSid: first, technicianId: techId, now: NOW });
    expect(await reserveTechVoiceCall(database, { callSid: sid(), technicianId: techId, now: minutesBefore(-1) }))
      .toEqual({ ok: false, reason: 'call_in_progress' });
    expect(await settleTechVoiceCall(database, { callSid: first, callStatus: 'completed', durationSeconds: '50', now: minutesBefore(-1) })).toBe(true);
    expect(await reserveTechVoiceCall(database, { callSid: sid(), technicianId: techId, now: minutesBefore(-2) })).toEqual({ ok: true });
  });

  test('the daily limit counts billed minutes, and an unsettled reservation counts in full', async () => {
    // 9 billed + one unsettled reservation from earlier today (3, unknown = spent) = 12 → one more 3-minute call fits.
    await seed({ created_at: minutesBefore(300), billed_minutes: 9, settled_at: minutesBefore(299) });
    await seed({ created_at: minutesBefore(200) });
    expect(await reserveTechVoiceCall(database, { callSid: sid(), technicianId: techId, now: NOW })).toEqual({ ok: true });
    // 15 used → refused.
    await settleTechVoiceCall(database, { callSid: (await database('tech_voice_usage').where({ technician_id: techId }).whereNull('settled_at').orderBy('created_at', 'desc').first()).call_sid, callStatus: 'completed', durationSeconds: '170', now: minutesBefore(-4) });
    expect(await reserveTechVoiceCall(database, { callSid: sid(), technicianId: techId, now: minutesBefore(-10) }))
      .toEqual({ ok: false, reason: 'daily_limit' });
  });

  test('yesterday (ET) does not count toward today; the month does', async () => {
    // 23:30 ET on Nov 11 = 04:30Z Nov 12: yesterday in ET though the UTC date is the same.
    await seed({ created_at: new Date('2026-11-12T04:30:00Z'), billed_minutes: 15, settled_at: new Date('2026-11-12T04:45:00Z') });
    expect(await reserveTechVoiceCall(database, { callSid: sid(), technicianId: techId, now: NOW })).toEqual({ ok: true });
  });

  test('the monthly limit (150) refuses even on a fresh day', async () => {
    await seed({ created_at: new Date('2026-11-05T15:00:00Z'), billed_minutes: 148, settled_at: new Date('2026-11-05T15:30:00Z') });
    expect(await reserveTechVoiceCall(database, { callSid: sid(), technicianId: techId, now: NOW }))
      .toEqual({ ok: false, reason: 'monthly_limit' });
    // Last month never counts.
    await database('tech_voice_usage').where({ technician_id: techId }).update({ created_at: new Date('2026-10-28T15:00:00Z') });
    expect(await reserveTechVoiceCall(database, { callSid: sid(), technicianId: techId, now: NOW })).toEqual({ ok: true });
  });

  test('settlement keeps billed minutes once: rounding up, at least one, a retry or a non-final status changes nothing', async () => {
    const callSid = sid();
    await reserveTechVoiceCall(database, { callSid, technicianId: techId, now: NOW });
    expect(await settleTechVoiceCall(database, { callSid, callStatus: 'in-progress', durationSeconds: '10' })).toBe(false);
    expect(await settleTechVoiceCall(database, { callSid, callStatus: 'completed', durationSeconds: '' })).toBe(false);
    expect((await row(callSid)).settled_at).toBeNull();
    expect(await settleTechVoiceCall(database, { callSid, callStatus: 'completed', durationSeconds: '70' })).toBe(true);
    expect(await settleTechVoiceCall(database, { callSid, callStatus: 'completed', durationSeconds: '300' })).toBe(false);
    expect((await row(callSid)).billed_minutes).toBe(2);
    // An answered 0-second call still bills a minute; a call that never connected bills none.
    const zero = sid();
    await seed({ call_sid: zero, created_at: minutesBefore(30) });
    await settleTechVoiceCall(database, { callSid: zero, callStatus: 'completed', durationSeconds: '0' });
    expect((await row(zero)).billed_minutes).toBe(1);
    const unanswered = sid();
    await seed({ call_sid: unanswered, created_at: minutesBefore(20) });
    await settleTechVoiceCall(database, { callSid: unanswered, callStatus: 'no-answer', durationSeconds: '0' });
    expect((await row(unanswered)).billed_minutes).toBe(0);
  });

  test('a call racing a reservation still in flight waits for it, then is refused (the per-technician lock)', async () => {
    // Connection 1 plays a first call mid-reservation: it holds the technician's
    // lock and has inserted, but not committed, its row. The real second call on
    // connection 2 must wait for that commit, then see the live call. Without the
    // lock it would read before the commit and admit a second call.
    const other = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    const first = await database.transaction();
    try {
      await first.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`tech-voice-usage:${techId}`]);
      await first('tech_voice_usage').insert({ call_sid: sid(), technician_id: techId, reserved_minutes: 3, created_at: NOW });
      const second = reserveTechVoiceCall(other, { callSid: sid(), technicianId: techId, now: NOW });
      let settled = false;
      second.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await first.commit();
      expect(await second).toEqual({ ok: false, reason: 'call_in_progress' });
      expect(await database('tech_voice_usage').where({ technician_id: techId })).toHaveLength(1);
    } finally {
      if (!first.isCompleted()) await first.rollback();
      await other.destroy();
    }
  });
});
