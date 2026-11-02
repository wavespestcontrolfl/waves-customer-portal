// Tech voice line admission (services/tech-voice-line.js) against PostgreSQL: the call's call_log row and its minute
// reservation commit together under the per-CallSid lock /call-status takes for its own write, and /call-status settles
// only after that write commits. So a final status and a reservation never miss each other: a final status that wins
// the race (the caller hung up during admission) leaves no reservation, and a status write that loses it waits, then
// settles the reservation. Here /call-status is played by its two steps: the CallSid-locked write, then the settlement.
// Synthetic technician and call rows, committed (the races need three connections) and deleted after each test.
// Skips without DATABASE_URL (CI runs it against the migrated database).
const SKIP = !process.env.DATABASE_URL;

const knex = require('knex');
const { randomUUID } = require('crypto');

const LINE = '+19415550188';
process.env.TECH_VOICE_NUMBER = LINE;
process.env.GATE_TECH_VOICE_LINE = 'true';
// The admission connection's name, so a test can see it wait on a lock.
const ADMISSION_APP = 'tech-voice-admission-test';

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);

describeDb('tech voice admission vs the final status callback (PostgreSQL)', () => {
  const { admitTechVoiceCall } = require('../services/tech-voice-line');
  const { settleTechVoiceCall } = require('../services/tech-voice-usage');
  let database;
  let admissionDb;
  let statusDb;
  let techId;
  let cell;
  const callSids = [];
  const sid = () => { const s = `CA${randomUUID().replace(/-/g, '')}`; callSids.push(s); return s; };
  const args = (callSid) => ({ callSid, from: cell, to: LINE, callStatus: 'ringing', stirVerstat: null });
  const usage = (callSid) => database('tech_voice_usage').where({ call_sid: callSid }).first();
  const pending = (promise) => {
    const state = { done: false };
    promise.then(() => { state.done = true; }, () => { state.done = true; });
    return state;
  };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  // Until the admission connection is blocked on a lock (it then holds every lock it took before).
  async function admissionWaitingOnALock() {
    for (let i = 0; i < 200; i += 1) {
      const { rows } = await database.raw(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ? AND wait_event_type = 'Lock'",
        [ADMISSION_APP],
      );
      if (rows[0].n > 0) return;
      await pause(25);
    }
    throw new Error('admission never waited on a lock');
  }

  beforeAll(() => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } });
    admissionDb = knex({
      client: 'pg',
      connection: { connectionString: process.env.DATABASE_URL, application_name: ADMISSION_APP },
      pool: { min: 0, max: 2 },
    });
    statusDb = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    cell = `+1941555${String(Math.floor(Math.random() * 9000) + 1000)}`;
    [{ id: techId }] = await database('technicians')
      .insert({ name: 'Voice Admission Test', phone: cell, employment_status: 'active', field_dispatchable: true })
      .returning('id');
  });
  afterEach(async () => {
    await database('tech_voice_usage').where({ technician_id: techId }).del();
    await database('call_log').whereIn('twilio_call_sid', callSids.splice(0)).del();
    await database('technicians').where({ id: techId }).del();
  });
  afterAll(async () => {
    await Promise.all([database, admissionDb, statusDb].filter(Boolean).map((k) => k.destroy()));
    await require('../models/db').destroy();
  });

  test('the final status reaches call_log first (the caller hung up during admission): nothing is reserved', async () => {
    const callSid = sid();
    // /call-status holds the CallSid lock with its fallback row (internal source, final status) not yet committed.
    const status = await statusDb.transaction();
    try {
      await status.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [callSid]);
      await status('call_log').insert({
        direction: 'inbound', from_phone: cell, to_phone: LINE, twilio_call_sid: callSid, status: 'canceled',
        duration_seconds: 0, source: 'tech_voice', metadata: JSON.stringify({ tech_voice: true, source: 'status_callback' }),
      });
      const admission = admitTechVoiceCall(admissionDb, args(callSid));
      const state = pending(admission);
      await pause(300);
      expect(state.done).toBe(false);
      await status.commit();
      expect(await admission).toEqual({ ok: false, reason: 'call_ended' });
    } finally {
      if (!status.isCompleted()) await status.rollback();
    }
    // Its settlement then finds nothing, and no reservation was ever left behind.
    expect(await settleTechVoiceCall(database, { callSid, callStatus: 'canceled', durationSeconds: '0' })).toBe(false);
    expect(await usage(callSid)).toBeUndefined();
    expect(await database('call_log').where({ twilio_call_sid: callSid }).first('source')).toEqual({ source: 'tech_voice' });
  });

  test('a status write that arrives during admission waits for its commit, then settles the reservation', async () => {
    const callSid = sid();
    // Pause admission inside its transaction: with the technician's usage lock held here, admission takes the
    // CallSid lock, writes the row, then waits in reserveTechVoiceCall.
    const usageLock = await database.transaction();
    try {
      await usageLock.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`tech-voice-usage:${techId}`]);
      const admission = admitTechVoiceCall(admissionDb, args(callSid));
      await admissionWaitingOnALock();
      // /call-status's write needs the CallSid lock admission holds.
      const statusWrite = statusDb.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [callSid]);
        const row = await trx('call_log').where({ twilio_call_sid: callSid }).first('id');
        await trx('call_log').where({ id: row.id }).update({ status: 'completed', duration_seconds: 70 });
      });
      const state = pending(statusWrite);
      await pause(300);
      expect(state.done).toBe(false);
      await usageLock.commit();
      expect(await admission).toEqual({ ok: true, technicianId: techId });
      await statusWrite;
    } finally {
      if (!usageLock.isCompleted()) await usageLock.rollback();
    }
    expect(await settleTechVoiceCall(database, { callSid, callStatus: 'completed', durationSeconds: '70' })).toBe(true);
    expect(await usage(callSid)).toMatchObject({ technician_id: techId, reserved_minutes: 3, billed_minutes: 2 });
  });
});
